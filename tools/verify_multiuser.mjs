// 验证多用户数据隔离 + 部署相关行为（不需真正部署）
// 思路：模拟两个不同 Cookie 的访客，确认互相看不到对方的笔记与已学状态。
const BASE = `http://127.0.0.1:${process.env.PORT || 3004}`;

let pass = 0, fail = 0;
const t = (n, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++; };

// 手工管理 Cookie，模拟两个独立浏览器
function makeClient(name) {
  const jar = { cookie: '' };
  return {
    name,
    async req(path, opt = {}) {
      const headers = Object.assign({}, opt.headers);
      if (jar.cookie) headers.Cookie = jar.cookie;
      if (opt.body) headers['Content-Type'] = 'application/json';
      const r = await fetch(BASE + path, { ...opt, headers });
      const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
      for (const c of sc) {
        const kv = c.split(';')[0];
        if (kv.startsWith('aipm_uid=')) jar.cookie = kv;
      }
      let body = null;
      const ct = r.headers.get('content-type') || '';
      if (ct.includes('json')) body = await r.json().catch(() => null);
      return { status: r.status, body, headers: r.headers };
    },
  };
}

const A = makeClient('访客A');
const B = makeClient('访客B');

async function reqA(p, o) { return A.req(p, o); }
async function reqB(p, o) { return B.req(p, o); }

(async () => {
  console.log('=== 1. 健康检查与检索配置 ===');
  {
    const h = await reqA('/api/health');
    t('/api/health 可访问', h.status === 200 && (h.body?.docs || 0) > 0, `docs=${h.body?.docs}`);
    t('检索模式=hybrid', h.body?.retrieval?.mode === 'hybrid');
    console.log('     queryEncoding = ' + h.body?.retrieval?.queryEncoding);
  }

  console.log('\n=== 2. 多用户隔离：笔记 ===');
  {
    // A 写笔记
    const w = await reqA('/api/note', { method: 'POST', body: JSON.stringify({ id: 'd40', text: '这是访客A的私有笔记-标记AAA' }) });
    t('访客A 能保存笔记', w.status === 200);

    const da = await reqA('/api/doc?id=d40');
    t('访客A 能读回自己的笔记', /标记AAA/.test(da.body?.note || ''), JSON.stringify(da.body?.note || '').slice(0, 40));

    const db = await reqB('/api/doc?id=d40');
    const bNote = db.body?.note || '';
    t('访客B 看不到访客A 的笔记', !/标记AAA/.test(bNote), 'B 读到: ' + JSON.stringify(bNote).slice(0, 30));

    // B 写自己的
    await reqB('/api/note', { method: 'POST', body: JSON.stringify({ id: 'd40', text: '这是访客B的私有笔记-标记BBB' }) });
    const da2 = await reqA('/api/doc?id=d40');
    const db2 = await reqB('/api/doc?id=d40');
    t('双方各写各的，互不覆盖',
      /标记AAA/.test(da2.body?.note || '') && /标记BBB/.test(db2.body?.note || ''));
  }

  console.log('\n=== 3. 多用户隔离：已学状态 ===');
  {
    await reqA('/api/learned', { method: 'POST', body: JSON.stringify({ id: 'd41', on: true }) });
    const pa = await reqA('/api/progress');
    const pb = await reqB('/api/progress');
    t('访客A 已学数 ≥1', (pa.body?.learned || 0) >= 1, 'A learned=' + pa.body?.learned);
    t('访客B 已学数不受影响', (pb.body?.learned || 0) === 0, 'B learned=' + pb.body?.learned);

    const da = await reqA('/api/doc?id=d41');
    const db = await reqB('/api/doc?id=d41');
    t('访客A 的 d41 显示已学', da.body?.learned === true);
    t('访客B 的 d41 未标记已学', db.body?.learned === false || db.body?.learned === undefined);
  }

  console.log('\n=== 4. 多用户隔离：知识树已学计数 ===');
  {
    const ta = await reqA('/api/tree');
    const tb = await reqB('/api/tree');
    const sa = ta.body.tree.reduce((s, g) => s + (g.learned || 0), 0);
    const sb = tb.body.tree.reduce((s, g) => s + (g.learned || 0), 0);
    t('树里的已学计数按用户区分', sa >= 1 && sb === 0, `A=${sa} B=${sb}`);
  }

  console.log('\n=== 5. 多用户隔离：新知识 ===');
  {
    const w = await reqA('/api/newknowledge', { method: 'POST', body: JSON.stringify({ title: 'A的新知识XYZ', content: '内容来自访客A', skipAI: true }) });
    t('访客A 能提交新知识', w.status === 200, 'status=' + w.status);
    const la = await reqA('/api/newknowledge');
    const lb = await reqB('/api/newknowledge');
    const hasA = (la.body.items || []).some(x => /A的新知识XYZ/.test(x.title || ''));
    const hasB = (lb.body.items || []).some(x => /A的新知识XYZ/.test(x.title || ''));
    t('访客A 能看到自己的新知识', hasA);
    t('访客B 看不到访客A 的新知识', !hasB);
  }

  console.log('\n=== 6. 多用户隔离：错题 ===');
  {
    const wa = await reqA('/api/wrong');
    const wb = await reqB('/api/wrong');
    t('错题本按用户隔离（结构正常）',
      Array.isArray(wa.body?.items) && Array.isArray(wb.body?.items),
      `A=${wa.body?.items?.length} B=${wb.body?.items?.length}`);
  }

  console.log('\n=== 7. 安全：密钥不回传 ===');
  {
    const s = await reqA('/api/settings');
    const raw = JSON.stringify(s.body);
    t('设置接口不回传 searchKey 明文', !/searchKey/.test(raw) || !s.body.searchKey);
    t('设置接口不回传密钥掩码', !/searchKeyMask/.test(raw));
    t('只暴露 hasSearchKey 布尔值', typeof s.body.hasSearchKey === 'boolean');
    t('暴露 lockedByEnv 供前端只读展示', typeof s.body.lockedByEnv === 'boolean');
  }

  console.log('\n=== 8. 隔离不会破坏基础功能 ===');
  {
    const c = await reqA('/api/catalog');
    t('知识目录正常', c.status === 200 && (c.body?.catalog?.length || 0) >= 7);
    const s = await reqA('/api/search?q=' + encodeURIComponent('什么是RAG'));
    t('混合检索正常', s.status === 200 && s.body.hits?.length > 0);
    t('  检索命中 RAG', s.body.hits[0]?.title === 'RAG', s.body.hits[0]?.title);
    t('  语义分为非零（向量生效）', (s.body.hits[0]?.sim || 0) > 0, 'sim=' + s.body.hits[0]?.sim);
    const d = await reqA('/api/doc?id=d40');
    t('详情字段契约完整', !!(d.body.explain && d.body.faqs?.length && d.body.breadcrumb?.length));
  }

  console.log(`\n===== 合计：PASS ${pass} / FAIL ${fail} =====`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('验证异常：', e); process.exit(2); });
