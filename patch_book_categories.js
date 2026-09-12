#!/usr/bin/env node
/**
 * patch_book_categories.js —— 修正书目条目的分类层级
 * =====================================================================
 * 问题：工具流程产出的 kb.json 里，20 条书目片段的 categoryL1 统一是「核心书目」，
 *       二级分类才是章节名。结果「核心书目」下塞了 13 本书的章节，无法按书浏览。
 *
 * 期望结构（需求要求「修正层级错乱、分类错误」）：
 *       一级分类 = 书名
 *       二级分类 = 章节目录（或「书目信息与阅读建议」）
 *
 * 做法：把 categoryL1/group 改为书名，并重算 breadcrumb。
 *       知识树的概念类条目不动（那 7 大主干分类是正确的）。
 *
 * 关系说明：本补丁只针对当前 kb.json 做一次性修正。
 *   tools/regen_knowledge.js 会重建 kb.json，重建后需再跑一次本脚本。
 *   命令：node patch_book_categories.js
 * =====================================================================
 */
'use strict';
const fs = require('fs');
const path = require('path');

const KB_PATH = path.join(__dirname, 'data', 'kb.json');
const kb = JSON.parse(fs.readFileSync(KB_PATH, 'utf8'));

let fixed = 0;
const bookTitles = new Set();

for (const d of kb.docs) {
  if (d.kind !== 'book') continue;
  // 书名来自 bookSource / book（形如「秒懂智能体：AI Agent重新定义未来工作 · 第1章 …」的前半段）
  let bookTitle = d.book || d.bookSource || '';
  if (!bookTitle && d.title) bookTitle = String(d.title).split(' · ')[0];
  bookTitle = String(bookTitle).trim();
  if (!bookTitle) continue;

  const needFix = (d.categoryL1 !== bookTitle) || (d.group !== bookTitle);
  if (needFix) {
    d.categoryL1 = bookTitle;
    d.group = bookTitle;
    fixed++;
  }
  // 二级分类保留章节名
  if (!d.categoryL2) d.categoryL2 = d.section || '书目信息与阅读建议';
  bookTitles.add(bookTitle);

  // 重算面包屑：书名 › 章节 › 标题
  const last = d.name || d.title || '';
  const crumb = [d.categoryL1, d.categoryL2].filter(Boolean);
  if (!crumb.length) crumb.push(last);
  else if (crumb[crumb.length - 1] !== last) crumb.push(last);
  d.breadcrumb = crumb;
}

// 同步更新 catalog（server.js 的 /api/catalog 直接返回它）
const byL1 = {};
for (const d of kb.docs) (byL1[d.categoryL1 || '未分类'] = byL1[d.categoryL1 || '未分类'] || []).push(d);
const catalog = [];
for (const [l1, list] of Object.entries(byL1)) {
  const byL2 = {};
  for (const d of list) {
    const k = d.categoryL2 || '总览';
    (byL2[k] = byL2[k] || []).push(d);
  }
  catalog.push({
    category: l1,
    group: l1,
    count: list.length,
    children: Object.entries(byL2).map(([l2, ds]) => ({
      category: l2,
      count: ds.length,
      items: ds.map(d => ({ id: d.id, name: d.name || d.title, title: d.title, mark: d.mark, level: d.levelN || d.level, kind: d.kind })),
    })),
  });
}
kb.catalog = catalog;
kb.stats = kb.stats || {};
kb.stats.categories = catalog.length;

// 原子写
const tmp = KB_PATH + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(kb), 'utf8');
fs.renameSync(tmp, KB_PATH);

console.log(`✅ 书目分类已修正：${fixed} 条`);
console.log(`   涉及书目 ${bookTitles.size} 本：`);
for (const t of bookTitles) console.log('     - ' + t);
console.log(`   一级分类总数：${catalog.length}（7 个知识树主干 + ${catalog.length - 7} 本书）`);
