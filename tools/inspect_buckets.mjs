/* =============================================================================
 * inspect_buckets.mjs —— 只读盘点 data/ 里的用户桶（不修改任何数据）
 * -----------------------------------------------------------------------------
 * 多用户隔离是按 Cookie 里的 aipm_uid 分桶存的。验证脚本每次跑都会新建访客，
 * 于是 data/ 里会攒下一批「孤儿桶」。这个脚本只统计，不清理 ——
 * 清理用 tools/drop_test_bucket.mjs（要显式指定 uid，避免误删真实学习数据）。
 *
 * 用法：node tools/inspect_buckets.mjs
 * ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');

const uidOf = key => key; // 桶 key 就是 uid（或 'anonymous'）
const rows = new Map();   // uid → { files:Set, entries:n }

for (const f of fs.readdirSync(DATA)) {
  if (!f.endsWith('.json') || f.endsWith('.bak')) continue;
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch (e) { continue; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) continue;

  // 只有「顶层 value 是对象、且 key 看起来像 uid」的文件才是分桶存储
  const keys = Object.keys(j);
  const looksBucketed = keys.length > 0 && keys.every(k => /^(anonymous|u_[A-Za-z0-9_-]+|[A-Za-z0-9_-]{6,40})$/.test(k))
    && keys.some(k => typeof j[k] === 'object' && j[k] !== null);
  if (!looksBucketed) continue;

  for (const k of keys) {
    if (!rows.has(k)) rows.set(k, { files: new Set(), entries: 0 });
    const r = rows.get(k);
    r.files.add(f);
    const v = j[k];
    if (Array.isArray(v)) r.entries += v.length;
    else if (v && typeof v === 'object') r.entries += Object.keys(v).length;
  }
}

const list = [...rows.entries()].sort((a, b) => b[1].entries - a[1].entries);
console.log('data/ 里的用户桶（按数据量排序）：\n');
console.log('  ' + 'UID'.padEnd(26) + '条目数'.padEnd(8) + '涉及文件');
console.log('  ' + '-'.repeat(70));
for (const [uid, r] of list) {
  const flag = /^(anonymous|e2e_verify_bucket|u_)/.test(uid) ? '' : '  ← 非标准命名';
  console.log('  ' + uid.padEnd(26) + String(r.entries).padEnd(8) + [...r.files].join(', ').slice(0, 60) + flag);
}
console.log('\n共 ' + list.length + ' 个桶。e2e_verify_bucket 是端到端验证脚本专用的桶，');
console.log('清掉它用： node tools/drop_test_bucket.mjs e2e_verify_bucket');
