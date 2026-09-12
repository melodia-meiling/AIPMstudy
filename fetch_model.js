#!/usr/bin/env node
/**
 * fetch_model.js —— 构建时按需下载向量模型权重
 * =====================================================================
 * 为什么需要这个脚本：
 *   模型权重约 98MB，超过 GitHub 单文件 100MB 的硬限制，
 *   所以 .gitignore 排除了 models/**\/*.onnx —— 仓库里没有权重文件。
 *   但托管平台是"从仓库构建镜像"，因此必须在构建阶段把权重下下来。
 *
 * 行为：
 *   · 权重已存在 → 直接跳过（本地开发时不会重复下载）
 *   · 缺失 → 从镜像站（默认 hf-mirror.com）下载
 *   · 失败 → **不中断构建**，打印警告后以 0 退出。
 *     这样镜像仍能构建成功，只是查询编码会退回关键词近似向量，
 *     不会让整个部署因为一个可选优化项而失败。
 *
 * 命令：node fetch_model.js
 * 环境变量：
 *   EMBED_MODEL   模型 id，默认 Xenova/bge-base-zh-v1.5
 *   HF_ENDPOINT   镜像地址，默认 https://hf-mirror.com
 * =====================================================================
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MODEL = process.env.EMBED_MODEL || 'Xenova/bge-base-zh-v1.5';
const HOST = (process.env.HF_ENDPOINT || 'https://hf-mirror.com').replace(/\/+$/, '');
const ROOT = __dirname;
const DIR = path.join(ROOT, 'models', MODEL);

// 这三件套就够跑 feature-extraction（quantized 版本）
const FILES = [
  ['config.json', 'config.json'],
  ['tokenizer.json', 'tokenizer.json'],
  ['tokenizer_config.json', 'tokenizer_config.json'],
  ['onnx/model_quantized.onnx', 'onnx/model_quantized.onnx'],
];

function human(n) {
  return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB';
}

(async () => {
  console.log('=== 检查向量模型权重 ===');
  console.log('  模型：  ' + MODEL);
  console.log('  目录：  ' + path.relative(ROOT, DIR));
  console.log('  镜像：  ' + HOST);

  // 已存在就跳过（判断最大的那个 onnx 文件）
  const onnxPath = path.join(DIR, 'onnx', 'model_quantized.onnx');
  if (fs.existsSync(onnxPath) && fs.statSync(onnxPath).size > 1024 * 1024) {
    console.log(`  ✅ 权重已存在（${human(fs.statSync(onnxPath).size)}），跳过下载`);
    process.exit(0);
  }

  console.log('  权重缺失，开始下载…\n');
  let ok = 0, failed = [];

  for (const [remote, local] of FILES) {
    const url = `${HOST}/${MODEL}/resolve/main/${remote}`;
    const dest = path.join(DIR, local);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      const t0 = Date.now();
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      // 防止把 HTML 错误页当成模型存下来
      if (buf.length < 100) throw new Error('返回内容过小，疑似错误页');
      fs.writeFileSync(dest, buf);
      ok++;
      console.log(`  ✅ ${local}  ${human(buf.length)}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    } catch (e) {
      failed.push(`${remote}: ${e.message}`);
      console.log(`  ❌ ${remote}  失败：${e.message}`);
    }
  }

  if (failed.length) {
    console.log('\n  ⚠️ 有文件下载失败。');
    console.log('     镜像部署仍会继续，但查询编码会退回「关键词近似向量」，');
    console.log('     语义检索质量会下降（top1 命中率约从 16/20 降到 12/20）。');
    console.log('     要修复：确认构建环境能访问 ' + HOST + '，或改用 Git LFS 分发权重。');
    console.log('     也可以直接在平台把 ENABLE_QUERY_MODEL 设为 0，明确走降级路径。');
    process.exit(0);   // 故意不失败：不让可选项拖垮整个部署
  }

  console.log(`\n  ✅ 模型就绪（${ok} 个文件）`);
})().catch(e => {
  // 任何意外都只警告，不阻断构建
  console.error('  ⚠️ fetch_model.js 异常：' + e.message);
  console.error('     继续构建，运行时将退回关键词近似向量。');
  process.exit(0);
});
