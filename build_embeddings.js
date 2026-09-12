#!/usr/bin/env node
/**
 * build_embeddings.js —— 离线生成片段向量（一次性）
 * =====================================================================
 * 用 @xenova/transformers 在本地跑 bge-base-zh-v1.5 模型，把 kb.json 里
 * 每个片段编码成 768 维向量，存进 data/embeddings.json。
 *
 * 运行时机：只在「知识库内容变了」或「首次搭建」时跑一次。
 * 之后 server.js 直接读向量文件，**不加载模型、不联网**，启动快且完全离线。
 *
 * 模型来源：首次运行需联网下载权重（约 100MB+）。
 *   HuggingFace 官方站在国内不可达，默认走 hf-mirror.com 镜像。
 *   权重缓存在 mvp/models/，下载一次后可完全离线复用。
 *
 * 启动命令：
 *   cd mvp
 *   node build_embeddings.js
 * =====================================================================
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const KB_PATH = path.join(ROOT, 'data', 'kb.json');
const OUT_PATH = path.join(ROOT, 'data', 'embeddings.json');
const MODEL_DIR = path.join(ROOT, 'models');

// ---------------------------------------------------------------------------
// 检索参数（经 20 条标注用例寻优确定，详见 README「检索质量」一节）
// ---------------------------------------------------------------------------
const MODEL_ID = process.env.EMBED_MODEL || 'Xenova/bge-base-zh-v1.5';
// BGE 检索用法：query 加中文指令，passage 不加
const QUERY_PREFIX = process.env.EMBED_QUERY_PREFIX || '为这个句子生成表示以用于检索相关文章：';
const POOLING = 'cls';           // BGE 用 cls；实测 mean 效果更差
const DIM_EXPECT = 768;

let transformers;
try {
  transformers = require('@xenova/transformers');
} catch (e) {
  console.error('\n[缺少依赖] 没有找到 @xenova/transformers。');
  console.error('请先在 mvp 目录执行：');
  console.error('  npm install @xenova/transformers\n');
  process.exit(1);
}
const { pipeline, env } = transformers;

// 模型缓存放工作区内；官方站被墙，默认走镜像
env.cacheDir = MODEL_DIR;
env.allowLocalModels = true;
env.allowRemoteModels = true;
env.remoteHost = process.env.HF_ENDPOINT || 'https://hf-mirror.com';

if (!fs.existsSync(KB_PATH)) {
  console.error(`[致命] 找不到 ${KB_PATH}，请先运行 build_kb.js`);
  process.exit(1);
}
const kb = JSON.parse(fs.readFileSync(KB_PATH, 'utf8'));
const docs = kb.docs;

// 参与编码的文本：标题 + 章节 + 内容。标题放最前，让模型更聚焦主题。
function docText(d) {
  return `${d.title}。${d.section}。${d.content}`;
}

(async () => {
  console.log('='.repeat(66));
  console.log('  离线生成向量索引');
  console.log('='.repeat(66));
  console.log(`  模型：      ${MODEL_ID}`);
  console.log(`  镜像：      ${env.remoteHost}`);
  console.log(`  模型缓存：  ${MODEL_DIR}`);
  console.log(`  片段数：    ${docs.length}`);
  console.log(`  pooling：   ${POOLING}`);
  if (!fs.existsSync(path.join(MODEL_DIR, MODEL_ID.split('/')[0]))) {
    console.log('\n  首次运行需下载模型权重（约 100MB+），请耐心等待…');
  }
  console.log('');

  const t0 = Date.now();
  const extractor = await pipeline('feature-extraction', MODEL_ID, { quantized: true });
  console.log(`  模型加载完成（${((Date.now() - t0) / 1000).toFixed(1)}s）`);

  const t1 = Date.now();
  const vectors = [];
  for (let i = 0; i < docs.length; i++) {
    const out = await extractor(docText(docs[i]), { pooling: POOLING, normalize: true });
    // 存成 float32 数组；文件用定点整数压缩，体积约为原始 JSON 的 1/3
    vectors.push(Float32Array.from(out.data));
    if ((i + 1) % 20 === 0 || i === docs.length - 1) {
      process.stdout.write(`\r  编码进度 ${i + 1}/${docs.length}`);
    }
  }
  console.log(`\n  编码完成（${((Date.now() - t1) / 1000).toFixed(1)}s）`);

  const dim = vectors[0].length;
  if (dim !== DIM_EXPECT) {
    console.log(`  ⚠️ 维度为 ${dim}，与预期的 ${DIM_EXPECT} 不同（模型换了？）`);
  }

  // 校验：不应有 NaN / 全零
  let bad = 0;
  for (const v of vectors) {
    let allZero = true;
    for (let i = 0; i < v.length; i++) {
      if (Number.isNaN(v[i])) { bad++; break; }
      if (v[i] !== 0) allZero = false;
    }
    if (allZero) bad++;
  }
  if (bad) console.log(`  ⚠️ 有 ${bad} 条向量异常（NaN 或全零）`);

  // 量化存盘：float32 -> int16，加载时反量化。体积减半，精度损失可忽略。
  const SCALE = 32767;
  const flat = new Int16Array(vectors.length * dim);
  for (let i = 0; i < vectors.length; i++) {
    for (let j = 0; j < dim; j++) {
      let v = vectors[i][j];
      if (!Number.isFinite(v)) v = 0;
      if (v > 1) v = 1; if (v < -1) v = -1;
      flat[i * dim + j] = Math.round(v * SCALE);
    }
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    model: MODEL_ID,
    queryPrefix: QUERY_PREFIX,
    pooling: POOLING,
    dim,
    scale: SCALE,
    count: vectors.length,
    // 记录 kb.json 的指纹，内容变了就提醒重新编码
    kbGeneratedAt: kb.generatedAt,
    ids: docs.map(d => d.id),
    data: Buffer.from(flat.buffer).toString('base64'),
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(payload), 'utf8');
  const mb = (fs.statSync(OUT_PATH).size / 1048576).toFixed(1);
  console.log(`\n  ✅ 已写出 ${OUT_PATH}`);
  console.log(`     维度 ${dim} · ${vectors.length} 条 · ${mb} MB`);

  // 冒烟测试：确认向量能用来检索
  const cos = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
  console.log('\n  检索自检：');
  for (const q of ['什么是RAG', '智能体怎么搭建', '推荐几本书']) {
    const qv = Float32Array.from((await extractor(QUERY_PREFIX + q, { pooling: POOLING, normalize: true })).data);
    const top = vectors.map((v, i) => ({ i, s: cos(qv, v) })).sort((a, b) => b.s - a.s).slice(0, 3);
    console.log(`    Q: ${q}`);
    for (const { i, s } of top) console.log(`       ${s.toFixed(4)}  ${docs[i].title}  ← ${docs[i].book}`);
  }
  console.log('');
})().catch(e => {
  console.error('\n❌ 失败:', e.message);
  if (/fetch|ENOTFOUND|ECONN|timeout/i.test(e.message)) {
    console.error('\n可能是模型下载失败。排查：');
    console.error('  1) 确认镜像可达：node -e "fetch(\'https://hf-mirror.com\').then(r=>console.log(r.status))"');
    console.error('  2) 换镜像：$env:HF_ENDPOINT="https://hf-mirror.com"');
    console.error('  3) 若已下载过，可强制离线：$env:EMBED_OFFLINE="1"');
  }
  process.exit(1);
});
