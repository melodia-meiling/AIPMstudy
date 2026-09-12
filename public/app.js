/* =============================================================================
 * AIPM 学习工作台 · 前端逻辑（完整版 · 7 个页面）
 * -----------------------------------------------------------------------------
 * 页面与数据来源（全部是真实接口，没有任何写死的示例数字）：
 *
 *   仪表盘主页    GET  /api/stats             今日/累计/成长计划/近 14 天
 *                GET  /api/checkins?days=14   迷你日历
 *                GET  /api/goals              今日目标
 *                POST /api/goals              保存今日目标
 *                POST /api/chat               右下角 AI Tutor（SSE 流式）
 *
 *   知识库文档    GET  /api/tree              三级知识树（含已学/笔记/补全状态）
 *                GET  /api/doc?id=            知识点详情
 *                GET  /api/search?q=          语义检索（不调大模型）
 *                POST /api/note               保存笔记（自动保存）
 *                POST /api/learned            标记已学 / 取消
 *                POST /api/ask                知识点内 AI 答疑（SSE）
 *                POST /api/enrich             笔记 → AI 补全（SSE）
 *                POST /api/websearch          联网搜一下
 *                GET/DELETE /api/newknowledge 新知识列表 / 删除
 *
 *   刷题中心      GET  /api/quiz?id=         取已出的题
 *                POST /api/quiz/generate     生成 3 道单选题
 *                POST /api/quiz/submit       交卷（错题自动进错题本）
 *                GET/DELETE /api/wrong       错题本
 *
 *   API 实验      POST /api/playground       服务端真实发一次 HTTP 请求
 *
 *   任务日历      GET  /api/checkins?days=N  按天聚合的打卡记录
 *
 *   项目作品集    GET/POST/DELETE /api/portfolio
 *
 *   设置          GET/POST /api/settings     联网模式 / 搜索 Key / 自动补全
 *
 * 约定：所有接口都用相对路径，不写死 host，部署到公网后自动跟随当前域名。
 * ============================================================================= */

'use strict';

/* =============================================================================
 * 0. 基础工具
 * ============================================================================= */

const $ = s => document.querySelector(s);
const $$ = s => Array.prototype.slice.call(document.querySelectorAll(s));

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

// 统一的 JSON 接口：
//   成功 → 返回解析后的对象
//   失败 → 抛 Error（优先用后端给的 error 文案，比 HTTP 500 友好）
async function api(path, body, method) {
  const opt = { method: method || (body ? 'POST' : 'GET') };
  if (body) { opt.headers = { 'Content-Type': 'application/json' }; opt.body = JSON.stringify(body); }
  const r = await fetch(path, opt);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}

// SSE 流式接口：后端按 event: xx / data: {json} 分块推送
async function sse(path, body, on) {
  const r = await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    if (on.error) on.error({ message: 'HTTP ' + r.status + ' ' + t.slice(0, 300) });
    return;
  }
  const rd = r.body.getReader();
  const dec = new TextDecoder('utf-8');
  let buf = '';
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const blocks = buf.split('\n\n');
    buf = blocks.pop();
    for (const b of blocks) {
      const m = b.match(/^event: (.*)$/m);
      if (!m) continue;
      const dm = b.match(/^data: (.*)$/m);
      let data = {};
      try { data = dm ? JSON.parse(dm[1]) : {}; } catch (e) { /* 半包，忽略 */ }
      if (on[m[1]]) on[m[1]](data);
    }
  }
}

// 日期工具：后端统一用 ISO(UTC) 的 YYYY-MM-DD 做「天」的主键，
// 前端也一律用 UTC 口径，避免本地时区导致日历错一格。
const isoDay = v => (v instanceof Date ? v : new Date(v)).toISOString().slice(0, 10);
const todayKey = () => isoDay(new Date());
const shiftDay = (key, n) => isoDay(new Date(new Date(key + 'T00:00:00Z').getTime() + n * 86400000));

function fmtDay(key) {
  const d = new Date(key + 'T00:00:00Z');
  return (d.getUTCMonth() + 1) + '月' + d.getUTCDate() + '日';
}
function fmtWeekday(key) {
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(key + 'T00:00:00Z').getUTCDay()];
}
function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = n => String(n).padStart(2, '0');
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

// 段落渲染：把纯文本按空行/换行切成 <p>（不解析 markdown）
function proseHTML(t) {
  if (!t) return '';
  return String(t).split(/\n+/).map(p => p.trim()).filter(Boolean)
    .map(p => '<p>' + esc(p) + '</p>').join('');
}

// 轻量 markdown：AI 的回答里会带 # 标题、**加粗**、表格、列表
function inlineMd(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>');
}

function mdHTML(src) {
  if (!src) return '';
  const lines = esc(src).split('\n');
  const out = [];
  const isRow = l => /^\s*\|.*\|\s*$/.test(l);
  const isSep = l => /^\s*\|[\s:|-]+\|\s*$/.test(l);
  const cut = l => l.trim().replace(/^\||\|$/g, '').split('|').map(x => x.trim());
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    // 表格
    if (isRow(l) && i + 1 < lines.length && isSep(lines[i + 1])) {
      const head = cut(l);
      i += 2;
      const rows = [];
      while (i < lines.length && isRow(lines[i])) { rows.push(cut(lines[i])); i++; }
      out.push('<table class="md-table"><thead><tr>' + head.map(h => '<th>' + inlineMd(h) + '</th>').join('') +
        '</tr></thead><tbody>' + rows.map(r => '<tr>' + r.map(c => '<td>' + inlineMd(c) + '</td>').join('') + '</tr>').join('') +
        '</tbody></table>');
      continue;
    }
    // 标题
    const h = l.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lv = Math.min(6, h[1].length + 2);
      out.push('<h' + lv + ' class="md-h">' + inlineMd(h[2]) + '</h' + lv + '>');
      i++; continue;
    }
    // 分隔线
    if (/^\s*[-*_]{3,}\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
    // 列表
    if (/^\s*([-*+]|\d+\.)\s+/.test(l)) {
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, ''));
        i++;
      }
      out.push('<ul class="md-ul">' + items.map(x => '<li>' + inlineMd(x) + '</li>').join('') + '</ul>');
      continue;
    }
    // 引用
    if (/^\s*>\s?/.test(l)) {
      const q = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      out.push('<blockquote>' + inlineMd(q.join(' ')) + '</blockquote>');
      continue;
    }
    out.push('<p>' + inlineMd(l) + '</p>');
    i++;
  }
  return out.join('');
}

// 弹窗
function openModal(html) { $('#modalBox').innerHTML = html; $('#modal').classList.add('on'); }
function closeModal() { $('#modal').classList.remove('on'); }

/* =============================================================================
 * 1. 全局状态
 * ============================================================================= */

const S = {
  page: 'dashboard',

  // 知识库
  tree: [],
  byTitle: new Map(),   // 标题 → id（关联概念跳转）
  byId: new Map(),      // id → 树节点（就地改「有笔记」标记）
  currentId: null,
  doc: null,
  search: '',
  openGroups: new Set(),
  askHistory: [],       // 当前知识点下的连续追问上下文

  // 仪表盘
  stats: null,
  checkins: null,
  goal: null,
  tutor: { history: [], busy: false },

  // 其他页
  quiz: { id: null, qs: [], ans: {} },
  wrongTab: 'quiz',             // 刷题中心当前标签：quiz（客观题）/ subj（主观题）/ wrong（错题本）
  subj: {
    dir: 'prd',                 // prd（PRD 撰写类）| prompt（提示词优化类）
    docId: '', docTitle: '',
    question: '',               // 当前练习题正文
    idea: '',                   // 用户这一版思路
    round: 0,                   // 这是第几版思路（迭代次数）
    feedback: '',               // 当前这版的三段反馈原文
    lastIdea: '', lastFeedback: '',  // 上一版，用于让 AI 对比进步
    savedId: '',                // 已保存的练习记录 id
    cases: [],                  // 联网找到的真实案例
    history: [],                // 练习历史
    busy: false,
  },
  calDays: 60,
  portfolio: [],

  settings: {},
  code: 'Melodia',

  // 定时器
  noteTimer: null,
  autoEnrichTimer: null,
  lastEnrichedNote: '',
};

const GROUP_ICON = {
  '行业&业务认知': '🏢', '产品基础能力': '📋', 'AI专属技术知识': '🤖',
  'AI开发工具平台': '🛠️', '实操落地&求职': '🎯', 'Python编程基础（产品经理向）': '🐍',
  '实操从0到1全流程': '🚀', '智能体搭建': '🧩', '核心书目': '📚',
};
const markBadge = m => m === '🔴' ? '必须掌握' : m === '🟡' ? '需要理解' : m === '⚪' ? '只需了解' : '';

const KIND_LABEL = {
  learn: '标记已学', note: '写笔记', enrich: 'AI 补全', wrong: '错题',
  quiz: '刷题', newknowledge: '新知识', portfolio: '作品', goal: '目标',
};

/* =============================================================================
 * 2. 页面切换（左侧导航）
 * ============================================================================= */

// 每个页面第一次进入时按需加载数据，避免一次性打一堆接口
const PAGE_LOADED = {};

function go(page) {
  S.page = page;
  $$('.nav-item').forEach(b => b.classList.toggle('on', b.dataset.page === page));
  $$('.page').forEach(p => p.classList.toggle('on', p.id === 'page-' + page));
  closeDrawer();

  if (page === 'dashboard') loadDashboard();
  else if (page === 'knowledge') ensureTree();
  else if (page === 'practice') ensurePractice();
  else if (page === 'calendar') loadCalendar();
  else if (page === 'portfolio') loadPortfolio();
  else if (page === 'settings') loadSettings();

  // 记住上次停留的页面，刷新后不回到首页
  try { localStorage.setItem('aipm.page', page); } catch (e) {}
}

$$('.nav-item').forEach(b => { b.onclick = () => go(b.dataset.page); });

/* =============================================================================
 * 3. 手机端抽屉
 * ============================================================================= */

function openDrawer() {
  $('#sidebar').classList.add('open');
  $('#sideMask').classList.add('on');
}
function closeDrawer() {
  $('#sidebar').classList.remove('open');
  $('#sideMask').classList.remove('on');
}
$('#btnMenu').onclick = e => {
  e.stopPropagation();
  if ($('#sidebar').classList.contains('open')) closeDrawer(); else openDrawer();
};
$('#sideMask').onclick = closeDrawer;

// 从手机尺寸切回桌面时清掉抽屉状态：否则在手机上打开的抽屉 class 会残留下来
// （桌面态下 .open 没有样式，不会真的出错，但残留状态容易让后续判断变乱）
const mqPhone = window.matchMedia('(max-width:767px)');
function syncDrawer() { if (!mqPhone.matches) closeDrawer(); }
if (typeof mqPhone.addEventListener === 'function') mqPhone.addEventListener('change', syncDrawer);
else if (typeof mqPhone.addListener === 'function') mqPhone.addListener(syncDrawer);
window.addEventListener('orientationchange', () => setTimeout(syncDrawer, 200));

/* =============================================================================
 * 4. 仪表盘主页
 * ============================================================================= */

async function loadDashboard() {
  try {
    // 三个接口并行拉，任何一个挂了都不影响其它卡片出数
    // （迷你日历用 /api/stats 里的 recent 字段，不需要再单独请求 checkins；
    //   主观题练习次数要从「新知识」里按标签筛，所以额外拉一次）
    const [stats, goal, nk] = await Promise.all([
      api('/api/stats').catch(() => null),
      api('/api/goals').catch(() => null),
      api('/api/newknowledge').catch(() => null),
    ]);
    if (stats) {
      S.stats = stats;
      renderOverview(stats);
      renderGoal(stats, goal);
      renderPractices(stats, nk);
      renderPlan(stats);
      renderMiniCal(stats);
    }
    if (goal) S.goal = goal;
    renderSideStats(stats);
  } catch (e) {
    $('#ovNote').textContent = '数据加载失败：' + e.message;
  }
}

function renderOverview(st) {
  const t = st.today, tot = st.totals;
  $('#ovDate').textContent = fmtDay(t.date);
  $('#ovMinutes').textContent = t.minutes + 'm';
  $('#ovEvents').textContent = t.events;
  $('#ovDocs').textContent = t.docs;

  $('#ovEv2').textContent = t.events + ' 次';
  $('#ovMin2').textContent = t.minutes + ' 分钟';
  $('#ovLearned').textContent = tot.learned + ' / ' + tot.docs;
  $('#ovNoted').textContent = tot.noted + ' 条';
  $('#ovWrong').textContent = tot.wrong + ' 道';
  $('#ovNote').textContent = '时长为估算值：每个学习事件按 ' + t.perEventMinutes +
    ' 分钟折算，不是精确计时；累计活跃 ' + tot.activeDays + ' 天。';
  $('#ovStreak').textContent = '连续打卡 ' + tot.streak + ' 天';
}

function renderGoal(st, goalData) {
  const g = st.goal || {};
  const target = Math.max(1, Number(g.targetTasks) || 4);
  const done = Number(g.done) || 0;
  const pct = Math.max(0, Math.min(100, Math.round(done / target * 100)));

  // 环形进度：周长 = 2πr = 2π×50 ≈ 314.16
  const C = 314.16;
  $('#ringArc').setAttribute('stroke-dasharray', (C * pct / 100).toFixed(2) + ' ' + C.toFixed(2));
  $('#goalPct').textContent = String(pct);

  const custom = !!(goalData && goalData.text) || !!g.isCustom;
  $('#goalText').textContent = custom
    ? ((goalData && goalData.text) || g.text)
    : ('今天完成 ' + target + ' 个学习事件（学知识点 / 写笔记都算）');
  $('#goalHint').textContent = custom
    ? ('目标设定于 ' + (goalData && goalData.updatedAt ? fmtDateTime(goalData.updatedAt) : '较早前') +
       '，当前已完成 ' + done + ' / ' + target + ' 个事件')
    : '点右上角铅笔图标，写今天想完成什么';
  $('#goalCount').textContent = '已完成 ' + done + ' 项';
}

function renderPractices(st, nk) {
  const tot = st.totals;
  // 主观题练习记录存在「新知识」里，按标签筛出来（见 6.5 节的说明）
  const subjList = nk ? ((nk.items || []).filter(subjHasTag)) : null;
  const subjDocs = new Set();
  if (subjList) for (const x of subjList) if (x.from && x.from[0] && x.from[0].id) subjDocs.add(x.from[0].id);

  // 目标次数是「建议值」而不是接口数据：一周练 6 次主观题差不多能覆盖两类写法
  const SUBJ_TARGET = 6;
  const subjItem = {
    name: '主观题练习',
    pct: subjList ? Math.min(100, Math.round(subjList.length / SUBJ_TARGET * 100)) : 0,
    ref: subjList
      ? ('已练 ' + subjList.length + ' 次 · 覆盖 ' + subjDocs.size + ' 个知识点（建议 ' + SUBJ_TARGET + ' 次起）')
      : '练习记录读取失败，稍后刷新看看',
  };

  const items = [
    {
      name: '知识点学习', pct: tot.docs ? Math.round(tot.learned / tot.docs * 100) : 0,
      ref: '已标记已学 ' + tot.learned + ' / ' + tot.docs + ' 个知识点',
    },
    {
      name: '知识库刷题', pct: tot.docs ? Math.round(tot.quizDocs / tot.docs * 100) : 0,
      ref: '已出题 ' + tot.quizDocs + ' 个知识点 · 共 ' + tot.quizQuestions + ' 道题',
    },
    subjItem,
    {
      name: '错题复盘', pct: tot.quizQuestions ? Math.max(0, 100 - Math.round(tot.wrong / tot.quizQuestions * 100)) : 0,
      ref: tot.wrong ? ('还有 ' + tot.wrong + ' 道错题没消化') : '错题本是空的，继续保持',
    },
    {
      name: '笔记沉淀', pct: tot.learned ? Math.round(tot.noted / tot.learned * 100) : 0,
      ref: '写了 ' + tot.noted + ' 条笔记 · AI 补全 ' + tot.enrichEntries + ' 条',
    },
    {
      name: '项目作品集', pct: Math.min(100, Math.round(tot.portfolio / 3 * 100)),
      ref: '已攒 ' + tot.portfolio + ' 个作品（面试建议 3 个起）',
    },
  ];

  $('#practiceList').innerHTML = items.map(it => {
    const p = Math.max(0, Math.min(100, it.pct));
    // 配色跟着设计稿走：进行中=暖色渐变，已完成=灰蓝渐变，未开始=空槽
    const state = p >= 100 ? ' done' : (p ? '' : ' zero');
    return '<li class="practice-item"><div class="pi-main">' +
      '<div class="pi-top"><span class="pi-name"><span>' + esc(it.name) + '</span></span>' +
      '<span class="pi-pct' + (p >= 100 ? ' done' : '') + '">' + p + '%</span></div>' +
      '<div class="pi-ref">' + esc(it.ref) + '</div>' +
      '<div class="pi-bar"><div class="pi-fill' + state + '" style="width:' + p + '%"></div></div>' +
      '</div></li>';
  }).join('');
}

function renderPlan(st) {
  const plan = st.plan || {};
  $('#planPct').textContent = String(plan.overall || 0);
  $('#planBar').style.width = Math.min(100, plan.overall || 0) + '%';

  const learned = st.totals.learned, total = st.totals.docs;
  $('#planRight').innerHTML = '已学 <b>' + learned + '</b> / ' + total + ' 个知识点';

  $('#planStages').innerHTML = (plan.stages || []).map(s => {
    const pct = s.docs ? Math.round(s.learned / s.docs * 100) : 0;
    const done = s.docs && s.learned >= s.docs;
    return '<div><p class="ps-name">' + esc(s.name) + '</p>' +
      '<p class="ps-val' + (done ? ' done' : '') + '">' + s.learned + ' / ' + s.docs +
      ' <span class="muted">(' + pct + '%)</span></p></div>';
  }).join('');
}

function renderMiniCal(st) {
  $('#miniCal').innerHTML = (st.recent || []).map(d => {
    const e = d.events;
    const cls = 'mini-day' + (e ? ' has' : '') + (e >= 6 ? ' hot' : '');
    const dd = new Date(d.date + 'T00:00:00Z');
    return '<div class="' + cls + '" title="' + fmtDay(d.date) + '：' + e + ' 个事件">' +
      '<span class="d-n">' + dd.getUTCDate() + '</span>' +
      '<span class="d-e">' + (e ? e : '·') + '</span></div>';
  }).join('');
  const active = (st.recent || []).filter(d => d.events).length;
  $('#calTotal').textContent = '近 14 天活跃 ' + active + ' 天';
}

// 左侧栏底部的小统计（属于骨架，每次仪表盘刷新时同步）
function renderSideStats(st) {
  if (!st) return;
  $('#miniEvents').textContent = st.today.events;
  $('#miniStreak').textContent = st.totals.streak + ' 天';
  $('#miniProgress').textContent = (st.plan ? st.plan.overall : 0) + '%';
}

/* --------------------------- 今日目标：编辑 / 推荐 --------------------------- */

$('#btnEditGoal').onclick = async () => {
  let cur = S.goal;
  try { cur = await api('/api/goals'); } catch (e) {}
  const target = Number(cur && cur.targetTasks) || 4;
  openModal([
    '<h3>今天想完成什么</h3>',
    '<p class="desc">目标只影响仪表盘上的进度环，不写进知识库。事件口径：标记已学、写笔记、交卷、AI 补全各算 1 个。</p>',
    '<div class="field"><label>目标描述</label>',
    '<input type="text" id="goalInput" class="control" maxlength="200" placeholder="例如：学完 3 个认知启蒙的知识点，给其中 1 条写笔记" value="' + esc(cur && cur.text || '') + '"></div>',
    '<div class="field"><label>目标事件数（1-20）</label>',
    '<input type="number" id="goalTarget" class="control" min="1" max="20" value="' + target + '"></div>',
    '<div class="modal-actions">',
    '<button class="btn-line" id="goalCancel">取消</button>',
    '<button class="btn-line" id="goalSuggest">用推荐目标</button>',
    '<button class="btn-dark" id="goalSave">保存</button>',
    '</div>',
  ].join(''));
  $('#goalCancel').onclick = closeModal;
  $('#goalSuggest').onclick = () => {
    const s = suggestGoal();
    $('#goalInput').value = s.text;
    $('#goalTarget').value = s.targetTasks;
  };
  $('#goalSave').onclick = async () => {
    const text = $('#goalInput').value.trim();
    const tt = Math.min(20, Math.max(1, Number($('#goalTarget').value) || 4));
    try {
      await api('/api/goals', { text: text, targetTasks: tt });
      closeModal();
      const [stats, goal] = await Promise.all([api('/api/stats'), api('/api/goals').catch(() => null)]);
      S.stats = stats; S.goal = goal;
      renderGoal(stats, goal);
    } catch (e) { alert('保存失败：' + e.message); }
  };
};

// 推荐目标基于真实进度：挑当前完成率最低的那个阶段
function suggestGoal() {
  const st = S.stats;
  if (!st) return { text: '今天学 3 个知识点，给其中 1 条写笔记', targetTasks: 4 };
  const stages = (st.plan && st.plan.stages) || [];
  let worst = null;
  for (const s of stages) {
    if (!s.docs) continue;
    const r = s.learned / s.docs;
    if (!worst || r < worst.r) worst = { r: r, name: s.name, left: s.docs - s.learned };
  }
  if (!worst) return { text: '今天学 3 个知识点，给其中 1 条写笔记', targetTasks: 4 };
  const n = Math.min(3, Math.max(1, worst.left));
  return {
    text: '「' + worst.name + '」阶段还剩 ' + worst.left + ' 个知识点，今天先学 ' + n + ' 个，并给其中 1 条写笔记',
    targetTasks: n + 1,
  };
}

$('#btnGoalPreset').onclick = async () => {
  const s = suggestGoal();
  try {
    await api('/api/goals', { text: s.text, targetTasks: s.targetTasks });
    const [stats, goal] = await Promise.all([api('/api/stats'), api('/api/goals').catch(() => null)]);
    S.stats = stats; S.goal = goal;
    renderGoal(stats, goal);
  } catch (e) { alert('设置失败：' + e.message); }
};

/* ------------------------------- AI Tutor 卡片 ------------------------------- */

function tutorPush(role, text) {
  const el = document.createElement('div');
  el.className = 'tutor-msg ' + (role === 'me' ? 'me' : 'bot');
  el.textContent = text;
  $('#tutorBody').appendChild(el);
  $('#tutorBody').scrollTop = $('#tutorBody').scrollHeight;
  return el;
}

async function tutorSend(q) {
  q = String(q || '').trim();
  if (!q || S.tutor.busy) return;
  S.tutor.busy = true;
  $('#btnTutorSend').disabled = true;
  $('#tutorInput').value = '';
  tutorPush('me', q);

  const bot = tutorPush('bot', '正在检索知识库…');
  let text = '';
  let note = '';

  await sse('/api/chat', { question: q, history: S.tutor.history.slice(-6) }, {
    hits: hits => {
      if (!hits || !hits.length) { note = '（知识库没检索到直接相关的内容）'; return; }
      note = '参考：' + hits.slice(0, 3).map(h => h.title).join(' · ');
      bot.textContent = note + '\n\n正在生成回答…';
    },
    lowConfidence: a => {
      note = '（本地匹配度较低 ' + (a.topScore || 0).toFixed(2) + '，回答仅供参考）';
    },
    delta: d => { text += d.text; bot.textContent = (note ? note + '\n\n' : '') + text; $('#tutorBody').scrollTop = $('#tutorBody').scrollHeight; },
    error: e => { bot.textContent = '出错了：' + e.message; },
    done: () => {
      if (!text) bot.textContent = note || '（没有返回内容）';
      S.tutor.history.push({ role: 'user', content: q });
      S.tutor.history.push({ role: 'assistant', content: text || '(无内容)' });
      if (S.tutor.history.length > 12) S.tutor.history = S.tutor.history.slice(-12);
    },
  });

  S.tutor.busy = false;
  $('#btnTutorSend').disabled = false;
}

$('#btnTutorSend').onclick = () => tutorSend($('#tutorInput').value);
$('#tutorInput').onkeydown = e => { if (e.key === 'Enter') tutorSend($('#tutorInput').value); };
$$('#tutorChips .chip').forEach(c => { c.onclick = () => tutorSend(c.dataset.q || c.textContent); });

$('#btnGoPractice').onclick = () => go('practice');

// Upgrade 按钮：不做假付费墙，直接给「怎么部署到公网」的真实步骤
$('#btnUpgrade').onclick = () => {
  openModal([
    '<h3>把工作台部署到公网</h3>',
    '<p class="desc">这个工作台是<b>单文件 Node 后端 + 静态前端</b>，可以一键部署成公网地址，手机也能打开。</p>',
    '<div class="field"><label>需要准备的东西</label>',
    '<div class="tip" style="font-size:12.5px;line-height:2">' +
    '1. 一个 <b>DEEPSEEK_API_KEY</b>（必需，检索之外的功能都要它）<br>' +
    '2. 一个博查搜索 Key（可选，想要「自动联网」才需要）<br>' +
    '3. 一个 GitHub 账号（用 Render 部署时用来拉代码）</div></div>',
    '<div class="field"><label>部署步骤（Render，免费层）</label>',
    '<div class="tip" style="font-size:12.5px;line-height:2">' +
    '1. 把 mvp/ 目录推到 GitHub 仓库<br>' +
    '2. Render → New → Web Service → 选这个仓库<br>' +
    '3. 环境变量里加 <code>DEEPSEEK_API_KEY</code>（想统一发搜索 Key 再加 <code>SEARCH_API_KEY</code>）<br>' +
    '4. 部署完成后打开 Render 给的域名即可</div></div>',
    '<p class="tip">仓库里已经带了 <code>Dockerfile</code> 和 <code>render.yaml</code>，不需要你再写配置。</p>',
    '<div class="modal-actions"><button class="btn-dark" id="upClose">知道了</button></div>',
  ].join(''));
  $('#upClose').onclick = closeModal;
};

/* =============================================================================
 * 5. 知识库文档
 * ============================================================================= */

async function ensureTree() {
  if (S.tree.length) { renderSidebar(); return; }
  try {
    await refreshTree();
    initOpen();
    renderSidebar();
    fillQuizPick();
  } catch (e) {
    $('#tree').innerHTML = '<div class="empty">知识树加载失败：' + esc(e.message) + '</div>';
  }
}

async function refreshTree() {
  const t = await api('/api/tree');
  S.tree = t.tree || [];
  S.byTitle = new Map();
  S.byId = new Map();
  for (const g of S.tree) for (const s of g.sections) for (const i of s.items) {
    S.byTitle.set(i.title, i.id);
    S.byId.set(i.id, i);
  }
}

function renderSidebar() {
  const kw = S.search.trim().toLowerCase();
  let html = '';

  for (const g of S.tree) {
    const secs = g.sections.map(s => {
      let items = s.items;
      if (kw) items = items.filter(i => i.title.toLowerCase().includes(kw));
      if (!items.length) return null;
      return { s: s, items: items };
    }).filter(Boolean);
    if (!secs.length) continue;

    const gOpen = kw ? true : S.openGroups.has(g.group);
    html += '<div class="t-group" data-g="' + esc(g.group) + '">' +
      '<span class="caret' + (gOpen ? ' open' : '') + '">▶</span>' +
      '<span>' + (GROUP_ICON[g.group] || '📁') + '</span>' +
      '<span>' + esc(g.group) + '</span>' +
      '<span class="t-count">' + g.learned + '/' + g.count + '</span></div>';

    if (!gOpen) continue;
    for (const pair of secs) {
      const s = pair.s, items = pair.items;
      const sKey = g.group + '|' + s.section;
      const sOpen = kw ? true : S.openGroups.has(sKey);
      html += '<div class="t-sec" data-s="' + esc(sKey) + '">' +
        '<span class="caret' + (sOpen ? ' open' : '') + '">▶</span>' +
        '<span>' + esc(s.section) + '</span>' +
        '<span class="t-count">' + items.length + '</span></div>';
      if (!sOpen) continue;
      for (const it of items) {
        const flags = [];
        if (it.learned) flags.push('✓');
        if (it.hasNote) flags.push('✎');
        if (it.enrichCount) flags.push('+' + it.enrichCount);
        html += '<div class="t-leaf' + (it.id === S.currentId ? ' active' : '') + '" data-id="' + it.id + '">' +
          '<span class="dot"></span>' +
          '<span>' + esc(it.title) + '</span>' +
          '<span class="flags">' + flags.join(' ') + '</span></div>';
      }
    }
  }
  $('#tree').innerHTML = html || '<div class="empty">没找到匹配的知识点</div>';

  $$('#tree .t-group').forEach(el => { el.onclick = () => {
    const g = el.dataset.g;
    if (S.openGroups.has(g)) S.openGroups.delete(g); else S.openGroups.add(g);
    renderSidebar();
  }; });
  $$('#tree .t-sec').forEach(el => { el.onclick = ev => {
    ev.stopPropagation();
    const k = el.dataset.s;
    if (S.openGroups.has(k)) S.openGroups.delete(k); else S.openGroups.add(k);
    renderSidebar();
  }; });
  $$('#tree .t-leaf').forEach(el => { el.onclick = () => { openDoc(el.dataset.id); closeDrawer(); }; });

  const st = S.tree.reduce((a, g) => ({ t: a.t + g.count, l: a.l + g.learned }), { t: 0, l: 0 });
  $('#sbSub').innerHTML = '共 ' + st.t + ' 个知识点 · 已学 ' + st.l +
    '<br>红点=必须掌握 · ✓已学 · ✎有笔记 · +N有补充';
}

$('#treeSearch').oninput = e => { S.search = e.target.value; renderSidebar(); };

function initOpen() {
  S.tree.slice(0, 2).forEach(g => {
    S.openGroups.add(g.group);
    g.sections.slice(0, 2).forEach(s => S.openGroups.add(g.group + '|' + s.section));
  });
}

/* ------------------------------ 全局搜索 ------------------------------ */

$('#globalSearch').onkeydown = e => {
  if (e.key !== 'Enter') return;
  const q = e.target.value.trim();
  if (!q) return;
  go('knowledge');
  runGlobalSearch(q);
};

async function runGlobalSearch(q) {
  $('#kbMain').innerHTML = '<div class="empty">正在检索「' + esc(q) + '」…</div>';
  try {
    const r = await api('/api/search?q=' + encodeURIComponent(q));
    const hits = r.hits || [];
    const head = '<h1 class="title">检索：' + esc(q) + '</h1>' +
      '<div class="badges">' +
      '<span class="badge gray">' + esc(r.mode) + '</span>' +
      '<span class="badge gray">最高分 ' + (r.topScore || 0).toFixed(2) + '</span>' +
      '<span class="badge gray">召回 ' + hits.length + ' 段</span>' +
      (r.lowConfidence ? '<span class="badge">匹配度偏低，可能不是知识库里的内容</span>' : '') +
      '</div>';
    if (!hits.length) {
      $('#kbMain').innerHTML = head + '<div class="empty">没有召回到相关内容。<br>可以换个说法，或者用仪表盘的 AI Tutor 直接问。</div>';
      return;
    }
    $('#kbMain').innerHTML = head + hits.map(h =>
      '<div class="enrich-item" data-open="' + esc(h.id) + '" style="cursor:pointer">' +
      '<div class="hd"><span class="badge orange">' + (h.score || 0).toFixed(2) + '</span>' +
      '<span class="mini-tag">' + esc(h.book || '') + '</span>' +
      (h.section ? '<span class="mini-tag">' + esc(h.section) + '</span>' : '') +
      (h.viaRelated ? '<span class="mini-tag">关联跳转</span>' : '') + '</div>' +
      '<div class="q" style="margin-bottom:4px">' + esc(h.title) + '</div>' +
      '<div class="tip">语义相似度 ' + (h.sim == null ? '–' : h.sim.toFixed(3)) +
      ' · 关键词分 ' + (h.kw == null ? '–' : h.kw.toFixed(2)) + '</div>' +
      '</div>').join('');
    $$('#kbMain [data-open]').forEach(el => { el.onclick = () => openDoc(el.dataset.open); });
  } catch (e) {
    $('#kbMain').innerHTML = '<div class="empty">检索失败：' + esc(e.message) + '</div>';
  }
}

/* ------------------------------ 知识点详情 ------------------------------ */

async function openDoc(id) {
  if (!id) {
    $('#kbMain').innerHTML = '<div class="empty">👈 从左侧知识树里点开一个知识点<br>开始学习</div>';
    return;
  }
  S.currentId = id;
  renderSidebar();
  $('#kbMain').innerHTML = '<div class="empty">加载中…</div>';
  let d;
  try { d = await api('/api/doc?id=' + encodeURIComponent(id)); }
  catch (e) { $('#kbMain').innerHTML = '<div class="empty">读取失败：' + esc(e.message) + '</div>'; return; }
  S.doc = d;
  renderDetail(d);
}

function renderDetail(d) {
  const crumb = (d.breadcrumb || []).map(c => '<span>' + esc(c) + '</span><i>›</i>').join('') +
    '<span>' + esc(d.title) + '</span>';

  const lv = d.levelN || markBadge(d.mark);
  const lvClass = (d.mark === '🔴' || lv === '必须掌握') ? '' : (d.mark === '🟡' ? 'orange' : 'gray');

  const body = d.explain || d.content || '';
  const related = (d.related || []).filter(t => S.byTitle.has(t));
  const faqOptions = (d.faqs || []).map((f, i) => '<option value="' + i + '">' + esc(f.q) + '</option>').join('');

  const enrich = (d.enrich || []).map(e =>
    '<div class="enrich-item"><div class="hd">' +
    '<span class="badge">' + (e.kind === 'note-web' ? 'AI 补全 · 含联网' : 'AI 补全') + '</span>' +
    '<span class="muted">' + fmtDateTime(e.at) + '</span></div>' +
    '<div class="bd">' + proseHTML(e.text || '') + '</div>' +
    ((e.refs && e.refs.length) ? '<div class="refs">来源：' + e.refs.map(r =>
      '<a href="' + esc(r.url) + '" target="_blank" rel="noreferrer">' + esc(r.title || r.url) + '</a>').join(' · ') + '</div>' : '') +
    '</div>').join('');

  $('#kbMain').innerHTML = [
    '<div class="crumb">' + crumb + '</div>',
    '<h1 class="title">' + esc(d.title) + '</h1>',
    d.en ? '<div class="en-title">' + esc(d.en) + '</div>' : '',
    '<div class="badges">',
    lv ? '<span class="badge ' + lvClass + '">' + esc(lv) + '</span>' : '',
    d.section ? '<span class="badge gray">' + esc(d.section) + '</span>' : '',
    d.learned ? '<span class="badge gray">✓ 已学</span>' : '',
    '</div>',

    '<h3 class="sec">概念解释</h3>',
    '<div class="prose">' + (proseHTML(body) || '<p>这条还没有内容。</p>') + '</div>',
    d.explain ? '' : '<p class="tip">当前这条只有一句大纲注释，还没做内容扩写。可以在下面写点笔记，然后用 AI 补全。</p>',

    ((d.keys && d.keys.length)
      ? '<h3 class="sec">核心要点</h3><ul class="keypoints">' + d.keys.map(k => '<li>' + esc(k) + '</li>').join('') + '</ul>'
      : (d.keypoints && d.keypoints.length
        ? '<h3 class="sec">核心要点</h3><ul class="keypoints">' + d.keypoints.map(k => '<li>' + esc(k) + '</li>').join('') + '</ul>'
        : '')),

    (d.scenario ? '<h3 class="sec">应用场景</h3><div class="prose">' + (proseHTML(d.scenario) || '<p>' + esc(d.scenario) + '</p>') + '</div>' +
      (d.bookRefHint ? '<p class="tip">可能相关的书籍章节（待核对，未验证）：' + esc(d.bookRefHint) + '</p>' : '') : ''),

    '<h3 class="sec">关联概念</h3>',
    related.length
      ? '<div class="chips">' + related.map(t => '<button class="chip" data-title="' + esc(t) + '">' + esc(t) + '</button>').join('') + '</div>'
      : '<p class="tip">这条暂时没有关联概念。</p>',

    '<div class="row between" style="margin:28px 0 12px">',
    '<h3 class="sec" style="margin:0">AI 答疑</h3>',
    '<span class="web-badge" id="webHint">🧠 自动判断是否联网</span>',
    '</div>',
    faqOptions ? '<select class="qa-select" id="faqSel"><option value="">— 选一个常见问题，AI 直接答 —</option>' + faqOptions + '</select>' : '',
    '<div class="ask-row">',
    '<input type="text" id="askInput" placeholder="也可以自己问，比如：这个在实际工作里怎么用？">',
    '<button class="btn-dark btn-sm" id="btnAsk">提问</button>',
    '</div>',
    '<div id="askOut"></div>',

    '<div class="row between" style="margin:28px 0 12px">',
    '<h3 class="sec" style="margin:0">我的笔记</h3>',
    '<span class="web-badge">✨ 记完自动补全，需要时会自己联网</span>',
    '</div>',
    '<textarea class="note" id="noteBox" placeholder="在这里记录你的学习笔记，会自动保存…">' + esc(d.note) + '</textarea>',
    '<div class="note-bar">',
    '<button class="btn-dark" id="btnEnrich">✨ 用 AI 补全这条知识</button>',
    '<button class="btn-line btn-sm" id="btnWeb">🌐 联网搜一下</button>',
    '<button class="btn-line btn-sm" id="btnNewList">📥 我的新知识</button>',
    '<span class="saved" id="savedTip"></span>',
    '</div>',
    '<div id="enrichOut"></div>',
    enrich ? '<h3 class="sec">我的补充知识</h3>' + enrich : '',

    (d.sources && d.sources.length ? '<p class="src">📚 信息来源：' + d.sources.map(s => '<span>' + esc(s) + '</span>').join(' · ') + '</p>' : ''),

    '<div class="row" style="margin-top:28px;gap:12px;flex-wrap:wrap">',
    '<button class="' + (d.learned ? 'btn-line' : 'btn-dark') + '" id="btnLearned">' +
      (d.learned ? '✓ 已学（点击取消）' : '+ 标记已学') + '</button>',
    '<button class="btn-line btn-sm" id="btnQuiz">去刷这个知识点的题 →</button>',
    '<button class="btn-line btn-sm" id="btnToPortfolio">收进作品集 →</button>',
    '</div>',
  ].join('');

  $$('#kbMain .chip[data-title]').forEach(c => { c.onclick = () => {
    const it = S.byTitle.get(c.dataset.title);
    if (it) openDoc(it);
  }; });

  // ---- 笔记：停笔 0.9 秒自动保存；开了「自动补全」再等 3 秒叫 AI 扩写 ----
  const box = $('#noteBox');
  box.oninput = () => {
    $('#savedTip').textContent = '正在输入…';
    clearTimeout(S.noteTimer);
    S.noteTimer = setTimeout(async () => {
      try {
        await api('/api/note', { id: d.id, text: box.value });
        const t = new Date();
        $('#savedTip').textContent = '已保存 ' + String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
        const item = S.byId.get(d.id);
        if (item) { item.hasNote = !!box.value.trim(); renderSidebar(); }

        if (S.settings && S.settings.autoEnrich !== false && box.value.trim().length >= 8) {
          $('#savedTip').textContent += ' · 稍后自动补全';
          clearTimeout(S.autoEnrichTimer);
          S.autoEnrichTimer = setTimeout(() => runEnrich(true), 3000);
        }
      } catch (e) { $('#savedTip').textContent = '保存失败：' + e.message; }
    }, 900);
  };

  // ---- 标记已学 ----
  $('#btnLearned').onclick = async () => {
    try {
      await api('/api/learned', { id: d.id, on: !d.learned });
      await refreshTree();
      renderSidebar();
      openDoc(d.id);
    } catch (e) { alert('操作失败：' + e.message); }
  };

  // ---- 去刷题 ----
  $('#btnQuiz').onclick = () => {
    S.quiz.id = d.id; S.quiz.qs = []; S.quiz.ans = {};
    setPracticeTab('quiz');
    go('practice');
    const sel = $('#quizPick');
    if (sel) sel.value = d.id;
    loadQuiz();
  };

  // ---- 收进作品集 ----
  $('#btnToPortfolio').onclick = () => {
    go('portfolio');
    setTimeout(() => openPortfolioModal({ docId: d.id, docTitle: d.title, title: d.title + ' · 学习作品' }), 60);
  };

  $('#btnNewList').onclick = () => showNewKnowledgeList();

  // ---- AI 答疑 ----
  const doAsk = async q => {
    if (!q || !q.trim()) return;
    const out = $('#askOut');
    out.innerHTML = '<div class="qa-answer md" id="qaBody">思考中…</div>';
    let text = '';
    const hint0 = $('#webHint');
    if (hint0) { hint0.textContent = '🧠 正在判断要不要联网…'; hint0.className = 'web-badge'; }
    await sse('/api/ask', { id: d.id, question: q, history: S.askHistory || [] }, {
      webdecide: a => {
        const h = $('#webHint');
        if (h) {
          h.textContent = a.need ? ('🌐 已自动联网 · ' + (a.reason || '')) : ('🧠 本地知识库已够用 · ' + (a.reason || ''));
          h.className = 'web-badge' + (a.need ? ' on' : '');
        }
      },
      status: a => { out.insertAdjacentHTML('afterbegin', '<p class="tip">' + esc(a.text) + '</p>'); },
      web: w => {
        out.insertAdjacentHTML('afterbegin',
          '<div class="enrich-item"><div class="hd"><span class="badge gray">联网结果</span></div><div class="refs">' +
          w.map(x => '<div><a href="' + esc(x.url) + '" target="_blank" rel="noreferrer">' + esc(x.title) + '</a>' +
            (x.site ? ' <span class="muted">' + esc(x.site) + '</span>' : '') + '</div>').join('') +
          '</div></div>');
      },
      delta: a => {
        text += a.text;
        const el = $('#qaBody');
        if (el) el.innerHTML = mdHTML(text);
      },
      error: a => { out.innerHTML = '<div class="qa-answer">' + esc(a.message) + '</div>'; },
    });
    const el = $('#qaBody');
    if (!text && el) el.textContent = '（没有返回内容）';
    // 连续追问用：把这一轮问答带进下一次请求
    if (text) {
      S.askHistory = (S.askHistory || []).concat([
        { role: 'user', content: q }, { role: 'assistant', content: text },
      ]).slice(-6);
    }
  };

  if ($('#faqSel')) $('#faqSel').onchange = e => {
    const i = e.target.value;
    if (i === '') return;
    doAsk(d.faqs[Number(i)].q);
  };
  $('#btnAsk').onclick = () => doAsk($('#askInput').value);
  $('#askInput').onkeydown = e => { if (e.key === 'Enter') doAsk($('#askInput').value); };

  // ---- 笔记 → AI 补全 ----
  async function runEnrich(auto) {
    // 自动触发时可能已经翻页了，元素不在 DOM 里 —— 直接退出，别在后台白烧 API
    const out = $('#enrichOut');
    const nbox = $('#noteBox');
    if (!out || !nbox) return;
    if (S.currentId !== d.id) return;

    const note = nbox.value.trim();
    if (!note) {
      if (!auto) { alert('先在这条知识点下面写点笔记，再让 AI 补全。'); nbox.focus(); }
      return;
    }
    if (auto && note === S.lastEnrichedNote) return;
    S.lastEnrichedNote = note;

    const steps = [];
    out.innerHTML = '<ul class="status-list" id="stList"></ul>';
    const draw = () => {
      const el = $('#stList');
      if (el) el.innerHTML = steps.map(s => '<li><span class="ic">' + s.ic + '</span><span>' + esc(s.t) + '</span></li>').join('');
    };
    const btn = $('#btnEnrich');
    if (btn) btn.disabled = true;

    await sse('/api/enrich', { id: d.id, note: note }, {
      webdecide: a => { steps.push({ ic: a.need ? '🌐' : '🧠', t: a.need ? ('自动联网：' + (a.reason || '')) : '本地知识库够用，先不联网' }); draw(); },
      status: a => { steps.push({ ic: '⏳', t: a.text }); draw(); },
      web: w => { steps.push({ ic: '🌐', t: '联网找到 ' + w.length + ' 条参考' }); draw(); },
      error: a => { steps.push({ ic: '❌', t: a.message }); draw(); },
      done: async a => {
        steps.push({ ic: '✅', t: '已写入「我的补充知识」，并同步进「新知识」' });
        draw();
        out.insertAdjacentHTML('beforeend',
          '<div class="enrich-item"><div class="hd"><span class="badge">' + esc(a.newKnowledge.title) + '</span></div>' +
          '<div class="bd">' + proseHTML(a.newKnowledge.content) + '</div>' +
          ((a.newKnowledge.refs || []).length ? '<div class="refs">来源：' + a.newKnowledge.refs.map(r =>
            '<a href="' + esc(r.url) + '" target="_blank" rel="noreferrer">' + esc(r.title || r.url) + '</a>').join(' · ') + '</div>' : '') +
          '</div>');
        await refreshTree();
        renderSidebar();
      },
    });
    const btnEnd = $('#btnEnrich');
    if (btnEnd) btnEnd.disabled = false;
  }
  $('#btnEnrich').onclick = () => runEnrich(false);

  // ---- 联网搜一下（不调大模型，只是把搜索结果列出来） ----
  $('#btnWeb').onclick = async () => {
    const out = $('#enrichOut');
    out.innerHTML = '<p class="tip">正在联网搜集…</p>';
    try {
      const r = await api('/api/websearch', { query: d.title + ' 是什么 怎么用', count: 5 });
      out.innerHTML = '<div class="enrich-item">' +
        '<div class="hd"><span class="badge gray">联网结果 · ' + r.count + ' 条</span></div>' +
        r.items.map(x => '<div style="margin-bottom:11px">' +
          '<a href="' + esc(x.url) + '" target="_blank" rel="noreferrer" class="pf-link" style="font-size:13.5px;font-weight:600">' + esc(x.title) + '</a>' +
          '<div class="muted" style="margin:3px 0;font-size:12px">' + esc(x.site || '') + (x.date ? ' · ' + esc(x.date) : '') + '</div>' +
          '<div style="font-size:13px;line-height:1.8">' + esc((x.snippet || '').slice(0, 260)) + '</div></div>').join('') +
        '</div>';
    } catch (e) {
      out.innerHTML = '<p class="tip">联网失败：' + esc(e.message) + '（到「设置」里配一下搜索 API Key 就能用了）</p>';
    }
  };
}

/* --------------------------- 新知识（弹窗形式） --------------------------- */

async function showNewKnowledgeList() {
  let items = [];
  try { items = (await api('/api/newknowledge')).items || []; } catch (e) {}

  // 主观题练习记录也放在这个 store 里（见 6.5 节的设计说明），
  // 但它在「练习历史」里已经有一份更合适的展示，这里单独分组，避免把补全知识挤下去
  const subjRecords = items.filter(subjHasTag);
  const knowledge = items.filter(n => !subjHasTag(n));

  const card = (n) => '<div class="enrich-item" style="margin-bottom:10px">' +
    '<div class="hd"><span class="badge">' + esc(n.title) + '</span>' +
    '<span class="mini-tag">' + (n.kind === 'manual' ? '手动记录' : (n.kind === 'note-web' ? 'AI 补全·含联网' : 'AI 补全')) + '</span>' +
    '<span class="muted">' + fmtDateTime(n.at) + '</span>' +
    '<button class="btn-line btn-sm" data-nkdel="' + esc(n.id) + '" style="margin-left:auto;height:30px;padding:0 12px">删除</button></div>' +
    (n.summary ? '<p class="tip">' + esc(n.summary) + '</p>' : '') +
    '<div class="bd">' + proseHTML(n.content) + '</div>' +
    ((n.refs || []).length ? '<div class="refs">来源：' + n.refs.map(x =>
      '<a href="' + esc(x.url) + '" target="_blank" rel="noreferrer">' + esc(x.title || x.url) + '</a>').join(' · ') + '</div>' : '') +
    '</div>';

  openModal([
    '<h3>我的新知识</h3>',
    '<p class="desc">从笔记里长出来的补充知识共 <b>' + knowledge.length + '</b> 条，' +
    '另有 <b>' + subjRecords.length + '</b> 条主观题练习记录（在「刷题中心 → 主观题」的练习历史里查看）。它们会一起参与检索。</p>',
    knowledge.length ? knowledge.map(card).join('')
      : '<div class="empty">还没有补充知识<br>在知识点里写笔记 → 点「用 AI 补全这条知识」<br>补全的内容会汇总到这里</div>',
    subjRecords.length
      ? '<p class="code-sub" style="margin-top:16px">主观题练习记录（' + subjRecords.length + ' 条 · 只列标题，正文在练习历史里）</p>' +
        subjRecords.map(n => '<div class="kv" style="margin-bottom:4px"><b>' + esc(n.title.replace('主观题练习 · ', '')) + '</b>' +
          '<span>' + fmtDateTime(n.at) + '</span>' +
          '<button class="link-btn" data-nkdel="' + esc(n.id) + '" style="margin-left:auto">删除</button></div>').join('')
      : '',
    '<div class="modal-actions">',
    '<button class="btn-line" id="nkAdd">＋ 手动记一条</button>',
    '<button class="btn-dark" id="nkClose">关闭</button>',
    '</div>',
  ].join(''));

  $$('#modalBox [data-nkdel]').forEach(b => { b.onclick = async () => {
    if (!confirm('删除这条新知识？同时会从对应知识点下移除。')) return;
    await api('/api/newknowledge?id=' + encodeURIComponent(b.dataset.nkdel), null, 'DELETE');
    showNewKnowledgeList();
  }; });
  $('#nkClose').onclick = closeModal;
  $('#nkAdd').onclick = () => {
    openModal([
      '<h3>手动记一条新知识</h3>',
      '<p class="desc">直接写进你的个人知识库，会参与后续检索。</p>',
      '<div class="field"><label>标题</label><input type="text" id="nkTitle" class="control" maxlength="80"></div>',
      '<div class="field"><label>内容</label><textarea id="nkContent" class="control" rows="6"></textarea></div>',
      '<div class="field"><label>标签（逗号分隔，可选）</label><input type="text" id="nkTags" class="control"></div>',
      '<div class="modal-actions"><button class="btn-line" id="nkCancel">取消</button>' +
      '<button class="btn-dark" id="nkSave">保存</button></div>',
    ].join(''));
    $('#nkCancel').onclick = closeModal;
    $('#nkSave').onclick = async () => {
      const title = $('#nkTitle').value.trim();
      const content = $('#nkContent').value.trim();
      if (!title || !content) { alert('标题和内容都不能为空'); return; }
      const tags = $('#nkTags').value.split(/[,，]/).map(x => x.trim()).filter(Boolean).slice(0, 5);
      try {
        await api('/api/newknowledge', { title: title, content: content, tags: tags });
        showNewKnowledgeList();
      } catch (e) { alert('保存失败：' + e.message); }
    };
  };
}

/* =============================================================================
 * 6. 刷题中心（刷题 + 错题本）
 * ============================================================================= */

function ensurePractice() {
  if (!S.tree.length) {
    ensureTree().then(() => { fillQuizPick(); fillSubjDoc(); if (S.quiz.id) loadQuiz(); });
  } else {
    fillQuizPick();
    fillSubjDoc();
    if (S.quiz.id) loadQuiz();
  }
  if (S.wrongTab === 'wrong') renderWrong();
  if (S.wrongTab === 'subj') { fillSubjDoc(); loadSubjHistory(); }
}

// 标签栏只有一行：客观题（quiz）/ 主观题（subj）/ 错题本（wrong）。
// 三个面板是并列的兄弟节点，谁被选中就显示谁 —— 不再有「二级模式」这一层，
// 所以也就不需要「切到错题本要先把模式切回客观题」这种联动。
function setPracticeTab(tab) {
  S.wrongTab = tab;
  $$('#practiceSeg .seg-item').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  $('#quizPane').classList.toggle('hidden', tab !== 'quiz');
  $('#subjectiveWrap').classList.toggle('hidden', tab !== 'subj');
  $('#wrongPane').classList.toggle('hidden', tab !== 'wrong');

  if (tab === 'subj') { fillSubjDoc(); loadSubjHistory(); }
  if (tab === 'wrong') renderWrong();
}
$$('#practiceSeg .seg-item').forEach(b => { b.onclick = () => setPracticeTab(b.dataset.tab); });

function fillQuizPick() {
  const sel = $('#quizPick');
  if (!sel || !S.tree.length) return;
  const all = [];
  for (const g of S.tree) for (const s of g.sections) for (const i of s.items) all.push({ id: i.id, title: i.title, group: g.group });
  sel.innerHTML = '<option value="">— 先选一个知识点 —</option>' + all.map(i =>
    '<option value="' + i.id + '"' + (i.id === S.quiz.id ? ' selected' : '') + '>' +
    esc(i.group + ' › ' + i.title) + '</option>').join('');
}

$('#quizPick').onchange = e => { S.quiz.id = e.target.value; S.quiz.qs = []; S.quiz.ans = {}; loadQuiz(); };
$('#btnGen').onclick = genQuiz;
$('#btnSubmit').onclick = submitQuiz;

async function loadQuiz() {
  if (!S.quiz.id) {
    $('#quizBody').innerHTML = '<div class="card"><div class="empty">先在上面选一个知识点，再点「生成 3 道题」</div></div>';
    $('#quizResult').innerHTML = '';
    return;
  }
  $('#quizBody').innerHTML = '<div class="card"><div class="empty">加载中…</div></div>';
  try {
    const r = await api('/api/quiz?id=' + encodeURIComponent(S.quiz.id));
    S.quiz.qs = r.questions || [];
    S.quiz.ans = {};
    if (!S.quiz.qs.length) {
      $('#quizBody').innerHTML = '<div class="card"><div class="empty">这个知识点还没出过题<br>点右上角「生成 3 道题」</div></div>';
      $('#quizTip').textContent = '';
      return;
    }
    renderQuizBody();
  } catch (e) {
    $('#quizBody').innerHTML = '<div class="card"><div class="empty">失败：' + esc(e.message) + '</div></div>';
  }
}

async function genQuiz() {
  if (!S.quiz.id) { alert('先选一个知识点'); return; }
  $('#quizBody').innerHTML = '<div class="card"><div class="empty">正在出题，约 10-20 秒…</div></div>';
  $('#quizResult').innerHTML = '';
  $('#quizTip').textContent = 'AI 正在出题…';
  $('#btnGen').disabled = true;
  try {
    const r = await api('/api/quiz/generate', { id: S.quiz.id });
    S.quiz.qs = r.questions; S.quiz.ans = {};
    renderQuizBody();
    $('#quizTip').textContent = '已生成 ' + r.questions.length + ' 道题';
  } catch (e) {
    $('#quizBody').innerHTML = '<div class="card"><div class="empty">出题失败：' + esc(e.message) + '</div></div>';
    $('#quizTip').textContent = '';
  }
  $('#btnGen').disabled = false;
}

function renderQuizBody() {
  $('#quizBody').innerHTML = S.quiz.qs.map((q, qi) =>
    '<div class="card" data-qi="' + qi + '" style="margin-bottom:16px">' +
    '<div class="q">' + (qi + 1) + '. ' + esc(q.q) + '</div>' +
    q.options.map((o, oi) => '<div class="opt" data-qi="' + qi + '" data-oi="' + oi + '">' +
      '<span class="idx">' + ('ABCD'[oi] || (oi + 1)) + '</span><span>' + esc(o) + '</span></div>').join('') +
    '</div>').join('');
  $('#quizResult').innerHTML = '';
  $('#btnSubmit').disabled = false;
  $('#quizTip').textContent = '已作答 0/' + S.quiz.qs.length;

  $$('#quizBody .opt').forEach(el => { el.onclick = () => {
    const qi = Number(el.dataset.qi);
    S.quiz.ans[qi] = Number(el.dataset.oi);
    el.parentNode.querySelectorAll('.opt').forEach(o => o.classList.remove('sel'));
    el.classList.add('sel');
    $('#quizTip').textContent = '已作答 ' + Object.keys(S.quiz.ans).length + '/' + S.quiz.qs.length;
  }; });
}

async function submitQuiz() {
  if (!S.quiz.qs.length) { alert('这个知识点还没有题目，先点「生成 3 道题」'); return; }
  const answers = Object.keys(S.quiz.ans).map(k => ({ qi: Number(k), chosen: S.quiz.ans[k] }));
  if (answers.length < S.quiz.qs.length && !confirm('还有题没作答，确定交卷？')) return;
  try {
    const r = await api('/api/quiz/submit', { id: S.quiz.id, answers: answers });
    $('#quizResult').innerHTML = '<div class="score-box"><div class="n">' + r.score + ' / ' + r.total +
      '</div><div class="l">' + (r.score === r.total ? '全对，这条知识点可以标记已学了' : '错的题已经进错题本') + '</div></div>';
    r.detail.forEach((d, qi) => {
      const card = $('#quizBody').querySelector('.card[data-qi="' + qi + '"]');
      if (!card) return;
      card.querySelectorAll('.opt').forEach(o => {
        const oi = Number(o.dataset.oi);
        o.classList.remove('sel');
        if (oi === d.answer) o.classList.add('right');
        else if (oi === d.chosen) o.classList.add('wrong');
      });
      card.insertAdjacentHTML('beforeend', '<div class="explain"><b>解析：</b>' + esc(d.explain) + '</div>');
    });
    $('#btnSubmit').disabled = true;
    $('#quizTip').textContent = '本次得分 ' + r.score + '/' + r.total;
  } catch (e) { alert('交卷失败：' + e.message); }
}

/* ------------------------------- 错题本 ------------------------------- */

async function renderWrong() {
  const pane = $('#wrongPane');
  pane.innerHTML = '<div class="card"><div class="empty">加载中…</div></div>';
  let items = [];
  try { items = (await api('/api/wrong')).items || []; }
  catch (e) { pane.innerHTML = '<div class="card"><div class="empty">加载失败：' + esc(e.message) + '</div></div>'; return; }

  const head = '<div class="row between" style="margin-bottom:16px;flex-wrap:wrap;gap:10px">' +
    '<div><h1 class="title" style="margin:0;font-size:20px">错题本</h1>' +
    '<p class="tip" style="margin-top:4px">共 ' + items.length + ' 道错题</p></div>' +
    (items.length ? '<button class="btn-line btn-sm" id="btnClearWrong">清空</button>' : '') + '</div>';

  const body = items.length ? items.map(w =>
    '<div class="card" style="margin-bottom:16px">' +
    '<div class="q">' + esc(w.q) + '</div>' +
    (w.options || []).map((o, oi) => '<div class="opt ' + (oi === w.answer ? 'right' : (oi === w.chosen ? 'wrong' : '')) + '">' +
      '<span class="idx">' + ('ABCD'[oi] || (oi + 1)) + '</span><span>' + esc(o) + '</span></div>').join('') +
    '<div class="explain"><b>解析：</b>' + esc(w.explain || '') + '</div>' +
    '<div class="row between" style="margin-top:12px;flex-wrap:wrap;gap:8px">' +
    '<span class="muted" style="font-size:12px">来自知识点：' +
    '<a href="javascript:;" data-doc="' + esc(w.docId) + '" style="color:var(--orange)">' + esc(w.docTitle || w.docId) + '</a>' +
    ' · ' + fmtDateTime(w.at) + '</span>' +
    '<button class="btn-line btn-sm" data-del="' + esc(w.id) + '">移除</button></div></div>').join('')
    : '<div class="card"><div class="empty">还没有错题<br>去「刷题中心」做几道题就有了</div></div>';

  pane.innerHTML = head + body;

  $$('#wrongPane [data-doc]').forEach(a => { a.onclick = () => { go('knowledge'); openDoc(a.dataset.doc); }; });
  $$('#wrongPane [data-del]').forEach(b => { b.onclick = async () => {
    await api('/api/wrong?id=' + encodeURIComponent(b.dataset.del), null, 'DELETE');
    renderWrong();
  }; });
  if ($('#btnClearWrong')) $('#btnClearWrong').onclick = async () => {
    if (!confirm('确定清空全部错题？')) return;
    await api('/api/wrong?id=all', null, 'DELETE');
    renderWrong();
  };
}

/* =============================================================================
 * 6.5 主观题练习（PRD 撰写 / 提示词优化）
 * -----------------------------------------------------------------------------
 * 定位：客观题练「判断」，主观题练「写法」——练习 → 反馈 → 迭代。
 *
 * ⚠️ 本模块**没有新增任何后端接口**，全部复用现有能力：
 *     POST /api/ask          出题 + 三段反馈（SSE 流式；带 id 时会把该知识点的
 *                            解释作为参考资料，并自动判断要不要联网）
 *     POST /api/websearch    单独查真实行业案例（不调大模型）
 *     GET  /api/newknowledge 读取练习历史
 *     POST /api/newknowledge 自动保存一条练习记录
 *     DELETE /api/newknowledge?id=  删除某条练习记录
 *
 * 为什么练习记录存在「新知识」store 里：
 *   服务端可写的 store 中，只有 newknowledge 同时满足「长正文 + 关联知识点 + 可删除」。
 *   （notes 每个知识点只有一条正文，存进去会覆盖用户自己的笔记；
 *     portfolio 的 summary 限 600 字，装不下三段反馈。）
 *   好处：保存时会被服务端的活动流自动记为一条学习事件（kind=newknowledge），
 *         于是练习次数能同步进仪表盘的今日事件 / 估算时长 / 连续打卡。
 *   代价（已实测确认，不是猜测）：练习记录会被 searchExtraKnowledge 当作
 *         「我的新知识」塞进后续 AI 答疑的参考材料里。记录标题以「主观题练习 · 」开头，
 *         所以模型能识别出它是练习记录；实测中它甚至会主动说明「参考资料里混进了一份
 *         别的场景的 PRD」，并不会照抄。影响范围由服务端限制在得分最高的 2 条以内。
 * ========================================================================== */

const SUBJ_DIR = {
  prd: {
    label: 'PRD 撰写类',
    hint: '围绕产品知识点出真实业务场景题，练的是「一份 PRD 该按什么结构把问题讲清楚」。',
  },
  prompt: {
    label: '提示词优化类',
    hint: '给出具体需求场景，练的是「一段提示词怎么写才能让模型稳定产出对的结果」。',
  },
};
const SUBJ_TAG = '主观题练习';

const subjHasTag = x => !!(x && Array.isArray(x.tags) && x.tags.indexOf(SUBJ_TAG) >= 0);

// 属性选择器里的值做一下转义（id 是服务端生成的随机串，不赌它一定安全）
const cssEsc = v => String(v).replace(/["\\]/g, '\\$&');

function subjStep(n, allDone) {
  $$('#subjSteps .step').forEach(el => {
    const s = Number(el.dataset.step);
    el.classList.toggle('on', s === n);
    el.classList.toggle('done', allDone ? true : s < n);
  });
}

function subjSetDir(dir) {
  if (!SUBJ_DIR[dir]) return;
  S.subj.dir = dir;
  $$('#subjDir .chip').forEach(c => c.classList.toggle('on', c.dataset.dir === dir));
  $('#subjDirTag').textContent = SUBJ_DIR[dir].label;
  $('#subjDirHint').textContent = SUBJ_DIR[dir].hint;
}
$$('#subjDir .chip').forEach(c => { c.onclick = () => subjSetDir(c.dataset.dir); });

function fillSubjDoc() {
  const sel = $('#subjDoc');
  if (!sel) return;
  if (!S.tree.length) { sel.innerHTML = '<option value="">（知识树还没加载）</option>'; return; }
  const opts = [];
  for (const g of S.tree) for (const s of g.sections) for (const i of s.items) {
    opts.push({ id: i.id, title: i.title, group: g.group, expanded: !!i.expanded });
  }
  // 有长解释的知识点更适合出主观题（题目能挂在真实内容上），排前面
  opts.sort((a, b) => (b.expanded ? 1 : 0) - (a.expanded ? 1 : 0));
  const keep = S.subj.docId || opts[0].id;
  sel.innerHTML = opts.map(o => '<option value="' + o.id + '"' + (o.id === keep ? ' selected' : '') + '>' +
    esc(o.group + ' › ' + o.title) + '</option>').join('');
  const chosen = opts.filter(o => o.id === keep)[0] || opts[0];
  S.subj.docId = chosen.id;
  S.subj.docTitle = chosen.title;
}

$('#subjDoc').onchange = e => {
  const o = e.target.options[e.target.selectedIndex];
  S.subj.docId = e.target.value;
  S.subj.docTitle = o ? o.textContent.split('›').pop().trim() : '';
};

/* ------------------------------ 出题提示词 ------------------------------ */

function subjQuestionPrompt(dir, doc, cases) {
  const isPrd = dir === 'prd';
  const taskItems = isPrd
    ? '目标用户与使用场景、核心流程怎么走、功能清单与优先级、成功指标怎么定、风险与「这期不做什么」的边界'
    : '角色与目标怎么设定、输入输出格式怎么约束、边界与禁止项、模型答偏时怎么兜底、怎么判断这条提示词好不好用';

  const parts = [
    `你现在扮演一位带过很多零基础转行学员的 AI 产品经理导师。请围绕知识点「${doc.title}」出一道主观练习题，让学员练习${isPrd ? 'PRD 撰写' : '提示词撰写'}的思路。`,
    '',
    '出题要求：',
    '1. 必须是真实工作场景，学员看完能想象自己正坐在工位上接到这个任务。',
    '2. 结构固定为四段，用下面四个小标题原文，各段之间空一行：',
    '   【业务背景】',
    '   【需求场景】',
    '   【你的任务】',
    '   【交付要求】',
    '3. 【业务背景】：这是什么公司、什么产品、目前处境如何，并给出具体的、可信的数据或用户反馈（可以合理虚构具体数字）。',
    '4. 【需求场景】：谁提出了什么诉求、痛在哪里、为什么现在必须做。',
    `5. 【你的任务】：用 3-4 条列出学员要产出什么，例如：${taskItems}。`,
    '6. 【交付要求】：说明只需要写思路和框架、不需要写完整全文，并给出建议字数（200-400 字）。',
    '7. 不要给出参考答案，不要替学员写。全文 350-550 字，讲人话，不要堆术语。',
  ];

  if (cases && cases.length) {
    parts.push(
      '',
      '以下是联网搜索到的真实行业案例。请把其中至少一个的场景、数据或做法融进【业务背景】，让题目贴近真实工作，并在【业务背景】结尾用一句话注明参考了哪个来源（写来源标题即可）：',
      cases.slice(0, 4).map((x, i) => `${i + 1}. ${x.title}${x.site ? '（' + x.site + '）' : ''}\n${(x.snippet || '').slice(0, 300)}`).join('\n')
    );
  }
  parts.push('', '只输出这道题的正文（四段小标题 + 内容），不要写别的话，不要用 markdown 代码围栏。');
  return parts.join('\n');
}

function subjFeedbackPrompt(j) {
  const isPrd = j.dir === 'prd';
  const struct = isPrd
    ? '背景与目标 / 目标用户与场景 / 需求范围与优先级 / 方案与主流程 / 成功指标 / 风险与不做的边界'
    : '角色与目标 / 输入说明 / 输出格式与字段 / 约束与禁止项 / 异常兜底 / 评估标准（怎么判断好不好用）';
  const iter = j.round > 1
    ? `\n\n注意：这已经是第 ${j.round} 版思路，我在对话历史里给了你上一版。请在【②】的第一段先写「相比上一版补上了什么」，再列本次仍然缺失的点。`
    : '';

  return [
    `我在做一道${SUBJ_DIR[j.dir].label}主观练习题。下面是我的思路——我只写了框架，不是完整成稿。请你按固定格式给我反馈。`,
    '',
    '【练习题原文】',
    j.question,
    '',
    `【我的思路（第 ${j.round} 版）】`,
    j.idea,
    '',
    '请严格按下面三段输出。三个标记必须单独成行、原文照抄、一个字都不要改，也不要再加别的编号标题：',
    '',
    '【① 优化后的规范完整版本】',
    `把上面这份思路补全成一份可以直接拿去评审的规范版本，结构用：${struct}。` +
      '要求保留我原本的想法和判断——场景、用户、方案都按我写的那套来，只做补全与规范化，' +
      '不要因为题目里写的是另一个场景，就悄悄把我的内容换成题目里的场景。' +
      (isPrd ? '' : '提示词部分请写成一条可以直接复制粘贴使用的完整提示词。'),
    '',
    '【② 你思路里缺少的核心要素】',
    '逐条列出我这份思路里缺失的关键要素，每条写成「缺什么 → 为什么它重要 → 补上之后会变成什么样」。' +
      '最多 6 条，按重要性从高到低排，用短句，不要写成作文。' +
      '每条尽量引用我原话里的词（例如我写了「抽字段」「节省工时」，就直接引用它），不要写成放之四海皆准的模板句。' +
      '特别重要：如果你发现我的思路和题目的业务场景/行业明显对不上（比如题目问的是 A 业务，我写的是 B 业务），' +
      '必须把这条错位放在最前面提醒我确认是不是看错了题、或者是不是想练另一个场景；不要默默替我把场景改掉。',
    '',
    '【③ 标准结构拆解和修改理由】',
    `讲清楚${isPrd ? '这份 PRD' : '这段提示词'}为什么是这个结构：每一部分分别在回答评审（或模型）心里的哪个问题、漏掉会被怎么追问、顺序为什么这样排。最后给一条这道题最该记住的通用规律。`,
    '',
    '注意：我写的是思路框架而不是成稿，所以不要评价我文笔如何，只针对结构和要素给反馈。' +
      '全文 900-1400 字，不要使用 markdown 代码围栏。' + iter,
  ].join('\n');
}

/* ------------------------------ 生成练习题 ------------------------------ */

async function subjGenerate() {
  const j = S.subj;
  if (!j.docId) { alert('先在下面选一个关联知识点'); return; }
  if (j.busy) return;
  j.busy = true;
  $('#btnSubjGen').disabled = true;

  const useWeb = !!$('#subjWeb').checked;
  $('#subjCases').innerHTML = '';
  j.cases = [];
  $('#subjQuestion').innerHTML = '<div class="empty">正在出题' +
    (useWeb ? '（先联网找真实行业案例，再据此命题）' : '') + '，约 10-25 秒…</div>';
  subjStep(2);

  let acc = '';
  let cases = [];

  await sse('/api/ask', {
    id: j.docId,
    question: subjQuestionPrompt(j.dir, { title: j.docTitle }, []),
    webMode: useWeb ? 'always' : 'never',
  }, {
    webdecide: a => {
      const h = $('#subjWebHint');
      if (h) {
        h.textContent = a.need ? ('🌐 出题时联网找真实案例 · ' + (a.reason || '')) : ('🧠 用本地知识库出题 · ' + (a.reason || ''));
        h.className = 'web-badge' + (a.need ? ' on' : '');
      }
    },
    status: () => {},
    web: w => { cases = w || []; S.subj.cases = cases; subjRenderCases(cases); },
    delta: d => {
      acc += d.text;
      const el = $('#subjQuestion');
      if (el) el.innerHTML = '<div class="q-brief"><div class="q-flag">正在生成…</div>' + mdHTML(acc) + '</div>';
    },
    error: e => { $('#subjQuestion').innerHTML = '<div class="empty">出题失败：' + esc(e.message) + '</div>'; },
    done: () => {
      const q = acc.trim();
      if (!q) return;
      j.question = q;
      j.round = 0;
      j.idea = '';
      j.feedback = '';
      j.lastIdea = '';
      j.lastFeedback = '';
      j.savedId = '';
      $('#subjQuestion').innerHTML = subjQuestionHTML(q, cases);
      $('#subjIdea').value = '';
      $('#subjFeedback').innerHTML = '<div class="empty">提交思路后，这里会给出三部分反馈：<br>' +
        '① 优化后的规范完整版本　② 你思路里缺少的核心要素　③ 标准结构拆解与修改理由</div>';
      $('#subjIterRow').style.display = 'none';
      $('#subjTip').textContent = '';
      subjStep(3);
      try { $('#subjIdea').focus(); } catch (e) {}
    },
  });

  j.busy = false;
  $('#btnSubjGen').disabled = false;
}

function subjQuestionHTML(text, cases) {
  const src = (cases && cases.length)
    ? '<div class="q-flag">🌐 题目背景参考了 ' + cases.length + ' 条联网案例</div>'
    : '<div class="q-flag">🧠 题目基于本地知识库生成</div>';
  return '<div class="q-brief">' + src + mdHTML(text) + '</div>';
}

function subjRenderCases(list) {
  const box = $('#subjCases');
  if (!box) return;
  if (!list || !list.length) { box.innerHTML = ''; return; }
  box.innerHTML = '<div class="enrich-item" style="margin-top:12px"><div class="hd">' +
    '<span class="badge gray">联网找到的真实案例 · ' + list.length + ' 条</span>' +
    '<span class="muted">已作为出题背景，可点开核对</span></div>' +
    '<div class="refs">' + list.map(x =>
      '<div><a href="' + esc(x.url) + '" target="_blank" rel="noreferrer">' + esc(x.title) + '</a>' +
      (x.site ? ' <span class="muted">' + esc(x.site) + '</span>' : '') + '</div>').join('') +
    '</div></div>';
}

$('#btnSubjGen').onclick = subjGenerate;

/* --------------------------- 只看真实案例（联网） --------------------------- */

$('#btnSubjCase').onclick = async () => {
  const j = S.subj;
  const q = j.dir === 'prd'
    ? (j.docTitle || '产品') + ' 产品需求文档 实践 案例'
    : (j.docTitle || '产品') + ' 提示词 prompt 实践 案例';
  $('#subjCases').innerHTML = '<div class="tip">正在联网搜索「' + esc(q) + '」…</div>';
  try {
    const r = await api('/api/websearch', { query: q, count: 5 });
    S.subj.cases = r.items || [];
    subjRenderCases(S.subj.cases);
  } catch (e) {
    $('#subjCases').innerHTML = '<div class="tip">联网失败：' + esc(e.message) +
      '（到「设置」里配一下搜索 API Key 就能用了）</div>';
  }
};

/* ------------------------------ 三段反馈 ------------------------------ */

// 按 ①②③ 三个标记把模型输出切成三段。
// 模型偶尔会漏标记，所以这里做容错：至少要有 ① 和 ②；③ 缺失时把剩余内容并入 ②。
function splitSubjFeedback(text) {
  const t = String(text || '')
    .replace(/^\s*```[a-zA-Z]*\s*/, '')
    .replace(/```\s*$/, '')
    .trim();
  const find = ch => {
    const m = t.match(new RegExp('【\\s*' + ch + '[^】]*】'));
    return m ? { at: m.index, len: m[0].length } : null;
  };
  const a = find('①'), b = find('②'), c = find('③');
  if (!a || !b || a.at >= b.at) return null;
  const endB = (c && c.at > b.at) ? c.at : t.length;
  return {
    final: t.slice(a.at + a.len, b.at).trim(),
    miss: t.slice(b.at + b.len, endB).trim(),
    why: (c && c.at > b.at) ? t.slice(c.at + c.len).trim() : '',
  };
}

function subjRenderFeedback(text) {
  const p = splitSubjFeedback(text);
  const box = $('#subjFeedback');
  if (!p) {
    // 模型没按格式返回时不假装成功：原样展示并说明原因
    box.innerHTML = '<div class="fb-block"><div class="fb-head"><span class="fb-n">AI</span>' +
      '<span class="fb-t">反馈</span>' +
      '<span class="mini-tag">模型没按三段格式返回，已原样展示</span></div>' +
      '<div class="qa-answer md">' + mdHTML(text) + '</div></div>';
    return false;
  }
  box.innerHTML = [
    '<div class="fb-block fb-final"><div class="fb-head"><span class="fb-n">①</span>' +
    '<span class="fb-t">优化后的规范完整版本</span>' +
    '<span class="mini-tag">可以直接拿去评审</span></div>' +
    '<div class="qa-answer md">' + (mdHTML(p.final) || '<p>（这一段没有返回内容）</p>') + '</div></div>',

    '<div class="fb-block fb-miss"><div class="fb-head"><span class="fb-n">②</span>' +
    '<span class="fb-t">你思路里缺少的核心要素</span>' +
    '<span class="mini-tag">按重要性排序</span></div>' +
    '<div class="qa-answer md">' + (mdHTML(p.miss) || '<p>（这一段没有返回内容）</p>') + '</div></div>',

    '<div class="fb-block"><div class="fb-head"><span class="fb-n">③</span>' +
    '<span class="fb-t">标准结构拆解与修改理由</span>' +
    '<span class="mini-tag">为什么要这么写</span></div>' +
    '<div class="qa-answer md">' + (mdHTML(p.why) || '<p>（这一段没有返回内容）</p>') + '</div></div>',
  ].join('');
  return true;
}

/* ------------------------------ 提交并自动保存 ------------------------------ */

async function subjSubmit() {
  const j = S.subj;
  if (!j.question) { alert('先生成练习题，再写思路'); return; }
  const idea = $('#subjIdea').value.trim();
  if (idea.length < 8) {
    alert('先写点你的思路，哪怕只有几条框架也可以（不用写成完整全文）');
    try { $('#subjIdea').focus(); } catch (e) {}
    return;
  }
  if (j.busy) return;
  j.busy = true;
  $('#btnSubjSubmit').disabled = true;

  j.idea = idea;
  j.round += 1;
  j.savedId = '';

  // 迭代：把上一版思路与反馈带进上下文，让模型能对比出进步
  const history = [];
  if (j.round > 1 && j.lastIdea && j.lastFeedback) {
    history.push({ role: 'user', content: '【我上一版的思路】\n' + j.lastIdea });
    history.push({ role: 'assistant', content: String(j.lastFeedback).slice(0, 4000) });
  }

  $('#subjFeedback').innerHTML = '<div class="fb-block"><div class="fb-head">' +
    '<span class="fb-n">AI</span><span class="fb-t">正在生成反馈（第 ' + j.round + ' 版）…</span></div>' +
    '<div class="qa-answer md" id="subjStream"></div></div>';
  $('#subjTip').textContent = '正在生成第 ' + j.round + ' 版反馈…';

  let acc = '';
  await sse('/api/ask', {
    id: j.docId,
    question: subjFeedbackPrompt(j),
    history: history,
    webMode: 'auto',
  }, {
    webdecide: a => {
      const h = $('#subjWebHint');
      if (h) {
        h.textContent = a.need ? ('🌐 反馈时联网补充了行业信息 · ' + (a.reason || '')) : ('🧠 本地知识库够用 · ' + (a.reason || ''));
        h.className = 'web-badge' + (a.need ? ' on' : '');
      }
    },
    status: () => {},
    web: w => { if (w && w.length) S.subj.cases = w; },
    delta: d => {
      acc += d.text;
      const el = $('#subjStream');
      if (el) el.innerHTML = mdHTML(acc);
    },
    error: e => {
      $('#subjFeedback').innerHTML = '<div class="qa-answer">' + esc(e.message) + '</div>';
      $('#subjTip').textContent = '生成失败';
    },
    done: async () => {
      const txt = acc.trim();
      if (!txt) return;
      j.feedback = txt;
      j.lastIdea = j.idea;
      j.lastFeedback = txt;
      const ok3 = subjRenderFeedback(txt);
      subjStep(4, true);
      $('#subjIterRow').style.display = 'flex';
      const saved = await subjAutoSave(ok3);
      if (saved) {
        $('#subjTip').textContent = '已自动保存到练习历史（第 ' + j.round + ' 版） · ' + fmtDateTime(new Date().toISOString());
        loadSubjHistory();
      }
    },
  });

  j.busy = false;
  $('#btnSubjSubmit').disabled = false;
}

$('#btnSubjSubmit').onclick = subjSubmit;
$('#btnSubjClear').onclick = () => {
  $('#subjIdea').value = '';
  $('#subjTip').textContent = '';
  try { $('#subjIdea').focus(); } catch (e) {}
};

// 把一次练习存进「新知识」store（服务端据此自动记一条学习活动 kind=newknowledge，
// 于是练习次数会反映到仪表盘的今日事件 / 估算时长 / 连续打卡里）
async function subjAutoSave(formatOk) {
  const j = S.subj;
  if (!j.feedback.trim() || !j.question.trim()) return false;
  const body = [
    '【练习题】', j.question, '',
    '【我的思路（第 ' + j.round + ' 版）】', j.idea, '',
    '【AI 反馈（第 ' + j.round + ' 版）】' + (formatOk ? '' : '（模型未按三段格式返回，以下为原始输出）'),
    j.feedback,
  ].join('\n');
  const title = ('主观题练习 · ' + SUBJ_DIR[j.dir].label + ' · ' + (j.docTitle || '未关联知识点')).slice(0, 80);
  const summary = ('第 ' + j.round + ' 版思路：' + j.idea.replace(/\s+/g, ' ')).slice(0, 120);
  try {
    const r = await api('/api/newknowledge', {
      title: title,
      content: body,
      summary: summary,
      tags: [SUBJ_TAG, SUBJ_DIR[j.dir].label, '第 ' + j.round + ' 版'],
      from: j.docId ? [{ id: j.docId, title: j.docTitle }] : [],
    });
    j.savedId = (r.item && r.item.id) || '';
    return true;
  } catch (e) {
    $('#subjTip').textContent = '保存失败：' + e.message;
    return false;
  }
}

/* ------------------------------ 练习历史 ------------------------------ */

async function loadSubjHistory() {
  const box = $('#subjHistory');
  if (!box) return;
  if (!box.dataset.loaded) box.innerHTML = '<div class="empty">加载中…</div>';
  let items = [];
  try {
    items = ((await api('/api/newknowledge')).items || []).filter(subjHasTag);
  } catch (e) {
    box.innerHTML = '<div class="empty">练习历史加载失败：' + esc(e.message) + '</div>';
    return;
  }
  box.dataset.loaded = '1';
  S.subj.history = items;
  $('#subjHistCount').textContent = items.length + ' 次';

  if (!items.length) {
    box.innerHTML = '<div class="empty">还没有练习记录。<br>完成一次「生成题目 → 写思路 → 提交反馈」就会自动存一条</div>';
    return;
  }

  box.innerHTML = items.map((n, i) => {
    const tags = (n.tags || []).filter(t => t !== SUBJ_TAG)
      .map(t => '<span class="mini-tag">' + esc(t) + '</span>').join('');
    const from = (n.from && n.from[0]) ? '<span class="mini-tag">' + esc(n.from[0].title) + '</span>' : '';
    const open = i === 0;   // 最新一条默认展开，其余折叠
    return '<div class="hist-item">' +
      '<div class="hist-top"><div class="hist-title">' + esc(n.title) + '</div>' +
      '<div class="row" style="flex:none">' +
      '<button class="btn-line btn-sm" data-histtoggle="' + esc(n.id) + '">' + (open ? '收起' : '展开') + '</button>' +
      '<button class="btn-line btn-sm" data-histdel="' + esc(n.id) + '">删除</button>' +
      '</div></div>' +
      '<div class="hist-meta">' + tags + from + '<span class="mini-tag">' + fmtDateTime(n.at) + '</span></div>' +
      (n.summary ? '<p class="tip">' + esc(n.summary) + '</p>' : '') +
      '<div class="hist-body' + (open ? '' : ' hidden') + '" data-histbody="' + esc(n.id) + '">' +
      mdHTML(n.content) + '</div>' +
      '</div>';
  }).join('');

  $$('#subjHistory [data-histtoggle]').forEach(b => {
    b.onclick = () => {
      const body = $('#subjHistory [data-histbody="' + cssEsc(b.dataset.histtoggle) + '"]');
      if (!body) return;
      const hidden = body.classList.toggle('hidden');
      b.textContent = hidden ? '展开' : '收起';
    };
  });
  $$('#subjHistory [data-histdel]').forEach(b => {
    b.onclick = async () => {
      if (!confirm('删除这条练习记录？')) return;
      try {
        await api('/api/newknowledge?id=' + encodeURIComponent(b.dataset.histdel), null, 'DELETE');
        loadSubjHistory();
      } catch (e) { alert('删除失败：' + e.message); }
    };
  });
}

$('#btnSubjHist').onclick = () => {
  const b = $('#subjHistory');
  if (b) b.dataset.loaded = '';
  loadSubjHistory();
};

/* =============================================================================
 * 7. API 实验
 * ========================================================================== */

function parseHeaderLines(text) {
  const out = {}; const bad = [];
  String(text || '').split('\n').forEach(line => {
    const t = line.trim();
    if (!t) return;
    const i = t.indexOf(':');
    if (i < 0) { bad.push(t); return; }
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (!/^[A-Za-z0-9-]+$/.test(k)) { bad.push(t); return; }
    out[k] = v;
  });
  return { headers: out, bad: bad };
}

function isPrivateHost(host) {
  host = String(host || '').toLowerCase();
  return /^(localhost|127\.|0\.0\.0\.0|::1|\[::1\])/.test(host)
    || /^10\./.test(host) || /^192\.168\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || /^169\.254\./.test(host)
    || host.endsWith('.internal') || host.endsWith('.local');
}

$('#btnLabSend').onclick = labSend;

async function labSend() {
  let raw = $('#labUrl').value.trim();
  if (!raw) { alert('先填一个接口地址'); return; }

  // 相对路径（比如 /api/health）补成完整地址，方便直接试本站接口
  let absolute = raw;
  if (raw.startsWith('/')) absolute = location.origin + raw;

  let host = '';
  try { host = new URL(absolute).hostname; } catch (e) { alert('URL 格式不正确'); return; }
  if (isPrivateHost(host) && !$('#labPrivate').checked) {
    // 本站就在内网/本机，明确提示而不是偷偷放行
    if (confirm('目标地址 ' + host + ' 属于本机 / 内网地址。\n后端默认拒绝这类请求以防被用来探测内网。\n\n点击「确定」勾选「允许请求内网地址」并继续。')) {
      $('#labPrivate').checked = true;
    } else return;
  }

  const hp = parseHeaderLines($('#labHeaders').value);
  const bodyText = $('#labBody').value.trim();
  const method = $('#labMethod').value;

  let parsedBody = bodyText;
  if (bodyText) {
    try { parsedBody = JSON.parse(bodyText); }
    catch (e) { alert('请求体不是合法 JSON：' + e.message); return; }
  }

  $('#labStatus').textContent = '请求中…';
  $('#labResult').innerHTML = '<div class="empty">正在从服务端发起请求…</div>';

  try {
    const r = await api('/api/playground', {
      method: method,
      url: absolute,
      headers: hp.headers,
      body: parsedBody,
      apiKey: $('#labKey').value.trim(),
      allowPrivate: $('#labPrivate').checked,
    });
    renderLabResult(r, hp);
  } catch (e) {
    $('#labStatus').textContent = '失败';
    $('#labResult').innerHTML = '<div class="empty">请求失败：' + esc(e.message) + '</div>';
  }
}

function renderLabResult(r, hp) {
  if (r.ok === false) {
    $('#labStatus').textContent = '请求未成功';
    $('#labResult').innerHTML =
      '<div class="lab-meta"><span class="lab-tag">方法 <b>' + esc(r.request.method) + '</b></span>' +
      '<span class="lab-tag">耗时 <b>' + r.elapsedMs + ' ms</b></span></div>' +
      '<div class="explain"><b>错误：</b>' + esc(r.error || '未知错误') +
      (r.hint ? '<br><br>' + esc(r.hint) : '') + '</div>';
    return;
  }

  const okStatus = r.status >= 200 && r.status < 300;
  $('#labStatus').textContent = r.status + ' ' + (r.statusText || '');

  const pretty = r.bodyJson != null ? JSON.stringify(r.bodyJson, null, 2) : (r.bodyText || '');
  const hdrKeys = Object.keys(r.headers || {});

  $('#labResult').innerHTML = [
    '<div class="lab-meta">',
    '<span class="lab-tag">状态 <b style="color:' + (okStatus ? '#6FAE7E' : '#D87060') + '">' + r.status + ' ' + esc(r.statusText || '') + '</b></span>',
    '<span class="lab-tag">耗时 <b>' + r.elapsedMs + ' ms</b></span>',
    '<span class="lab-tag">方法 <b>' + esc(r.request.method) + '</b></span>',
    '<span class="lab-tag">请求头 <b>' + (r.request.headerKeys || []).length + '</b> 个</span>',
    '<span class="lab-tag">响应体 <b>' + (r.bodyText || '').length + '</b> 字符</span>',
    r.truncated ? '<span class="lab-tag">已截断到 60KB</span>' : '',
    '</div>',

    hp.bad.length ? '<div class="explain">下面这些请求头格式不对，已忽略：<br>' + hp.bad.map(esc).join('<br>') + '</div>' : '',

    '<p class="code-sub">响应头（set-cookie / authorization 已被服务端剥离）</p>',
    hdrKeys.length
      ? '<div class="kv-list">' + hdrKeys.map(k => '<div class="kv"><b>' + esc(k) + '</b><span>' + esc(r.headers[k]) + '</span></div>').join('') + '</div>'
      : '<p class="tip">没有响应头</p>',

    '<p class="code-sub">响应体' + (r.bodyJson != null ? '（已格式化为 JSON）' : '（原文，非 JSON）') + '</p>',
    '<div class="code-block">' + esc(pretty) + '</div>',
  ].join('');
}

$('#btnLabHealth').onclick = () => {
  $('#labMethod').value = 'GET';
  $('#labUrl').value = '/api/health';
  $('#labHeaders').value = '';
  $('#labBody').value = '';
  $('#labKey').value = '';
  // 本站就在本机 / 内网，直接勾上「允许内网」，省掉一次确认弹窗
  $('#labPrivate').checked = true;
  labSend();
};

$$('#labSamples .chip').forEach(c => { c.onclick = () => {
  const u = c.dataset.url || '';
  $('#labMethod').value = 'GET';
  $('#labUrl').value = u;
  $('#labHeaders').value = '';
  $('#labBody').value = '';
  if (isPrivateHost(location.hostname)) $('#labPrivate').checked = true;
  labSend();
}; });

/* =============================================================================
 * 8. 任务日历
 * ============================================================================= */

$('#calRangeSel').onchange = e => { S.calDays = Number(e.target.value) || 60; loadCalendar(); };

async function loadCalendar() {
  const days = S.calDays || 60;
  $('#calGrid').innerHTML = '<div class="empty">加载中…</div>';
  let r;
  try { r = await api('/api/checkins?days=' + days); }
  catch (e) {
    $('#calGrid').innerHTML = '<div class="empty">加载失败：' + esc(e.message) + '</div>';
    return;
  }
  const map = new Map();
  (r.days || []).forEach(d => map.set(d.date, d));

  const isEst = r.activitySource === 'derived';
  $('#calStat').textContent = '共 ' + r.total + ' 天有记录' + (isEst ? ' · 依据学习记录时间戳推算' : '');

  renderCalGrid(days, map);
  renderCalList(r.days || []);
}

function renderCalGrid(days, map) {
  const today = new Date();
  const todayK = todayKey();
  const start = new Date(today.getTime() - (days - 1) * 86400000);
  const startK = isoDay(start);

  // 对齐到周一开头：UTC 下 getUTCDay() 周日=0，转成周一=0
  const lead = (start.getUTCDay() + 6) % 7;
  const gridStart = new Date(start.getTime() - lead * 86400000);
  const tail = 6 - ((today.getUTCDay() + 6) % 7);
  const end = new Date(today.getTime() + tail * 86400000);

  const out = [];
  ['一', '二', '三', '四', '五', '六', '日'].forEach(w => { out.push('<div class="cal-dow">' + w + '</div>'); });

  for (let t = gridStart.getTime(); t <= end.getTime(); t += 86400000) {
    const key = isoDay(new Date(t));
    const dd = new Date(key + 'T00:00:00Z');
    const rec = map.get(key);
    const e = rec ? rec.events : 0;
    let cls = 'cal-cell';
    if (key < startK || key > todayK) cls += ' out';
    else if (e >= 6) cls += ' hot';
    else if (e >= 3) cls += ' mid';
    else if (e >= 1) cls += ' has';

    const title = fmtDay(key) + (e ? '：' + e + ' 个事件 · 约 ' + rec.minutes + ' 分钟' : '：无记录');
    out.push('<div class="' + cls + '" title="' + esc(title) + '">' +
      '<span class="c-d">' + dd.getUTCDate() + '</span>' +
      (e ? '<span class="c-e">' + e + '</span>' : '') +
      '</div>');
  }
  $('#calGrid').innerHTML = out.join('');
}

function renderCalList(days) {
  if (!days.length) {
    $('#calList').innerHTML = '<div class="empty">还没有打卡记录。去知识库标几个「已学」或写条笔记，这里就有数据了</div>';
    return;
  }
  const list = days.slice().reverse().slice(0, 30);
  $('#calList').innerHTML = list.map(d =>
    '<div class="cal-item">' +
    '<div class="cal-date">' + fmtDay(d.date) + '<span>' + fmtWeekday(d.date) + '</span></div>' +
    '<div class="cal-body">' +
    '<div class="cal-kinds">' + Object.keys(d.kinds || {}).map(k =>
      '<span class="mini-tag">' + esc(KIND_LABEL[k] || k) + ' × ' + d.kinds[k] + '</span>').join('') +
    '<span class="mini-tag">' + d.events + ' 个事件 · 约 ' + d.minutes + ' 分钟</span></div>' +
    ((d.titles || []).length ? '<div class="cal-titles">涉及：' + d.titles.map(esc).join('、') + '</div>' : '') +
    '</div></div>').join('');
}

/* =============================================================================
 * 9. 项目作品集
 * ============================================================================= */

async function loadPortfolio() {
  const list = $('#portfolioList');
  list.innerHTML = '<div class="card"><div class="empty">加载中…</div></div>';
  try {
    S.portfolio = (await api('/api/portfolio')).items || [];
  } catch (e) {
    list.innerHTML = '<div class="card"><div class="empty">加载失败：' + esc(e.message) + '</div></div>';
    return;
  }
  renderPortfolio();
}

const PF_TYPE = { practice: '练习作品', prd: 'PRD 文档', case: '案例分析', other: '其他' };

function renderPortfolio() {
  const items = S.portfolio;
  if (!items.length) {
    $('#portfolioList').innerHTML = '<div class="card"><div class="empty">还没有作品<br>点右上角「＋ 新增作品」，把练习成果、PRD、案例分析记下来<br>面试时这些就是你的证据</div></div>';
    return;
  }
  $('#portfolioList').innerHTML = items.map(it =>
    '<div class="pf-item">' +
    '<div class="pf-top">' +
    '<div><div class="pf-title">' + esc(it.title) + '</div>' +
    '<div class="pf-meta">' +
    '<span class="mini-tag">' + esc(PF_TYPE[it.type] || it.type) + '</span>' +
    '<span class="mini-tag">' + fmtDateTime(it.at) + '</span>' +
    (it.docTitle ? '<span class="mini-tag">来自：' + esc(it.docTitle) + '</span>' : '') +
    '</div></div>' +
    '<div class="pf-actions">' +
    (it.docId ? '<button class="btn-line btn-sm" data-pfdoc="' + esc(it.docId) + '">看知识点</button>' : '') +
    '<button class="pf-del" data-pfdel="' + esc(it.id) + '" title="删除">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>' +
    '</button></div></div>' +
    (it.summary ? '<div class="pf-sum">' + esc(it.summary) + '</div>' : '') +
    (it.link ? '<div style="margin-top:9px"><a class="pf-link" href="' + esc(it.link) + '" target="_blank" rel="noreferrer">' + esc(it.link) + '</a></div>' : '') +
    '</div>').join('');

  $$('#portfolioList [data-pfdel]').forEach(b => { b.onclick = async () => {
    if (!confirm('确定删除这个作品？')) return;
    await api('/api/portfolio?id=' + encodeURIComponent(b.dataset.pfdel), null, 'DELETE');
    loadPortfolio();
  }; });
  $$('#portfolioList [data-pfdoc]').forEach(b => { b.onclick = () => { go('knowledge'); openDoc(b.dataset.pfdoc); }; });
}

$('#btnAddNew').onclick = () => openPortfolioModal({});

function openPortfolioModal(pre) {
  pre = pre || {};
  openModal([
    '<h3>新增作品</h3>',
    '<p class="desc">把练习成果沉淀成作品。标题、类型、简述越具体，面试时越好讲。</p>',
    '<div class="field"><label>作品标题</label>' +
    '<input type="text" id="pfTitle" class="control" maxlength="80" placeholder="例如：AI 简历优化工具 PRD v1" value="' + esc(pre.title || '') + '"></div>',
    '<div class="field"><label>类型</label><select id="pfType" class="control">' +
    Object.keys(PF_TYPE).map(k => '<option value="' + k + '"' + (pre.type === k ? ' selected' : '') + '>' + PF_TYPE[k] + '</option>').join('') +
    '</select></div>',
    '<div class="field"><label>一句话简介</label>' +
    '<textarea id="pfSummary" class="control" rows="3" maxlength="600" placeholder="解决了什么问题、你做了什么、结果如何"></textarea></div>',
    '<div class="field"><label>外部链接（可选）</label>' +
    '<input type="text" id="pfLink" class="control" placeholder="https://..."></div>',
    '<div class="field"><label>关联知识点（可选）</label>' +
    '<select id="pfDoc" class="control"><option value="">— 不关联 —</option>' +
    allDocOptions(pre.docId) + '</select></div>',
    '<div class="modal-actions"><button class="btn-line" id="pfCancel">取消</button>' +
    '<button class="btn-dark" id="pfSave">保存</button></div>',
  ].join(''));

  $('#pfCancel').onclick = closeModal;
  $('#pfSave').onclick = async () => {
    const title = $('#pfTitle').value.trim();
    if (!title) { alert('作品标题不能为空'); return; }
    try {
      await api('/api/portfolio', {
        title: title,
        type: $('#pfType').value,
        summary: $('#pfSummary').value.trim(),
        link: $('#pfLink').value.trim(),
        docId: $('#pfDoc').value,
      });
      closeModal();
      loadPortfolio();
    } catch (e) { alert('保存失败：' + e.message); }
  };
}

function allDocOptions(selected) {
  const out = [];
  for (const g of S.tree) for (const s of g.sections) for (const i of s.items) {
    out.push('<option value="' + i.id + '"' + (i.id === selected ? ' selected' : '') + '>' +
      esc(g.group + ' › ' + i.title) + '</option>');
  }
  return out.join('');
}

/* =============================================================================
 * 10. 设置
 * ============================================================================= */

async function loadSettings() {
  let s = S.settings;
  try { s = await api('/api/settings'); S.settings = s; }
  catch (e) { $('#saveTip').textContent = '读取设置失败：' + e.message; }

  const wm = s.webMode || 'auto';
  const radios = document.querySelectorAll('input[name=setWebMode]');
  Array.prototype.forEach.call(radios, r => { r.checked = (r.value === wm); });
  ['optAuto', 'optAlways', 'optNever'].forEach(id => {
    const el = $('#' + id);
    if (!el) return;
    const v = el.querySelector('input');
    el.classList.toggle('on', !!v && v.value === wm);
  });

  $('#setProvider').value = s.searchProvider || 'bocha';
  $('#setKey').value = '';
  $('#setKey').placeholder = s.hasSearchKey ? '当前已配置（重新填写可覆盖）' : 'sk-...';
  $('#setAutoEnrich').checked = s.autoEnrich !== false;
  $('#setCodeName').value = S.code;

  $('#setKeyState').textContent = s.lockedByEnv
    ? '搜索密钥由服务器环境变量统一配置，访客不可修改。'
    : (s.hasSearchKey
      ? '当前已配置搜索密钥。密钥只保存在本机 data/settings.json，接口只返回「有没有配置」，不会回传密钥本身。'
      : '还没有配置。密钥只保存在本机 data/settings.json，不会上传到任何第三方。');

  // 单选卡片高亮：必须限定在设置页里。
  // （刷题的选项也用了 .opt 类，全局选会把它们的点击事件覆盖掉）
  $$('#page-settings .opt').forEach(o => {
    o.onclick = () => {
      const v = o.querySelector('input');
      if (!v) return;
      $$('#page-settings .opt').forEach(x => { if (x.querySelector('input[name=setWebMode]')) x.classList.remove('on'); });
      o.classList.add('on');
    };
  });
}

$('#setSave').onclick = async () => {
  const body = {
    searchProvider: $('#setProvider').value,
    webMode: (document.querySelector('input[name=setWebMode]:checked') || { value: 'auto' }).value,
    autoEnrich: $('#setAutoEnrich').checked,
  };
  const k = $('#setKey').value.trim();
  if (k) body.searchKey = k;

  try {
    S.settings = await api('/api/settings', body);
    const code = $('#setCodeName').value.trim();
    if (code) { S.code = code; try { localStorage.setItem('aipm.code', code); } catch (e) {} applyCode(); }
    $('#saveTip').textContent = '已保存 ' + fmtDateTime(new Date().toISOString());
    $('#setKey').value = '';
    await loadSettings();
  } catch (e) {
    $('#saveTip').textContent = '保存失败：' + e.message;
  }
};

function applyCode() {
  $('#codeName').textContent = S.code;
  const nameEl = $('.user-name');
  const avEl = $('.user-av');
  if (nameEl) nameEl.textContent = S.code;
  if (avEl) avEl.textContent = (S.code || 'M').slice(0, 1);
}

/* =============================================================================
 * 11. 启动
 * ============================================================================= */

$('#modal').onclick = e => { if (e.target.id === 'modal') closeModal(); };
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

// 手机端：输入框获得焦点后滚动到可见位置（软键盘会遮挡）
document.addEventListener('focusin', e => {
  const t = e.target;
  if (!window.matchMedia('(max-width:767px)').matches) return;
  if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) {
    setTimeout(() => {
      try { t.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (err) { t.scrollIntoView(); }
    }, 260);
  }
});

window.addEventListener('beforeunload', () => {
  clearTimeout(S.noteTimer);
  clearTimeout(S.autoEnrichTimer);
});

(async function boot() {
  try { S.code = localStorage.getItem('aipm.code') || 'Melodia'; } catch (e) {}
  applyCode();

  // 设置要先拿到：自动补全的开关会影响详情页行为
  try { S.settings = await api('/api/settings'); } catch (e) {}

  // 先把知识树拉下来：详情页、作品集关联、刷题下拉都要用
  try { await refreshTree(); initOpen(); } catch (e) {
    $('#tree').innerHTML = '<div class="empty">知识树加载失败：' + esc(e.message) +
      '<br><br>请确认是通过 http://127.0.0.1:3000 打开的，而不是双击 html 文件。</div>';
  }
  renderSidebar();
  fillQuizPick();
  fillSubjDoc();

  // 记住上次停留的页面（默认仪表盘）
  let last = 'dashboard';
  try { last = localStorage.getItem('aipm.page') || 'dashboard'; } catch (e) {}
  if (!document.getElementById('page-' + last)) last = 'dashboard';
  go(last);
})();
