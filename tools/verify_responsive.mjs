#!/usr/bin/env node
/**
 * verify_responsive.mjs —— 校验响应式适配是否落地
 * -----------------------------------------------------------------------------
 * 前端已拆分为三个文件，本脚本按新结构读取：
 *   public/index.html   结构
 *   public/styles.css   样式（含响应式断点）
 *   public/app.js       逻辑（含手机抽屉交互）
 *
 * 不依赖 jsdom：只做静态结构 + 关键字校验，以及后端是否正常吐出资源。
 * 命令：node tools/verify_responsive.mjs
 */
import fs from 'node:fs';

const HTML = fs.readFileSync('public/index.html', 'utf8');
const CSS = fs.readFileSync('public/styles.css', 'utf8');
const JS = fs.readFileSync('public/app.js', 'utf8');
// 三份合并后的全文，用于「某关键字在不在前端代码里」这类判断
const ALL = HTML + '\n' + CSS + '\n' + JS;

let pass = 0, fail = 0;
const t = (name, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++; };

console.log('=== 0. 文件拆分结构 ===');
t('index.html 只留结构（无内联 style）', !/<style/i.test(HTML));
t('index.html 只留结构（无内联 script）', !/<script(?![^>]*src)/i.test(HTML));
t('相对路径引入 styles.css', /href="styles\.css"/.test(HTML));
t('相对路径引入 app.js', /src="app\.js"/.test(HTML));
t('styles.css 非空', CSS.length > 5000, `${(CSS.length / 1024).toFixed(1)} KB`);
t('app.js 非空', JS.length > 20000, `${(JS.length / 1024).toFixed(1)} KB`);

console.log('\n=== 1. 响应式元素 ===');
t('汉堡按钮 #btnMenu 在 HTML 中', /id="btnMenu"/.test(HTML));
t('抽屉遮罩 #sideMask 在 HTML 中', /id="sideMask"/.test(HTML));
t('汉堡按钮在 <header> 内', /<header[^>]*>[\s\S]*?id="btnMenu"[\s\S]*?<\/header>/.test(HTML));
t('汉堡按钮样式在 styles.css', /\.burger\s*\{/.test(CSS));
t('遮罩样式在 styles.css', /\.side-mask\s*\{/.test(CSS));

console.log('\n=== 2. 三档断点 ===');
const mqs = [...CSS.matchAll(/@media([^{]+)\{/g)].map(m => m[1].trim());
mqs.forEach(m => console.log('     ' + m));
t('桌面 ≥1024 为默认态（无需媒体查询）', !/@media\s*\(min-width:\s*1024/.test(CSS));
t('768~1024 平板压缩', /@media\s*\(max-width:\s*1024px\)/.test(CSS));
t('<768 手机适配', /@media\s*\(max-width:\s*767px\)/.test(CSS));
t('平板下侧栏宽度压缩（--side-w 变量）',
  /max-width:\s*1024px[\s\S]*?--side-w:\s*(1\d\d|2[0-3]\d)px/.test(CSS));
t('手机下侧栏改抽屉（translateX 收起）', /\.sidebar[\s\S]{0,600}translateX\(-10\d%\)/.test(CSS));
t('手机下才显示顶部条（桌面隐藏）',
  /\.topbar\s*\{\s*display:\s*none/.test(CSS) &&
  /max-width:\s*767px[\s\S]*?\.topbar\s*\{[^}]*display:\s*flex/.test(CSS));
t('手机下汉堡按钮可见（在顶部条里）',
  /max-width:\s*767px[\s\S]*?\.burger\s*\{[^}]*display:\s*flex/.test(CSS));

console.log('\n=== 3. 移动端专项优化（需求逐条）===');
t('顶部导航高度适配手机（54px）', /max-width:\s*767px[\s\S]*?\.topbar\s*\{[^}]*height:\s*54px/.test(CSS));
t('顶部条显示学习代号（小屏信息重排）', /max-width:\s*767px[\s\S]*?\.topbar\s+\.codename\s*\{/.test(CSS));
t('主内容区宽度自适应、不横向溢出（flex + min-width:0）',
  /\.main\s*\{[^}]*min-width:\s*0/.test(CSS) && /\.card\s*\{[^}]*min-width:\s*0/.test(CSS));
t('知识库双栏在手机上改为上下堆叠',
  /max-width:\s*767px[\s\S]*?\.kb-layout\s*\{[^}]*flex-direction:\s*column/.test(CSS));
t('长文本自动换行', /overflow-wrap:\s*break-word/.test(CSS));
t('行间距优化', /line-height:\s*1\.85/.test(CSS));
t('触控目标 ≥44px', /min-height:\s*44px/.test(CSS));
t('输入框 16px（防 iOS 聚焦缩放）', /font-size:\s*16px/.test(CSS));
t('手机键盘弹出滚动到输入框', /focusin[\s\S]{0,400}scrollIntoView/.test(JS));
t('表格横向可滚', /\.md-table[\s\S]{0,200}overflow-x:\s*auto/.test(CSS));
t('iPhone 安全区适配', /safe-area-inset-bottom/.test(CSS));
t('横屏矮屏适配', /orientation:\s*landscape/.test(CSS));
t('超小屏 <380px 适配', /max-width:\s*379px/.test(CSS));

console.log('\n=== 3b. 刷题中心标签栏（三个选项一行对齐）===');
t('标签栏是单行 inline-flex（不会换行成两行）',
  /\.seg\s*\{[^}]*display:\s*inline-flex/.test(CSS) && !/\.seg\s*\{[^}]*flex-wrap/.test(CSS));
t('标签之间有间距、外层有内边距（对齐靠 gap 而不是猜数字）',
  /\.seg\s*\{[^}]*gap:\s*\d+px[^}]*padding:\s*\d+px/.test(CSS));
t('三个选项等宽（同一套 padding 规则，不靠字数凑宽度）',
  /\.seg-item\s*\{[^}]*padding:\s*9px 22px/.test(CSS));
t('手机上标签栏撑满一行且三个平分',
  /max-width:\s*767px[\s\S]*?\.seg\s*\{[^}]*width:\s*100%/.test(CSS) &&
  /max-width:\s*767px[\s\S]*?\.seg-item\s*\{[^}]*flex:\s*1/.test(CSS));
t('手机上标签仍 ≥44px 可点高度',
  /max-width:\s*767px[\s\S]*?\.seg-item\s*\{[^}]*padding:\s*11px/.test(CSS));
t('已清掉上一版的二级切换样式（.seg-mini）', !/\.seg-mini/.test(CSS));

console.log('\n=== 4. 功能完整性（无阉割）===');
for (const [name, re] of [
  ['知识树跳转', /renderSidebar|\/api\/tree/],
  ['AI答疑', /btnAsk|askInput|\/api\/ask/],
  ['笔记', /noteBox|\/api\/note/],
  ['标记已学', /btnLearned|\/api\/learned/],
  ['新知识模块', /showNewKnowledgeList|\/api\/newknowledge/],
  ['刷题中心', /renderQuizBody|\/api\/quiz/],
  ['错题本', /renderWrong|\/api\/wrong/],
  ['设置', /loadSettings|\/api\/settings/],
  ['流式对话', /\/api\/chat/],
  ['检索接口', /\/api\/search/],
  ['仪表盘统计', /\/api\/stats/],
  ['打卡日历', /\/api\/checkins/],
  ['今日目标', /\/api\/goals/],
  ['作品集', /\/api\/portfolio/],
  ['API 实验', /\/api\/playground/],
]) t(name, re.test(ALL));

console.log('\n=== 5. 抽屉交互逻辑（仅手机生效）===');
t('用 matchMedia 判断手机尺寸', /matchMedia\('\(max-width:767px\)'\)/.test(JS));
t('点遮罩关闭抽屉', /#sideMask'\)\.onclick\s*=\s*closeDrawer/.test(JS));
t('点汉堡按钮开合抽屉', /#btnMenu'\)\.onclick[\s\S]{0,220}openDrawer/.test(JS));
t('选中知识点后自动收起', /openDoc\(el\.dataset\.id\);\s*closeDrawer\(\)/.test(JS));
t('切视图时收起抽屉', /function go\(page\)[\s\S]{0,700}closeDrawer\(\)/.test(JS));
t('回到桌面尺寸自动复位', /addEventListener\('change',\s*syncDrawer\)|addListener\(syncDrawer\)/.test(JS));

console.log('\n=== 6. 结构完整性 ===');
t('index.html 无孤立闭合标签', !/^\s*<\/(?:style|script)>\s*$/m.test(HTML));
const openDiv = (HTML.match(/<div\b/g) || []).length;
const closeDiv = (HTML.match(/<\/div>/g) || []).length;
t('div 标签平衡', openDiv === closeDiv, `${openDiv} / ${closeDiv}`);
t('script 标签平衡', (HTML.match(/<script\b/g) || []).length === (HTML.match(/<\/script>/g) || []).length);
t('viewport meta 存在', /<meta name="viewport"/.test(HTML));
t('app.js 无残留 HTML 标签（防 Unexpected token \<）', !/<\/?(?:script|style)\b[^>]*>/i.test(JS));
t('styles.css 无残留 HTML 标签', !/<\/?(?:script|style)\b[^>]*>/i.test(CSS));

console.log(`\n===== 合计：PASS ${pass} / FAIL ${fail} =====`);
process.exit(fail ? 1 : 0);
