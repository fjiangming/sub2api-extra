FROM node:20-alpine
WORKDIR /app

# 安装 zip 工具（alpine 默认没有）
RUN apk add --no-cache zip

# 安装应用依赖
COPY package.json ./
RUN npm install --omit=dev --registry=https://registry.npmmirror.com/

# 拷贝所有源码
COPY . .

# 构建加密插件包 → 生成 ZIP → 清理构建产物
RUN cd protection \
    && npm install \
    && npm run build \
    && cd dist/extension-protected \
    && zip -r /app/public/epoint-gpt-autoreg-extension.zip . \
    && cd /app \
    && rm -rf protection/dist protection/node_modules

EXPOSE 3100
CMD ["node", "server.js"]
