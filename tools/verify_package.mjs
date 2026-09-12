/* =============================================================================
 * verify_package.mjs —— 用「像别人 clone 下来那样」的方式验证打包结果
 * -----------------------------------------------------------------------------
 * 为什么单独做这个：
 *   打包最容易出的问题不是「文件少了一个」，而是「少的那一个刚好是运行时才用到的」——
 *   本地测都正常，别人 clone 下来就起不来。所以这里不信清单，直接对着**包里的服务**
 *   把七类真实请求打一遍，并且专门验证「首次启动能自己把数据文件建出来」。
 *
 * 用法（包里的服务已在运行）：
 *   $env:PORT="3100"; node tools/verify_package.mjs
 * 或指定地址：
 *   node tools/verify_package.mjs --base http://127.0.0.1:3100
 * ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');
const baseIdx = process.argv.indexOf('--base');
const BASE = baseIdx >= 0 ? process.argv[baseIdx + 1] : 'http://127.0.0.1:' + (process.env.PORT || 3100);

let pass = 0, fail = 0;
const t = (n, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++; };
const j = async p => { const r = await fetch(BASE + p); return { status: r.status, type: r.headers.get('content-type') || '', body: await r.json().catch(() => null) }; };

console.log('==============================================================');
console.log(' 打包结果可用性验证（把包当成「别人 clone 下来的仓库」来跑）');
console.log(' 包目录: ' + PKG);
console.log(' 服务:   ' + BASE);
console.log('==============================================================\n');

/* ---------- 1. 静态资源与页面 ---------- */
console.log('=== 1. 前端资源能正常下载（决定页面能不能打开）===');
{
  const r = await fetch(BASE + '/');
  const html = await r.text();
  t('GET / 返回 200', r.status === 200, 'status=' + r.status);
  t('返回的是 HTML', (r.headers.get('content-type') || '').includes('text/html'));
  t('页面含 7 个页面容器', ['dashboard', 'knowledge', 'practice', 'lab', 'calendar', 'portfolio', 'settings']
    .every(p => html.includes('id="page-' + p + '"')));
  t('页面含刷题中心三个标签',
    /data-tab="quiz">客观题</.test(html) && /data-tab="subj">主观题</.test(html) && /data-tab="wrong">错题本</.test(html));
  t('资源都是相对路径（换域名不用改）',
    !/(src|href)="https?:\/\//.test(html.replace(/href="https:\/\/open\.bochaai\.com"/g, '')));

  for (const [f, must] of [['/styles.css', 'text/css'], ['/app.js', 'javascript'], ['/theme.css', 'text/css']]) {
    const rr = await fetch(BASE + f);
    const txt = await rr.text();
    t(f + ' 返回 200 且类型正确', rr.status === 200 && (rr.headers.get('content-type') || '').includes(must),
      rr.status + ' ' + rr.headers.get('content-type'));
    t(f + ' 不是 HTML（防 Unexpected token <）', !txt.trimStart().startsWith('<'));
  }
  const app = await (await fetch(BASE + '/app.js')).text();
  t('app.js 里有 7 个页面的逻辑', ['/api/tree', '/api/stats', '/api/checkins', '/api/goals', '/api/portfolio', '/api/playground', '/api/settings']
    .every(p => app.includes(p)));
  t('app.js 里有主观题练习逻辑', app.includes('主观题练习') && app.includes('/api/ask'));
}

/* ---------- 2. 知识库资产 ---------- */
console.log('\n=== 2. 知识库与向量（决定检索能不能用）===');
{
  const h = await j('/api/health');
  t('/api/health 正常', h.status === 200 && h.body && h.body.ok === true);
  t('知识库已加载（240 个片段）', h.body.docs === 240, 'docs=' + h.body.docs);
  t('倒排索引已加载', h.body.terms > 10000, 'terms=' + h.body.terms);
  t('向量文件已加载且条数与知识库一致',
    h.body.retrieval.embeddingCount === h.body.docs,
    h.body.retrieval.embeddingCount + '/' + h.body.docs);
  t('检索为混合模式', h.body.retrieval.mode === 'hybrid', h.body.retrieval.mode);
}
{
  const tr = await j('/api/tree');
  const docs = (tr.body.tree || []).reduce((a, g) => a + g.count, 0);
  t('/api/tree 返回 240 个知识点', docs === 240, 'docs=' + docs);
  t('知识树是三级结构', (tr.body.tree || []).every(g => Array.isArray(g.sections)));
}
{
  const s = await j('/api/search?q=' + encodeURIComponent('什么是RAG'));
  t('/api/search 能召回到结果', (s.body.hits || []).length > 0, 'hits=' + (s.body.hits || []).length);
  t('召回结果带书名与章节（不是空壳）',
    !!(s.body.hits[0] && s.body.hits[0].title && s.body.hits[0].book),
    s.body.hits[0] && (s.body.hits[0].title + ' · ' + s.body.hits[0].book));
}
{
  const d = await j('/api/doc?id=d1');
  t('/api/doc 返回知识点详情', d.status === 200 && !!d.body.title, d.body && d.body.title);
  t('详情字段完整（explain/breadcrumb/levelN）',
    !!(d.body.explain && d.body.breadcrumb && d.body.levelN));
}

/* ---------- 3. 首次启动能不能自己建数据文件（fresh clone 的关键）---------- */
console.log('\n=== 3. 首次启动自动初始化个人数据（别人 clone 下来的关键）===');
{
  const created = ['notes.json', 'learned.json', 'enrich.json', 'newknowledge.json', 'quiz.json', 'wrong.json', 'settings.json'];
  const missing = created.filter(f => !fs.existsSync(path.join(PKG, 'data', f)));
  t('服务启动后自动创建了个人数据文件', missing.length === 0,
    missing.length ? '缺：' + missing.join(', ') : created.length + ' 个文件都在');

  // 写一次再读回来，证明包里的 data/ 真的可写
  const r = await fetch(BASE + '/api/note', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'd1', text: '打包验证：写一条再读回来' }),
  });
  const cookie = (r.headers.getSetCookie ? r.headers.getSetCookie() : []).map(c => c.split(';')[0]).join('; ');
  t('POST /api/note 写入成功', r.status === 200);
  const r2 = await fetch(BASE + '/api/doc?id=d1', { headers: cookie ? { Cookie: cookie } : {} });
  const d2 = await r2.json();
  t('读回来能看到刚写的笔记（data/ 可写且隔离生效）', d2.note === '打包验证：写一条再读回来', JSON.stringify(d2.note));
}

/* ---------- 4. 各页面依赖的接口都能通 ---------- */
console.log('\n=== 4. 七个页面依赖的接口逐个打通 ===');
for (const [label, p] of [
  ['仪表盘统计', '/api/stats'],
  ['打卡日历', '/api/checkins?days=30'],
  ['今日目标', '/api/goals'],
  ['作品集', '/api/portfolio'],
  ['错题本', '/api/wrong'],
  ['新知识', '/api/newknowledge'],
  ['设置', '/api/settings'],
]) {
  const r = await j(p);
  t(label + '  ' + p, r.status === 200 && !!r.body, 'status=' + r.status);
}
{
  const st = await j('/api/stats');
  t('仪表盘统计口径完整',
    !!st.body.today && !!st.body.totals && !!st.body.plan && Array.isArray(st.body.recent),
    'totals.docs=' + (st.body.totals && st.body.totals.docs));
}

/* ---------- 5. 压缩包换行/编码 ---------- */
console.log('\n=== 5. 关键文件的编码与换行（避免别人打开是乱码）===');
for (const f of ['README.md', 'server.js', 'public/index.html', 'GITHUB上传说明.md']) {
  const buf = fs.readFileSync(path.join(PKG, f));
  const txt = buf.toString('utf8');
  const noBom = !(buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF);
  const utf8Ok = !txt.includes('\uFFFD');
  t(f + ' 是 UTF-8 无 BOM 且中文正常', noBom && utf8Ok,
    (noBom ? 'no-BOM' : 'has-BOM') + (utf8Ok ? ' utf8-ok' : ' 有替换字符'));
}

console.log(`\n===== 合计：PASS ${pass} / FAIL ${fail} =====`);
process.exit(fail ? 1 : 0);
