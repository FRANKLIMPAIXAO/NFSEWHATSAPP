/**
 * src/services/financeiro-extractor.js
 * Extractor especializado pra mensagens financeiras (boleto, comprovante Pix,
 * texto/áudio de transação). Usa Claude pra interpretar e devolve JSON
 * estruturado pronto pra INSERT no Supabase.
 *
 * Substitui o AI Agent do workflow n8n "Conciliação Bancária WhatsApp"
 * (gpt-4.1-mini + langchain). Vantagens vs n8n:
 *   - Resposta determinística (Claude com schema fixo, não langchain)
 *   - Sem dependência de Redis Chat Memory (não precisamos pra extração
 *     pontual de transação)
 *   - Bem mais barato (Haiku ~5x mais rápido que gpt-4.1-mini)
 *   - Versionável em git
 *   - Testável com fixtures
 */
import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../utils/logger.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
// Default Haiku pra extração financeira — tarefa relativamente simples
// (extrair valor + descrição + tipo + categoria). Override possível.
const MODEL = process.env.ANTHROPIC_MODEL_FINANCEIRO || "claude-haiku-4-5";

/**
 * Sub-tipos de mensagem financeira (alinhado com o subtipo que o
 * classificador devolve).
 */
const SUBTIPOS_BOLETO = new Set(["boleto"]);
const SUBTIPOS_TRANSACAO = new Set([
    "pagamento_efetuado",
    "recebimento",
    "outro",
]);

// ── Prompts ──────────────────────────────────────────────────────

const BOLETO_SYSTEM_PROMPT = `Você é um especialista em extrair dados de BOLETOS BANCÁRIOS e FATURAS de pagamento (não comprovantes — esses são separados).

A entrada é uma imagem ou PDF de boleto/fatura. Extraia:

- entity_name: nome da empresa beneficiária / cedente. Pode ser empresa, fornecedor, pessoa. Curto, sem "LTDA" se possível. Ex: "Vivo", "Eletropaulo", "Locador João Silva".
- description: descrição curta do que é. Ex: "Internet", "Energia elétrica", "Aluguel", "Software", "Mensalidade contador". Se não estiver claro no boleto, use o entity_name + tipo de serviço inferido.
- amount: valor a pagar em decimal (ponto). Ex: 1234.56. Se houver desconto, considere o valor LÍQUIDO. Se houver multa/juros, use o valor TOTAL com encargos.
- due_date: data de vencimento no formato ISO YYYY-MM-DD. Se já passou, use a data mesmo.
- numero_boleto: número/linha digitável OU nosso número (opcional, só se aparecer claro).

REGRAS:
- Se a imagem NÃO for um boleto/fatura (ex: é um comprovante de pagamento já feito, foto de produto, etc), retorne {status: "not_boleto", motivo: "..."} pra eu desviar pro handler certo.
- Se faltar valor OU vencimento (campos críticos), retorne {status: "incomplete", campos_faltantes: [...]}.
- Se tudo OK, retorne {status: "ok", entity_name, description, amount, due_date, numero_boleto?}.

DEVOLVA APENAS JSON, sem markdown:
{
  "status": "ok" | "incomplete" | "not_boleto",
  "entity_name": "...",
  "description": "...",
  "amount": 1234.56,
  "due_date": "YYYY-MM-DD",
  "numero_boleto": "string ou null",
  "campos_faltantes": ["..."],
  "motivo": "string"
}`;

const TRANSACAO_SYSTEM_PROMPT = `Você é um especialista em extrair dados de TRANSAÇÕES FINANCEIRAS já realizadas (não boleto futuro).

Entrada possível:
- Texto: "paguei 50 reais no mercado", "recebi 1200 do cliente João"
- Áudio transcrito: idem
- Imagem: comprovante de Pix, transferência, recibo

A empresa do usuário é "{NOME_EMPRESA}" (CNPJ {CNPJ_EMPRESA}).

Extraia:
- type: "expense" (saiu dinheiro) ou "income" (entrou dinheiro)
   * "paguei", "gastei", "comprei", "saiu", Pix com remetente=empresa → expense
   * "recebi", "entrou", "cliente pagou", Pix com destinatário=empresa → income
   * Em imagem de Pix: SE o destinatário do Pix for a empresa do usuário (CNPJ acima) → income. Senão → expense.
- amount: valor em decimal. Aceita "mil" = 1000, "1.5k" = 1500, "R$ 82,50" = 82.50.
- description: descrição curta. Ex: "Mercado Atacadão", "Pix de João Silva", "Posto Shell". Se vier de imagem, usa o nome do destinatário/remetente do Pix.
- date: data ISO YYYY-MM-DD. Default hoje se não mencionar.
- categoria_sugerida: uma destas EXATAS (case-sensitive):
   * "Receita" — qualquer income
   * "Alimentação" — mercado, restaurante, padaria, iFood
   * "Transporte" — combustível, Uber, ônibus, posto
   * "Moradia" — aluguel, energia, água, internet, condomínio
   * "Impostos" — DAS, DARF, DARE, IPVA, IPTU
   * "Outros" — qualquer outro

REGRAS:
- Se faltar valor OU descrição (críticos), retorne {status: "incomplete", campos_faltantes: [...], pergunta: "Faltou X — me manda?"}.
- A pergunta deve ser HUMANA, brasileira, sem jargão. Ex: "Faltou o valor — quanto foi?"
- Se a entrada não parece ser uma transação financeira (ex: foto de boleto, conversa solta), retorne {status: "not_transacao", motivo: "..."}.

DEVOLVA APENAS JSON, sem markdown:
{
  "status": "ok" | "incomplete" | "not_transacao",
  "type": "expense" | "income",
  "amount": 1234.56,
  "description": "...",
  "date": "YYYY-MM-DD",
  "categoria_sugerida": "Receita" | "Alimentação" | "Transporte" | "Moradia" | "Impostos" | "Outros",
  "campos_faltantes": ["..."],
  "pergunta": "string",
  "motivo": "string"
}`;

// ── Helpers ──────────────────────────────────────────────────────

function montarContentBlocks({ texto, imagens, pdf }) {
    const blocks = [];
    if (pdf?.base64) {
        blocks.push({
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: pdf.base64 },
        });
    }
    for (const img of imagens || []) {
        if (!img?.base64) continue;
        blocks.push({
            type: "image",
            source: {
                type: "base64",
                media_type: img.mimetype || "image/jpeg",
                data: img.base64,
            },
        });
    }
    blocks.push({
        type: "text",
        text: texto || "(sem texto — só mídia anexa)",
    });
    return blocks;
}

async function chamarClaude({ systemPrompt, blocks, maxTokens = 512 }) {
    const t0 = Date.now();
    const response = await client.messages.create({
        model: MODEL,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: "user", content: blocks }],
    });
    const latenciaMs = Date.now() - t0;

    let raw = response.content[0].text.trim();
    raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    const data = JSON.parse(raw);
    return { data, latenciaMs };
}

// ── Extractor: boleto ────────────────────────────────────────────

/**
 * Extrai dados de um boleto/fatura pra cadastrar em poupeja_payables.
 *
 * @returns {Promise<{status, entity_name?, description?, amount?, due_date?, numero_boleto?, motivo?, campos_faltantes?, latenciaMs}>}
 */
export async function extrairBoleto({ texto, imagens, pdf }) {
    const blocks = montarContentBlocks({ texto, imagens, pdf });

    try {
        const { data, latenciaMs } = await chamarClaude({
            systemPrompt: BOLETO_SYSTEM_PROMPT,
            blocks,
            maxTokens: 512,
        });
        logger.info(
            { status: data.status, latenciaMs, amount: data.amount, entity: data.entity_name },
            "financeiro-extractor: boleto"
        );
        return { ...data, latenciaMs };
    } catch (err) {
        logger.error({ err: err.message }, "financeiro-extractor: erro extraindo boleto");
        return {
            status: "incomplete",
            campos_faltantes: ["__erro_tecnico__"],
            motivo: err.message,
            latenciaMs: -1,
        };
    }
}

// ── Extractor: transação ────────────────────────────────────────

/**
 * Extrai dados de uma transação já realizada pra cadastrar em poupeja_transactions.
 *
 * @param {Object} args
 * @param {string} args.texto - mensagem ou transcrição
 * @param {Array}  args.imagens - [{base64, mimetype}]
 * @param {Object} args.pdf - {base64}
 * @param {Object} args.empresa - empresa identificada (usado pra detectar income/expense em comprovante)
 */
export async function extrairTransacao({ texto, imagens, pdf, empresa }) {
    const blocks = montarContentBlocks({ texto, imagens, pdf });

    // Injeta nome/CNPJ da empresa no prompt
    const promptContextualizado = TRANSACAO_SYSTEM_PROMPT
        .replace("{NOME_EMPRESA}", empresa?.razao_social || empresa?.nome_fantasia || "empresa")
        .replace("{CNPJ_EMPRESA}", empresa?.cnpj || "—");

    try {
        const { data, latenciaMs } = await chamarClaude({
            systemPrompt: promptContextualizado,
            blocks,
            maxTokens: 512,
        });
        logger.info(
            {
                status: data.status,
                latenciaMs,
                type: data.type,
                amount: data.amount,
                categoria: data.categoria_sugerida,
            },
            "financeiro-extractor: transacao"
        );
        return { ...data, latenciaMs };
    } catch (err) {
        logger.error({ err: err.message }, "financeiro-extractor: erro extraindo transação");
        return {
            status: "incomplete",
            campos_faltantes: ["__erro_tecnico__"],
            pergunta: "😬 Travei processando aqui. Manda de novo ou descreve por texto que eu pego.",
            motivo: err.message,
            latenciaMs: -1,
        };
    }
}

// ── Extractor: extrato bancário ──────────────────────────────────

const EXTRATO_SYSTEM_PROMPT = `Você é especialista em conciliação bancária. A entrada é um extrato bancário (PDF ou imagem).

Extraia TODAS as transações listadas no extrato.

REGRAS DE CLASSIFICAÇÃO (use APENAS estas categorias EXATAS):
- "Receita" — Pix recebido, transferência recebida, depósito, salário
- "Alimentação" — padaria, mercado, supermercado, restaurante, iFood, lanchonete (qualquer nome que indique comida)
- "Transporte" — posto, combustível, Uber, 99, ônibus, gasolina
- "Moradia" — energia, luz, água, internet, aluguel, condomínio, IPTU residencial
- "Impostos" — DARE, DARF, GPS, DAS, IPVA, ICMS
- "Outros" — qualquer outro caso

TIPO (C = crédito/entrada, D = débito/saída):
- Pix RECEBIDO, transferência RECEBIDA → C (Receita)
- Pix ENVIADO, transferência ENVIADA → D
- Valores com sinal "-" → D
- Valores sem sinal → C

NUNCA invente categorias. NUNCA omita transações. Se for um TED/DOC sem nome claro, use "Outros".

FORMATO DE SAÍDA (JSON puro, sem markdown):
{
  "status": "ok" | "not_extrato",
  "motivo": "string se not_extrato",
  "transacoes": [
    {
      "data": "YYYY-MM-DD",
      "descricao": "texto literal do extrato, curto",
      "valor": 1234.56,
      "tipo": "C" | "D",
      "categoria": "Receita" | "Alimentação" | "Transporte" | "Moradia" | "Impostos" | "Outros"
    }
  ]
}

Se a imagem/PDF NÃO for um extrato bancário (ex: é um boleto, comprovante isolado, foto qualquer), retorne status="not_extrato" com motivo.`;

/**
 * Extrai todas as transações de um extrato bancário (PDF ou imagem).
 *
 * @returns {Promise<{status, transacoes?: Array, motivo?, latenciaMs}>}
 */
export async function extrairExtrato({ texto, imagens, pdf }) {
    const blocks = montarContentBlocks({ texto, imagens, pdf });

    try {
        // Extrato pode ter muitas linhas — aumenta max_tokens.
        const { data, latenciaMs } = await chamarClaude({
            systemPrompt: EXTRATO_SYSTEM_PROMPT,
            blocks,
            maxTokens: 4096,
        });
        const qtd = Array.isArray(data.transacoes) ? data.transacoes.length : 0;
        logger.info(
            { status: data.status, latenciaMs, qtd },
            "financeiro-extractor: extrato"
        );
        return { ...data, latenciaMs };
    } catch (err) {
        logger.error({ err: err.message }, "financeiro-extractor: erro extraindo extrato");
        return {
            status: "not_extrato",
            motivo: `Erro técnico: ${err.message}`,
            transacoes: [],
            latenciaMs: -1,
        };
    }
}

export { SUBTIPOS_BOLETO, SUBTIPOS_TRANSACAO };
