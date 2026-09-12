# GITHUB上传说明

> 这个文件夹 = AIPM 学习工作台的**完整可运行版本**，可以直接 `git push` 到 GitHub。
> 生成时间：2026-09-12 09:51:04
> 生成方式：`node tools/make_github_package.mjs`（源目录：mvp/）

---

## 一、里面有什么（共 66 个文件 / 5.33 MB）

```
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
│                              （docs/ 合计 14 个文件）
│
├── tools/                    26 个脚本：验证套件 + 知识库加工工具
│   ├── dom_shim.mjs          测试用的 DOM 替身（在 Node 里真跑 app.js）
│   ├── verify_package.mjs    把这个包当成「别人 clone 下来的仓库」跑一遍（39 项断言）
│   ├── verify_*.mjs / .js    13 个验证脚本（见 README 验证一节）
│   ├── make_github_package.mjs  重新生成这个包
│   └── …                     知识库合并/清洗/修复工具
│
└── GITHUB上传说明.md          本文件
```

---

## 二、故意**没有**放进去的东西

| 没放 | 原因 |
|---|---|
| `node_modules/` | 依赖，clone 后 npm install 重新装 |
| `models/` | 向量模型权重约 100MB，超过 GitHub 单文件 100MB 限制；Dockerfile 会在构建阶段下载 |
| `data/notes.json、learned.json、enrich.json、newknowledge.json、quiz.json、wrong.json、activity.json、goals.json、portfolio.json、settings.json` | 你自己的学习数据（含搜索 Key），必须留在本机 |
| `data/backup-*/、data/*.bak*、data/data-new/、data/*.log` | 内容治理过程中的备份与日志 |
| `data-clean/` | 「干净数据」单独交付物，与工作台运行无关 |
| `backup-frontend-*/` | 上一代前端的备份 |
| `_map_appjs.js、_map_settings.js` | 一次性调试脚本 |
| `split_assets.js、repair_split.js、inject_responsive.js、theme.css（根目录）` | 上一代「单文件前端拆分」流程的遗留脚本，对新前端已不适用，留着会误导 |
| `*.tmp、*~、.vscode/、.idea/、Thumbs.db` | 临时文件与编辑器配置 |

> 关键点：**.gitignore 已经挡住了个人学习数据和模型权重**。
> 就算你以后在本地跑出了笔记、错题、搜索 Key，`git add .` 也不会把它们提交上去。

---

## 三、上传到 GitHub（三步）

在**这个文件夹**里打开终端，依次执行：

```bash
git init
git add .
git commit -m "AIPM 学习工作台：知识库 + 混合检索 + 7 页工作台 + 客观题/主观题练习"
git branch -M main
git remote add origin https://github.com/你的用户名/仓库名.git
git push -u origin main
```

**推送前建议先看一眼会提交什么**（确认没有敏感文件）：

```bash
git add .
git status --short
```

预期只看到源码、文档、`data/` 里的知识库三件套；
如果看到 `node_modules/`、`models/`、`data/notes.json` 之类，说明 .gitignore 没生效，
先停下来查 `.gitignore` 的位置（必须在仓库根目录）。

> 如果 GitHub 提示某个文件超过 100MB：本包最大的是 `data/index.json`（约 2MB），
> 不会触发；真正需要小心的是 `models/` 里的 .onnx（约 98MB），它已经被忽略。

---

## 四、别人（或你换台电脑）clone 下来怎么跑

```bash
git clone https://github.com/你的用户名/仓库名.git
cd 仓库名
npm install

# 必填：大模型密钥（检索类功能不需要它，AI 相关功能需要）
# Windows PowerShell:
$env:DEEPSEEK_API_KEY="sk-你的密钥"
# macOS / Linux:
export DEEPSEEK_API_KEY=sk-你的密钥

npm start          # 打开 http://127.0.0.1:3000
```

首次启动会自动创建个人数据文件（笔记、已学、错题…），**不需要手动准备任何数据文件**。

### 关于向量模型（影响检索精度）

| 情况 | 检索表现 |
|---|---|
| 不设 `ENABLE_QUERY_MODEL` | 用「关键词近似向量」，开箱即用，top1 命中约 12/20 |
| 设 `ENABLE_QUERY_MODEL=1` | 用本地 bge-base-zh-v1.5 真实编码查询，top1 命中 16/20 |
| 设 `ENABLE_QUERY_MODEL=1` 且本地没有 `models/` | 首次启动会从 hf-mirror.com 下载约 98MB 权重（一次性） |

本包**没有带 `models/`**（超过 GitHub 单文件限制）。
两种做法任选：让它按上面的说明自己下载；或者用 Docker 部署（Dockerfile 会在构建阶段下载）。

---

## 五、部署到公网（Render 免费层，可选）

1. 仓库推到 GitHub 后 → Render → New → Web Service → 选这个仓库
2. 环境变量里至少填：
   - `DEEPSEEK_API_KEY`（必填）
   - `HOST=0.0.0.0`（容器里必须，否则平台探针访问不到）
   - `ENABLE_QUERY_MODEL=1`（想要更好的检索质量）
   - 可选 `SEARCH_API_KEY`（博查搜索，配了才有「自动联网」）
3. 仓库里已有 `Dockerfile` 和 `render.yaml`，不需要再写配置

⚠️ **免费层重启会清空磁盘**，学习记录会丢；要长期保留请挂持久化盘。

---

## 六、上传后自检清单

| # | 检查 | 预期 |
|---|---|---|
| 1 | GitHub 仓库里能看到 `server.js` / `public/` / `data/kb.json` | 说明清单完整 |
| 2 | 仓库里**看不到** `node_modules` / `models` / `data/notes.json` | 说明 .gitignore 生效 |
| 3 | clone 到新目录后 `npm install && npm start` | 能打开 http://127.0.0.1:3000 |
| 4 | 打开首页 → 左侧知识树能展开到 240 个知识点 | 说明 `data/` 三件套没漏 |
| 5 | 全局搜索「RAG」能出结果 | 说明索引与向量都在 |
| 6 | 刷题中心三个标签（客观题/主观题/错题本）都能点 | 说明前端资源完整 |
| 7 | `npm run verify:frontend` | 通过（不需要 Key） |
| 8 | `npm run verify:ui` | 通过（需要服务已在跑；不调大模型） |
| 9 | 另开一个端口把包当新仓库跑一遍：<br>`$env:PORT="3100"; node server.js` 然后 `node tools/verify_package.mjs` | 39 项全过（这个脚本就是专门验「包是否自洽」的） |

---

## 七、维护约定（改完东西记得同步）

| 你改了什么 | 需要重跑什么 |
|---|---|
| 改了 `public/` 前端 | 无需重建；浏览器强刷一次即可。验证：`npm run verify:ui` |
| 改了知识库内容（`data/kb.json`） | `node build_embeddings.js` 重建向量（否则检索会失准）→ `npm run verify` |
| 加/改了后端接口 | `npm run verify:frontend`（会检查前端调用的路径是否存在、以及后端路由清单有没有意外膨胀） |
| 想重新生成这个包 | `node tools/make_github_package.mjs` |

---

## 八、这台电脑上的运行提醒（只对本机有效，不影响 GitHub）

你本机 PATH 里的 `node` 是个 0 字节的商店占位程序（直接跑会报 "Access is denied"），
所以在本机要这样启动：

```powershell
cd "E:\桌面\AI PM知识库搜集\mvp"
$env:ENABLE_QUERY_MODEL="1"; $env:HOST="0.0.0.0"
& "E:\deepseek harness\node.exe" server.js
```

或者双击 `start.bat` —— 它已经会自动寻找可用的 node 可执行文件
（先试 PATH 里的 `node`，失败则回退到 `E:\deepseek harness\node.exe`，
找不到会给出明确提示，不会静默失败）。

换了别的电脑、或者别人 clone 你的仓库，直接用 `node server.js` 即可，不需要这段。
