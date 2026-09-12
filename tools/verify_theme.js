#!/usr/bin/env node
/**
 * verify_theme.js —— 设计系统落地校验（奶油风）
 * =====================================================================
 * 背景（重要，别当成鸡肋）：
 *   上一代前端的做法是「styles.css 是旧深色主题本体 + theme.css 用 117 条
 *   body[data-theme] 规则去覆盖它」。那次改版的目标 DOM 已经不存在了。
 *   现在反过来：styles.css **本身就是**奶油风设计系统，theme.css 退休成占位文件。
 *
 * 这个脚本因此校验四件事：
 *   A. 主题文件的角色是否正确（theme.css 不能再藏样式；旧覆盖规则必须清零）
 *   B. 设计规范的色值/圆角/间距是否原样落地
 *   C. 工作台与设计稿 dashboard.html 的色值是否一致（防止两边各改各的、慢慢跑偏）
 *   D. 旧深色主题的残留色值是否清干净（残留会让某些元素在浅色底上「看起来坏了」）
 *
 * 命令：node tools/verify_theme.js
 * =====================================================================
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(PUB, 'styles.css'), 'utf8');
const theme = fs.readFileSync(path.join(PUB, 'theme.css'), 'utf8');
const mock = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');

let pass = 0, fail = 0;
const t = (n, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++; };

/* ============ A. 主题文件的角色 ============ */

console.log('=== A1. 引用顺序与职责 ===');
const links = [...html.matchAll(/<link[^>]*href="([^"]+)"[^>]*>/g)].map(m => m[1]);
console.log('  link 顺序：' + links.join(' → '));
t('引用了 styles.css（设计系统本体）', links.includes('styles.css'));
t('仍然引用 theme.css（避免旧缓存 404）', links.includes('theme.css'));
t('styles.css 在 theme.css 之前', links.indexOf('styles.css') < links.indexOf('theme.css'));
t('link 全部是相对路径', links.every(x => !/^(https?:)?\/\//.test(x)));
t('<body> 保留 data-theme 属性（主题切换预留）', /<body[^>]*data-theme="cream"/.test(html));

console.log('\n=== A2. theme.css 已退休 ===');
// 「有样式」的判定：出现 `选择器 { 属性: 值` 这种块级规则
const themeRule = /[^{}\/\n][^{}\n]*\{[^{}]*:[^{}]*\}/.test(theme.replace(/\/\*[\s\S]*?\*\//g, ''));
t('theme.css 不再包含任何样式规则', !themeRule, theme.length + ' 字节（纯说明）');
t('theme.css 不含旧的 body[data-theme] 覆盖选择器',
  !/^\s*body\[data-theme\]/m.test(theme.replace(/\/\*[\s\S]*?\*\//g, '')));
t('styles.css 内部不再嵌套依赖 theme.css 的提权前缀',
  !/body\[data-theme\]/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')));

/* ============ B. 设计规范落地 ============ */

console.log('\n=== B1. 规范色值（应与设计稿一致）===');
const SPEC = [
  ['页面背景 #F4F1EB', '#F4F1EB', '--cream'],
  ['卡片底色 #F9F6F1', '#F9F6F1', '--milk'],
  ['暖橙主色 #E89B68', '#E89B68', '--orange'],
  ['柔黄 #F2D188', '#F2D188', '--orange-soft'],
  ['砖红 #D87060', '#D87060', '--brick'],
  ['主文字 #333333', '#333333', '--ink'],
  ['次要文字 #777777', '#777777', '--muted'],
];
for (const [n, c, varName] of SPEC) {
  t(n, css.includes(c) && new RegExp(varName.replace(/-/g, '\\-') + ':\\s*' + c, 'i').test(css), varName);
}

console.log('\n=== B2. 规范尺寸 ===');
for (const [n, re] of [
  ['卡片圆角 18px', /--r-card:\s*18px/],
  ['卡片间距 24px', /--gap:\s*24px/],
  ['侧栏宽度 248px（1440 画布下）', /--side-w:\s*248px/],
  ['柔和阴影（极淡两层）', /--shadow-soft:\s*0 1px 2px[\s\S]{0,80}0 \d+px \d+px/],
  ['Inter 字体优先', /font-family:\s*Inter/],
  ['中文回退链完整（PingFang / YaHei）', /"PingFang SC"[\s\S]{0,40}"Microsoft YaHei"/],
]) t(n, re.test(css));

/* ============ C. 与设计稿不跑偏 ============ */

console.log('\n=== C1. 工作台 vs 设计稿色值一致 ===');
for (const [n, c] of SPEC) {
  t('设计稿里也有 ' + c, mock.includes(c));
}
// 反向：设计稿用什么色，styles.css 就得有，避免「设计稿加了新色但工作台没跟上」
const mockHex = [...new Set([...mock.matchAll(/#[0-9A-Fa-f]{6}/g)].map(m => m[0].toUpperCase()))];
const specHex = new Set(SPEC.map(x => x[1].toUpperCase()));
const missing = mockHex.filter(c => !css.toUpperCase().includes(c) && !specHex.has(c));
t('设计稿用到的每个色值都能在 styles.css 里找到（或属于渐变辅色）', missing.length === 0,
  missing.length ? 'styles.css 里缺：' + missing.join(', ') : mockHex.length + ' 个色值全部覆盖');

/* ============ D. 旧主题残留 ============ */

console.log('\n=== D1. 旧深色主题残留清零 ===');
const RESIDUE = [
  ['深色侧栏变量 --nav1/--nav2', /--nav[12]\b/],
  ['深蓝色主色 #1a1f36 系列', /#1a1f36|#232a45|#0f1425/i],
  ['正文浅色 #e8ecf5 系列（深色主题专用）', /#e8ecf5|#c9d1e6/i],
  ['绿色主按钮 --brand:', /--brand:/],
  ['浅色叶子变量 --lnk:', /--lnk:/],
];
for (const [n, re] of RESIDUE) t('已清除：' + n, !re.test(css));

const cssNoComment = css.replace(/\/\*[\s\S]*?\*\//g, '');
// 只关心「布局面」被涂成深色（那才是旧深色主题的残留特征）。
// API 实验页的 .code-block 是刻意做成深色的代码块，不算残留。
t('布局面（body / 侧栏 / 顶栏 / 主区）没有写死的深色背景',
  !/(?:^|\})\s*(?:body|\.sidebar|\.topbar|\.main|\.app)\s*\{[^}]*background(?:-color)?:\s*#(0|1|2)[0-9a-f]{5}/i
    .test(cssNoComment));

/* ============ 汇总 ============ */
console.log(`\n===== 合计：PASS ${pass} / FAIL ${fail} =====`);
process.exit(fail ? 1 : 0);
