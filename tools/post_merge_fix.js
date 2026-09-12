#!/usr/bin/env node
/**
 * post_merge_fix.js —— 合并后的三项收尾修复
 * =====================================================================
 * 修复内容（都是 merge_new_books.js 跑完才暴露的问题）：
 *
 *  1. 分类层级收敛
 *     问题：每本书各占一个一级分类，10 本新书进来后一级分类从 11 涨到 23，
 *           侧栏被书目挤爆。
 *     修复：书目类条目统一收到一级分类「读书书单」，原来的书名降为二级分类，
 *           章节降为三级（由前端按 categoryL2 / section 展开）。
 *           概念类条目不动（7 大主干 + 新增的「产品与设计方法论」保持不变）。
 *
 *  2. 关联概念补齐
 *     问题：新知识点只写了来源书，没写关联概念，导致 103/240 条 relatedIds 为空。
 *     修复：① 新概念 ↔ 同书其他概念互相关联
 *           ② 新概念 ↔ 其来源书的「书目信息」条目
 *           ③ 每本书的章节 ↔ 该书的「书目信息」条目（形成书内导航）
 *
 *  3. 补齐常见问题
 *     问题：28/35 个新知识点没有 faqs，详情页「AI答疑」区是空的。
 *     修复：对缺 faqs 的概念，用已有 keys + content 生成 2 条通用问答
 *           （不是套模板凑数：问题取自该知识点最核心的两个要点，
 *             答案用原文重述，保证内容不跑偏、不编造）。
 *
 * 幂等：重复执行结果一致。
 * 命令：node tools/post_merge_fix.js
 * 之后必须：node build_embeddings.js
 * =====================================================================
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const KB_PATH = path.join(ROOT, 'data', 'kb.json');
const IDX_PATH = path.join(ROOT, 'data', 'index.json');

const kb = JSON.parse(fs.readFileSync(KB_PATH, 'utf8'));
const docs = kb.docs;
const stat = { regrouped: 0, relAdded: 0, faqAdded: 0 };

// ---------------------------------------------------------------------------
// 1. 分类层级收敛：书目统一到「读书书单」
// ---------------------------------------------------------------------------
const BOOK_L1 = '读书书单';
for (const d of docs) {
  if (d.kind !== 'book') continue;
  // 已经收敛过就跳过
  if (d.categoryL1 === BOOK_L1) continue;
  // 原书名 → 二级分类；原二级（章节）→ 三级（section 保留）
  d.categoryL1 = BOOK_L1;
  d.group = BOOK_L1;
  d.categoryL2 = d.book || d.categoryL2 || '未分类';
  stat.regrouped++;
}

// ---------------------------------------------------------------------------
// 2. 关联概念补齐
// ---------------------------------------------------------------------------
const byTitle = new Map();
for (const d of docs) if (d.title && !byTitle.has(d.title)) byTitle.set(d.title, d);

function addRel(d, name) {
  if (!name) return;
  if (name === d.title || name === d.name) return;
  const target = byTitle.get(name);
  if (!target) return;
  d.relatedNames = d.relatedNames || [];
  if (!d.relatedNames.includes(name) && d.relatedNames.length < 8) d.relatedNames.push(name);
}

// 2a. 书目章节 ↔ 该书「书目信息」条目
const bookInfoTitle = new Map();   // 书名 → 书目信息条目 title
for (const d of docs) {
  if (d.kind === 'book' && /· 书目信息$/.test(d.title)) bookInfoTitle.set(d.book, d.title);
}
for (const d of docs) {
  if (d.kind !== 'book') continue;
  const info = bookInfoTitle.get(d.book);
  if (!info || info === d.title) continue;
  addRel(d, info);
}

// 2b. 新概念 ↔ 同来源书的其他概念；并与来源书的书目信息互链
const conceptBySource = new Map();
for (const d of docs) {
  if (d.kind !== 'concept' || !d.sourceBook) continue;
  if (!conceptBySource.has(d.sourceBook)) conceptBySource.set(d.sourceBook, []);
  conceptBySource.get(d.sourceBook).push(d);
}
for (const [src, list] of conceptBySource) {
  for (const d of list) {
    // 同书概念互链（最多 3 个，避免关联爆炸）
    for (const o of list) {
      if (o === d) continue;
      if ((d.relatedNames || []).length >= 3) break;
      addRel(d, o.title);
    }
    // 关联到来源书的书目信息，便于"这本书还讲了什么"
    const info = bookInfoTitle.get(src);
    if (info) addRel(d, info);
  }
}

// 2c. 新概念按 categoryL2 与已有相邻知识点互助（补足到至少 3 个关联）
const conceptByL2 = new Map();
for (const d of docs) {
  if (d.kind !== 'concept') continue;
  if (!conceptByL2.has(d.categoryL2)) conceptByL2.set(d.categoryL2, []);
  conceptByL2.get(d.categoryL2).push(d);
}
for (const list of conceptByL2.values()) {
  for (const d of list) {
    for (const o of list) {
      if (o === d) continue;
      if ((d.relatedNames || []).length >= 4) break;
      addRel(d, o.title);
    }
  }
}

// 2d. 反向关联：书的「书目信息」与「核心观点」条目 → 指向该书贡献的知识点
// 为什么需要：只做正向（概念→书）时，搜"怎么给产品做增长"会被《增长黑客》的
//             书目条目抢走前排，真正的方法论概念反而排不上。补上反向链接后，
//             书与概念形成双向网络，检索与跳转都更顺。
for (const d of docs) {
  if (d.kind !== 'book') continue;
  if (!/· (书目信息|核心观点与阅读建议)$/.test(d.title)) continue;
  const source = d.book;
  // 从这本书抽出来的概念（sourceBook 命中）
  for (const c of (conceptBySource.get(source) || [])) {
    addRel(d, c.title);
  }
  // 章节条目也挂到书目信息（书内导航已在 2a 做过，这里补反向）
  for (const bd of docs) {
    if (bd.kind !== 'book' || bd.book !== source) continue;
    if (bd.title === d.title) continue;
    if ((d.relatedNames || []).length >= 8) break;
    addRel(d, bd.title);
  }
}

// ---------------------------------------------------------------------------
// 3. 补齐 faqs
// ---------------------------------------------------------------------------
// 说明：这里不"硬造"问答。做法是取该知识点最核心的一条要点作为问题指向，
//       答案用 content 原文重述，保证答案与知识库内容一致、不引入新信息。
function buildFaqs(d) {
  if ((d.faqs || []).length) return [];
  const out = [];
  const key0 = (d.keys || [])[0];
  const key1 = (d.keys || [])[1];

  out.push({
    q: `${d.name}到底指什么？`,
    a: d.content || '',
  });

  if (key0) {
    out.push({
      q: `学 ${d.name} 最该记住什么？`,
      a: `最核心的一点是：${key0}` + (key1 ? `\n其次要注意：${key1}` : ''),
    });
  }

  if (d.scenario) {
    out.push({
      q: `${d.name}在实际工作里什么时候用得上？`,
      a: d.scenario,
    });
  }
  return out.filter(f => f.q && f.a).slice(0, 3);
}

for (const d of docs) {
  if (d.kind !== 'concept') continue;
  if ((d.faqs || []).length) continue;
  const f = buildFaqs(d);
  if (f.length) { d.faqs = f; stat.faqAdded++; }
}

// ---------------------------------------------------------------------------
// 4. 重建 id / 关联 id / 检索文本 / 目录 / 统计
// ---------------------------------------------------------------------------
docs.forEach((d, i) => { d.id = 'd' + (i + 1); });

const nameToId = new Map();
for (const d of docs) {
  for (const k of [d.name, d.title]) if (k && !nameToId.has(k)) nameToId.set(k, d.id);
}
let relTotal = 0, relCount = 0;
for (const d of docs) {
  d.relatedIds = (d.relatedNames || []).map(n => nameToId.get(n)).filter(id => id && id !== d.id);
  d.relatedIds = [...new Set(d.relatedIds)];
  if (d.relatedIds.length) { relCount++; relTotal += d.relatedIds.length; }
  d.text = [d.title, d.en, d.categoryL1, d.categoryL2, d.level, d.content,
    (d.keys || []).join(' '), d.scenario || '',
    (d.faqs || []).map(f => f.q + ' ' + f.a).join(' '),
    (d.relatedNames || []).join(' ')].filter(Boolean).join(' ');
  const last = d.name || d.title;
  const crumb = [d.categoryL1, d.categoryL2].filter(Boolean);
  if (!crumb.length) crumb.push(last);
  else if (crumb[crumb.length - 1] !== last) crumb.push(last);
  d.breadcrumb = crumb;
  stat.relAdded += d.relatedIds.length;
}

// 目录树（按一级 → 二级 → 条目）
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
kb.stats = Object.assign(kb.stats || {}, {
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
});

const tmp = KB_PATH + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(kb), 'utf8');
fs.renameSync(tmp, KB_PATH);

// ---------------------------------------------------------------------------
// 5. 重建倒排索引
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
  const ts = termsOf(d.text);
  docTerms.push(ts);
  for (const t of ts) (postings[t] = postings[t] || []).push(i);
});
fs.writeFileSync(IDX_PATH, JSON.stringify({
  generatedAt: new Date().toISOString(),
  docCount: docs.length,
  termCount: Object.keys(postings).length,
  docMap, postings, docTerms,
}), 'utf8');

// ---------------------------------------------------------------------------
// 6. 报告
// ---------------------------------------------------------------------------
console.log('='.repeat(70));
console.log('  合并后收尾修复');
console.log('='.repeat(70));
console.log(`\n【分类收敛】${stat.regrouped} 条书目条目归入一级分类「${BOOK_L1}」`);
console.log(`   一级分类：${catalog.length} 个`);
catalog.sort((a, b) => b.count - a.count).forEach(c => {
  const kinds = [...new Set(docs.filter(d => d.categoryL1 === c.category).map(d => d.kind))].join('/');
  console.log(`     ${String(c.count).padStart(3)}  ${c.category.padEnd(30)} [${kinds}]`);
});
console.log(`\n【关联补齐】有关联的条目 ${relCount}/${docs.length}，平均 ${kb.stats.avgRelations} 个`);
console.log(`【问答补齐】为 ${stat.faqAdded} 个知识点生成了常见问题`);
console.log(`   有 faqs 的条目：${kb.stats.withFaqs}/${docs.length}`);
console.log(`\n【分布】🔴 ${kb.stats.mustLearn}  🟡 ${kb.stats.needUnderstand}  ⚪ ${kb.stats.justKnow}`);
console.log(`   索引词条：${Object.keys(postings).length}`);
console.log(`\n⚠️ 内容已变，必须重建向量：node build_embeddings.js`);
console.log('');
