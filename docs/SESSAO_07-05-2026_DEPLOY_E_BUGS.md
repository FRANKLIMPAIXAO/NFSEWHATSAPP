# Sessão 07/05/2026 — Deploy EasyPanel + correção de bugs em produção

## Contexto

Primeira tentativa de emissão real em produção da empresa-piloto **Roca Serviço LTDA** (CNPJ `63052142000112`, emissor EPN). Duas falhas em sequência:

1. **06:40** — bot recebeu confirmação ("Sim") e respondeu `❌ Tive um erro técnico ao emitir. A equipe foi notificada.`
2. **17:22** — bot respondeu `Olá! Este número não está cadastrado no agente PAC.`

A investigação descobriu duas causas independentes, descritas abaixo.

---

## Problema 1 — Certificado A1 (.p12) chegando corrompido no container EasyPanel

### Sintoma
Erro técnico durante emissão NFS-e via emissor EPN, que precisa do PFX `/app/certs/roca.p12` carregado em mTLS contra a SEFAZ.

### Causa raiz
Tentativas anteriores de transferir o `.p12` via paste de base64 no console web do EasyPanel quebravam o conteúdo binário — o terminal cortava/reformatava a string longa, deixando o `.p12` inválido.

### Solução adotada — base64 via env var
Em vez de colar base64 no console (instável), passamos como **variável de ambiente** (campo do EasyPanel aceita strings longas sem corromper):

#### Passo 1 — gera o base64 no Mac
```bash
cd "/Users/franklimpaixao/Documents/CLAUDE/EMISSOR NOTA WHTASAP/agent-nfse"
base64 -i certs/roca.p12 | tr -d '\n' | pbcopy
```

#### Passo 2 — adiciona env var no EasyPanel
Aba **Environment** do serviço:
- `Name`: `ROCA_CERT_PFX_BASE64`
- `Value`: `<paste do base64>`

EasyPanel reinicia o container automaticamente.

#### Passo 3 — extrai pro arquivo no console do container
```bash
rm -f /app/certs/roca.p12
node -e "require('fs').writeFileSync('/app/certs/roca.p12',Buffer.from(process.env.ROCA_CERT_PFX_BASE64.replace(/\s+/g,''),'base64'));console.log('OK',require('fs').statSync('/app/certs/roca.p12').size,'bytes')"
chmod 600 /app/certs/roca.p12
```

Esperado: `OK 8791 bytes` (mesmo tamanho do arquivo local).

#### Passo 4 — valida o cert
```bash
node -e "import('./src/services/cert.js').then(({loadPfx}) => { const r=loadPfx('/app/certs/roca.p12','Roca123@'); console.log('CN:', r.metadata.cn, '| CNPJ:', r.metadata.cnpj); })"
```

#### Passo 5 — teste de emissão
```bash
node scripts/teste-emissao-roca-epn.js
```

### Status
- [x] Base64 gerado e colado no EasyPanel
- [ ] Validação do cert no console (passos 3-4) — **pendente confirmação**
- [ ] Teste de emissão (passo 5) — pendente

### Próximo passo recomendado (segurança)
Depois que tudo voltar a funcionar, **migrar pra volume persistente** em vez de env var (mais seguro — env vars ficam expostas no painel):

No EasyPanel → **Mounts**:
- Volume `agent-nfse-certs` → mount path `/app/certs`

E remover a env var `ROCA_CERT_PFX_BASE64` depois.

---

## Problema 2 — "Número não cadastrado" mesmo com empresa no banco

### Sintoma
Mensagem de WhatsApp do dono da Roca recebia resposta `Olá! Este número não está cadastrado no agente PAC.`, apesar da empresa estar cadastrada com `ativa=1` no SQLite.

### Investigação
Query diagnóstica no console do container (`/app/data/agent.db`, 156KB, persistido):

**Tabela `empresas`:**
| id | cnpj | whatsapp_dono | dígitos | ativa |
|----|------|---------------|---------|-------|
| 2 | 12345678000199 (teste) | `556294089289` | **12** | 1 |
| 3 | 63052142000112 (Roca) | `5562986429305` | **13** | 1 |

**Tabela `mensagens_processadas` (últimas 5 — `numero` recebido pelo webhook):**
| message_id | numero | criado_em |
|------------|--------|-----------|
| `2A01B210...D7506` | `556286429305` (12 dígitos) | 20:22:58 |
| `A51525...C80E`    | `556294089289` (12 dígitos) | 09:40:29 |
| `A52AC9...FCBD`    | `556294089289` (12 dígitos) | 09:40:18 |
| ... | ... | ... |

### Causa raiz — "nono dígito" inconsistente
O **WhatsApp Cloud API** entrega celular brasileiro ora com o "nono dígito" (`5562 9 8642-9305` = 13 chars), ora sem (`5562 8642-9305` = 12 chars). Não tem como prever qual formato vem.

- Cadastro Roca: `5562986429305` (13 chars, com 9)
- Webhook recebeu: `556286429305` (12 chars, sem 9)
- Comparação `WHERE whatsapp_dono = ?` falha → empresa não encontrada → mensagem genérica de "não cadastrado"

A empresa-teste id=2 funcionou de manhã porque o cadastro casualmente já estava sem o 9 (12 chars), batendo com o que a Meta entregou.

### Solução aplicada — normalização de variantes

Edits em duas posições:

#### `src/db/index.js`
- Substituído o `prepare()` direto de `findEmpresaByWhatsapp` por uma função wrapper que tenta múltiplas variantes do número.
- Helpers exportados: `variantesNumeroBr(numero)` e `mesmoNumeroBr(a, b)`.

```js
const findEmpresaByWhatsappStmt = db.prepare(
    "SELECT * FROM empresas WHERE whatsapp_dono = ? AND ativa = 1"
);

export function variantesNumeroBr(numero) {
    if (!numero) return [];
    const variants = new Set([numero]);
    // 12 chars: 55 + DDD(2) + 8 dígitos → adiciona o 9 após o DDD
    if (/^55\d{10}$/.test(numero)) {
        variants.add(numero.slice(0, 4) + "9" + numero.slice(4));
    }
    // 13 chars: 55 + DDD(2) + 9 + 8 dígitos → remove o 9 após o DDD
    if (/^55\d{2}9\d{8}$/.test(numero)) {
        variants.add(numero.slice(0, 4) + numero.slice(5));
    }
    return [...variants];
}

export function mesmoNumeroBr(a, b) {
    if (!a || !b) return false;
    const va = variantesNumeroBr(a);
    return va.includes(b) || variantesNumeroBr(b).some((x) => va.includes(x));
}

export const findEmpresaByWhatsapp = {
    get(numero) {
        for (const variant of variantesNumeroBr(numero)) {
            const row = findEmpresaByWhatsappStmt.get(variant);
            if (row) return row;
        }
        return undefined;
    },
};
```

#### `src/handlers/webhook.js`
- Import de `mesmoNumeroBr`.
- Comparação `numero === ADMIN_WHATSAPP` substituída por `mesmoNumeroBr(numero, ADMIN_WHATSAPP)` (mesmo bug do nono dígito atingiria o admin).

### Resultado
A query passa a buscar empresas tentando ambos os formatos do número (com/sem o 9), independente do que a Meta entregar. O admin também é reconhecido nos dois formatos.

### Status
- [x] Edits aplicados em `src/db/index.js` e `src/handlers/webhook.js`
- [ ] Redeploy no EasyPanel (precisa rebuild da imagem) — **pendente**
- [ ] Teste end-to-end no WhatsApp depois do redeploy — pendente

---

## Verificações já feitas

### Volume `/app/data` está persistente
O `agent.db` (156KB) sobreviveu aos restarts do container durante o trabalho com o cert. Não precisa montar volume nomeado pra `/app/data` — EasyPanel já preserva. *(Não é o caso do `/app/certs`, ainda dependente de env var.)*

### Schema do `mensagens_processadas`
Colunas: `id, message_id, numero, tipo, criado_em` (não `processada_em` — pequena correção pra queries futuras de diagnóstico).

### Empresas em produção
- id=2: empresa-teste, CNPJ fictício `12345678000199`, focus
- id=3: Roca Serviço LTDA, CNPJ `63052142000112`, emissor EPN

---

## Checklist pós-deploy

- [ ] Rebuild da imagem no EasyPanel (pra subir os edits do código)
- [ ] Confirmar que `/app/certs/roca.p12` tem 8791 bytes após restart
- [ ] Validar cert via `loadPfx` (script no passo 4)
- [ ] Testar emissão direta: `node scripts/teste-emissao-roca-epn.js`
- [ ] Testar fluxo completo via WhatsApp: enviar áudio/texto → confirmar → admin aprova → nota emitida
- [ ] Migrar cert pra volume persistente (`/app/certs`) e remover env var

---

## Notas e referências

- **Empresa-piloto**: Centro Automotivo El Shadai (Aparecida de Goiânia) — primeira empresa cadastrada no agent-nfse (id=2 com CNPJ de teste, ainda não emite em produção real).
- **Empresa em produção real**: Roca Serviço LTDA (id=3, CNPJ `63052142000112`).
- **Stack**: SQLite (better-sqlite3) + Node 20 Alpine + Chromium nativo + Puppeteer (DANFE PDF) + EPN (mTLS direto SEFAZ Nacional).
- **Host**: EasyPanel + Supabase (sistema PAC no Bolso, integrando com este agente WhatsApp).
