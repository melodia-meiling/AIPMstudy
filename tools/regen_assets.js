#!/usr/bin/env node
/**
 * regen_assets.js —— 为「对比版知识树」生成检索资产 + 预览数据目录
 * =====================================================================
 * 读取重建后的 kb.json.new，产出 data-new/ 目录，包含：
 *   kb.json          （= kb.json.new，改名为正式名，供预览服务加载）
 *   index.json       （关键词倒排索引，基于 doc.text 重建）
 *   embeddings.json  （本地 bge-base-zh 向量，基于 title+section+content 重建）
 *   + 复制现有 7 个用户数据文件（notes/learned/enrich/newknowledge/quiz/wrong/settings）
 *
 * 之后即可启动对比预览实例：
 *   DATA_DIR=data-new PORT=3001 node server.js
 * 与正式实例（3000）并排对比。
 *
 * 用法：
 *   node tools/regen_assets.js                       # 默认读 kb.json.new → 写 data-new
 *   node tools/regen_assets.js --in <kb路径> --outdir <目录>
 * =====================================================================
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const IN_KB = process.argv.includes('--in') ? process.argv[process.argv.indexOf('--in') + 1] : path.join(DATA_DIR, 'kb.json.new');
const OUT_DIR = process.argv.includes('--outdir') ? process.argv[process.argv.indexOf('--outdir') + 1] : path.join(DATA_DIR, 'data-new');

const MODEL_ID = process.env.EMBED_MODEL || 'Xenova/bge-base-zh-v1.5';
const QUERY_PREFIX = process.env.EMBED_QUERY_PREFIX || '为这个句子生成表示以用于检索相关文章：';
const POOLING = 'cls';
const DIM_EXPECT = 768;

// ---------- 关键词切分（与 build_kb.js 完全一致）----------
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
        if (/[\u4e00-\u9fa5]/.test(c2) && !STOP.has(c) && !STOP.has(c2)) out.add(c + c2);
      }
    } else if (/[a-z0-9]/.test(c)) {
      let j = i; while (j < s.length && /[a-z0-9+#.]/.test(s[j])) j++;
      out.add(s.slice(i, j)); i = j - 1;
    }
  }
  for (const w of String(text || '').toLowerCase().match(/[a-z][a-z0-9+#.]*/g) || []) out.add(w);
  return [...out];
}

(async () => {
  if (!fs.existsSync(IN_KB)) { console.error('❌ 找不到输入知识库:', IN_KB); process.exit(1); }
  const kb = JSON.parse(fs.readFileSync(IN_KB, 'utf8'));
  const docs = kb.docs;
  console.log(`输入：${IN_KB}（${docs.length} 个片段）`);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 1) 复制 kb（改名）
  fs.copyFileSync(IN_KB, path.join(OUT_DIR, 'kb.json'));

  // 2) 重建关键词倒排索引
  const postings = {}, docMap = {}, docTerms = [];
  docs.forEach((d, i) => {
    docMap[i] = d.id;
    const ts = termsOf(d.text || (d.title + ' ' + d.content));
    docTerms.push(ts);
    for (const t of ts) (postings[t] = postings[t] || []).push(i);
  });
  const idx = {
    generatedAt: new Date().toISOString(),
    docCount: docs.length,
    termCount: Object.keys(postings).length,
    docMap, postings, docTerms,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify(idx), 'utf8');
  console.log(`✅ index.json ｜ ${idx.termCount} 词词条`);

  // 3) 重建向量
  let transformers;
  try { transformers = require('@xenova/transformers'); }
  catch { console.error('❌ 缺少 @xenova/transformers'); process.exit(1); }
  const { pipeline, env } = transformers;
  env.cacheDir = path.join(ROOT, 'models');
  env.allowLocalModels = true; env.allowRemoteModels = true;
  env.remoteHost = process.env.HF_ENDPOINT || 'https://hf-mirror.com';

  console.log(`加载向量模型 ${MODEL_ID} …`);
  const t0 = Date.now();
  const extractor = await pipeline('feature-extraction', MODEL_ID, { quantized: true });
  console.log(`模型加载完成（${((Date.now() - t0) / 1000).toFixed(1)}s）`);

  const docText = d => `${d.title}。${d.section}。${d.content}`;
  const vectors = [];
  const t1 = Date.now();
  for (let i = 0; i < docs.length; i++) {
    const out = await extractor(docText(docs[i]), { pooling: POOLING, normalize: true });
    vectors.push(Float32Array.from(out.data));
    if ((i + 1) % 20 === 0 || i === docs.length - 1) process.stdout.write(`\r  编码 ${i + 1}/${docs.length}`);
  }
  console.log(`\n编码完成（${((Date.now() - t1) / 1000).toFixed(1)}s）`);

  const dim = vectors[0].length;
  let bad = 0;
  for (const v of vectors) { let z = true; for (let i = 0; i < v.length; i++) { if (!Number.isFinite(v[i])) { bad++; break; } if (v[i] !== 0) z = false; } if (z) bad++; }
  if (bad) console.log(`⚠️ ${bad} 条向量异常`);

  const SCALE = 32767;
  const flat = new Int16Array(vectors.length * dim);
  for (let i = 0; i < vectors.length; i++) for (let j = 0; j < dim; j++) {
    let v = vectors[i][j]; if (!Number.isFinite(v)) v = 0; if (v > 1) v = 1; if (v < -1) v = -1;
    flat[i * dim + j] = Math.round(v * SCALE);
  }
  const payload = {
    generatedAt: new Date().toISOString(), model: MODEL_ID, queryPrefix: QUERY_PREFIX,
    pooling: POOLING, dim, scale: SCALE, count: vectors.length,
    kbGeneratedAt: kb.generatedAt, ids: docs.map(d => d.id),
    data: Buffer.from(flat.buffer).toString('base64'),
  };
  fs.writeFileSync(path.join(OUT_DIR, 'embeddings.json'), JSON.stringify(payload), 'utf8');
  console.log(`✅ embeddings.json ｜ ${dim} 维 × ${vectors.length} 条`);

  // 4) 复制用户数据文件（预览用，避免缺文件报错）
  const USER_FILES = ['notes.json', 'learned.json', 'enrich.json', 'newknowledge.json', 'quiz.json', 'wrong.json', 'settings.json'];
  let cp = 0;
  for (const f of USER_FILES) {
    const src = path.join(DATA_DIR, f);
    if (fs.existsSync(src) && !fs.existsSync(path.join(OUT_DIR, f))) { fs.copyFileSync(src, path.join(OUT_DIR, f)); cp++; }
  }
  console.log(`✅ 复制用户数据文件 ${cp} 个`);
  console.log(`\n🎉 预览目录就绪：${OUT_DIR}`);
  console.log(`   启动预览：DATA_DIR=data-new PORT=3001 node server.js`);
})().catch(e => { console.error('❌ 失败:', e.message); process.exit(1); });
