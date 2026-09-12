#!/usr/bin/env node
/**
 * enrich_kb.js —— 知识库内容增强（大模型补充完善）
 * =====================================================================
 * 作用：把"只有一段概念解释"的知识点，升级成结构化的完整内容：
 *        概念解释（保留原有，不覆盖）
 *        + 核心要点（3-5 条）
 *        + 应用场景（贴近 AI 产品经理实际工作）
 *        + 关联概念（3-5 个，必须是知识库里已存在的知识点名称）
 *
 * 【重要：关于"来源书籍"的如实说明】
 *   工作区里那 15 本（去重后 13 本）书籍资料**只有书名 + 章节目录 + 一段简介**，
 *   没有书籍正文。因此无法为每个知识点标注真实的书籍章节出处。
 *   本脚本的处理原则：
 *     · 来源字段区分三档：原始（知识树已有）/ 书目（确实来自某本书的目录）/ 拓展补充（大模型生成）
 *     · 让模型只在"确实能对应到某本书目录"时才填 bookRef，否则留空
 *     · **绝不编造章节号** —— 宁可留空
 *
 * 关于 API 调用：
 *   · 批量处理，一次请求 6 个知识点，减少调用次数
 *   · 每处理完一批就落盘，中断可续跑（--resume 默认开启，已增强的会跳过）
 *   · 支持 --limit N 先跑一小部分验证效果
 *
 * 启动命令：
 *   cd mvp
 *   node enrich_kb.js --limit 6      # 先试 6 条
 *   node enrich_kb.js                # 全量（137 条，约 23 次请求）
 *   node enrich_kb.js --force        # 重新增强全部
 * =====================================================================
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = __dirname;
const KB_PATH = path.join(ROOT, 'data', 'kb.json');

const argv = process.argv.slice(2);
const LIMIT = (() => {
  const i = argv.indexOf('--limit');
  return i >= 0 ? Number(argv[i + 1]) : 0;
})();
const FORCE = argv.includes('--force');
const BATCH = (() => {
  const i = argv.indexOf('--batch');
  return i >= 0 ? Number(argv[i + 1]) : 6;
})();

const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const BASE = process.env.DEEPSEEK_BASE || 'https://api.deepseek.com';

// ---------------------------------------------------------------------------
// API Key（与 server.js 同一来源）
// ---------------------------------------------------------------------------
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
if (!KEY) {
  console.error('找不到 DEEPSEEK_API_KEY。请设置环境变量，或写入 ~/.dsh/.credentials.yaml');
  process.exit(1);
}

if (!fs.existsSync(KB_PATH)) {
  console.error(`找不到 ${KB_PATH}，请先运行 build_kb.js`);
  process.exit(1);
}
const kb = JSON.parse(fs.readFileSync(KB_PATH, 'utf8'));
const docs = kb.docs;
const allTitles = docs.map(d => d.name || d.title);

// ---------------------------------------------------------------------------
// 提示词：要求严格 JSON，避免解析失败
// ---------------------------------------------------------------------------
const SYS = `你是资深 AI 产品经理培训讲师，正在为一份学习知识库补充内容。
你的读者是零基础转行做 AI 产品经理的人：没有技术背景，需要具体、能落地的解释。

对每个给定的知识点，补充以下内容：

1. keys: 3-5 条核心要点。每条一句话，说清"是什么/为什么重要/要注意什么"。
2. scenario: 1-2 句应用场景，说明这个知识点在 AI 产品经理的实际工作里什么时候用得上。
3. related: 3-5 个关联概念。**必须从下面的候选概念列表里选**，不能自创名称。
   用"语义相关、学习时应当一起掌握"为标准挑选。
4. faqs: **2-3 个初学者最可能问的问题及答案**。这是详情页的"AI答疑"区，直接展示给用户。
   · q 是问题的原话（用户口吻，如"RAG和微调到底该用哪个？"）
   · a 是答案，2-4 句，通俗、具体、最好带类比或例子
5. bookRef: 如果你能确定该知识点对应下列书籍目录中的某一章，填写"书名 · 章节名"；
   **不确定就填空字符串**。绝对不要编造章节号。

写作要求：
- 通俗易懂，不用技术黑话；必须用术语时，用一句生活化的话解释它。
- 不要照抄原解释，要补充原解释没有的信息（原解释会一并给你）。
- 不要用 Markdown 加粗标记（**），不要用 # 标题，纯文本即可。
- 全部用中文。

严格输出 JSON，不要任何解释文字或代码块围栏。格式：
{"items":[{"id":"d1","keys":["..."],"scenario":"...","related":["名称1","名称2","名称3"],"faqs":[{"q":"...","a":"..."}],"bookRef":""}]}`;

function buildUserPrompt(batch, bookList) {
  const lines = [];
  lines.push('【候选关联概念列表】（related 只能从这里选）');
  lines.push(bookList.join('、'));
  lines.push('');
  lines.push('【书籍目录参考】（bookRef 用；不确定就留空）');
  lines.push('《秒懂智能体：AI Agent重新定义未来工作》：第1章你不可不知的AI变革 / 第2章提示词设计 / 第3章文心一言智能体 / 第4章智谱清言智能体 / 第5章GPTs进阶指南 / 第6章扣子智能体');
  lines.push('《AI产品经理实战：从大模型集成到商业化落地》：第1章AI产品简介与方法论基础 / 第2章AI产品原型设计 / 第3章大模型技术选型与集成 / 第4章AI产品交互体验设计 / 第5章AI产品商业化落地 / 第6章行业实战案例拆解');
  lines.push('《AI产品经理：方法、技术与实战》：第1章深入理解AI和AI产品 / 第2章AI产品经理职业全景 / 第3-6章AI技术通识 / 第7-11章AI产品落地实践 / 第12-13章行业与项目实战');
  lines.push('');
  lines.push('【待补充的知识点】');
  for (const d of batch) {
    lines.push(`- id: ${d.id}`);
    lines.push(`  名称: ${d.name}`);
    lines.push(`  分类: ${d.categoryL1} > ${d.categoryL2}`);
    lines.push(`  原有解释: ${d.content}`);
  }
  return lines.join('\n');
}

async function callLLM(batch, bookList) {
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: SYS },
      { role: 'user', content: buildUserPrompt(batch, bookList) },
    ],
    temperature: 0.4,
    response_format: { type: 'json_object' },
    stream: false,
  };
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`API ${res.status} ${res.statusText} ${t.slice(0, 300)}`);
  }
  const j = await res.json();
  const txt = j.choices?.[0]?.message?.content || '';
  const usage = j.usage || {};
  // 容错：可能被包在 ```json 里
  const clean = txt.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch (e) {
    const m = clean.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('返回内容不是 JSON：' + clean.slice(0, 200));
    parsed = JSON.parse(m[0]);
  }
  return { items: parsed.items || [], usage };
}

// ---------------------------------------------------------------------------
// 前端字段契约补齐
// ---------------------------------------------------------------------------
// 前端 public/index.html 的 renderDetail 读取的字段名与本知识库的内部字段名不同，
// 若不补齐，详情页会退化：核心要点不显示、正文提示"还没做内容扩写"、
// 面包屑为空、AI答疑区没有可选问题、来源不显示。
//
// 契约映射（前端读 → 本库字段）：
//   explain    ← content（清洗后的概念解释正文）
//   keypoints  ← keys（核心要点）
//   faqs       ← faqs（AI答疑的常见问题）
//   breadcrumb ← [一级分类, 二级分类, 名称]（书目条目为 [书名, 章节, 标题]）
//   sources    ← [sourceBook]（真实来源；bookRefHint 是未核对的推测，不放进 sources）
//   levelN     ← 掌握程度的文字形式（如"必须掌握"），供前端渲染标签
//   enrich     ← 笔记 AI 补全产生的补充内容（初始为空数组，由 /api/enrich 写入）
function applyFrontendContract(d) {
  // ⚠️ 绝不覆盖已有的 explain！
  // tools/regen_knowledge.js 会写入 800+ 字的长文 explain，
  // 之前这里写成 `d.explain = d.content` 把全库 93913 字压成了 19094 字。
  // 只在 explain 缺失时才回退到 content。
  if (!d.explain) d.explain = d.content || '';
  d.content = d.content || d.explain;

  if (!d.name) d.name = d.title || '';
  if (!d.categoryL1) d.categoryL1 = d.group || '';
  if (!d.categoryL2) d.categoryL2 = d.section || '';

  // keypoints 可能来自 keys（本脚本生成）或直接叫 keypoints（regen 脚本生成）
  d.keypoints = Array.isArray(d.keypoints) && d.keypoints.length
    ? d.keypoints
    : (Array.isArray(d.keys) ? d.keys : []);
  d.faqs = Array.isArray(d.faqs) ? d.faqs : [];

  // 关联概念：兼容 related（名称数组）与 relatedNames 两种字段名
  const relNames = (Array.isArray(d.relatedNames) && d.relatedNames.length)
    ? d.relatedNames
    : (Array.isArray(d.related) ? d.related : []);
  d.relatedNames = relNames;

  // 面包屑：优先用「一级分类 / 二级分类 / 名称」三级；
  // regen 脚本会把 breadcrumb 写成只有名称的一项数组，那种情况要重算，
  // 否则详情页的面包屑只剩一个词。
  const last = d.name || d.title || '';
  const rebuilt = [d.categoryL1, d.categoryL2].filter(Boolean);
  if (!rebuilt.length) rebuilt.push(last);
  else if (rebuilt[rebuilt.length - 1] !== last) rebuilt.push(last);
  if (!Array.isArray(d.breadcrumb) || d.breadcrumb.length < 2) {
    d.breadcrumb = rebuilt;
  }

  // 来源：sourceBook 优先，退回 book/bookSource
  const src = d.sourceBook || d.book || d.bookSource || '';
  d.sourceBook = src;
  if (!Array.isArray(d.sources) || !d.sources.length) {
    d.sources = src ? [src] : [];
  }

  // 掌握程度文字标签：level 可能是"核心技术"这类原始标签，levelN 要给人看的档位
  const lvRaw = d.level || d.levelRaw || '';
  if (!d.levelN || d.levelN === lvRaw) {
    d.levelN = (d.mark === '🔴' ? '必须掌握' : d.mark === '🟡' ? '需要理解' : '了解即可');
  }

  if (!Array.isArray(d.enrich)) d.enrich = [];
  return d;
}

// 关联概念名称 → id。注意必须用 title 兜底：
// regen 脚本生成的 kb.json 里没有 name 字段，只用 d.name 建索引会全部解析失败。
function resolveRelatedIds(docs) {
  const byName = new Map();
  for (const d of docs) {
    for (const k of [d.name, d.title]) if (k && !byName.has(k)) byName.set(k, d.id);
  }
  for (const d of docs) {
    d.relatedIds = (d.relatedNames || d.related || [])
      .map(n => byName.get(n))
      .filter(id => id && id !== d.id);
  }
  return docs;
}

// 把模型返回的单条结果写回知识点（批量与重试共用同一套逻辑）
function applyItem(d, it) {
  // 校验 related：只保留知识库里真实存在的名称，避免模型自创
  const rel = (it.related || [])
    .map(x => String(x).trim())
    .filter(x => allTitles.includes(x) && x !== d.name);
  if (rel.length) d.relatedNames = rel.slice(0, 5);

  d.keys = (it.keys || []).map(k => String(k).trim()).filter(Boolean).slice(0, 5);
  d.scenario = String(it.scenario || '').trim();

  // 详情页「AI答疑」区所需：2-3 个常见问题
  d.faqs = (it.faqs || [])
    .map(f => ({ q: String(f.q || '').trim(), a: String(f.a || '').trim() }))
    .filter(f => f.q && f.a)
    .slice(0, 3);

  // bookRef 是模型推测的"可能相关章节"，无法验证（我们没有书籍正文）。
  // 因此单独存为 bookRefHint，并明确标注"待核对"，**不**写进 sourceBook 冒充确切出处。
  d.bookRefHint = String(it.bookRef || '').trim();
  if (d.kind === 'book') {
    d.sourceBook = d.book;
    d.contentOrigin = '书目';
  } else {
    // 知识树是真实的整理来源，保持它作为 sourceBook，并标出内容构成
    d.sourceBook = 'AI产品经理知识树';
    d.contentOrigin = '知识树原有解释 + 大模型拓展';
  }
  d.enriched = true;
  d.enrichedAt = new Date().toISOString();
  return d;
}

// 原子写：先写临时文件再改名，避免与其它进程（如 tools/regen_knowledge.js）
// 抢同一个文件时把内容写坏；改名失败则重试几次。
function saveKB(kb) {
  const tmp = KB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(kb), 'utf8');
  for (let i = 0; i < 6; i++) {
    try {
      fs.renameSync(tmp, KB_PATH);
      return true;
    } catch (e) {
      if (i === 5) {
        console.error(`\n  ⚠️ 写入 ${path.basename(KB_PATH)} 失败（${e.code}），临时文件保留在 ${path.basename(tmp)}`);
        return false;
      }
      // 同步等待，给占用方一点时间释放
      const end = Date.now() + 400 * (i + 1);
      while (Date.now() < end) { /* busy wait */ }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
(async () => {
  // --contract-only：只补前端字段契约，不调用 API。
  // 用于内容已增强但字段名不匹配的场景（改字段名不该再花一次 API 钱）。
  if (argv.includes('--contract-only')) {
    for (const d of docs) applyFrontendContract(d);
    resolveRelatedIds(docs);
    kb.stats.withFaqs = docs.filter(d => (d.faqs || []).length > 0).length;
    kb.stats.withRelations = docs.filter(d => (d.relatedIds || []).length > 0).length;
    saveKB(kb);
    const exTotal = docs.reduce((s, d) => s + (d.explain || '').length, 0);
    console.log(`✅ 已补齐前端契约字段（未调用 API）`);
    console.log(`   explain: ${docs.filter(d => d.explain).length}/${docs.length}，总字数 ${exTotal}`);
    console.log(`   keypoints: ${docs.filter(d => (d.keypoints || []).length).length}/${docs.length}`);
    console.log(`   faqs: ${docs.filter(d => (d.faqs || []).length).length}/${docs.length}`);
    console.log(`   breadcrumb: ${docs.filter(d => (d.breadcrumb || []).length).length}/${docs.length}`);
    console.log(`   sources: ${docs.filter(d => (d.sources || []).length).length}/${docs.length}`);
    console.log(`   levelN: ${docs.filter(d => d.levelN).length}/${docs.length}`);
    console.log(`   relatedIds: ${docs.filter(d => (d.relatedIds || []).length).length}/${docs.length}`);
    return;
  }

  // 待增强判定：未增强，或增强过但没有 faqs（早期版本没生成 faqs）
  const todo = FORCE ? docs.slice() : docs.filter(d => !d.enriched || !(d.faqs || []).length);
  const target = LIMIT ? todo.slice(0, LIMIT) : todo;

  console.log('='.repeat(70));
  console.log('  知识库内容增强');
  console.log('='.repeat(70));
  console.log(`  知识库：    ${docs.length} 条（待增强 ${todo.length} 条）`);
  console.log(`  本次处理：  ${target.length} 条`);
  console.log(`  批大小：    ${BATCH} 条/次请求`);
  console.log(`  预计请求：  ${Math.ceil(target.length / BATCH)} 次`);
  console.log(`  模型：      ${MODEL}`);
  console.log('');

  if (!target.length) {
    console.log('  所有条目都已增强。要重跑请加 --force');
    return;
  }

  let done = 0, failed = 0;
  let promptTokens = 0, completionTokens = 0;
  const t0 = Date.now();

  for (let i = 0; i < target.length; i += BATCH) {
    const batch = target.slice(i, i + BATCH);
    const n = Math.floor(i / BATCH) + 1;
    const total = Math.ceil(target.length / BATCH);
    process.stdout.write(`\r  [${n}/${total}] 处理 ${batch.map(d => d.name).join('、').slice(0, 50)}…`);

    let r;
    try {
      r = await callLLM(batch, allTitles);
    } catch (e) {
      // 失败常见原因是模型返回的 JSON 被截断或含非法转义。
      // 重试一次并调小批，能救回大部分情况（否则整批 6 条全丢）。
      const isJsonErr = /JSON|Unexpected|position/i.test(e.message);
      if (isJsonErr && batch.length > 2) {
        console.log(`\n  ⚠️ 第 ${n} 批 JSON 解析失败，拆成小批重试…`);
        for (const one of batch) {
          try {
            const r1 = await callLLM([one], allTitles);
            const it1 = (r1.items || [])[0];
            if (!it1) { failed++; continue; }
            promptTokens += r1.usage.prompt_tokens || 0;
            completionTokens += r1.usage.completion_tokens || 0;
            applyItem(one, it1);
            done++;
          } catch (e2) {
            failed++;
            console.log(`  ❌ ${one.name} 仍失败：${e2.message.slice(0, 80)}`);
          }
          kb.stats.enriched = docs.filter(d => d.enriched).length;
          saveKB(kb);
        }
        continue;
      }
      failed += batch.length;
      console.log(`\n  ❌ 第 ${n} 批失败：${e.message.slice(0, 120)}`);
      await new Promise(res => setTimeout(res, 2000));
      continue;
    }
    promptTokens += r.usage.prompt_tokens || 0;
    completionTokens += r.usage.completion_tokens || 0;

    const byId = new Map(r.items.map(it => [it.id, it]));
    for (const d of batch) {
      const it = byId.get(d.id);
      if (!it) { failed++; continue; }
      applyItem(d, it);
      done++;
    }

    // 每批落盘，中断可续
    kb.stats.enriched = docs.filter(d => d.enriched).length;
    saveKB(kb);
  }

  // 关联 id 需要在增强后重算（因为 relatedNames 变了）
  const byName = new Map(docs.map(d => [d.name, d.id]));
  for (const d of docs) {
    d.relatedIds = (d.relatedNames || []).map(n => byName.get(n)).filter(id => id && id !== d.id);
    applyFrontendContract(d);
  }
  kb.stats.enriched = docs.filter(d => d.enriched).length;
  kb.stats.withRelations = docs.filter(d => (d.relatedIds || []).length > 0).length;
  kb.stats.avgRelations = +(docs.reduce((s, d) => s + (d.relatedIds || []).length, 0) / docs.length).toFixed(2);
  kb.stats.withFaqs = docs.filter(d => (d.faqs || []).length > 0).length;
  kb.enrichedAt = new Date().toISOString();
  saveKB(kb);

  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\n\n  ✅ 完成：成功 ${done} 条，失败 ${failed} 条，耗时 ${secs}s`);
  console.log(`  Token：输入 ${promptTokens} · 输出 ${completionTokens}`);
  // deepseek-chat 参考价：输入约 ¥2/百万、输出约 ¥8/百万（以官方为准）
  const cost = (promptTokens / 1e6) * 2 + (completionTokens / 1e6) * 8;
  console.log(`  预估费用：约 ¥${cost.toFixed(4)}（按 ¥2/¥8 每百万 token 估算，以官方价目为准）`);
  console.log(`  关联网络：${kb.stats.withRelations}/${docs.length} 条有关联，平均 ${kb.stats.avgRelations} 个`);
  console.log(`  ⚠️ 内容变了，记得重建向量索引：node build_embeddings.js`);
  console.log('');

  // 抽样展示
  const sample = docs.filter(d => d.enriched).slice(0, 2);
  for (const d of sample) {
    console.log(`  ── 样例：${d.name}（${d.contentOrigin}）`);
    console.log(`     原有解释：${d.content.slice(0, 80)}`);
    (d.keys || []).forEach(k => console.log(`     要点：${k}`));
    if (d.scenario) console.log(`     场景：${d.scenario}`);
    console.log(`     关联：${(d.relatedNames || []).join('、')}`);
    if (d.bookRefHint) console.log(`     目录线索（待核对）：${d.bookRefHint}`);
    console.log('');
  }
})().catch(e => { console.error('\n❌ 失败:', e.message); process.exit(1); });
