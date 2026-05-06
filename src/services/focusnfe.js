/**
 * src/services/focusnfe.js
 * Cliente da API Focus NFe — emissão e consulta de NFS-e.
 *
 * Doc oficial: https://focusnfe.com.br/doc/#nfse
 *
 * IMPORTANTE: a Focus NFe usa REFERÊNCIA pra idempotência. Cada emissão
 * precisa de uma referência única (UUID ou similar). Se você reenviar com
 * a mesma referência, ela retorna o status da emissão anterior.
 */
import { logger } from "../utils/logger.js";

const ENV = process.env.FOCUS_NFE_ENV || "homologacao";
const BASE_URL =
    ENV === "producao"
        ? process.env.FOCUS_NFE_BASE_URL_PRODUCAO || "https://api.focusnfe.com.br"
        : process.env.FOCUS_NFE_BASE_URL_HOMOLOGACAO ||
          "https://homologacao.focusnfe.com.br";

/**
 * Faz chamada autenticada à Focus NFe.
 * Auth: HTTP Basic com token como user e senha em branco.
 */
async function focusFetch(method, path, token, body) {
    const url = `${BASE_URL}${path}`;
    const auth = Buffer.from(`${token}:`).toString("base64");

    const response = await fetch(url, {
        method,
        headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
    });

    const text = await response.text();
    let data;
    try {
        data = text ? JSON.parse(text) : {};
    } catch {
        data = { raw: text };
    }

    if (!response.ok) {
        const err = new Error(
            `Focus ${response.status}: ${data.mensagem || text}`
        );
        err.status = response.status;
        err.data = data;
        throw err;
    }

    return data;
}

/**
 * Emite NFS-e na Focus NFe.
 *
 * @param {Object} params
 * @param {string} params.referencia - identificador único da nota
 * @param {Object} params.empresa - empresa cadastrada (prestador)
 * @param {Object} params.tomador - {tipo, documento, razao_social}
 * @param {Object} params.servico - {descricao, codigo_lc116, valor_total}
 * @param {string} params.competencia - YYYY-MM-DD
 * @returns {Promise<Object>} resposta da Focus
 */
export async function emitirNFSe({
    referencia,
    empresa,
    tomador,
    servico,
    competencia,
}) {
    // Monta payload no schema da Focus NFe NFS-e
    // Doc: https://focusnfe.com.br/doc/#emissao-de-nfse
    let inscricaoMunicipal = empresa.inscricao_municipal || null;
    if (!inscricaoMunicipal && empresa.endereco_json) {
        try {
            const e = JSON.parse(empresa.endereco_json);
            if (e.inscricao_municipal) inscricaoMunicipal = e.inscricao_municipal;
        } catch {}
    }

    const payload = {
        data_emissao: `${competencia}T12:00:00`,
        prestador: {
            cnpj: empresa.cnpj,
            inscricao_municipal: inscricaoMunicipal || undefined,
            codigo_municipio: empresa.municipio_codigo,
        },
        tomador: {
            cnpj: tomador.tipo === "PJ" ? tomador.documento : undefined,
            cpf: tomador.tipo === "PF" ? tomador.documento : undefined,
            razao_social: tomador.razao_social,
        },
        servico: {
            aliquota: empresa.aliquota_iss,
            discriminacao: servico.descricao,
            iss_retido: false,
            item_lista_servico: servico.codigo_lc116,
            codigo_tributario_municipio:
                servico.codigo_tributario_municipio || undefined,
            valor_servicos: servico.valor_total,
        },
    };

    logger.info(
        { referencia, valor: servico.valor_total, env: ENV },
        "emitindo NFS-e na Focus"
    );

    const t0 = Date.now();
    const result = await focusFetch(
        "POST",
        `/v2/nfse?ref=${encodeURIComponent(referencia)}`,
        empresa.focus_token,
        payload
    );
    logger.info(
        { referencia, duration_ms: Date.now() - t0, status: result.status },
        "Focus respondeu"
    );

    return { payload, result };
}

/**
 * Consulta status de NFS-e emitida.
 * Necessário porque a emissão é assíncrona — você emite e depois consulta.
 */
export async function consultarNFSe(referencia, focusToken) {
    return focusFetch(
        "GET",
        `/v2/nfse/${encodeURIComponent(referencia)}`,
        focusToken
    );
}

/**
 * Baixa PDF (DANFSE) da nota emitida.
 * Retorna Buffer com o conteúdo binário.
 */
export async function baixarPdf(referencia, focusToken) {
    const url = `${BASE_URL}/v2/nfse/${encodeURIComponent(referencia)}.pdf`;
    const auth = Buffer.from(`${focusToken}:`).toString("base64");
    const response = await fetch(url, {
        headers: { Authorization: `Basic ${auth}` },
    });
    if (!response.ok) {
        throw new Error(`Falha ao baixar PDF: HTTP ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer;
}
