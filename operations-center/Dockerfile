FROM node:22.20.0-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && npm ci --omit=dev \
    && npm cache clean --force \
    && apk del .build-deps

FROM node:22.20.0-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY integrations ./integrations
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 9872
CMD ["node", "src/server.js"]
