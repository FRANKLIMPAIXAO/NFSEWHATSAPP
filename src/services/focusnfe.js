/**
 * src/services/focusnfe.js
 * Cliente da API Focus NFe — emissão e consulta de NFS-e.
 *
 * Suporta dois padrões:
 *   - NFS-e Municipal (ABRASF, ISSNet, etc) — endpoint /v2/nfse  (payload aninhado)
 *   - NFS-e Nacional (padrão unificado CGSN/União) — endpoint /v2/nfsen (payload flat, DPS)
 *
 * Escolhe baseado em empresa.usa_nfse_nacional ou env FOCUS_NFE_PADRAO=nacional|municipal.
 */
import { logger } from "../utils/logger.js";

const ENV = process.env.FOCUS_NFE_ENV || "homologacao";
const PADRAO_DEFAULT = process.env.FOCUS_NFE_PADRAO || "nacional";
const BASE_URL =
    ENV === "producao"
        ? process.env.FOCUS_NFE_BASE_URL_PRODUCAO || "https://api.focusnfe.com.br"
        : process.env.FOCUS_NFE_BASE_URL_HOMOLOGACAO ||
          "https://homologacao.focusnfe.com.br";

function resolverPadrao(empresa) {
    if (empresa && typeof empresa.usa_nfse_nacional !== "undefined") {
        return empresa.usa_nfse_nacional ? "nacional" : "municipal";
    }
    return PADRAO_DEFAULT;
}

function basePathPara(padrao) {
    return padrao === "nacional" ? "/v2/nfsen" : "/v2/nfse";
}

// "14.01" → "140100" | "1401" → "140100" | "14.01.00" → "140100"
function codigoServico6Digitos(codigo) {
    const d = String(codigo || "").replace(/\D/g, "");
    return d.padEnd(6, "0").slice(0, 6);
}

// Data/hora atual em horário de Brasília com TZD -03:00.
// SEFAZ rejeita Z (interpreta como futuro). BRT explícito é seguro.
function agoraBrtIso() {
    const localBrt = new Date(Date.now() - 3 * 60 * 60 * 1000);
    return localBrt.toISOString().slice(0, 19) + "-03:00";
}

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
            `Focus ${response.status}: ${data.mensagem || data.erros?.[0]?.mensagem || text}`
        );
        err.status = response.status;
        err.data = data;
        throw err;
    }

    return data;
}

function montarPayloadMunicipal({ referencia, empresa, tomador, servico, competencia }) {
    let inscricaoMunicipal = empresa.inscricao_municipal || null;
    if (!inscricaoMunicipal && empresa.endereco_json) {
        try {
            const e = JSON.parse(empresa.endereco_json);
            if (e.inscricao_municipal) inscricaoMunicipal = e.inscricao_municipal;
        } catch {}
    }

    const optanteSimples = empresa.regime === "simples_nacional";
    const aliquotaServico = Number(empresa.aliquota_iss) || 0;

    return {
        data_emissao: agoraBrtIso(),
        natureza_operacao: 1,
        optante_simples_nacional: optanteSimples,
        incentivador_cultural: false,
        regime_especial_tributacao: optanteSimples ? 6 : undefined,
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
            aliquota: aliquotaServico,
            discriminacao: servico.descricao,
            iss_retido: false,
            item_lista_servico: codigoServico6Digitos(servico.codigo_lc116),
            codigo_tributario_municipio:
                servico.codigo_tributario_municipio || undefined,
            codigo_municipio: empresa.municipio_codigo,
            valor_servicos: servico.valor_total,
            // Campos federais — zerados pro Simples Nacional (tributos saem via DAS).
            valor_pis: 0,
            valor_cofins: 0,
            valor_inss: 0,
            valor_ir: 0,
            valor_csll: 0,
            outras_retencoes: 0,
            desconto_incondicionado: 0,
            desconto_condicionado: 0,
            // Lei da Transparência (gera <totTrib> no XML padrão Nacional).
            // Pra Simples Nacional, estimativa IBPT ~6% (faixa típica ME/EPP serviços).
            percentual_total_tributos: optanteSimples ? 6.0 : 0,
            fonte_total_tributos: "IBPT",
            // Reforma Tributária — campos IBS/CBS (gera <gIBSCBS> no XML).
            // Pra Simples Nacional: CST=200, cClassTrib=200052 (referência XML
            // real de empresa do nicho). Alíquotas zeradas porque tributos
            // continuam via DAS no Simples.
            codigo_indicador_operacao: empresa.cind_op_padrao || "030101",
            ibs_cbs_situacao_tributaria: optanteSimples ? "200" : undefined,
            ibs_cbs_classificacao_tributaria: optanteSimples
                ? "200052"
                : undefined,
            ibs_cbs_base_calculo: servico.valor_total,
            ibs_uf_aliquota: 0,
            ibs_mun_aliquota: 0,
            cbs_aliquota: 0,
            ibs_uf_valor: 0,
            ibs_mun_valor: 0,
            cbs_valor: 0,
            codigo_nbs: empresa.codigo_nbs_padrao || undefined,
        },
    };
}

function montarPayloadNacional({ empresa, tomador, servico, competencia }) {
    const optanteSimples = empresa.regime === "simples_nacional";

    // codigo_tributacao_nacional_iss: 6 dígitos da Tabela CGSN (NFS-e Nacional).
    // Para LC 14.01 (manutenção/reparação de veículos) → 140100.
    const codTribNacional = Number(
        codigoServico6Digitos(
            servico.codigo_tributacao_nacional ||
                empresa.codigo_tributacao_nacional ||
                servico.codigo_lc116
        )
    );

    // Numero DPS único na faixa 1..999999999999999 (15 dígitos). Usamos timestamp em segundos.
    const numeroDps = Math.floor(Date.now() / 1000);

    const dataEmissao = agoraBrtIso();

    const payload = {
        data_emissao: dataEmissao,
        serie_dps: 1,
        numero_dps: numeroDps,
        data_competencia: competencia,
        emitente_dps: "1", // Prestador
        codigo_municipio_emissora: Number(empresa.municipio_codigo),
        cnpj_prestador: empresa.cnpj,
        inscricao_municipal_prestador: empresa.inscricao_municipal || undefined,
        razao_social_prestador: empresa.razao_social || undefined,
        codigo_opcao_simples_nacional: optanteSimples ? "3" : "1", // 3=ME/EPP, 1=Não optante
        regime_especial_tributacao: "0", // Nenhum
        codigo_municipio_prestacao: Number(empresa.municipio_codigo),
        codigo_tributacao_nacional_iss: Number(codTribNacional),
        descricao_servico: servico.descricao,
        valor_servico: Number(servico.valor_total),
        tributacao_iss: "1", // Operação tributável
        tipo_retencao_iss: "1", // Não Retido
        indicador_total_tributacao: "0",
        // Reforma Tributária (LC 214/2025)
        finalidade_emissao: "0", // NFS-e regular
        consumidor_final: tomador.tipo === "PF" ? "1" : "0",
        indicador_destinatario: "0", // tomador = destinatário
    };

    if (tomador.tipo === "PJ") {
        payload.cnpj_tomador = tomador.documento;
    } else {
        payload.cpf_tomador = tomador.documento;
    }
    payload.razao_social_tomador = tomador.razao_social;

    return payload;
}

/**
 * Emite NFS-e na Focus NFe (escolhe padrão automaticamente).
 *
 * @param {Object} params
 * @param {string} params.referencia
 * @param {Object} params.empresa
 * @param {Object} params.tomador {tipo, documento, razao_social}
 * @param {Object} params.servico {descricao, codigo_lc116, valor_total, codigo_tributacao_nacional?}
 * @param {string} params.competencia AAAA-MM-DD
 */
export async function emitirNFSe(params) {
    const { referencia, empresa } = params;
    const padrao = resolverPadrao(empresa);
    const basePath = basePathPara(padrao);

    const payload =
        padrao === "nacional"
            ? montarPayloadNacional(params)
            : montarPayloadMunicipal(params);

    logger.info(
        { referencia, valor: params.servico.valor_total, env: ENV, padrao },
        "emitindo NFS-e na Focus"
    );

    const t0 = Date.now();
    const result = await focusFetch(
        "POST",
        `${basePath}?ref=${encodeURIComponent(referencia)}`,
        empresa.focus_token,
        payload
    );
    logger.info(
        { referencia, duration_ms: Date.now() - t0, status: result.status, padrao },
        "Focus respondeu"
    );

    return { payload, result, padrao };
}

export async function consultarNFSe(referencia, focusToken, empresa) {
    const basePath = basePathPara(resolverPadrao(empresa));
    return focusFetch(
        "GET",
        `${basePath}/${encodeURIComponent(referencia)}`,
        focusToken
    );
}

export async function baixarPdf(referencia, focusToken, empresa) {
    const basePath = basePathPara(resolverPadrao(empresa));
    const url = `${BASE_URL}${basePath}/${encodeURIComponent(referencia)}.pdf`;
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
