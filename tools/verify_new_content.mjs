// 新内容专项验证：确认新增的 10 本书与 35 个知识点「搜得到、答得上、点得动」
const PORT = process.env.PORT || 3000;
const B = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const t = (n, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++; };

let COOKIE = '';
async function req(p, o = {}) {
  const h = Object.assign({}, o.headers);
  if (COOKIE) h.Cookie = COOKIE;
  const r = await fetch(B + p, { ...o, headers: h });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  for (const c of sc) if (c.startsWith('aipm_uid=')) COOKIE = c.split(';')[0];
  return r;
}
const j = async (p, o) => { const r = await req(p, o); return r.json().catch(() => null); };

(async () => {
  console.log('=== 1. 知识库规模 ===');
  const health = await j('/api/health');
  const s = health.stats || {};
  t('条目总数 137 → 240', s.total === 240, `total=${s.total}`);
  t('知识点 109 → 144', s.concept === 144, `concept=${s.concept}`);
  t('书目 20 → 88', s.book === 88, `book=${s.book}`);
  t('一级分类收敛为 10 个', s.categories === 10, `categories=${s.categories}`);
  t('向量已按新规模重建', health.retrieval?.embeddingCount === 240,
    `${health.retrieval?.embeddingCount} 条`);
  t('向量维度 768', health.retrieval?.embeddingDim === 768);

  console.log('\n=== 2. 知识树：新内容出现且可展开 ===');
  const tree = await j('/api/tree');
  const total = tree.tree.reduce((a, g) => a + g.count, 0);
  t('树总条目 = 240', total === 240, `总条目=${total}`);
  const names = tree.tree.map(g => g.group || g.category);
  t('含「产品与设计方法论」', names.includes('产品与设计方法论'));
  t('含「读书书单」', names.includes('读书书单'));
  t('原 7 大主干仍在',
    ['行业&业务认知', '产品基础能力', 'AI专属技术知识', 'AI开发工具平台']
      .every(k => names.includes(k)));
  // 重复调用不累加（老 bug 的回归检查）
  const tree2 = await j('/api/tree');
  t('重复调用计数不累加',
    tree2.tree.reduce((a, g) => a + g.count, 0) === 240);

  const mf = tree.tree.find(g => (g.group || g.category) === '产品与设计方法论');
  t('新分类下挂到二级分类', (mf?.sections?.length || 0) >= 6,
    `${mf?.sections?.length} 个二级分类`);
  const bookG = tree.tree.find(g => (g.group || g.category) === '读书书单');
  // 11 本新书（10 本 + 书单总览）+ 13 本已有书（其中 3 本与新书同名已合并）≈ 14 个二级分类
  t('书单下每本书独立成二级分类', (bookG?.sections?.length || 0) >= 12,
    `${bookG?.sections?.length} 本书/分组`);

  console.log('\n=== 3. 新增知识点详情字段完整 ===');
  // 抽查几个新知识点
  // 「MVP 最小可行产品」按名称包含关系正确合并进了已有的「MVP」条目，
  // 所以这里预期查不到独立条目，而是应命中 MVP 且要点已被扩充
  const probes = ['用户体验五层模型', 'AARRR 增长漏斗', '概率性输出', '意符 Affordance', '好产品的四个条件'];
  for (const name of probes) {
    // 从树里找 id
    let id = null;
    for (const g of tree.tree) for (const sec of g.sections) {
      const it = sec.items.find(x => (x.name || x.title) === name || x.title.includes(name));
      if (it) { id = it.id; break; }
      if (id) break;
    }
    if (!id) { t(`找到「${name}」`, false, '树里没有'); continue; }
    const d = await j('/api/doc?id=' + id);
    const ok = !!(d.explain || d.content) && (d.keypoints || []).length > 0
      && (d.breadcrumb || []).length >= 2 && (d.sources || []).length > 0;
    t(`「${name}」字段完整`, ok,
      `要点${(d.keypoints || []).length} 答疑${(d.faqs || []).length} 关联${(d.relatedIds || []).length} 来源${(d.sources || [])[0] || '-'}`);
  }

  console.log('\n=== 4. 搜索能命中新内容（语义 + 关键词）===');
  const queries = [
    ['什么是用户体验五层模型', ['用户体验五层模型']],
    ['AARRR是什么', ['AARRR 增长漏斗']],
    // 「怎么找真实需求」有两个都对的答案，任一命中即算通过
    ['怎么找用户的真实需求', ['需求采集的四种方法', '用户想要的 vs 用户需要的', '用户调研']],
    ['AI输出不确定怎么办', ['概率性输出']],
    ['怎么判断一个需求该不该用AI', ['AI 可行性判断']],
    ['意符是什么', ['意符 Affordance']],
    ['MVP怎么做', ['MVP']],
    ['怎么给产品做增长', ['增长实验流程', 'AARRR 增长漏斗', '增长黑客']],
    ['推荐几本书', null],
  ];
  for (const [q, expect] of queries) {
    const r = await j('/api/search?q=' + encodeURIComponent(q));
    const titles = (r.hits || []).slice(0, 3).map(h => h.title);
    const hit = expect ? titles.some(x => expect.some(e => x.includes(e))) : titles.length > 0;
    const simOk = (r.hits?.[0]?.sim || 0) > 0;
    t(`「${q}」`, hit && simOk, titles.join(' | ').slice(0, 70));
  }

  console.log('\n=== 5. 书目搜索：新书能被找到 ===');
  for (const q of ['用户体验要素这本书讲什么', '设计心理学', '增长黑客 书', '精益创业 MVP']) {
    const r = await j('/api/search?q=' + encodeURIComponent(q));
    const hitBook = (r.hits || []).some(h => h.book !== 'AI产品经理知识树' && h.book);
    t(`「${q}」`, hitBook, (r.hits || []).map(h => h.book).slice(0, 2).join(' / '));
  }

  console.log('\n=== 6. AI 问答能引用新知识库（真实调用一次）===');
  {
    const res = await req('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '什么是AARRR增长漏斗？和AI产品有什么关系？', history: [] }),
    });
    let text = '', hits = [], err = null, low = false;
    const rd = res.body.getReader(); const dec = new TextDecoder('utf-8');
    let buf = '';
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n'); buf = parts.pop();
      for (const p of parts) {
        const L = p.split('\n');
        let ev = '', data = '';
        for (const l of L) { if (l.startsWith('event:')) ev = l.slice(6).trim(); else if (l.startsWith('data:')) data += l.slice(5).trim(); }
        if (!data) continue;
        let o; try { o = JSON.parse(data); } catch { continue; }
        if (ev === 'delta') text += o.text;
        else if (ev === 'hits') hits = o;
        else if (ev === 'lowConfidence') low = true;
        else if (ev === 'error') err = o.message;
      }
    }
    t('接口无错误', !err, err || '');
    t('召回到新知识点', hits.some(h => /AARRR/.test(h.title)),
      hits.map(h => h.title).slice(0, 3).join(' | ').slice(0, 70));
    t('回答非空且引用了新知识', text.length > 100, `${text.length} 字`);
    t('回答提到 AARRR 或漏斗', /AARRR|漏斗/.test(text));
    t('置信度正常（非低置信）', !low);
  }

  console.log(`\n===== 合计：PASS ${pass} / FAIL ${fail} =====`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('验证异常:', e); process.exit(2); });
