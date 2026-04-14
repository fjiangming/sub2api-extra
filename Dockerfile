FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --registry=https://registry.npmmirror.com/
COPY . .
EXPOSE 3100
CMD ["node", "server.js"]
