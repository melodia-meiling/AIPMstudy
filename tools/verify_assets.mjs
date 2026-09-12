// 验证拆分后的资源加载：类型、路径、内容完整性
// 说明：index.html 现在是「7 个页面的结构壳」，样式和脚本都在外部文件里。
//       体量不再是判断标准，判断标准是「结构 / 样式 / 逻辑三层有没有真正分开」。
const PORT = process.env.PORT || 3000;
const B = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const t = (n, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++; };

(async () => {
  console.log('=== 1. index.html 结构与引用 ===');
  const r = await fetch(B + '/');
  const html = await r.text();
  t('GET / 返回 200', r.status === 200);
  t('Content-Type 是 HTML', (r.headers.get('content-type') || '').includes('text/html'));
  t('体积合理（结构壳，不含样式与逻辑）', html.length > 5000 && html.length < 80000,
    `${(html.length / 1024).toFixed(1)} KB`);

  const links = [...html.matchAll(/<link[^>]*href=["']([^"']+)["']/gi)].map(m => m[1]);
  const scripts = [...html.matchAll(/<script[^>]*\bsrc=["']([^"']+)["']/gi)].map(m => m[1]);
  t('引用了 styles.css', links.some(x => /styles\.css$/.test(x)), links.join(', '));
  t('引用了 app.js', scripts.some(x => /app\.js$/.test(x)), scripts.join(', '));
  t('全部是相对路径（不含 http/localhost）',
    [...links, ...scripts].every(x => !/^(https?:)?\/\//.test(x) && !x.includes('localhost')),
    [...links, ...scripts].join(', '));
  t('没有残留内联 <style>', !/<style/i.test(html));
  t('没有残留内联 <script>（除引入）', !/<script(?![^>]*src)/i.test(html));
  t('7 个页面容器都在', ['dashboard', 'knowledge', 'practice', 'lab', 'calendar', 'portfolio', 'settings']
    .every(p => html.includes('id="page-' + p + '"')));
  t('导航有 7 个入口', [...html.matchAll(/data-page="[a-z]+"/g)].length === 7);

  console.log('\n=== 2. 外部资源可加载且 MIME 正确 ===');
  for (const [file, expectType, minSize] of [
    ['/styles.css', 'text/css', 10000],
    ['/app.js', 'javascript', 20000],
  ]) {
    const rr = await fetch(B + file);
    const ct = rr.headers.get('content-type') || '';
    const body = await rr.text();
    t(`${file} 返回 200`, rr.status === 200);
    t(`  类型是 ${expectType}`, ct.includes(expectType), ct);
    t(`  不是 HTML（否则浏览器报 Unexpected token '<'）`, !body.trimStart().startsWith('<'));
    t(`  体积合理`, body.length > minSize, `${(body.length / 1024).toFixed(1)} KB`);
  }

  console.log('\n=== 3. 样式完整性（奶油风设计规范）===');
  const css = await (await fetch(B + '/styles.css')).text();
  // 断言值可以是正则（对 css 取 test），也可以直接是布尔（用于「不能出现某某」这类反向断言）
  const hit = x => (typeof x === 'boolean' ? x : x.test(css));
  for (const [k, re] of [
    ['设计稿底色变量 #F4F1EB', /--cream:\s*#F4F1EB/i],
    ['卡片底色变量 #F9F6F1', /--milk:\s*#F9F6F1/i],
    ['主色 / 强调色变量', /--orange:\s*#E89B68[\s\S]{0,120}--orange-soft:\s*#F2D188/i],
    ['正文 / 次要文字变量', /--ink:\s*#333333[\s\S]{0,80}--muted:\s*#777777/i],
    ['卡片圆角 18px', /--r-card:\s*18px/],
    ['卡片间距 24px', /--gap:\s*24px/],
    ['柔和阴影（非硬边框）', /--shadow-soft:\s*0 1px 2px/],
    ['侧栏是浅色（设计稿要求，不用深色导航）', !/--nav1|linear-gradient\([^)]*#1[0-9a-f]{5}/i.test(css)],
    ['响应式断点 1024', /@media\s*\(max-width:\s*1024px\)/],
    ['响应式断点 767', /@media\s*\(max-width:\s*767px\)/],
    ['响应式断点 379（小屏）', /@media\s*\(max-width:\s*379px\)/],
    ['汉堡按钮样式', /\.burger\s*\{/],
    ['抽屉收起 transform', /translateX\(-10\d%\)/],
    ['触控 44px', /min-height:\s*44px/],
    ['表格横滚（手机端宽表格）', /\.md-table[\s\S]{0,120}overflow-x:\s*auto/],
  ]) t(k, hit(re));

  console.log('\n=== 4. 脚本完整性（7 个页面对接的接口）===');
  const js = await (await fetch(B + '/app.js')).text();
  for (const [k, re] of [
    ['知识树渲染', /\/api\/tree|renderSidebar/],
    ['知识点详情', /\/api\/doc/],
    ['检索接口', /\/api\/search/],
    ['对话流式接口', /\/api\/chat/],
    ['答疑接口', /\/api\/ask/],
    ['笔记接口', /\/api\/note/],
    ['AI补全', /\/api\/enrich/],
    ['标记已学', /\/api\/learned/],
    ['刷题中心', /\/api\/quiz/],
    ['错题本', /\/api\/wrong/],
    ['新知识', /\/api\/newknowledge/],
    ['仪表盘统计', /\/api\/stats/],
    ['打卡记录（日历）', /\/api\/checkins/],
    ['今日目标', /\/api\/goals/],
    ['项目作品集', /\/api\/portfolio/],
    ['API 实验', /\/api\/playground/],
    ['设置', /\/api\/settings/],
    ['响应式抽屉逻辑', /matchMedia\('\(max-width:767px\)'\)/],
  ]) t(k, re.test(js));

  console.log('\n=== 5. 接口都是相对路径（部署关键）===');
  const absCalls = [...js.matchAll(/['"`](https?:\/\/[^'"`]*\/api\/[^'"`]*)/g)].map(m => m[1]);
  t('没有把 host 写死在接口调用里', absCalls.length === 0, absCalls.join(', ') || '无绝对地址');
  const relApi = [...new Set([...js.matchAll(/['"`](\/api\/[a-z0-9\-\/]+)/gi)].map(m => m[1]))];
  t('使用 /api/xxx 相对路径', relApi.length >= 8, relApi.length + ' 个接口');

  console.log('\n=== 6. 关键接口仍返回 JSON ===');
  for (const p of ['/api/tree', '/api/health']) {
    const rr = await fetch(B + p);
    t(`${p} 是 JSON`, (rr.headers.get('content-type') || '').includes('json'));
  }

  console.log(`\n===== 合计：PASS ${pass} / FAIL ${fail} =====`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('异常:', e); process.exit(2); });
