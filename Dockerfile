# =============================================================================
# Dockerfile multi-stage pro agent-nfse
# Alpine + chromium (pra Puppeteer/DANF-Se PDF) + node-gyp pra better-sqlite3.
# Stage 1 compila, stage 2 roda — imagem final fica enxuta.
# =============================================================================

FROM node:20-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json ./
# CRITICAL: pula download do Chromium pelo Puppeteer (transitive de nfse-nacional).
# Sem isso o postinstall trava o build em Alpine. O Chromium do sistema é
# instalado no stage runtime (apk add chromium).
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
RUN npm ci --no-audit --no-fund --omit=dev


FROM node:20-alpine
WORKDIR /app

# Chromium nativo do Alpine — Puppeteer usa este em vez de baixar o próprio.
# Reduz tamanho da imagem e funciona em arquiteturas onde Puppeteer não tem build.
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    font-noto-emoji

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# node_modules já compilados (incluindo better-sqlite3 nativo)
COPY --from=builder /app/node_modules ./node_modules

# Cache-bust: incrementar quando precisar forçar rebuild fresh no EasyPanel
ARG CACHEBUST=2026-05-16-14
RUN echo "cachebust=$CACHEBUST"

# Código da aplicação (respeita .dockerignore)
COPY . .

# Volumes persistentes (Easypanel monta aqui)
RUN mkdir -p /app/data /app/certs /app/data/notas /tmp/agent-nfse-audio
ENV DB_PATH=/app/data/agent.db \
    NFSE_PDF_DIR=/app/data/notas

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "src/server.js"]
