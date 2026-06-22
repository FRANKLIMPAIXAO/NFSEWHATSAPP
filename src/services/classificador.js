/**
 * src/services/classificador.js
 * Classificador de intenção: decide o tipo da mensagem antes do extractor de NFS-e.
 *
 * Fluxo:
 *   webhook.js → identifica empresa →
 *   classificarIntencao(input) → switch(intencao) →
 *     emitir_nfse        → extractor + emissor (fluxo atual)
 *     registrar_financeiro → handler/financeiro (proxy n8n por enquanto)
 *     consultar_agenda   → handler/agenda (Supabase poupeja_compromissos)
 *     duvida_geral       → mensagem padrão FAQ
 *
 * Input: mesmo formato do extractor — texto, áudio transcrito, imagem(s), PDF.
 */
import Anthropic from "@anthropic-ai/sdk";
import { CLASSIFICADOR_SYSTEM_PROMPT } from "../prompts/classificador.js";
import { logger } from "../utils/logger.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
// Default Haiku pra classificação — tarefa simples (escolher 1 de 4 categorias),
// rodando em CADA mensagem que chega. Haiku traz ~1s vs ~5s do Sonnet, com
// qualidade indistinguível pra esse caso (validado em prod 09/06/2026:
// classificações de imagem/áudio/texto consistentemente 95-100% de confiança).
// Pode overrride via env ANTHROPIC_MODEL_CLASSIFICADOR pra rodar com Sonnet
// (mais caro mas mesmo resultado).
const MODEL = process.env.ANTHROPIC_MODEL_CLASSIFICADOR
    || "claude-haiku-4-5";

// Categorias válidas (espelha o prompt)
const INTENCOES_VALIDAS = new Set([
    "emitir_nfse",
    "registrar_financeiro",
    "consultar_agenda",
    "relatorio_financeiro",
    "duvida_geral",
]);

// Threshold de confiança — abaixo disso, downgrade pra "duvida_geral"
const CONFIANCA_MINIMA = 0.6;

/**
 * @typedef {Object} ResultadoClassificacao
 * @property {"emitir_nfse"|"registrar_financeiro"|"consultar_agenda"|"duvida_geral"} intencao
 * @property {string} subtipo
 * @property {number} confianca - 0.0 a 1.0
 * @property {string} resumo
 * @property {string} motivo
 * @property {number} latenciaMs - tempo de classificação
 */

/**
 * Classifica a intenção da mensagem do usuário.
 *
 * @param {string|Object} input — pode ser:
 *   - string (texto puro)
 *   - {texto?: string, imagens?: Array<{base64, mimetype}>, pdf?: {base64}}
 * @returns {Promise<ResultadoClassificacao>}
 */
export async function classificarIntencao(input) {
    const t0 = Date.now();

    // Normaliza input
    const { texto, imagens, pdf } =
        typeof input === "string" ? { texto: input } : input || {};

    const temMidia = (imagens && imagens.length) || pdf;

    let userText = `MENSAGEM DO USUÁRIO:\n${texto || "(sem texto — só mídia)"}`;
    if (temMidia) {
        userText += "\n\n(usuário também anexou imagem ou PDF — examine pra decidir a categoria)";
    }

    // Monta content blocks (texto + mídia)
    const contentBlocks = [];
    if (pdf?.base64) {
        contentBlocks.push({
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: pdf.base64 },
        });
    }
    for (const img of imagens || []) {
        if (!img?.base64) continue;
        contentBlocks.push({
            type: "image",
            source: {
                type: "base64",
                media_type: img.mimetype || "image/jpeg",
                data: img.base64,
            },
        });
    }
    contentBlocks.push({ type: "text", text: userText });

    try {
        const response = await client.messages.create({
            model: MODEL,
            max_tokens: 256, // resposta curtinha
            system: CLASSIFICADOR_SYSTEM_PROMPT,
            messages: [{ role: "user", content: contentBlocks }],
        });

        let raw = response.content[0].text.trim();
        // Remove cercas markdown se vierem
        raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");

        const data = JSON.parse(raw);

        // Sanitização — garante que veio o que o prompt mandou
        if (!INTENCOES_VALIDAS.has(data.intencao)) {
            logger.warn({ raw, data }, "classificador: intenção inválida, downgrade pra duvida_geral");
            data.intencao = "duvida_geral";
            data.subtipo = "duvida";
            data.confianca = 0;
            data.motivo = "intenção retornada inválida";
        }
        if (typeof data.confianca !== "number" || data.confianca < 0 || data.confianca > 1) {
            data.confianca = 0;
        }

        // Downgrade por baixa confiança — vamos perguntar ao usuário em vez de chutar
        if (data.intencao !== "duvida_geral" && data.confianca < CONFIANCA_MINIMA) {
            logger.info(
                { intencao_original: data.intencao, confianca: data.confianca },
                "classificador: confiança abaixo do threshold, downgrade pra duvida_geral"
            );
            data._intencao_original = data.intencao;
            data.intencao = "duvida_geral";
            data.subtipo = "duvida";
        }

        const latenciaMs = Date.now() - t0;
        logger.info(
            {
                intencao: data.intencao,
                subtipo: data.subtipo,
                confianca: data.confianca,
                latenciaMs,
                temMidia: !!temMidia,
                tamanhoTexto: (texto || "").length,
            },
            "classificacao concluída"
        );

        return { ...data, latenciaMs };
    } catch (err) {
        // Falha técnica no classificador — NÃO dá pra deixar o fluxo morrer.
        // Fallback: trata como "duvida_geral" e o handler de dúvida vai pedir
        // mais info pro usuário.
        const latenciaMs = Date.now() - t0;
        logger.error(
            { err: err.message, latenciaMs },
            "classificador: erro técnico, fallback pra duvida_geral"
        );
        return {
            intencao: "duvida_geral",
            subtipo: "duvida",
            confianca: 0,
            resumo: "(falha no classificador)",
            motivo: `erro técnico: ${err.message}`,
            latenciaMs,
            _erro: err.message,
        };
    }
}
