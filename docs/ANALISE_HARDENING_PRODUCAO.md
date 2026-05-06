# Análise Técnica e Hardening — Agent NFS-e

Data: 2026-05-06
Projeto: `agent-nfse`

## 1) Resumo da análise

O projeto está bem estruturado para MVP, com fluxo claro ponta a ponta:

`webhook -> transcrição -> extração -> confirmação -> emissão Focus -> envio PDF`

### Pontos fortes

- Arquitetura simples e objetiva por camadas (`handlers`, `services`, `db`).
- Persistência com SQLite e schema organizado com índices.
- Controle de estado de conversa (`aguardando_dados`, `aguardando_confirmacao`, etc.).
- Idempotência de emissão via referência única para Focus NFe.

### Riscos identificados na análise inicial

1. Webhook sem autenticação de origem.
2. Fluxo de aprovação admin frágil (queries dinâmicas e trecho inconsistente).
3. Sem deduplicação robusta de eventos por `messageId`.
4. Arquivos temporários de áudio sem limpeza garantida.

## 2) Hardening aplicado no código

### 2.1 Autenticação do webhook por segredo

Arquivo: `src/server.js`

- Adicionado suporte ao `WEBHOOK_SECRET`.
- Quando definido, o endpoint `POST /webhook` exige header:
  - `x-webhook-secret` (preferencial), ou
  - `x-evolution-secret`.
- Comparação feita com `timingSafeEqual` (evita comparação insegura).
- Requisição inválida retorna `401 unauthorized`.

### 2.2 Deduplicação de eventos por `messageId`

Arquivos: `src/db/schema.sql`, `src/db/index.js`, `src/handlers/webhook.js`

- Criada tabela `mensagens_processadas` com `message_id UNIQUE`.
- Criada função `registrarMensagemProcessada(messageId, numero, tipo)`.
- Se evento repetido chegar, o handler ignora com log (`evento duplicado ignorado`).

### 2.3 Refactor do fluxo de aprovação admin

Arquivo: `src/handlers/webhook.js`

- Removidos `import()` dinâmicos no fluxo de runtime.
- Adicionados/uso de statements explícitos:
  - `findConversaById`
  - `findEmpresaById`
- Ajustado tratamento para conversa/empresa inexistente no comando de aprovação.

### 2.4 Limpeza de áudio temporário

Arquivo: `src/handlers/webhook.js`

- Após transcrição, o arquivo de áudio baixado em `/tmp` é removido no bloco `finally`.

### 2.5 Variáveis de ambiente

Arquivo: `.env.example`

- Incluída variável:
  - `WEBHOOK_SECRET=`

## 3) Validação executada

Validação de sintaxe (`node --check`) concluída com sucesso em:

- `src/server.js`
- `src/handlers/webhook.js`
- `src/db/index.js`

## 4) Checklist de produção (infra e operação)

### Nginx

- Expor apenas `443` publicamente.
- Redirecionar `80 -> 443`.
- Configurar `client_max_body_size` (ex.: `15m`).
- Aplicar rate limit no `/webhook` (ex.: `10r/s` com burst baixo).

### Firewall (UFW)

- Permitir somente:
  - `22/tcp`
  - `80/tcp`
  - `443/tcp`
- Bloquear acesso externo direto em `3000` (app) e `8080` (Evolution).
- Preferir bind local (`127.0.0.1`) para app e Evolution quando possível.

### Segredos e ambiente

- Definir `WEBHOOK_SECRET` forte e único.
- Rotacionar periodicamente:
  - `EVOLUTION_API_KEY`
  - `OPENAI_API_KEY`
  - `ANTHROPIC_API_KEY`
- Restringir permissões do `.env`:
  - `chmod 600 .env`

### PM2 e logs

- Garantir `pm2 startup` + `pm2 save`.
- Instalar e configurar `pm2-logrotate`.
- Revisar logs de erro regularmente:
  - `pm2 logs agent-nfse --lines 200`

### SQLite

- Manter `WAL` ativo (já está).
- Fazer backup diário de:
  - `agent.db`
  - `agent.db-wal`
  - `agent.db-shm`
- Validar restauração periodicamente em ambiente separado.

### Observabilidade mínima

- Usar `/health` para verificação de disponibilidade (já existe).
- Criar alerta simples para processo parado / ausência de eventos por X horas.
- Monitorar taxa de rejeição (`notas_emitidas.status = 'rejeitada'`).

### Privacidade/LGPD

- Definir política de retenção para eventos, transcrições e payloads sensíveis.
- Implementar rotina de limpeza (ex.: dados > 90 dias).

### Teste de fumaça pós-deploy

- Testar mensagem de texto simples.
- Testar áudio curto de emissão.
- Testar confirmação `SIM`.
- Testar aprovação admin e envio de PDF.
- Testar deduplicação reenviando o mesmo evento.

## 5) Próximo passo recomendado

1. Configurar `WEBHOOK_SECRET` no `.env`.
2. Configurar a Evolution para enviar o mesmo segredo no header do webhook.
3. Executar teste de fumaça completo após reinício do serviço.
