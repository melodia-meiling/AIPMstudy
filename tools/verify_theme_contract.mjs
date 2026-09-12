/* =============================================================================
 * verify_theme_contract.mjs —— DOM 契约校验（静态 + 动态全覆盖）
 * -----------------------------------------------------------------------------
 * 这个文件以前叫「主题契约」，校验的是上一代前端（#panel、4 个 Tab 那一版）的
 * id 清单，那次改版的目标 DOM 已经不存在了。现在换成一份更有用的契约：
 *
 *   契约：app.js 里每一个 $('#xxx') 访问到的 id，都必须能在真实的运行过程中
 *         被创建出来 —— 要么本来就写在 index.html 里，要么由某个操作触发的
 *         模板渲染出来。任何一个都不应该是「永远选不到」的死选择器。
 *
 * 为什么这件事值得单独测：
 *   前端改版最常见的静默故障就是「JS 还在点一个已经不存在的按钮」：
 *   不报错、不崩溃，功能就是没反应。静态扫字符串只能查出「两处都没有」，
 *   查不出「写在了某个永远走不到的分支里」。所以这里真的把 app.js 跑起来，
 *   逐个场景点一遍，再回头统计哪些 id 始终没被创建。
 *
 * 命令：node tools/verify_theme_contract.mjs
 * 前置：后端已启动（需要一个真实接口来驱动渲染）
 * ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import vm from 'node:vm';

import { createDOM, makeFetch, makeLocalStorage } from './dom_shim.mjs';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PUB = path.join(ROOT, 'public');
const BASE = process.env.AIPM_BASE || 'http://127.0.0.1:' + (process.env.PORT || 3000);

let pass = 0, fail = 0;
const t = (n, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');

/* ---------- 1. 静态契约：引用关系盘点 ---------- */

console.log('=== 1. 静态契约（引用关系盘点）===');

const htmlIdList = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
const htmlIds = new Set(htmlIdList);
const jsIds = new Set([...js.matchAll(/\$\$?\('#([A-Za-z0-9_-]+)/g)].map(m => m[1]));
const runtimeIds = new Set([...js.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map(m => m[1]));

t('index.html 里没有重复 id', htmlIds.size === htmlIdList.length, htmlIds.size + ' / ' + htmlIdList.length);
t('app.js 引用了 ' + jsIds.size + ' 个 id', jsIds.size > 30);
t('其中 ' + runtimeIds.size + ' 个由 app.js 动态生成', runtimeIds.size > 10);

const nowhere = [...jsIds].filter(id => !htmlIds.has(id) && !runtimeIds.has(id));
t('没有「两处都找不到」的 id', nowhere.length === 0, nowhere.join(', '));

// 静态存在但 JS 没引用的控件 → 只提示，不算失败（可能由父元素代理事件）
const controls = [...html.matchAll(/<(button|input|select|textarea)[^>]*\bid="([^"]+)"/g)].map(m => m[2]);
const orphan = controls.filter(id => !jsIds.has(id));
if (orphan.length) console.log('  [提示] 这些静态控件没被 app.js 直接引用（可能由父元素代理）: ' + orphan.join(', '));

/* ---------- 2. 真实执行 ---------- */

console.log('\n=== 2. 真实执行 app.js 并逐个场景展开 ===');

const document = createDOM(html);
const myFetch = makeFetch(BASE);
myFetch.jar.set('aipm_uid', 'e2e_verify_bucket');

const windowObj = {
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  addEventListener() {},
  location: { origin: BASE, hostname: '127.0.0.1', href: BASE + '/' },
};
Object.assign(globalThis, {
  document: document, window: windowObj,
  localStorage: makeLocalStorage(),
  location: windowObj.location,
  fetch: myFetch,
  alert: () => {}, confirm: () => true, prompt: () => null,
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  requestAnimationFrame: cb => setTimeout(cb, 0),
});

const epilogue = `
;globalThis.__T = { S: S, go: go, openDoc: openDoc, renderSidebar: renderSidebar,
  openPortfolioModal: openPortfolioModal, showNewKnowledgeList: showNewKnowledgeList,
  loadCalendar: loadCalendar, loadPortfolio: loadPortfolio, loadSettings: loadSettings,
  setPracticeTab: setPracticeTab, fillQuizPick: fillQuizPick };
`;

try {
  vm.runInThisContext(js + epilogue, { filename: 'public/app.js' });
  t('app.js 执行无异常', true);
} catch (e) {
  t('app.js 执行无异常', false, e.message);
  console.log(e.stack);
  process.exit(1);
}

const T = globalThis.__T;

// 注意：这里必须记「曾经出现过」，不能记「某一刻缺失」。
// 因为弹窗是互相替换的（#modalBox 的 innerHTML 被覆盖），
// 打开作品集弹窗时目标弹窗的 input 就没了 —— 那不是死选择器。
const everSeen = new Set();

async function scenario(name, fn) {
  try { await fn(); } catch (e) { console.log('  ! 场景「' + name + '」执行异常：' + e.message); }
  await sleep(200);
  const present = [...jsIds].filter(id => document.getElementById(id));
  const fresh = present.filter(id => !everSeen.has(id));
  present.forEach(id => everSeen.add(id));
  console.log('  · ' + name.padEnd(20) + ' 本次可见 ' + present.length + ' 个，累计覆盖 ' +
    everSeen.size + '/' + jsIds.size + (fresh.length ? '（新增 ' + fresh.length + '）' : ''));
}

let firstDoc = null;

await scenario('启动 → 仪表盘', async () => {
  for (let i = 0; i < 120 && !T.S.stats; i++) await sleep(100);
});
await scenario('打开知识点详情', async () => {
  for (const g of T.S.tree) for (const s of g.sections) for (const i of s.items) { if (i.expanded && !firstDoc) firstDoc = i; }
  if (firstDoc) await T.openDoc(firstDoc.id);
});
await scenario('刷题中心 + 错题本', async () => { T.go('practice'); T.setPracticeTab('wrong'); });
// 主观题标签：切过去后四步面板、方向选择、练习历史都要在位
await scenario('主观题标签', async () => {
  T.go('practice');
  T.setPracticeTab('subj');
});
await scenario('任务日历', async () => { T.go('calendar'); await T.loadCalendar(); });
await scenario('作品集 + 新增弹窗', async () => { T.go('portfolio'); await T.loadPortfolio(); T.openPortfolioModal({}); });
await scenario('设置页', async () => { T.go('settings'); await T.loadSettings(); });
await scenario('今日目标弹窗', async () => {
  T.go('dashboard'); document.getElementById('btnEditGoal').onclick(); await sleep(500);
});
await scenario('新知识弹窗', async () => { T.showNewKnowledgeList(); await sleep(500); });
await scenario('新知识新增表单', async () => {
  const b = document.getElementById('nkAdd'); if (b) b.onclick(); await sleep(300);
});
await scenario('部署说明弹窗', async () => { document.getElementById('btnUpgrade').onclick(); await sleep(200); });

/* ---------- 3. 契约结论 ---------- */

console.log('\n=== 3. 契约结论 ===');

// 这些 id 只在「请求进行中」这一瞬间存在，稳定态里观察不到。
// 允许清单必须写清理由，避免以后变成「一有问题就往白名单里加」。
const TRANSIENT = new Map([
  ['stList', 'AI 补全过程中才生成的步骤列表（只在 SSE 期间存在）'],
  ['qaBody', 'AI 答疑流式输出中的答案容器（只在 SSE 期间存在）'],
  ['subjStream', '主观题反馈流式输出中的容器（只在 SSE 期间存在）'],
  ['btnClearWrong', '错题本非空时才渲染的「清空」按钮'],
]);

const deadSelectors = [...jsIds].filter(id => !everSeen.has(id) && !TRANSIENT.has(id));
t('所有被引用的 id 都能在某个真实场景里被创建', deadSelectors.length === 0,
  deadSelectors.length ? '始终没被创建：' + deadSelectors.join(', ') : jsIds.size + ' 个 id 全部可达');

for (const [id, why] of TRANSIENT) {
  t('允许清单条目 ' + id + ' 仍被引用（' + why + '）', jsIds.has(id));
}

const neverSeen = [...runtimeIds].filter(id => !htmlIds.has(id) && !everSeen.has(id) && !TRANSIENT.has(id));
t('app.js 模板里声明的动态 id 都真的被生成过', neverSeen.length === 0,
  neverSeen.length ? '模板里有但从未生成：' + neverSeen.join(', ') : runtimeIds.size + ' 个动态 id 全部验证到');

console.log(`\n===== 合计：PASS ${pass} / FAIL ${fail} =====`);
process.exit(fail ? 1 : 0);
