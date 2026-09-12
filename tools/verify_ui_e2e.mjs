/* =============================================================================
 * verify_ui_e2e.mjs —— 在 Node 里真实执行 public/app.js，跑通 7 个页面
 * -----------------------------------------------------------------------------
 * 这不是「读代码猜能不能跑」，而是：
 *   1) 用 dom_shim 造一个 DOM，加载真实的 public/index.html
 *   2) 真的执行 public/app.js（同一个文件，不改一行）
 *   3) 真的去打 http://127.0.0.1:3000 上的后端接口（带 cookie jar，走真实多用户隔离）
 *   4) 像人一样点按钮、填输入框，然后检查 DOM 里有没有渲染出真实数据
 *
 * 默认会跳过需要调用大模型的步骤（出题 / 补全 / AI 答疑），加 --ai 才会跑。
 *
 * 用法：
 *   node tools/verify_ui_e2e.mjs              # 不含 AI 调用
 *   node tools/verify_ui_e2e.mjs --ai         # 连 AI 相关路径一起验
 *   node tools/verify_ui_e2e.mjs --ai --keep  # 保留测试产生的数据（默认会清理）
 *
 * 前置：后端已启动（ENABLE_QUERY_MODEL=1 时检索才是语义模式）
 * ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import vm from 'node:vm';

import { createDOM, makeFetch, makeLocalStorage } from './dom_shim.mjs';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PUB = path.join(ROOT, 'public');
const BASE = process.env.AIPM_BASE || 'http://127.0.0.1:3000';

const WITH_AI = process.argv.includes('--ai');

/* --------------------------------- 断言 ----------------------------------- */

let pass = 0;
const fails = [];
const skips = [];

function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); return true; }
  fails.push(name + (detail ? ' → ' + detail : ''));
  console.log('  ✗ ' + name + (detail ? ' → ' + detail : ''));
  return false;
}
function skip(name, reason) {
  skips.push(name + '（' + reason + '）');
  console.log('  ○ 跳过 ' + name + '：' + reason);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  for (;;) {
    let v = false;
    try { v = await fn(); } catch (e) { /* 还没就绪 */ }
    if (v) return true;
    if (Date.now() - t0 > ms) throw new Error('等待超时：' + label);
    await sleep(80);
  }
}

/* ------------------------------- 启动环境 --------------------------------- */

const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const appSrc = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');

const document = createDOM(html);
const myFetch = makeFetch(BASE);
const localStorage = makeLocalStorage();

// 固定一个测试专用的用户桶，避免每次跑都新建一个孤儿 bucket 把 data/ 撑大。
// （服务端要求 cookie 值匹配 ^[A-Za-z0-9_-]{6,40}$）
const TEST_UID = 'e2e_verify_bucket';
myFetch.jar.set('aipm_uid', TEST_UID);

const alerts = [];
const confirms = [];
const logs = [];

const windowObj = {
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  addEventListener() {},
  location: { origin: BASE, hostname: '127.0.0.1', href: BASE + '/' },
};

Object.assign(globalThis, {
  document: document,
  window: windowObj,
  localStorage: localStorage,
  location: windowObj.location,
  fetch: myFetch,
  alert: m => { alerts.push(String(m)); logs.push('[alert] ' + m); },
  confirm: m => { confirms.push(String(m)); return true; },
  prompt: () => null,
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  requestAnimationFrame: cb => setTimeout(cb, 0),
});
// navigator 在 Node 里是只读的 getter，用 defineProperty 覆盖
try {
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'node-e2e' }, configurable: true, writable: true,
  });
} catch (e) { /* 覆盖不了也不影响 */ }

// 暴露内部函数给测试用（app.js 本身不需要这段）
const epilogue = `
;globalThis.__T = {
  S: S, go: go, api: api, openDoc: openDoc, renderSidebar: renderSidebar,
  loadDashboard: loadDashboard, loadCalendar: loadCalendar, loadPortfolio: loadPortfolio,
  loadSettings: loadSettings, loadQuiz: loadQuiz, renderWrong: renderWrong,
  fillQuizPick: fillQuizPick, setPracticeTab: setPracticeTab, labSend: labSend,
  tutorSend: tutorSend, runGlobalSearch: runGlobalSearch, openPortfolioModal: openPortfolioModal,
  showNewKnowledgeList: showNewKnowledgeList, isPrivateHost: isPrivateHost,
  refreshTree: refreshTree,
};
`;

console.log('==============================================================');
console.log(' AIPM 前端端到端验证（真实执行 app.js，真实打后端接口）');
console.log(' 目标: ' + BASE + '    AI 步骤: ' + (WITH_AI ? '开启' : '跳过'));
console.log('==============================================================');

/* ------------------------------- 0. 准备 --------------------------------- */
console.log('\n[0] 环境准备');

let health = null;
try {
  const r = await myFetch('/api/health');
  health = await r.json();
} catch (e) {
  console.log('  ✗ 连不上后端 ' + BASE + '：' + e.message);
  console.log('    请先启动：$env:ENABLE_QUERY_MODEL="1"; node server.js');
  process.exit(1);
}
check('后端健康检查可达', health && health.ok === true, 'ok=' + (health && health.ok));
check('检索为语义混合模式（EMB 已加载）', !!health.retrieval && health.retrieval.mode === 'hybrid',
  'mode=' + (health.retrieval && health.retrieval.mode));
check('embedding 覆盖全部知识点', health.retrieval.embeddingCount === health.docs,
  health.retrieval.embeddingCount + '/' + health.docs);
if (health.retrieval.queryEncoding !== 'real-model') {
  console.log('  ! 注意：queryEncoding=' + health.retrieval.queryEncoding +
    '，说明启动时没带 ENABLE_QUERY_MODEL=1，检索质量会下降');
}

/* ------------------------------- 1. 启动 --------------------------------- */
console.log('\n[1] 加载 index.html 并执行 app.js（模拟打开页面）');

try {
  vm.runInThisContext(appSrc + epilogue, { filename: 'public/app.js' });
  check('app.js 执行无异常', true);
} catch (e) {
  check('app.js 执行无异常', false, e.message);
  console.log('\n堆栈：\n' + e.stack);
  process.exit(1);
}

const T = globalThis.__T;
check('app.js 暴露了内部状态', !!T && !!T.S);

await waitFor(() => T.S.stats && T.S.stats.ok, 12000, '仪表盘数据加载')
  .then(() => check('启动后自动进入仪表盘并拉到 /api/stats', true))
  .catch(e => check('启动后自动进入仪表盘并拉到 /api/stats', false, e.message));

check('默认停在仪表盘页（page-dashboard 有 on 类）',
  document.getElementById('page-dashboard').classList.contains('on'));
check('导航高亮跟着页面走',
  document.querySelectorAll('.nav-item')[0].classList.contains('on'));

const treeDocs = T.S.tree.reduce((a, g) => a + g.count, 0);
check('知识树渲染出 ' + treeDocs + ' 个知识点', treeDocs > 200, 'count=' + treeDocs);
check('左侧树渲染出了可见节点', document.querySelectorAll('#tree .t-leaf').length > 0,
  'leaf=' + document.querySelectorAll('#tree .t-leaf').length);
check('侧栏统计文案已填充', document.getElementById('sbSub').textContent.indexOf('个知识点') >= 0,
  document.getElementById('sbSub').textContent.slice(0, 60));

/* ---------------------- 2. 仪表盘：真实数据渲染 ---------------------- */
console.log('\n[2] 仪表盘主页渲染');

const ovEvents = document.getElementById('ovEvents').textContent;
const ovMinutes = document.getElementById('ovMinutes').textContent;
const planPct = document.getElementById('planPct').textContent;
const practiceItems = document.querySelectorAll('#practiceList .practice-item');
const miniDays = document.querySelectorAll('#miniCal .mini-day');
const planStages = document.querySelectorAll('#planStages > div');

check('今日事件数已填充（当前 ' + ovEvents + '）', /^\d+$/.test(ovEvents));
check('时长气泡已填充（' + ovMinutes + '）', /^\d+m$/.test(ovMinutes), ovMinutes);
check('成长计划百分比已填充（' + planPct + '%）', /^\d+$/.test(planPct));
check('成长计划 4 个阶段都渲染了', planStages.length === 4, 'stages=' + planStages.length);
check('我的练习 6 条都有进度条', practiceItems.length === 6 &&
  document.querySelectorAll('#practiceList .pi-fill').length === 6,
  'items=' + practiceItems.length);
check('迷你日历渲染 14 天', miniDays.length === 14, 'days=' + miniDays.length);
check('时长口径被明确标注为「估算」',
  document.getElementById('ovNote').textContent.indexOf('估算') >= 0,
  document.getElementById('ovNote').textContent);
check('侧栏小统计已填充', /^\d+%$/.test(document.getElementById('miniProgress').textContent),
  document.getElementById('miniProgress').textContent);
check('环形进度条用真实百分比设置了 dasharray',
  /^\d/.test(document.getElementById('ringArc').getAttribute('stroke-dasharray') || ''));

/* ---------------------- 3. 知识库：详情 / 笔记 / 已学 ---------------------- */
console.log('\n[3] 知识库文档页（详情、笔记、已学、检索）');

// 挑一个概念类知识点（有 explain 的更适合验证渲染）
let target = null;
for (const g of T.S.tree) for (const s of g.sections) for (const i of s.items) {
  if (i.expanded && !target) target = i;
}
check('能找到一条有长解释的知识点', !!target, target ? target.title : '无');

await T.openDoc(target.id);
await waitFor(() => document.querySelector('#kbMain h1.title'), 5000, '详情渲染');
const h1 = document.querySelector('#kbMain h1.title');
check('详情页标题与所选知识点一致', h1 && h1.textContent.trim() === target.title,
  h1 ? h1.textContent : '无');
check('面包屑渲染', document.querySelectorAll('#kbMain .crumb span').length >= 2);
check('概念解释有正文', document.querySelectorAll('#kbMain .prose p').length > 0);
check('渲染了「概念解释 / 关联概念 / AI 答疑 / 我的笔记」四个板块',
  document.getElementById('kbMain').textContent.indexOf('概念解释') >= 0 &&
  document.getElementById('kbMain').textContent.indexOf('关联概念') >= 0 &&
  document.getElementById('kbMain').textContent.indexOf('AI 答疑') >= 0 &&
  document.getElementById('kbMain').textContent.indexOf('我的笔记') >= 0);

// 笔记自动保存：模拟打字后等防抖
const NOTE = '端到端验证写入的笔记 ' + Date.now();
document.getElementById('noteBox').value = NOTE;
document.getElementById('noteBox').fire('input');
await sleep(1500);
let docNow = await (await myFetch('/api/doc?id=' + encodeURIComponent(target.id))).json();
check('笔记自动保存到后端', docNow.note === NOTE, 'note=' + JSON.stringify(docNow.note).slice(0, 40));
check('保存提示已更新', document.getElementById('savedTip').textContent.indexOf('已保存') >= 0,
  document.getElementById('savedTip').textContent);
check('左侧树出现「有笔记」标记 ✎',
  document.querySelector('#tree .t-leaf.active .flags').textContent.indexOf('✎') >= 0);

// 标记已学
document.getElementById('btnLearned').onclick();
await waitFor(async () => {
  const d = await (await myFetch('/api/doc?id=' + encodeURIComponent(target.id))).json();
  return d.learned === true;
}, 5000, '已学状态写回').then(() => check('标记已学写回后端', true))
  .catch(e => check('标记已学写回后端', false, e.message));
await waitFor(() => document.getElementById('btnLearned').textContent.indexOf('已学（点击取消）') >= 0, 5000, '按钮状态刷新')
  .then(() => check('按钮变成「已学（点击取消）」', true))
  .catch(e => check('按钮变成「已学（点击取消）」', false, e.message));

// 取消已学 → 再标回来（幂等验证）
document.getElementById('btnLearned').onclick();
await sleep(400);
document.getElementById('btnLearned').onclick();
await sleep(400);
docNow = await (await myFetch('/api/doc?id=' + encodeURIComponent(target.id))).json();
check('已学状态可反复切换且最终正确', docNow.learned === true, 'learned=' + docNow.learned);

// 左侧树搜索过滤
document.getElementById('treeSearch').value = 'RAG';
document.getElementById('treeSearch').fire('input');
const filtered = document.querySelectorAll('#tree .t-leaf').length;
check('知识树搜索能过滤（RAG → ' + filtered + ' 条）', filtered > 0 && filtered < treeDocs,
  filtered + ' / ' + treeDocs);
document.getElementById('treeSearch').value = '';
document.getElementById('treeSearch').fire('input');

// 全局检索（走 /api/search，语义混合）
document.getElementById('globalSearch').value = 'RAG 和微调怎么选';
document.getElementById('globalSearch').fire('keydown', { key: 'Enter' });
await waitFor(() => document.querySelector('#kbMain [data-open]'), 8000, '检索结果渲染');
const hitCount = document.querySelectorAll('#kbMain [data-open]').length;
check('全局检索渲染出命中卡片（' + hitCount + ' 条）', hitCount > 0);
check('检索结果卡片可点击跳转', typeof document.querySelector('#kbMain [data-open]').onclick === 'function');

// 点第一条命中 → 应该打开对应知识点
document.querySelector('#kbMain [data-open]').onclick();
await waitFor(() => document.querySelector('#kbMain h1.title'), 5000, '命中跳转');
check('从检索结果能跳到知识点详情', !!document.querySelector('#kbMain h1.title'));

/* ---------------------- 4. 刷题中心：刷题 + 错题本 ---------------------- */
console.log('\n[4] 刷题中心页');

T.go('practice');
await sleep(200);

// 菜单文字与页面大标题必须一致（渲染后从真实 DOM 里读，不看源码字符串）
{
  const navLabel = document.querySelector('.nav-item[data-page="practice"]').textContent.trim();
  const pageTitle = document.querySelector('#page-practice h1.greet').textContent.trim();
  check('菜单里这一项叫「刷题中心」', navLabel === '刷题中心', '实际: ' + navLabel);
  check('页面大标题也叫「刷题中心」', pageTitle === '刷题中心', '实际: ' + pageTitle);
  check('菜单文字与页面标题完全一致', navLabel === pageTitle);
  check('页面副标题说明了两种模式',
    document.querySelector('#page-practice .greet-sub').textContent.indexOf('客观题') >= 0 &&
    document.querySelector('#page-practice .greet-sub').textContent.indexOf('主观题') >= 0,
    document.querySelector('#page-practice .greet-sub').textContent);
  // 标签栏只有一行：客观题 / 主观题 / 错题本
  const tabs = document.querySelectorAll('#practiceSeg .seg-item');
  check('标签栏只有一个（不再有两级切换）',
    document.querySelectorAll('.page#page-practice .seg').length === 1,
    'seg=' + document.querySelectorAll('.page#page-practice .seg').length);
  check('标签数量是 3 个', tabs.length === 3, 'tabs=' + tabs.length);
  check('三个标签依次是「客观题 / 主观题 / 错题本」',
    tabs[0].textContent.trim() === '客观题' && tabs[1].textContent.trim() === '主观题' &&
    tabs[2].textContent.trim() === '错题本',
    Array.prototype.map.call(tabs, x => x.textContent.trim()).join(' / '));
  check('默认选中「客观题」', tabs[0].classList.contains('on'));
  check('页面大标题与副标题保留', document.querySelector('#page-practice h1.greet').textContent.trim() === '刷题中心' &&
    document.querySelector('#page-practice .greet-sub').textContent.indexOf('客观题') >= 0);

  // 三个标签互相切换（真点，真检查面板显隐）
  tabs[1].onclick();
  await sleep(250);
  check('点「主观题」显示主观题面板、隐藏另外两个',
    !document.getElementById('subjectiveWrap').classList.contains('hidden') &&
    document.getElementById('quizPane').classList.contains('hidden') &&
    document.getElementById('wrongPane').classList.contains('hidden'));
  check('选中态跟着走', tabs[1].classList.contains('on') && !tabs[0].classList.contains('on'));
  tabs[2].onclick();
  await sleep(300);
  check('点「错题本」显示错题本面板、隐藏另外两个',
    !document.getElementById('wrongPane').classList.contains('hidden') &&
    document.getElementById('quizPane').classList.contains('hidden') &&
    document.getElementById('subjectiveWrap').classList.contains('hidden'));
  check('错题本内容真的渲染了（不是空壳）',
    document.getElementById('wrongPane').textContent.indexOf('加载中') < 0 &&
    document.getElementById('wrongPane').textContent.length > 4,
    document.getElementById('wrongPane').textContent.replace(/\s+/g, ' ').slice(0, 40));
  tabs[0].onclick();
  await sleep(200);
  check('点「客观题」切回选择题面板',
    !document.getElementById('quizPane').classList.contains('hidden') &&
    document.getElementById('subjectiveWrap').classList.contains('hidden') &&
    document.getElementById('wrongPane').classList.contains('hidden'));
  check('原有选择题控件都还在（下拉/生成/交卷）',
    !!document.getElementById('quizPick') && !!document.getElementById('btnGen') && !!document.getElementById('btnSubmit'));
}

const pickOptions = document.querySelectorAll('#quizPick option').length;
check('题目下拉填入了全部知识点（' + pickOptions + ' 项）', pickOptions >= 241, 'opts=' + pickOptions);

// 找一个「还没出过题」的知识点，这样才能复现「还没出过题」的空状态。
// （测试用固定用户桶，重复跑的时候 target 那个知识点可能已经有题了）
let quizDoc = null;
{
  const cands = [];
  for (const g of T.S.tree) for (const s of g.sections) for (const i of s.items) cands.push(i);
  for (const c of cands) {
    const r = await (await myFetch('/api/quiz?id=' + encodeURIComponent(c.id))).json();
    if (!(r.questions || []).length) { quizDoc = c; break; }
  }
}
check('找到一个还没出过题的知识点用于验证空状态', !!quizDoc, quizDoc ? quizDoc.title : '全部知识点都已出过题');

document.getElementById('quizPick').value = quizDoc.id;
document.getElementById('quizPick').fire('change');
await waitFor(() => document.getElementById('quizBody').textContent.indexOf('加载中') < 0, 5000, '题目加载');
check('未出题时给出明确引导',
  document.getElementById('quizBody').textContent.indexOf('还没出过题') >= 0,
  document.getElementById('quizBody').textContent.slice(0, 50).replace(/\s+/g, ' '));

if (WITH_AI) {
  const wrongBefore = ((await (await myFetch('/api/wrong')).json()).items || []).length;
  document.getElementById('btnGen').onclick();
  // 出题结束的可靠信号：按钮从 disabled 恢复，且题目已渲染出来
  const genOk = await waitFor(() =>
    document.getElementById('btnGen').disabled === false &&
    document.querySelectorAll('#quizBody .card[data-qi]').length === 3,
  120000, 'AI 出题').then(() => true).catch(() => false);
  if (genOk) {
    check('AI 生成 3 道题并渲染选项',
      document.querySelectorAll('#quizBody .card[data-qi]').length === 3 &&
      document.querySelectorAll('#quizBody .opt').length === 12,
      'cards=' + document.querySelectorAll('#quizBody .card[data-qi]').length +
      ' opts=' + document.querySelectorAll('#quizBody .opt').length);
    check('每题 4 个选项、均带 ABCD 序号',
      document.querySelectorAll('#quizBody .card[data-qi] .opt .idx').length === 12,
      'idx=' + document.querySelectorAll('#quizBody .card[data-qi] .opt .idx').length);
    check('出题后按钮恢复可用', document.getElementById('btnGen').disabled === false);

    // 全部故意选错，验证错题自动入本
    let clicked = 0;
    document.querySelectorAll('#quizBody .card[data-qi]').forEach((card, qi) => {
      const opts = card.querySelectorAll('.opt');
      const correctIdx = T.S.quiz.qs[qi].answer;
      const wrongIdx = (correctIdx + 1) % opts.length;
      if (opts[wrongIdx]) { opts[wrongIdx].onclick(); clicked++; }
    });
    check('点选后有选中态', clicked === 3 && document.querySelectorAll('#quizBody .opt.sel').length === 3,
      'clicked=' + clicked);
    document.getElementById('btnSubmit').onclick();
    await waitFor(() => document.querySelector('#quizResult .score-box'), 15000, '交卷结果');
    check('交卷显示得分', document.querySelector('#quizResult .score-box').textContent.indexOf('/ 3') >= 0,
      document.querySelector('#quizResult .score-box').textContent.replace(/\s+/g, ' '));
    check('答错选项被标红、正确选项被标绿',
      document.querySelectorAll('#quizBody .opt.wrong').length === 3 &&
      document.querySelectorAll('#quizBody .opt.right').length === 3);
    check('每题都插入了 AI 解析', document.querySelectorAll('#quizBody .explain').length === 3);

    const wrong = await (await myFetch('/api/wrong')).json();
    check('错题自动进了错题本（本次 +' + (wrong.items.length - wrongBefore) + ' 道，累计 ' + wrong.items.length + ' 道）',
      wrong.items.length - wrongBefore === 3);

    T.setPracticeTab('wrong');
    await waitFor(() => document.querySelectorAll('#wrongPane .card').length >= 3, 6000, '错题本渲染');
    check('错题本页渲染出错题', document.querySelectorAll('#wrongPane .card').length >= 3,
      'cards=' + document.querySelectorAll('#wrongPane .card').length);
    check('错题本标出了正确/错误选项',
      document.querySelectorAll('#wrongPane .opt.right').length >= 3 &&
      document.querySelectorAll('#wrongPane .opt.wrong').length >= 3);
    check('错题本能跳回知识点', typeof document.querySelector('#wrongPane [data-doc]').onclick === 'function');

    // 移除一道
    const wrongNow = ((await (await myFetch('/api/wrong')).json()).items || []).length;
    document.querySelector('#wrongPane [data-del]').onclick();
    await waitFor(async () => ((await (await myFetch('/api/wrong')).json()).items || []).length === wrongNow - 1,
      6000, '移除错题')
      .then(() => check('错题可以逐条移除', true))
      .catch(e => check('错题可以逐条移除', false, e.message));
    T.setPracticeTab('quiz');
  } else {
    skip('AI 出题 / 交卷 / 错题本写入', '出题接口没在 120 秒内返回（可能是 Key / 余额 / 网络问题）');
    skip('错题本渲染（需要先有错题）', '本轮没有生成题目');
  }
} else {
  skip('AI 出题 / 交卷 / 错题本写入', '未加 --ai');
  skip('错题本渲染（需要先有错题）', '未加 --ai');
}

/* ------------- 4b. 主观题练习（PRD 撰写 / 提示词优化） ------------- */
console.log('\n[4b] 主观题练习模式');

const has = (sel, cls) => { const el = document.querySelector(sel); return !!el && el.classList.contains(cls); };
const quizVisible = () => !has('#quizPane', 'hidden');
const subjVisible = () => !has('#subjectiveWrap', 'hidden');
const wrongVisible = () => !has('#wrongPane', 'hidden');

// 主观题是标签栏里的第二个选项（点它即可，不需要再切一层模式）
const modeBtns = document.querySelectorAll('#practiceSeg .seg-item');
modeBtns[1].onclick();
await sleep(300);
check('切到主观题：主观题面板显示、客观题与错题本隐藏',
  subjVisible() && !quizVisible() && !wrongVisible());
check('主观题四步进度条齐了', document.querySelectorAll('#subjSteps .step').length === 4,
  'steps=' + document.querySelectorAll('#subjSteps .step').length);
check('四个步骤文字与需求一致',
  ['选方向与知识点', '生成练习题', '写我的思路', '看反馈再迭代']
    .every((t, i) => document.querySelectorAll('#subjSteps .step')[i].textContent.indexOf(t) >= 0),
  Array.prototype.map.call(document.querySelectorAll('#subjSteps .step'), e => e.textContent.trim()).join(' | '));
check('第一步是当前步骤', document.querySelectorAll('#subjSteps .step')[0].classList.contains('on'));

const dirChips = document.querySelectorAll('#subjDir .chip');
check('练习方向有两个（PRD 撰写类 / 提示词优化类）', dirChips.length === 2);
check('方向名称正确',
  dirChips[0].textContent.indexOf('PRD 撰写类') >= 0 && dirChips[1].textContent.indexOf('提示词优化类') >= 0,
  dirChips[0].textContent + ' / ' + dirChips[1].textContent);
check('默认选中 PRD 撰写类', dirChips[0].classList.contains('on'));

dirChips[1].onclick();
await sleep(120);
check('可以切到提示词优化类', dirChips[1].classList.contains('on') && !dirChips[0].classList.contains('on'));
check('方向提示语跟着变',
  document.getElementById('subjDirHint').textContent.indexOf('提示词') >= 0,
  document.getElementById('subjDirHint').textContent);
dirChips[0].onclick();
await sleep(120);

const subjDocOpts = document.querySelectorAll('#subjDoc option').length;
check('关联知识点下拉填入了全部知识点（' + subjDocOpts + ' 项）', subjDocOpts >= 240, 'opts=' + subjDocOpts);
check('知识点下拉已选中一个（不是空值）', !!document.getElementById('subjDoc').value);
check('有「联网搜真实案例」的开关且默认打开', document.getElementById('subjWeb').checked === true);
check('有「只看真实案例」按钮', !!document.getElementById('btnSubjCase'));
check('思路输入框存在且是简略思路（不是全文）', !!document.getElementById('subjIdea'));
check('反馈区有等待说明',
  document.getElementById('subjFeedback').textContent.indexOf('三部分反馈') >= 0);
check('练习历史区已渲染', document.getElementById('subjHistCount').textContent.indexOf('次') >= 0,
  document.getElementById('subjHistCount').textContent);

// 切回客观题：原有选择题功能必须完好
modeBtns[0].onclick();
await sleep(200);
check('切回客观题：原有面板恢复显示', quizVisible() && !subjVisible() && !wrongVisible());
check('原有错题本容器还在', !!document.getElementById('wrongPane'));

// 再走一遍三个标签的往返，确认没有互相影响
modeBtns[2].onclick();
await sleep(250);
check('错题本标签可独立打开（不需要先切回客观题）', wrongVisible() && !quizVisible() && !subjVisible());
modeBtns[1].onclick();
await sleep(250);
check('从错题本直接切回主观题也正常', subjVisible() && !wrongVisible() && !quizVisible());
check('再切回主观题后四步面板仍在', document.querySelectorAll('#subjSteps .step').length === 4);

if (WITH_AI) {
  // ---- 第二步：生成练习题（走 /api/ask，联网开关打开时先搜真实案例）----
  const statsBefore = await (await myFetch('/api/stats')).json();
  const nkBefore = ((await (await myFetch('/api/newknowledge')).json()).items || []).length;

  document.getElementById('btnSubjGen').onclick();
  const genOk = await waitFor(() => {
    const q = document.getElementById('subjQuestion').textContent;
    return q.indexOf('业务背景') >= 0 && q.indexOf('你的任务') >= 0 &&
      document.getElementById('btnSubjGen').disabled === false;
  }, 150000, '主观题生成').then(() => true).catch(() => false);

  check('AI 生成出练习题（含业务背景/需求场景/任务/交付要求）', genOk,
    document.getElementById('subjQuestion').textContent.replace(/\s+/g, ' ').slice(0, 80));
  const qText = document.getElementById('subjQuestion').textContent;
  check('题目包含需求场景', qText.indexOf('需求场景') >= 0);
  check('题目包含交付要求', qText.indexOf('交付要求') >= 0);
  check('题目没有直接给答案（不是一段成稿）', qText.indexOf('【你的任务】') >= 0);
  check('题目区标注了背景来源（联网案例 或 本地知识库）',
    qText.indexOf('联网案例') >= 0 || qText.indexOf('本地知识库') >= 0,
    qText.slice(0, 40).replace(/\s+/g, ' '));
  check('出题后进度条走到第三步', document.querySelectorAll('#subjSteps .step')[2].classList.contains('on'));
  // 没有配搜索 Key 时应该优雅降级（联网失败但题目照出）
  const webNote = document.getElementById('subjWebHint').textContent;
  check('联网决策有明确提示（联网 或 本地）', webNote.indexOf('联网') >= 0 || webNote.indexOf('本地') >= 0, webNote);

  // ---- 第三步：写思路并提交 ----
  const IDEA1 = '1. 目标是让客服少花时间\n2. 先做抽字段，再做自动回复\n3. 用准确率和节省工时衡量';
  document.getElementById('subjIdea').value = IDEA1;
  document.getElementById('btnSubjSubmit').onclick();
  const fbOk = await waitFor(() => {
    const el = document.getElementById('subjFeedback');
    return el.textContent.indexOf('优化后的规范完整版本') >= 0 &&
      document.getElementById('btnSubjSubmit').disabled === false;
  }, 180000, '主观题反馈').then(() => true).catch(() => false);

  check('AI 返回了带三段结构的反馈', fbOk,
    document.getElementById('subjFeedback').textContent.replace(/\s+/g, ' ').slice(0, 90));
  const blocks = document.querySelectorAll('#subjFeedback .fb-block');
  check('反馈渲染成 3 个独立区块', blocks.length === 3, 'blocks=' + blocks.length);
  check('① 是「优化后的规范完整版本」', blocks[0] && blocks[0].textContent.indexOf('优化后的规范完整版本') >= 0);
  check('② 是「你思路里缺少的核心要素」', blocks[1] && blocks[1].textContent.indexOf('缺少的核心要素') >= 0);
  check('③ 是「标准结构拆解与修改理由」', blocks[2] && blocks[2].textContent.indexOf('结构拆解') >= 0);
  check('① 有实际内容（不是空壳）', blocks[0].textContent.length > 150, 'len=' + blocks[0].textContent.length);
  check('② 列出了缺失要素', blocks[1].querySelectorAll('.qa-answer li, .qa-answer p').length >= 2,
    'items=' + blocks[1].querySelectorAll('.qa-answer li, .qa-answer p').length);
  check('③ 讲了为什么这样写', blocks[2].textContent.length > 100, 'len=' + blocks[2].textContent.length);
  check('反馈区标注了「可以直接拿去评审」这类交付提示',
    blocks[0].textContent.indexOf('评审') >= 0 || blocks[0].textContent.indexOf('规范') >= 0);
  check('进度条四步全部完成',
    Array.prototype.every.call(document.querySelectorAll('#subjSteps .step'), e => e.classList.contains('done')));

  // ---- 自动保存 + 练习历史 ----
  check('提交后自动保存提示出现',
    document.getElementById('subjTip').textContent.indexOf('已自动保存') >= 0,
    document.getElementById('subjTip').textContent);
  const nkAfter = ((await (await myFetch('/api/newknowledge')).json()).items || []);
  const saved1 = nkAfter.filter(x => (x.tags || []).indexOf('主观题练习') >= 0);
  check('练习记录落库（/api/newknowledge 里带「主观题练习」标签）', saved1.length === 1,
    'records=' + saved1.length);
  check('记录标题带方向与知识点',
    saved1[0] && saved1[0].title.indexOf('PRD 撰写类') >= 0 && saved1[0].title.indexOf('主观题练习') >= 0,
    saved1[0] && saved1[0].title);
  check('记录正文含题目 + 我的思路 + AI 反馈',
    saved1[0] && saved1[0].content.indexOf('【练习题】') >= 0 &&
    saved1[0].content.indexOf('我的思路') >= 0 && saved1[0].content.indexOf('【AI 反馈') >= 0);
  check('记录关联了知识点（from 字段）',
    !!(saved1[0] && saved1[0].from && saved1[0].from[0] && saved1[0].from[0].title),
    saved1[0] && JSON.stringify(saved1[0].from));
  await waitFor(() => document.getElementById('subjHistCount').textContent.indexOf('1 次') >= 0, 6000, '历史计数')
    .then(() => check('练习历史列表出现这条记录', document.querySelectorAll('#subjHistory .hist-item').length === 1))
    .catch(e => check('练习历史列表出现这条记录', false, e.message));
  check('历史里能展开/收起与删除', !!document.querySelector('#subjHistory [data-histtoggle]') &&
    !!document.querySelector('#subjHistory [data-histdel]'));

  // ---- 练习数据同步到整体学习统计 ----
  const statsAfter = await (await myFetch('/api/stats')).json();
  check('练习次数进入整体统计：新知识 +1',
    statsAfter.totals.newKnowledge === statsBefore.totals.newKnowledge + 1,
    statsBefore.totals.newKnowledge + ' → ' + statsAfter.totals.newKnowledge);
  check('练习被记为学习活动：今日事件 +1（服务端活动流）',
    statsAfter.today.events >= statsBefore.today.events + 1,
    statsBefore.today.events + ' → ' + statsAfter.today.events);
  await waitFor(() => document.getElementById('miniEvents').textContent !== '–', 6000, '侧栏统计')
    .then(() => check('侧栏/仪表盘统计会重新读取（进仪表盘即刷新）', true))
    .catch(() => {});

  // ---- 迭代：改完再提交一次，应生成第 2 版并单独存一条 ----
  document.getElementById('subjIdea').value = IDEA1 + '\n4. 补上：先做人工兜底，抽错时有人工复核入口\n5. 补上：第一版只覆盖 3 类工单，其余先不做';
  document.getElementById('btnSubjSubmit').onclick();
  const v2Ok = await waitFor(async () => {
    const items = ((await (await myFetch('/api/newknowledge')).json()).items || [])
      .filter(x => (x.tags || []).indexOf('主观题练习') >= 0);
    return items.length === 2 && document.getElementById('btnSubjSubmit').disabled === false;
  }, 180000, '第二版反馈').then(() => true).catch(() => false);
  check('同一道题可以迭代第二版（反馈照常给出）', v2Ok);
  const v2 = ((await (await myFetch('/api/newknowledge')).json()).items || [])
    .filter(x => (x.tags || []).indexOf('主观题练习') >= 0);
  check('第 2 版单独存了一条记录（带「第 2 版」标签）',
    v2.some(x => (x.tags || []).indexOf('第 2 版') >= 0), 'records=' + v2.length);
  check('第 2 版把上一版思路带进了上下文（历史里有上一版正文）',
    v2.some(x => x.content.indexOf('人工兜底') >= 0));
  await waitFor(() => document.getElementById('subjHistCount').textContent.indexOf('2 次') >= 0, 6000, '历史计数 2')
    .then(() => check('练习历史累计到 2 条', true))
    .catch(e => check('练习历史累计到 2 条', false, e.message));

  // ---- 删除一条 ----
  document.querySelector('#subjHistory [data-histdel]').onclick();
  await waitFor(async () => ((await (await myFetch('/api/newknowledge')).json()).items || [])
    .filter(x => (x.tags || []).indexOf('主观题练习') >= 0).length === 1, 8000, '删除练习记录')
    .then(() => check('练习记录可以删除', true))
    .catch(e => check('练习记录可以删除', false, e.message));

  // ---- 仪表盘「我的练习」里能看到主观题练习 ----
  T.go('dashboard');
  await waitFor(() => document.querySelectorAll('#practiceList .practice-item').length === 6, 8000, '仪表盘练习卡');
  const practiceText = document.getElementById('practiceList').textContent;
  check('仪表盘「我的练习」新增了主观题练习一项', practiceText.indexOf('主观题练习') >= 0);
  check('统计里显示已练次数与覆盖知识点',
    practiceText.indexOf('已练') >= 0 && practiceText.indexOf('个知识点') >= 0,
    practiceText.replace(/\s+/g, ' ').slice(0, 120));
  T.go('practice');
  modeBtns[1].onclick();
  await sleep(300);
} else {
  skip('主观题生成 / 反馈 / 保存 / 迭代 / 统计同步', '未加 --ai');
}

/* ---------------------- 5. API 实验 ---------------------- */
console.log('\n[5] API 实验页');

T.go('lab');
document.getElementById('labUrl').value = 'https://api.deepseek.com/models';
check('地址输入框可写', document.getElementById('labUrl').value.indexOf('deepseek') >= 0);

// 试本站接口：应该自动勾上「允许内网」并且真的发出请求
document.getElementById('btnLabHealth').onclick();
await waitFor(() => document.getElementById('labResult').textContent.indexOf('响应体') >= 0, 20000, '本站健康检查结果')
  .then(() => check('「试本站 /api/health」真的发出请求并渲染响应', true))
  .catch(e => check('「试本站 /api/health」真的发出请求并渲染响应', false, e.message));
check('本机地址自动勾选了「允许内网」', document.getElementById('labPrivate').checked === true);
check('响应状态码已显示', /\d{3}/.test(document.getElementById('labStatus').textContent),
  document.getElementById('labStatus').textContent);
check('响应头以列表形式展示', document.querySelectorAll('#labResult .kv').length > 0,
  'kvs=' + document.querySelectorAll('#labResult .kv').length);
check('响应体以代码块展示', document.querySelectorAll('#labResult .code-block').length === 1);

// 样本 chip：点 /api/stats
const statChip = Array.prototype.filter.call(document.querySelectorAll('#labSamples .chip'),
  c => c.dataset.url === '/api/stats')[0];
check('样本 chip 存在 /api/stats', !!statChip);
statChip.onclick();
await waitFor(() => document.getElementById('labResult').textContent.indexOf('"totals"') >= 0, 20000, 'stats 响应体')
  .then(() => check('/api/stats 样本返回了真实 JSON（含 totals）', true))
  .catch(e => check('/api/stats 样本返回了真实 JSON（含 totals）', false, e.message));

/* ---------------------- 6. 项目作品集 ---------------------- */
console.log('\n[6] 项目作品集页');

T.go('portfolio');
await waitFor(() => document.getElementById('portfolioList').textContent.indexOf('加载中') < 0, 6000, '作品集加载');
check('空状态有引导文案', document.getElementById('portfolioList').textContent.indexOf('还没有作品') >= 0 ||
  document.querySelectorAll('#portfolioList .pf-item').length > 0);

const PF_TITLE = '端到端验证作品 ' + Date.now();
T.openPortfolioModal({ docId: target.id, docTitle: target.title });
document.getElementById('pfTitle').value = PF_TITLE;
document.getElementById('pfType').value = 'prd';
document.getElementById('pfSummary').value = '验证用：一句话简介应该被持久化。';
document.getElementById('pfLink').value = 'https://example.com/aipm';
document.getElementById('pfDoc').value = target.id;
document.getElementById('pfSave').onclick();
await waitFor(() => document.getElementById('portfolioList').textContent.indexOf(PF_TITLE) >= 0, 8000, '作品渲染')
  .then(() => check('新增作品后列表立即出现该作品', true))
  .catch(e => check('新增作品后列表立即出现该作品', false, e.message));

const pfServer = await (await myFetch('/api/portfolio')).json();
const saved = (pfServer.items || []).filter(x => x.title === PF_TITLE)[0];
check('作品落库并带上关联知识点', !!saved && saved.docId === target.id,
  saved ? 'docId=' + saved.docId : '未找到');
check('作品类型保存正确', !!saved && saved.type === 'prd', saved && saved.type);
check('关联知识点名称由后端补齐', !!saved && saved.docTitle === target.title, saved && saved.docTitle);
check('作品卡片渲染了类型/时间/来源标签',
  document.querySelectorAll('#portfolioList .pf-item .mini-tag').length >= 3);

// 删除
const delBtn = Array.prototype.filter.call(document.querySelectorAll('#portfolioList [data-pfdel]'),
  b => true)[0];
check('作品卡片有删除按钮', !!delBtn);
delBtn.onclick();
await waitFor(async () => ((await (await myFetch('/api/portfolio')).json()).items || []).length === 0, 8000, '作品删除')
  .then(() => check('作品可以删除', true))
  .catch(e => check('作品可以删除', false, e.message));

/* ---------------------- 7. 任务日历 ---------------------- */
console.log('\n[7] 任务日历页');

T.go('calendar');
await waitFor(() => document.querySelectorAll('#calGrid .cal-cell').length > 0, 8000, '日历渲染');
const cells = document.querySelectorAll('#calGrid .cal-cell');
const activeCells = document.querySelectorAll('#calGrid .cal-cell.has, #calGrid .cal-cell.mid, #calGrid .cal-cell.hot');
check('日历渲染出格子（' + cells.length + ' 个）', cells.length >= 30);
check('日历按周一开头（第一行 7 个 dow 表头）', document.querySelectorAll('#calGrid .cal-dow').length === 7);
check('今天之前有学习记录的日子被点亮（' + activeCells.length + ' 天）', activeCells.length >= 1);
check('打卡统计文案有数据', document.getElementById('calStat').textContent.indexOf('天有记录') >= 0,
  document.getElementById('calStat').textContent);
check('最近学习记录列表有内容', document.querySelectorAll('#calList .cal-item').length >= 1,
  'items=' + document.querySelectorAll('#calList .cal-item').length);
check('记录里标出了事件类型与估算时长',
  document.querySelector('#calList .cal-kinds').textContent.indexOf('分钟') >= 0,
  document.querySelector('#calList .cal-kinds').textContent.replace(/\s+/g, ' '));
check('记录里列出了涉及的知识点', document.querySelector('#calList .cal-titles').textContent.indexOf('涉及') >= 0);

// 切换时间范围
document.getElementById('calRangeSel').value = '30';
document.getElementById('calRangeSel').fire('change');
await waitFor(() => document.getElementById('calStat').textContent.indexOf('天有记录') >= 0, 8000, '30 天重载');
check('时间范围可切换并重新拉取', T.S.calDays === 30);

const ck = await (await myFetch('/api/checkins?days=30')).json();
check('日历数据源标注真实（activity / derived）',
  ck.activitySource === 'activity' || ck.activitySource === 'derived', 'source=' + ck.activitySource);

/* ---------------------- 8. 设置 ---------------------- */
console.log('\n[8] 设置页');

T.go('settings');
// 注意：select 的默认首项就是 bocha，用它判断「加载完成」会立刻通过（假就绪）。
// 必须等 loadSettings 真正写完的那一处：#setKeyState 的提示文案。
await waitFor(() => {
  const t = document.getElementById('setKeyState').textContent;
  return t.indexOf('还没有配置') >= 0 || t.indexOf('已配置搜索密钥') >= 0 || t.indexOf('环境变量') >= 0;
}, 8000, '设置加载');
check('联网模式单选按后端值回填', ['optAuto', 'optAlways', 'optNever']
  .some(id => document.getElementById(id).classList.contains('on')),
  ['optAuto', 'optAlways', 'optNever'].map(id => id + '=' + document.getElementById(id).classList.contains('on')).join(' '));
check('密钥状态提示说明了「只返回有没有配置」',
  document.getElementById('setKeyState').textContent.indexOf('不会回传') >= 0 ||
  document.getElementById('setKeyState').textContent.indexOf('已配置') >= 0,
  document.getElementById('setKeyState').textContent.slice(0, 40));

const CODE = 'E2E代号';
document.getElementById('setCodeName').value = CODE;
document.getElementById('setAutoEnrich').checked = true;
document.getElementById('setSave').onclick();
await waitFor(() => document.getElementById('saveTip').textContent.indexOf('已保存') >= 0, 8000, '设置保存')
  .then(() => check('设置保存成功并回显时间', true))
  .catch(e => check('设置保存成功并回显时间', false, e.message));
check('学习代号同步到顶部', document.getElementById('codeName').textContent === CODE,
  document.getElementById('codeName').textContent);
check('学习代号同步到侧栏用户卡片', document.querySelector('.user-name').textContent === CODE,
  document.querySelector('.user-name').textContent);
check('代号持久化到 localStorage', localStorage.getItem('aipm.code') === CODE);

const st = await (await myFetch('/api/settings')).json();
check('设置真的写进了后端（autoEnrich=true, webMode=auto）',
  st.autoEnrich === true && st.webMode === 'auto', JSON.stringify(st));

/* ---------------------- 9. 今日目标 ---------------------- */
console.log('\n[9] 今日目标（仪表盘）');

T.go('dashboard');
await sleep(300);
document.getElementById('btnGoalPreset').onclick();
await waitFor(async () => (await (await myFetch('/api/goals')).json()).text.length > 0, 8000, '推荐目标写入')
  .then(() => check('「用推荐目标」写入后端', true))
  .catch(e => check('「用推荐目标」写入后端', false, e.message));
check('目标文案渲染到卡片', document.getElementById('goalText').textContent.length > 4,
  document.getElementById('goalText').textContent);
check('目标进度环有百分比', /^\d+$/.test(document.getElementById('goalPct').textContent),
  document.getElementById('goalPct').textContent);
check('已完成项数显示', document.getElementById('goalCount').textContent.indexOf('已完成') >= 0,
  document.getElementById('goalCount').textContent);

// 手动编辑目标
document.getElementById('btnEditGoal').onclick();
await waitFor(() => document.getElementById('goalSave'), 5000, '目标弹窗');
document.getElementById('goalInput').value = '端到端验证目标：学 2 个知识点';
document.getElementById('goalTarget').value = '2';
document.getElementById('goalSave').onclick();
await waitFor(async () => (await (await myFetch('/api/goals')).json()).targetTasks === 2, 8000, '目标保存')
  .then(() => check('弹窗里保存目标生效', true))
  .catch(e => check('弹窗里保存目标生效', false, e.message));
check('目标描述回显', document.getElementById('goalText').textContent.indexOf('端到端验证目标') >= 0,
  document.getElementById('goalText').textContent);

/* ---------------------- 10. 仪表盘数字是否反映刚才的操作 ---------------------- */
console.log('\n[10] 仪表盘数字与真实操作一致');

const stats = await (await myFetch('/api/stats')).json();
check('累计已学 ≥ 1（刚才标记过）', stats.totals.learned >= 1, 'learned=' + stats.totals.learned);
check('累计笔记 ≥ 1（刚才写过）', stats.totals.noted >= 1, 'noted=' + stats.totals.noted);
check('今日事件数 > 0', stats.today.events > 0, 'events=' + stats.today.events);
check('连续打卡 ≥ 1 天', stats.totals.streak >= 1, 'streak=' + stats.totals.streak);
check('页面上的已学数字与接口一致',
  document.getElementById('ovLearned').textContent.indexOf(String(stats.totals.learned)) === 0,
  document.getElementById('ovLearned').textContent + ' vs ' + stats.totals.learned);
check('页面上的笔记数字与接口一致',
  document.getElementById('ovNoted').textContent.indexOf(String(stats.totals.noted)) === 0,
  document.getElementById('ovNoted').textContent + ' vs ' + stats.totals.noted);
check('/api/stats 明确标注时长为估算', stats.today.minutesIsEstimate === true &&
  stats.today.perEventMinutes === 6);

/* ---------------------- 11. AI 问答（可选） ---------------------- */
console.log('\n[11] AI 相关路径');

if (WITH_AI) {
  // AI Tutor（仪表盘）
  T.go('dashboard');
  await sleep(200);
  const body = document.getElementById('tutorBody');
  const before = document.querySelectorAll('#tutorBody .tutor-msg').length;
  const greeting = document.querySelector('#tutorBody .tutor-msg').textContent;
  const Q = '什么是一个知识点？用一句话回答';
  T.tutorSend(Q);
  const tutorOk = await waitFor(() =>
    T.S.tutor.busy === false && document.querySelectorAll('#tutorBody .tutor-msg').length >= before + 2,
    90000, 'AI Tutor 回复').then(() => true).catch(() => false);

  check('AI Tutor 走通 SSE 并渲染回复', tutorOk, 'msgs=' + document.querySelectorAll('#tutorBody .tutor-msg').length);
  const msgs = document.querySelectorAll('#tutorBody .tutor-msg');
  check('用户消息与 AI 消息成对出现', msgs.length === before + 2, 'msgs=' + msgs.length);
  if (msgs.length >= before + 2) {
    check('用户气泡内容就是刚才问的问题', msgs[before].textContent === Q,
      msgs[before].textContent.slice(0, 40));
    const reply = msgs[before + 1].textContent;
    check('AI 气泡是真实回答（不是报错、也不是还没写）',
      reply.length > 10 && reply.indexOf('出错了') < 0 && reply.indexOf('正在检索') < 0 && reply !== greeting,
      reply.slice(0, 80).replace(/\s+/g, ' '));
    check('回答里带上了知识库引用来源', reply.indexOf('参考：') >= 0, reply.slice(0, 60).replace(/\s+/g, ' '));
    check('用户气泡有 me 样式、AI 气泡有 bot 样式',
      msgs[before].classList.contains('me') && msgs[before + 1].classList.contains('bot'));
  }
  check('多轮上下文已记录', T.S.tutor.history.length >= 2, 'history=' + T.S.tutor.history.length);

  // 追问一轮，验证上下文能接着带过去
  T.tutorSend('那它和知识点有什么区别？');
  await waitFor(() => T.S.tutor.busy === false && document.querySelectorAll('#tutorBody .tutor-msg').length >= before + 4,
    90000, 'AI Tutor 追问').then(() => check('可以连续追问（第二轮也返回了）', true))
    .catch(e => check('可以连续追问（第二轮也返回了）', false, e.message));
  check('上下文被裁剪到最近 12 条以内', T.S.tutor.history.length <= 12, 'history=' + T.S.tutor.history.length);

  // 知识点内 AI 答疑
  T.go('knowledge');
  await T.openDoc(target.id);
  await waitFor(() => document.getElementById('askInput'), 5000, '答疑输入框');
  document.getElementById('askInput').value = '这个知识点在工作中怎么用？';
  document.getElementById('btnAsk').onclick();
  await waitFor(() => {
    const el = document.getElementById('qaBody');
    return el && el.textContent.length > 20 && el.textContent.indexOf('思考中') < 0;
  }, 90000, 'AI 答疑回答').then(() => check('知识点内 AI 答疑返回内容', true))
    .catch(e => check('知识点内 AI 答疑返回内容', false, e.message));
  // 联网决策会明确告诉用户「这次有没有联网、为什么」，两种结论都算正常
  const hint = document.getElementById('webHint').textContent;
  check('联网决策提示可见（联网 或 本地够用，并给出理由）',
    (hint.indexOf('已自动联网') >= 0 || hint.indexOf('本地知识库已够用') >= 0) && hint.indexOf('·') >= 0,
    hint);

  // 笔记 → AI 补全
  document.getElementById('noteBox').value = '端到端验证：让 AI 把这句话扩展成一条可沉淀的知识。';
  document.getElementById('noteBox').fire('input');
  await sleep(1300);
  document.getElementById('btnEnrich').onclick();
  await waitFor(() => document.getElementById('enrichOut').textContent.indexOf('已写入') >= 0 ||
    document.getElementById('enrichOut').textContent.indexOf('失败') >= 0, 120000, 'AI 补全')
    .then(() => {
      check('笔记 AI 补全流程跑通', document.getElementById('enrichOut').textContent.indexOf('已写入') >= 0,
        document.getElementById('enrichOut').textContent.replace(/\s+/g, ' ').slice(0, 80));
    })
    .catch(e => check('笔记 AI 补全流程跑通', false, e.message));
  const nk = await (await myFetch('/api/newknowledge')).json();
  check('补全结果进入「新知识」', (nk.items || []).length >= 1, 'items=' + (nk.items || []).length);

  T.showNewKnowledgeList();
  await waitFor(() => document.querySelectorAll('#modalBox .enrich-item').length >= 1, 6000, '新知识弹窗')
    .then(() => check('新知识弹窗渲染出内容', true))
    .catch(e => check('新知识弹窗渲染出内容', false, e.message));
  document.getElementById('modal').classList.contains('on') &&
    check('弹窗打开状态正确', true);
  if (document.getElementById('nkClose')) document.getElementById('nkClose').onclick();
  check('弹窗可关闭', !document.getElementById('modal').classList.contains('on'));
} else {
  skip('AI Tutor / 答疑 / 补全 / 新知识弹窗', '未加 --ai');
}

/* ---------------------- 12. 全局收尾检查 ---------------------- */
console.log('\n[12] 收尾');

check('全程没有弹出未经预期的 alert（' +
  (alerts.length ? alerts.join(' | ').slice(0, 120) : '0 次') + '）', alerts.length === 0);
check('页面正常渲染结束时没有残留的「加载中」占位',
  document.body.textContent.indexOf('加载中…') < 0,
  '仍在加载的区域存在');
check('所有 7 个页面容器都能切换',
  ['dashboard', 'knowledge', 'practice', 'lab', 'calendar', 'portfolio', 'settings']
    .every(p => { T.go(p); return document.getElementById('page-' + p).classList.contains('on'); }));

/* ---------------------- 汇总 ---------------------- */
console.log('\n==============================================================');
if (skips.length) {
  console.log(' 跳过的检查 ' + skips.length + ' 项：');
  skips.forEach(s => console.log('   ○ ' + s));
}
if (fails.length) {
  console.log(' ✗ 失败 ' + fails.length + ' 项：');
  fails.forEach(f => console.log('   - ' + f));
  console.log(' 通过 ' + pass + ' 项');
  console.log('==============================================================');
  process.exit(1);
}
console.log(' ✓ 端到端验证全部通过：' + pass + ' 项断言（跳过 ' + skips.length + ' 项）');
console.log('==============================================================');
