#!/usr/bin/env node
/**
 * verify_new_endpoints.mjs —— 验证新增的 5 个端点
 * 命令：PORT=3000 node tools/verify_new_endpoints.mjs
 */
const PORT = process.env.PORT || 3000;
const B = `http://127.0.0.1:${PORT}`;
let cookie = '';
async function req(path, opt = {}) {
  const h = Object.assign({}, opt.headers);
  if (cookie) h.Cookie = cookie;
  const r = await fetch(B + path, { ...opt, headers: h });
  for (const c of (r.headers.getSetCookie?.() || [])) if (c.startsWith('aipm_uid=')) cookie = c.split(';')[0];
  return r;
}
const j = async (p, o) => (await req(p, o)).json().catch(() => null);
const post = (p, d) => j(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) });

let pass = 0, fail = 0;
const t = (n, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++; };

(async () => {
  console.log('=== 1. /api/stats 仪表盘聚合 ===');
  {
    const s = await j('/api/stats');
    t('返回 ok', s?.ok === true);
    t('today 有真实字段（非写死）', typeof s?.today?.minutes === 'number' && typeof s?.today?.events === 'number');
    t('  标注了时长是估算值', s?.today?.minutesIsEstimate === true, `系数 ${s?.today?.perEventMinutes} 分钟/事件`);
    t('totals 反映真实知识库规模', s?.totals?.docs === 240, `docs=${s?.totals?.docs}`);
    t('byMark 分档完整', !!(s?.byMark?.['🔴'] && s?.byMark?.['🟡'] && s?.byMark?.['⚪']));
    t('plan 四阶段', (s?.plan?.stages || []).length === 4, (s?.plan?.stages || []).map(x => x.name).join('/'));
    t('recent 14 天序列', (s?.recent || []).length === 14);
    t('goal 有默认目标值', typeof s?.goal?.targetTasks === 'number', `target=${s?.goal?.targetTasks}`);
    console.log(`    今日事件 ${s?.today?.events} 个 / 估算时长 ${s?.today?.minutes} 分钟 / 连续打卡 ${s?.totals?.streak} 天`);
  }

  console.log('\n=== 2. /api/goals 今日目标读写 ===');
  {
    const g0 = await j('/api/goals');
    t('GET 返回默认值', g0?.ok === true);
    const w = await post('/api/goals', { text: '完成 PRD 撰写练习，复盘 1 个 BadCase', targetTasks: 5 });
    t('POST 保存成功', w?.ok === true && w.targetTasks === 5);
    const g1 = await j('/api/goals');
    t('回读一致（真的落库了）', g1?.text === '完成 PRD 撰写练习，复盘 1 个 BadCase' && g1.targetTasks === 5);
    t('目标数被限制在 1~20', (await post('/api/goals', { text: 'x', targetTasks: 999 })).targetTasks === 20);
    await post('/api/goals', { text: '', targetTasks: 4 });
  }

  console.log('\n=== 3. 活动流：写操作是否自动记录 ===');
  {
    // 触发一次写操作
    await post('/api/learned', { id: 'd5', on: true });
    await new Promise(r => setTimeout(r, 220));
    const c = await j('/api/checkins');
    t('checkins 返回 ok', c?.ok === true);
    t('有打卡数据', (c?.days || []).length >= 1, `${(c?.days || []).length} 天`);
    const today = (c?.days || []).slice(-1)[0];
    t('今天的记录含事件', (today?.events || 0) >= 1, JSON.stringify(today?.kinds || {}));
    t('带知识点标题（不是空壳）', (today?.titles || []).length >= 1, (today?.titles || []).join('、'));
    console.log(`    数据来源：${c?.activitySource}`);
    await post('/api/learned', { id: 'd5', on: false });
  }

  console.log('\n=== 4. /api/portfolio 作品集 CRUD ===');
  {
    const l0 = await j('/api/portfolio');
    t('GET 返回数组', Array.isArray(l0?.items));
    const w = await post('/api/portfolio', { title: '合同条款提取智能体', type: 'agent', docId: 'd1', summary: '用扣子搭的，验证 RAG + 工作流' });
    t('POST 新增成功', w?.ok === true && !!w.item?.id);
    t('  自动补了关联知识点标题', !!w.item?.docTitle, w.item?.docTitle);
    t('  拒绝空标题', (await post('/api/portfolio', { title: '' })).error !== undefined);
    const l1 = await j('/api/portfolio');
    t('列表里有刚新增的', (l1?.items || []).some(x => x.title === '合同条款提取智能体'));
    const del = await req('/api/portfolio?id=' + encodeURIComponent(w.item.id), { method: 'DELETE' });
    t('DELETE 删除成功', (await del.json()).ok === true);
    const l2 = await j('/api/portfolio');
    t('删除后不在列表', !(l2?.items || []).some(x => x.title === '合同条款提取智能体'));
  }

  console.log('\n=== 5. /api/playground API 实验 ===');
  {
    const bad = await post('/api/playground', { url: 'not-a-url' });
    t('拒绝非法 URL', !!bad?.error, bad?.error?.slice(0, 30));
    const priv = await post('/api/playground', { url: 'http://127.0.0.1:9/x' });
    t('拒绝内网地址（防 SSRF）', priv?.code === 'PRIVATE_HOST_BLOCKED');
    // 真实外呼：打本项目自己的 /api/health，验证代理链路真的通
    const real = await post('/api/playground', { url: `http://127.0.0.1:${PORT}/api/health`, allowPrivate: true });
    t('允许内网后真实请求成功', real?.ok === true && real.status === 200, `status=${real?.status} ${real?.elapsedMs}ms`);
    t('  返回了 JSON 解析结果', real?.bodyJson?.docs === 240, `docs=${real?.bodyJson?.docs}`);
    t('  不回显 set-cookie / authorization', !Object.keys(real?.headers || {}).some(k => /set-cookie|authorization/i.test(k)));
    // 外网真实请求（若网络不可达则允许失败，但要返回结构化错误）
    const ext = await post('/api/playground', { url: 'https://httpbin.org/get' });
    t('外网请求返回结构化结果', ext?.ok === true || typeof ext?.error === 'string',
      ext?.ok ? `HTTP ${ext.status} ${ext.elapsedMs}ms` : ('已优雅失败：' + String(ext?.error).slice(0, 40)));
  }

  console.log('\n=== 6. 多用户隔离：新端点也要隔离 ===');
  {
    const jarA = cookie;
    await post('/api/portfolio', { title: 'A的作品-隔离测试' });
    const aSees = (await j('/api/portfolio')).items.some(x => x.title === 'A的作品-隔离测试');
    t('访客A 能看到自己的作品', aSees);
    // 换一个访客
    cookie = '';
    const bSees = (await j('/api/portfolio')).items.some(x => x.title === 'A的作品-隔离测试');
    t('访客B 看不到访客A 的作品', !bSees);
    cookie = jarA;
    // 清理
    const items = (await j('/api/portfolio')).items.filter(x => x.title === 'A的作品-隔离测试');
    for (const it of items) await req('/api/portfolio?id=' + encodeURIComponent(it.id), { method: 'DELETE' });
  }

  console.log('\n=== 7. 原有端点未受影响 ===');
  {
    const h = await j('/api/health');
    t('/api/health 正常', h?.docs === 240);
    const tr = await j('/api/tree');
    t('/api/tree 正常', tr?.tree?.length === 10);
    const s = await j('/api/search?q=RAG');
    t('/api/search 正常', (s?.hits || []).length > 0);
  }

  console.log(`\n===== 合计：PASS ${pass} / FAIL ${fail} =====`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('异常:', e); process.exit(2); });
