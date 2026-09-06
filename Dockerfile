# 公共新知识空间 P0 原型 — 部署镜像
# 同一个镜像被render.yaml里的web和worker两个服务共用，
# 靠各自不同的启动命令(node server.js / node worker.js)区分角色。

FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --omit=dev

COPY . .

# 实际监听端口由Render注入的PORT环境变量决定，见server.js
EXPOSE 4000

CMD ["node", "server.js"]
