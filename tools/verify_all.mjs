// AIPM 学习工作台 · 全量接口验证
// 注意：服务端按 Cookie 做多用户隔离，因此本脚本必须在整个流程里保持同一个会话，
//       否则每次请求都是"新访客"，写笔记与读笔记会落在不同用户桶里，造成误报。
const PORT = process.env.PORT || 3000;
const B = `http://127.0.0.1:${PORT}`;

let COOKIE = '';
async function req(path, opt = {}) {
  const headers = Object.assign({}, opt.headers);
  if (COOKIE) headers.Cookie = COOKIE;
  const r = await fetch(B + path, { ...opt, headers });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  for (const c of sc) if (c.startsWith('aipm_uid=')) COOKIE = c.split(';')[0];
  return r;
}
const j = async (p, o) => {
  const r = await req(p, o);
  return { code: r.status, body: await r.json().catch(() => null) };
};
const jpost = (p, data) => j(p, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(data),
});

let pass = 0, fail = 0;
const t = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  ok ? pass++ : fail++;
};

console.log('=== 1. 静态页面（7 页版工作台）===');
{
  const r = await req('/');
  const h = await r.text();
  t('GET / 返回 200', r.status === 200);
  t('含知识点详情容器 #kbMain', h.includes('id="kbMain"'));
  t('含知识树容器 #tree', h.includes('id="tree"'));
  // 左侧导航的 7 个入口（与设计稿一一对应）
  for (const [kw, page] of [
    ['仪表盘主页', 'dashboard'], ['知识库文档', 'knowledge'], ['刷题中心', 'practice'],
    ['API实验', 'lab'], ['任务日历', 'calendar'], ['项目作品集', 'portfolio'], ['设置', 'settings'],
  ]) t(`导航入口：${kw}`, h.includes(kw) && h.includes('id="page-' + page + '"'));
  // 菜单文字与页面大标题必须一致（改了一边忘另一边会被这条测出来）。
  // 直接按元素匹配，不用「出现 N 次」这种计数断言 —— 计数会被注释里的同名词凑够。
  t('刷题中心：菜单文字与页面大标题一致',
    /<span>刷题中心<\/span>/.test(h) && /<h1 class="greet">刷题中心<\/h1>/.test(h));
  // 标签栏只有一行，三个选项并列
  t('刷题中心标签栏只有一行', (h.match(/class="seg"/g) || []).length === 1 &&
    !/id="modeSeg"/.test(h), 'seg 数=' + (h.match(/class="seg"/g) || []).length);
  t('三个标签：客观题 / 主观题 / 错题本',
    /data-tab="quiz">客观题</.test(h) && /data-tab="subj">主观题</.test(h) && /data-tab="wrong">错题本</.test(h));
  t('页面副标题保留', /客观题练判断，主观题练写法/.test(h));
  t('右侧代号显示', /codeName/.test(h));
  t('响应式：汉堡按钮', /id="btnMenu"/.test(h));
  t('响应式：抽屉遮罩', /id="sideMask"/.test(h));
}

console.log('\n=== 2. 只读接口 ===');
{
  const h = await j('/api/health');
  t('/api/health', h.code === 200 && h.body.docs > 0, `docs=${h.body?.docs} key=${h.body?.hasKey}`);
  t('  检索模式=hybrid', h.body.retrieval?.mode === 'hybrid');
  t('  向量已加载', h.body.retrieval?.embeddingCount === h.body.docs,
    `${h.body.retrieval?.embeddingCount} / ${h.body.docs}`);

  const c = await j('/api/catalog');
  const nCat = c.body?.catalog?.length ?? 0;
  t('/api/catalog', c.code === 200 && nCat >= 7 && nCat <= 25, `一级分类=${nCat}`);
  const catName = x => x.category || x.group;
  t('  含 7 大知识树主干分类',
    ['行业&业务认知', '产品基础能力', 'AI专属技术知识', 'AI开发工具平台']
      .every(k => c.body.catalog.some(x => catName(x) === k)));
  // 书目统一收在「读书书单」下，书名作为二级分类
  // （不让每本书各占一个一级分类，否则侧栏会被书目挤爆）
  const bookCat = c.body.catalog.find(x => catName(x) === '读书书单');
  t('  书目收在「读书书单」下并按书名分组', !!bookCat && bookCat.children.length >= 12,
    bookCat ? `${bookCat.children.length} 本书/分组` : '未找到读书书单');

  const tr = await j('/api/tree');
  const total = tr.body.tree.reduce((s, g) => s + g.count, 0);
  const EXPECT_DOCS = h.body.docs;
  t('/api/tree', tr.code === 200 && total === EXPECT_DOCS, `分组=${tr.body?.tree?.length} 条目=${total} / 期望 ${EXPECT_DOCS}`);
  t('  树支持三级（group→sections→items）', !!tr.body.tree[0]?.sections?.[0]?.items?.[0]?.id);

  // 连续调用两次，确认计数不会累加（曾经的 bug）
  const tr2 = await j('/api/tree');
  const total2 = tr2.body.tree.reduce((s, g) => s + g.count, 0);
  t('  重复调用计数不累加', total2 === total, `第2次=${total2}`);

  const d = await j('/api/doc?id=d40');
  t('/api/doc', d.code === 200 && d.body.id === 'd40', d.body?.name);
  for (const f of ['explain', 'keypoints', 'faqs', 'breadcrumb', 'sources', 'levelN', 'relatedIds']) {
    const v = d.body[f];
    const ok = Array.isArray(v) ? v.length > 0 : (typeof v === 'string' ? v.length > 0 : !!v);
    t(`  字段 ${f}`, ok, Array.isArray(v) ? `${v.length} 项` : String(v).slice(0, 28));
  }
  t('  explain 为扩写长文（>300字）', (d.body.explain || '').length > 300, `${(d.body.explain || '').length} 字`);
  t('  breadcrumb 为层级路径', (d.body.breadcrumb || []).length >= 2, (d.body.breadcrumb || []).join(' › '));
  t('  faqs 有答案内容', (d.body.faqs?.[0]?.a || '').length > 20);
  t('  sources 不冒充书籍出处', !(d.body.sources || []).some(s => /模型通用知识/.test(s)),
    (d.body.sources || []).join(' / '));

  const s = await j('/api/search?q=' + encodeURIComponent('什么是RAG'));
  t('/api/search', s.code === 200 && s.body.hits.length > 0);
  t('  RAG 排第一', s.body.hits[0]?.title === 'RAG', s.body.hits[0]?.title);
  t('  返回语义分与关键词分', s.body.hits[0]?.sim !== undefined && s.body.hits[0]?.kw !== undefined);
  t('  语义分非零（向量生效）', (s.body.hits[0]?.sim || 0) > 0, 'sim=' + s.body.hits[0]?.sim);

  const pg = await j('/api/progress');
  t('/api/progress', pg.code === 200);
}

console.log('\n=== 3. 写入类接口（笔记 / 已学）===');
{
  const n = await jpost('/api/note', { id: 'd40', text: '自测笔记：RAG 先检索再生成' });
  t('POST /api/note 保存成功', n.code === 200);

  const d2 = await j('/api/doc?id=d40');
  t('  笔记已回读（同一会话）', (d2.body.note || '').includes('自测笔记'), d2.body.note);

  const l = await jpost('/api/learned', { id: 'd40', on: true });
  t('POST /api/learned 标记成功', l.code === 200);
  const d3 = await j('/api/doc?id=d40');
  t('  已学状态已持久化', d3.body.learned === true);

  // 还原，避免污染
  await jpost('/api/note', { id: 'd40', text: '' });
  await jpost('/api/learned', { id: 'd40', on: false });
}

console.log('\n=== 4. 刷题 / 错题本 / 新知识 ===');
{
  const qMissing = await req('/api/quiz');
  t('GET /api/quiz 缺 id 时给明确错误', qMissing.status === 404);

  const q = await j('/api/quiz?id=d40');
  t('GET /api/quiz?id=d40', q.code === 200 && q.body.id === 'd40', `已存题目 ${q.body?.questions?.length ?? 0} 道`);

  const g = await jpost('/api/quiz/generate', { id: 'd40', count: 3 });
  const qn = g.body?.questions?.length || 0;
  t('POST /api/quiz/generate 生成题目', qn >= 1, `${qn} 道`);
  if (qn) t('  题目字段完整', !!(g.body.questions[0].q && Array.isArray(g.body.questions[0].options)));

  const w = await j('/api/wrong');
  t('GET /api/wrong 返回数组', w.code === 200 && Array.isArray(w.body.items));

  const nk = await j('/api/newknowledge');
  t('GET /api/newknowledge 返回数组', nk.code === 200 && Array.isArray(nk.body.items),
    `${nk.body?.items?.length ?? '?'} 条`);

  const st = await j('/api/settings');
  t('GET /api/settings', st.code === 200);
  t('  不回传密钥明文或掩码', !('searchKey' in st.body) && !('searchKeyMask' in st.body));
}

console.log(`\n===== 合计：PASS ${pass} / FAIL ${fail} =====`);
process.exit(fail ? 1 : 0);
