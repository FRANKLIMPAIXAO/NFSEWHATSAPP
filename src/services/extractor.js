/**
 * src/services/extractor.js
 * Extrator de campos: texto livre → JSON estruturado de NFS-e via Claude.
 */
import Anthropic from "@anthropic-ai/sdk";
import { EXTRACTOR_SYSTEM_PROMPT } from "../prompts/extractor.js";
import { resolverCep } from "./viacep.js";
import { consultarCnpj } from "./cnpj-lookup.js";
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
                    data.tomador.razao_social =
                        data.tomador.razao_social || dadosCnpj.razao_social;
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
