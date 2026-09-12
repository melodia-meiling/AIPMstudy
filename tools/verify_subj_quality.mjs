/* =============================================================================
 * verify_subj_quality.mjs —— 主观题反馈的「内容质量」验证（不只是结构）
 * -----------------------------------------------------------------------------
 * 为什么单独做这个：
 *   verify_ui_e2e.mjs 只能验证「三段反馈有没有渲染出来、有没有存下来」。
 *   但主观题练习真正的价值在于反馈**是不是忠实于学员的思路**。
 *   有一次实测发现了真问题：学员的思路写的是「客服工单抽字段」，而题目问的是
 *   「企业培训学习效果」——AI 默默把场景换成了题目的场景，学员的回答被覆盖，
 *   他根本不知道自己答错了题。这类问题结构断言查不出来，只能读内容。
 *
 * 本脚本用固定题目 + 固定思路，验证两件事：
 *   A. 思路与题目「对不上」时：必须在 ② 里点出错位，且 ① 不能把学员的场景偷换掉
 *   B. 思路与题目「对得上」时：① 要沿着学员自己的场景补全，且引用学员的原话
 *
 * 用法：node tools/verify_subj_quality.mjs
 * 前置：后端已启动（会真实调用大模型，约 2 次）
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
// 只做「观察记录」用：模型的行为有合理波动，不适合写成硬断言，
// 但值得打印出来让人看到它到底怎么说的（避免把不确定的东西伪装成确定）
const note = (msg) => console.log('  · 观察：' + msg);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  for (;;) {
    let v = false;
    try { v = await fn(); } catch (e) {}
    if (v) return true;
    if (Date.now() - t0 > ms) throw new Error('等待超时：' + label);
    await sleep(150);
  }
}

/* ------------------------------- 环境 ------------------------------------- */

const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const appSrc = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');

const document = createDOM(html);
const myFetch = makeFetch(BASE);
myFetch.jar.set('aipm_uid', 'e2e_verify_bucket');

const windowObj = {
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  addEventListener() {}, scrollTo() {},
  location: { origin: BASE, hostname: '127.0.0.1', href: BASE + '/' },
};
Object.assign(globalThis, {
  document: document, window: windowObj,
  localStorage: makeLocalStorage(),
  location: windowObj.location,
  fetch: myFetch,
  alert: m => console.log('  [alert] ' + m),
  confirm: () => true, prompt: () => null,
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  requestAnimationFrame: cb => setTimeout(cb, 0),
});

try {
  vm.runInThisContext(appSrc + '\n;globalThis.__T={S:S,go:go,subjSubmit:subjSubmit,splitSubjFeedback:splitSubjFeedback,subjFeedbackPrompt:subjFeedbackPrompt};',
    { filename: 'public/app.js' });
} catch (e) {
  console.log('app.js 执行失败：' + e.message);
  process.exit(1);
}
const T = globalThis.__T;

console.log('==============================================================');
console.log(' 主观题反馈质量验证（真实调用大模型，验证反馈是否忠实于学员思路）');
console.log('==============================================================\n');

await waitFor(() => T.S.stats, 15000, '启动');

// 固定题目：客服工单场景（避免每次生成不一样的题导致断言不稳定）
const FIXED_Q = [
  '【业务背景】',
  '你在一家做跨境电商 SaaS 的公司，产品帮卖家管理多平台店铺。目前付费卖家 3200 家，客服团队 18 人。',
  '上个季度客服平均首次响应时间从 4 分钟涨到 11 分钟，投诉量上升 40%，客服离职了 3 个人。',
  '',
  '【需求场景】',
  '客服每天要处理约 900 条工单，其中六成是「我的订单为什么还没到」这类重复问题。',
  '客服主管希望能自动从工单里抽出关键字段（平台、订单号、问题类型、紧急程度），先把重复问题自动回复掉。',
  '',
  '【你的任务】',
  '请产出：1. 目标用户与场景；2. 从工单进来到自动回复的核心流程；3. 功能清单与优先级；4. 成功指标与不做的边界。',
  '',
  '【交付要求】',
  '只需要写思路和框架，不用写完整文档，建议 200-400 字。',
].join('\n');

function runSubmit(idea, label) {
  const j = T.S.subj;
  j.docId = 'd1';
  j.docTitle = 'BRD';
  j.dir = 'prd';
  j.question = FIXED_Q;
  j.round = 0;
  j.lastIdea = '';
  j.lastFeedback = '';
  const box = document.getElementById('subjIdea');
  box.value = idea;
  return new Promise(async (resolve) => {
    document.getElementById('btnSubjSubmit').onclick();
    try {
      await waitFor(() => {
        const el = document.getElementById('subjFeedback');
        return el.textContent.indexOf('优化后的规范完整版本') >= 0 && !document.getElementById('btnSubjSubmit').disabled;
      }, 240000, label);
    } catch (e) {
      console.log('  ! ' + label + ' 超时或失败');
    }
    resolve(j.feedback || '');
  });
}

/* ---------------------- A. 思路与题目场景对不上 ---------------------- */

console.log('[A] 学员思路与题目场景错位（题目=客服工单，思路=企业培训）');
const MISMATCH_IDEA = [
  '1. 目标用户是中小企业 HR，他们花了钱但看不出员工学没学会。',
  '2. 先做学后测评，再做效果报告，让 HR 能向老板交代。',
  '3. 用报告查看率和续费率衡量。',
].join('\n');

const fbA = await runSubmit(MISMATCH_IDEA, '错位场景反馈');
const partsA = T.splitSubjFeedback(fbA);
t('① 三段结构解析成功', !!partsA);
if (partsA) {
  const miss = partsA.miss;
  const fin = partsA.final;
  console.log('  · ② 开头：' + miss.replace(/\s+/g, ' ').slice(0, 120));
  // 关键断言：必须点出场景错位
  t('② 点出了「场景/业务对不上」这条错位',
    /对不上|错位|不一致|不是同一|题目(问|说)的是|场景不符|看错题|答的不是/.test(miss.slice(0, 300)),
    miss.replace(/\s+/g, ' ').slice(0, 100));
  // 关键断言：不能把学员的场景偷换掉
  t('① 仍然沿着学员写的场景（HR / 培训）补全，没有偷换成题目场景',
    /HR|培训|员工|学习效果/.test(fin) && !/^[\s\S]{0,80}跨境电商/.test(fin),
    fin.replace(/\s+/g, ' ').slice(0, 100));
  t('② 引用了学员原话里的词（HR / 学后测评 / 效果报告 之类）',
    /HR|学后测评|效果报告|续费率/.test(miss));
}

/* ---------------------- B. 思路与题目场景对得上 ---------------------- */

console.log('\n[B] 学员思路与题目场景一致（都是客服工单）');
const MATCH_IDEA = [
  '1. 目标用户是那 18 个客服，他们每天被重复问题淹没。',
  '2. 流程：工单进来 → 抽字段 → 命中重复问题库就自动回复 → 没命中转人工。',
  '3. 先做抽字段和重复问题识别，自动回复放第二期。',
  '4. 用首次响应时间和自动解决率衡量，不做全渠道工单系统。',
].join('\n');

const fbB = await runSubmit(MATCH_IDEA, '一致场景反馈');
const partsB = T.splitSubjFeedback(fbB);
t('① 三段结构解析成功', !!partsB);
if (partsB) {
  const fin = partsB.final, miss = partsB.miss;
  console.log('  · ① 开头：' + fin.replace(/\s+/g, ' ').slice(0, 120));
  t('① 沿着学员自己的方案补全（能看出抽字段/自动回复这条线）',
    /抽字段|字段|自动回复|重复/.test(fin));
  t('① 没有把学员的优先级判断改掉（第二期做自动回复这类判断被保留）',
    /第二期|二期|后置|往后放|后续/.test(fin) || /先做/.test(fin),
    fin.replace(/\s+/g, ' ').slice(0, 60));
  t('② 引用了学员原话里的词（18 个客服 / 首次响应 / 自动解决率）',
    /18|首次响应|自动解决率|重复问题/.test(miss));
  // 本题场景是一致的，所以绝不能把学员的思路判成「答错了题」。
  // 这里只断言「没有明确说学员答错题」这种硬错误；至于模型会不会顺带提一句
  // 「参考资料里混进了别的场景」，属于合理波动，用观察记录打出来而不是硬断言。
  const accuses = /看错题|答的不是|你写的是.{0,16}(HR|培训)[\s\S]{0,20}(错位|对不上)/.test(miss.slice(0, 400));
  t('② 没有把学员的思路误判成「答错了题」', !accuses,
    accuses ? miss.replace(/\s+/g, ' ').slice(0, 100) : '');
  note(/参考资料|参考材料|混进|无关/.test(miss)
    ? '模型提到「参考资料里混进了别的场景」——这是历史练习记录被当作参考材料喂进来的副作用（见 README 局限说明），它没有照抄，只是提醒你'
    : '模型这次直接给了要素反馈，没有提及参考资料');
  t('① 没有被历史练习记录带偏（不该出现上一题的培训场景）',
    !/学吧|企业培训|培训 SaaS/.test(fin),
    fin.replace(/\s+/g, ' ').slice(0, 100));
  t('③ 讲清楚了结构顺序的理由', partsB.why.length > 100, 'len=' + partsB.why.length);
}

console.log(`\n===== 合计：PASS ${pass} / FAIL ${fail} =====`);
process.exit(fail ? 1 : 0);
