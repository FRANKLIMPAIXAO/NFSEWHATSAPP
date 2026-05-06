# =============================================================================
# Dockerfile multi-stage pro agent-nfse
# better-sqlite3 precisa de build tools nativos (compila em musl no Alpine)
# Stage 1 compila, stage 2 só roda — imagem final fica enxuta.
# =============================================================================

FROM node:20-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev


FROM node:20-alpine
WORKDIR /app

# Copia node_modules já compilados do builder
COPY --from=builder /app/node_modules ./node_modules

# Copia código da aplicação (respeita .dockerignore)
COPY . .

# Diretório do SQLite (Easypanel monta volume persistente aqui)
RUN mkdir -p /app/data
ENV DB_PATH=/app/data/agent.db

# Diretório temp pros áudios baixados do WhatsApp
RUN mkdir -p /tmp/agent-nfse-audio

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Healthcheck próprio do container (Easypanel usa pra restart automático)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "src/server.js"]
