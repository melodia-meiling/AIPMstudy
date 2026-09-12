// build_kb.js —— 一次性生成 data/kb.json 与 data/index.json
// ============================================================
// 【重要】本脚本全程离线：不调用 DeepSeek API、不调用 Embedding 接口、零网络请求。
//         检索采用关键词匹配（倒排索引 + IDF 加权），不需要任何模型。
//
// 数据来源（全部为工作区已有文件，无新增人工内容）：
//   1. AI产品经理知识树_完整版.html     → 116 个知识点（概念层，撑起问答）
//   2. kb_main_六步法.md 的内容         → 8 条智能体搭建片段（操作层）
//   3. 三本核心书籍的章节目录 + 简介     → 20 条书目片段（书目层）
//
// 片段字段严格按需求：book（书名/来源）、section（章节）、content（内容）
//   + 附加内部字段 kind/group/mark/level/title/related（供前端目录与检索用）
//
// ⚠️ MVP 取舍说明：
//   需求写的是"把书籍大纲按章节拆成片段"。已按要求实现（20 条书目片段）。
//   但仅靠书目片段无法回答"RAG是什么""智能体怎么搭"这类问题——
//   因为书单资料只有章节目录和简介，没有操作细节。
//   因此把知识树的 116 个知识点也作为片段一并入库（kind=concept），
//   否则 MVP 跑起来只会回答"建议阅读《XX书》第X章"。
//   若你只要书目片段，把下面 pushDoc 的 walk(tree) 那段注释掉即可。
// ============================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'data', 'kb.json');
const OUT_IDX = path.join(__dirname, 'data', 'index.json');

// ---------- 1. 解析知识树 ----------
function loadTree() {
  const raw = fs.readFileSync(path.join(ROOT, 'AI产品经理知识树_完整版.html'), 'utf8');
  const s = raw.indexOf('const treeData = ');
  const a = raw.indexOf('[', s);
  const b = raw.indexOf('\n];', a);
  const j = raw.slice(a, b + 2)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
    .replace(/,[ \t]*\r?\n[ \t]*([\]}])/g, '$1');
  return JSON.parse(j);
}

const TITLE_FIX = {
  '全盘加密 FDE': '全盘加密（FDE）',
  'FDE特性驱动开发': '特性驱动开发（FDE）',
};

function emoji(level) {
  if (!level) return '⚪';
  if (/必须|核心|主攻/.test(level)) return '🔴';
  if (/理解|重点|推荐|高频/.test(level)) return '🟡';
  return '⚪';
}

const tree = loadTree();
const docs = [];
let seq = 0;

// ---------- 冲突消解：知识树里的"智能体搭建7步法"与统一六步法冲突 ----------
// 原因：知识树 tb "Coze智能体搭建7步法"是另一套步法（7步），
//       与全局统一的六步法不一致（Demo 6步 / 知识树7步 / 知识树8步，三处冲突）。
//       既然本 MVP 只讲统一六步法，就把这 7 条从主库剔除，避免用户同时看到两套。
//       其中"第3步 配置知识库RAG""第5步 配置插件工具"这两条内容（RAG/插件原理）
//       已被六步法第4步、第5步覆盖，故不另作迁移。
const CONFLICT_SECTIONS = new Set([
  '第1步 创建智能体',
  '第2步 配置人设Prompt',
  '第3步 配置知识库RAG',
  '第4步 配置工作流',
  '第5步 配置插件工具',
  '第6步 调试测试',
  '第7步 发布',
]);
let dropped = 0;

function pushDoc(d) {
  seq++;
  // 统一成需求要求的三个核心字段：book / section / content
  docs.push({
    id: 'd' + seq,
    book: d.bookSource || d.book || '知识树',
    section: d.section || '',
    content: d.content || d.body || '',
    ...d,
  });
}

// ---------------------------------------------------------------------------
// 内容清洗：去掉 AI 生成资料里的排版残留
//   问题来源：原始资料由 AI 整理，正文里有零散的 ** 加粗标记、多余空格、
//             中文之间的空格、连续标点等痕迹（如"核心 **能力** 、和"）。
//   原则：只清理排版噪音，不改变语义，不删除原有 Emoji（Emoji 是有用的状态标记）。
// ---------------------------------------------------------------------------
function cleanText(s) {
  if (typeof s !== 'string') return '';
  let t = s;
  // 1. 全角空格 / 不换行空格 → 普通空格
  t = t.replace(/[\u3000\u00a0\u200b\ufeff]/g, ' ');
  // 2. 去掉残留的 Markdown 标记（**加粗**、_斜体_、`代码`、### 标题）
  t = t.replace(/\*\*/g, '').replace(/^#{1,6}\s*/gm, '');
  t = t.replace(/`([^`]*)`/g, '$1');
  // 3. 中文与中文之间的游离空格（AI 生成资料常见："不 能 做"）
  t = t.replace(/([\u4e00-\u9fa5])[ \t]+([\u4e00-\u9fa5])/g, '$1$2');
  // 反复几次，处理"不 能 做"这种多空格情形
  for (let i = 0; i < 3; i++) t = t.replace(/([\u4e00-\u9fa5])[ \t]+([\u4e00-\u9fa5])/g, '$1$2');
  // 4. 中文标点前后的空格
  t = t.replace(/\s+([，。、；：？！）】》」』])/g, '$1');
  t = t.replace(/([（【《「『])\s+/g, '$1');
  // 5. 连续重复标点（如"。。"、"，，"、"！！"）
  t = t.replace(/([，。、；：！？])\1+/g, '$1');
  // 6. 行尾空白、连续空行压缩
  t = t.replace(/[ \t]+$/gm, '');
  t = t.replace(/\n{3,}/g, '\n\n');
  // 7. 去掉行首非语义的装饰符号（保留 - / · / 数字编号）
  t = t.replace(/^[ \t]*[◆●■□▪▫★☆▲▼►▶→]+\s*/gm, '');
  // 8. 收尾
  return t.trim();
}

// 清洗并把"关联概念（名称）"解析成 id 列表；同时按新结构补齐字段
function finalizeDocs(all) {
  // 先建"名称 → id"索引，用于解析关联概念
  const byTitle = new Map();
  const byCleanTitle = new Map();
  for (const d of all) {
    if (!byTitle.has(d.title)) byTitle.set(d.title, d.id);
    const ck = cleanText(d.title);
    if (!byCleanTitle.has(ck)) byCleanTitle.set(ck, d.id);
  }

  for (const d of all) {
    // 正文清洗
    d.content = cleanText(d.content);
    d.title = cleanText(d.title);
    d.section = cleanText(d.section);
    d.group = cleanText(d.group);
    // 名称：去除英文括注，便于展示；原英文名保留在 en 字段
    d.name = d.title;
    // 一级分类 / 二级分类
    d.categoryL1 = d.group || '';
    d.categoryL2 = d.section || '';
    // 关联概念 → id（保留名称列表，便于展示与检索）
    const names = (d.related || []).map(cleanText).filter(Boolean);
    d.relatedNames = names;
    d.relatedIds = names
      .map(n => byTitle.get(n) || byCleanTitle.get(n))
      .filter(id => id && id !== d.id);

    // 来源书籍：概念类来自知识树，其余来自各自书名
    d.sourceBook = d.book;

    // 掌握程度标签（保留原始 level 文本）
    d.levelLabel = d.level || '';

    // 检索文本重建（清洗后）
    d.text = [
      d.title, d.en || '', d.categoryL1, d.categoryL2,
      d.level || '', d.content, d.relatedNames.join(' '),
    ].filter(Boolean).join(' ');
  }
  return all;
}

// 知识树 → 概念类条目
(function walk(nodes, cats) {
  for (const n of nodes) {
    if (n.children && n.children.length) { walk(n.children, [...cats, n.title]); continue; }
    // 剔除与统一六步法冲突的 7 步法条目
    if (CONFLICT_SECTIONS.has(n.title)) { dropped++; continue; }
    let title = TITLE_FIX[n.title] || n.title;
    let body = n.desc || '';
    if (n.title === '全盘加密 FDE') body += '（注意：另有同名缩写 FDE 指「特性驱动开发」，两者无关。）';
    if (n.title === 'FDE特性驱动开发') body += '（注意：另有同名缩写 FDE 指「全盘加密」，两者无关。）';
    pushDoc({
      kind: 'concept',
      bookSource: 'AI产品经理知识树',
      group: cats[0] || '知识树',
      section: cats.length > 1 ? cats.slice(1).join(' → ') : (cats[0] || '') + ' · 总览',
      title,
      en: n.en || '',
      level: n.level || '',
      mark: emoji(n.level),
      content: body,
      related: n.related || [],
      text: [title, n.en || '', cats.join(' '), n.level || '', body, (n.related || []).join(' ')].join(' '),
    });
  }
})(tree, []);

// ---------- 2. 解析六步法 ----------
const sixSteps = [
  {
    title: '统一六步法总览',
    body: '智能体搭建六步：1 定场景 → 2 选模型 → 3 写提示词 → 4 配知识库 → 5 接工具并编排工作流 → 6 测试调优并发布。深入讲解时展开为八步：1定场景 2选模型取API Key 3写人设Prompt 4配知识库RAG 5配工具调用 6设计工作流 7测试迭代(记BadCase) 8部署上线。六步的第5步等于八步的第5+6步，六步的第6步等于八步的第7+8步。',
    text: '智能体 搭建 六步法 八步法 定场景 选模型 提示词 知识库 工具 工作流 测试 发布 部署',
  },
  {
    title: '第1步 定场景',
    body: '想清楚这个智能体帮谁、解决什么事。产出：一句话场景描述 + 它能做/不能做的清单。判断标准：能用一句话说清"给谁用、解决什么、不解决什么"。新手最容易错：跳过这步直接玩工作流，做出"能跑但没用"的东西然后放弃——这是新手放弃的头号原因。拦截话术："配工作流是第6步。场景没定清楚，工作流配得再漂亮也没用。先花5分钟告诉我你想让它干什么。"',
    text: '第1步 定场景 场景 想清楚 帮谁 解决什么 产出 判断标准 新手错误 跳过 工作流 放弃 拦截',
  },
  {
    title: '第2步 选模型',
    body: '选一个"大脑"，并拿到调用它的钥匙（API Key）。产出：确定的模型 + 可用 API Key。零基础第一次搭建议用平台内置模型，先不折腾 API Key。温度值(temperature)建议调低到 0.3-0.6，教学类智能体要的是稳定不是创意。新手最容易错：一上来纠结"哪个模型最强"——零基础阶段选哪个都能跑通，先走完流程比选对模型重要。',
    text: '第2步 选模型 模型 API Key 钥匙 内置模型 temperature 温度 随机性 稳定 选型 新手错误',
  },
  {
    title: '第3步 写提示词',
    body: '给智能体写"岗位说明书"。类比：智能体是知识面很广但没上过岗的新员工，提示词就是告诉他你是谁、干什么、怎么干、不能干什么。必写四块：角色、任务、边界、格式。判断标准：把提示词给一个陌生人看，他能准确说出这个智能体会怎么回答。新手最容易错：①只写"你是XX助手"就完事，任务和边界全缺 ②没写"不能做什么"，而边界比能力更重要 ③一次改十个地方，改完不知道哪个改动起作用——一次只改一个变量。',
    text: '第3步 写提示词 Prompt 岗位说明书 角色 任务 边界 格式 判断标准 新手错误 一次只改一个变量',
  },
  {
    title: '第4步 配知识库（RAG）',
    body: '给智能体配一本"随时能翻的参考手册"。类比：新员工光有岗位说明书不够，还得给他公司手册，遇到问题先翻手册而不是凭记忆瞎说。运行逻辑：用户提问 → 先去知识库搜相关内容 → 把"搜到的资料+用户问题"一起给大模型 → 大模型基于资料生成答案。为什么需要它：大模型有三个天生短板——会胡说（幻觉）、不知道你的内部数据、知识有截止日期。新手最容易错：①文档切得太碎，切片把一句话切断，检索出的片段没上下文 ②什么都往里塞，不相关内容把有用的挤下去 ③指望它万能。什么时候不用：问题如果是通用知识（模型本来就会），配知识库反而增加成本和不稳定。',
    text: '第4步 配知识库 RAG 检索增强 参考手册 切分 切片 幻觉 内部数据 知识截止 新手错误 向量 检索',
  },
  {
    title: '第5步 接工具并编排工作流',
    body: '接工具：让智能体能"动手"——读PDF、查网页、算数、生成图片、连企业系统。类比：工具=给它配的办公软件（有脑子但需要手和脚）。编排工作流：把多步骤任务串成固定流程。类比：工作流=标准作业流程SOP。为什么把这两步合并讲：工作流里需要调用工具节点，先设计工作流再补工具通常要回头返工——先明确需要哪些工具，再编排流程。新手最容易错：①一上来就玩工作流 ②多智能体过早引入，一个智能体能做好的事用三个智能体，复杂度爆炸 ③节点太多导致调试困难，先用3个节点跑通再加。',
    text: '第5步 接工具 工具 插件 工作流 编排 流水线 节点 SOP 办公软件 调用 新手错误 多智能体',
  },
  {
    title: '第6步 测试调优并发布',
    body: '测出问题、修掉、再上线。产出：一份测试记录（BadCase清单）+ 已发布的智能体。判断标准：准备5-10个真实测试用例逐个跑过，记录所有失败情况。BadCase就是智能体输出出错、效果不达标、任务执行失败的案例——收集并逐个修复是AI产品经理的核心工作之一。迭代循环：发现问题 → 分析原因（提示词？知识库？工具？模型？）→ 改一处 → 回归测试 → 下一个。准确率从70%→80%→90%就是迭代的价值。排查看Trace（链路追踪）：用户输入→怎么拆解→调了哪个工具→工具返回什么→哪一步报错→最终输出。新手最容易错：①只测正常情况，一定要测边界和异常 ②改完不回归，修了A场景B场景坏了 ③不记录，同一个错犯三次。',
    text: '第6步 测试 调优 发布 BadCase 坏案例 迭代 回归测试 Trace 链路追踪 异常 边界 上线',
  },
  {
    title: '智能体搭建常见问题 FAQ',
    body: 'Q一定要用API Key吗？不一定，平台零代码模式可直接用内置模型，API Key是外部调用或对比不同模型时才需要。Q RAG和微调选哪个？先试RAG，成本低见效快、改资料就能更新；微调成本高周期长，只有对风格或专业度要求极高才考虑。Q为什么智能体答得不准？按顺序查：①提示词写清楚了没（90%问题在这）②知识库里有没有对应内容 ③切片有没有切断语义 ④模型选得合不合适，不要一上来就想换模型或上微调。Q工作流和智能体什么关系？智能体是"会思考的人"，工作流是"给他定的作业流程"，简单任务不需要工作流。Q搭一个要多久？跑通一个能用的第一次大概2-4小时，做到好用需要反复迭代几天到几周，别信"10分钟搭一个"。',
    text: 'FAQ 常见问题 API Key RAG 微调 答得不准 工作流 关系 多久 时间 成本',
  },
];
for (const s of sixSteps) {
  // 统一六步法的内容就是《秒懂智能体》第6章"扣子智能体"那套流程的整理，
  // 归到该书名下，方便侧边目录按书浏览。
  pushDoc({ kind: 'agent', bookSource: '秒懂智能体：AI Agent重新定义未来工作', group: '智能体搭建', section: '统一六步法', ...s });
}
console.log(`[冲突消解] 从知识树剔除 ${dropped} 条"7步法"条目（与统一六步法冲突）`);

// 给"8步法"与"六步法总览"互加交叉说明：
// 这两条是同一流程的粗/细两种视图，不是两套不同方案，用户容易误读。
for (const d of docs) {
  if (d.title === '搭建智能体通用8步法') {
    d.content += '\n\n【与其他步法的关系】这是"智能体搭建六步法"的**深入讲解版**，' +
      '不是另一套流程。六步法（定场景→选模型→写提示词→配知识库→接工具并编排工作流→测试调优并发布）' +
      '是面向"我要开始搭"的简版；本 8 步法把第5步拆成"配工具调用+设计工作流"、把第6步拆成"测试迭代+部署上线"，' +
      '并把"选模型获取API Key""做用户界面"单独列出。**两套的步骤顺序完全相容，不要理解为两种做法。**';
    d.text += ' 六步法 关系 深入讲解版 简化版 不是另一套';
  }
  if (d.title === '统一六步法总览') {
    d.content += '\n\n【深入讲解版】需要更细的步骤时，见知识树"AI开发工具平台"下的' +
      '《搭建智能体通用8步法》——那是同一流程展开成 8 步的版本，顺序完全相容。';
    d.text += ' 八步法 通用8步法 深入讲解版 详版';
  }
}

// ---------- 3. 三本核心书（书目层） ----------
const books = [
  {
    title: '秒懂智能体：AI Agent重新定义未来工作',
    meta: '郭泽德 等｜清华大学出版社｜2025年4月',
    why: '国内较早系统讲解 AI Agent 落地的实战手册，精准切入智能体技术浪潮。',
    fit: '想自己动手搭智能体的零基础读者；产品经理、运营、创业者',
    chapters: [
      ['第1章 你不可不知的AI变革', '智能体的概念起源与核心定义；智能体与传统AI、聊天机器人的本质区别；工作原理、分类与典型类型；发展历程与未来趋势'],
      ['第2章 提示词设计：打造高效智能体', '提示词基础认知与核心原则；"八要素体系"提示词系统化设计方法；主流平台提示词落地指南；Manus提示词方法论'],
      ['第3章 文心一言智能体', '平台功能与能力边界；从0到1构建专属智能体的完整步骤；实战案例"高情商大师"智能体'],
      ['第4章 智谱清言智能体', '平台核心能力；构建流程与进阶功能；创意生产类智能体实战'],
      ['第5章 GPTs进阶指南', '基础操作与核心能力；从构思到创建专属AI助手；自定义Action（插件）开发与配置'],
      ['第6章 扣子智能体', '扣子平台架构与生态；零代码快速入门；插件能力与知识库接入；多智能体协同工作流设计'],
    ],
  },
  {
    title: 'AI产品经理实战：从大模型集成到商业化落地',
    meta: '颜佳明、李思 等｜机械工业出版社｜2026年6月｜242页｜ISBN 9787111810636',
    why: '2026年最新出版的国内原创实战书，覆盖从产品设计到商业化落地的完整链路。',
    fit: '传统产品经理转型AI方向；想了解国内AI产品实践的人',
    chapters: [
      ['第1章 AI产品简介与方法论基础', 'AI产品经理的职责；AI产品开发的关键流程与管理机制；AI思维下的产品定义方法；AI在产品中的嵌入方式；产品案例分析'],
      ['第2章 AI产品原型设计', 'AI可行场景判断；产品原型设计方法与工具；大模型能力边界与原型验证方案'],
      ['第3章 大模型技术选型与集成', '主流大模型对比与选型策略；Prompt工程体系化设计；RAG知识库搭建与优化；模型微调与Agent开发入门'],
      ['第4章 AI产品交互体验设计', '智能交互核心原则；对话式交互设计方法；多模态交互设计实践；容错机制与用户信任构建'],
      ['第5章 AI产品商业化落地', '成本测算与定价模型；商业模式设计；合规风控与数据安全；规模化落地与增长策略'],
      ['第6章 行业实战案例拆解', 'C端AI工具产品、B端企业智能系统、G端政务智能化项目三大类案例'],
    ],
    caution: '⚠️ 该书章节结构在不同资料中存在两种说法，本目录采用"12章"版本的要点归纳，建议对照原书核实。',
  },
  {
    title: 'AI产品经理：方法、技术与实战',
    meta: '王泽楷｜机械工业出版社｜4篇13章',
    why: '国内体系最完整的 AI 产品经理经典教材，被多所高校选为参考用书。',
    fit: '零基础读者搭建完整AI产品知识框架；从业者查漏补缺',
    chapters: [
      ['第1章 深入理解AI和AI产品', 'AI的定义、三大学派、发展历程与产业政策；AI产品的定义、技术产品化、产业化与标准化；AI产品落地的核心价值与普遍难题'],
      ['第2章 AI产品经理职业全景', '角色定位与职责；职业发展路径与能力知识体系；不同背景转型AI产品经理的方法'],
      ['第3-6章 AI技术通识', '机器学习基础（监督/无监督/强化学习、深度学习原理与局限、迁移学习）；计算机视觉；语音识别与自然语言处理；AI云原生与工程化'],
      ['第7-11章 AI产品落地实践', 'AI产品通用方法论；算法类产品（自动驾驶、智能汽车）；中台类产品（企业智能中台、能力开放平台）；业务类产品（城市治理、企业服务、个人消费级）'],
      ['第12-13章 行业与项目实战', '安防、制造业、汽车三大行业案例；B/G端项目可行性验证与交付'],
    ],
  },
];
for (const b of books) {
  for (const [title, body] of b.chapters) {
    pushDoc({
      kind: 'book',
      bookSource: b.title,
      group: b.title,
      section: title,
      title: `${b.title} · ${title}`,
      content: `${body}\n\n【本书定位】${b.why}\n【适合谁】${b.fit}\n【出版信息】${b.meta}${b.caution ? '\n' + b.caution : ''}`,
      text: [b.title, title, body, b.why, b.fit, b.meta].join(' '),
    });
  }
  pushDoc({
    kind: 'book',
    bookSource: b.title,
    group: b.title,
    section: '书目信息与阅读建议',
    title: `${b.title} · 书目信息`,
    content: `【定位】${b.why}\n【适合谁】${b.fit}\n【出版信息】${b.meta}${b.caution ? '\n' + b.caution : ''}`,
    text: [b.title, b.why, b.fit, b.meta, '推荐 选书 适合 阶段 阅读'].join(' '),
  });
}

// ---------- 4. 清洗 + 结构化 → 目录树 & 统计 ----------
finalizeDocs(docs);

// 目录树：一级分类 → 二级分类 → 知识点（前端做多级折叠展开）
const catalog = [];
const byL1 = {};
for (const d of docs) {
  (byL1[d.categoryL1] = byL1[d.categoryL1] || []).push(d);
}
for (const [l1, list] of Object.entries(byL1)) {
  const byL2 = {};
  for (const d of list) {
    const k = d.categoryL2 || '总览';
    (byL2[k] = byL2[k] || []).push(d);
  }
  catalog.push({
    category: l1,
    count: list.length,
    children: Object.entries(byL2).map(([l2, ds]) => ({
      category: l2,
      count: ds.length,
      items: ds.map(d => ({
        id: d.id, name: d.name, title: d.title,
        mark: d.mark, level: d.level, kind: d.kind,
      })),
    })),
  });
}

// 关联网络统计：有多少知识点建立了关联
const withRel = docs.filter(d => (d.relatedIds || []).length > 0).length;
const avgRel = (docs.reduce((s, d) => s + (d.relatedIds || []).length, 0) / docs.length).toFixed(2);

const stats = {
  total: docs.length,
  concept: docs.filter(d => d.kind === 'concept').length,
  agent: docs.filter(d => d.kind === 'agent').length,
  book: docs.filter(d => d.kind === 'book').length,
  mustLearn: docs.filter(d => d.mark === '🔴').length,
  needUnderstand: docs.filter(d => d.mark === '🟡').length,
  justKnow: docs.filter(d => d.mark === '⚪').length,
  treeTotal: docs.filter(d => d.kind === 'concept').length,
  categories: catalog.length,
  withRelations: withRel,
  avgRelations: +avgRel,
  enriched: docs.filter(d => d.enriched).length,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), stats, catalog, docs }, null, 0), 'utf8');
console.log('生成完成:', OUT);
console.log('总条目', stats.total, '| 概念', stats.concept, '| 智能体', stats.agent, '| 书目', stats.book);
console.log('掌握程度: 🔴', stats.mustLearn, '🟡', stats.needUnderstand, '⚪', stats.justKnow);
console.log('目录分组:', catalog.map(c => `${c.category}(${c.count})`).join(' '));
console.log(`关联网络: ${stats.withRelations}/${stats.total} 条有关联概念，平均 ${stats.avgRelations} 个`);
if (stats.enriched) console.log(`内容增强: ${stats.enriched} 条已由大模型补充完善`);
console.log('文件大小:', (fs.statSync(OUT).size / 1024).toFixed(1), 'KB');

// ---------- 5. 离线构建倒排索引（关键词匹配用，无 Embedding） ----------
// 中文用字符 bigram 切分：不需要词典、零依赖，对中文关键词匹配效果好。
// "智能体怎么搭建" → 智能/能体/体怎/怎么/么搭/搭建
const STOP = new Set('的了和是在有与及或我你他她它们这那什么怎么如何为什么吗呢吧啊哦嗯一个能不能可以需要要是就是都也很还只把被让对从到与以及等'.split(''));

function termsOf(text) {
  const out = new Set();
  const s = String(text || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (/[\u4e00-\u9fa5]/.test(c)) {
      if (!STOP.has(c)) out.add(c);
      if (i + 1 < s.length) {
        const c2 = s[i + 1];
        if (/[\u4e00-\u9fa5]/.test(c2)) {
          const bg = c + c2;
          // 两边都不能是停用字：避免"不可""么搭"这类跨词 bigram 造成误召回
          // （例如"可不可行"曾命中"条件判断"，就是"不可"造成的）
          if (!STOP.has(c) && !STOP.has(c2)) out.add(bg);
        }
      }
    } else if (/[a-z0-9]/.test(c)) {
      let j = i;
      while (j < s.length && /[a-z0-9+#.]/.test(s[j])) j++;
      out.add(s.slice(i, j));
      i = j - 1;
    }
  }
  // 英文/缩写也要抓：注意 RAG、LLM、API、MVP、MCP、PRD 都是 3 字母，
  // 原正则写成 [a-z][a-z0-9+#.]{1,} 要求至少 2 位，会把它们全部漏掉。
  for (const w of String(text || '').toLowerCase().match(/[a-z][a-z0-9+#.]*/g) || []) out.add(w);
  return [...out];
}

const postings = {};            // term -> [docIdx...]
const docMap = {};              // docIdx -> docId
const docTerms = [];            // docIdx -> [terms]
docs.forEach((d, i) => {
  docMap[i] = d.id;
  const ts = termsOf(d.text || (d.title + ' ' + d.content));
  docTerms.push(ts);
  for (const t of ts) {
    (postings[t] = postings[t] || []).push(i);
  }
});

fs.writeFileSync(OUT_IDX, JSON.stringify({
  generatedAt: new Date().toISOString(),
  docCount: docs.length,
  termCount: Object.keys(postings).length,
  docMap,
  postings,
  docTerms,
}), 'utf8');
console.log('索引完成:', OUT_IDX);
console.log('词条数', Object.keys(postings).length, '| 大小', (fs.statSync(OUT_IDX).size / 1024).toFixed(1), 'KB');

// ---------- 6. 自检：跑几条真实检索，确认不是空召回 ----------
// IDF 用"正文文档频率"而不是"标题命中数"：
// 标题很短的片段（如"条件判断 if/else"）否则会因为标题加权被排到第一。
function search(query, topK = 3) {
  const qTerms = termsOf(query);
  const N = docs.length;
  // 正文文档频率
  const bodyDf = {};
  for (let i = 0; i < docs.length; i++) {
    const body = ((docs[i].content || '') + ' ' + (docs[i].section || '')).toLowerCase();
    for (const t of new Set(qTerms)) {
      if (body.includes(t)) bodyDf[t] = (bodyDf[t] || 0) + 1;
    }
  }
  const bodyDfAll = {};
  for (let i = 0; i < docs.length; i++) {
    for (const t of docTerms[i]) {
      const body = ((docs[i].content || '') + ' ' + (docs[i].section || '')).toLowerCase();
      if (body.includes(t)) bodyDfAll[t] = (bodyDfAll[t] || 0) + 1;
    }
  }

  const scores = new Map();
  for (const t of qTerms) {
    const pl = postings[t];
    if (!pl) continue;
    const df = bodyDfAll[t] || pl.length;
    const idf = Math.log(1 + N / df);
    const w = t.length >= 2 ? 1.6 : 1.0;
    for (const i of pl) {
      // 标题加权只在"正文也命中"时才给，避免短标题片段靠标题蹭分
      const bodyHit = ((docs[i].content || '') + ' ' + (docs[i].section || '')).toLowerCase().includes(t);
      const titleHit = bodyHit && (docs[i].title || '').toLowerCase().includes(t) ? 1.5 : 1.0;
      scores.set(i, (scores.get(i) || 0) + idf * w * titleHit);
    }
  }
  return [...scores.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    // 决胜：标题恰好等于查询词（如查"什么是RAG"命中标题就是"RAG"的条目）排前面。
    // 否则会退化成按插入顺序，把正主挤出 top3。
    const at = (docs[a[0]].title || '').trim().toLowerCase();
    const bt = (docs[b[0]].title || '').trim().toLowerCase();
    const aExact = qTerms.some(t => at === t) ? 1 : 0;
    const bExact = qTerms.some(t => bt === t) ? 1 : 0;
    if (bExact !== aExact) return bExact - aExact;
    return a[0] - b[0];
  }).slice(0, topK)
    .map(([i, s]) => ({ id: docs[i].id, index: i, title: docs[i].title, score: +s.toFixed(2) }));
}

console.log('\n=== 检索自检 ===');
for (const q of ['什么是RAG', '智能体怎么搭建', '怎么判断AI产品可不可行', '推荐几本书', 'PRD怎么写']) {
  const r = search(q);
  console.log(`\nQ: ${q}`);
  if (!r.length) console.log('   ⚠️ 空召回');
  else r.forEach(x => console.log(`   ${x.score}  ${x.title}`));
}
