#!/usr/bin/env node
/**
 * regen_knowledge.js —— 重做知识树（生成对比版，不直接覆盖线上数据）
 * =====================================================================
 * 作用：把当前 kb.json 里的 109 个「概念类」知识点，用 DeepSeek 重新扩写成
 *       "厚、有来源、结构化" 的条目，写到 data/kb.json.new（对比版）。
 *       原 kb.json 完全不动，等用户点头才替换。
 *
 * 与旧 expand_knowledge.js 的区别：
 *   1. 写 kb.json.new，不碰 kb.json（对比版，安全）
 *   2. 不只重写 explain，还一并重写检索用的 content、新增 keypoints（要点）、
 *      sources（来源说明），让每条更厚、更可溯源
 *   3. 可选联网：settings.searchKey（博查）或 BOCHA_KEY 环境变量非空时，
 *      逐条先搜一次博查，把网页片段喂给模型并记到 sources
 *   4. 自动重建 doc.text（供关键词索引），保证换库后检索不退化
 *
 * 用法：
 *   node tools/regen_knowledge.js                 # 全量重做 109 个概念
 *   node tools/regen_knowledge.js --dry           # 只跑 1 条，只打印不落盘
 *   node tools/regen_knowledge.js --force         # 已有 explain 也重跑
 *   node tools/regen_knowledge.js --id d38        # 只跑某个知识点
 *   node tools/regen_knowledge.js --web           # 强制开启联网（需有 key）
 *
 * 断点续传：kb.json.new 里已有 explain 的条目自动跳过（除非 --force）。
 * =====================================================================
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const KB_PATH = path.join(ROOT, 'data', 'kb.json');
const NEW_PATH = path.join(ROOT, 'data', 'kb.json.new');
const REPORT_PATH = path.join(ROOT, 'data', 'regen_report.json');

const BASE = process.env.DEEPSEEK_BASE || 'https://api.deepseek.com';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const CONCURRENCY = Number(process.env.CONCURRENCY || 2);
const MAX_RETRY = 4;
const FORCE_WEB = process.argv.includes('--web');
const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');
const ONLY_ID = (() => { const i = process.argv.indexOf('--id'); return i >= 0 ? process.argv[i + 1] : null; })();

const LEVEL_BY_MARK = { '🔴': '必须掌握', '🟡': '需要理解', '⚪': '只需了解' };

// 上传过的书目（gen_book_kb.js 整理出来的 13 本），用于约束 sources 不编造引用
const BOOK_TITLES = [
  'AI产品经理实战：从大模型集成到商业化落地', '秒懂智能体：AI Agent重新定义未来工作',
  '产品经理的AI设计力：大模型一键搞定产品设计全流程', 'AI产品经理：方法、技术与实战',
  '人工智能产品设计', '迈向AGI时代：AI产品经理方法论', 'AI产品经理',
  'Machine Learning in Production', 'Building Machine Learning Powered Applications',
  'Co-Intelligence', 'Building AI-Powered Products', 'Designing Machine Learning Systems',
  'The Art of AI Product Development',
];

// ---------- API Key ----------
function readDeepSeekKey() {
  if (process.env.DEEPSEEK_API_KEY) return { key: process.env.DEEPSEEK_API_KEY, from: '环境变量' };
  const p = path.join(os.homedir(), '.dsh', '.credentials.yaml');
  if (fs.existsSync(p)) {
    const m = fs.readFileSync(p, 'utf8').match(/^\s*DEEPSEEK_API_KEY\s*:\s*(\S+)\s*$/m);
    if (m) return { key: m[1], from: '~/.dsh/.credentials.yaml' };
  }
  return { key: null, from: null };
}
function readBochaKey() {
  if (process.env.BOCHA_KEY) return process.env.BOCHA_KEY;
  const sp = path.join(ROOT, 'data', 'settings.json');
  if (fs.existsSync(sp)) {
    try {
      const s = JSON.parse(fs.readFileSync(sp, 'utf8'));
      if (s && s.searchKey) return s.searchKey;
    } catch { /* 忽略 */ }
  }
  return '';
}

// ---------- 提示词 ----------
const SYSTEM = `你是 AI 产品经理方向的资深教研老师，正在为一套「零基础转行 AI 产品经理」的学习工作台重写知识点词条。

读者画像：无技术背景、刚下班、有点焦虑、不知道从哪下手。他们需要「能看懂、看完知道下一步做什么」的解释，不是教科书。

写作要求：
1. 讲人话。术语第一次出现必须用生活化类比解释清楚，再给专业定义。
2. 有信息量：能用到的平台、工具、参数、场景写具体，不写正确的废话。
3. 必须忠实：拿不准的平台功能、价格、额度，写"具体以平台后台为准"，绝不编造数字与章节号。
4. 禁止 markdown 标题符号（#）、星号加粗（**）、多余分隔线等排版垃圾。正文用自然段落/中文序号。
5. 关联概念必须从【可选关联概念池】挑 3-5 个真实存在的（原样入库做成可点击标签），优先同分类。不许自造新词。

只输出一个 JSON 对象，不要任何解释文字、不要 markdown 代码围栏。格式：
{
  "en": "通行英文名，没有则空字符串",
  "content": "精炼摘要，2-4 句话，≤140 字。是详情页首段，也是检索用的短文，要有信息量、别只复述标题",
  "explain": "概念解释，500-800 字，纯文本（可用「一、二、」分段，禁用 # 和 *）。要把：是什么 / 为什么重要 / 实际工作中长什么样 / 新手容易误解什么 讲清楚。若是工具平台，说明干什么用、什么时候用到",
  "keypoints": ["要点1（≤30字）", "要点2", "要点3", "要点4"],
  "related": ["从池子选的关联概念1", "关联概念2", "关联概念3"],
  "faqs": [
    {"q": "学习者最常问的具体口语化问题1", "a": "答案，200-400 字"},
    {"q": "问题2", "a": "答案"},
    {"q": "问题3", "a": "答案"}
  ],
  "sources": ["来源说明1", "来源说明2"]
}

⚠️ 硬性要求：
- faqs 必须正好 3 个对象，不许只给 1-2 个。
- keypoints 必须 2-4 条，每条≤30字。
- related 必须全部来自概念池，不许出现池子外的新词。
- sources 必须真实：本工作台上传资料只有大纲与书单目录、没有完整书内容。默认写「知识树原有解释 + 大模型拓展」——因为本次扩写是在工作台已有知识树词条的基础上做的补充完善，不是从某本书正文摘录的。只有某条信息确实能对应到指定书目之一时才写该书名，绝不编造引用。若本次提供了【网上检索资料】，把对应来源写成「博查检索：站点名（URL）」。**不要写「模型通用知识」这种说法**，用户看不懂也不关心信息来源是哪个模型。`;

function userPrompt(doc, titles, webText) {
  const sameGroup = titles.filter(t => t.group === doc.group).map(t => t.title);
  const others = titles.filter(t => t.group !== doc.group).map(t => t.title);
  const pool = [...new Set([...sameGroup, ...others])].filter(t => t !== doc.title);

  let s = `请重写下面这个知识点词条。

【知识点名称】${doc.title}
【所属分类】${doc.group || '未分类'} > ${doc.section || '未分类'}
【重要程度】${LEVEL_BY_MARK[doc.mark] || '需要理解'}
【我资料里已有的说法（仅供参考，可推翻重写，但以不矛盾为佳）】${(doc.content || '').replace(/\s+/g, ' ').trim()}
${doc.related && doc.related.length ? `【我原先随手写的关联概念】${doc.related.join('、')}（可参考，但仍须来自下面池子）` : ''}
${doc.en ? `【英文】${doc.en}` : ''}

【可选关联概念池】（只从这里选，原样复制名称）
${pool.join('、')}`;

  if (webText) s += `\n\n【网上检索资料】（来自博查，可用于补充最新/外部信息，引用时记进 sources）
${webText}`;
  return s;
}

// ---------- 清洗 ----------
function clean(t) {
  return String(t || '')
    .replace(/\*\*/g, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-*]{3,}\s*$/gm, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function parseJSONLoose(raw) {
  let s = String(raw).trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  return JSON.parse(s);
}

// ---------- 全局限流：429 时整池冷却 ----------
let cooldownUntil = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function withCooldown(fn) {
  const w = cooldownUntil - Date.now();
  if (w > 0) await sleep(w);
  return fn();
}

// ---------- DeepSeek ----------
async function callDeepSeek(key, doc, titles, webText) {
  const r = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: userPrompt(doc, titles, webText) },
      ],
      temperature: 0.6,
      max_tokens: 4096,
      response_format: { type: 'json_object' },
    }),
  });
  if (r.status === 429) {
    cooldownUntil = Date.now() + 25000;           // 全局冷却 25s
    throw new Error('HTTP 429 频率限制（已自动冷却重试）');
  }
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`HTTP ${r.status} ${t.slice(0, 200)}`);
  }
  const j = await r.json();
  return { raw: j.choices?.[0]?.message?.content || '', usage: j.usage || {} };
}

// ---------- 博查联网（可选）----------
async function webSearch(query, key) {
  const r = await fetch('https://api.bochaai.com/v1/web-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, freshness: 'noLimit', summary: true, count: 3 }),
  });
  if (!r.ok) throw new Error(`博查 ${r.status}`);
  const j = await r.json();
  const list = j.data?.webPages?.value || j.webPages?.value || [];
  return list.slice(0, 3).map(x => ({
    site: x.siteName || x.site || '',
    url: x.url || '',
    snippet: clean(x.summary || x.snippet || ''),
  })).filter(x => x.snippet);
}

// ---------- 主流程 ----------
(async () => {
  const { key, from } = readDeepSeekKey();
  if (!key) { console.error('❌ 没找到 DEEPSEEK_API_KEY'); process.exit(1); }
  console.log(`DeepSeek Key 来源：${from} ｜ 模型：${MODEL}`);

  const bochaKey = FORCE_WEB ? readBochaKey() : '';
  if (bochaKey) console.log('🌐 联网增强：已开启（博查）');
  else console.log('📝 联网增强：未配置博查 Key，跳过（sources 标「模型通用知识」）');

  const kb = JSON.parse(fs.readFileSync(KB_PATH, 'utf8'));

  // 读取已有的对比版（支持断点续传）
  let out;
  if (!DRY && fs.existsSync(NEW_PATH)) {
    try { out = JSON.parse(fs.readFileSync(NEW_PATH, 'utf8')); console.log('↺ 发现已有 kb.json.new，启用断点续传'); }
    catch { out = null; }
  }
  if (!out) {
    out = JSON.parse(JSON.stringify(kb));   // 深拷贝骨架（保留 catalog/stats/所有字段）
    out.generatedAt = new Date().toISOString();
    out.regen = { by: 'regen_knowledge.js', model: MODEL, webEnabled: !!bochaKey };
  }

  const docs = out.docs;
  const ALL_TITLES = docs.map(d => ({ title: d.title, group: d.group }));
  const TITLE_SET = new Set(ALL_TITLES.map(t => t.title));

  let targets = docs.filter(d => d.kind === 'concept');
  if (ONLY_ID) targets = targets.filter(d => d.id === ONLY_ID);
  // 续传以「是否已有 keypoints」为准：本脚本新增的字段，有就跳过（这样已扩写的 80 条不会再跑，只补缺失的 29 条必须掌握）
  if (!FORCE) targets = targets.filter(d => !Array.isArray(d.keypoints) || d.keypoints.length === 0);
  if (DRY) targets = targets.slice(0, 1);

  console.log(`目标概念条目：${targets.length} 个${DRY ? '（dry-run，只跑 1 条不落盘）' : ''}`);
  if (!targets.length) { console.log('没有需要处理的条目，退出。'); return; }

  const report = {
    startedAt: new Date().toISOString(), model: MODEL, webEnabled: !!bochaKey,
    ok: [], fail: [], inTok: 0, outTok: 0, beforeChars: 0, afterChars: 0,
  };
  // 基线：旧 content+explain 长度
  for (const d of targets) report.beforeChars += (d.content || '').length + (d.explain || '').length;

  let cursor = 0, done = 0;
  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= targets.length) return;
      const doc = targets[i];
      const oldLen = (doc.content || '').length + (doc.explain || '').length;

      // 1) 可选联网
      let webText = '', webSources = [];
      if (bochaKey) {
        try {
          const res = await withCooldown(() => webSearch(`${doc.title} ${doc.section || ''} AI产品经理`, bochaKey));
          if (res.length) {
            webText = res.map((x, k) => `（${k + 1}）${x.site}：${x.snippet}`).join('\n');
            webSources = res.map(x => `博查检索：${x.site}${x.url ? '（' + x.url + '）' : ''}`);
          }
        } catch (e) { /* 联网失败不阻断，退回纯模型知识 */ }
      }

      // 2) 调 DeepSeek（带重试 + 全局冷却）
      let lastErr = null, j = null;
      for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
        try {
          const { raw, usage } = await withCooldown(() => callDeepSeek(key, doc, ALL_TITLES, webText));
          j = parseJSONLoose(raw);
          if (!j.explain || j.explain.length < 300) throw new Error(`explain 太短(${(j.explain || '').length}字)`);
          report.inTok += usage.prompt_tokens || 0;
          report.outTok += usage.completion_tokens || 0;
          lastErr = null; break;
        } catch (e) {
          lastErr = e;
          if (attempt < MAX_RETRY) await sleep(1500 * attempt);
        }
      }
      if (lastErr) {
        report.fail.push({ id: doc.id, title: doc.title, error: lastErr.message });
        console.log(`❌ ${doc.id} ${doc.title} → ${lastErr.message}`);
        continue;
      }

      // 3) 落字段
      doc.en = clean(j.en) || doc.en || '';
      doc.content = clean(j.content).slice(0, 160) || doc.content;
      doc.explain = clean(j.explain);
      doc.keypoints = (Array.isArray(j.keypoints) ? j.keypoints : [])
        .map(x => clean(x)).filter(x => x).slice(0, 4);
      // related 只保留池子里真实存在的，避免点进去是空页面
      if (Array.isArray(j.related) && j.related.length) {
        const kept = j.related.map(x => clean(x)).filter(x => x && x !== doc.title && TITLE_SET.has(x));
        doc.related = kept.slice(0, 6);
      }
      doc.faqs = (Array.isArray(j.faqs) ? j.faqs : [])
        .filter(x => x && x.q && x.a).map(x => ({ q: clean(x.q), a: clean(x.a) })).slice(0, 3);
      // sources：合并模型自述 + 联网来源
      const src = (Array.isArray(j.sources) ? j.sources : []).map(x => clean(x)).filter(x => x);
      if (!src.length) src.push('知识树原有解释 + 大模型拓展');
      // 统一口径：把旧的「模型通用知识（非上传资料）」换掉
      // （用户看不懂、也不关心信息来源是哪个模型）
      doc.sources = [...new Set([...src, ...webSources].map(s =>
        /模型通用知识/.test(s) ? '知识树原有解释 + 大模型拓展' : s
      ))].slice(0, 5);
      doc.levelN = LEVEL_BY_MARK[doc.mark] || '需要理解';
      doc.level = doc.levelN;
      doc.regenAt = new Date().toISOString();
      doc.contentOrigin = '知识树原有解释 + 大模型拓展';
      // 重建检索文本（供关键词索引）
      doc.text = [doc.title, doc.en, doc.section, doc.group, doc.content, doc.related?.join(' ')].filter(Boolean).join(' ');

      done++;
      const newLen = (doc.content || '').length + (doc.explain || '').length;
      report.afterChars += newLen;
      report.ok.push({ id: doc.id, title: doc.title, chars: newLen, faqs: doc.faqs.length, related: doc.related.length, keypoints: doc.keypoints.length, sources: doc.sources.length });
      console.log(`✅ [${done}/${targets.length}] ${doc.id} ${doc.title} → ${newLen}字（原${oldLen}）, ${doc.faqs.length}问/${doc.related.length}关联/${doc.keypoints.length}要点`);

      // 每条落盘，防中断丢进度
      if (!DRY) {
        fs.writeFileSync(NEW_PATH, JSON.stringify(out, null, 1), 'utf8');
        report.finishedAt = new Date().toISOString();
        report.levelNormalized = 0;
        fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 1), 'utf8');
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));

  // -------------------------------------------------------------------------
  // 输出前端字段契约（在最终写盘前统一补一次）
  // -------------------------------------------------------------------------
  // 前端 public/index.html 的 renderDetail 读取的字段名与知识库内部字段不同，
  // 不补齐会退化：面包屑只剩一个词、关联概念点不动、来源不显示。
  // 这里让本脚本自己产出这些字段，避免每次重跑之后又要外部再补一遍。
  function applyContract(list) {
    // 关联概念名称 → id（用 title 兜底，因为本脚本不写 name 字段）
    const byName = new Map();
    for (const d of list) for (const k of [d.name, d.title]) if (k && !byName.has(k)) byName.set(k, d.id);

    for (const d of list) {
      d.name = d.name || d.title || '';
      d.categoryL1 = d.categoryL1 || d.group || '';
      d.categoryL2 = d.categoryL2 || d.section || '';

      // 面包屑：一级分类 › 二级分类 › 名称
      const last = d.name;
      const crumb = [d.categoryL1, d.categoryL2].filter(Boolean);
      if (!crumb.length) crumb.push(last);
      else if (crumb[crumb.length - 1] !== last) crumb.push(last);
      if (!Array.isArray(d.breadcrumb) || d.breadcrumb.length < 2) d.breadcrumb = crumb;

      // 关联概念 id
      d.relatedNames = Array.isArray(d.relatedNames) && d.relatedNames.length
        ? d.relatedNames
        : (Array.isArray(d.related) ? d.related : []);
      d.relatedIds = d.relatedNames.map(n => byName.get(n)).filter(id => id && id !== d.id);

      // 来源：只增不减
      const src = d.sourceBook || d.book || d.bookSource || '';
      d.sourceBook = src;
      if (!Array.isArray(d.sources) || !d.sources.length) d.sources = src ? [src] : [];

      // explain 缺失时回退到 content（绝不反向覆盖：explain 是扩写后的长文）
      if (!d.explain) d.explain = d.content || '';
      if (!Array.isArray(d.enrich)) d.enrich = [];
    }
    return list;
  }

  if (!DRY && out.docs) {
    applyContract(out.docs);
    out.stats = out.stats || {};
    out.stats.withRelations = out.docs.filter(d => (d.relatedIds || []).length > 0).length;
    out.stats.avgRelations = +(out.docs.reduce((s, d) => s + (d.relatedIds || []).length, 0) / out.docs.length).toFixed(2);
    out.stats.withFaqs = out.docs.filter(d => (d.faqs || []).length > 0).length;
    out.stats.withKeypoints = out.docs.filter(d => (d.keypoints || []).length > 0).length;
    fs.writeFileSync(NEW_PATH, JSON.stringify(out, null, 1), 'utf8');
    console.log(`\n契约字段已输出：breadcrumb ${out.docs.filter(d => (d.breadcrumb || []).length).length}/${out.docs.length}` +
      ` · relatedIds ${out.stats.withRelations}/${out.docs.length}` +
      ` · sources ${out.docs.filter(d => (d.sources || []).length).length}/${out.docs.length}`);
  }

  if (DRY && targets[0]) {
    const d = targets[0];
    console.log('\n──────── dry-run 样例 ────────');
    console.log('标题:', d.title, '| en:', d.en);
    console.log('摘要:', (d.content || '').slice(0, 200));
    console.log('要点:', (d.keypoints || []).join(' / '));
    console.log('来源:', (d.sources || []).join(' / '));
    console.log('关联:', (d.related || []).join(' / '));
    console.log('解释:\n' + (d.explain || '').slice(0, 900));
  } else {
    const avgBefore = targets.length ? Math.round(report.beforeChars / targets.length) : 0;
    const avgAfter = done ? Math.round(report.afterChars / done) : 0;
    const cost = (report.inTok / 1e6) * 3 + (report.outTok / 1e6) * 6;
    console.log('\n──────── 汇总 ────────');
    console.log(`成功 ${report.ok.length} 条，失败 ${report.fail.length} 条`);
    console.log(`平均字数：原 ${avgBefore} → 新 ${avgAfter}（约 ${avgAfter ? (avgAfter / Math.max(1, avgBefore)).toFixed(1) : '?'} 倍）`);
    console.log(`token：输入 ${report.inTok} / 输出 ${report.outTok} ｜ 估算费用 ≈ ${cost.toFixed(3)} 元`);
    console.log(`对比版已写出：${path.basename(NEW_PATH)}`);
    if (!DRY) console.log(`预览：把 data/kb.json.new 换到 data-new 后启动预览实例即可`);
  }
})();
