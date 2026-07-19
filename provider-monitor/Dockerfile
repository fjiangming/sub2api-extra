FROM node:20-bookworm-slim AS deps
WORKDIR /app

ARG NPM_REGISTRY

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev ${NPM_REGISTRY:+--registry=$NPM_REGISTRY}

FROM node:20-bookworm-slim
WORKDIR /app

ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY public ./public

RUN mkdir -p /app/data && chown -R node:node /app

USER node
EXPOSE 9871

CMD ["node", "src/server.js"]
