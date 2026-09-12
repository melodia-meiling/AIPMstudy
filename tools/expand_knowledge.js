#!/usr/bin/env node
/**
 * 知识点内容扩写脚本
 * =====================================================================
 * 作用：把「只有一句话注释」的知识点，扩写成 600-1000 字的概念解释
 *       + 关联概念 + 3 组预设问答（供详情页「AI 答疑」下拉使用）
 *
 * 设计要点（重要）：
 *   · 不覆盖 doc.content —— content 是检索用的短文，向量已按它算好。
 *     扩写结果写进新字段 doc.explain / doc.faqs / doc.en / doc.expandAt。
 *     这样 kb.json 片段数不变、向量不需要重算，风险最小。
 *   · 同时统一 doc.level 为三档：必须掌握 / 需要理解 / 只需了解（按 mark 判定）
 *   · 断点续传：已有 explain 的自动跳过，中断后重跑不会重复花钱
 *   · 会先把 kb.json 备份到 data/kb.json.bak-<时间戳>
 *
 * 用法：
 *   node tools/expand_knowledge.js --dry        # 只跑 1 条，只打印不落盘
 *   node tools/expand_knowledge.js              # 全量跑 🔴 必须掌握（29 条）
 *   node tools/expand_knowledge.js --mark 🟡    # 换一档跑
 *   node tools/expand_knowledge.js --id d38     # 只跑某个知识点
 *   node tools/expand_knowledge.js --force      # 已有 explain 也重跑
 * =====================================================================
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const KB_PATH = path.join(ROOT, 'data', 'kb.json');
const REPORT_PATH = path.join(ROOT, 'data', 'expand_report.json');

const BASE = process.env.DEEPSEEK_BASE || 'https://api.deepseek.com';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const CONCURRENCY = Number(process.env.CONCURRENCY || 3);
const MAX_RETRY = 3;

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const val = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

const DRY = has('--dry');
const FORCE = has('--force');
const ONLY_ID = val('--id');
const TARGET_MARK = val('--mark') || '🔴';

const LEVEL_BY_MARK = { '🔴': '必须掌握', '🟡': '需要理解', '⚪': '只需了解' };

// ---------- API Key ----------
function readKey() {
  if (process.env.DEEPSEEK_API_KEY) return { key: process.env.DEEPSEEK_API_KEY, from: '环境变量' };
  const p = path.join(os.homedir(), '.dsh', '.credentials.yaml');
  if (fs.existsSync(p)) {
    const m = fs.readFileSync(p, 'utf8').match(/^\s*DEEPSEEK_API_KEY\s*:\s*(\S+)\s*$/m);
    if (m) return { key: m[1], from: '~/.dsh/.credentials.yaml' };
  }
  return { key: null, from: null };
}

// ---------- 提示词 ----------
const SYSTEM = `你是 AI 产品经理方向的资深教研老师，正在为一套「零基础转行 AI 产品经理」的学习工作台编写知识点词条。

读者画像：无技术背景、刚下班、有点焦虑、不知道从哪下手。他们需要的是「能看懂、看完知道下一步做什么」的解释，不是教科书。

写作要求：
1. 讲人话。术语第一次出现必须用生活化的类比解释清楚，再给专业定义。
2. 有具体信息量：能用到的平台、工具、参数、场景要写出来，不要写正确的废话。
3. 必须忠实。拿不准的平台功能、价格、额度，就写"具体以平台后台为准"，绝不编造数字。
4. 禁止出现 markdown 标题符号（#）、星号加粗（**）、多余的分隔线等排版垃圾。正文用自然段落。
5. 关联概念必须从【可选关联概念池】里挑选 3-5 个真实存在的概念（我会原样入库并做成可点击标签），优先选同一分类下的。绝对不许自己造新词，不许选池子里没有的。

只输出一个 JSON 对象，不要任何解释文字、不要 markdown 代码围栏。格式：
{
  "en": "该知识点通行的英文名，没有就用其英文术语，确实没有则空字符串",
  "explain": "概念解释，600-1000 字，纯文本（可用「一、二、」这类中文序号分段，不要用 # 和 *）",
  "related": ["从池子里选的关联概念1", "关联概念2", "关联概念3"],
  "faqs": [
    {"q": "学习者最常问的问题1（要具体、口语化）", "a": "答案，200-400 字"},
    {"q": "问题2", "a": "答案"},
    {"q": "问题3", "a": "答案"}
  ]
}

⚠️ 硬性要求：faqs 数组必须正好包含 3 个对象，不许只给 1 个或 2 个。这是最容易被忽略的地方，务必输出满 3 条。`;

const REPAIR_SYSTEM = `你是 AI 产品经理方向的资深教研老师。用户已经写好了一个知识点的概念解释，但预设问答没给够，请你补齐。只输出一个 JSON 对象，不要 markdown 代码围栏，格式：{"faqs":[{"q":"...","a":"..."}]}`;

function userPrompt(doc, titles) {
  // 候选关联概念池：同一分组优先，控制在 90 个以内，避免 prompt 过长
  const sameGroup = titles.filter(t => t.group === doc.group).map(t => t.title);
  const others = titles.filter(t => t.group !== doc.group).map(t => t.title);
  const pool = [...new Set([...sameGroup, ...others])].filter(t => t !== doc.title);

  return `请为下面这个知识点写词条。

【知识点名称】${doc.title}
【所属分类】${doc.group || '未分类'} > ${doc.section || '未分类'}
【重要程度】${LEVEL_BY_MARK[doc.mark] || '需要理解'}
【我原有的一句话注释】${(doc.content || '').replace(/\s+/g, ' ').trim()}
${doc.related && doc.related.length ? `【我原先随手写的关联概念】${doc.related.join('、')}（可参考、可推翻，但仍须来自下面的池子）` : ''}

【可选关联概念池】（只能从这里选，原样复制名称）
${pool.join('、')}

要求：概念解释里要把「是什么 / 为什么重要 / 在实际工作中长什么样 / 新手容易误解什么」讲清楚。如果这个知识点是工具或平台，说明它是干什么用的、什么时候会用到它。`;
}

// ---------- 调用 ----------
async function callDeepSeek(key, doc, titles) {
  const r = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: userPrompt(doc, titles) },
      ],
      temperature: 0.6,
      max_tokens: 4000,
      response_format: { type: 'json_object' },
    }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`HTTP ${r.status} ${t.slice(0, 200)}`);
  }
  const j = await r.json();
  const raw = j.choices?.[0]?.message?.content || '';
  const usage = j.usage || {};
  return { raw, usage };
}

// 补问答：万一模型只给了 1-2 条，单独再要一次，保证详情页下拉里至少有 3 个问题
async function repairFaqs(key, doc, have) {
  const need = 3 - have.length;
  const r = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: REPAIR_SYSTEM },
        {
          role: 'user',
          content: `知识点：${doc.title}（${doc.group || ''} > ${doc.section || ''}）\n概念解释：${(doc.explain || '').slice(0, 1500)}\n\n已有的问题（不要重复）：${have.map(f => f.q).join('；') || '无'}\n\n请再补 ${need} 个学习者最常问的、和上面不重复的问题及解答。`,
        },
      ],
      temperature: 0.7,
      max_tokens: 1600,
      response_format: { type: 'json_object' },
    }),
  });
  if (!r.ok) return { faqs: [], usage: {} };
  const j = await r.json();
  let parsed = {};
  try { parsed = parseJSONLoose(j.choices?.[0]?.message?.content || '{}'); } catch { /* 忽略 */ }
  return { faqs: Array.isArray(parsed.faqs) ? parsed.faqs : [], usage: j.usage || {} };
}

function parseJSONLoose(raw) {
  let s = String(raw).trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  return JSON.parse(s);
}

// 清洗扩写文本里可能残留的排版符号
function clean(t) {
  return String(t || '')
    .replace(/\*\*/g, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-*]{3,}\s*$/gm, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------- 主流程 ----------
(async () => {
  const { key, from } = readKey();
  if (!key) {
    console.error('❌ 没找到 DEEPSEEK_API_KEY。可先设环境变量，或确认 ~/.dsh/.credentials.yaml 里有这一行。');
    process.exit(1);
  }
  console.log(`API Key 来源：${from}`);

  const kb = JSON.parse(fs.readFileSync(KB_PATH, 'utf8'));
  const docs = kb.docs;

  let targets = ONLY_ID
    ? docs.filter(d => d.id === ONLY_ID)
    : docs.filter(d => d.mark === TARGET_MARK);
  if (!FORCE) targets = targets.filter(d => !d.explain);

  if (DRY) targets = targets.slice(0, 1);

  console.log(`目标知识点：${targets.length} 个${DRY ? '（dry-run，只跑 1 条不落盘）' : ''}`);
  if (!targets.length) { console.log('没有需要处理的知识点，退出。'); return; }

  if (!DRY) {
    const bak = path.join(ROOT, 'data', `kb.json.bak-${Date.now()}`);
    fs.copyFileSync(KB_PATH, bak);
    console.log(`已备份 kb.json → ${path.basename(bak)}`);
  }

  const report = { startedAt: new Date().toISOString(), model: MODEL, ok: [], fail: [], inTok: 0, outTok: 0 };
  const ALL_TITLES = docs.map(d => ({ title: d.title, group: d.group }));
  const TITLE_SET = new Set(ALL_TITLES.map(t => t.title));
  let done = 0;

  // 自己实现的小并发池
  let cursor = 0;
  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= targets.length) return;
      const doc = targets[i];
      let lastErr = null;
      for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
        try {
          const { raw, usage } = await callDeepSeek(key, doc, ALL_TITLES);
          const j = parseJSONLoose(raw);
          if (!j.explain || j.explain.length < 200) throw new Error(`explain 太短(${(j.explain || '').length}字)`);

          doc.en = clean(j.en) || doc.en || '';
          doc.explain = clean(j.explain);
          // 关联概念：只保留池子里真实存在的，避免点进去是空页面
          if (Array.isArray(j.related) && j.related.length) {
            const kept = j.related.map(x => clean(x)).filter(x => x && x !== doc.title && TITLE_SET.has(x));
            const dropped = j.related.length - kept.length;
            doc.related = kept.slice(0, 6);
            if (dropped) report.droppedRelated = (report.droppedRelated || 0) + dropped;
          }
          doc.faqs = (Array.isArray(j.faqs) ? j.faqs : [])
            .filter(x => x && x.q && x.a)
            .map(x => ({ q: clean(x.q), a: clean(x.a) }))
            .slice(0, 3);
          doc.levelN = LEVEL_BY_MARK[doc.mark] || '需要理解';
          doc.expandAt = new Date().toISOString();

          report.inTok += usage.prompt_tokens || 0;
          report.outTok += usage.completion_tokens || 0;

          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          if (attempt < MAX_RETRY) await new Promise(r => setTimeout(r, 1200 * attempt));
        }
      }
      if (lastErr) {
        report.fail.push({ id: doc.id, title: doc.title, error: lastErr.message });
        console.log(`❌ ${doc.id} ${doc.title}  → ${lastErr.message}`);
      } else {
        // 问答不够 3 条 → 单独补一次
        if ((doc.faqs || []).length < 3) {
          try {
            const { faqs, usage } = await repairFaqs(key, doc, doc.faqs || []);
            const add = faqs
              .filter(x => x && x.q && x.a)
              .map(x => ({ q: clean(x.q), a: clean(x.a) }))
              .filter(x => !(doc.faqs || []).some(h => h.q === x.q));
            doc.faqs = [...(doc.faqs || []), ...add].slice(0, 3);
            report.inTok += usage.prompt_tokens || 0;
            report.outTok += usage.completion_tokens || 0;
            report.repaired = (report.repaired || 0) + 1;
          } catch { /* 补不上就算了，不阻断 */ }
        }
        done++;
        report.ok.push({ id: doc.id, title: doc.title, chars: doc.explain.length, faqs: (doc.faqs || []).length, related: (doc.related || []).length });
        console.log(`✅ [${done}/${targets.length}] ${doc.id} ${doc.title}  → ${doc.explain.length}字, ${(doc.faqs || []).length}问, 关联${(doc.related || []).length}个`);
      }
      // 每条都落盘，防止中断丢进度
      if (!DRY) fs.writeFileSync(KB_PATH, JSON.stringify(kb, null, 1), 'utf8');
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));

  // 统一 level 字段（三档）
  let normalized = 0;
  for (const d of docs) {
    if (LEVEL_BY_MARK[d.mark]) {
      if (d.level !== LEVEL_BY_MARK[d.mark]) normalized++;
      d.levelRaw = d.level && d.level !== LEVEL_BY_MARK[d.mark] ? d.level : d.levelRaw;
      d.level = LEVEL_BY_MARK[d.mark];
    }
  }

  if (!DRY) {
    fs.writeFileSync(KB_PATH, JSON.stringify(kb, null, 1), 'utf8');
    report.finishedAt = new Date().toISOString();
    report.levelNormalized = normalized;
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 1), 'utf8');
  }

  console.log('\n──────── 汇总 ────────');
  console.log(`成功 ${report.ok.length} 条，失败 ${report.fail.length} 条`);
  console.log(`level 字段统一（三档）修正 ${normalized} 条`);
  // deepseek-chat 参考价：输入 3 元/百万 tokens，输出 6 元/百万 tokens
  const cost = (report.inTok / 1e6) * 3 + (report.outTok / 1e6) * 6;
  console.log(`token 用量：输入 ${report.inTok} / 输出 ${report.outTok}`);
  console.log(`估算费用：约 ${cost.toFixed(3)} 元（按输入3元、输出6元/百万tokens）`);
  if (DRY) console.log('（dry-run 未写入任何文件）');

  if (DRY && report.ok.length) {
    const d = targets[0];
    console.log('\n──────── dry-run 样例 ────────');
    console.log('标题:', d.title, '| en:', d.en, '| level:', d.levelN);
    console.log('关联概念:', (d.related || []).join(' / '));
    console.log('概念解释:\n' + (d.explain || '').slice(0, 700));
    console.log('\n预设问答:');
    (d.faqs || []).forEach((f, i) => console.log(`  ${i + 1}. ${f.q}\n     ${f.a.slice(0, 120)}...`));
  }
})();
