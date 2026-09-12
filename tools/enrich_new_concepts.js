#!/usr/bin/env node
/**
 * enrich_new_concepts.js —— 给新增知识点补充深入解释
 * =====================================================================
 * 背景：
 *   merge 进来的 35 个方法论知识点，explain 只有 90-160 字（我写的数据源就是短文），
 *   而知识树原有概念都是 600-900 字的深入讲解。两者放在同一个详情页里，
 *   阅读体验不一致，面试场景也不够用。
 *
 * 做什么：
 *   只针对「产品与设计方法论」这一支的新知识点，调用 DeepSeek 生成
 *   600-900 字的深入解释，**追加**到 explain（保留原有定义段落，不改写）。
 *
 * 不做：书目的章节条目（那些本来就是大纲，扩写没有意义）。
 *
 * 断点续传：explain 已经超过 500 字的跳过。
 * 命令：node tools/enrich_new_concepts.js [--limit N] [--force]
 * 之后必须：node build_embeddings.js
 * =====================================================================
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const KB_PATH = path.join(ROOT, 'data', 'kb.json');
const IDX_PATH = path.join(ROOT, 'data', 'index.json');

const argv = process.argv.slice(2);
const LIMIT = (() => { const i = argv.indexOf('--limit'); return i >= 0 ? Number(argv[i + 1]) : 0; })();
const FORCE = argv.includes('--force');
const BATCH = (() => { const i = argv.indexOf('--batch'); return i >= 0 ? Number(argv[i + 1]) : 3; })();

const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const BASE = process.env.DEEPSEEK_BASE || 'https://api.deepseek.com';
const TARGET_L1 = '产品与设计方法论';
const MIN_CHARS = 500;

function resolveKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const p = path.join(os.homedir(), '.dsh', '.credentials.yaml');
    if (!fs.existsSync(p)) return null;
    const m = fs.readFileSync(p, 'utf8').match(/^\s*DEEPSEEK_API_KEY\s*:\s*(\S+)\s*$/m);
    return m ? m[1] : null;
  } catch { return null; }
}
const KEY = resolveKey();
if (!KEY) { console.error('找不到 DEEPSEEK_API_KEY'); process.exit(1); }

const kb = JSON.parse(fs.readFileSync(KB_PATH, 'utf8'));
const docs = kb.docs;

function saveKB() {
  const tmp = KB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(kb), 'utf8');
  fs.renameSync(tmp, KB_PATH);
}

const SYS = `你是资深 AI 产品经理培训讲师，正在为零基础转行的学员写知识库条目。
学员特点是：没有技术背景、需要能直接用在面试和工作里的知识、讨厌空话。

给你的每个知识点，请写一段 600-900 字的深入解释，要求：

结构（用小标题分段，纯文本，不要 Markdown 的 ** 加粗和 # 标题）：
1. 它到底在说什么 —— 用生活化的类比把概念讲透，不要复述定义
2. 为什么产品经理必须懂它 —— 讲清实际工作里不用它会出什么问题
3. 怎么用 —— 给一个具体可操作的步骤或判断方法
4. 常见的误解或坑 —— 新手最容易搞错的地方
5. 面试/工作中会怎么被问到 —— 给 1-2 个典型问法和答题要点

写作要求：
- 通俗、具体、有例子。禁止"综上所述""值得注意的是"这类书面语。
- 不要编造数据、书名、人名。不需要引用来源。
- 不要用 Markdown 加粗标记（**），不要用 # 标题。
- 全部中文。

严格输出 JSON，不要代码块围栏：
{"items":[{"id":"d1","explain":"..."}]}`;

async function callLLM(batch) {
  const user = batch.map(d =>
    `- id: ${d.id}\n  名称: ${d.name}\n  分类: ${d.categoryL1} > ${d.categoryL2}\n` +
    `  现有简述: ${d.content}\n  核心要点: ${(d.keys || []).join('；')}`
  ).join('\n\n');

  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYS },
        { role: 'user', content: `请为下面 ${batch.length} 个知识点各写一段深入解释。\n\n${user}` },
      ],
      temperature: 0.5,
      response_format: { type: 'json_object' },
      stream: false,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`API ${res.status} ${t.slice(0, 200)}`);
  }
  const j = await res.json();
  const txt = (j.choices?.[0]?.message?.content || '').replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  let parsed;
  try { parsed = JSON.parse(txt); }
  catch {
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('返回不是 JSON：' + txt.slice(0, 150));
    parsed = JSON.parse(m[0]);
  }
  return { items: parsed.items || [], usage: j.usage || {} };
}

function applyItem(d, it) {
  const add = String(it.explain || '').trim();
  if (add.length < 200) return false;
  const head = `【概念定义】${d.content}`;
  d.explain = `${head}\n\n${add}`;
  d.enrichDeep = true;
  d.enrichDeepAt = new Date().toISOString();
  return true;
}

(async () => {
  const todo = FORCE
    ? docs.filter(d => d.categoryL1 === TARGET_L1)
    : docs.filter(d => d.categoryL1 === TARGET_L1 && (d.explain || '').length < MIN_CHARS);
  const target = LIMIT ? todo.slice(0, LIMIT) : todo;

  console.log('='.repeat(70));
  console.log('  新增知识点深入解释');
  console.log('='.repeat(70));
  console.log(`  目标分类：${TARGET_L1}`);
  console.log(`  知识库总计：${docs.length} 条`);
  console.log(`  待补：${todo.length} 条，本次处理 ${target.length} 条`);
  console.log(`  批大小：${BATCH}，预计 ${Math.ceil(target.length / BATCH)} 次请求`);
  console.log('');

  if (!target.length) { console.log('  已全部补完。要重跑加 --force'); return; }

  let done = 0, failed = 0, inTok = 0, outTok = 0;
  const t0 = Date.now();

  for (let i = 0; i < target.length; i += BATCH) {
    const batch = target.slice(i, i + BATCH);
    const n = Math.floor(i / BATCH) + 1, total = Math.ceil(target.length / BATCH);
    process.stdout.write(`\r  [${n}/${total}] ${batch.map(d => d.name).join('、').slice(0, 46)}…`);

    let r;
    try {
      r = await callLLM(batch);
    } catch (e) {
      // JSON 截断时拆成单条重试，避免整批丢
      console.log(`\n  ⚠️ 第 ${n} 批失败（${e.message.slice(0, 60)}），拆小批重试…`);
      for (const one of batch) {
        try {
          const r1 = await callLLM([one]);
          inTok += r1.usage.prompt_tokens || 0; outTok += r1.usage.completion_tokens || 0;
          const it1 = (r1.items || [])[0];
          if (it1 && applyItem(one, it1)) done++; else failed++;
        } catch (e2) { failed++; console.log(`  ❌ ${one.name}: ${e2.message.slice(0, 60)}`); }
        saveKB();
      }
      continue;
    }
    inTok += r.usage.prompt_tokens || 0;
    outTok += r.usage.completion_tokens || 0;
    const byId = new Map((r.items || []).map(x => [x.id, x]));
    for (const d of batch) {
      const it = byId.get(d.id);
      if (it && applyItem(d, it)) done++; else failed++;
    }
    saveKB();
  }

  // 重建检索文本（新内容要能被搜到）
  for (const d of docs) {
    d.text = [d.title, d.en, d.categoryL1, d.categoryL2, d.level, d.content,
      (d.keys || []).join(' '), d.scenario || '',
      (d.faqs || []).map(f => f.q + ' ' + f.a).join(' '),
      (d.relatedNames || []).join(' '), d.explain || ''].filter(Boolean).join(' ');
  }
  kb.stats = Object.assign(kb.stats || {}, {
    enriched: docs.filter(d => d.enriched || d.enrichDeep).length,
    withLongExplain: docs.filter(d => (d.explain || '').length > 300).length,
  });
  saveKB();

  // 重建索引
  const STOP = new Set('的了和是在有与及或我你他她它们这那什么怎么如何为什么吗呢吧啊哦嗯一个能不能可以需要要是就是都也很还只把被让对从到与以及等'.split(''));
  function termsOf(text) {
    const out = new Set();
    const s = String(text || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (/[\u4e00-\u9fa5]/.test(c)) {
        if (!STOP.has(c)) out.add(c);
        if (i + 1 < s.length) {
          const c2 = s[i + 1];
          if (/[\u4e00-\u9fa5]/.test(c2) && !STOP.has(c) && !STOP.has(c2)) out.add(c + c2);
        }
      } else if (/[a-z0-9]/.test(c)) {
        let k = i; while (k < s.length && /[a-z0-9+#.]/.test(s[k])) k++;
        out.add(s.slice(i, k)); i = k - 1;
      }
    }
    for (const w of String(text || '').toLowerCase().match(/[a-z][a-z0-9+#.]*/g) || []) out.add(w);
    return [...out];
  }
  const postings = {}, docMap = {}, docTerms = [];
  docs.forEach((d, i) => {
    docMap[i] = d.id;
    const ts = termsOf(d.text);
    docTerms.push(ts);
    for (const t of ts) (postings[t] = postings[t] || []).push(i);
  });
  fs.writeFileSync(IDX_PATH, JSON.stringify({
    generatedAt: new Date().toISOString(),
    docCount: docs.length, termCount: Object.keys(postings).length,
    docMap, postings, docTerms,
  }), 'utf8');

  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  const cost = (inTok / 1e6) * 3 + (outTok / 1e6) * 6;
  console.log(`\n\n  ✅ 成功 ${done} 条，失败 ${failed} 条，耗时 ${secs}s`);
  console.log(`  Token：输入 ${inTok} / 输出 ${outTok} ｜ 估算费用 ≈ ¥${cost.toFixed(3)}`);
  console.log(`  长文解释覆盖：${kb.stats.withLongExplain}/${docs.length}`);
  console.log(`  索引词条：${Object.keys(postings).length}`);
  console.log(`\n⚠️ 内容已变，必须重建向量：node build_embeddings.js`);
  console.log('');

  const sample = docs.filter(d => d.enrichDeep).slice(0, 1)[0];
  if (sample) {
    console.log(`  ── 样例：${sample.name}（${(sample.explain || '').length} 字）`);
    console.log('  ' + (sample.explain || '').slice(0, 400).replace(/\n/g, '\n  '));
    console.log('');
  }
})().catch(e => { console.error('\n❌ 失败:', e.message); process.exit(1); });
