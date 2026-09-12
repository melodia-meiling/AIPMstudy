# AIPM 学习工作台 · MVP

最小可运行版本：**单文件后端 + 单页前端 + 本地向量混合检索 + DeepSeek 对话**。

三大模块已产品化：知识树浏览、刷题中心（客观题 + 主观题）、新知识与笔记沉淀。
支持**桌面 / 平板 / 手机**三端响应式，可**一键部署到托管平台**生成公网链接。

---

# 一、公网上线操作手册

> 目标：不用买服务器、不用做运维，把项目部署到公网，
> 然后**在任何电脑、手机浏览器打开链接就能用全部功能**。
>
> 全程约 15 分钟。下面每一步都是"照做即可"。

## 前置准备（只有两项）

1. **一个 GitHub 账号** —— 免费注册：https://github.com/signup
2. **一个 DeepSeek API Key** —— 去 https://platform.deepseek.com 注册后，
   在「API Keys」页创建一个，形如 `sk-xxxxxxxx`。**先复制存好，后面要用**。
   （按量计费，学习用途通常几块钱能用很久）

---

## 第一步：把项目上传到 GitHub

### 1.1 在 GitHub 新建仓库

1. 打开 https://github.com/new
2. **Repository name** 填 `aipm-study-workbench`（名字随意）
3. 选 **Public**（公开）或 Private（私有）都行。Render 两种都支持，
   私有仓库首次授权时多一步确认
4. **不要**勾选 "Add a README file"（我们本地已经有）
5. 点 **Create repository**

建好后页面会显示仓库地址，形如
`https://github.com/你的用户名/aipm-study-workbench.git` —— **复制它**。

### 1.2 在本地项目目录执行推送

打开 PowerShell，逐段执行：

```powershell
# 进入项目目录
cd "E:\桌面\AI PM知识库搜集\mvp"

# 初始化仓库（如果还没初始化过）
git init

# 确认 .gitignore 生效：不应该列出 node_modules 与 models 里的 .onnx
git status --short

# 关联你刚建的仓库（把地址换成你自己的）
git remote add origin https://github.com/你的用户名/aipm-study-workbench.git

git branch -M main
git add .
git commit -m "AIPM 学习工作台：响应式 + 公网部署配置"
git push -u origin main
```

推送时若要求登录，用 GitHub 的 **Personal Access Token** 当密码
（在 GitHub → Settings → Developer settings → Personal access tokens 生成），
不要用账号密码。

> ⚠️ **`.gitignore` 已经排除了这些，别手动加回来**：
> `node_modules/`（274MB）、`models/**/*.onnx`（98MB，超 GitHub 单文件 100MB 限制）、
> `.env`（密钥）、`data/notes.json` 等个人学习数据。
>
> 但 **`data/kb.json`、`data/index.json`、`data/embeddings.json` 必须提交** ——
> 它们是知识库与向量索引，是应用资产。

---

## 第二步：注册 Render 并关联仓库

1. 打开 https://render.com ，点 **Get Started**，
   选 **GitHub** 登录（这样能直接读到你的仓库）
2. 首次会要求授权，选择 **Only select repositories**，
   勾上刚建的 `aipm-study-workbench`，点 Install
3. 进入控制台，点右上 **New +** → **Blueprint**
4. 选中 `aipm-study-workbench` 仓库，点 **Connect**
5. Render 会自动读取仓库里的 `render.yaml`，显示要创建的服务
   （名字 `aipm-study-workbench`，runtime = Docker）
6. 点 **Apply** / **Create**

> 如果你在 Blueprint 列表里没看到仓库，检查第一步的授权是否勾了这个仓库。

---

## 第三步：填环境变量（最关键的一步）

在创建过程中（或服务页面的 **Environment** 标签）填入：

| Key | Value | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | `sk-你的密钥` | **必填**。不填对话会报错 |

`render.yaml` 里已经预置好了其余变量（`HOST=0.0.0.0`、`ENABLE_QUERY_MODEL=1`、
`DEEPSEEK_MODEL=deepseek-chat`、`WEB_MODE=auto`），**不用手动加**。

点 **Save Changes**。

> ⚠️ 千万别把密钥写进 `render.yaml` 再提交到仓库。
> 文件里用的是 `sync: false`，意思是"值只存在 Render 后台，不读仓库"。

---

## 第四步：一键部署，等待生成公网链接

1. 保存环境变量后，Render 会自动开始构建。
   也可以手动点 **Manual Deploy** → **Deploy latest commit**
2. 看 **Logs** 面板，构建大约需要 **3~6 分钟**（要装依赖 + 下载 98MB 模型）
3. 看到这样的日志就成功了：

```
✅ 模型就绪（4 个文件）
[知识库] 137 个片段 · 索引 5461 词条
[向量] ✅ 137 条 × 768 维 · 模型 Xenova/bge-base-zh-v1.5
监听：      0.0.0.0（公网/容器可达） : 10000
多用户隔离：已启用
```

4. 页面顶部会显示公网地址，形如
   **`https://aipm-study-workbench.onrender.com`** —— 这就是你的链接

**健康检查**：把 `/api/health` 拼到链接后面，
能返回 JSON（含 `"docs":137`）就说明服务正常。

---

## 第五步：电脑 / 手机打开链接，直接用

把公网链接发到手机上，浏览器打开即可。手机端会自动切换成：

- 顶部出现 **☰ 汉堡按钮**，点击滑出知识树抽屉
- 点遮罩或选中知识点会自动收起抽屉
- 按钮、输入框都放大到适合手指点按（≥44px）
- 笔记输入框在键盘弹出时会自动滚到可见位置

**建议把链接加到手机主屏**（Safari：分享 → 添加到主屏幕；
Chrome：菜单 → 添加到主屏幕），用起来像个 App。

### 上线后自检清单

| # | 操作 | 预期 |
|---|---|---|
| 1 | 打开首页 | 左侧 7 个导航入口，仪表盘 6 张卡片都出数 |
| 2 | 知识库点「AI专属技术知识 › 核心技术能力 › RAG」 | 面包屑、能力标签、概念解释、核心要点、关联概念、AI答疑、我的笔记、标记已学 |
| 3 | 点 AI答疑里的问题 | 正常流式回答，带「（来源：…）」标注 |
| 4 | 在笔记里写一句、点「用 AI 补全」 | 自动补出拓展内容，并出现在「新知识」弹窗 |
| 5 | 刷题中心客观题选知识点出题 | 3 道单选题，答错自动进错题本 |
| 6 | 刷题中心主观题走完四步 | 三段反馈 + 自动存进练习历史 |
| 7 | 手机打开同一链接 | 布局自适应，汉堡菜单可用，功能不缺失 |

---

## 上线相关的几个重要事实（务必读）

### 1. 免费层的冷启动

Render 免费实例**闲置 15 分钟会休眠**，下次访问需要 **30~60 秒**唤醒。
这是免费层的机制，不是故障。想免掉就升级到 Starter（约 $7/月）。

### 2. 学习记录会随重启丢失

笔记、已学、错题等存在容器内的 `data/*.json`。
**免费层没有持久化磁盘**，重新部署或实例重建时会清空。
另外因为按 Cookie 隔离，同一浏览器（同一 Cookie）才能看到自己的记录。

- 只做学习用：可以接受，重要笔记建议自己也存一份
- 想长期保留：在 Render 挂一个 **Disk**（服务页 → Disks → Add Disk，
  挂载路径填 `/app/data`），注意免费层不支持磁盘，需 Starter 及以上

### 3. 多用户已经隔离

服务端按 Cookie 给每个浏览器分配独立空间，**不同人打开同一链接
看不到彼此的笔记、错题和已学状态**（已通过 24 项自动化测试验证）。

但要注意：这只是"数据互不可见"，**没有账号密码体系**。
如果你把它放到公开场合（比如发到群里），任何拿到链接的人都能使用你的
DeepSeek 额度。要限制访问，见下面「限制访问」。

### 4. 限制访问（可选）

不想让陌生人用你的额度，两种做法：

- **Render 后台**：服务设置里有 Access Control，可开启 Basic Auth（需付费层）
- **自己加一道口令**：目前项目未内置，可以后续加一个环境变量校验中间件

### 5. 什么时候需要用到 Dockerfile

`render.yaml` 里 `runtime: docker`，Render 会用仓库里的 `Dockerfile` 构建。
这个 Dockerfile **也能直接用于其它平台**：

```bash
# 本地验证镜像能不能跑起来
docker build -t aipm-workbench .
docker run -p 3000:3000 -e DEEPSEEK_API_KEY=sk-xxx aipm-workbench
# 打开 http://127.0.0.1:3000
```

迁移到 Railway / Fly.io / 阿里云 / 腾讯云时，直接指向这个 Dockerfile 即可。

### 6. 常见故障排查

| 症状 | 原因 | 处理 |
|---|---|---|
| 部署成功但链接打不开 | 服务绑到了 127.0.0.1 | 确认 `HOST=0.0.0.0`（render.yaml 已预置） |
| 日志停在下载模型 | 构建环境访问不到 hf-mirror | 脚本会跳过并继续；也可设 `ENABLE_QUERY_MODEL=0` 明确走降级 |
| 提问报"未找到 DEEPSEEK_API_KEY" | 环境变量没填或填错 Key 名 | 在 Environment 面板确认 `DEEPSEEK_API_KEY` |
| 检索变得不准 | 模型没加载，退化为关键词近似向量 | 看启动日志「查询编码」一行；或按上面处理模型下载 |
| 记录突然没了 | 免费实例重启 + 无持久化磁盘 | 见上面第 2 条 |
| 构建报 `COPY failed: models` | 你删掉了 `RUN node fetch_model.js` 又没提交模型 | 恢复那行，或用 Git LFS 提交模型 |

---


检索为 **本地语义向量 + 关键词混合**（`@xenova/transformers` 跑 bge-base-zh-v1.5），
**检索与向量化全程离线，不调用任何 Embedding 外部 API**。

---

## 一、启动验证步骤

### 最快方式

双击 `start.bat`（会自动释放 3000 端口并设好环境变量）。

### 命令行方式

```powershell
cd "E:\桌面\AI PM知识库搜集\mvp"
$env:ENABLE_QUERY_MODEL="1"
& "E:\deepseek harness\node.exe" server.js
```

浏览器打开 **http://127.0.0.1:3000** ｜ 停止：`Ctrl + C`

> `node` 必须写绝对路径：这台机器 PATH 里的 `node` 是 WindowsApps 的 0 字节占位符，
> 直接敲 `node` 会报 `Access is denied`。把 `E:\deepseek harness` 加进 PATH 即可解决。

### 启动成功的标志

启动日志应包含这 5 行：

```
[知识库] 137 个片段 · 索引 5461 词条
[知识库] 分布 {... "withFaqs":137,"enriched":137}
[向量] ✅ 137 条 × 768 维 · 模型 Xenova/bge-base-zh-v1.5
[提示词] 已加载，2608 字符
  检索方式：  混合检索（向量 768维 + 关键词）
```

### 启动后请按顺序验证这 7 项

| # | 操作 | 预期 |
|---|---|---|
| 1 | 打开首页 | 左侧 7 个导航入口（仪表盘/知识库/刷题中心/API实验/任务日历/作品集/设置），仪表盘 6 张卡片都有真实数字 |
| 2 | 左侧「知识库文档」点「AI专属技术知识 › 核心技术能力 › RAG」 | 详情页依次出现：面包屑 → 标题+能力标签 → 概念解释 → 核心要点 → 应用场景 → 关联概念（可点击跳转）→ AI答疑（3 个可展开问题）→ 我的笔记 → 标记已学 |
| 3 | 点 AI答疑里的问题 | 正常流式回答，且带「（来源：…）」标注 |
| 4 | 在「我的笔记」写一句话保存，点「用 AI 补全」 | 自动调用 DeepSeek，补出拓展内容，并出现在「新知识」弹窗 |
| 5 | 「刷题中心 → 客观题」选一个知识点，让 AI 出题并作答 | 3 道单选题；答错的自动进「错题本」 |
| 6 | 「刷题中心 → 主观题」选方向与知识点 → 生成练习题 → 写几条思路 → 提交 | 出题 10-25 秒；提交后出现①规范完整版②缺失要素③结构拆解三段反馈；改完再提交可做第 2 版对比；练习历史自动多一条 |
| 7 | 回仪表盘 → 刷新页面 | 「我的练习」里主观题练习次数 +1，今日事件数增加；已学状态与笔记也保留（持久化在 `data/*.json`） |

**无需联网 / 无需 API Key 也能验证的部分**：
`http://127.0.0.1:3000/api/health`、`/api/catalog`、`/api/tree`、`/api/search?q=什么是RAG`

### 知识内容重新生成时（按顺序）

工作区里有两套内容产出工具，职责不同，**必须搞清归属再动**：

| 工具 | 产出 | 说明 |
|---|---|---|
| `tools/regen_knowledge.js` | **权威内容产出** | 把每条知识点扩写成 ~987 字（3 问 + 5 关联 + 4 要点），可 `--web` 走博查取证。**会整体重建 kb.json** |
| `enrich_kb.js` | 字段契约补齐 | 补 `breadcrumb` / `relatedIds` / `sources` / `levelN`；只增不删，可反复跑 |
| `patch_book_categories.js` | 分类层级修正 | 把书目条目从「核心书目」下拆出，改为「书名 › 章节 › 标题」 |

标准顺序：

```powershell
cd "E:\桌面\AI PM知识库搜集\mvp"
& "E:\deepseek harness\node.exe" tools\regen_knowledge.js   # ① 内容扩写（调 API，可续跑）
& "E:\deepseek harness\node.exe" enrich_kb.js --contract-only  # ② 补字段契约（不调 API）
& "E:\deepseek harness\node.exe" patch_book_categories.js   # ③ 修书目分类层级（不调 API）
& "E:\deepseek harness\node.exe" build_embeddings.js        # ④ 重建向量（离线）
```

> ⚠️ **顺序不能反**：①会重建 kb.json，所以②③必须在它之后；②③改了内容/字段，所以④必须最后跑。
> 漏跑④会导致向量与内容不一致，检索失准。
>
> ⚠️ `tools/regen_knowledge.js` 已内置②的字段契约逻辑，
> 所以按上面顺序跑时，②在它之后属于幂等操作（不会重复改坏）。

### 验证

全部验证脚本（服务已在运行时执行；除注明外默认打 `127.0.0.1:3000`）：

```powershell
$env:PORT="3000"
& "E:\deepseek harness\node.exe" tools\verify_all.mjs              # 接口与页面入口
& "E:\deepseek harness\node.exe" tools\verify_multiuser.mjs        # 多用户数据隔离
& "E:\deepseek harness\node.exe" tools\verify_new_content.mjs      # 知识库内容与检索命中
& "E:\deepseek harness\node.exe" tools\verify_new_endpoints.mjs    # 仪表盘/目标/作品集/API实验
& "E:\deepseek harness\node.exe" tools\verify_assets.mjs           # 资源加载与设计规范
& "E:\deepseek harness\node.exe" tools\verify_responsive.mjs       # 响应式与手机抽屉
& "E:\deepseek harness\node.exe" tools\verify_theme.js             # 设计系统落地
& "E:\deepseek harness\node.exe" tools\verify_dashboard.js         # 设计稿 dashboard.html
& "E:\deepseek harness\node.exe" tools\verify_frontend.mjs         # 前端静态契约（id/class/接口）
& "E:\deepseek harness\node.exe" tools\verify_theme_contract.mjs   # DOM 契约（真实执行 app.js）
& "E:\deepseek harness\node.exe" tools\verify_ui_e2e.mjs           # 端到端（7 个页面全流程）
& "E:\deepseek harness\node.exe" tools\verify_ui_e2e.mjs --ai      # 端到端 + 真实调用大模型的路径
& "E:\deepseek harness\node.exe" tools\verify_subj_quality.mjs     # 主观题反馈的「内容质量」（读内容，不只看结构）
& "E:\deepseek harness\node.exe" tools\verify_package.mjs          # 把项目当「别人 clone 的仓库」验一遍（改端口另跑）
```

> **要打包上传 GitHub**：`node tools/make_github_package.mjs`
> 会生成一份可直接 `git push` 的完整包，并自动做三项检查：
> ① 必需文件齐不齐；② 有没有密钥泄漏；③ `.gitignore` 挡不挡得住个人数据
> （第③项是真的按 git 规则算一遍，不是看文件在不在）。

当前基线（共 13 个脚本，全部通过）：

| 脚本 | 覆盖 | 基线 |
|---|---|---|
| `verify_all.mjs` | 页面入口、全部只读接口、字段契约、笔记/已学持久化、刷题、错题本、新知识 | 54 |
| `verify_multiuser.mjs` | 两个访客的笔记/已学/新知识/错题互相隔离 | 24 |
| `verify_new_content.mjs` | 240 条知识库、新书新概念、9 组语义命中、真实 AI 引用 | 36 |
| `verify_new_endpoints.mjs` | `/api/stats` `/api/goals` `/api/portfolio` `/api/playground` + 隔离 | 34 |
| `verify_assets.mjs` | 三层文件拆分、MIME、设计规范色值/尺寸、18 个接口都接上了 | 55 |
| `verify_responsive.mjs` | 三档断点、移动端逐条要求、标签栏对齐、抽屉交互 | 64 |
| `verify_theme.js` | 设计系统落地 + 与设计稿色值不跑偏 + 旧主题残留清零 | 35 |
| `verify_dashboard.js` | 设计稿本身的规范符合度 | 82 |
| `verify_frontend.mjs` | id/class/接口三张静态契约表 + **后端路由清单没膨胀** | 9 |
| `verify_theme_contract.mjs` | 真实执行 app.js，138 个 id 全部可达 | 11 |
| `verify_ui_e2e.mjs` | 7 个页面真实点一遍（不含 AI） | 122 |
| `verify_ui_e2e.mjs --ai` | 上面这些 + AI Tutor / 答疑 / 补全 / 客观题出题 + **主观题全流程** | 184 |
| `verify_subj_quality.mjs` | 主观题反馈是否忠实于学员思路（固定题目 + 故意错位，读内容判断） | 11 |

> `verify_ui_e2e.mjs` 与 `verify_theme_contract.mjs` 会在 Node 里真实执行 `public/app.js`
> （`tools/dom_shim.mjs` 提供够用的 DOM 替身），并真的打后端接口。
> 它们使用固定的测试用户桶 `e2e_verify_bucket`，不会污染你浏览器里的学习数据。

### 依赖安装（已装好，重装时才需要）

```powershell
& "E:\deepseek harness\npm.cmd" install @xenova/transformers
```

---

## 二、目录结构

```
mvp/
├── start.bat             一键启动（释放端口 + 设环境变量）
├── build_kb.js           ① 构建知识库：清洗 + 结构化 + 目录树 + 倒排索引（离线）
├── enrich_kb.js          ② 大模型补充内容：要点/场景/关联/答疑 + 前端字段契约
├── build_embeddings.js   ③ 生成语义向量索引（离线；首次需下模型）
├── server.js             后端（单文件：混合检索 + 全部接口 + DeepSeek）
├── prompt.md             系统提示词（定义混合问答的来源标注规则）
├── dashboard.html        设计稿（奶油风仪表盘静态原型，规范值以它为准）
├── models/               bge-base-zh-v1.5 权重缓存（129MB，不入库）
├── data/
│   ├── kb.json               知识库：240 个知识点（144 概念 + 8 智能体 + 88 书目条目）
│   ├── index.json            倒排索引（关键词那一路用）
│   ├── embeddings.json       语义向量：240 × 768 维
│   ├── notes.json            我的笔记
│   ├── learned.json          已学状态
│   ├── enrich.json           笔记 AI 补全产生的补充知识
│   ├── newknowledge.json     新知识
│   ├── quiz.json / wrong.json 刷题与错题
│   ├── goals.json            今日目标
│   ├── portfolio.json        项目作品集
│   ├── activity.json         学习活动流（打卡日历 / 时长估算的数据源）
│   └── settings.json         设置（含联网搜索配置）
├── tools/                验证脚本与一次性数据加工脚本
└── public/
    ├── index.html        7 个页面 + 刷题中心三标签（客观题/主观题/错题本）的结构壳（24KB，只含 DOM + 相对路径引用）
    ├── styles.css        奶油风设计系统（34KB：变量 + 组件 + 三档响应式）
    ├── theme.css         已退休的占位文件（旧主题覆盖层，只留说明，无样式）
    └── app.js            前端逻辑（83KB：7 个页面 + 主观题练习全部对接真实接口）
```

### 前端文件结构

`public/` 下四个文件，**引用全部用相对路径**，不含 `localhost`，
所以部署到任何域名都会自动跟随：

```html
<link rel="stylesheet" href="styles.css">
<link rel="stylesheet" href="theme.css">
<script src="app.js"></script>
```

| 文件 | 职责 | 要改什么来这里 |
|---|---|---|
| `index.html` | 7 个页面的结构：左侧导航 + 仪表盘 / 知识库 / 刷题中心（客观题 + 主观题）/ API实验 / 任务日历 / 作品集 / 设置 | 加页面 / 加入口 |
| `styles.css` | 全部样式与设计变量（`--cream` `--orange` `--r-card` `--gap` …）+ 1024/767/379 三档响应式 | 改配色 / 布局 / 断点 |
| `theme.css` | **不再提供任何样式**，只保留文件避免旧缓存 404；要换肤请覆盖 `:root` 变量 | 换肤 |
| `app.js` | 全部逻辑：7 个页面各自的数据加载、渲染、SSE 流式、主观题练习、手机抽屉 | 改功能 / 接口调用 |

> 设计规范（与 `dashboard.html` 一致）：底色 `#F4F1EB`、卡片 `#F9F6F1`、
> 暖橙 `#E89B68`、柔黄 `#F2D188`、砖红 `#D87060`、正文 `#333333`、次要 `#777777`、
> 卡片圆角 18px、卡片间距 24px、极淡柔和阴影、Inter 字体、**浅色侧栏（不用深色导航）**。
> `tools/verify_theme.js` 会交叉校验这两份文件的色值，改一边忘另一边会被测出来。

> 这三个文件原本是一个 52KB 的 `index.html`（CSS 与 JS 全内联）。
> 用 `node split_assets.js` 拆分得到，**内容未做任何修改**。
>
> ⚠️ `inject_responsive.js` 是拆分之前写的（针对内联结构），现在再跑会自动跳过并提示，
> 不会破坏拆分后的文件。响应式调整请直接编辑 `styles.css` / `app.js`。

---

## 三、知识库内容治理

### 清洗（`build_kb.js` 的 `cleanText()`）

原始资料由 AI 整理，正文里有排版残留。构建时自动清理：

| 问题 | 处理 |
|---|---|
| 散落的 `**` 加粗标记、`#` 标题 | 去除标记，保留文字 |
| 中文之间的游离空格（"不 能 做"） | 合并 |
| 中文标点前后的空格 | 去除 |
| 连续重复标点（"。。"、"，，"） | 压缩为一个 |
| 全角空格 / 零宽字符 / BOM | 转普通空格或删除 |
| 行首装饰符号（◆●■★▶） | 去除 |

清洗后自检：`**` 残留 0 条、中文间空格 0 条、连续标点 0 条。

### 结构化字段

每个知识点统一字段：

```
id            知识点唯一 ID
name          名称
categoryL1    一级分类（行业&业务认知 / 产品基础能力 / AI专属技术知识 / …）
categoryL2    二级分类（岗位分类 / 核心技术能力 / …）
content       概念解释正文
relatedIds    关联概念 ID 列表（4-5 个，全部指向真实存在的知识点）
level         掌握程度标签（必须掌握 / 理解 / 了解）
sourceBook    来源书籍
--- 前端契约字段 ---
explain       概念解释（= content）
keypoints     核心要点（3-5 条）
scenario      应用场景
faqs          常见问题 2-3 个（详情页「AI答疑」用）
breadcrumb    面包屑层级
sources       信息来源数组
levelN        掌握程度文字形式
```

### 内容生成逻辑

**现状与偏离（重要）**：
需求写的是"以已上传的 15 本书为核心依据"。但工作区里的书籍资料
**只有书名 + 章节目录 + 一段简介，没有书籍正文**，无法从中提取概念解释。

因此实际采用：**知识树（109 条人工整理的概念解释）为骨架 + 大模型补充完善**：

- 保留知识树原有的概念解释（`content`），不被覆盖
- 大模型补充：核心要点 5 条、应用场景、3 条常见问题、关联概念 4-5 个
- 来源如实分档：`contentOrigin` 标注「知识树原有解释 + 大模型拓展」或「书目」
- 模型推测的"可能相关章节"存在 `bookRefHint`，标明**待核对**，
  **不写进 `sources` 冒充确切出处**——因为我们无法验证

**成本**：全量 137 条约 25 次请求，实测 ¥0.52（`deepseek-chat`）。

---

## 四、检索是怎么做的

**混合检索**（两条信号加权合并）：

```
最终得分 = 0.85 × 语义相似度 + 0.15 × 关键词分 + 0.15 × 标题命中加成
```

| 环节 | 实现 |
|---|---|
| 语义向量 | 本地 `Xenova/bge-base-zh-v1.5`（768 维），CLS 池化 + 归一化 |
| 查询编码 | query 加中文指令 `为这个句子生成表示以用于检索相关文章：`，passage 不加（BGE 标准用法） |
| 关键词分 | 字符 bigram 倒排 + IDF，再过 `tanh` 软压缩 |
| 标题加成 | 查询词（≥2 字）精确出现在片段标题里 → 固定 +0.15 |
| 低置信判断 | 最高分 < 0.30 → 触发「拓展补充」路线 |
| 关联扩展 | 命中片段的 `related` 概念额外带入（最多 2 条） |

### 为什么服务端不直接加载模型

`build_embeddings.js` 离线把 137 个片段编码好存盘，`server.js` 只读向量文件，
所以服务端启动**不含模型、秒起、天然离线**，向量文件只有 0.3MB。

查询编码需要模型，因此提供 `ENABLE_QUERY_MODEL=1`。
不设时服务端会退化成"关键词近似向量"，检索质量明显下降。

### 模型与镜像

`@xenova/transformers` 首次运行要从 HuggingFace 下载权重，
而**官方站在这台机器上不可达（超时）**，已默认走镜像 `https://hf-mirror.com`。
权重缓存在 `mvp/models/`，下载一次后可完全离线复用。

选型实测（20 条标注用例，top3 命中率）：

| 模型 | top1 | top3 | 超纲问题最高分 |
|---|---|---|---|
| `paraphrase-multilingual-MiniLM-L12-v2` | 1/20 | 7/20 | 0.638 ⚠️ |
| `bge-small-zh-v1.5` | 10/20 | 12/20 | 0.448 |
| **`bge-base-zh-v1.5`** | **12/20** | **17/20** | **0.375** ✅ |

混合检索权重寻优：

| 关键词权重 | top1 | top3 | 超纲最高分 |
|---|---|---|---|
| 0（纯向量） | 12/20 | 17/20 | 0.375 |
| **0.15 + 标题加成** | **16/20** | **19/20** | 0.398 |
| 1.0（纯关键词） | 15/20 | 18/20 | 1.000 ⚠️ |

**关键词只做小权重补强（0.15）最划算**——top1 从 12 提到 16，超纲分几乎不变。

---

## 五、智能问答：本地知识库优先 + 大模型拓展

`prompt.md` 里定义了三种情况的处理规则：

| 情况 | 判断标准 | 行为 |
|---|---|---|
| 一：资料相关 | 能为核心结论标注出来源 | 以资料为核心作答 + 补充类比/例子，**标注「（来源：…）」** |
| 二：资料无关/没有 | 无法注明来源 | **直接用大模型专业知识完整回答，开头第一行原样输出「该内容为拓展补充」** |
| 三：部分相关 | — | 相关部分标来源，缺失部分标「（拓展补充）」 |

**实测验证**：

| 用例 | 来源标注 | 拓展补充标注 | Markdown 加粗 | 结果 |
|---|---|---|---|---|
| 「RAG和微调有什么区别？」 | ✅ 有 | 无（不需要） | 无 | PASS |
| 「Transformer自注意力数学公式怎么推导？」 | — | ✅ 第一行原样输出 | 无 | PASS |

多轮追问：`/api/chat` 与 `/api/ask` 都接收 `history` 字段（取最近 6 轮）。

---

## 六、接口一览

| 接口 | 是否调 DeepSeek | 用途 |
|---|---|---|
| `GET /` | 否 | 前端页面 |
| `GET /api/health` | 否 | 片段数、Key 来源、检索配置与权重 |
| `GET /api/catalog` | 否 | 知识目录 |
| `GET /api/tree` | 否 | 三级知识树（含已学状态） |
| `GET /api/doc?id=d40` | 否 | 知识点详情（合并笔记/已学/AI补全） |
| `GET /api/search?q=…` | 否 | 只检索不生成（返回语义分/关键词分） |
| `GET /api/progress` | 否 | 学习进度总览 |
| `POST /api/chat` | **是** | 通用问答，SSE 流式 |
| `POST /api/ask` | **是** | 知识点内 AI 答疑（当前知识点 + 检索 + 笔记 + 联网） |
| `POST /api/note` | 否 | 保存笔记 |
| `POST /api/enrich` | **是** | 笔记 → AI 补全成一条可沉淀的知识 |
| `POST /api/learned` | 否 | 标记已学 |
| `GET/POST/DELETE /api/newknowledge` | POST 时 **是** | 新知识：新增时结构化并由大模型补关联 |
| `GET /api/quiz` · `POST /api/quiz/generate` · `POST /api/quiz/submit` | generate **是** | 客观题（选择题）出题 / 交卷 |
| `GET/DELETE /api/wrong` | 否 | 错题本 |
| `GET/POST /api/settings` | 否 | 设置（含联网搜索配置） |
| `POST /api/websearch` | 否（调搜索服务商） | 联网搜索（需自配 Key，默认博查） |
| `GET /api/stats` | 否 | 仪表盘聚合：今日/累计/成长计划/近 14 天/今日目标 |
| `GET /api/checkins?days=120` | 否 | 打卡记录：按天聚合，供日历页与迷你日历 |
| `GET/POST /api/goals` | 否 | 今日目标读写 |
| `GET/POST/DELETE /api/portfolio` | 否 | 项目作品集 CRUD |
| `POST /api/playground` | 否（服务端真实发 HTTP） | API 实验：试任意接口，带 SSRF 防护 |

> 新增的 5 个端点另有详细文档：`docs/新增接口文档.md`。
>
> **主观题练习没有新增任何接口**：出题与三段反馈都走 `POST /api/ask`，
> 真实案例走 `POST /api/websearch`，练习记录用 `GET/POST/DELETE /api/newknowledge`。
> `tools/verify_frontend.mjs` 里钉住了后端路由清单（23 个），
> 以后谁不小心加了新路由，那条断言会立刻失败并列出差异。
>
> **口径说明**：`/api/stats` 的 `today.minutes` 是**估算值**（每个学习事件按 6 分钟折算，
> 返回值里带 `minutesIsEstimate: true` 与 `perEventMinutes`），前端会明确标注"估算"，
> 不会把它当成精确计时。

---

## 七、环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3000` | 端口 |
| `ENABLE_QUERY_MODEL` | 未设 | 设 `1` 启用真实查询编码（推荐） |
| `HF_ENDPOINT` | `https://hf-mirror.com` | 模型下载镜像 |
| `EMBED_MODEL` | `Xenova/bge-base-zh-v1.5` | 换模型后必须重跑 `build_embeddings.js` |
| `DEEPSEEK_MODEL` | `deepseek-chat` | 生成模型 |
| `DEEPSEEK_API_KEY` | 自动读取 | 来源 `~/.dsh/.credentials.yaml` |

---

## 八、已知局限

1. **书籍正文缺失**：13 本书只有目录级资料，所以内容主体来自知识树 + 大模型补充，
   不是"从书里摘出来的"。`sources` 是真实来源，`bookRefHint` 是**未核对**的推测章节线索。
2. **`智能体是什么` 检索排不第一**：被"多智能体"挤到后面（两者都含"智能体"，算部分正确）。
3. **超纲阈值有一例漏判**：「考勤制度」得 0.3276 略高于 0.30 阈值。
   该例由提示词的来源标注规则兜住，不影响正确性。
4. **联网搜索需自配 Key**：默认未配置，此时问答只用本地知识库 + 大模型自身知识。
5. **新知识入库即时可检索**：新增内容写入 `newknowledge.json` 并计入关键词检索；
   语义向量需重跑 `build_embeddings.js` 才覆盖（服务端会提示）。
6. **无重排序（rerank）**：加 cross-encoder 重排通常还能再提几个点，本期未做。
7. **学习时长是估算**：没有真实计时器，按"每个学习事件 6 分钟"折算，
   接口与界面都标注了这是估算口径。
8. **前端只在 Chromium 内核上实测过**：端到端验证是在 Node 里跑真实 `app.js`
   （`tools/dom_shim.mjs`），验证的是数据与交互逻辑；
   视觉效果（阴影、间距、字体渲染）请在浏览器里目视确认一遍。
9. **旧版浏览器的兼容性**：前端用了可选链、`Proxy`（仅测试桩）、CSS 变量与 grid，
   建议 Edge / Chrome / Safari 近两年的版本。
10. **主观题练习记录会进「新知识」**（这是「不新增后端接口」的代价）：
   服务端只有 `newknowledge` 这一个 store 同时能装长正文、能关联知识点、能删除。
   已实测的副作用：这些记录会被 `searchExtraKnowledge` 当作「我的新知识」塞进后续
   AI 答疑的参考材料里。因为记录标题统一以「主观题练习 · 」开头，模型能识别出它是
   练习记录——实测中它甚至会主动说明"参考资料里混进了一份别的场景的 PRD"，并没有照抄。
   影响范围被服务端限制在得分最高的 2 条以内。「新知识」弹窗里也把练习记录单独分组，
   不会把补全知识挤下去。
11. **主观题反馈的稳定性**：三段格式（①②③）由提示词约束，模型偶尔会漏标记。
   前端做了容错（只要有 ① 和 ② 就切三段，③ 缺失并入 ②；完全解析不出来就原样展示
   并标注"模型没按三段格式返回"），不会假装成功。
12. **练习次数的目标值是建议值**：仪表盘「我的练习 → 主观题练习」的 6 次分母
   是我定的建议值（覆盖两类写法各练几轮），不是接口给的数据。
