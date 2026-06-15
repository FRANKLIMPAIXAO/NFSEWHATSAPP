/**
 * src/services/extractor.js
 * Extrator de campos: texto livre → JSON estruturado de NFS-e via Claude.
 */
import Anthropic from "@anthropic-ai/sdk";
import { EXTRACTOR_SYSTEM_PROMPT } from "../prompts/extractor.js";
import { resolverCep } from "./viacep.js";
import { consultarCnpj } from "./cnpj-lookup.js";
import { validarCpf, formatarCpf } from "../utils/cpf.js";
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
 * Extrai campos de NFS-e a partir de texto, imagem(s) e/ou PDF.
 *
 * @param {string|Object} input — pode ser:
 *   - string (compatibilidade): tratado como texto livre
 *   - {texto?: string, imagens?: Array<{base64, mimetype}>, pdf?: {base64}}
 * @param {Object|null} payloadAnterior - extração parcial de conversa anterior
 * @returns {Promise<ExtractionResult>}
 */
export async function extrairCampos(input, payloadAnterior = null) {
    const t0 = Date.now();
    const today = new Date().toISOString().slice(0, 10);
    const hojeBR = new Date().toLocaleDateString("pt-BR", {
        weekday: "long",
        day: "2-digit",
        month: "long",
        year: "numeric",
    });

    // Normaliza input: string vira {texto}
    const { texto, imagens, pdf } =
        typeof input === "string" ? { texto: input } : input || {};

    const temMidia = (imagens && imagens.length) || pdf;
    // Cabeçalho reforçado: sem isso o LLM chuta datas aleatórias quando
    // o usuário não fala data explicitamente (ex: "emite nota pro João,
    // R$ 1500" — sem cabeçalho LLM inventa data_emissao e competencia).
    const cabecalho =
        `DATA DE HOJE: ${today} (${hojeBR})\n` +
        `Use SEMPRE essa data como referência pra data_emissao e competencia. ` +
        `Se o usuário NÃO mencionar data, use ${today}. ` +
        `NUNCA invente data fora desse contexto.`;
    const introTexto = temMidia
        ? "TEXTO/LEGENDA DO USUÁRIO (pode estar vazio se só mandou mídia):"
        : "TEXTO DO USUÁRIO:";

    let userText = `${cabecalho}\n\n${introTexto}\n${texto || "(vazio)"}`;
    if (payloadAnterior) {
        userText =
            `[CONTINUAÇÃO]\n` +
            `${cabecalho}\n\n` +
            `PAYLOAD ANTERIOR (extração parcial):\n` +
            `${JSON.stringify(payloadAnterior, null, 2)}\n\n` +
            `NOVA MENSAGEM DO USUÁRIO (completando o anterior):\n${texto || "(sem texto, ver mídia anexa)"}`;
    }
    if (temMidia) {
        userText +=
            "\n\nO USUÁRIO ANEXOU MÍDIA (imagem(ns) ou PDF). Extraia os dados visíveis " +
            "(orçamento, cartão de visita, proposta, etc.) e combine com o texto se houver.";
    }

    // Monta content blocks pro Anthropic SDK (texto + imagens + pdf)
    const contentBlocks = [];
    if (pdf?.base64) {
        contentBlocks.push({
            type: "document",
            source: {
                type: "base64",
                media_type: "application/pdf",
                data: pdf.base64,
            },
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
            max_tokens: 1024,
            system: EXTRACTOR_SYSTEM_PROMPT,
            messages: [{ role: "user", content: contentBlocks }],
        });

        let raw = response.content[0].text.trim();
        // remove cercas markdown se vierem
        raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");

        const data = JSON.parse(raw);

        // Pós-processamento PJ: se o tomador é pessoa jurídica e tem CNPJ,
        // consulta a BrasilAPI pra obter razão social + endereço completo.
        // Isso elimina a necessidade de o usuário informar endereço pra PJs
        // (basta o CNPJ) e remove dependência de "alucinação" do LLM pros
        // dados cadastrais.
        if (data.tomador?.tipo === "PJ" && data.tomador?.documento) {
            const cnpjLimpo = String(data.tomador.documento).replace(/\D/g, "");
            if (cnpjLimpo.length === 14) {
                const dadosCnpj = await consultarCnpj(cnpjLimpo);
                if (dadosCnpj) {
                    // Receita Federal é a fonte de verdade — SEMPRE sobrescreve
                    // o que o LLM "leu" da imagem, mesmo que ele tenha extraído
                    // um nome diferente (alucinação ou imagem ambígua).
                    data.tomador.razao_social = dadosCnpj.razao_social;
                    data.tomador.endereco = {
                        cep: dadosCnpj.cep,
                        numero: dadosCnpj.numero || "S/N",
                        logradouro: dadosCnpj.logradouro,
                        bairro: dadosCnpj.bairro,
                        municipio: dadosCnpj.municipio,
                        uf: dadosCnpj.uf,
                        ibge: dadosCnpj.ibge,
                        complemento: dadosCnpj.complemento || null,
                    };
                    if (!dadosCnpj.ativa) {
                        data.observacoes =
                            (data.observacoes ? data.observacoes + " | " : "") +
                            `CNPJ situação: ${dadosCnpj.situacao_cadastral}`;
                    }
                    // Garante que campos_faltantes não exija endereço (já temos)
                    data.campos_faltantes = (data.campos_faltantes || []).filter(
                        (c) => c !== "endereco_tomador"
                    );
                    if (data.status === "incomplete" && data.campos_faltantes.length === 0) {
                        data.status = "ok";
                    }
                } else {
                    // CNPJ não encontrado → marca incomplete pra usuário corrigir
                    data.status = "incomplete";
                    data.campos_faltantes = [
                        ...(data.campos_faltantes || []),
                        "cnpj_invalido",
                    ];
                    data.resumo_confirmacao = `CNPJ ${cnpjLimpo} não encontrado na Receita Federal. Pode confirmar o CNPJ?`;
                }
            }
        }

        // Validação de CPF (DV) — pra PF, antes de qualquer chamada externa.
        // Receita não tem API pública de CPF, então só validamos dígito verificador.
        // Pega CPF inventado, digitado errado, ou alucinado pelo LLM ao ler imagem.
        if (data.tomador?.tipo === "PF" && data.tomador?.documento) {
            const cpfLimpo = String(data.tomador.documento).replace(/\D/g, "");
            if (!validarCpf(cpfLimpo)) {
                data.status = "incomplete";
                data.campos_faltantes = [
                    ...(data.campos_faltantes || []),
                    "cpf_invalido",
                ];
                data.resumo_confirmacao =
                    `CPF ${formatarCpf(cpfLimpo)} não é válido (dígito verificador não bate). ` +
                    `Pode confirmar o número do CPF?`;
                logger.warn({ cpf: cpfLimpo }, "cpf_invalido detectado");
                return data;
            }
        }

        // Pós-processamento PF: se o LLM extraiu CEP do tomador, resolve via ViaCEP
        // pra completar logradouro/bairro/município/UF/IBGE de forma confiável
        // (sem depender do LLM "alucinar" esses campos). Se o CEP for inválido,
        // marca como incomplete e devolve mensagem clara pro usuário corrigir.
        if (data.tomador?.tipo !== "PJ" && data.tomador?.documento && data.tomador?.endereco?.cep) {
            const cep = String(data.tomador.endereco.cep).replace(/\D/g, "");
            const dadosCep = await resolverCep(cep);
            if (dadosCep) {
                data.tomador.endereco = {
                    ...data.tomador.endereco,
                    cep: dadosCep.cep,
                    logradouro:
                        data.tomador.endereco.logradouro ||
                        dadosCep.logradouro,
                    bairro: data.tomador.endereco.bairro || dadosCep.bairro,
                    municipio:
                        data.tomador.endereco.municipio || dadosCep.municipio,
                    uf: data.tomador.endereco.uf || dadosCep.uf,
                    ibge: dadosCep.ibge,
                };
            } else {
                // CEP inválido — força conversa pra "aguardando_dados" pedir correção.
                data.status = "incomplete";
                data.campos_faltantes = [
                    ...(data.campos_faltantes || []),
                    "endereco_tomador_cep_invalido",
                ];
                data.resumo_confirmacao = `CEP ${cep} não encontrado. Pode confirmar o CEP do tomador (8 dígitos)?`;
                // limpa campos que o LLM possa ter inventado
                data.tomador.endereco = {
                    cep,
                    numero: data.tomador.endereco.numero || null,
                    logradouro: null,
                    bairro: null,
                    municipio: null,
                    uf: null,
                    ibge: null,
                };
            }
        }

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
