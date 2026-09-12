/* =============================================================================
 * make_github_package.mjs —— 生成「可以直接上传 GitHub」的完整包
 * -----------------------------------------------------------------------------
 * 为什么用脚本而不是手动复制：
 *   1. 上传 GitHub 最怕两件事：漏文件（别人 clone 下来跑不起来）、
 *      多文件（把几百 MB 的模型权重或自己的学习数据推上去）。
 *      这里把「要什么 / 不要什么」写死成清单，每次生成结果一致，也可复查。
 *   2. 生成后会自动做两件检查：必需文件齐不齐、有没有疑似密钥泄漏。
 *
 * 用法：
 *   node tools/make_github_package.mjs            # 生成到工作区根目录
 *   node tools/make_github_package.mjs --out "D:\某处\AIPM工作台-GitHub可上传"
 *
 * 产物位置（默认）：<工作区根>/AIPM工作台-GitHub可上传/
 * ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');                 // mvp/
const WORKSPACE = path.resolve(SRC, '..');            // 工作区根

const outIdx = process.argv.indexOf('--out');
const DEST = outIdx >= 0 && process.argv[outIdx + 1]
  ? path.resolve(process.argv[outIdx + 1])
  : path.join(WORKSPACE, 'AIPM工作台-GitHub可上传');

/* ============================== 清单 ============================== */

// ① 项目根下的单个文件（少了任何一个，clone 下来就跑不起来或部署不了）
const ROOT_FILES = [
  // 运行必需
  'server.js',
  'prompt.md',
  'package.json',
  'package-lock.json',
  'start.bat',
  // 知识库构建链（离线跑，重建 kb.json / 向量时用）
  'build_kb.js',
  'enrich_kb.js',
  'build_embeddings.js',
  'fetch_model.js',
  'patch_book_categories.js',
  // 部署与配置
  'Dockerfile',
  'render.yaml',
  '.env.example',
  '.gitignore',
  '.dockerignore',
  // 文档与设计稿
  'README.md',
  'dashboard.html',
];

// ② 整个目录（递归复制，内部还有各自的过滤）
const DIRS = ['public', 'docs', 'tools'];

// ③ data/ 只带「应用资产」：知识库与向量索引。
//    个人学习数据（笔记/已学/错题/设置）由 .gitignore 排除，
//    服务首次启动会自动创建空文件 —— 别人的 clone 不该看到你的学习记录。
const DATA_FILES = ['kb.json', 'index.json', 'embeddings.json', 'merge_report.json'];

// ④ 工作区根目录下的项目文档 → 放进包里的 docs/项目文档/
const WORKSPACE_DOCS = [
  '01_知识库体检报告.md',
  '02_系统提示词.md',
  '03_功能模块与交互流程.md',
  '04_欢迎语与引导话术.md',
  '05_搭建执行步骤.md',
  '06_知识树结构化导出.md',
  '07_资产对齐与整合诊断.md',
  '08_提示词诊断与原版对照.md',
  '09_系统提示词_精简版.md',
  'kb_book_书单.md',
  'kb_main_六步法.md',
  'kb_main_知识树.md',
  '升级说明.md',
];

// ⑤ 明确不上传的东西（本机保留），以及为什么
const EXCLUDED = [
  ['node_modules/', '依赖，clone 后 npm install 重新装'],
  ['models/', '向量模型权重约 100MB，超过 GitHub 单文件 100MB 限制；Dockerfile 会在构建阶段下载'],
  ['data/notes.json、learned.json、enrich.json、newknowledge.json、quiz.json、wrong.json、activity.json、goals.json、portfolio.json、settings.json', '你自己的学习数据（含搜索 Key），必须留在本机'],
  ['data/backup-*/、data/*.bak*、data/data-new/、data/*.log', '内容治理过程中的备份与日志'],
  ['data-clean/', '「干净数据」单独交付物，与工作台运行无关'],
  ['backup-frontend-*/', '上一代前端的备份'],
  ['_map_appjs.js、_map_settings.js', '一次性调试脚本'],
  ['split_assets.js、repair_split.js、inject_responsive.js、theme.css（根目录）', '上一代「单文件前端拆分」流程的遗留脚本，对新前端已不适用，留着会误导'],
  ['*.tmp、*~、.vscode/、.idea/、Thumbs.db', '临时文件与编辑器配置'],
];

/* ============================== 工具 ============================== */

let copied = 0, bytes = 0;
const missing = [];

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

// 递归数文件（用于统计与说明文档）
function countFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .reduce((a, e) => a + (e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1), 0);
}

function copyFile(from, to) {
  if (!fs.existsSync(from)) { missing.push(path.relative(SRC, from)); return false; }
  ensureDir(path.dirname(to));
  fs.copyFileSync(from, to);
  copied++;
  bytes += fs.statSync(to).size;
  return true;
}

function copyDir(fromDir, toDir, filter) {
  if (!fs.existsSync(fromDir)) { missing.push(path.relative(SRC, fromDir)); return; }
  for (const entry of fs.readdirSync(fromDir, { withFileTypes: true })) {
    const from = path.join(fromDir, entry.name);
    const to = path.join(toDir, entry.name);
    if (filter && !filter(from, entry)) continue;
    if (entry.isDirectory()) copyDir(from, to, filter);
    else copyFile(from, to);
  }
}

// 只放行文本/代码，挡掉误入的二进制与小文件（tools 里可能有临时产物）
const cleanFilter = (from, entry) => {
  if (entry.isDirectory()) return true;
  const n = entry.name;
  if (/\.(tmp|log|bak|onnx|bin|zip|rar|7z)$/i.test(n)) return false;
  if (/\.bak-/.test(n)) return false;
  if (n === '.DS_Store' || n === 'Thumbs.db' || n === 'desktop.ini') return false;
  return true;
};

/* ============================== 开始生成 ============================== */

if (path.resolve(DEST) === path.resolve(SRC)) {
  console.error('✗ 输出目录不能就是项目目录本身');
  process.exit(1);
}
if (fs.existsSync(DEST)) {
  console.log('清理已存在的输出目录：' + DEST);
  fs.rmSync(DEST, { recursive: true, force: true });
}
ensureDir(DEST);

console.log('源目录：' + SRC);
console.log('输出到：' + DEST + '\n');

// 1) 根文件
for (const f of ROOT_FILES) copyFile(path.join(SRC, f), path.join(DEST, f));

// 2) 目录
for (const d of DIRS) copyDir(path.join(SRC, d), path.join(DEST, d), cleanFilter);

// 3) data 应用资产
for (const f of DATA_FILES) copyFile(path.join(SRC, 'data', f), path.join(DEST, 'data', f));

// 4) 工作区项目文档
const docDir = path.join(DEST, 'docs', '项目文档');
for (const f of WORKSPACE_DOCS) copyFile(path.join(WORKSPACE, f), path.join(docDir, f));

if (missing.length) {
  console.error('\n✗ 清单里有 ' + missing.length + ' 个文件没找到（生成结果不完整）：');
  missing.forEach(m => console.error('   - ' + m));
  process.exit(1);
}

/* ============================== 校验 ============================== */

console.log('=== 1. 完整性检查 ===');
const REQUIRED = [
  'server.js', 'package.json', 'package-lock.json', 'prompt.md', '.gitignore', '.dockerignore',
  'Dockerfile', 'render.yaml', '.env.example', 'start.bat', 'README.md', 'dashboard.html',
  'public/index.html', 'public/styles.css', 'public/app.js', 'public/theme.css',
  'data/kb.json', 'data/index.json', 'data/embeddings.json',
];
let okAll = true;
for (const r of REQUIRED) {
  const p = path.join(DEST, r);
  const ok = fs.existsSync(p);
  if (!ok) okAll = false;
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + r + (ok && fs.statSync(p).isFile() ? '  ' + (fs.statSync(p).size / 1024).toFixed(1) + ' KB' : ''));
}
if (!okAll) { console.error('\n✗ 缺少必需文件，包不完整'); process.exit(1); }

console.log('\n=== 2. 密钥与隐私扫描 ===');
// 占位符不算泄漏：sk-xxxxxxx / sk-**** / sk-0000 这类「同一个字符重复」的写法
// 是文档里用来提示格式的，真实密钥不会长这样。
const isPlaceholder = s => {
  const body = String(s).replace(/^Bearer\s+/i, '').replace(/^(sk-|key-)/i, '');
  return /^(.)\1*$/.test(body) || /^[xX*0_.-]+$/.test(body);
};
const SECRET_PATTERNS = [
  [/sk-[A-Za-z0-9_-]{24,}/g, '疑似 DeepSeek/OpenAI 密钥'],
  [/["']?searchKey["']?\s*[:=]\s*["'][A-Za-z0-9_-]{16,}["']/g, '疑似搜索服务密钥'],
  [/Bearer\s+[A-Za-z0-9_-]{24,}/g, '疑似 Bearer Token'],
];
const LOCAL_PATH_PATTERNS = [
  [/E:\\桌面/g, '本机绝对路径（工作区）'],
  [/E:\\deepseek harness/g, '本机 Node 路径'],
];
const hits = [];
const allowed = new Set([path.join(DEST, 'start.bat'), path.join(DEST, 'README.md'),
  path.join(DEST, '.env.example'), path.join(DEST, 'docs', '新增接口文档.md')]);

(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (/\.(png|jpg|jpeg|gif|webp|ico|onnx|woff2?|ttf)$/i.test(e.name)) continue;
    if (fs.statSync(p).size > 3 * 1024 * 1024) continue;
    let txt = '';
    try { txt = fs.readFileSync(p, 'utf8'); } catch { continue; }
    for (const [re, label] of SECRET_PATTERNS) {
      const m = (txt.match(re) || []).filter(s => !isPlaceholder(s));
      if (m.length) hits.push({ file: path.relative(DEST, p), label, sample: m[0].slice(0, 12) + '…' });
    }
    if (!allowed.has(path.resolve(p))) {
      for (const [re, label] of LOCAL_PATH_PATTERNS) {
        const m = txt.match(re);
        if (m) hits.push({ file: path.relative(DEST, p), label, sample: m[0] });
      }
    }
  }
})(DEST);

const secrets = hits.filter(h => h.label.indexOf('疑似') === 0);
if (secrets.length) {
  console.error('  ✗ 发现疑似密钥，绝不能上传：');
  secrets.forEach(h => console.error('     ' + h.file + ' → ' + h.label + '（' + h.sample + '）'));
  process.exit(1);
}
console.log('  ✓ 没有发现疑似密钥（.env.example 里的占位符不算）');
const locals = hits.filter(h => h.label.indexOf('本机') === 0);
if (locals.length) {
  console.log('  ! 这些文件里有本机路径（start.bat/README 里是刻意保留的说明，其它请留意）：');
  locals.forEach(h => console.log('     ' + h.file + ' → ' + h.label + '（' + h.sample + '）'));
} else {
  console.log('  ✓ 没有多余的本机绝对路径');
}

/* ============================== 上传说明 ============================== */

// 这份说明由脚本生成（而不是手写），保证清单变了说明跟着变，不会对不上。
// +1 是这份说明自己（它要写在文档里，所以先算上）
const totalFiles = countFiles(DEST) + 1;
const toolsCount = countFiles(path.join(DEST, 'tools'));
const docsCount = countFiles(path.join(DEST, 'docs'));
const uploadGuide = `# GITHUB上传说明

> 这个文件夹 = AIPM 学习工作台的**完整可运行版本**，可以直接 \`git push\` 到 GitHub。
> 生成时间：${new Date().toISOString().slice(0, 19).replace('T', ' ')}
> 生成方式：\`node tools/make_github_package.mjs\`（源目录：mvp/）

---

## 一、里面有什么（共 ${totalFiles} 个文件 / ${(bytes / 1024 / 1024).toFixed(2)} MB）

\`\`\`
AIPM工作台-GitHub可上传/
├── server.js                 后端主体（单文件：混合检索 + 全部接口 + DeepSeek）
├── prompt.md                 系统提示词（定义「本地知识库优先 + 大模型拓展」的回答规则）
├── package.json              依赖与脚本（npm start / npm run verify:ui 等）
├── package-lock.json         锁定依赖版本，保证别人装出来和你一样
├── start.bat                 Windows 一键启动（会自动找可用的 node）
├── Dockerfile                容器镜像（任何支持 Docker 的平台都能部署）
├── render.yaml               Render 一键部署配置
├── .env.example              环境变量清单与说明（只有 DeepSeek Key 是必填）
├── .gitignore                Git 忽略规则（挡住依赖、模型权重、你的学习数据）
├── .dockerignore             Docker 构建上下文忽略规则
├── README.md                 完整文档：部署手册 + 目录结构 + 检索原理 + 已知局限
├── dashboard.html            设计稿（奶油风仪表盘静态原型，规范值以它为准）
│
├── public/                   前端（4 个文件，引用全用相对路径）
│   ├── index.html            7 个页面的结构壳
│   ├── styles.css            奶油风设计系统 + 三档响应式
│   ├── theme.css             已退休的占位文件（只留说明，无样式）
│   └── app.js                全部前端逻辑（含主观题练习）
│
├── data/                     应用资产（**不是**你的学习数据）
│   ├── kb.json               知识库：240 个知识点
│   ├── index.json            倒排索引（关键词那一路）
│   ├── embeddings.json       语义向量：240 × 768 维
│   └── merge_report.json     知识库合并报告
│
├── docs/
│   ├── 新增接口文档.md        5 个新增端点的详细文档 + 前端页面↔接口对照表
│   └── 项目文档/              13 份设计与治理文档（系统提示词、知识树、执行步骤…）
│                              （docs/ 合计 ${docsCount} 个文件）
│
├── tools/                    ${toolsCount} 个脚本：验证套件 + 知识库加工工具
│   ├── dom_shim.mjs          测试用的 DOM 替身（在 Node 里真跑 app.js）
│   ├── verify_package.mjs    把这个包当成「别人 clone 下来的仓库」跑一遍（39 项断言）
│   ├── verify_*.mjs / .js    13 个验证脚本（见 README 验证一节）
│   ├── make_github_package.mjs  重新生成这个包
│   └── …                     知识库合并/清洗/修复工具
│
└── GITHUB上传说明.md          本文件
\`\`\`

---

## 二、故意**没有**放进去的东西

| 没放 | 原因 |
|---|---|
${EXCLUDED.map(([what, why]) => `| \`${what}\` | ${why} |`).join('\n')}

> 关键点：**.gitignore 已经挡住了个人学习数据和模型权重**。
> 就算你以后在本地跑出了笔记、错题、搜索 Key，\`git add .\` 也不会把它们提交上去。

---

## 三、上传到 GitHub（三步）

在**这个文件夹**里打开终端，依次执行：

\`\`\`bash
git init
git add .
git commit -m "AIPM 学习工作台：知识库 + 混合检索 + 7 页工作台 + 客观题/主观题练习"
git branch -M main
git remote add origin https://github.com/你的用户名/仓库名.git
git push -u origin main
\`\`\`

**推送前建议先看一眼会提交什么**（确认没有敏感文件）：

\`\`\`bash
git add .
git status --short
\`\`\`

预期只看到源码、文档、\`data/\` 里的知识库三件套；
如果看到 \`node_modules/\`、\`models/\`、\`data/notes.json\` 之类，说明 .gitignore 没生效，
先停下来查 \`.gitignore\` 的位置（必须在仓库根目录）。

> 如果 GitHub 提示某个文件超过 100MB：本包最大的是 \`data/index.json\`（约 2MB），
> 不会触发；真正需要小心的是 \`models/\` 里的 .onnx（约 98MB），它已经被忽略。

---

## 四、别人（或你换台电脑）clone 下来怎么跑

\`\`\`bash
git clone https://github.com/你的用户名/仓库名.git
cd 仓库名
npm install

# 必填：大模型密钥（检索类功能不需要它，AI 相关功能需要）
# Windows PowerShell:
$env:DEEPSEEK_API_KEY="sk-你的密钥"
# macOS / Linux:
export DEEPSEEK_API_KEY=sk-你的密钥

npm start          # 打开 http://127.0.0.1:3000
\`\`\`

首次启动会自动创建个人数据文件（笔记、已学、错题…），**不需要手动准备任何数据文件**。

### 关于向量模型（影响检索精度）

| 情况 | 检索表现 |
|---|---|
| 不设 \`ENABLE_QUERY_MODEL\` | 用「关键词近似向量」，开箱即用，top1 命中约 12/20 |
| 设 \`ENABLE_QUERY_MODEL=1\` | 用本地 bge-base-zh-v1.5 真实编码查询，top1 命中 16/20 |
| 设 \`ENABLE_QUERY_MODEL=1\` 且本地没有 \`models/\` | 首次启动会从 hf-mirror.com 下载约 98MB 权重（一次性） |

本包**没有带 \`models/\`**（超过 GitHub 单文件限制）。
两种做法任选：让它按上面的说明自己下载；或者用 Docker 部署（Dockerfile 会在构建阶段下载）。

---

## 五、部署到公网（Render 免费层，可选）

1. 仓库推到 GitHub 后 → Render → New → Web Service → 选这个仓库
2. 环境变量里至少填：
   - \`DEEPSEEK_API_KEY\`（必填）
   - \`HOST=0.0.0.0\`（容器里必须，否则平台探针访问不到）
   - \`ENABLE_QUERY_MODEL=1\`（想要更好的检索质量）
   - 可选 \`SEARCH_API_KEY\`（博查搜索，配了才有「自动联网」）
3. 仓库里已有 \`Dockerfile\` 和 \`render.yaml\`，不需要再写配置

⚠️ **免费层重启会清空磁盘**，学习记录会丢；要长期保留请挂持久化盘。

---

## 六、上传后自检清单

| # | 检查 | 预期 |
|---|---|---|
| 1 | GitHub 仓库里能看到 \`server.js\` / \`public/\` / \`data/kb.json\` | 说明清单完整 |
| 2 | 仓库里**看不到** \`node_modules\` / \`models\` / \`data/notes.json\` | 说明 .gitignore 生效 |
| 3 | clone 到新目录后 \`npm install && npm start\` | 能打开 http://127.0.0.1:3000 |
| 4 | 打开首页 → 左侧知识树能展开到 240 个知识点 | 说明 \`data/\` 三件套没漏 |
| 5 | 全局搜索「RAG」能出结果 | 说明索引与向量都在 |
| 6 | 刷题中心三个标签（客观题/主观题/错题本）都能点 | 说明前端资源完整 |
| 7 | \`npm run verify:frontend\` | 通过（不需要 Key） |
| 8 | \`npm run verify:ui\` | 通过（需要服务已在跑；不调大模型） |
| 9 | 另开一个端口把包当新仓库跑一遍：<br>\`$env:PORT="3100"; node server.js\` 然后 \`node tools/verify_package.mjs\` | 39 项全过（这个脚本就是专门验「包是否自洽」的） |

---

## 七、维护约定（改完东西记得同步）

| 你改了什么 | 需要重跑什么 |
|---|---|
| 改了 \`public/\` 前端 | 无需重建；浏览器强刷一次即可。验证：\`npm run verify:ui\` |
| 改了知识库内容（\`data/kb.json\`） | \`node build_embeddings.js\` 重建向量（否则检索会失准）→ \`npm run verify\` |
| 加/改了后端接口 | \`npm run verify:frontend\`（会检查前端调用的路径是否存在、以及后端路由清单有没有意外膨胀） |
| 想重新生成这个包 | \`node tools/make_github_package.mjs\` |

---

## 八、这台电脑上的运行提醒（只对本机有效，不影响 GitHub）

你本机 PATH 里的 \`node\` 是个 0 字节的商店占位程序（直接跑会报 "Access is denied"），
所以在本机要这样启动：

\`\`\`powershell
cd "E:\\桌面\\AI PM知识库搜集\\mvp"
$env:ENABLE_QUERY_MODEL="1"; $env:HOST="0.0.0.0"
& "E:\\deepseek harness\\node.exe" server.js
\`\`\`

或者双击 \`start.bat\` —— 它已经会自动寻找可用的 node 可执行文件
（先试 PATH 里的 \`node\`，失败则回退到 \`E:\\deepseek harness\\node.exe\`，
找不到会给出明确提示，不会静默失败）。

换了别的电脑、或者别人 clone 你的仓库，直接用 \`node server.js\` 即可，不需要这段。
`;

fs.writeFileSync(path.join(DEST, 'GITHUB上传说明.md'), uploadGuide, 'utf8');
console.log('\n已生成：GITHUB上传说明.md（' + (Buffer.byteLength(uploadGuide, 'utf8') / 1024).toFixed(1) + ' KB）');

console.log('\n=== 3. 提交安全性检查（.gitignore 到底挡不挡得住）===');
// 这里不满足于「.gitignore 文件存在」，而是**真的按 git 的规则算一遍**：
// 把这些「绝对不能被提交」的路径喂进去，看规则能不能挡住。
// 起因：第一版清单里 data/goals.json、portfolio.json、activity.json 是漏的 ——
// 跑过一次工作台之后，个人目标与作品就会被 `git add .` 一起推上去。
// 这种漏项光看文件是看不出来的，必须真的算一遍。
function compileGitignore(text) {
  const rules = [];
  for (const raw of text.split('\n')) {
    let s = raw.trim();
    if (!s || s.startsWith('#')) continue;
    let neg = false;
    if (s.startsWith('!')) { neg = true; s = s.slice(1); }
    const dirOnly = s.endsWith('/');
    if (dirOnly) s = s.slice(0, -1);
    if (s.startsWith('/')) s = s.slice(1);
    const anchored = s.includes('/');
    let re = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '*') {
        if (s[i + 1] === '*') { re += '.*'; i++; if (s[i + 1] === '/') i++; }
        else re += '[^/]*';
      } else if (c === '?') re += '[^/]';
      else if ('\\^$.|+()[]{}'.indexOf(c) >= 0) re += '\\' + c;
      else re += c;
    }
    rules.push({ neg, dirOnly, re: new RegExp('^' + (anchored ? '' : '(?:.*/)?') + re + '$') });
  }
  return rules;
}
const igRules = compileGitignore(fs.readFileSync(path.join(DEST, '.gitignore'), 'utf8'));

// 判断一个路径会不会被忽略：目录规则看每一层祖先，文件规则看路径本身；最后命中的规则说了算
function isIgnored(rel) {
  const parts = rel.split('/');
  let ignored = false;
  for (const r of igRules) {
    let hit = false;
    if (r.dirOnly) {
      for (let i = 1; i < parts.length; i++) if (r.re.test(parts.slice(0, i).join('/'))) { hit = true; break; }
    } else if (r.re.test(rel)) hit = true;
    if (hit) ignored = !r.neg;
  }
  return ignored;
}

const MUST_BE_IGNORED = [
  ['node_modules/express/index.js', '依赖'],
  ['models/Xenova/bge-base-zh-v1.5/onnx/model_quantized.onnx', '模型权重（约 98MB，超 GitHub 限制）'],
  ['models/Xenova/bge-base-zh-v1.5/tokenizer.json', '模型分词器'],
  ['.env', '环境变量文件'],
  ['data/notes.json', '个人笔记'],
  ['data/learned.json', '个人已学状态'],
  ['data/enrich.json', '个人 AI 补全内容'],
  ['data/newknowledge.json', '个人新知识与练习记录'],
  ['data/quiz.json', '个人刷题记录'],
  ['data/wrong.json', '个人错题本'],
  ['data/settings.json', '个人设置（含搜索 Key）'],
  ['data/goals.json', '个人今日目标'],
  ['data/portfolio.json', '个人作品集'],
  ['data/activity.json', '个人学习活动流'],
  ['data/notes.json.bak-scope-repair', '数据备份'],
  ['data/backup-buckets-2026-01-01/notes.json', '数据备份目录'],
  ['data/regen_run.log', '日志'],
  ['server3000.log', '日志'],
];
let igOk = true;
for (const [p, label] of MUST_BE_IGNORED) {
  const ok = isIgnored(p);
  if (!ok) igOk = false;
  console.log('  ' + (ok ? '✓' : '✗') + ' 会被忽略：' + p + '（' + label + '）');
}

// 反向：应用资产与源码**必须**能提交，否则别人 clone 下来跑不起来
const MUST_NOT_BE_IGNORED = [
  'data/kb.json', 'data/index.json', 'data/embeddings.json', 'data/merge_report.json',
  'server.js', 'public/app.js', 'public/index.html', 'public/styles.css',
  'package.json', 'package-lock.json', 'Dockerfile', 'render.yaml', '.env.example',
  'README.md', 'GITHUB上传说明.md', 'tools/verify_package.mjs',
];
let keepOk = true;
for (const p of MUST_NOT_BE_IGNORED) {
  const ok = !isIgnored(p);
  if (!ok) keepOk = false;
  console.log('  ' + (ok ? '✓' : '✗') + ' 会被提交：' + p);
}
if (!igOk || !keepOk) {
  console.error('\n✗ .gitignore 规则有问题：要么漏挡了个人数据，要么误挡了应用资产');
  process.exit(1);
}
console.log('  → 结论：个人数据 / 依赖 / 模型权重都挡得住，知识库资产与源码都进得去');

console.log('\n=== 4. 统计 ===');
console.log('  文件数：' + countFiles(DEST) + ' 个（复制 ' + copied + ' 个 + 上传说明 1 个，' +
  (bytes / 1024 / 1024).toFixed(2) + ' MB）');
console.log('  输出目录：' + DEST);
console.log('\n✓ 生成完成。上传说明见包内《GITHUB上传说明.md》');
