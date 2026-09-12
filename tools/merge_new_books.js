#!/usr/bin/env node
/**
 * merge_new_books.js —— 把新增 10 本书合并进现有知识库
 * =====================================================================
 * 输入：
 *   data/kb.json                  现有知识库（137 条）
 *   tools/new_books_data.js       新增 10 本书的书目信息 + 30 个方法论知识点
 *
 * 输出：
 *   data/kb.json                  合并后的知识库
 *   data/index.json               重建的关键词倒排索引
 *   data/merge_report.json        本次合并报告（新增/跳过/疑似重复）
 *
 * 合并原则：
 *   1. 书目条目按书名去重——已存在的不重复添加
 *   2. 知识点先做四层去重检测（精确名 / 规范化名 / 包含关系 / 关键词重合度），
 *      命中就把新内容的要点合并到已有条目，而不是新增冗余
 *   3. 疑似重复但不完全确定的，只记录到报告里，不擅自合并——避免把不同概念揉在一起
 *   4. 所有条目重排 id、重建 catalog 与 stats，字段与现有格式完全兼容
 *
 * 命令：node tools/merge_new_books.js
 * 之后必须跑：node build_embeddings.js
 * =====================================================================
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const KB_PATH = path.join(ROOT, 'data', 'kb.json');
const IDX_PATH = path.join(ROOT, 'data', 'index.json');
const REPORT_PATH = path.join(ROOT, 'data', 'merge_report.json');

const { BOOKS, CONCEPTS } = require('./new_books_data.js');

const kb = JSON.parse(fs.readFileSync(KB_PATH, 'utf8'));
const docs = kb.docs;

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
// 名称规范化：去掉空白、标点、全半角差异，用于比对"同一个东西的不同写法"
function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\u3000]/g, '')
    .replace(/[·・\-—_/\\（）()【】\[\]{}《》<>「」『』"'`，。、；：！？,.;:!?]/g, '')
    .trim();
}

// 关键词集合（中文 bigram + 英文词），用于计算重合度
function tokenSet(s) {
  const out = new Set();
  const t = String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (/[\u4e00-\u9fa5]/.test(c)) {
      out.add(c);
      if (i + 1 < t.length && /[\u4e00-\u9fa5]/.test(t[i + 1])) out.add(c + t[i + 1]);
    }
  }
  for (const w of t.match(/[a-z][a-z0-9+#.]*/g) || []) out.add(w);
  return out;
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

const byName = new Map();        // 规范化名 → doc
const byTitle = new Map();       // 原书名 → doc
for (const d of docs) {
  byName.set(normName(d.name || d.title), d);
  byTitle.set(d.title, d);
}

const report = {
  mergedAt: new Date().toISOString(),
  before: {
    total: docs.length,
    concept: docs.filter(d => d.kind === 'concept').length,
    book: docs.filter(d => d.kind === 'book').length,
    categories: (kb.catalog || []).length,
  },
  newBooks: { added: [], skipped: [] },
  newConcepts: { added: [], mergedIntoExisting: [], skippedDuplicate: [], suspected: [] },
  after: {},
};

// ---------------------------------------------------------------------------
// 1. 合并书目（按书名去重）
// ---------------------------------------------------------------------------
const CATALOG_L2_MAX = '书目信息与阅读建议';
const bookTitles = new Set(docs.filter(d => d.kind === 'book').map(d => d.book || d.categoryL1));

for (const b of BOOKS) {
  // 已存在同名书 → 跳过（不做内容覆盖，避免破坏已有扩写内容）
  if (bookTitles.has(b.title)) {
    report.newBooks.skipped.push({ title: b.title, reason: '知识库已有同名书目' });
    continue;
  }

  // 书目信息条
  docs.push(makeBookDoc(b, CATALOG_L2_MAX, {
    content: `【定位】${b.gist}\n【适合谁】零基础转行 AI 产品经理的人；${b.type}\n` +
      `【出版信息】${b.author}｜${b.press}｜${b.rating}\n【所属阶段】${b.stage}（${b.purpose}）`,
    extra: b,
  }));

  // 每个章节一条
  b.outline.forEach((line, i) => {
    docs.push(makeBookDoc(b, line, {
      content: `${line}\n\n【本书主旨】${b.gist}\n【本章要点】${(b.points[i] || b.points[0] || '')}`,
      extra: b,
    }));
  });

  // 核心观点汇总条（便于检索"这本书讲什么"）
  docs.push(makeBookDoc(b, '核心观点与阅读建议', {
    content: `【一句话主旨】${b.gist}\n\n【核心观点】\n` +
      b.points.map((p, i) => `${i + 1}. ${p}`).join('\n') +
      `\n\n【为什么推荐】${b.why}\n\n【阅读建议】${b.advice}`,
    extra: b,
  }));

  bookTitles.add(b.title);
  report.newBooks.added.push({ title: b.title, entries: b.outline.length + 2 });
}

// 阅读顺序总览（单独一条，方便"我该按什么顺序读"）
{
  const order = BOOKS.map((b, i) => `${i + 1}. 《${b.title}》— ${b.type}（${b.rating}）`).join('\n');
  const stages = [...new Set(BOOKS.map(b => b.stage))];
  const stageText = stages.map(s => {
    const list = BOOKS.filter(b => b.stage === s);
    return `${s}：${list.map(b => '《' + b.title + '》').join('、')}　目标：${list[0].purpose}`;
  }).join('\n');
  docs.push({
    id: '',
    kind: 'book',
    title: 'AI产品经理入门推荐书单 · 10本',
    name: 'AI产品经理入门推荐书单 · 10本',
    book: 'AI产品经理入门推荐书单 · 10本',
    bookSource: 'AI产品经理入门推荐书单 · 10本',
    categoryL1: 'AI产品经理入门推荐书单 · 10本',
    categoryL2: '书目信息与阅读建议',
    group: 'AI产品经理入门推荐书单 · 10本',
    section: '书目信息与阅读建议',
    content: `零基础转行 AI 产品经理的系统性学习书单，10 本不同类型高评分作品，从 AI 科普到产品实战。\n\n` +
      `【分阶段阅读顺序】\n${stageText}\n\n【书目一览】\n${order}\n\n` +
      `【阅读原则】不求每本都精读，先快速通读建立框架，遇到和当前学习相关的章节再深入。`,
    explain: `零基础转行 AI 产品经理的系统性学习书单，10 本不同类型高评分作品，从 AI 科普到产品实战。\n\n【分阶段阅读顺序】\n${stageText}\n\n【书目一览】\n${order}`,
    level: '了解', mark: '⚪', levelN: '了解即可',
    related: BOOKS.map(b => b.title),
    sources: ['AI产品经理入门推荐书单_10本.docx'],
    keys: ['10 本分四阶段阅读', 'AI认知 → 产品方法论 → UX设计 → 商业与专项', '先通读建框架，再按需精读'],
    faqs: [
      { q: '这 10 本要按顺序全读完吗？', a: '不用。先按四阶段顺序各挑一本通读建立框架，遇到和你当前项目相关的章节再精读。书单的价值是给你一张地图，不是任务清单。' },
      { q: '零基础应该从哪本开始？', a: '从《AI 3.0》和《大模型浪潮》开始，先搞懂 AI 能做什么、不能做什么；再读《人人都是产品经理》和《启示录》补产品方法论。' },
    ],
    text: '',
  });
  report.newBooks.added.push({ title: 'AI产品经理入门推荐书单 · 10本（总览）', entries: 1 });
}

function makeBookDoc(b, section, opt) {
  const title = section === CATALOG_L2_MAX ? `${b.title} · 书目信息` : `${b.title} · ${section}`;
  return {
    id: '',
    kind: 'book',
    title,
    name: title,
    book: b.title,
    bookSource: b.title,
    categoryL1: b.title,
    categoryL2: section,
    group: b.title,
    section,
    en: b.en || '',
    content: opt.content,
    explain: opt.content,
    level: '了解',
    mark: '⚪',
    levelN: '了解即可',
    related: [],
    sources: [b.title],
    keys: section === CATALOG_L2_MAX
      ? [b.type, b.rating, `${b.author}`, b.stage]
      : [section.replace(/^第[一二三四五六七八九十\d]+[章部分]\s*/, '').slice(0, 40)],
    faqs: [],
    scenario: section === CATALOG_L2_MAX
      ? `当你需要判断"这本书现在该不该读"时参考：${b.why}`
      : `读到本章时留意：${(b.points[b.outline.indexOf(section)] || '').slice(0, 60)}`,
    text: '',
  };
}

// ---------------------------------------------------------------------------
// 2. 合并知识点（先去重再新增）
// ---------------------------------------------------------------------------
const allDocs = () => [...docs];

for (const c of CONCEPTS) {
  const key = normName(c.name);

  // 第 1 层：精确名 / 规范化名相同
  if (byName.has(key)) {
    const hit = byName.get(key);
    mergeInto(hit, c, 'name-exact');
    report.newConcepts.mergedIntoExisting.push({ name: c.name, into: hit.title, reason: '名称相同' });
    continue;
  }

  // 第 2 层：包含关系（"MVP" vs "MVP最小可行产品"）
  let hit = null, why = '';
  for (const d of allDocs()) {
    if (d.kind !== 'concept') continue;
    const dn = normName(d.name || d.title);
    if (!dn || dn.length < 3) continue;
    if (dn.includes(key) || key.includes(dn)) { hit = d; why = '名称包含关系'; break; }
  }
  if (hit) {
    mergeInto(hit, c, 'name-contains');
    report.newConcepts.mergedIntoExisting.push({ name: c.name, into: hit.title, reason: why });
    continue;
  }

  // 第 3 层：关键词重合度（高阈值才算同一概念，避免误并）
  let best = null, bestSim = 0;
  const cSet = tokenSet(c.name + c.content);
  for (const d of allDocs()) {
    if (d.kind !== 'concept') continue;
    const sim = jaccard(cSet, tokenSet((d.name || d.title) + (d.content || '')));
    if (sim > bestSim) { bestSim = sim; best = d; }
  }
  if (best && bestSim >= 0.55) {
    mergeInto(best, c, 'keyword-overlap');
    report.newConcepts.mergedIntoExisting.push({
      name: c.name, into: best.title, reason: `关键词重合 ${bestSim.toFixed(2)}`,
    });
    continue;
  }
  // 0.3~0.55 之间：疑似重复，只记录不并
  if (best && bestSim >= 0.3) {
    report.newConcepts.suspected.push({
      name: c.name, similarTo: best.title, similarity: +bestSim.toFixed(2),
      note: '已作为新条目加入，但可能与本条重复，建议人工确认是否合并',
    });
  }

  // 新增知识点
  docs.push({
    id: '',
    kind: 'concept',
    title: c.name,
    name: c.name,
    en: c.en || '',
    categoryL1: '产品与设计方法论',   // 新开一级分类，避免塞进现有分类造成语义混乱
    categoryL2: c.categoryL2,
    group: '产品与设计方法论',
    section: c.categoryL2,
    content: c.content,
    explain: c.content,
    keys: c.keys || [],
    keypoints: c.keys || [],
    scenario: c.scenario || '',
    faqs: c.faqs || [],
    level: c.level || '理解',
    levelN: c.level || '理解',
    mark: c.mark || '🟡',
    related: [],
    relatedNames: [],
    sources: [c.sourceBook],
    sourceBook: c.sourceBook,
    contentOrigin: '书籍内容整理 + 大模型拓展',
    book: c.sourceBook,
    enriched: true,
    enrichedAt: new Date().toISOString(),
    text: '',
  });
  byName.set(key, docs[docs.length - 1]);
  report.newConcepts.added.push({ name: c.name, category: c.categoryL2, source: c.sourceBook });
}

// 把新内容合进已有条目（不覆盖原有内容，只补缺失字段）
function mergeInto(target, c, how) {
  target.keys = target.keys || [];
  target.keypoints = target.keypoints || [];
  target.faqs = target.faqs || [];

  // 补充要点（去重后追加，上限 8 条，避免条目过度膨胀）
  for (const k of (c.keys || [])) {
    if (target.keys.length >= 8) break;
    if (!target.keys.some(x => jaccard(tokenSet(x), tokenSet(k)) > 0.7)) target.keys.push(k);
  }
  target.keypoints = target.keys;

  // 补充常见问题（上限 4 条）
  for (const f of (c.faqs || [])) {
    if (target.faqs.length >= 4) break;
    if (!target.faqs.some(x => x.q === f.q)) target.faqs.push(f);
  }

  // 来源合并
  target.sources = [...new Set([...(target.sources || []), c.sourceBook].filter(Boolean))];
  // 应用场景：原有为空才补
  if (!target.scenario && c.scenario) target.scenario = c.scenario;
  // 关联概念：把新概念名加进去（若列表里还没有）
  target.related = target.related || [];
  if (!target.related.includes(c.name) && normName(target.title) !== normName(c.name)) {
    if (target.related.length < 6) target.related.push(c.name);
  }
  target.mergedFrom = [...new Set([...(target.mergedFrom || []), how])];
  target.mergedAt = new Date().toISOString();
}

// ---------------------------------------------------------------------------
// 3. 重排 id、补关联 id、重建目录与统计
// ---------------------------------------------------------------------------
// 顺序：先概念（按分类），再智能体，最后书目——保持知识树阅读顺序稳定
const order = { concept: 0, agent: 1, book: 2 };
docs.sort((a, b) => {
  const ka = order[a.kind] ?? 9, kb2 = order[b.kind] ?? 9;
  if (ka !== kb2) return ka - kb2;
  const c = String(a.categoryL1).localeCompare(String(b.categoryL1), 'zh');
  if (c !== 0) return c;
  const s = String(a.categoryL2).localeCompare(String(b.categoryL2), 'zh');
  if (s !== 0) return s;
  return String(a.title).localeCompare(String(b.title), 'zh');
});
docs.forEach((d, i) => { d.id = 'd' + (i + 1); });

// 关联概念 → id（用 name 和 title 双索引）
const nameToId = new Map();
for (const d of docs) {
  for (const k of [d.name, d.title]) if (k && !nameToId.has(k)) nameToId.set(k, d.id);
}
let relTotal = 0, relCount = 0;
for (const d of docs) {
  const names = (d.relatedNames && d.relatedNames.length) ? d.relatedNames : (d.related || []);
  d.relatedNames = names;
  d.relatedIds = names.map(n => nameToId.get(n)).filter(id => id && id !== d.id);
  if (d.relatedIds.length) { relCount++; relTotal += d.relatedIds.length; }
  // 检索文本：把新字段也纳入，保证新内容能被搜到
  d.text = [d.title, d.en, d.categoryL1, d.categoryL2, d.level, d.content,
    (d.keys || []).join(' '), d.scenario || '', (d.faqs || []).map(f => f.q + ' ' + f.a).join(' '),
    (d.relatedNames || []).join(' ')].filter(Boolean).join(' ');
  // 面包屑
  const last = d.name || d.title;
  const crumb = [d.categoryL1, d.categoryL2].filter(Boolean);
  if (!crumb.length) crumb.push(last);
  else if (crumb[crumb.length - 1] !== last) crumb.push(last);
  d.breadcrumb = crumb;
  // 兜底字段
  d.explain = d.explain || d.content || '';
  d.keypoints = d.keypoints || d.keys || [];
  d.levelN = d.levelN || d.level || (d.mark === '🔴' ? '必须掌握' : d.mark === '🟡' ? '需要理解' : '了解即可');
  d.sources = (d.sources && d.sources.length) ? d.sources : (d.sourceBook ? [d.sourceBook] : []);
  if (!Array.isArray(d.enrich)) d.enrich = [];
}

// 目录树
const byL1 = {};
for (const d of docs) (byL1[d.categoryL1] = byL1[d.categoryL1] || []).push(d);
const catalog = [];
for (const [l1, list] of Object.entries(byL1)) {
  const byL2 = {};
  for (const d of list) {
    const k = d.categoryL2 || '总览';
    (byL2[k] = byL2[k] || []).push(d);
  }
  catalog.push({
    category: l1, group: l1, count: list.length,
    children: Object.entries(byL2).map(([l2, ds]) => ({
      category: l2, count: ds.length,
      items: ds.map(d => ({
        id: d.id, name: d.name || d.title, title: d.title,
        mark: d.mark, level: d.levelN || d.level, kind: d.kind,
      })),
    })),
  });
}

kb.catalog = catalog;
kb.generatedAt = new Date().toISOString();
kb.stats = {
  total: docs.length,
  concept: docs.filter(d => d.kind === 'concept').length,
  agent: docs.filter(d => d.kind === 'agent').length,
  book: docs.filter(d => d.kind === 'book').length,
  mustLearn: docs.filter(d => d.mark === '🔴').length,
  needUnderstand: docs.filter(d => d.mark === '🟡').length,
  justKnow: docs.filter(d => d.mark === '⚪').length,
  treeTotal: docs.filter(d => d.kind === 'concept').length,
  categories: catalog.length,
  withRelations: relCount,
  avgRelations: +(relTotal / docs.length).toFixed(2),
  enriched: docs.filter(d => d.enriched).length,
  withFaqs: docs.filter(d => (d.faqs || []).length).length,
};

// 原子写
const tmp = KB_PATH + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(kb), 'utf8');
fs.renameSync(tmp, KB_PATH);

report.after = {
  total: docs.length,
  concept: kb.stats.concept,
  book: kb.stats.book,
  categories: catalog.length,
  mustLearn: kb.stats.mustLearn,
};

// ---------------------------------------------------------------------------
// 4. 重建关键词倒排索引（索引必须跟着内容一起重建，否则搜索失准）
// ---------------------------------------------------------------------------
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
      let j = i;
      while (j < s.length && /[a-z0-9+#.]/.test(s[j])) j++;
      out.add(s.slice(i, j));
      i = j - 1;
    }
  }
  for (const w of String(text || '').toLowerCase().match(/[a-z][a-z0-9+#.]*/g) || []) out.add(w);
  return [...out];
}

const postings = {}, docMap = {}, docTerms = [];
docs.forEach((d, i) => {
  docMap[i] = d.id;
  const ts = termsOf(d.text || (d.title + ' ' + d.content));
  docTerms.push(ts);
  for (const t of ts) (postings[t] = postings[t] || []).push(i);
});
fs.writeFileSync(IDX_PATH, JSON.stringify({
  generatedAt: new Date().toISOString(),
  docCount: docs.length,
  termCount: Object.keys(postings).length,
  docMap, postings, docTerms,
}), 'utf8');

fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');

// ---------------------------------------------------------------------------
// 5. 打印结果
// ---------------------------------------------------------------------------
console.log('='.repeat(70));
console.log('  合并新增 10 本书');
console.log('='.repeat(70));
console.log(`\n【书目】新增 ${report.newBooks.added.length} 本，跳过 ${report.newBooks.skipped.length} 本`);
report.newBooks.added.forEach(b => console.log(`   + 《${b.title}》(${b.entries} 条)`));
report.newBooks.skipped.forEach(b => console.log(`   = 跳过《${b.title}》：${b.reason}`));

console.log(`\n【知识点】新增 ${report.newConcepts.added.length} 个`);
report.newConcepts.added.forEach(c => console.log(`   + ${c.name}  [${c.category}]  ← ${c.source}`));

console.log(`\n【去重】合并进已有条目 ${report.newConcepts.mergedIntoExisting.length} 个`);
report.newConcepts.mergedIntoExisting.forEach(c => console.log(`   ~ ${c.name} → 并入「${c.into}」（${c.reason}）`));

if (report.newConcepts.suspected.length) {
  console.log(`\n【疑似重复】${report.newConcepts.suspected.length} 个（已新增，但建议人工确认）`);
  report.newConcepts.suspected.forEach(c => console.log(`   ? ${c.name} ≈ 「${c.similarTo}」重合 ${c.similarity}`));
}

console.log(`\n【知识库变化】`);
console.log(`   条目：     ${report.before.total} → ${report.after.total}`);
console.log(`   知识点：   ${report.before.concept} → ${report.after.concept}`);
console.log(`   书目：     ${report.before.book} → ${report.after.book}`);
console.log(`   一级分类： ${report.before.categories} → ${report.after.categories}`);
console.log(`   🔴必学：   ${report.after.mustLearn}`);
console.log(`   关联网络： ${kb.stats.withRelations}/${kb.stats.total} 条，平均 ${kb.stats.avgRelations} 个`);
console.log(`   索引词条： ${Object.keys(postings).length}`);
console.log(`\n⚠️ 内容已变，必须重建向量：node build_embeddings.js`);
console.log(`   合并报告：data/merge_report.json`);
console.log('');
