FROM node:20-alpine
WORKDIR /app

# npm 镜像源：中国大陆构建传 --build-arg NPM_REGISTRY=https://registry.npmmirror.com/
# 不传则使用默认的 registry.npmjs.org
ARG NPM_REGISTRY

# 安装应用依赖
COPY package.json package-lock.json ./
RUN npm ci --omit=dev ${NPM_REGISTRY:+--registry=$NPM_REGISTRY}

# 拷贝所有源码
COPY . .

# 构建加密插件包（含混淆 + ZIP 打包 → public/）→ 清理构建产物
RUN cd protection \
    && npm install ${NPM_REGISTRY:+--registry=$NPM_REGISTRY} \
    && npm run build \
    && cd /app \
    && rm -rf protection/dist protection/node_modules

EXPOSE 3100
CMD ["node", "server.js"]
