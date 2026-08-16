# Runs the authoritative server via tsx — no build step (see D-501).
FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY shared ./shared
COPY server ./server
COPY content ./content

ENV NODE_ENV=production
EXPOSE 8080 8081
CMD ["node", "node_modules/tsx/dist/cli.mjs", "server/src/index.ts"]
