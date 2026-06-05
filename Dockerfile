# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

RUN npm run build \
  && node scripts/fetch-ytdlp.mjs linux \
  && node scripts/fetch-cloudflared.mjs linux

FROM node:22-bookworm-slim AS production

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3001 \
    REKORD_LISTEN_HOST=0.0.0.0 \
    MUSIC_ROOT=/music \
    REKORD_USER_CONFIG_DIR=/config

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /music /config \
  && chown node:node /music /config

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server ./server
COPY --from=builder /app/public ./public

USER node

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.mjs"]
