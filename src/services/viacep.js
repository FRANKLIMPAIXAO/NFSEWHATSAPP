/**
 * src/services/viacep.js
 * Resolve um CEP em endereço completo (logradouro, bairro, município, UF, IBGE)
 * usando a API pública ViaCEP. Usado pra completar endereços de tomadores
 * extraídos do WhatsApp — usuário só precisa informar CEP + número.
 *
 * API: https://viacep.com.br/ws/{cep}/json/
 */
import { logger } from "../utils/logger.js";

const VIACEP_BASE = "https://viacep.com.br/ws";

/**
 * @param {string} cep — 8 dígitos sem hífen (aceita com hífen, normaliza)
 * @returns {Promise<Object|null>} { cep, logradouro, bairro, municipio, uf, ibge } ou null se inválido
 */
export async function resolverCep(cep) {
    if (!cep) return null;
    const limpo = String(cep).replace(/\D/g, "");
    if (limpo.length !== 8) {
        logger.warn({ cep }, "viacep: CEP com formato inválido");
        return null;
    }

    try {
        const res = await fetch(`${VIACEP_BASE}/${limpo}/json/`, {
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) {
            logger.warn({ cep: limpo, status: res.status }, "viacep: erro HTTP");
            return null;
        }
        const data = await res.json();
        if (data.erro) {
            logger.warn({ cep: limpo }, "viacep: CEP não encontrado");
            return null;
        }
        return {
            cep: limpo,
            logradouro: data.logradouro || "",
            bairro: data.bairro || "",
            municipio: data.localidade || "",
            uf: data.uf || "",
            ibge: data.ibge || "",
        };
    } catch (err) {
        logger.error({ cep, err: err.message }, "viacep: falha na consulta");
        return null;
    }
}
