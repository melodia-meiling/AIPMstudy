/* =============================================================================
 * drop_test_bucket.mjs —— 清理验证脚本产生的测试用户桶
 * -----------------------------------------------------------------------------
 * 背景：多用户隔离是按 Cookie 里的 aipm_uid 分桶存的，验证脚本每跑一次就新建
 * 一两个访客，于是 data/ 里会攒下一批「孤儿桶」。真实学习数据也在这套文件里，
 * 所以清理必须**有证据**，不能靠猜。
 *
 * 三条安全设计：
 *   1. 默认只读：不加 --apply 绝不写文件
 *   2. 先备份：写之前把要动的文件整份复制到 data/backup-buckets-<时间戳>/
 *   3. 证据优先：--empty 只删「一个字段都没有」的桶（不可能含用户数据）；
 *      --drop 必须显式点名 uid，且报告里会打印该桶的内容摘要供人核对
 *
 * 用法：
 *   node tools/drop_test_bucket.mjs                     # 只报告（推荐先跑这个）
 *   node tools/drop_test_bucket.mjs --empty --apply      # 删掉全空的桶
 *   node tools/drop_test_bucket.mjs --drop e2e_verify_bucket --apply
 *
 * 注意：清理前请先停掉 server.js，避免它内存里的旧数据又写回来。
 * ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const DROP_EMPTY = argv.includes('--empty');
const dropIdx = argv.indexOf('--drop');
const DROP_LIST = dropIdx >= 0 && argv[dropIdx + 1]
  ? argv[dropIdx + 1].split(',').map(s => s.trim()).filter(Boolean)
  : [];

// 不参与分桶统计的文件：
//   · 知识库本体 / 索引 / 向量 / 报告（不是用户数据）
//   · settings.json 是**全局**设置（顶层就是 searchProvider / webMode / searchKey
//     这些字段名，不是 uid），它的 key 长得很像 uid，不排除掉会被误判成 6 个桶
const SKIP = new Set(['kb.json', 'index.json', 'embeddings.json', 'merge_report.json', 'settings.json']);

// 桶结构里的固定字段（不是用户 id），比如 activity.json 里可能出现的索引字段
const STRUCTURAL = new Set();

const FILES = fs.readdirSync(DATA)
  .filter(f => f.endsWith('.json') && !f.includes('.bak') && !SKIP.has(f));

const uidLike = k => /^(anonymous|u_[A-Za-z0-9_-]+|[A-Za-z0-9_-]{6,40})$/.test(k);

// 'owner' 是历史遗留的「根」标记（早期未分桶时的数据位置）。
// 它一定要留在文件里：服务端读文件时用它判断结构，删掉会让存储层认不出格式。
const PROTECTED = new Set(['owner']);

function readBuckets(file) {
  const p = path.join(DATA, file);
  let j;
  try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const keys = Object.keys(j);
  if (!keys.length) return null;                 // 空文件，没有桶
  // 只认「顶层 key 都是 uid（或受保护的 owner / 桶结构字段）」的文件
  if (!keys.every(k => uidLike(k) || PROTECTED.has(k) || STRUCTURAL.has(k))) return null;
  return j;
}

/** 一个桶里有没有内容（空对象 / 空数组都算空） */
function sizeOf(v) {
  if (v == null) return 0;
  if (Array.isArray(v)) return v.length;
  if (typeof v === 'object') return Object.keys(v).length;
  return v === '' ? 0 : 1;
}

const stores = new Map();   // file → parsed json
const buckets = new Map();  // uid → { total, perFile:{file:n} }
const protectedHits = new Map(); // key → Set(file)，受保护但存在的键

for (const f of FILES) {
  const j = readBuckets(f);
  if (!j) continue;
  stores.set(f, j);
  for (const [uid, v] of Object.entries(j)) {
    if (PROTECTED.has(uid) || STRUCTURAL.has(uid)) {
      if (!protectedHits.has(uid)) protectedHits.set(uid, new Set());
      protectedHits.get(uid).add(f);
      continue;
    }
    if (!buckets.has(uid)) buckets.set(uid, { total: 0, perFile: {} });
    const b = buckets.get(uid);
    const n = sizeOf(v);
    b.total += n;
    b.perFile[f] = n;
  }
}

/* ------------------------------- 报告 ------------------------------- */

console.log('data/ 分桶盘点（' + stores.size + ' 个存储文件，' + buckets.size + ' 个用户桶）\n');
if (protectedHits.size) {
  console.log('受保护的键（永远不会被删除）：' +
    [...protectedHits].map(([k, fs2]) => k + '（出现在 ' + [...fs2].join('/') + '）').join('、') + '\n');
}

const nonEmpty = [...buckets.entries()].filter(([, b]) => b.total > 0)
  .sort((a, b) => b[1].total - a[1].total);
const empties = [...buckets.entries()].filter(([, b]) => b.total === 0);

console.log('有内容的桶（需要人工核对是不是真实学习数据）：');
for (const [uid, b] of nonEmpty) {
  const parts = Object.entries(b.perFile).filter(([, n]) => n > 0).map(([f, n]) => f.replace('.json', '') + ':' + n);
  console.log('\n  ● ' + uid + '  合计 ' + b.total + ' 条');
  console.log('    字段分布: ' + parts.join('  '));
  // 打证据：笔记/作品/目标 里挑一条出来给人看
  const notes = stores.get('notes.json') || {};
  const nb = notes[uid];
  if (nb && typeof nb === 'object') {
    const first = Object.entries(nb)[0];
    if (first) console.log('    笔记样例: 「' + String(first[1] && first[1].text || '').slice(0, 40) + '」');
  }
  const pf = (stores.get('portfolio.json') || {})[uid];
  if (Array.isArray(pf) && pf.length) console.log('    作品样例: 「' + String(pf[0].title || '').slice(0, 40) + '」');
  const gl = (stores.get('goals.json') || {})[uid];
  if (gl && gl.text) console.log('    目标: 「' + String(gl.text).slice(0, 40) + '」');
  else if (gl) console.log('    目标: 只有事件数设置（text 为空）');
  const lr = (stores.get('learned.json') || {})[uid];
  if (lr && typeof lr === 'object') console.log('    已学知识点: ' + Object.keys(lr).join(', '));
  const qz = (stores.get('quiz.json') || {})[uid];
  if (qz && typeof qz === 'object') {
    console.log('    出过题的知识点: ' + Object.keys(qz).map(k => k + '(' + (qz[k] || []).length + '题)').join(', '));
  }
}

console.log('\n全空的桶（' + empties.length + ' 个，删掉不会丢任何数据）：');
console.log('  ' + empties.map(([uid]) => uid).join(', ') || '（无）');

/* ------------------------------- 执行 ------------------------------- */

const targets = new Set();
if (DROP_EMPTY) empties.forEach(([uid]) => targets.add(uid));
DROP_LIST.forEach(uid => {
  if (!buckets.has(uid)) { console.log('\n! 找不到桶 ' + uid + '，已忽略'); return; }
  targets.add(uid);
});

console.log('\n' + (APPLY ? '将要删除' : '【只读模式】如果加 --apply 将删除') + ' ' + targets.size + ' 个桶：');
console.log('  ' + ([...targets].join(', ') || '（无）'));

if (!targets.size) {
  console.log('\n没有需要清理的桶。');
  process.exit(0);
}
if (!APPLY) {
  console.log('\n（当前是只读模式，没有修改任何文件。确认无误后加 --apply）');
  process.exit(0);
}

// 备份
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backupDir = path.join(DATA, 'backup-buckets-' + stamp);
fs.mkdirSync(backupDir, { recursive: true });

let touched = 0;
for (const [f, j] of stores) {
  let changed = false;
  for (const uid of targets) if (uid in j) { delete j[uid]; changed = true; }
  if (!changed) continue;
  fs.copyFileSync(path.join(DATA, f), path.join(backupDir, f));
  fs.writeFileSync(path.join(DATA, f), JSON.stringify(j));
  touched++;
  console.log('  已清理 ' + f + '（原文件已备份）');
}

console.log('\n完成：处理了 ' + touched + ' 个文件，备份在 data/backup-buckets-' + stamp + '/');
console.log('如果有问题，把备份目录里的文件复制回 data/ 即可还原。');
