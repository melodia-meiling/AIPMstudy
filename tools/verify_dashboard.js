#!/usr/bin/env node
/**
 * verify_dashboard.js —— 校验 dashboard.html
 * =====================================================================
 * 两部分：
 *   A. 设计规范符合度（色彩/尺寸/布局/六张卡片/组件规范/无效 Tailwind 类）
 *   B. 结构完整性（标签配平 / 语义 / 无占位内容）
 *
 * 命令：node tools/verify_dashboard.js
 * =====================================================================
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, '..', 'dashboard.html');
const h = fs.readFileSync(FILE, 'utf8');

let pass = 0, fail = 0;
const t = (n, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++; };

/* ============================ A. 设计规范 ============================ */

console.log('=== A1. 色彩规范（规范值原样出现）===');
for (const [n, c] of [
  ['页面背景 #F4F1EB', '#F4F1EB'], ['卡片底色 #F9F6F1', '#F9F6F1'],
  ['暖橙 #E89B68', '#E89B68'], ['柔黄 #F2D188', '#F2D188'], ['砖红 #D87060', '#D87060'],
  ['主文字 #333333', '#333333'], ['次要文字 #777777', '#777777'],
]) t(n, h.includes(c));

console.log('\n=== A2. 字体与尺寸 token ===');
t('Inter 字体已引入', /family=Inter/.test(h) && /sans:\s*\['Inter'/.test(h));
t('卡片圆角 18px', /card:\s*'18px'/.test(h));
t('卡片间距 24px', /gutter:\s*'24px'/.test(h));
t('极淡柔和阴影（双层低透明度）', /boxShadow:\s*\{[\s\S]*?rgba\(51,51,51,\.0\d\)/.test(h));
t('无厚重黑阴影', !/rgba\(0,\s*0,\s*0,\s*0\.[3-9]/.test(h));
t('1440px 页面宽度', /w-\[1440px\]/.test(h));
t('未使用暗黑模式', !/dark:/.test(h));

console.log('\n=== A3. 布局结构 ===');
t('左右分栏 aside + main', /<aside/.test(h) && /<main/.test(h));
t('侧边栏背景 = 页面背景', /<aside[^>]*bg-cream/.test(h));
t('侧边栏固定窄宽度', /<aside[^>]*w-\[248px\]/.test(h));
for (const x of ['AIPM工作台', '仪表盘主页', '知识库文档', '刷题中心', 'API实验', '任务日历', '项目作品集', '设置'])
  t(`导航「${x}」`, h.includes(x));
t('底部用户头像卡片', /转行 AI 产品经理/.test(h));

console.log('\n=== A4. 顶部栏 ===');
t('问候语 Hi！美玲', h.includes('Hi！美玲'));
t('副标题「今天继续AI产品学习」', h.includes('今天继续AI产品学习'));
t('搜索框', /placeholder="搜索课程、案例、练习"/.test(h));
t('Upgrade 深色填充圆角按钮',
  /<button class="[^"]*bg-slate[^"]*text-white[^"]*"[^>]*>\s*Upgrade/.test(h.replace(/\s*\n\s*/g, ' ')));

console.log('\n=== A5. 六张卡片 ===');
for (const x of ['Learning Results for Today', 'Learning Schedule', "Today's Target", 'My Practices', 'Growth Plan', 'AI Tutor'])
  t(`卡片「${x}」`, h.includes(x));
t('卡片类统一 rounded-card（6 张）', (h.match(/rounded-card/g) || []).length === 6,
  `${(h.match(/rounded-card/g) || []).length} 张`);

console.log('\n=== A6. 卡片1 占 2 列宽度 ===');
t('卡片1 有 col-span-2', /class="col-span-2 rounded-card/.test(h));
t('其余 5 张不跨列', (h.match(/class="rounded-card/g) || []).length === 5,
  `${(h.match(/class="rounded-card/g) || []).length} 张单列`);
t('网格 2 列 + 24px 间距', /grid grid-cols-2 gap-gutter/.test(h));

console.log('\n=== A7. 各卡片内部要素 ===');
t('卡片1 三色图例齐全', /累计学习时长/.test(h) && /练习完成数量/.test(h) && /阅读文档页数/.test(h));
t('卡片1 气泡柔和渐变 + 柔边', /bg-gradient-to-br/.test(h) && /blur-\[/.test(h));
t('卡片2 月份选择器', /2026 年 9 月/.test(h));
t('卡片2 三色圆点图例', /已完成/.test(h) && /待学习/.test(h) && /计划任务/.test(h));
t('卡片3 环形进度（68%）', /stroke-dasharray="213\.6 314\.16"/.test(h));
t('卡片3 修改目标图标', /aria-label="修改目标"/.test(h));
t('卡片4 Add New 按钮', /Add New/.test(h));
for (const p of ['PRD 撰写', 'Agent 搭建', 'API 对接', '需求分析']) t(`  练习项「${p}」`, h.includes(p));
t('  4 条参考资料', (h.match(/参考资料：/g) || []).length === 4);
t('  4 条更多操作按钮', (h.match(/aria-label="更多操作"/g) || []).length === 4);
t('卡片5 横向长进度条', /h-3 w-full overflow-hidden rounded-full bg-cream/.test(h));
t('卡片5 起点终点标注', /起点 · 认知启蒙/.test(h) && /终点 · 可面试/.test(h));
t('卡片6 输入框 + 快捷提问', /placeholder="输入你的学习问题…"/.test(h) && /RAG 和微调怎么选？/.test(h));

console.log('\n=== A8. 无效 Tailwind 类检测 ===');
const classes = new Set();
for (const m of h.matchAll(/class="([^"]+)"/g)) for (const c of m[1].split(/\s+/)) if (c) classes.add(c);
const all = [...classes];
const invalid = [];
for (const c of all) {
  if (/^font-\d+$/.test(c)) invalid.push(c + ' → 应用 font-bold / font-medium');
  if (/^(bg|text|border|rounded|shadow|p|m|gap|w|h|col|flex|grid)-$/.test(c)) invalid.push(c + ' → 悬空前缀');
}
if (invalid.length) { [...new Set(invalid)].forEach(x => { console.log('    FAIL ' + x); fail++; }); }
else { console.log('  PASS  无无效类'); pass++; }

console.log('\n=== A9. 自定义 token 均已定义 ===');
const custom = all.filter(c => /^(bg|text|border|from|to|via)-(cream|milk|orange|brick|ink|muted|hair|slate)/.test(c));
const undef = [...new Set(custom)].filter(c => {
  const root = c.replace(/^(bg|text|border|from|to|via)-/, '').split('/')[0].split('-')[0];
  return !new RegExp(`\\b${root}:`).test(h);
});
t('所有自定义色 token 均已定义', undef.length === 0, undef.join(', ') || '无遗漏');

console.log('\n=== A10. 几何检查（气泡与右侧摘要不重叠）===');
{
  const cs = h.indexOf('今日学习总览气泡图');
  const ce = h.indexOf('<!-- 图例 -->', cs);
  const chart = h.slice(cs, ce);
  let maxRight = 0;
  for (const m of chart.matchAll(/left-\[(\d+)px\] top-\[(\d+)px\][^"]*?h-\[(\d+)px\] w-\[(\d+)px\]/g)) {
    maxRight = Math.max(maxRight, +m[1] + +m[4]);
  }
  const contentW = 1440 - 248 - 28 - 48;
  const summaryLeft = contentW - 32 - 300;
  console.log(`  气泡群右边界 ≈ ${maxRight}px ｜ 摘要左边界 ≈ ${summaryLeft}px`);
  t('气泡群与右侧摘要不重叠', maxRight < summaryLeft, `${maxRight} < ${summaryLeft}`);
}

console.log('\n=== A11. 静态页面要求 ===');
t('无 addEventListener', !/addEventListener/.test(h));
t('仅 2 个 script（CDN + config）', (h.match(/<script/g) || []).length === 2);

/* ============================ B. 结构完整性 ============================ */

console.log('\n=== B1. 文档骨架 ===');
t('DOCTYPE', /^<!DOCTYPE html>/i.test(h.trim()));
t('lang="zh-CN"', /<html lang="zh-CN">/.test(h));
t('head / body / html 闭合', /<head>/.test(h) && /<\/head>/.test(h) && /<\/body>/.test(h) && /<\/html>/.test(h));
t('charset UTF-8', /<meta charset="UTF-8">/.test(h));

console.log('\n=== B2. 标签配平 ===');
{
  const VOID = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr','path','circle','rect','line','polyline','polygon','stop','use','ellipse']);
  const stack = [], errors = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*?)(\/?)>/g;
  let m;
  while ((m = re.exec(h))) {
    const closing = m[1] === '/', name = m[2].toLowerCase(), selfClose = m[4] === '/';
    if (VOID.has(name) || selfClose) continue;
    if (!closing) stack.push(name);
    else {
      let found = -1;
      for (let i = stack.length - 1; i >= 0; i--) if (stack[i] === name) { found = i; break; }
      if (found < 0) errors.push(`多余的 </${name}>`);
      else {
        const unclosed = stack.splice(found);
        for (let i = 1; i < unclosed.length; i++) errors.push(`<${unclosed[i]}> 未闭合`);
        stack.splice(found, 1);
      }
    }
  }
  stack.forEach(n => errors.push(`<${n}> 未闭合`));
  if (errors.length) { [...new Set(errors)].forEach(e => { console.log('    FAIL ' + e); fail++; }); }
  else { console.log('  PASS  所有标签正确配平'); pass++; }
}

console.log('\n=== B3. 关键标签开闭平衡 ===');
const cnt = re => (h.match(re) || []).length;
for (const [name, o, c] of [
  ['div', /<div\b/g, /<\/div>/g], ['section', /<section\b/g, /<\/section>/g],
  ['button', /<button\b/g, /<\/button>/g], ['span', /<span\b/g, /<\/span>/g],
  ['p', /<p\b/g, /<\/p>/g], ['svg', /<svg\b/g, /<\/svg>/g],
  ['li', /<li\b/g, /<\/li>/g], ['ul', /<ul\b/g, /<\/ul>/g],
]) t(`${name} 平衡`, cnt(o) === cnt(c), `${cnt(o)} / ${cnt(c)}`);

console.log('\n=== B4. 语义与可访问性 ===');
t('气泡图有 role="img" + aria-label', /role="img"/.test(h) && /aria-label="今日学习总览气泡图/.test(h));
t('纯图标按钮都有 aria-label', (h.match(/<button[^>]*aria-label=/g) || []).length >= 5,
  `${(h.match(/<button[^>]*aria-label=/g) || []).length} 个`);

console.log('\n=== B5. 无占位 / 调试残留 ===');
t('无 TODO / FIXME', !/TODO|FIXME/.test(h));
t('无 lorem ipsum', !/lorem ipsum/i.test(h));
t('无 console.log', !/console\.log/.test(h));
t('无空 class', !/class="\s*"/.test(h));
t('无重复 id', (() => { const ids = [...h.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]); return new Set(ids).size === ids.length; })());

console.log('\n=== B6. 体积 ===');
const kb = (Buffer.byteLength(h, 'utf8') / 1024).toFixed(1);
console.log(`  ${kb} KB · ${h.split('\n').length} 行`);
t('单页体积合理（< 80KB）', Number(kb) < 80, `${kb} KB`);

console.log(`\n===== 合计：PASS ${pass} / FAIL ${fail} =====`);
process.exit(fail ? 1 : 0);
