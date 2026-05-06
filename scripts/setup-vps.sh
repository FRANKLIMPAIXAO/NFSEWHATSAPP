#!/usr/bin/env bash
# ============================================================================
# AGENT NFS-E — Setup completo na VPS Hostinger
# ============================================================================
#
# Roda como root (sudo) na VPS limpa Ubuntu 22.04 ou 24.04.
# Subdomínio assumido: onboarding.com.br (ajuste se for outro).
#
# Tempo: ~10 minutos.
# ============================================================================

set -euo pipefail

DOMAIN="onboarding.com.br"
EMAIL="seu-email@aqui.com"          # pra Let's Encrypt — ATUALIZAR
APP_DIR="/opt/agent-nfse"
EVOLUTION_DIR="/opt/evolution-api"

echo "==> 1/8  Atualizando sistema..."
apt-get update -y
apt-get upgrade -y

echo "==> 2/8  Instalando Node.js 20, build tools, git..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs build-essential git sqlite3 nginx certbot python3-certbot-nginx

echo "==> 3/8  Instalando Docker (pra Evolution API)..."
if ! command -v docker &>/dev/null; then
    curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

echo "==> 4/8  Instalando PM2 (gerenciador de processos)..."
npm install -g pm2

echo "==> 5/8  Subindo Evolution API via Docker..."
mkdir -p $EVOLUTION_DIR
cat > $EVOLUTION_DIR/docker-compose.yml <<'EOF'
services:
  evolution-api:
    image: atendai/evolution-api:latest
    container_name: evolution-api
    restart: always
    ports:
      - "127.0.0.1:8080:8080"
    environment:
      - SERVER_TYPE=http
      - SERVER_PORT=8080
      - SERVER_URL=https://onboarding.com.br
      - DATABASE_ENABLED=true
      - DATABASE_PROVIDER=postgresql
      - DATABASE_CONNECTION_URI=postgresql://evolution:evolution_pass@postgres:5432/evolution
      - AUTHENTICATION_API_KEY=AJUSTE_SUA_CHAVE_FORTE_AQUI
      - LOG_LEVEL=ERROR,WARN,INFO
      - LOG_COLOR=true
      - WEBHOOK_GLOBAL_URL=http://host.docker.internal:3000/webhook
      - WEBHOOK_GLOBAL_ENABLED=true
      - WEBHOOK_GLOBAL_WEBHOOK_BY_EVENTS=false
      - WEBHOOK_EVENTS_MESSAGES_UPSERT=true
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - ./instances:/evolution/instances
    depends_on:
      - postgres

  postgres:
    image: postgres:15-alpine
    container_name: evolution-postgres
    restart: always
    environment:
      - POSTGRES_USER=evolution
      - POSTGRES_PASSWORD=evolution_pass
      - POSTGRES_DB=evolution
    volumes:
      - postgres_data:/var/lib/postgresql/data

volumes:
  postgres_data:
EOF

cd $EVOLUTION_DIR
docker compose up -d

echo "==> 6/8  Configurando Nginx + SSL pro domínio $DOMAIN..."
cat > /etc/nginx/sites-available/agent-nfse <<EOF
server {
    listen 80;
    server_name $DOMAIN;

    # Webhook do agente (porta 3000 do Node)
    location /webhook {
        proxy_pass http://127.0.0.1:3000/webhook;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # Healthcheck
    location /health {
        proxy_pass http://127.0.0.1:3000/health;
    }

    # Painel da Evolution API (porta 8080)
    location /evolution/ {
        proxy_pass http://127.0.0.1:8080/;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    }
}
EOF

ln -sf /etc/nginx/sites-available/agent-nfse /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

# SSL via Let's Encrypt
certbot --nginx -d $DOMAIN --email $EMAIL --agree-tos --non-interactive --redirect

echo "==> 7/8  Clonando o agente em $APP_DIR..."
mkdir -p $APP_DIR
cd $APP_DIR
# Você vai fazer git clone aqui. Por ora, copie os arquivos manualmente:
# scp -r agent-nfse/ root@SEU_IP:/opt/

echo "==> 8/8  Configuração final manual:"
cat <<INSTRUCOES

╔══════════════════════════════════════════════════════════════════════╗
║ PRÓXIMOS PASSOS MANUAIS                                              ║
╠══════════════════════════════════════════════════════════════════════╣
║                                                                      ║
║ 1. SUBIR O CÓDIGO DO AGENTE                                          ║
║    Da sua máquina local:                                             ║
║      scp -r agent-nfse/ root@SEU_IP:/opt/                            ║
║                                                                      ║
║ 2. INSTALAR DEPENDÊNCIAS                                             ║
║      cd /opt/agent-nfse                                              ║
║      npm install                                                     ║
║                                                                      ║
║ 3. CONFIGURAR .ENV                                                   ║
║      cp .env.example .env                                            ║
║      nano .env       # preencher chaves                              ║
║                                                                      ║
║ 4. INICIAR BANCO                                                     ║
║      npm run init-db                                                 ║
║                                                                      ║
║ 5. RODAR COM PM2                                                     ║
║      pm2 start src/server.js --name agent-nfse                       ║
║      pm2 save                                                        ║
║      pm2 startup                                                     ║
║                                                                      ║
║ 6. CONECTAR INSTÂNCIA WHATSAPP                                       ║
║      Acesse https://$DOMAIN/evolution/manager/                       ║
║      Crie instância "pac-bot"                                        ║
║      Escaneie QR code com o WhatsApp dedicado da PAC                 ║
║                                                                      ║
║ 7. TESTAR HEALTH                                                     ║
║      curl https://$DOMAIN/health                                     ║
║                                                                      ║
║ 8. CADASTRAR PRIMEIRA EMPRESA                                        ║
║      cd /opt/agent-nfse && npm run add-empresa                       ║
║                                                                      ║
╚══════════════════════════════════════════════════════════════════════╝
INSTRUCOES
