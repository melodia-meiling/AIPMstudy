# =============================================================================
# AIPM 学习工作台 · 容器镜像
# -----------------------------------------------------------------------------
# 适用：Render / Railway / Fly.io / 阿里云 / 腾讯云 等任何支持 Docker 的平台
#
# 设计要点：
#   1. Debian slim 基础镜像，体积小、启动快
#   2. 装完依赖后剔除 sharp（transformers.js 只在处理图片时用它，
#      本项目是纯文本向量，留着会白白多出上百 MB 依赖）
#   3. 知识库与向量索引（data/）随镜像打包 —— 部署后无需重建，
#      离线混合检索开箱即用
#   4. 模型权重在**构建阶段**下载。原因：权重约 98MB，超过 GitHub
#      单文件 100MB 限制，仓库里不存它（见 .gitignore）。
#      下载失败不会让构建失败，只是退回关键词近似向量。
#   5. 以非 root 用户运行（容器安全基线）
#
# 构建：docker build -t aipm-workbench .
# 运行：docker run -p 3000:3000 -e DEEPSEEK_API_KEY=sk-xxx aipm-workbench
# =============================================================================
FROM node:20-slim

# onnxruntime-node 在部分环境需要 libgomp（OpenMP 运行时）；
# ca-certificates 是构建阶段访问 https 镜像站所必需
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

WORKDIR /app

# ---- 依赖层（放最前，利用 Docker 层缓存）----
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund \
 && rm -rf node_modules/sharp \
 && npm cache clean --force

# ---- 应用代码与知识库 ----
COPY server.js prompt.md fetch_model.js ./
COPY public ./public
COPY data ./data

# ---- 向量模型权重（构建时下载，失败不阻断）----
# 本地开发时 models/ 已存在则脚本会跳过下载。
# 想彻底不带模型：注释掉这一行，并设 ENABLE_QUERY_MODEL=0。
RUN node fetch_model.js

# 运行期可写目录（笔记 / 已学 / 错题等落在这里）
RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 3000

# 健康检查：/api/health 不调用任何外部 API，适合做存活探针
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
