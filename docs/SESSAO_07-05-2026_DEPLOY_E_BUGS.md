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

- [x] Rebuild da imagem no EasyPanel (pra subir os edits do código)
- [x] Validar cert via `loadPfx` (script no passo 4)
- [x] Confirmar fluxo: empresa achada, CPF pedido, confirmação SIM
- [ ] Confirmar que `restoreCertsFromEnv` regrava `/app/certs/roca.p12` automaticamente no boot do próximo deploy
- [ ] Testar emissão direta: `node scripts/teste-emissao-roca-epn.js`
- [ ] Repetir fluxo completo via WhatsApp: enviar áudio/texto → confirmar → admin aprova → **PDF da nota recebido**
- [ ] (Opcional) Migrar cert pra volume persistente (`/app/certs`) e remover env var

---

## Problema 3 — Cert sumiu após redeploy (`ENOENT: /app/certs/roca.p12`)

### Sintoma
Após o push do fix do nono dígito (commit `7c637fb`), o redeploy automático
do EasyPanel reconstruiu a imagem e o fluxo no WhatsApp progrediu até a
confirmação ("Sim"). Mas a emissão falhou:

```
Erro técnico (ROCA LTDA): ENOENT: no such file or directory, open '/app/certs/roca.p12'
```

### Causa raiz
`/app/certs` no EasyPanel **não é volume persistente** — todo redeploy reconstrói
o filesystem. O `.p12` que tínhamos colocado manualmente no console
(extraindo da env var `ROCA_CERT_PFX_BASE64`) sumiu junto.

A env var continua existindo, mas ninguém regrava o arquivo após o restart.

### Solução aplicada — restore automático no boot (commit `aa6a463`)

Novo módulo [src/utils/restore-certs.js](agent-nfse/src/utils/restore-certs.js)
chamado uma vez em [src/server.js:8-10](agent-nfse/src/server.js:8) antes do
`app.listen()`.

Lógica:

1. Lê todas as empresas com `cert_pfx_path` setado.
2. Para cada uma, verifica se o arquivo existe em disco.
3. Se NÃO existe, deriva o nome da env var do basename do path:
   `/app/certs/roca.p12` → `ROCA_CERT_PFX_BASE64`.
4. Se a env var existe, decodifica o base64 e grava o `.p12` com perm `600`.
5. Se não existe, loga `warn` (operador sabe imediatamente que falta env var).

Convenção é genérica: cadastrar nova empresa com `cert_pfx_path` setado e adicionar
a env var correspondente — o restore acontece sozinho no próximo deploy.

### Status
- [x] Módulo criado, importado no `server.js`, push em `main`
- [ ] Rebuild no EasyPanel pra ativar (auto-deploy deve disparar)
- [ ] Confirmar nos logs do container que a mensagem `certs restaurados de env vars no boot` aparece após o boot

### Quick fix imediato (enquanto aguarda rebuild)
Pra desbloquear o teste agora sem esperar o auto-deploy:

```bash
node -e "require('fs').writeFileSync('/app/certs/roca.p12',Buffer.from(process.env.ROCA_CERT_PFX_BASE64.replace(/\s+/g,''),'base64'));require('fs').chmodSync('/app/certs/roca.p12',0o600);console.log('OK',require('fs').statSync('/app/certs/roca.p12').size,'bytes')"
```

Manda "Sim" no WhatsApp em seguida.

---

## Problema 4 — `cServTribNac` undefined no payload EPN

### Sintoma
Após cert OK e empresa identificada, emissão falhava com:
```
DPS inválido — 1 erro(s):
  • [infDps.servico.codigoServico.cServTribNac] Invalid input: expected string, received undefined
```

### Causa
O extractor produz `codigo_lc116` (formato LC 116/2003 ex `"14.01"`), mas o EPN exige `cServTribNac` (formato pós-Reforma, ex `"140101"`). Os scripts de teste mascaravam fazendo o fallback manualmente. O webhook em produção passava `payload.servico` direto sem fallback.

### Solução (commit `828fafb`)
No `emissor.js` (caminho EPN), antes de chamar `emitirEpn`, fazer fallback:
```js
codigo_servico_nacional:
  servico.codigo_servico_nacional ||
  empresa.servico_padrao_lc116 ||
  null
```
Se nem isso vier, lança erro descritivo em vez de deixar a SEFAZ rejeitar opacamente.

---

## Problema 5 — Endereço do tomador faltando

### Sintoma
```
DPS inválido: Endereço do tomador é obrigatório quando o tomador é identificado.
```

### Causa
Extractor não pedia endereço do tomador, então pra tomador PF (CPF) o payload ia sem `tomador.endereco`.

### Solução (commit `a68256c` + refinamentos `192eb03`, `0ef2a5a`)
3 mudanças encadeadas:

1. **`prompts/extractor.js`** — adiciona `tomador.endereco` (cep+numero) como obrigatório quando tomador tem documento. Marca `status=incomplete` se faltar.
2. **`services/viacep.js`** (novo) — resolve CEP em logradouro/bairro/município/UF/IBGE via API ViaCEP. Timeout 5s, fail-soft com warn.
3. **`services/extractor.js`** — pós-processamento: se LLM extraiu CEP, chama ViaCEP e completa. Se CEP inválido, força `incomplete` com mensagem clara pro usuário corrigir.
4. **`services/epn.js`** — mapeia `tomador.endereco` pro formato `EnderecoData` (xLgr/nro/cMun/uf/cep/...) que a SEFAZ espera.
5. **`services/emissor.js`** — validação rigorosa antes de chamar EPN: exige cep, numero, logradouro, bairro, ibge/municipio, uf não-vazios. Se faltar qualquer, erro descritivo.
6. Prompt explicita pro LLM **NÃO inventar** logradouro/bairro/UF — sistema resolve via ViaCEP. (Sem isso, o LLM "alucinava": criou `"Rua 13"` sem base, deixou bairro null → SEFAZ rejeitou).

---

## Feature 6 — Tomador PJ via CNPJ (BrasilAPI)

### Motivação
Pra tomador PJ, é UX horrível pedir endereço. Solução: usuário só informa o CNPJ, sistema consulta a Receita Federal.

### Implementação (commit `530e42d`)
1. **`services/cnpj-lookup.js`** (novo) — wrapper sobre BrasilAPI (`https://brasilapi.com.br/api/cnpj/v1/{cnpj}`). Gratuita, sem auth, mas requer User-Agent (sem ele retorna 403). Retorna razão social + endereço completo + IBGE + situação cadastral.
2. **`services/extractor.js`** — pós-processamento PJ: se tomador é PJ + tem 14 dígitos, chama BrasilAPI e completa razão social + endereço. Se não encontrado, força `incomplete`. Se situação não-ATIVA, sinaliza em `observacoes`.
3. **`prompts/extractor.js`** — instrução clara: pra PJ, NÃO extrair endereço (sistema completa pelo CNPJ); só pra PF é que CEP+número são obrigatórios.

### Resultado
```
Você: "Emite nota R$1500 pra CNPJ 63052142000112 consultoria"
Bot:  "NFS-e para ROCA LTDA (...). Confirma?"  ← consultou Receita
```

---

## Auditoria 7 — Padrão Nacional XML oficial vs nosso payload (commits `e904ef7`, `849a771`)

Usuário compartilhou repo oficial `github.com/VenturaCerqueira/NFS-e-novo` e PDF `Padrão Nacional.xml`. Auditoria campo por campo do XSD revelou 5 gaps (já em homologação aceitava, mas produção pode/deve exigir):

1. **`prestador.inscricaoMunicipal`** — empresa.inscricao_municipal cadastrado no DB mas não enviado.
2. **`prestador.nome`** (xNome) — razão social do prestador, não estávamos enviando.
3. **`prestador.endereco`** (enderNac) — endereço do prestador, não estávamos enviando. Helper `prestadorEnderecoFromEmpresa()` faz parse de `empresa.endereco_json` + `municipio_codigo` + `uf`.
4. **`tributacao.issqn.aliquota`** (pAliq) — alíquota como decimal (0.05 pra 5%). Estávamos enviando só o totalizador.
5. **`tributacao.issqn.exigibilidadeISS`** — default 1 (exigível).

Bloco IBS/CBS Reforma Tributária com defaults seguros pra serviço comum:
- `infDps.ibsCbs.finNFSe = "0"` (NFS-e regular)
- `infDps.ibsCbs.cIndOp = "100000"` (operação interna padrão; Anexo VII pra casos especiais)
- `infDps.ibsCbs.indDest = "0"` (destinatário = tomador)
- `infDps.ibsCbs.indFinal = "0"` (não é consumo pessoal)
- `valores.trib.gIBSCBS.CST = "000"` (tributação plena)
- `valores.trib.gIBSCBS.cClassTrib = "010100"` (serviços em geral)

**Casos especiais NÃO cobertos (TODO quando aparecer caso real):** exportação (CST 200), imunidade (300), ZFM, ente governamental, intermediário, obra/evento, retenções federais (vRetIRRF/vRetCSLL), tomador estrangeiro com NIF.

---

## Confirmação de ambiente — Homologação

Chave de acesso da nota emitida: `52087072263052142000112000000000000626058358138896`

Decodificada:
| Posição | Valor | Significado |
|---|---|---|
| 1-7 | `5208707` | Goiânia/GO |
| 8 | **`2`** | **tpAmb = 2 → HOMOLOGAÇÃO** (1=Produção) |
| 9 | `2` | tpInsc (CNPJ) |
| 10-23 | `63052142000112` | CNPJ Roca |
| 24-49 | sequencial + DV | (zeros à esquerda típicos de homologação) |

Nota é fake (sem valor fiscal). Confirma URL `adn.producaorestrita.nfse.gov.br` no `.env`.

---

## Resumo de commits desta sessão

| Hash | Descrição |
|---|---|
| `7c637fb` | fix(webhook): normaliza nono dígito do celular brasileiro na busca de empresa |
| `aa6a463` | feat(boot): restaura .p12 ausente a partir de env var no startup |
| `43a4f59` | docs: atualiza sessão 07/05 com problema 3 |
| `828fafb` | fix(emissor): preenche codigo_servico_nacional no fluxo EPN com fallback da empresa |
| `a68256c` | feat(tomador): exige endereço quando tomador identificado, resolve CEP via ViaCEP |
| `192eb03` | fix(emissor): validação rigorosa do endereço do tomador antes de chamar EPN |
| `0ef2a5a` | fix(extractor): resolve CEP via ViaCEP no pós-processamento e detecta CEP inválido |
| `530e42d` | feat(tomador-pj): consulta automática de CNPJ via BrasilAPI |
| `e904ef7` | feat(epn): inclui IM do prestador e bloco IBS/CBS da Reforma Tributária |
| `849a771` | feat(epn): completa prestador (nome+endereço) e tributacao.issqn (alíquota+exigibilidade) |

---

## Pendências ao final da sessão

1. **Erro com áudio** — usuário reportou "no áudio dá um erro" mas faltou diagnóstico (rodar query de eventos `transcricao`/`extracao` no DB pra ver o que falhou).
2. **`scripts/cadastrar-empresa.js` genérico** — pedido pelo usuário, não foi criado. Útil pra onboarding de futuras empresas.
3. **Ligar produção** — quando confiante: `EPN_AMBIENTE=producao` no EasyPanel. Pré-req: cert habilitado pra produção (não só restrita) + Roca aderiu ao EPN no portal nfse.gov.br.
4. **Casos especiais Reforma Tributária** — exportação, imunidade, ZFM, ente governamental, intermediação, obra/evento, retenções federais.

---

## Notas e referências

- **Empresas no DB local**: id=1 Jovelino e Acilda (El Shadai/Aparecida, focus), id=2 ROCA LTDA (Goiânia, EPN).
- **Empresas no servidor EasyPanel**: id=2 PAC Contabilidade Teste (CNPJ fictício, focus), id=3 ROCA LTDA (Goiânia, EPN).
- **Stack**: SQLite (better-sqlite3) + Node 20 Alpine + Chromium nativo + Puppeteer (DANFE PDF) + lib `nfse-nacional` (mTLS direto SEFAZ Nacional).
- **Host**: EasyPanel auto-deploy do branch `main` em `github.com/FRANKLIMPAIXAO/NFSEWHATSAPP`.
- **Repo oficial referência**: `github.com/VenturaCerqueira/NFS-e-novo` (XSDs, manuais, exemplos).
- **PDF de referência local**: `/Users/franklimpaixao/Documents/MENTORIA FAMILIA TRIBUTARIA/padraonacional.pdf` (XML DPS exemplo, 2 páginas).
