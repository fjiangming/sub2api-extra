FROM node:24-bookworm-slim AS deps
WORKDIR /app
ARG NPM_REGISTRY
COPY package.json package-lock.json ./
RUN npm ci --omit=dev ${NPM_REGISTRY:+--registry=$NPM_REGISTRY}

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY sql ./sql
RUN mkdir -p /app/config && chown -R node:node /app
USER node
EXPOSE 9875
CMD ["node", "src/server.js"]
