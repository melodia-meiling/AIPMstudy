#!/usr/bin/env node
/**
 * AIPM 学习工作台 · MVP 后端（单文件）
 * =====================================================================
 * 架构：
 *   data/kb.json          知识库（build_kb.js 离线生成，零 API 调用）
 *   data/index.json       倒排索引（离线生成，供关键词打分）
 *   data/embeddings.json  片段语义向量（build_embeddings.js 离线生成）
 *   public/index.html     前端（对话窗 + 侧边知识目录）
 *
 * 检索：混合检索 = 语义向量（本地 bge-base-zh-v1.5）+ 关键词（bigram 倒排）+ 标题加成
 *       · 向量在此**只读不加载模型**（服务端启动不含模型，秒起、且完全离线）
 *       · 向量文件由 build_embeddings.js 用 @xenova/transformers 离线生成
 *       · 缺向量文件时自动退化为纯关键词检索，不会挂
 *
 * DeepSeek：只在用户发消息时调用一次 /chat/completions，流式返回。
 *          启动、构建、检索、看目录都不调用任何外部 API。
 *
 * 启动：node server.js
 * 环境变量（都可选）：
 *   PORT              端口，默认 3000
 *   DEEPSEEK_API_KEY  API Key；不设则自动从 ~/.dsh/.credentials.yaml 读取
 *   DEEPSEEK_MODEL    模型，默认 deepseek-chat
 *   DEEPSEEK_BASE     API 基址，默认 https://api.deepseek.com
 *   ENABLE_QUERY_MODEL=1  启用真实查询编码（需加载模型，启动变慢但检索更准）
 * =====================================================================
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { URL } = require('node:url');
const crypto = require('node:crypto');

const ROOT = __dirname;
// DATA_DIR 可经环境变量覆盖，便于在不改动正式数据的情况下用另一份知识库做预览/对比
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');

const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const BASE = process.env.DEEPSEEK_BASE || 'https://api.deepseek.com';
const TOP_K = 3;                    // 需求：召回最相关的 3 个片段
const MAX_CONTEXT_CHARS = 4500;     // 上下文长度上限，防止把 prompt 撑爆

// ---------------------------------------------------------------------------
// 1. 读取知识库与索引
// ---------------------------------------------------------------------------
function loadJSON(p) {
  if (!fs.existsSync(p)) {
    console.error(`\n[致命] 找不到 ${p}`);
    console.error('请先运行：node build_kb.js\n');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const KB = loadJSON(path.join(DATA_DIR, 'kb.json'));
const IDX = loadJSON(path.join(DATA_DIR, 'index.json'));
const DOCS = KB.docs;

console.log(`[知识库] ${DOCS.length} 个片段 · 索引 ${IDX.termCount} 词条`);
console.log(`[知识库] 分布 ${JSON.stringify(KB.stats)}`);

// ---------------------------------------------------------------------------
// 2. 检索（混合：本地语义向量 + 关键词，全程离线，不用外部 Embedding API）
// ---------------------------------------------------------------------------
const STOP = new Set(
  '的了和是在有与及或我你他她它们这那什么怎么如何为什么吗呢吧啊哦嗯一个能不能可以需要要是就是都也很还只把被让对从到与以及等'.split('')
);

function termsOf(text) {
  const out = new Set();
  const s = String(text || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (/[\u4e00-\u9fa5]/.test(c)) {
      if (!STOP.has(c)) out.add(c);
      if (i + 1 < s.length) {
        const c2 = s[i + 1];
        // 两边都不能是停用字，避免"不可"这类跨词 bigram 误召回
        if (/[\u4e00-\u9fa5]/.test(c2) && !STOP.has(c) && !STOP.has(c2)) out.add(c + c2);
      }
    } else if (/[a-z0-9]/.test(c)) {
      let j = i;
      while (j < s.length && /[a-z0-9+#.]/.test(s[j])) j++;
      out.add(s.slice(i, j));
      i = j - 1;
    }
  }
  // 英文缩写（RAG/LLM/API/MVP/PRD）也要抓，长度 1 起
  for (const w of String(text || '').toLowerCase().match(/[a-z][a-z0-9+#.]*/g) || []) out.add(w);
  return [...out];
}

// 预计算"正文文档频率"（IDF 用正文 df，而不是标题命中数）
const BODY = DOCS.map(d => ((d.content || '') + ' ' + (d.section || '') + ' ' + (d.title || '')).toLowerCase());
const BODY_DF = {};
for (let i = 0; i < DOCS.length; i++) {
  for (const t of new Set(IDX.docTerms[i] || [])) {
    if (BODY[i].includes(t)) BODY_DF[t] = (BODY_DF[t] || 0) + 1;
  }
}

// 关键词打分（作为混合检索的第二路信号，不单独使用）
function keywordScores(qTerms) {
  const N = DOCS.length, sc = new Map();
  for (const t of qTerms) {
    const pl = IDX.postings[t];
    if (!pl) continue;
    const df = BODY_DF[t] || pl.length;
    const idf = Math.log(1 + N / df);
    const w = t.length >= 2 ? 1.6 : 1.0;
    for (const i of pl) {
      const bodyHit = BODY[i].includes(t);
      const tb = bodyHit && DOCS[i].title.toLowerCase().includes(t) ? 1.5 : 1.0;
      sc.set(i, (sc.get(i) || 0) + idf * w * tb);
    }
  }
  // tanh 软压缩：实测比"归一化到 0..1"更好——归一化会让关键词头名恒为 1.0，
  // 容易把短标题片段顶到语义正确答案前面，且会拉高超纲问题的分数。
  for (const [k, v] of sc) sc.set(k, Math.tanh(v / 20));
  return sc;
}

// ---------------------------------------------------------------------------
// 语义向量（离线生成，服务端只读不加载模型）
// ---------------------------------------------------------------------------
const EMB_PATH = path.join(DATA_DIR, 'embeddings.json');
let EMB = null;
let EMB_VECS = null;
let EMB_DIM = 0;

function loadEmbeddings() {
  if (!fs.existsSync(EMB_PATH)) {
    console.log('[向量] ⚠️ 未找到 data/embeddings.json —— 将退化为纯关键词检索');
    console.log('[向量]    生成方式：node build_embeddings.js');
    return;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(EMB_PATH, 'utf8'));
    if (raw.ids.length !== DOCS.length) {
      console.log(`[向量] ⚠️ 向量条数(${raw.ids.length})与知识库片段数(${DOCS.length})不一致 —— 退化为纯关键词检索`);
      console.log('[向量]    知识库变过之后请重跑：node build_embeddings.js');
      return;
    }
    // 校验顺序一致，防止 kb.json 重排后向量错位
    for (let i = 0; i < DOCS.length; i++) {
      if (raw.ids[i] !== DOCS[i].id) {
        console.log('[向量] ⚠️ 向量与片段 ID 顺序不一致 —— 退化为纯关键词检索，请重跑 build_embeddings.js');
        return;
      }
    }
    const buf = Buffer.from(raw.data, 'base64');
    const i16 = new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);
    const dim = raw.dim, scale = raw.scale || 32767;
    const vecs = new Array(raw.ids.length);
    for (let i = 0; i < raw.ids.length; i++) {
      const v = new Float32Array(dim);
      const off = i * dim;
      for (let j = 0; j < dim; j++) v[j] = i16[off + j] / scale;
      vecs[i] = v;
    }
    EMB = raw; EMB_VECS = vecs; EMB_DIM = dim;
    console.log(`[向量] ✅ ${raw.ids.length} 条 × ${dim} 维 · 模型 ${raw.model}`);
  } catch (e) {
    console.log('[向量] ⚠️ 向量文件读取失败：' + e.message + ' —— 退化为纯关键词检索');
  }
}
loadEmbeddings();

// ---------------------------------------------------------------------------
// 2.5 用户数据层（笔记 / 已学 / AI补全 / 新知识 / 题库 / 错题 / 设置）
//     全部落在 data/ 下的独立 JSON，不写 kb.json，避免破坏向量与片段的对齐关系。
//     需要合并展示时在读取阶段合并（见 mergeDoc）。
// ---------------------------------------------------------------------------
const STORE_FILES = {
  notes: 'notes.json',               // { docId: { text, updatedAt } }
  learned: 'learned.json',           // { docId: { at } }
  enrich: 'enrich.json',             // { docId: [ { id, kind, text, refs, at } ] }
  newknowledge: 'newknowledge.json', // [ { id, title, content, tags, from, kind, at } ]
  quiz: 'quiz.json',                 // { docId: [ { q, options, answer, explain } ] }
  wrong: 'wrong.json',               // [ { id, docId, q, chosen, answer, at } ]
  // 以下为「仪表盘/打卡/目标/作品集」新增，同样纳入多用户隔离
  goals: 'goals.json',               // { text, target, updatedAt }
  portfolio: 'portfolio.json',       // [ { id, title, type, docId, summary, link, at } ]
  activity: 'activity.json',         // [ { at, kind, docId, detail } ]  ← 只记时间线，不存内容
  settings: 'settings.json',         // { searchProvider, searchKey, useWebDefault }
};
// 哪些 store 的顶层结构是「数组」而不是「对象」——集中定义，避免多处判定漏改
const ARRAY_STORES = new Set(['newknowledge', 'wrong', 'portfolio', 'activity']);
const emptyFor = (key) => (ARRAY_STORES.has(key) ? [] : {});

const STORES = {};

function storePath(name) { return path.join(DATA_DIR, STORE_FILES[name]); }

function loadStore(name, fallback) {
  try {
    const p = storePath(name);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.log(`[数据] ${name} 读取失败（${e.message}），本次用默认值`);
  }
  return fallback;
}

// 原子写：先写 .tmp 再改名，避免服务被中断时把文件写坏
function saveStore(name, data) {
  const p = storePath(name);
  fs.writeFileSync(p + '.tmp', JSON.stringify(data, null, 1), 'utf8');
  fs.renameSync(p + '.tmp', p);
}

// 旧版扁平结构 {docId: data} → 新版命名空间 {ownerId: {docId: data}}
// 判断依据：键名是知识点 id（形如 d12）就是旧结构；键名是匿名 id（形如 u_xxx）就是新结构。
function migrateToNamespaced(name, data) {
  if (name === 'settings') return data;
  const isDocKey = k => /^d\d+$/.test(k);
  if (Array.isArray(data)) return { owner: data };          // 新知识/错题：旧版是数组
  const keys = Object.keys(data || {});
  if (!keys.length) return {};
  // 有任何"非知识点 id"的键 → 认为已经是命名空间结构
  if (keys.some(k => !isDocKey(k))) return data;
  // 全是知识点 id → 旧结构，整体归到 owner 名下（保留你现有的笔记与已学状态）
  console.log(`[数据] ${name}：旧版扁平结构已迁移到 owner 命名空间（${keys.length} 项）`);
  return { owner: data };
}

for (const k of Object.keys(STORE_FILES)) {
  const fb = emptyFor(k);
  STORES[k] = migrateToNamespaced(k, loadStore(k, fb));
  if (!fs.existsSync(storePath(k))) saveStore(k, STORES[k]);
}
STORES.settings = Object.assign(
  {
    searchProvider: 'bocha',
    searchKey: '',
    useWebDefault: false,   // 旧字段，保留兼容
    webMode: 'auto',        // auto=系统自己判断 / always=每次都联网 / never=从不联网
    autoEnrich: true,       // 笔记写完自动让 AI 补全
    autoEnrichMinChars: 15, // 笔记至少多少字才值得自动补全
  },
  STORES.settings
);

// 环境变量覆盖：部署场景下所有机密与开关都由管理员通过平台环境变量下发，
// 不用（也不该）让访客在网页上填。环境变量优先级高于 settings.json。
if (process.env.SEARCH_PROVIDER) STORES.settings.searchProvider = process.env.SEARCH_PROVIDER;
if (process.env.SEARCH_API_KEY) STORES.settings.searchKey = process.env.SEARCH_API_KEY;
if (process.env.WEB_MODE) STORES.settings.webMode = process.env.WEB_MODE;
if (process.env.AUTO_ENRICH === '0') STORES.settings.autoEnrich = false;

// ---------------------------------------------------------------------------
// 2.2 多用户数据隔离（公网部署必需）
// ---------------------------------------------------------------------------
// 问题：原实现把所有学习数据（笔记/已学/错题/新知识/收藏）存在**全实例共享**的
//       JSON 对象里。部署到公网后，任何访客都能看到别人写的笔记和错题。
//
// 做法：磁盘结构从 {docId: data} 改为 {ownerId: {docId: data}}，
//       再用 Proxy 让原有 `stores.notes[docId]` 写法自动落到 data[clientId] 下，
//       这样不用改动几十处调用点。
//
// ownerId 来自 httpOnly Cookie（首次访问自动下发），前端无需任何改动。
// settings 是全局配置（不是个人学习数据），不参与隔离。
// ---------------------------------------------------------------------------
const cookieParser = (req, name) => {
  const raw = req.headers.cookie;
  if (!raw) return '';
  const m = raw.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : '';
};

// 取（或首次下发）客户端标识。httpOnly Cookie，前端完全无感。
// 首次访问生成一个匿名 id，之后所有个人数据都挂在这个 id 下。
// ⚠️ 容器平台重启会清空磁盘，届时会重新下发新 id（学习记录随之丢失）。
//    需要长期保留就挂持久化盘，或把 STORES 的读写换成外部存储。
function getClientId(req, res) {
  let cid = cookieParser(req, 'aipm_uid');
  if (cid && /^[A-Za-z0-9_-]{6,40}$/.test(cid)) return cid;
  cid = 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  res.setHeader('Set-Cookie',
    `aipm_uid=${encodeURIComponent(cid)}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`);
  return cid;
}

// ---------------------------------------------------------------------------
// 命名空间根：只读私有引用 + 请求级作用域
// ---------------------------------------------------------------------------
// 演进史（都是踩过的坑，改前务必读）：
//   第 1 版用 Proxy 让 STORES.notes[d.id] 自动落到 data[clientId]。
//     踩坑：数组经 Proxy 后 JSON.stringify 失效（返回 {"length":0}）、
//           对象展开进入死循环导致 /api/tree 挂死、写后读读不到。
//   第 2 版改成「请求开始切换、请求结束还原」，但用 `saved[k] = STORES[k]`
//     把当时的值当作"根"。踩坑：只要有一次请求没走到还原（连接被掐、
//     异常、进程被杀），STORES[k] 就永久停在某个用户桶上，之后每次请求
//     都把新用户桶塞进旧桶，形成 {uidA:{uidB:{uidC:{}}}} 嵌套；
//     而 persistScope 与还原逻辑指向不同的根，于是出现
//     "写入返回成功、读取却是空"的幽灵 bug。
//   第 3 版（现在）：根只保留私有引用 ROOT_DATA，**永不从 STORES 读根**，
//     一律按 ownerId 定址。漏一次还原也不会累积污染，下个请求自动纠偏。
//     另外 bucketFromRoot() 会检测并修复历史遗留的嵌套污染。
const ROOT_DATA = {};
for (const k of Object.keys(STORE_FILES)) ROOT_DATA[k] = STORES[k];

// 判断一个"桶"是不是被污染的嵌套结构（它的 key 里出现了别的用户 id）
const looksLikeUserId = (k) => /^(u_[A-Za-z0-9]+|owner|anonymous)$/.test(k);
function isPollutedBucket(bucket) {
  if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) return false;
  return Object.keys(bucket).some(looksLikeUserId);
}

// 从根里取（必要时创建）某用户的桶；顺带修复被污染的嵌套结构
function bucketFromRoot(key, ownerId) {
  const root = ROOT_DATA[key];
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    // 根本身被污染成数组了，重建
    ROOT_DATA[key] = emptyFor(key);
  }
  const R = ROOT_DATA[key];
  let bucket = R[ownerId];

  if (!bucket) {
    bucket = emptyFor(key);
    R[ownerId] = bucket;
  } else if (isPollutedBucket(bucket) && !Array.isArray(bucket)) {
    // 该桶里混进了别的用户 id → 说明它是被当成"根"用过。
    // 把里面的用户桶提升到真正的根上（保住数据），再给当前用户一个干净桶。
    let rescued = 0;
    for (const [k2, v2] of Object.entries(bucket)) {
      if (!looksLikeUserId(k2)) continue;
      if (!R[k2]) { R[k2] = v2; rescued++; }
      delete bucket[k2];
    }
    console.log(`[数据] ${key}: 修复嵌套污染，迁移出 ${rescued} 个用户桶`);
  }

  Object.defineProperty(bucket, '__ownerId', {
    value: ownerId, enumerable: false, configurable: true, writable: true,
  });
  return bucket;
}

// 进入某用户的作用域。返回值只是给调用方做标识，不再用于"还原根"。
function enterUserScope(clientId) {
  const ownerId = clientId || 'anonymous';
  for (const k of Object.keys(STORE_FILES)) {
    if (k === 'settings') continue;
    STORES[k] = bucketFromRoot(k, ownerId);
  }
  return { ownerId };
}

// 作用域里当前用户的数据（供 diff / persist 使用）
function currentBucket(key) {
  const cur = STORES[key];
  const ownerId = cur && cur.__ownerId;
  if (!ownerId) return null;
  return { ownerId, root: ROOT_DATA[key], bucket: cur };
}

// ---------------------------------------------------------------------------
// 学习活动时间线：靠「作用域前后差量」自动记录
// ---------------------------------------------------------------------------
// 为什么这样做：
//   要支持「今日学习时长/完成任务数/打卡日历」，必须有带时间戳的活动记录。
//   但逐个去改十几个写接口（note/learned/quiz.submit/enrich…）既啰嗦又容易漏
//   —— 比如 /api/quiz/submit 只给错题打了时间戳，答对的题不留痕迹。
//   这里改成在 exitUserScope 里统一比对"请求前 vs 请求后"的差异，
//   凡是新增的条目就记一条活动。以后新增写接口也自动被覆盖。
//
// 隐私说明：activity 只记「什么时间、对哪个知识点、做了哪类动作」，
//          不复制笔记/答案等正文内容。
const ACTIVITY_KINDS = {
  notes: { kind: 'note', label: '写笔记' },
  learned: { kind: 'learn', label: '标记已学' },
  enrich: { kind: 'enrich', label: 'AI 补全笔记' },
  newknowledge: { kind: 'newknowledge', label: '新增知识' },
  quiz: { kind: 'quiz', label: '生成练习题' },
  wrong: { kind: 'wrong', label: '产生错题' },
  portfolio: { kind: 'portfolio', label: '新增作品' },
};

// 从「旧数据 vs 新数据」中找出新增/变更的条目，生成活动记录（最多 20 条/请求）
function collectActivity(before, after, ownerId) {
  const out = [];
  const now = new Date().toISOString();
  for (const [store, meta] of Object.entries(ACTIVITY_KINDS)) {
    const a = after[store];
    if (!a) continue;
    const b = before[store] || emptyFor(store);
    const at = (obj, k) => (obj && Object.prototype.hasOwnProperty.call(obj, k) ? obj[k] : undefined);

    if (Array.isArray(a)) {
      const beforeIds = new Set((Array.isArray(b) ? b : []).map(x => x && x.id).filter(Boolean));
      for (const it of a.slice(0, 30)) {
        if (!it) continue;
        const id = it.id || (it.docId + '|' + String(it.q || '').slice(0, 24));
        if (beforeIds.has(it.id)) continue;
        // 数组型 store 里，只有带 id 的新条目才算新增（避免重复记录）
        if (it.id && beforeIds.has(it.id)) continue;
        out.push({
          at: typeof it.at === 'string' ? it.at : now,
          kind: meta.kind, label: meta.label,
          docId: it.docId || '', detail: String(it.title || it.docTitle || '').slice(0, 40),
        });
        if (out.length >= 20) return out;
      }
    } else {
      const keys = new Set([...Object.keys(b || {}), ...Object.keys(a || {})]);
      for (const k of keys) {
        const ov = at(b, k), nv = at(a, k);
        if (JSON.stringify(ov) === JSON.stringify(nv)) continue;
        if (nv === undefined) continue;   // 删除不算学习活动
        const ts = (nv && (nv.updatedAt || nv.at)) || now;
        out.push({
          at: typeof ts === 'string' ? ts : now,
          kind: meta.kind, label: meta.label,
          docId: /^d\d+$/.test(k) ? k : '',
          detail: (/^d\d+$/.test(k) ? '' : k).slice(0, 40),
        });
        if (out.length >= 20) return out;
      }
    }
  }
  return out;
}

// 退出作用域：把当前用户的数据写回根并落盘。
// 刻意不使用任何"进入时保存的引用"——只按 ownerId 从 ROOT_DATA 定址，
// 这样即使上一次请求泄漏了状态，本函数也只会写到正确的位置。
function exitUserScope(scope) {
  const ownerId = (scope && scope.ownerId) || (STORES.notes && STORES.notes.__ownerId);
  if (!ownerId) return;

  // ① 记录本请求产生的学习活动（必须在写回之前做，才能拿到 diff）
  try {
    const stream = ROOT_DATA.activity[ownerId] || (ROOT_DATA.activity[ownerId] = []);
    const before = {}, after = {};
    for (const k of Object.keys(ACTIVITY_KINDS)) {
      before[k] = ROOT_DATA[k][ownerId] || emptyFor(k);
      after[k] = STORES[k];
    }
    const events = collectActivity(before, after, ownerId);
    if (events.length) {
      for (const e of events) {
        if (stream.some(x => x.at === e.at && x.kind === e.kind && x.docId === e.docId)) continue;
        stream.push(e);
      }
      if (stream.length > 800) stream.splice(0, stream.length - 800);
      try { saveStore('activity', ROOT_DATA.activity); } catch (e) {
        console.error('[数据] activity 落盘失败：' + e.message);
      }
    }
  } catch (e) {
    console.error('[活动] 记录失败：' + e.message);
  }

  // ② 按 ownerId 把各 store 的最新数据写回根（整体替换也能正确落位）
  for (const k of Object.keys(STORE_FILES)) {
    if (k === 'settings') continue;
    const root = ROOT_DATA[k];
    const scoped = STORES[k];
    if (root && typeof root === 'object' && !Array.isArray(root)) {
      // 只有"当前作用域确实属于这个用户"时才回写，避免把别人的桶写进来
      const ownerOfScoped = scoped && scoped.__ownerId;
      if (ownerOfScoped === ownerId || ownerOfScoped === undefined) {
        root[ownerId] = scoped;
      }
    }
    try { saveStore(k, ROOT_DATA[k]); } catch (e) {
      console.error(`[数据] ${k} 落盘失败：${e.message}`);
    }
  }
}

// 作用域内改完数据立刻落盘（只写当前用户所在的桶，不碰别人的数据）。
// ⚠️ 绝对不能写 saveStore('notes', S.notes) —— S.notes 是该用户的桶，
//    那样会把整个文件覆盖成单个用户的数据，摧毁其他人的记录。
//
// ⚠️ 整体替换 store 时必须调用 replaceStore()：
//    落盘靠 __ownerId 标记来定位"这份数据属于谁"，而 new Array()/new Object()
//    是不带标记的。曾经因此出现"保存成功但读回还是旧值"（goals、portfolio 删除）。
function tagOwner(obj, ownerId) {
  if (!obj || typeof obj !== 'object' || !ownerId) return obj;
  try {
    Object.defineProperty(obj, '__ownerId', {
      value: ownerId, enumerable: false, configurable: true, writable: true,
    });
  } catch { /* 冻结对象等极端情况忽略 */ }
  return obj;
}

// 用新数据整体替换当前作用域里的某个 store。
// 新对象本身不带 ownerId，靠这里补上；落盘时 exitUserScope 也会按当前
// 请求的 ownerId 兜底回写，两层保证不会"改了但没生效"。
function replaceStore(key, next, current) {
  const ownerId = (current && current.__ownerId) || (STORES[key] && STORES[key].__ownerId);
  tagOwner(next, ownerId);
  STORES[key] = next;
  return next;
}

// 作用域内改完数据立刻落盘（只写当前用户所在的桶，不碰别人的数据）。
// ⚠️ 绝对不能写 saveStore('notes', S.notes) —— S.notes 是该用户的桶，
//    那样会把整个文件覆盖成单个用户的数据，摧毁其他人的记录。
function persistScope() {
  for (const k of Object.keys(STORE_FILES)) {
    if (k === 'settings') continue;
    const scoped = STORES[k];
    const ownerId = scoped && scoped.__ownerId;
    if (process.env.SCOPE_DEBUG === '1') {
      console.log('[scope] ' + k + ' ownerId=' + (ownerId || '(无)') +
        ' isArray=' + Array.isArray(scoped) +
        ' len=' + (scoped && typeof scoped === 'object' ? Object.keys(scoped).length : '-'));
    }
    if (!ownerId) continue;
    const root = ROOT_DATA[k];
    if (root && typeof root === 'object' && !Array.isArray(root)) root[ownerId] = scoped;
    try { saveStore(k, root); } catch (e) {
      console.error(`[数据] ${k} 落盘失败：${e.message}`);
    }
  }
}

function openStores(clientId) {
  const ownerId = clientId || 'anonymous';
  const out = {};
  for (const k of Object.keys(STORE_FILES)) {
    out[k] = (k === 'settings') ? STORES.settings : (ROOT_DATA[k][ownerId] || emptyFor(k));
  }
  return out;
}

// 统计某用户的数据量（用于 /api/progress 等聚合）
// 取某用户在某类数据下的原始对象（现在是普通对象/数组，无需解包）
function scopeRaw(stores, key) {
  return stores[key] || emptyFor(key);
}

const DOC_BY_ID = new Map(DOCS.map(d => [d.id, d]));
const DOC_BY_TITLE = new Map(DOCS.map(d => [d.title, d]));
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// 把知识点与「用户笔记 / 已学状态 / AI 补全内容」合并后返回给前端
// stores 必须是 openStores(clientId) 的结果，否则会读到别人的数据
function mergeDoc(d, stores) {
  if (!d) return null;
  const S = stores || openStores('anonymous');
  return {
    ...d,
    explain: d.explain || '',            // 扩写脚本写入的长文；没有则前端回退用 content
    faqs: d.faqs || [],
    levelN: d.levelN || d.level || '',
    // 面包屑优先用知识库预置的（含一级/二级分类 + 名称），
    // 没有才退回 group/section。直接覆盖会丢掉分类层级。
    breadcrumb: (d.breadcrumb && d.breadcrumb.length)
      ? d.breadcrumb
      : [d.categoryL1 || d.group, d.categoryL2 || d.section, d.name || d.title].filter(Boolean),
    sources: d.sources || (d.sourceBook ? [d.sourceBook] : []),
    note: (S.notes[d.id] || {}).text || '',
    learned: !!S.learned[d.id],
    enrich: S.enrich[d.id] || [],
  };
}

// ---------------------------------------------------------------------------
// 2.6 联网搜索（可插拔；默认博查 BochaAI）
// ---------------------------------------------------------------------------
async function webSearch(query, count = 5) {
  const st = STORES.settings;
  if (!st.searchKey) throw new Error('还没有配置搜索 API Key（在工作台右上角「设置」里填）');

  if (st.searchProvider === 'bocha') {
    const r = await fetch('https://api.bochaai.com/v1/web-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${st.searchKey}` },
      body: JSON.stringify({ query, freshness: 'noLimit', summary: true, count }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error(`博查返回 ${r.status}：${t.slice(0, 200)}`);
    }
    const j = await r.json();
    const list = j.data?.webPages?.value || j.webPages?.value || j.data?.value || [];
    return list.map(x => ({
      title: x.name || x.title || '',
      url: x.url || '',
      site: x.siteName || x.site || '',
      date: x.datePublished || x.dateLastCrawled || '',
      snippet: x.summary || x.snippet || '',
    })).filter(x => x.title || x.snippet);
  }

  throw new Error(`未知的搜索服务商：${st.searchProvider}`);
}

// ---------------------------------------------------------------------------
// 2.6b 「要不要联网」的自动判断
// ---------------------------------------------------------------------------
// 目标：让它像豆包那样自己决定，而不是让用户每次勾一个复选框。
// 判断分三层，从便宜到贵：
//   ① 模式：never 直接不搜；always 直接搜
//   ② 本地知识库够不够：检索归一化得分低于 AUTO_WEB_MIN_SCORE → 本地答不好，去搜
//   ③ 问题是不是"时效性"的：涉及价格/版本/最新/政策这类，本地静态知识必然过时 → 去搜
const AUTO_WEB_MIN_SCORE = Number(process.env.AUTO_WEB_MIN_SCORE || 0.34);

// 命中这些词，说明答案会随时间变化，本地知识库给不了准确答案
const TIMELY_RE = /最新|最近|现在|目前|如今|今年|去年|明年|上一个?月|20\d\d|价格|定价|售价|收费|多少钱|费用|免费额度|额度|涨价|降价|调价|新版|更新|升级|迭代|发布|上线|下线|官网|官方文档|文档地址|是否支持|支不支持|支持.{0,8}吗|不支持|还能用|能不能|可以用吗|能用吗|取消|政策|规定|法规|趋势|现状|流行|主流|推荐哪个|哪个好|怎么选|对比|区别|vs|变化/i;

function looksTimely(text) {
  return TIMELY_RE.test(String(text || ''));
}

/**
 * 决定这次要不要联网。
 * @param {object} o
 * @param {string} o.mode   auto | always | never（请求级覆盖，缺省读全局设置）
 * @param {string} o.question 用户的问题 / 笔记内容
 * @param {object} [o.retrieval] 本地检索结果 { topScore, hits, lowConfidence }
 * @returns {{need:boolean, reason:string, source:string}}
 */
function decideWeb({ mode, question, retrieval }) {
  const st = STORES.settings;
  const m = (mode === 'always' || mode === 'never' || mode === 'auto') ? mode
          : (st.webMode || 'auto');

  if (m === 'never') return { need: false, reason: '你设置了不联网', source: 'mode' };
  if (!st.searchKey) return { need: false, reason: '还没配置搜索 Key，先用本地知识库回答', source: 'nokey' };
  if (m === 'always') return { need: true, reason: '你设置了每次都联网', source: 'mode' };

  // ---- auto 模式下的判断 ----
  if (looksTimely(question)) {
    return { need: true, reason: '问题涉及时效性信息（价格/版本/最新动态），本地知识库会过时', source: 'timely' };
  }
  if (!retrieval || !retrieval.hits || !retrieval.hits.length) {
    return { need: true, reason: '本地知识库没有相关内容', source: 'empty' };
  }
  if (Number(retrieval.topScore) < AUTO_WEB_MIN_SCORE) {
    return {
      need: true,
      reason: `本地匹配度偏低（${Number(retrieval.topScore).toFixed(2)} < ${AUTO_WEB_MIN_SCORE}），去网上补一补`,
      source: 'lowscore',
    };
  }
  return {
    need: false,
    reason: `本地知识库已经能答（匹配度 ${Number(retrieval.topScore).toFixed(2)}）`,
    source: 'local',
  };
}

/**
 * 把请求里的「联网意图」翻译成模式。
 * 新前端传 webMode；老前端传布尔量 useWeb（true=强制联网），两者都兼容。
 * 都不传 → undefined，跟随全局设置。
 */
function webModeOverride(b) {
  if (b.webMode === 'auto' || b.webMode === 'always' || b.webMode === 'never') return b.webMode;
  if (b.useWeb === true) return 'always';
  if (b.useWeb === false) return undefined;
  return undefined;
}

// ---------------------------------------------------------------------------
// 2.7 与 DeepSeek 交互的两个通用封装
// ---------------------------------------------------------------------------
// 非流式：用于出题、笔记补全这类「要结构化结果」的场景
async function chatJSON(messages, maxTokens = 2000, temperature = 0.6) {
  const { key } = resolveKey();
  if (!key) throw new Error('未找到 DEEPSEEK_API_KEY');
  const r = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: MODEL, messages, max_tokens: maxTokens, temperature,
      response_format: { type: 'json_object' },
    }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`DeepSeek 返回 ${r.status}：${t.slice(0, 200)}`);
  }
  const j = await r.json();
  const raw = j.choices?.[0]?.message?.content || '';
  let s = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  return { json: JSON.parse(s), usage: j.usage || {} };
}

// 流式：把上游 SSE 转发给浏览器，返回完整回答文本
async function sseChat(res, messages, sse, opts = {}) {
  const { key, from } = resolveKey();
  if (!key) {
    sse('error', {
      message: '未找到 DEEPSEEK_API_KEY。\n' +
        '两种设置方式（任选其一）：\n' +
        '  1) 启动时设置环境变量：  $env:DEEPSEEK_API_KEY="sk-..." ; node server.js\n' +
        '  2) 写入 ~/.dsh/.credentials.yaml，加一行：\n     DEEPSEEK_API_KEY: sk-...\n' +
        '注意：知识目录、笔记、检索都不需要 Key，仍然可用。',
    });
    res.end();
    return null;
  }

  let upstream;
  try {
    upstream = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: MODEL, messages, stream: true, temperature: opts.temperature ?? 0.5 }),
    });
  } catch (e) {
    sse('error', {
      message: `调用 DeepSeek 失败（网络层）：${e.message}\n\n目标地址：${BASE}/chat/completions\n` +
        '排查：确认能访问外网；若需代理，设置 $env:HTTPS_PROXY="http://..."',
    });
    res.end();
    return null;
  }

  if (!upstream.ok) {
    const t = await upstream.text().catch(() => '');
    sse('error', {
      message: `DeepSeek 返回 ${upstream.status} ${upstream.statusText}\n${t.slice(0, 500)}\n\n` +
        (upstream.status === 401 ? '提示：API Key 无效或已过期。' :
         upstream.status === 402 ? '提示：账户余额不足。' :
         upstream.status === 429 ? '提示：请求过于频繁，稍后重试。' : ''),
    });
    res.end();
    return null;
  }

  const reader = upstream.body.getReader();
  const dec = new TextDecoder('utf-8');
  let buf = '', full = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const data = s.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          const delta = j.choices?.[0]?.delta?.content;
          if (delta) { full += delta; sse('delta', { text: delta }); }
        } catch { /* 半包，忽略 */ }
      }
    }
  } catch (e) {
    sse('error', { message: '读取流式响应中断：' + e.message });
  }
  if (opts.log) console.log(`[对话] Key来源: ${from} · ${opts.log} · 回答 ${full.length} 字`);
  return full;
}

// 让 AI 答疑也能用上「用户自己攒的笔记补全内容和新知识」
// stores 按用户隔离传入，避免把别人的笔记当成"我的补充知识"喂给模型
function searchExtraKnowledge(query, stores, limit = 2) {
  const S = stores || openStores('anonymous');
  const qTerms = termsOf(query);
  if (!qTerms.length) return [];
  const sc = [];
  for (const [docId, arr] of Object.entries(scopeRaw(S, 'enrich'))) {
    for (const e of (arr || [])) {
      let s = 0;
      for (const t of qTerms) if ((e.text || '').includes(t)) s += t.length >= 2 ? 2 : 1;
      if (s > 0) sc.push({ s, text: `【我的笔记补全 · ${DOC_BY_ID.get(docId)?.title || docId}】\n${e.text}` });
    }
  }
  for (const n of scopeRaw(S, 'newknowledge')) {
    let s = 0;
    for (const t of qTerms) if ((n.title + n.content).includes(t)) s += t.length >= 2 ? 2 : 1;
    if (s > 0) sc.push({ s, text: `【我的新知识 · ${n.title}】\n${n.content}` });
  }
  sc.sort((a, b) => b.s - a.s);
  return sc.slice(0, limit).map(x => x.text);
}

// ---------------------------------------------------------------------------
// 混合检索参数（经 20 条标注用例寻优，见 README「检索质量」）
// ---------------------------------------------------------------------------
const W_EMBED = 0.85;        // 语义向量权重
const W_KEYWORD = 0.15;      // 关键词权重（tanh 压缩后）
const TITLE_BONUS = 0.15;    // 查询词精确出现在标题里的加成
const OOD_THRESHOLD = 0.30;  // 低于此最高分视为"知识库未覆盖"（超纲问题实测最高约 0.30-0.40）

const cos = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

// 查询向量：需要模型。服务端不加载模型，因此这里用"关键词倒排 + 预存向量"的
// 折中——语义部分靠预存片段向量，查询侧用轻量方式近似。
// 为了让服务端保持零模型依赖，这里采用「查询关键词 → 片段向量加权平均」的
// 伪查询向量方案，效果弱于真实查询编码，因此 build_embeddings.js 额外存了
// 一份"查询示例向量"来校准。若需要最佳效果，启用 ENABLE_QUERY_MODEL=1。
const ENABLE_QUERY_MODEL = process.env.ENABLE_QUERY_MODEL === '1';
let queryExtractor = null;

async function getQueryExtractor() {
  if (queryExtractor) return queryExtractor;
  const { pipeline, env } = require('@xenova/transformers');
  env.cacheDir = path.join(ROOT, 'models');
  env.allowRemoteModels = false;   // 查询侧也强制离线，只用已缓存权重
  env.allowLocalModels = true;
  queryExtractor = await pipeline('feature-extraction', EMB.model, { quantized: true });
  return queryExtractor;
}

// 由关键词命中的片段向量做加权平均，近似出查询向量
function pseudoQueryVector(qTerms) {
  const kw = keywordScores(qTerms);
  if (!kw.size) return null;
  const acc = new Float32Array(EMB_DIM);
  let total = 0;
  for (const [i, w] of kw) {
    if (w <= 0) continue;
    const v = EMB_VECS[i];
    total += w;
    for (let j = 0; j < EMB_DIM; j++) acc[j] += v[j] * w;
  }
  if (!total) return null;
  // 归一化
  let n = 0;
  for (let j = 0; j < EMB_DIM; j++) { acc[j] /= total; n += acc[j] * acc[j]; }
  n = Math.sqrt(n) || 1;
  for (let j = 0; j < EMB_DIM; j++) acc[j] /= n;
  return acc;
}

async function retrieve(query, topK = TOP_K) {
  const qTerms = termsOf(query);
  const kw = keywordScores(qTerms);
  const N = DOCS.length;

  // --- 语义分 ---
  let sims = null;
  if (EMB && EMB_VECS) {
    let qv = null;
    if (ENABLE_QUERY_MODEL) {
      try {
        const ex = await getQueryExtractor();
        const out = await ex((EMB.queryPrefix || '') + query, { pooling: EMB.pooling || 'cls', normalize: true });
        qv = Float32Array.from(out.data);
      } catch (e) {
        console.log('[向量] 查询编码失败，回退到关键词近似：' + e.message);
      }
    }
    if (!qv) qv = pseudoQueryVector(qTerms);
    if (qv) sims = EMB_VECS.map(v => cos(qv, v));
  }

  // --- 混合打分 ---
  const scored = [];
  for (let i = 0; i < N; i++) {
    let s = 0;
    if (sims) s += sims[i] * W_EMBED;
    s += (kw.get(i) || 0) * W_KEYWORD;
    // 查询词（≥2字）精确出现在标题里 → 强证据
    if (qTerms.some(t => t.length >= 2 && DOCS[i].title.toLowerCase().includes(t))) s += TITLE_BONUS;
    scored.push({ i, s, sim: sims ? sims[i] : 0, kw: kw.get(i) || 0 });
  }
  scored.sort((a, b) => {
    if (b.s !== a.s) return b.s - a.s;
    const at = (DOCS[a.i].title || '').trim().toLowerCase();
    const bt = (DOCS[b.i].title || '').trim().toLowerCase();
    const aE = qTerms.some(t => at === t) ? 1 : 0;
    const bE = qTerms.some(t => bt === t) ? 1 : 0;
    if (bE !== aE) return bE - aE;
    return a.i - b.i;
  });

  const top = scored.slice(0, topK);
  const picked = new Set(top.map(r => r.i));

  // 关联扩展：把命中片段的 related 概念也带上（最多 2 条）
  const related = [];
  for (const r of top) {
    for (const rel of DOCS[r.i].related || []) {
      const j = DOCS.findIndex(d => d.title === rel);
      if (j >= 0 && !picked.has(j)) {
        picked.add(j); related.push({ i: j, s: 0, sim: 0, kw: 0, viaRelated: DOCS[r.i].title });
        if (related.length >= 2) break;
      }
    }
    if (related.length >= 2) break;
  }

  let hits = top;
  // 命中太少时回填，保证上下文有内容
  if (hits.length < topK) {
    const fill = [];
    for (let i = 0; i < N && hits.length + fill.length < topK; i++) {
      if (!picked.has(i)) { picked.add(i); fill.push({ i, s: 0, sim: 0, kw: 0 }); }
    }
    hits = [...hits, ...fill];
  }

  const topScore = top.length ? top[0].s : 0;
  return {
    lowConfidence: topScore < OOD_THRESHOLD,   // 供上层提示"知识库可能未覆盖"
    topScore: +topScore.toFixed(4),
    hits: [...hits, ...related].map(r => ({
      id: DOCS[r.i].id,
      book: DOCS[r.i].book,
      section: DOCS[r.i].section,
      title: DOCS[r.i].title,
      mark: DOCS[r.i].mark || '',
      level: DOCS[r.i].level || '',
      related: DOCS[r.i].related || [],
      score: +r.s.toFixed(4),
      sim: +r.sim.toFixed(4),
      kw: +r.kw.toFixed(4),
      viaRelated: r.viaRelated || null,
      content: DOCS[r.i].content,
    })),
  };
}

// ---------------------------------------------------------------------------
// 3. DeepSeek API Key
// ---------------------------------------------------------------------------
function readKeyFromCredentials() {
  try {
    const p = path.join(os.homedir(), '.dsh', '.credentials.yaml');
    if (!fs.existsSync(p)) return null;
    const txt = fs.readFileSync(p, 'utf8');
    const m = txt.match(/^\s*DEEPSEEK_API_KEY\s*:\s*(\S+)\s*$/m);
    return m ? m[1] : null;
  } catch { return null; }
}

function resolveKey() {
  if (process.env.DEEPSEEK_API_KEY) return { key: process.env.DEEPSEEK_API_KEY, from: '环境变量 DEEPSEEK_API_KEY' };
  const k = readKeyFromCredentials();
  if (k) return { key: k, from: '~/.dsh/.credentials.yaml' };
  return { key: null, from: null };
}

// ---------------------------------------------------------------------------
// 4. 系统提示词
// ---------------------------------------------------------------------------
function loadSystemPrompt() {
  // 优先用精简版（1692 字符，更稳），找不到则内嵌兜底
  const cands = [
    path.join(ROOT, 'prompt.md'),
    path.join(ROOT, '..', '09_系统提示词_精简版.md'),
    path.join(ROOT, '..', '02_系统提示词.md'),
  ];
  for (const p of cands) {
    if (!fs.existsSync(p)) continue;
    const txt = fs.readFileSync(p, 'utf8');
    // 抽出 ``` 包裹的提示词正文
    const m = txt.match(/```\s*\n([\s\S]*?)\n```/);
    if (m && m[1].trim().length > 400) return m[1].trim();
  }
  return FALLBACK_PROMPT;
}

const FALLBACK_PROMPT = `你是"AIPM学习工作台"助手，定位是零基础友好的AIPM学习陪练与知识顾问。
服务对象：零基础转行AI产品经理的人——无技术背景、缺产品全流程经验、对智能体原理认知模糊。
他们常刚下班、有点焦虑、不知从何下手。所以回答要让他们知道下一步做什么。
核心使命：1 讲清AI产品从0到1的完整运行逻辑 2 讲透智能体搭建的底层逻辑。
回答要求：
1 通俗易懂，不用技术黑话，术语首次出现必须用生活化的话解释。
2 固定五段结构：①一句话结论(≤30字) ②打个比方 ③步骤/清单/表格 ④今天就能做的一件事 ⑤一个追问。
3 一次只讲一件事，大问题拆开先讲第一步。
4 只依据"参考资料"回答；资料里没有的，明确说"这块我资料里没有覆盖"，
  可以基于通用经验给思路，但要说明这是你的补充。绝不编造。
5 智能体搭建统一用六步法：1定场景 2选模型 3写提示词 4配知识库 5接工具并编排工作流 6测试调优并发布。
6 涉及平台具体功能、价格、额度时不要凭记忆回答，让用户去后台核实。`;

const SYSTEM_PROMPT = loadSystemPrompt();
console.log(`[提示词] 已加载，${SYSTEM_PROMPT.length} 字符`);

// ---------------------------------------------------------------------------
// 5. 组装上下文
// ---------------------------------------------------------------------------
function buildContext(hits) {
  let out = '';
  let used = 0;
  for (const h of hits) {
    const head = `【${h.book} · ${h.section}】${h.title}`;
    let body = h.content;
    const piece = `${head}\n${body}\n\n`;
    if (used + piece.length > MAX_CONTEXT_CHARS) {
      const room = MAX_CONTEXT_CHARS - used - head.length - 20;
      if (room < 80) break;
      body = body.slice(0, room) + '…';
    }
    out += `${head}\n${body}\n\n`;
    used += out.length;
  }
  return out.trim();
}

function buildUserMessage(question, hits, retrieval, extra) {
  const ctx = buildContext(hits);
  const extraBlock = (extra && extra.length)
    ? '\n\n【用户自己积累的补充知识（来自他自己的笔记补全，优先级高，可视为他的个人笔记）】\n' + extra.join('\n\n')
    : '';
  if (!ctx && !extraBlock) {
    return `用户问题：${question}\n\n（本次没有检索到相关参考资料，请如实说明资料未覆盖。）`;
  }
  // 检索置信度低时明确告知模型，让它走「拓展补充」路线而不是硬编或拒答
  const warn = retrieval && retrieval.lowConfidence
    ? `\n\n⚠️ 检索置信度提示：本次最高相关度仅 ${retrieval.topScore}（阈值 ${OOD_THRESHOLD}），` +
      '说明本地知识库**基本没有覆盖这个问题**。按「情况二」处理：' +
      '直接用你自己的专业知识给出完整回答，**开头标注「该内容为拓展补充」**，' +
      '不要因为本地资料没有就敷衍或拒答，也不要谎称知识库里有。'
    : '';
  return `参考资料（来自本地知识库，请优先依据它回答）：\n\n${ctx}${extraBlock}${warn}\n\n---\n用户问题：${question}`;
}

// ---------------------------------------------------------------------------
// 6. HTTP 服务
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => {
      n += c.length;
      if (n > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[\\/])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 未找到 ' + rel); }
    // 必须显式声明缓存策略：
    //   之前这里什么都不发，浏览器可能拿启发式缓存 —— 改版后出现「index.html 是新的、
    //   app.js 还是旧的」，报 "Unexpected token '<'" 那类莫名其妙的前端错误。
    //   这里对 HTML 要求每次回源校验，对静态资源也不允许直接用旧副本
    //   （本地单机/自托管场景，多一次 200 的开销可以忽略，换来的是永远不会看到半新半旧的页面）。
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache, must-revalidate',
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = u.pathname;

  // ---- 多用户数据隔离 ----
  // 从 Cookie 取（或下发）客户端 id，然后把 STORES 指向该用户的数据。
  // enterUserScope 是同步的，Node 单线程下不会与其他请求交错，
  // 请求结束时在 res 的 finish/close 里还原并落盘。
  const cid = getClientId(req, res);
  const __savedScope = enterUserScope(cid);
  let __scopeRestored = false;
  const __restore = () => { if (!__scopeRestored) { __scopeRestored = true; exitUserScope(__savedScope); } };
  res.on('finish', __restore);
  res.on('close', __restore);
  const S = openStores(cid);

  // --- 健康检查（不调 API） ---
  if (p === '/api/health') {
    const { from } = resolveKey();
    return sendJSON(res, 200, {
      ok: true, docs: DOCS.length, terms: IDX.termCount,
      stats: KB.stats, model: MODEL, base: BASE,
      keySource: from || '未找到',
      hasKey: !!resolveKey().key,
      builtAt: KB.generatedAt,
      // 检索相关
      retrieval: {
        mode: EMB ? 'hybrid' : 'keyword-only',
        embeddingModel: EMB ? EMB.model : null,
        embeddingDim: EMB ? EMB_DIM : 0,
        embeddingCount: EMB ? EMB.ids.length : 0,
        embeddingsBuiltAt: EMB ? EMB.generatedAt : null,
        weights: { embed: W_EMBED, keyword: W_KEYWORD, titleBonus: TITLE_BONUS },
        oodThreshold: OOD_THRESHOLD,
        queryEncoding: ENABLE_QUERY_MODEL ? 'real-model' : 'keyword-approx',
      },
      // 内容建设情况
      content: {
        expandedDocs: DOCS.filter(d => d.explain).length,
        withFaqs: DOCS.filter(d => (d.faqs || []).length).length,
      },
      // 用户数据
      userData: {
        notes: Object.keys(S.notes).length,
        learned: Object.keys(S.learned).length,
        enrichEntries: Object.values(S.enrich).reduce((a, b) => a + b.length, 0),
        newKnowledge: S.newknowledge.length,
        wrong: S.wrong.length,
        quizSets: Object.keys(S.quiz).length,
      },
      // 联网搜索
      search: {
        provider: STORES.settings.searchProvider,
        hasKey: !!STORES.settings.searchKey,
        webMode: STORES.settings.webMode || 'auto',
        useWebDefault: !!STORES.settings.useWebDefault,
      },
    });
  }

  // --- 知识目录（不调 API） ---
  if (p === '/api/catalog') return sendJSON(res, 200, { catalog: KB.catalog, stats: KB.stats });

  // --- 三级知识树：一级分类 → 二级分类 → 知识点（带已学状态，供左侧树渲染） ---
  // 说明：字段名沿用 group/section（前端已按此渲染），它们对应需求里的
  //       「一级分类 / 二级分类」。概念类取知识树的分类，书目类取书名/章节。
  if (p === '/api/tree') {
    // ⚠️ 这里曾有两个 bug，都已修：
    //   1) 局部变量 const S = G.sections.get(s) 遮蔽了请求级的用户数据视图 S，
    //      导致 S.learned[d.id] / S.notes[d.id] 实际在读「分节对象」——状态全错。
    //   2) G.count++ / S.count++ 累加到**跨请求共享**的对象上：同一接口调第二次
    //      计数翻倍，sections 数组无限增长，最后把请求彻底卡死。
    //   现在每次请求都从 DOCS 重新构建，不留任何跨请求可变状态。
    const groups = new Map();
    const secMapByGroup = new Map();

    for (const d of DOCS) {
      const gName = d.categoryL1 || d.group || '未分类';
      const sName = d.categoryL2 || d.section || '未分类';

      if (!groups.has(gName)) {
        groups.set(gName, { group: gName, category: gName, count: 0, learned: 0 });
        secMapByGroup.set(gName, new Map());
      }
      const G = groups.get(gName);
      const secMap = secMapByGroup.get(gName);
      if (!secMap.has(sName)) {
        secMap.set(sName, { section: sName, category: sName, count: 0, learned: 0, items: [] });
      }
      const sec = secMap.get(sName);

      // 用用户数据视图 S 判断状态，不要用分节对象
      const learned = !!S.learned[d.id];
      sec.items.push({
        id: d.id,
        title: d.title,
        name: d.name || d.title,
        mark: d.mark || '',
        level: d.levelN || d.level || '',
        learned,
        hasNote: !!(S.notes[d.id] && S.notes[d.id].text),
        enrichCount: (S.enrich[d.id] || []).length,
        expanded: !!d.explain,
      });
      sec.count++;
      if (learned) sec.learned++;
      G.count++;
      if (learned) G.learned++;
    }

    const tree = [...groups.values()].map(G => ({
      group: G.group, category: G.group, count: G.count, learned: G.learned,
      sections: [...secMapByGroup.get(G.group).values()],
    }));
    return sendJSON(res, 200, { tree, stats: KB.stats });
  }

  // --- 片段详情（不调 API；已合并笔记/已学/AI补全） ---
  if (p === '/api/doc') {
    const id = u.searchParams.get('id');
    const d = DOCS.find(x => x.id === id);
    if (!d) return sendJSON(res, 404, { error: '片段不存在' });
    // 必须把当前用户的 S 传进去，否则会退到 anonymous 桶，读不到自己的笔记/已学
    return sendJSON(res, 200, mergeDoc(d, S));
  }

  // --- 学习进度总览（不调 API） ---
  if (p === '/api/progress') {
    const learnedIds = Object.keys(S.learned);
    const noteCount = Object.values(S.notes).filter(n => n && n.text && n.text.trim()).length;
    const byMark = {};
    for (const d of DOCS) {
      const m = d.mark || '无';
      byMark[m] = byMark[m] || { total: 0, learned: 0 };
      byMark[m].total++;
      if (S.learned[d.id]) byMark[m].learned++;
    }
    return sendJSON(res, 200, {
      totalDocs: DOCS.length,
      learned: learnedIds.length,
      noted: noteCount,
      expanded: DOCS.filter(d => d.explain).length,
      newKnowledge: S.newknowledge.length,
      wrong: S.wrong.length,
      byMark,
    });
  }

  // --- 只检索、不调大模型（调试用，不消耗额度） ---
  if (p === '/api/search') {
    const q = u.searchParams.get('q') || '';
    const r = await retrieve(q);
    return sendJSON(res, 200, {
      query: q,
      mode: EMB ? 'hybrid(embedding+keyword)' : 'keyword-only',
      topScore: r.topScore,
      lowConfidence: r.lowConfidence,
      hits: r.hits.map(h => ({
        id: h.id, book: h.book, section: h.section, title: h.title,
        score: h.score, sim: h.sim, kw: h.kw, viaRelated: h.viaRelated,
      })),
      contextPreview: buildContext(r.hits).slice(0, 500),
    });
  }

  // --- 对话（唯一会调用 DeepSeek 的接口，每条消息调用一次） ---
  if (p === '/api/chat' && req.method === 'POST') {
    let payload;
    try { payload = JSON.parse(await readBody(req)); }
    catch (e) { return sendJSON(res, 400, { error: '请求体不是合法 JSON：' + e.message }); }

    const question = String(payload.question || '').trim();
    if (!question) return sendJSON(res, 400, { error: '问题不能为空' });

    const retrieval = await retrieve(question, TOP_K);
    const hits = retrieval.hits;

    // 先把召回的片段发给前端（不依赖大模型）
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const sse = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    sse('hits', hits.map(h => ({
      id: h.id, book: h.book, section: h.section, title: h.title,
      mark: h.mark, level: h.level, score: h.score, sim: h.sim, kw: h.kw,
      viaRelated: h.viaRelated,
    })));
    if (retrieval.lowConfidence) sse('lowConfidence', { topScore: retrieval.topScore });

    const { key, from } = resolveKey();
    if (!key) {
      sse('error', {
        message: '未找到 DEEPSEEK_API_KEY。\n' +
          '两种设置方式（任选其一）：\n' +
          '  1) 启动时设置环境变量：  $env:DEEPSEEK_API_KEY="sk-..." ; node server.js\n' +
          '  2) 写入 ~/.dsh/.credentials.yaml，加一行：\n     DEEPSEEK_API_KEY: sk-...\n' +
          '注意：检索功能仍可正常使用（左侧目录、/api/search 都不需要 Key）。',
      });
      return res.end();
    }
    console.log(`[对话] Key 来源: ${from} · 召回 ${hits.length} 段 · Q: ${question.slice(0, 40)}`);

    // 组装消息
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...(Array.isArray(payload.history) ? payload.history.slice(-6).map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: String(m.content || '').slice(0, 4000),
      })) : []),
      { role: 'user', content: buildUserMessage(question, hits, retrieval, searchExtraKnowledge(question, S)) },
    ];

    let upstream;
    try {
      upstream = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: MODEL, messages, stream: true, temperature: 0.5 }),
      });
    } catch (e) {
      console.error('[对话] 网络失败:', e.message);
      sse('error', {
        message: `调用 DeepSeek 失败（网络层）：${e.message}\n\n` +
          `目标地址：${BASE}/chat/completions\n` +
          '排查建议：\n  1) 确认能访问外网：Test-NetConnection api.deepseek.com -Port 443\n' +
          '  2) 若公司网络需代理，设置 $env:HTTPS_PROXY="http://..."\n' +
          '  3) 左侧知识目录和关键词检索不依赖网络，仍可正常使用。',
      });
      return res.end();
    }

    if (!upstream.ok) {
      const t = await upstream.text().catch(() => '');
      console.error('[对话] API 返回', upstream.status);
      sse('error', {
        message: `DeepSeek 返回 ${upstream.status} ${upstream.statusText}\n${t.slice(0, 500)}\n\n` +
          (upstream.status === 401 ? '提示：API Key 无效或已过期。' :
           upstream.status === 402 ? '提示：账户余额不足。' :
           upstream.status === 429 ? '提示：请求过于频繁，稍后重试。' : ''),
      });
      return res.end();
    }

    // 解析 SSE 流并转发
    const reader = upstream.body.getReader();
    const dec = new TextDecoder('utf-8');
    let buf = '';
    let full = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          const s = line.trim();
          if (!s.startsWith('data:')) continue;
          const data = s.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const j = JSON.parse(data);
            const delta = j.choices?.[0]?.delta?.content;
            if (delta) { full += delta; sse('delta', { text: delta }); }
          } catch { /* 忽略半包 */ }
        }
      }
    } catch (e) {
      sse('error', { message: '读取流式响应中断：' + e.message });
    }
    if (hits.length) sse('citations', hits.map(h => ({ id: h.id, title: h.title, book: h.book, section: h.section })));
    sse('done', { chars: full.length });
    res.end();
    return;
  }

  // =========================================================================
  // 以下为用户数据相关接口：笔记 / 已学 / AI答疑 / 笔记补全 / 新知识 / 刷题 / 错题 / 设置
  // =========================================================================
  function openSSE() {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    return (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  async function readJSONBody(req2) {
    try { return JSON.parse(await readBody(req2)); }
    catch (e) { return { __bad: e.message }; }
  }

  // --- 保存笔记 ---
  if (p === '/api/note' && req.method === 'POST') {
    const b = await readJSONBody(req);
    if (b.__bad) return sendJSON(res, 400, { error: '请求体不是合法 JSON：' + b.__bad });
    const d = DOC_BY_ID.get(b.id);
    if (!d) return sendJSON(res, 404, { error: '知识点不存在' });
    const text = String(b.text || '');
    if (text.trim()) {
      S.notes[b.id] = { text, updatedAt: new Date().toISOString() };
    } else {
      delete S.notes[b.id];
    }
    persistScope();
    return sendJSON(res, 200, { ok: true, savedAt: new Date().toISOString() });
  }

  // --- 标记已学 ---
  if (p === '/api/learned' && req.method === 'POST') {
    const b = await readJSONBody(req);
    if (b.__bad) return sendJSON(res, 400, { error: '请求体不是合法 JSON：' + b.__bad });
    if (!DOC_BY_ID.has(b.id)) return sendJSON(res, 404, { error: '知识点不存在' });
    const on = b.on !== false;
    if (on) S.learned[b.id] = { at: new Date().toISOString() };
    else delete S.learned[b.id];
    persistScope();
    return sendJSON(res, 200, { ok: true, learned: on });
  }

  // --- AI 答疑（针对某个知识点，可联网） ---
  if (p === '/api/ask' && req.method === 'POST') {
    const b = await readJSONBody(req);
    if (b.__bad) return sendJSON(res, 400, { error: '请求体不是合法 JSON：' + b.__bad });
    const question = String(b.question || '').trim();
    if (!question) return sendJSON(res, 400, { error: '问题不能为空' });
    const d = DOC_BY_ID.get(b.id);

    const sse = openSSE();

    // 先做本地检索，它的得分是"要不要联网"的判断依据之一
    const retrieval = await retrieve(question, 3);

    // 自动判断要不要联网（用户可在设置里改成「总是/从不」，或前端临时切换）
    const decision = decideWeb({ mode: webModeOverride(b), question, retrieval });
    sse('webdecide', decision);

    let web = [];
    if (decision.need) {
      sse('status', { text: '正在联网搜集…' });
      try {
        web = await webSearch(question, 4);
        sse('web', web);
      } catch (e) {
        sse('status', { text: '联网失败（已跳过，用本地知识库回答）：' + e.message });
      }
    }

    // 参考材料：当前知识点 + 知识库检索 + 历史笔记补全 + 联网结果
    const parts = [];
    if (d) parts.push(`【正在学的知识点：${d.title}】\n${d.explain || d.content || ''}`);
    parts.push(buildContext(retrieval.hits));
    const extra = searchExtraKnowledge(question, S);
    if (extra.length) parts.push(extra.join('\n\n'));
    if (web.length) {
      parts.push('【联网搜索结果（注意：来自网络，需与知识库区分，引用时给出标题和链接）】\n' +
        web.map((x, i) => `${i + 1}. ${x.title}${x.site ? '（' + x.site + '）' : ''}\n${(x.snippet || '').slice(0, 600)}\n链接：${x.url}`).join('\n\n'));
    }

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      // 多轮上下文：前端会把本知识点下已经问过的问答传回来，
      // 这样用户可以连续追问（"那它和XX有什么区别"）而不必重复背景。
      ...(Array.isArray(b.history) ? b.history.slice(-6).map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: String(m.content || '').slice(0, 4000),
      })) : []),
      {
        role: 'user',
        content: `参考资料如下：\n\n${parts.filter(Boolean).join('\n\n')}\n\n` +
          `---\n${d ? `我正在学「${d.title}」这个知识点，` : ''}我的问题是：${question}`,
      },
    ];
    await sseChat(res, messages, sse, { log: `答疑 ${d ? d.title : ''} Q: ${question.slice(0, 30)}` });
    sse('done', {});
    res.end();
    return;
  }

  // --- 笔记触发 AI 补全：把笔记扩成一条可以沉淀的知识 ---
  if (p === '/api/enrich' && req.method === 'POST') {
    const b = await readJSONBody(req);
    if (b.__bad) return sendJSON(res, 400, { error: '请求体不是合法 JSON：' + b.__bad });
    const d = DOC_BY_ID.get(b.id);
    if (!d) return sendJSON(res, 404, { error: '知识点不存在' });
    const note = String(b.note || (S.notes[b.id] || {}).text || '').trim();
    if (!note) return sendJSON(res, 400, { error: '这条知识点还没有笔记内容，先写点东西再让 AI 补全' });

    const sse = openSSE();
    sse('status', { text: '正在读取知识点与你的笔记…' });

    // 自动判断要不要联网：拿「知识点 + 笔记」去本地检索。
    // 笔记里冒出来的新名词，知识库多半没有，得分低就自动去网上补。
    let nsRetrieval = null;
    try { nsRetrieval = await retrieve(`${d.title} ${note}`.slice(0, 300), 3); } catch (e) {}
    const decision = decideWeb({ mode: webModeOverride(b), question: `${d.title} ${note}`, retrieval: nsRetrieval });
    sse('webdecide', decision);

    let web = [];
    if (decision.need) {
      sse('status', { text: '正在联网搜集…' });
      try {
        web = await webSearch(`${d.title} ${note.slice(0, 60)}`, 4);
        sse('web', web);
      } catch (e) {
        sse('status', { text: '联网失败（已跳过）：' + e.message });
      }
    }

    sse('status', { text: '正在生成补充知识…' });
    const sys = `你是 AI 产品经理方向的学习助理。用户在学习一个知识点时随手写了笔记，你要基于他的笔记，把它扩展成一条**可以长期沉淀的补充知识**，写进他的个人知识库。

要求：
1. 忠实于用户笔记的原意，帮他把话讲完整、讲清楚，不要跑题去讲别的。
2. 补上他笔记里省略掉的背景、原理、具体做法、易错点。
3. 讲人话，术语首次出现用类比解释。禁止出现 # 和 ** 这类排版符号，用自然段落。
4. 涉及平台功能、价格、额度时不要凭记忆写死，提示"以平台后台为准"。
5. 标题要短（12 字以内），能一眼看出这条讲的是什么。

只输出 JSON，不要 markdown 围栏。格式：
{"title":"补全后的知识点标题","summary":"一句话概括（40字内）","content":"补充知识正文，400-800字","tags":["标签1","标签2","标签3"]}`;

    const userMsg = `【所在知识点】${d.title}（${d.group || ''} > ${d.section || ''}）
${d.explain ? '【该知识点的概念解释】' + d.explain.slice(0, 1500) : d.content ? '【该知识点原注释】' + d.content : ''}

【我写的笔记】
${note}
${web.length ? `\n【联网搜集到的材料（可参考，引用时注明来源标题与链接）】\n${web.map((x, i) => `${i + 1}. ${x.title} — ${(x.snippet || '').slice(0, 500)}\n${x.url}`).join('\n')}` : ''}`;

    try {
      const { json } = await chatJSON([
        { role: 'system', content: sys },
        { role: 'user', content: userMsg },
      ], 2600, 0.5);

      const entry = {
        id: newId(),
        kind: web.length ? 'note-web' : 'note',
        text: String(json.content || '').trim(),
        summary: String(json.summary || '').trim(),
        refs: web.map(x => ({ title: x.title, url: x.url })),
        noteAt: (S.notes[b.id] || {}).updatedAt || null,
        at: new Date().toISOString(),
      };
      if (!entry.text) throw new Error('模型没有返回正文');

      // 1) 挂到该知识点下（后台更新）
      (S.enrich[b.id] = S.enrich[b.id] || []).push(entry);
      persistScope();

      // 2) 同时进入「新知识」（可独立检索）
      const nk = {
        id: entry.id,
        title: String(json.title || d.title).trim(),
        content: entry.text,
        summary: entry.summary,
        tags: Array.isArray(json.tags) ? json.tags.map(t => String(t)).slice(0, 5) : [],
        from: [{ id: d.id, title: d.title }],
        kind: entry.kind,
        refs: entry.refs,
        at: entry.at,
      };
      S.newknowledge.unshift(nk);
      persistScope();

      sse('done', { entry, newKnowledge: nk, web });
    } catch (e) {
      sse('error', { message: '生成失败：' + e.message });
    }
    res.end();
    return;
  }

  // --- 新知识：列表 / 手动新增 / 删除 ---
  if (p === '/api/newknowledge' && req.method === 'GET') {
    return sendJSON(res, 200, { items: S.newknowledge });
  }
  if (p === '/api/newknowledge' && req.method === 'POST') {
    const b = await readJSONBody(req);
    if (b.__bad) return sendJSON(res, 400, { error: '请求体不是合法 JSON：' + b.__bad });
    const title = String(b.title || '').trim();
    const content = String(b.content || '').trim();
    if (!title || !content) return sendJSON(res, 400, { error: '标题和内容都不能为空' });
    const nk = {
      id: newId(),
      title,
      content,
      summary: String(b.summary || '').trim(),
      tags: Array.isArray(b.tags) ? b.tags.slice(0, 5) : [],
      from: b.from || [],
      kind: 'manual',
      refs: [],
      at: new Date().toISOString(),
    };
    S.newknowledge.unshift(nk);
    persistScope();
    return sendJSON(res, 200, { ok: true, item: nk });
  }
  if (p === '/api/newknowledge' && req.method === 'DELETE') {
    const id = u.searchParams.get('id');
    const before = S.newknowledge.length;
    S.newknowledge = replaceStore('newknowledge', S.newknowledge.filter(x => x.id !== id), S.newknowledge);
    if (S.newknowledge.length === before) return sendJSON(res, 404, { error: '找不到这条新知识' });
    persistScope();
    // 同步移除挂在知识点下的补全条目
    let touched = false;
    for (const k of Object.keys(S.enrich)) {
      const arr = S.enrich[k] || [];
      const left = arr.filter(e => e.id !== id);
      if (left.length !== arr.length) { S.enrich[k] = left; touched = true; }
    }
    if (touched) persistScope();
    return sendJSON(res, 200, { ok: true });
  }

  // --- 刷题：取题 / 生成题 / 交卷 ---
  if (p === '/api/quiz' && req.method === 'GET') {
    const id = u.searchParams.get('id');
    const d = DOC_BY_ID.get(id);
    if (!d) return sendJSON(res, 404, { error: '知识点不存在' });
    return sendJSON(res, 200, { id, title: d.title, questions: S.quiz[id] || [] });
  }

  if (p === '/api/quiz/generate' && req.method === 'POST') {
    const b = await readJSONBody(req);
    if (b.__bad) return sendJSON(res, 400, { error: '请求体不是合法 JSON：' + b.__bad });
    const d = DOC_BY_ID.get(b.id);
    if (!d) return sendJSON(res, 404, { error: '知识点不存在' });
    const sys = `你是 AI 产品经理方向的出题老师，为零基础转行的学习者出单选题。

要求：
1. 出 3 道题，每题 4 个选项，只有 1 个正确答案。
2. 题干要考"理解"而不是"背名词"，多结合真实工作场景。
3. 错误选项要有迷惑性（常见的误解），不要一眼看出是错的。
4. 解析要讲清楚"为什么对、其他错在哪"，150-250 字，讲人话。
5. 不要出现 # 和 ** 排版符号。

只输出 JSON，不要 markdown 围栏：
{"questions":[{"q":"题干","options":["A选项","B选项","C选项","D选项"],"answer":0,"explain":"解析"}]}
其中 answer 是正确选项的下标（0-3）。`;
    try {
      const { json } = await chatJSON([
        { role: 'system', content: sys },
        { role: 'user', content: `知识点：${d.title}（${d.group || ''} > ${d.section || ''}）\n参考内容：\n${(d.explain || d.content || '').slice(0, 2500)}` },
      ], 2200, 0.7);
      const qs = (Array.isArray(json.questions) ? json.questions : [])
        .filter(x => x && x.q && Array.isArray(x.options) && x.options.length >= 2)
        .slice(0, 3)
        .map(x => ({
          q: String(x.q),
          options: x.options.map(o => String(o)),
          answer: Math.max(0, Math.min(x.options.length - 1, Number(x.answer) || 0)),
          explain: String(x.explain || ''),
        }));
      if (!qs.length) throw new Error('模型没返回有效题目');
      S.quiz[b.id] = qs;
      persistScope();
      return sendJSON(res, 200, { ok: true, questions: qs });
    } catch (e) {
      return sendJSON(res, 500, { error: '出题失败：' + e.message });
    }
  }

  if (p === '/api/quiz/submit' && req.method === 'POST') {
    const b = await readJSONBody(req);
    if (b.__bad) return sendJSON(res, 400, { error: '请求体不是合法 JSON：' + b.__bad });
    const d = DOC_BY_ID.get(b.id);
    const qs = S.quiz[b.id] || [];
    if (!qs.length) return sendJSON(res, 400, { error: '这个知识点还没有题目' });
    const answers = Array.isArray(b.answers) ? b.answers : [];
    const detail = qs.map((x, i) => {
      const a = answers.find(z => Number(z.qi) === i);
      const chosen = a ? Number(a.chosen) : -1;
      const correct = chosen === x.answer;
      return { qi: i, q: x.q, options: x.options, chosen, answer: x.answer, correct, explain: x.explain };
    });
    const score = detail.filter(x => x.correct).length;

    // 错题入错题本（同一题不重复堆叠）
    for (const it of detail) {
      if (it.correct) continue;
      if (S.wrong.some(w => w.docId === b.id && w.q === it.q)) continue;
      S.wrong.unshift({
        id: newId(),
        docId: b.id,
        docTitle: d ? d.title : b.id,
        q: it.q,
        options: it.options,
        chosen: it.chosen,
        answer: it.answer,
        explain: it.explain,
        at: new Date().toISOString(),
      });
    }
    persistScope();
    return sendJSON(res, 200, { ok: true, score, total: detail.length, detail });
  }

  // --- 错题本 ---
  if (p === '/api/wrong' && req.method === 'GET') {
    return sendJSON(res, 200, { items: S.wrong });
  }
  if (p === '/api/wrong' && req.method === 'DELETE') {
    const id = u.searchParams.get('id');
    if (id === 'all') { replaceStore('wrong', [], S.wrong); persistScope(); return sendJSON(res, 200, { ok: true }); }
    S.wrong = replaceStore('wrong', S.wrong.filter(x => x.id !== id), S.wrong);
    persistScope();
    return sendJSON(res, 200, { ok: true });
  }

  // --- 设置（搜索 API Key 等） ---
  if (p === '/api/settings' && req.method === 'GET') {
    const st = STORES.settings;
    return sendJSON(res, 200, {
      searchProvider: st.searchProvider,
      webMode: st.webMode || 'auto',
      autoEnrich: st.autoEnrich !== false,
      useWebDefault: !!st.useWebDefault,
      // 只暴露"有没有配置"，绝不回传甚至部分回传密钥本身。
      // 公网部署时任何访客都能打开设置面板，回传后 4 位也算泄露。
      hasSearchKey: !!st.searchKey,
      minScore: AUTO_WEB_MIN_SCORE,
      // 密钥是否受环境变量冻结（部署场景下由管理员统一下发，访客不可改）
      lockedByEnv: !!process.env.SEARCH_API_KEY,
    });
  }
  if (p === '/api/settings' && req.method === 'POST') {
    const b = await readJSONBody(req);
    if (b.__bad) return sendJSON(res, 400, { error: '请求体不是合法 JSON：' + b.__bad });
    if (typeof b.searchProvider === 'string' && b.searchProvider) STORES.settings.searchProvider = b.searchProvider;
    if (b.webMode === 'auto' || b.webMode === 'always' || b.webMode === 'never') {
      STORES.settings.webMode = b.webMode;
      // 兼容：老字段跟着新模式走，免得旧代码读到矛盾的值
      STORES.settings.useWebDefault = b.webMode === 'always';
    }
    if (typeof b.autoEnrich === 'boolean') STORES.settings.autoEnrich = b.autoEnrich;
    if (typeof b.useWebDefault === 'boolean') STORES.settings.useWebDefault = b.useWebDefault;
    // 搜索密钥：如果管理员用环境变量冻结了，访客改不了（避免公网访客把密钥换成自己的或清空）
    if (!process.env.SEARCH_API_KEY) {
      if (typeof b.searchKey === 'string' && b.searchKey.trim()) STORES.settings.searchKey = b.searchKey.trim();
      if (b.clearSearchKey === true) STORES.settings.searchKey = '';
    }
    saveStore('settings', STORES.settings);
    const st = STORES.settings;
    return sendJSON(res, 200, {
      ok: true,
      searchProvider: st.searchProvider,
      webMode: st.webMode || 'auto',
      autoEnrich: st.autoEnrich !== false,
      useWebDefault: !!st.useWebDefault,
      hasSearchKey: !!st.searchKey,
      minScore: AUTO_WEB_MIN_SCORE,
    });
  }

  // --- 联网搜索（测试用，不调大模型） ---
  if (p === '/api/websearch' && req.method === 'POST') {
    const b = await readJSONBody(req);
    if (b.__bad) return sendJSON(res, 400, { error: '请求体不是合法 JSON：' + b.__bad });
    const q = String(b.query || '').trim();
    if (!q) return sendJSON(res, 400, { error: 'query 不能为空' });
    try {
      const items = await webSearch(q, Number(b.count) || 5);
      return sendJSON(res, 200, { ok: true, query: q, count: items.length, items });
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }

  // =========================================================================
  // 以下为「仪表盘 / 打卡 / 目标 / 作品集 / API 实验」新增端点
  // 设计原则：全部基于真实数据计算，没有任何写死的示例值。
  // =========================================================================

  // --- 仪表盘聚合：把散落在各 store 的数据算成仪表盘需要的口径 ----
  if (p === '/api/stats') {
    const now = new Date();
    const todayKey = now.toISOString().slice(0, 10);

    const activity = Array.isArray(S.activity) ? S.activity : [];
    const learnedMap = S.learned || {};
    const notesMap = S.notes || {};
    const enrichMap = S.enrich || {};
    const quizMap = S.quiz || {};
    const wrongList = Array.isArray(S.wrong) ? S.wrong : [];
    const nkList = Array.isArray(S.newknowledge) ? S.newknowledge : [];
    const pfList = Array.isArray(S.portfolio) ? S.portfolio : [];
    const goal = (S.goals && typeof S.goals === 'object' && !Array.isArray(S.goals)) ? S.goals : {};

    // 时间轴：优先用活动流；为空时用各 store 自带的时间戳兜底拼出来
    const timeline = [];
    for (const e of activity) {
      if (e && typeof e.at === 'string') timeline.push({ at: e.at, kind: e.kind, docId: e.docId || '' });
    }
    if (!timeline.length) {
      for (const [docId, v] of Object.entries(learnedMap)) {
        if (v && typeof v.at === 'string') timeline.push({ at: v.at, kind: 'learn', docId });
      }
      for (const [docId, v] of Object.entries(notesMap)) {
        if (v && typeof v.updatedAt === 'string') timeline.push({ at: v.updatedAt, kind: 'note', docId });
      }
      for (const [docId, arr] of Object.entries(enrichMap)) {
        for (const it of (arr || [])) if (it && typeof it.at === 'string') timeline.push({ at: it.at, kind: 'enrich', docId });
      }
      for (const it of wrongList) if (it && typeof it.at === 'string') timeline.push({ at: it.at, kind: 'wrong', docId: it.docId || '' });
      for (const it of nkList) if (it && typeof it.at === 'string') timeline.push({ at: it.at, kind: 'newknowledge', docId: '' });
    }
    timeline.sort((a, b) => String(a.at).localeCompare(String(b.at)));

    const onDay = (day) => timeline.filter(x => String(x.at).slice(0, 10) === day);

    // 「学习时长」估算口径：每条活动记 6 分钟（读一个知识点/写一条笔记的典型耗时）。
    // 这个系数是可解释的估算，不是编造的数字——前端会标注它是估算值。
    const MIN_PER_EVENT = 6;
    const minutesOf = (list) => list.length * MIN_PER_EVENT;
    const todayEvents = onDay(todayKey);

    // 练习进度：以"已生成题目的知识点"为单位，统计其中答对率
    const quizDocIds = Object.keys(quizMap);
    let quizQuestions = 0, wrongCount = wrongList.length;
    for (const id of quizDocIds) quizQuestions += (quizMap[id] || []).length;

    // 成长计划：按 mark 分档折算整体进度
    const byMark = {};
    for (const d of DOCS) {
      const m = d.mark || '无';
      byMark[m] = byMark[m] || { total: 0, learned: 0 };
      byMark[m].total++;
      if (learnedMap[d.id]) byMark[m].learned++;
    }
    const learnedCount = Object.keys(learnedMap).length;

    // 连续打卡天数（从今天往回数）
    const days = new Set(timeline.map(x => String(x.at).slice(0, 10)));
    let streak = 0;
    for (let i = 0; i < 400; i++) {
      const dt = new Date(now.getTime() - i * 86400000).toISOString().slice(0, 10);
      if (days.has(dt)) streak++;
      else if (i > 0) break;
    }

    return sendJSON(res, 200, {
      ok: true,
      generatedAt: now.toISOString(),
      // 今日
      today: {
        date: todayKey,
        events: todayEvents.length,
        minutes: minutesOf(todayEvents),
        minutesIsEstimate: true,
        perEventMinutes: MIN_PER_EVENT,
        learned: todayEvents.filter(x => x.kind === 'learn').length,
        notes: todayEvents.filter(x => x.kind === 'note').length,
        quizzes: todayEvents.filter(x => x.kind === 'quiz' || x.kind === 'wrong').length,
        docs: todayEvents.filter(x => x.kind === 'learn' || x.kind === 'note').length,
      },
      // 累计
      totals: {
        docs: DOCS.length,
        learned: learnedCount,
        noted: Object.values(notesMap).filter(n => n && n.text && n.text.trim()).length,
        enrichEntries: Object.values(enrichMap).reduce((a, b) => a + (b || []).length, 0),
        wrong: wrongCount,
        newKnowledge: nkList.length,
        portfolio: pfList.length,
        quizDocs: quizDocIds.length,
        quizQuestions,
        activityEvents: timeline.length,
        activeDays: days.size,
        streak,
      },
      byMark,
      // 今日目标（用户可设，未设时给一个基于真实进度的默认值）
      goal: {
        text: goal.text || '',
        targetTasks: Number(goal.targetTasks) || 4,
        done: todayEvents.length,
        isCustom: !!goal.text,
      },
      // 成长计划：四阶段（与学习路径一致）
      plan: {
        stages: [
          { key: 'cognition', name: '认知启蒙', docs: byMark['⚪'] ? byMark['⚪'].total : 0, learned: byMark['⚪'] ? byMark['⚪'].learned : 0 },
          { key: 'product', name: '产品思维', docs: byMark['🟡'] ? byMark['🟡'].total : 0, learned: byMark['🟡'] ? byMark['🟡'].learned : 0 },
          { key: 'design', name: '设计实战', docs: byMark['🔴'] ? byMark['🔴'].total : 0, learned: byMark['🔴'] ? byMark['🔴'].learned : 0 },
          { key: 'tech', name: '技术拓展', docs: byMark['无'] ? byMark['无'].total : 0, learned: byMark['无'] ? byMark['无'].learned : 0 },
        ],
        overall: DOCS.length ? Math.round(learnedCount / DOCS.length * 100) : 0,
      },
      // 近 14 天活动量，供日历与趋势图用
      recent: (() => {
        const out = [];
        for (let i = 13; i >= 0; i--) {
          const dt = new Date(now.getTime() - i * 86400000).toISOString().slice(0, 10);
          const list = onDay(dt);
          out.push({ date: dt, events: list.length, minutes: minutesOf(list) });
        }
        return out;
      })(),
    });
  }

  // --- 打卡记录：按天聚合，供日历页与仪表盘日历卡使用 ---
  if (p === '/api/checkins') {
    const days = Number(u.searchParams.get('days')) || 120;
    const activity = Array.isArray(S.activity) ? S.activity : [];
    const byDay = {};
    const push = (at, kind, docId) => {
      const k = String(at).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) return;
      byDay[k] = byDay[k] || { date: k, events: 0, kinds: {}, docIds: [] };
      byDay[k].events++;
      byDay[k].kinds[kind] = (byDay[k].kinds[kind] || 0) + 1;
      if (docId && byDay[k].docIds.length < 12 && !byDay[k].docIds.includes(docId)) byDay[k].docIds.push(docId);
    };
    if (activity.length) {
      for (const e of activity) push(e.at, e.kind, e.docId);
    } else {
      // 兜底：从各 store 自带时间戳聚合
      for (const [docId, v] of Object.entries(S.learned || {})) if (v && v.at) push(v.at, 'learn', docId);
      for (const [docId, v] of Object.entries(S.notes || {})) if (v && v.updatedAt) push(v.updatedAt, 'note', docId);
      for (const it of (Array.isArray(S.wrong) ? S.wrong : [])) if (it && it.at) push(it.at, 'wrong', it.docId);
    }
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const list = Object.values(byDay)
      .filter(d => d.date >= cutoff)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(d => ({
        date: d.date,
        events: d.events,
        minutes: d.events * 6,
        kinds: d.kinds,
        titles: d.docIds.map(id => (DOC_BY_ID.get(id) || {}).title || id).slice(0, 6),
      }));
    return sendJSON(res, 200, { ok: true, days: list, total: list.length, activitySource: activity.length ? 'activity' : 'derived' });
  }

  // --- 今日目标：读取 / 保存 ---
  if (p === '/api/goals') {
    if (req.method === 'GET') {
      const goal = (S.goals && !Array.isArray(S.goals)) ? S.goals : {};
      return sendJSON(res, 200, {
        ok: true,
        text: goal.text || '',
        targetTasks: Number(goal.targetTasks) || 4,
        updatedAt: goal.updatedAt || null,
      });
    }
    if (req.method === 'POST') {
      const b = await readJSONBody(req);
      if (b.__bad) return sendJSON(res, 400, { error: '请求体不是合法 JSON：' + b.__bad });
      const text = String(b.text || '').slice(0, 200);
      const targetTasks = Math.min(20, Math.max(1, Number(b.targetTasks) || 4));
      replaceStore('goals', { text, targetTasks, updatedAt: new Date().toISOString() }, S.goals);
      persistScope();
      return sendJSON(res, 200, { ok: true, text, targetTasks });
    }
  }

  // --- 项目作品集：列表 / 新增 / 删除 ---
  if (p === '/api/portfolio') {
    if (req.method === 'GET') {
      return sendJSON(res, 200, { ok: true, items: Array.isArray(S.portfolio) ? S.portfolio : [] });
    }
    if (req.method === 'POST') {
      const b = await readJSONBody(req);
      if (b.__bad) return sendJSON(res, 400, { error: '请求体不是合法 JSON：' + b.__bad });
      const title = String(b.title || '').trim().slice(0, 80);
      if (!title) return sendJSON(res, 400, { error: '作品标题不能为空' });
      const d = b.docId ? DOC_BY_ID.get(b.docId) : null;
      const item = {
        id: newId(),
        title,
        type: String(b.type || 'practice').slice(0, 20),
        docId: d ? d.id : '',
        docTitle: d ? d.title : '',
        summary: String(b.summary || '').slice(0, 600),
        link: String(b.link || '').slice(0, 400),
        at: new Date().toISOString(),
      };
      if (!Array.isArray(S.portfolio)) replaceStore('portfolio', [], S.portfolio);
      S.portfolio = replaceStore('portfolio', [item].concat(S.portfolio), S.portfolio);
      persistScope();
      return sendJSON(res, 200, { ok: true, item });
    }
    if (req.method === 'DELETE') {
      const id = u.searchParams.get('id');
      if (!Array.isArray(S.portfolio)) replaceStore('portfolio', [], S.portfolio);
      if (id === 'all') { replaceStore('portfolio', [], S.portfolio); persistScope(); return sendJSON(res, 200, { ok: true }); }
      const before = S.portfolio.length;
      S.portfolio = replaceStore('portfolio', S.portfolio.filter(x => x.id !== id), S.portfolio);
      if (S.portfolio.length === before) return sendJSON(res, 404, { error: '找不到这条作品' });
      persistScope();
      return sendJSON(res, 200, { ok: true });
    }
  }

  // --- API 实验：在当前服务里真实发起一次 HTTP 请求，把结果原样返回 ----
  // 安全约束（重要）：
  //   · 只允许 http/https，且默认拒绝内网/环回地址（防 SSRF 探测内网）
  //   · 超时 15 秒，响应体截断到 60KB，避免被大响应拖垮
  //   · 不记录、不回显用户传入的密钥（仅用于本次请求的 Authorization 头）
  if (p === '/api/playground' && req.method === 'POST') {
    const b = await readJSONBody(req, 2 << 20);
    if (b.__bad) return sendJSON(res, 400, { error: '请求体不是合法 JSON：' + b.__bad });

    const url = String(b.url || '').trim();
    if (!/^https?:\/\//i.test(url)) return sendJSON(res, 400, { error: 'URL 必须以 http:// 或 https:// 开头' });

    // SSRF 防护：拒绝环回、私网、链路本地地址
    let target;
    try { target = new URL(url); } catch { return sendJSON(res, 400, { error: 'URL 格式不正确' }); }
    const host = target.hostname.toLowerCase();
    const isPrivate = /^(localhost|127\.|0\.0\.0\.0|::1|\[::1\])/.test(host)
      || /^10\./.test(host) || /^192\.168\./.test(host)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
      || /^169\.254\./.test(host)
      || host.endsWith('.internal') || host.endsWith('.local');
    if (isPrivate && !b.allowPrivate) {
      return sendJSON(res, 400, {
        error: '出于安全考虑，默认不允许请求内网 / 本机地址。确实需要请勾选"允许内网地址"。',
        code: 'PRIVATE_HOST_BLOCKED',
      });
    }

    // 组装请求头：用户自定义 + 可选的 Bearer
    const headers = {};
    if (b.headers && typeof b.headers === 'object') {
      for (const [k, v] of Object.entries(b.headers)) {
        if (!/^[A-Za-z0-9-]+$/.test(k)) continue;
        headers[k] = String(v).slice(0, 2000);
      }
    }
    if (b.apiKey) headers['Authorization'] = 'Bearer ' + String(b.apiKey).trim();

    const method = String(b.method || 'GET').toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      return sendJSON(res, 400, { error: '不支持的请求方法：' + method });
    }

    const started = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const init = { method, headers, signal: ctrl.signal };
      if (method !== 'GET' && method !== 'DELETE' && b.body) {
        init.body = typeof b.body === 'string' ? b.body : JSON.stringify(b.body);
        if (!headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/json';
        }
      }
      const r = await fetch(url, init);
      const raw = await r.text().catch(() => '');
      clearTimeout(timer);

      // 隐私：响应头里的 set-cookie / authorization 不回显
      const respHeaders = {};
      r.headers.forEach((v, k) => {
        if (/^(set-cookie|authorization|proxy-authorization)$/i.test(k)) return;
        respHeaders[k] = v;
      });

      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { /* 非 JSON，保留原文 */ }

      return sendJSON(res, 200, {
        ok: true,
        request: { method, url, headerKeys: Object.keys(headers) },
        status: r.status,
        statusText: r.statusText,
        headers: respHeaders,
        bodyText: raw.slice(0, 60000),
        bodyJson: parsed,
        truncated: raw.length > 60000,
        elapsedMs: Date.now() - started,
      });
    } catch (e) {
      clearTimeout(timer);
      const msg = e.name === 'AbortError' ? '请求超时（15 秒）' : e.message;
      return sendJSON(res, 200, {
        ok: false,
        request: { method, url },
        error: msg,
        elapsedMs: Date.now() - started,
        hint: /fetch failed|ENOTFOUND|ECONNREFUSED/i.test(e.message)
          ? '无法连接目标地址。常见原因：域名写错、目标服务不可达、或该地址需要代理。'
          : '',
      });
    }
  }

  // --- 静态文件 ---
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, p);
  res.writeHead(405); res.end('method not allowed');
});

// 绑定地址：本地开发用 127.0.0.1，容器/托管平台必须绑 0.0.0.0 才能被外部访问。
// Render / Railway / Fly 等平台会自动注入 PORT，并用外部探针访问容器端口；
// 绑到 127.0.0.1 会导致"部署成功但打不开"。
const HOST = process.env.HOST || (process.env.RENDER || process.env.PORT ? '0.0.0.0' : '127.0.0.1');

server.listen(PORT, HOST, () => {
  const { key, from } = resolveKey();
  const shown = HOST === '0.0.0.0' ? '0.0.0.0（公网/容器可达）' : '127.0.0.1（仅本机）';
  console.log('');
  console.log('  AIPM 学习工作台 已启动');
  console.log('  ─────────────────────────────────────────');
  console.log(`  监听：      ${shown} : ${PORT}`);
  console.log(`  本地访问：  http://127.0.0.1:${PORT}`);
  if (process.env.PUBLIC_URL) console.log(`  公网访问：  ${process.env.PUBLIC_URL}`);
  console.log(`  模型：      ${MODEL}  (${BASE})`);
  console.log(`  API Key：   ${key ? '已就绪（来源：' + from + '）' : '⚠️ 未找到 —— 对话会报错，但检索和目录可用'}`);
  console.log(`  知识片段：  ${DOCS.length} 个（概念 ${KB.stats.concept} / 智能体 ${KB.stats.agent} / 书目 ${KB.stats.book}）`);
  console.log(`  检索方式：  ${EMB ? `混合检索（向量 ${EMB_DIM}维 + 关键词）· 模型 ${EMB.model}` : '⚠️ 纯关键词（未找到向量文件，跑 build_embeddings.js 可启用语义检索）'}`);
  console.log(`  查询编码：  ${ENABLE_QUERY_MODEL ? '真实模型编码（启动已含模型）' : '关键词近似向量（服务端不含模型，启动快）'}`);
  console.log(`  多用户隔离：已启用（Cookie 维度，每个浏览器一份独立学习数据）`);
  if (!process.env.DEEPSEEK_API_KEY && from && /credentials\.yaml/.test(from)) {
    console.log('  ⚠️ 当前 Key 来自本机 ~/.dsh/.credentials.yaml —— 部署到托管平台必须设置环境变量 DEEPSEEK_API_KEY');
  }
  console.log('  ─────────────────────────────────────────');
  console.log('  不调 API 的调试接口：');
  console.log(`    http://127.0.0.1:${PORT}/api/health`);
  console.log(`    http://127.0.0.1:${PORT}/api/search?q=什么是RAG`);
  console.log('  停止：Ctrl + C');
  console.log('');
});

process.on('uncaughtException', e => console.error('[未捕获异常]', e));
