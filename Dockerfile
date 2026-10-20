# 君威智能排产助手 · 生产镜像
# 基础镜像用 node:24-alpine（与开发机 Node v24 对齐，体积 ~50MB）
# 本应用零第三方依赖、无构建步骤，静态产物即源码，因此不需要多阶段构建。
FROM node:24-alpine

LABEL org.opencontainers.image.title="君威智能排产助手 · 静态分发" \
      org.opencontainers.image.description="钢绳索具工厂多工序智能排产工作台（原生 ES Modules，零运行时依赖）" \
      org.opencontainers.image.version="1.0.0"

# 生产模式；容器内必须监听 0.0.0.0 才能被 -p 映射访问；日志用 JSON 便于采集
ENV NODE_ENV=production \
    PORT=5178 \
    HOST=0.0.0.0 \
    ROOT=/app \
    READ_ONLY=true \
    MAX_AGE=3600 \
    LOG_FORMAT=json \
    LOG_LEVEL=info

WORKDIR /app

# 只拷贝运行所需：前端、数据快照、静态服务器（自检脚本 / 文档 / 设计稿不进镜像）
COPY web/ /app/web/
COPY data/ /app/data/
COPY tools/serve.mjs /app/tools/serve.mjs

# 非 root 运行：直接复用基础镜像自带的 node 用户（uid 1000）
RUN chown -R node:node /app
USER node

EXPOSE 5178

# 健康检查直接打 /healthz：不依赖 curl/wget，只用 node 内置模块
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "const p=Number(process.env.PORT||5178);require('node:http').get({host:'127.0.0.1',port:p,path:'/healthz',timeout:2500},r=>{r.resume();process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1)).on('timeout',function(){this.destroy();process.exit(1)})"]

# 只读静态分发；默认即为只读模式（写方法一律 405）
CMD ["node", "tools/serve.mjs"]
