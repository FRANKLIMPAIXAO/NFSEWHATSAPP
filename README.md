# Agent NFS-e — PAC

Agente WhatsApp **multi-intenção** do PacNoBolso. Cliente fala uma coisa só
(texto, áudio, foto ou PDF) e o agente roteia pra ação certa: emitir nota,
registrar movimento financeiro, consultar/criar lembrete da agenda, ou
tirar dúvida.

---

## Arquitetura

```
WhatsApp (cliente) → Evolution API → Webhook Node.js
                                          ↓
                                    Identifica empresa (Supabase + SQLite)
                                          ↓
                          ┌───── classificarIntencao (Claude) ─────┐
                          ↓             ↓             ↓             ↓
                    emitir_nfse   registrar_   consultar_    duvida_geral
                          ↓       financeiro    agenda            ↓
                    Extractor +      ↓             ↓        Mensagem
                    Focus NFe   handleFinanceiro handleAgenda  de ajuda
                          ↓     (HTTP POST →    (Supabase          ↓
                       PDF/XML  webhook n8n →   poupeja_       resposta
                          ↓     RabbitMQ Meu_App) compromissos)
                       resposta      ↓                ↓
                              [n8n consome,       resposta
                               processa,
                               responde via
                               Evolution]
```

**Stack:** Node.js 20 · Express · better-sqlite3 · Anthropic SDK
(extractor + classificador + agenda) · OpenAI Whisper · Focus NFe ·
Evolution API · Supabase (RLS por user_id)

### Robustez

- Webhook responde 200 imediato (Evolution não fica esperando).
- `handleWebhook` tem `try/catch` global — se qualquer erro vazar do miolo,
  o cliente recebe mensagem amigável em vez de ficar no vácuo.
- Classificador com **threshold de confiança** (≥0.6): abaixo disso vira
  `duvida_geral` em vez de chutar e mandar pro handler errado.
- Conversa em andamento (NFSe parcial aguardando confirmação ou dados)
  **não passa pelo classificador** — continua direto pro extractor pra
  não quebrar fluxo de várias mensagens.

### Resumo matinal proativo (cron)

Todo dia útil às 7h BRT, o agent abre uma mensagem amigável pro
WhatsApp do dono cadastrado mostrando: compromissos de hoje, atrasados,
próximos 7 dias e total a pagar na semana. Cria hábito de consulta
diária — inspirado no concorrente Meu Assessor. Sem nada cadastrado,
não manda nada (zero spam).

Dispatch manual via `POST /api/resumo-matinal-dispatch` (requer JWT
admin) — útil pra testar formatação sem esperar 7h.

Schedule customizável via env `RESUMO_MATINAL_CRON_EXPR`. Desabilita
com `RESUMO_MATINAL_CRON_ENABLED=false`.

---

## Estrutura

```
agent-nfse/
├── src/
│   ├── server.js                # Express + webhook (responde 200 imediato)
│   ├── handlers/
│   │   ├── webhook.js           # Orquestrador (identifica → classifica → roteia)
│   │   ├── agenda.js            # CRUD de compromissos via WhatsApp
│   │   └── financeiro.js        # NOVO — proxy HTTP pro n8n (boleto/pix/extrato)
│   ├── services/
│   │   ├── whisper.js           # Áudio → texto
│   │   ├── extractor.js         # Texto → JSON NFSe (Claude)
│   │   ├── classificador.js     # NOVO — roteador de intenção (Claude)
│   │   ├── focusnfe.js          # Emissão NFS-e
│   │   └── whatsapp.js          # Envio de mensagens/PDFs
│   ├── prompts/
│   │   ├── extractor.js         # System prompt do extrator NFSe
│   │   └── classificador.js     # NOVO — system prompt do classificador
│   ├── db/
│   │   ├── index.js             # Conexão + queries
│   │   ├── empresa-adapter.js   # Supabase row → empresa (inclui _supabaseUserId)
│   │   └── schema.sql           # Schema das tabelas
│   └── utils/
│       └── logger.js            # Pino
├── scripts/                     # init-db, add-empresa, test-extractor, setup-vps
├── .env.example                 # Template (ANTHROPIC_MODEL_CLASSIFICADOR opcional)
├── package.json
└── README.md
```

---

## Setup na VPS (Hostinger KVM 2)

### 1. Apontar DNS

No painel Hostinger, criar registro A apontando `onboarding.com.br` (ou subdomínio escolhido) pro IP da VPS.

### 2. Rodar setup

```bash
ssh root@SEU_IP
wget https://...setup-vps.sh   # ou cole o script
chmod +x setup-vps.sh
./setup-vps.sh
```

Esse script instala: Node.js 20, Docker, PM2, Nginx, Certbot, Evolution API + Postgres.

### 3. Subir código

Da sua máquina local:

```bash
scp -r agent-nfse/ root@SEU_IP:/opt/
```

### 4. Configurar e iniciar

```bash
cd /opt/agent-nfse
npm install
cp .env.example .env
nano .env                    # preencher chaves
npm run init-db
pm2 start src/server.js --name agent-nfse
pm2 save && pm2 startup
```

### 5. Conectar WhatsApp

1. Acesse `https://onboarding.com.br/evolution/manager/`
2. Crie instância chamada `pac-bot`
3. Escaneie o QR code com o WhatsApp dedicado da PAC

### 6. Cadastrar primeira empresa

```bash
npm run add-empresa
```

---

## Variáveis de ambiente (.env)

| Variável | Descrição |
|---|---|
| `ANTHROPIC_API_KEY` | Chave da API do Claude |
| `OPENAI_API_KEY` | Chave Whisper (OpenAI) |
| `FOCUS_NFE_ENV` | `homologacao` (testes) ou `producao` |
| `EVOLUTION_API_KEY` | Chave da Evolution (definida no docker-compose) |
| `ADMIN_WHATSAPP` | Seu número pra aprovar emissões nos primeiros dias |
| `APPROVAL_MODE` | `manual_approval` ou `auto` |

---

## Fluxo de uma emissão (passo a passo)

1. Cliente manda áudio: *"Emite uma nota de R$ 500 pro João da Silva CNPJ 12.345.678/0001-99 manutenção"*
2. Evolution recebe e dispara webhook → `POST /webhook`
3. Handler identifica a empresa pelo número
4. Baixa áudio → Whisper transcreve → Claude extrai JSON estruturado
5. Bot responde: *"NFS-e pra João da Silva, R$ 500, manutenção. Confirma? SIM ou CANCELA"*
6. Cliente: *"sim"*
7. **Modo manual_approval:** bot manda pra você no admin: *"APROVAR 42 ou REJEITAR 42"*. Você responde APROVAR.
8. Bot chama Focus NFe → polling até autorização
9. Bot baixa PDF → manda no WhatsApp do cliente: *"✅ Nota emitida! Número: 12345"*

---

## Comandos úteis

```bash
# Ver logs em tempo real
pm2 logs agent-nfse

# Reiniciar agente
pm2 restart agent-nfse

# Status Evolution API
docker compose -f /opt/evolution-api/docker-compose.yml ps

# Logs Evolution
docker compose -f /opt/evolution-api/docker-compose.yml logs -f evolution-api

# Testar webhook manualmente
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{"event":"messages.upsert","data":{"key":{"fromMe":false,"remoteJid":"5511...@s.whatsapp.net","id":"test"},"messageType":"conversation","message":{"conversation":"oi"}}}'

# Inspecionar banco
sqlite3 /opt/agent-nfse/data/agent.db
> .tables
> SELECT * FROM empresas;
> SELECT * FROM notas_emitidas ORDER BY criada_em DESC LIMIT 10;
> .exit
```

---

## Custo mensal estimado

| Item | Valor |
|---|---|
| VPS Hostinger KVM 2 | ~R$ 25 |
| Focus NFe Start (3 CNPJs) | R$ 113,90 |
| Anthropic (~R$ 0,02/extração) | ~R$ 5-15 |
| OpenAI Whisper (~R$ 0,03/áudio) | ~R$ 5-15 |
| **Total fixo** | **~R$ 145-170** |

Pra 10 clientes pagando R$ 79/mês no agente: receita R$ 790, custo ~R$ 380, **margem ~R$ 410**.

---

## Próximos passos depois do MVP

- Painel web admin (listar empresas, notas emitidas, métricas)
- Cancelamento de NFS-e via WhatsApp ("cancela nota 12345 motivo erro")
- Relatório semanal automático ("essa semana você emitiu 23 notas no total de R$ 18.500")
- Integração com nfse-robo pra também sincronizar NFS-e tomadas
- Multi-prestador (uma empresa com múltiplos sócios autorizados)
