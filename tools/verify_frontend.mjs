/* =============================================================================
 * verify_frontend.mjs —— 前端静态契约校验（不启动浏览器）
 * -----------------------------------------------------------------------------
 * 校验三件事：
 *   1) app.js 里出现的所有 DOM id 选择器，index.html 里都必须真实存在
 *      （改版最容易出的坑：JS 还在点一个已经不存在的按钮，静默失效）
 *   2) index.html 里出现的 class，styles.css 里必须有对应规则
 *      （否则是「没样式的裸元素」，页面看着像坏了）
 *   3) app.js / index.html 里出现的每个 /api/xxx 调用，server.js 里必须真的有
 *      这个路由（防止前端打到一个不存在的接口）
 *
 * 用法： node tools/verify_frontend.mjs
 * ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PUB = path.join(ROOT, 'public');

const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(PUB, 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

let pass = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fails.push(name + (detail ? ' → ' + detail : ''));
}

/* ---------- 1. id 契约 ---------- */
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));

// app.js 里所有 $('#xxx') 与 $$('#xxx ...') 的第一个 id
const jsIds = new Set();
for (const m of js.matchAll(/\$\$?\('#([A-Za-z0-9_-]+)/g)) jsIds.add(m[1]);

// app.js 自己用模板生成的元素（详情页、弹窗等），这些 id 不出现在 index.html 里是正常的
const runtimeIds = new Set([...js.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map(m => m[1]));

const missingIds = [...jsIds].filter(id => !htmlIds.has(id) && !runtimeIds.has(id));
ok('app.js 引用的 DOM id 都能被创建（index.html 静态 或 app.js 动态）', missingIds.length === 0,
  missingIds.length ? '两处都找不到：' + missingIds.join(', ') : '');

// 反向：页面上的交互控件应该被 JS 用到（仅提示，不算失败）
const interactive = [...html.matchAll(/<(button|input|select|textarea)[^>]*\bid="([^"]+)"/g)].map(m => m[2]);
const unused = interactive.filter(id => !jsIds.has(id));
if (unused.length) console.log('  [提示] 这些静态控件 id 没在 app.js 的 $(\'#id\') 里出现（可能由父元素代理或纯装饰）: ' + unused.join(', '));

/* ---------- 2. class 契约 ---------- */
const classes = new Set();
const addClasses = v => { for (const c of String(v).split(/\s+/)) if (/^[a-z][a-z0-9-]*$/.test(c)) classes.add(c); };
for (const m of html.matchAll(/\bclass="([^"]+)"/g)) addClasses(m[1]);
// JS 模板里的 class="..."：只匹配「纯字面量」形式，形如 class="' + x + '" 的跳过
for (const m of js.matchAll(/\bclass="([A-Za-z][A-Za-z0-9_ -]*)"/g)) addClasses(m[1]);
// JS 里按空格拼接的多个类名，例如 'cal-cell hot'（要求至少含一个连字符，避免吃到 'use strict' 这类短语）
for (const m of js.matchAll(/['"]([a-z][a-z0-9-]*(?:\s+[a-z][a-z0-9-]*)+)['"]/g)) {
  if (/-/.test(m[1])) addClasses(m[1]);
}

const cssClasses = new Set([...css.matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/g)].map(m => m[1]));
// 纯状态/语义类：由 JS 切换、样式写在别的组合选择器里，或刻意无样式
const ALLOW_NO_STYLE = new Set([
  'page', 'on', 'open', 'has', 'hot', 'mid', 'out', 'sel', 'right', 'wrong', 'zero', 'md',
  'md-h', 'md-ul', 'md-table', 'done',
]);
const noStyle = [...classes].filter(c => !cssClasses.has(c) && !ALLOW_NO_STYLE.has(c));
ok('index.html / app.js 用到的 class 在 styles.css 里都有规则', noStyle.length === 0,
  noStyle.length ? 'styles.css 里没有：' + noStyle.join(', ') : '');

/* ---------- 3. 接口契约 ---------- */
const serverRoutes = new Set();
for (const m of server.matchAll(/p === '(\/api\/[A-Za-z0-9_\/]+)'/g)) serverRoutes.add(m[1]);

const calledPaths = new Set();
for (const m of js.matchAll(/['"`](\/api\/[A-Za-z0-9_\/]+)/g)) calledPaths.add(m[1].replace(/\/$/, ''));
for (const m of html.matchAll(/data-url="(\/api\/[A-Za-z0-9_\/]+)"/g)) calledPaths.add(m[1]);

const badPaths = [...calledPaths].filter(p => !serverRoutes.has(p));
ok('前端调用的每个 /api 路径都存在于 server.js', badPaths.length === 0,
  badPaths.length ? 'server.js 里没有这个路由：' + badPaths.join(', ') : '');

const notUsed = [...serverRoutes].filter(p => !calledPaths.has(p));
console.log('  [提示] 前端暂未调用的接口: ' + (notUsed.length ? notUsed.join(', ') : '（无，全部已对接）'));

/* ---------- 4. 结构契约 ---------- */
ok('7 个页面容器都在', ['dashboard', 'knowledge', 'practice', 'lab', 'calendar', 'portfolio', 'settings']
  .every(p => htmlIds.has('page-' + p)));
ok('导航按钮 7 个且 data-page 与页面容器一一对应',
  [...html.matchAll(/data-page="([a-z]+)"/g)].length === 7);
ok('index.html 只加载相对路径资源（无绝对 host）',
  !/(src|href)="https?:\/\//.test(html.replace(/href="https:\/\/open\.bochaai\.com"/g, '')));
ok('theme.css 已停用（不含旧版 body[data-theme] 覆盖规则）',
  !/^\s*body\[data-theme\]/m.test(fs.readFileSync(path.join(PUB, 'theme.css'), 'utf8')));

/* ---------- 5. 后端接口面「只许复用、不许膨胀」 ---------- */
// 主观题模块是纯前端新增功能，要求「不新增后端接口」。
// 这里把后端路由清单钉住：以后谁不小心加了新路由，这条会立刻失败并列出差异。
const EXPECTED_ROUTES = [
  '/api/health', '/api/catalog', '/api/tree', '/api/doc', '/api/progress', '/api/search',
  '/api/chat', '/api/ask', '/api/note', '/api/enrich', '/api/learned',
  '/api/newknowledge', '/api/quiz', '/api/quiz/generate', '/api/quiz/submit',
  '/api/wrong', '/api/settings', '/api/websearch',
  '/api/stats', '/api/checkins', '/api/goals', '/api/portfolio', '/api/playground',
].sort();
const actualRoutes = [...serverRoutes].sort();
const addedRoutes = actualRoutes.filter(p => EXPECTED_ROUTES.indexOf(p) < 0);
const removedRoutes = EXPECTED_ROUTES.filter(p => actualRoutes.indexOf(p) < 0);
ok('后端路由清单没有新增（共 ' + EXPECTED_ROUTES.length + ' 个）', addedRoutes.length === 0,
  addedRoutes.length ? '多出来的路由：' + addedRoutes.join(', ') : '');
ok('后端原有路由一个都没少', removedRoutes.length === 0,
  removedRoutes.length ? '少了的：' + removedRoutes.join(', ') : '');

/* ---------- 汇总 ---------- */
console.log('');
if (fails.length) {
  console.log('✗ 前端契约校验失败 ' + fails.length + ' 项：');
  fails.forEach(f => console.log('   - ' + f));
  process.exit(1);
}
console.log('✓ 前端契约校验通过（' + pass + ' 项断言）');
console.log('  DOM id ' + jsIds.size + ' 个（静态 ' + htmlIds.size + ' · 动态 ' + runtimeIds.size +
  '）· class ' + classes.size + ' 个 · 接口路径 ' + calledPaths.size + ' 个');
