#!/usr/bin/env node
/**
 * make_clean_data.js —— 生成可分发的干净 data 副本
 * =====================================================================
 * 为什么不直接打包 data/：
 *   目录里混着你的真实学习记录（笔记、已学、错题、新知识、AI补全），
 *   以及一堆过程备份（.bak-*、backup-*、data-new/）。
 *   直接给别人会带出隐私数据，而且体积大、有陈旧文件误导。
 *
 * 产出 data-clean/：
 *   应用资产（必须带）：
 *     kb.json          知识库 240 条
 *     index.json       关键词倒排索引
 *     embeddings.json  语义向量 240×768
 *   空的学习数据（结构正确、内容为空，开箱即用）：
 *     notes / learned / enrich / quiz / wrong / newknowledge / settings
 *
 * 命令：node tools/make_clean_data.js
 * =====================================================================
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'data');
const OUT = path.join(ROOT, 'data-clean');

// 必须一起带走的应用资产
const ASSETS = ['kb.json', 'index.json', 'embeddings.json'];

// 用户数据文件 → 清空后的初始值
const USER_FILES = {
  'notes.json': {},
  'learned.json': {},
  'enrich.json': {},
  'quiz.json': {},
  'wrong.json': [],
  'newknowledge.json': [],
  'settings.json': {
    searchProvider: 'bocha',
    searchKey: '',
    useWebDefault: false,
    webMode: 'auto',
    autoEnrich: true,
    autoEnrichMinChars: 15,
  },
};

// 1. 重建目录
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// 2. 拷贝应用资产
console.log('=== 拷贝应用资产 ===');
for (const f of ASSETS) {
  const s = path.join(SRC, f);
  if (!fs.existsSync(s)) { console.log(`  ❌ 缺失 ${f}`); process.exit(1); }
  fs.copyFileSync(s, path.join(OUT, f));
  const kb = f === 'kb.json';
  console.log(`  ✅ ${f.padEnd(18)} ${(fs.statSync(s).size / 1024).toFixed(1)} KB`);
}

// 3. 生成空的用户数据文件
console.log('\n=== 生成空的学习数据文件（开箱即用）===');
for (const [f, v] of Object.entries(USER_FILES)) {
  fs.writeFileSync(path.join(OUT, f), JSON.stringify(v, null, 1), 'utf8');
  console.log(`  ✅ ${f.padEnd(18)} 空`);
}

// 4. 自检：确认干净副本能用，且不含个人数据
console.log('\n=== 自检 ===');
const kb = JSON.parse(fs.readFileSync(path.join(OUT, 'kb.json'), 'utf8'));
const idx = JSON.parse(fs.readFileSync(path.join(OUT, 'index.json'), 'utf8'));
const emb = JSON.parse(fs.readFileSync(path.join(OUT, 'embeddings.json'), 'utf8'));

const checks = [
  ['kb.json 条目数 240', kb.docs.length === 240, `${kb.docs.length}`],
  ['index.json 与 kb 对齐', idx.docCount === kb.docs.length, `${idx.docCount}`],
  ['embeddings 条数对齐', emb.ids.length === kb.docs.length, `${emb.ids.length}`],
  ['embeddings ID 顺序一致',
    emb.ids.every((v, i) => v === kb.docs[i].id), ''],
  ['向量维度 768', emb.dim === 768, `${emb.dim}`],
  ['知识点 144', kb.stats.concept === 144, `${kb.stats.concept}`],
  ['书目 88', kb.stats.book === 88, `${kb.stats.book}`],
  ['一级分类 10', kb.stats.categories === 10, `${kb.stats.categories}`],
  ['笔记文件为空', Object.keys(JSON.parse(fs.readFileSync(path.join(OUT, 'notes.json'), 'utf8'))).length === 0],
  ['已学文件为空', Object.keys(JSON.parse(fs.readFileSync(path.join(OUT, 'learned.json'), 'utf8'))).length === 0],
  ['错题文件为空数组', Array.isArray(JSON.parse(fs.readFileSync(path.join(OUT, 'wrong.json'), 'utf8')))],
  ['新知识文件为空数组', Array.isArray(JSON.parse(fs.readFileSync(path.join(OUT, 'newknowledge.json'), 'utf8')))],
  ['无备份残留文件', !fs.readdirSync(OUT).some(f => /\.bak|backup|data-new|\.log$/.test(f))],
];
let bad = 0;
for (const [n, ok, extra] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`);
  if (!ok) bad++;
}

// 5. 个人数据泄漏扫描：搜索应用资产里是否混入用户内容
console.log('\n=== 个人数据泄漏扫描 ===');
const assetText = ASSETS.map(f => fs.readFileSync(path.join(OUT, f), 'utf8')).join('');
const leaks = [];
// 你的真实学习痕迹关键词（来自备份里的实际内容特征）
const patterns = [
  [/自测笔记/, '测试用笔记'],
  [/标记AAA|标记BBB/, '隔离测试数据'],
  [/私有笔记/, '隔离测试数据'],
  [/A的新知识XYZ/, '隔离测试数据'],
];
for (const [re, label] of patterns) if (re.test(assetText)) leaks.push(label);
console.log(leaks.length ? `  ⚠️ 发现：${leaks.join('、')}` : '  ✅ 应用资产中未发现个人学习数据');

// 6. 汇总
const files = fs.readdirSync(OUT).sort();
let total = 0;
console.log('\n=== data-clean 内容 ===');
for (const f of files) {
  const sz = fs.statSync(path.join(OUT, f)).size;
  total += sz;
  console.log(`  ${f.padEnd(20)} ${(sz / 1024).toFixed(1).padStart(8)} KB`);
}
console.log(`  ${'合计'.padEnd(20)} ${(total / 1024 / 1024).toFixed(2).padStart(8)} MB`);
console.log(`\n  目录：${OUT}`);
console.log(`  用法：把它整个覆盖到 mvp/data/ 即可，无需其他改动。`);
console.log(bad ? `\n❌ ${bad} 项未通过` : '\n✅ 干净副本可用');
process.exit(bad ? 1 : 0);
