/**
 * src/services/extractor.js
 * Extrator de campos: texto livre → JSON estruturado de NFS-e via Claude.
 */
import Anthropic from "@anthropic-ai/sdk";
import { EXTRACTOR_SYSTEM_PROMPT } from "../prompts/extractor.js";
import { logger } from "../utils/logger.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";

/**
 * @typedef {Object} ExtractionResult
 * @property {"ok"|"incomplete"|"ambiguous"} status
 * @property {Object|null} tomador
 * @property {Object|null} servico
 * @property {string} competencia
 * @property {string|null} observacoes
 * @property {string[]} campos_faltantes
 * @property {string[]} ambiguidades
 * @property {string} resumo_confirmacao
 */

/**
 * Extrai campos de NFS-e do texto.
 * @param {string} texto - texto livre (transcrição do áudio)
 * @param {Object|null} payloadAnterior - extração parcial de conversa anterior (pra retomada)
 * @returns {Promise<ExtractionResult>}
 */
export async function extrairCampos(texto, payloadAnterior = null) {
    const t0 = Date.now();
    const today = new Date().toISOString().slice(0, 10);

    let userContent = `DATA DE HOJE: ${today}\n\nTEXTO DO ÁUDIO:\n${texto}`;
    if (payloadAnterior) {
        userContent =
            `[CONTINUAÇÃO]\n` +
            `DATA DE HOJE: ${today}\n\n` +
            `PAYLOAD ANTERIOR (extração parcial):\n` +
            `${JSON.stringify(payloadAnterior, null, 2)}\n\n` +
            `NOVO TEXTO DO USUÁRIO (completando o anterior):\n${texto}`;
    }

    try {
        const response = await client.messages.create({
            model: MODEL,
            max_tokens: 1024,
            system: EXTRACTOR_SYSTEM_PROMPT,
            messages: [{ role: "user", content: userContent }],
        });

        let raw = response.content[0].text.trim();
        // remove cercas markdown se vierem
        raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");

        const data = JSON.parse(raw);
        logger.info(
            {
                duration_ms: Date.now() - t0,
                status: data.status,
                input_tokens: response.usage?.input_tokens,
                output_tokens: response.usage?.output_tokens,
            },
            "extracao concluida"
        );
        return data;
    } catch (err) {
        logger.error({ err: err.message }, "erro na extração");
        throw new Error(`Extrator falhou: ${err.message}`);
    }
}
