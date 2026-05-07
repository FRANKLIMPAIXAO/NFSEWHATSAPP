/**
 * src/services/cnpj-lookup.js
 *
 * Resolve um CNPJ em dados completos da empresa (razão social + endereço
 * + IBGE) usando a API pública BrasilAPI. Usado pra completar dados de
 * tomadores PJ extraídos do WhatsApp — usuário só precisa informar o CNPJ.
 *
 * API: https://brasilapi.com.br/api/cnpj/v1/{cnpj}
 * Gratuita, sem auth, sem rate limit declarado.
 */
import { logger } from "../utils/logger.js";

const BRASILAPI_BASE = "https://brasilapi.com.br/api/cnpj/v1";

/**
 * @param {string} cnpj — 14 dígitos (aceita com pontos/barras, normaliza)
 * @returns {Promise<Object|null>} dados da empresa ou null se inválido/não encontrado
 *
 * Retorno (sucesso):
 * {
 *   cnpj, razao_social, nome_fantasia,
 *   logradouro, numero, complemento, bairro,
 *   municipio, uf, cep, ibge,
 *   situacao_cadastral, ativa: boolean
 * }
 */
export async function consultarCnpj(cnpj) {
    if (!cnpj) return null;
    const limpo = String(cnpj).replace(/\D/g, "");
    if (limpo.length !== 14) {
        logger.warn({ cnpj }, "cnpj-lookup: formato inválido");
        return null;
    }

    try {
        const res = await fetch(`${BRASILAPI_BASE}/${limpo}`, {
            headers: {
                "User-Agent": "agent-nfse/1.0 (+contato: paixaoassessoriacontabil@gmail.com)",
                Accept: "application/json",
            },
            signal: AbortSignal.timeout(8000),
        });
        if (res.status === 404) {
            logger.warn({ cnpj: limpo }, "cnpj-lookup: CNPJ não encontrado");
            return null;
        }
        if (!res.ok) {
            logger.warn(
                { cnpj: limpo, status: res.status },
                "cnpj-lookup: erro HTTP"
            );
            return null;
        }
        const data = await res.json();
        const situacao =
            data.descricao_situacao_cadastral || data.situacao_cadastral || "";
        return {
            cnpj: data.cnpj || limpo,
            razao_social: data.razao_social || "",
            nome_fantasia: data.nome_fantasia || "",
            logradouro: data.logradouro || "",
            numero: data.numero || "",
            complemento: data.complemento || "",
            bairro: data.bairro || "",
            municipio: data.municipio || "",
            uf: data.uf || "",
            cep: String(data.cep || "").replace(/\D/g, ""),
            ibge: String(data.codigo_municipio_ibge || ""),
            situacao_cadastral: situacao,
            ativa: situacao.toUpperCase() === "ATIVA",
        };
    } catch (err) {
        logger.error({ cnpj, err: err.message }, "cnpj-lookup: falha na consulta");
        return null;
    }
}
