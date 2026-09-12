#!/usr/bin/env node
/**
 * repair_scope_data.js —— 修复「作用域泄漏」造成的桶嵌套污染
 * =====================================================================
 * 实际症状（实测确认）：
 *   每个用户桶里都嵌套着自己，逐次请求累积：
 *     u_A → { u_A: {} }                     第一次泄漏
 *     u_B → { u_B: {}, u_C: {} }            再次累积，且混入别的用户
 *     goals 的 u_D → { text, targetTasks, updatedAt, u_D: {} }
 *   结果：写入的数据停在内层，读取时按顶层键找 → 读到空。
 *
 * 修复规则（精确，不误删）：
 *   对每个顶层用户桶 B：
 *     · 桶内凡"用户形态"的键（u_xxx / owner / anonymous）→ 从 B 里移除，
 *       并把该键的内容提升为顶层桶（若顶层已有同键则不覆盖）
 *     · 其余键（text/targetTasks/updatedAt/d1/d21…）→ 原样保留
 *   空桶保留为空桶，代表"这个用户还没有数据"，不删除。
 *
 * 命令：node tools/repair_scope_data.js [--dry]
 * =====================================================================
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const DATA = path.join(__dirname, '..', 'data');
const DRY = process.argv.includes('--dry');
const isUserKey = (k) => /^(u_[A-Za-z0-9]+|owner|anonymous)$/.test(k);

function load(name) {
  const p = path.join(DATA, name + '.json');
  if (!fs.existsSync(p)) return null;
  try { return { p, raw: JSON.parse(fs.readFileSync(p, 'utf8')) }; }
  catch (e) { console.log(`  ${name}.json 解析失败，跳过：${e.message}`); return null; }
}

function repair(name) {
  const L = load(name);
  if (!L) return { changed: false, buckets: 0, polluted: 0 };
  const raw = L.raw;
  if (Array.isArray(raw)) { console.log(`  ${name}.json  （顶层是数组，跳过）`); return { changed: false, buckets: 0, polluted: 0 }; }

  // 嵌套可能不止一层（u_A → u_B → u_C），必须循环拉平到收敛。
  // 上限 10 轮：正常最多 2~3 层，超过说明数据异常，停手让人来看。
  let cur = JSON.parse(JSON.stringify(raw));
  let rounds = 0, rescuedTotal = 0, pollutedSeen = 0;
  const MAX = 10;

  for (; rounds < MAX; rounds++) {
    const out = {};
    let rescued = 0, polluted = 0;
    for (const [k, v] of Object.entries(cur)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const nested = Object.keys(v).filter(isUserKey);
        if (nested.length) {
          polluted++;
          for (const nk of nested) {
            // 内层桶提升到顶层（不覆盖已有的），并从本桶移除
            if (!(nk in out)) out[nk] = v[nk];
            delete v[nk];
            rescued++;
          }
        }
      }
      if (!(k in out)) out[k] = v;
    }
    rescuedTotal += rescued; pollutedSeen += polluted;
    const stillPolluted = Object.values(out).filter(v =>
      v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).some(isUserKey)).length;
    cur = out;
    if (stillPolluted === 0) { rounds++; break; }
  }

  const changed = JSON.stringify(raw) !== JSON.stringify(cur);
  const stillPolluted = Object.values(cur).filter(v =>
    v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).some(isUserKey)).length;

  console.log(`  ${name.padEnd(16)} 桶 ${String(Object.keys(raw).length).padStart(2)} → ${String(Object.keys(cur).length).padStart(2)}` +
    `  污染桶 ${pollutedSeen}  提升 ${rescuedTotal}  收敛轮数 ${rounds}  残留污染 ${stillPolluted}` +
    (changed ? '  ✅ 需修复' : '  （无需修改）'));

  if (changed && !DRY) {
    fs.copyFileSync(L.p, L.p + '.bak-scope-repair');
    const tmp = L.p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cur, null, 1), 'utf8');
    fs.renameSync(tmp, L.p);
  }
  return { changed, buckets: Object.keys(cur).length, polluted: stillPolluted };
}

console.log('=== 修复桶嵌套污染 ===' + (DRY ? '（试运行，不写盘）' : ''));
const files = ['notes', 'learned', 'enrich', 'quiz', 'goals', 'portfolio', 'activity', 'wrong', 'newknowledge'];
let totalFixed = 0, totalPolluted = 0;
for (const n of files) {
  const r = repair(n);
  if (r.changed) totalFixed++;
  totalPolluted += r.polluted;
}
console.log(`\n汇总：需修复文件 ${totalFixed} 个；修后残留污染桶 ${totalPolluted} 个`);
if (totalPolluted) console.log('⚠️ 仍有污染，说明嵌套层级超过一层，需再跑一次本脚本。');
else console.log('✅ 全部拉平完成');
if (!DRY && totalFixed) console.log('原文件已备份为 *.bak-scope-repair');
