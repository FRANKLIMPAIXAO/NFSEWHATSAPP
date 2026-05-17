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
// Default MUNICIPAL (ABRASF v2.04). Estágio Reforma em mai/2026 varia POR
// MUNICÍPIO, não por UF:
//   - Goiânia (5208707) → ABRASF v2.04 puro, SEM IBS/CBS. Comprovado por
//     notas reais HC#15 (22/04), Roca#11 (28/04), Centro Oeste#96 (14/05).
//   - Aparecida (5201405) → JÁ NFS-e Nacional 1.01 com IBS/CBS completo.
//     Comprovado pela nota Pac Inteligência #267 (10/04).
// Empresa pode forçar via empresa.usa_nfse_nacional. Default municipal.
const PADRAO_DEFAULT = process.env.FOCUS_NFE_PADRAO || "municipal";
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

// NFS-e NACIONAL (Aparecida, EPN) — cServTribNac da Tabela CGSN, 6 dígitos puros.
// "14.01" → "140100" | "1401" → "140100" | "171901" → "171901"
function codigoCGSN6Digitos(codigo) {
    const d = String(codigo || "").replace(/\D/g, "");
    return d.padEnd(6, "0").slice(0, 6);
}

// ABRASF v2.04 (Goiânia) — ItemListaServico no formato decimal "XX.XX" (LC 116).
// Comprovado pelas notas reais Roca #11 ("14.01"), HC #15 ("17.01"), Centro
// Oeste #96 ("11.04"). Aceita entrada flexível: "17.01", "1701", "170100".
function formatarItemABRASF(codigo) {
    const d = String(codigo || "").replace(/\D/g, "").slice(0, 4);
    if (d.length < 3) return d;
    return d.slice(0, 2) + "." + d.slice(2).padEnd(2, "0");
}

// ABRASF v2.04 (Goiânia) — CodigoTributacaoMunicipio no formato 4 dígitos sem
// ponto. Notas reais: Roca "1401", HC "1701", Centro Oeste "1104".
function formatarCodTribMunABRASF(codigo) {
    return String(codigo || "").replace(/\D/g, "").slice(0, 4);
}

// XSD Nacional pós-Reforma (sped.fazenda.gov.br/nfse) — cTribMun com pattern
// próprio do município (Aparecida nota #267 usa 7 dígitos "6920601").
function formatarCodTribMunNacional(codigo) {
    return String(codigo || "").replace(/\D/g, "").slice(0, 7);
}

// Normaliza discriminacao removendo acentos/diacríticos e caracteres exóticos.
// Converte tudo pra MAIÚSCULAS — formato dominante nas notas em prod (Roca #11,
// Centro Oeste #96). HC #15 tem misto mas maiúsculas é mais seguro contra
// rejeição XSD em municípios mais restritos.
function normalizarDiscriminacao(texto) {
    if (!texto) return "";
    return String(texto)
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[çÇ]/g, "C")
        .toUpperCase()
        .replace(/[^A-Z0-9&$%()\/+\-.,;:=* ]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
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

// Monta payload Focus pra municípios ainda em ABRASF v2.04 (ex: Goiânia).
// Espelha exatamente o formato das notas reais Roca #11, HC #15, Centro Oeste
// #96 emitidas em prod 2026. SEM campos da Reforma Tributária (IBS/CBS, finNFSe,
// cIndOp, tribFed, totTrib) — esses só valem pro padrão Nacional.
function montarPayloadMunicipal({ referencia, empresa, tomador, servico, competencia }) {
    let inscricaoMunicipal = empresa.inscricao_municipal || null;
    if (!inscricaoMunicipal && empresa.endereco_json) {
        try {
            const end = JSON.parse(empresa.endereco_json) || {};
            inscricaoMunicipal = end.inscricao_municipal || null;
        } catch {}
    }

    const optanteSimples = empresa.regime === "simples_nacional";
    const aliquotaServico = Number(empresa.aliquota_iss) || 0;

    // ItemListaServico: formato decimal "XX.XX" (LC 116). Fonte:
    // empresa.servico_padrao_lc116 — emissor.js já injetou em codigo_lc116.
    const itemListaServico = formatarItemABRASF(servico.codigo_lc116);

    // CodigoTributacaoMunicipio: 4 dígitos (cadastro próprio do município).
    // Notas Goiânia mostram "1701", "1401", "1104".
    const codigoTributarioMunicipio = formatarCodTribMunABRASF(
        servico.codigo_tributario_municipio ||
            empresa.codigo_atividade_municipal ||
            servico.codigo_lc116
    );

    const numeroRps = Math.floor(Date.now() / 1000);

    const tomadorEndereco = tomador.endereco || {};
    const temEnderecoReal = !!(
        tomadorEndereco.logradouro && tomadorEndereco.bairro
    );

    const payload = {
        data_emissao: agoraBrtIso(),
        optante_simples_nacional: optanteSimples,
        incentivador_cultural: false,
        prestador: {
            cnpj: empresa.cnpj,
            // ABRASF v2.04 aceita IM normalmente — notas Goiânia trazem
            // <InscricaoMunicipal> preenchida. Só omitir no padrão Nacional
            // quando município está fora do CNC (regra E0120 do XSD Nacional).
            inscricao_municipal: inscricaoMunicipal || undefined,
            codigo_municipio: empresa.municipio_codigo,
        },
        tomador: {
            cnpj: tomador.tipo === "PJ" ? tomador.documento : undefined,
            cpf: tomador.tipo === "PF" ? tomador.documento : undefined,
            razao_social: tomador.razao_social || "Tomador nao informado",
            email: tomador.email || undefined,
        },
        servico: {
            valor_servicos: servico.valor_total,
            iss_retido: false,
            aliquota: aliquotaServico,
            discriminacao: normalizarDiscriminacao(servico.descricao),
            item_lista_servico: itemListaServico,
            codigo_tributario_municipio: codigoTributarioMunicipio,
            codigo_cnae: empresa.cnae || undefined,
            codigo_municipio: empresa.municipio_codigo,
        },
        numero: numeroRps,
        serie: "1",
    };

    if (temEnderecoReal) {
        payload.tomador.endereco = {
            logradouro: tomadorEndereco.logradouro,
            numero: tomadorEndereco.numero || "SN",
            complemento: tomadorEndereco.complemento || undefined,
            bairro: tomadorEndereco.bairro,
            codigo_municipio:
                tomadorEndereco.codigo_municipio ||
                tomadorEndereco.ibge ||
                empresa.municipio_codigo,
            uf: tomadorEndereco.uf || empresa.uf || "GO",
            cep: (tomadorEndereco.cep || "").replace(/\D/g, "") || undefined,
        };
    }

    if (!optanteSimples) {
        payload.natureza_operacao = 1;
    }

    return payload;
}

function montarPayloadNacional({ empresa, tomador, servico, competencia }) {
    const optanteSimples = empresa.regime === "simples_nacional";

    // codigo_tributacao_nacional_iss: 6 dígitos da Tabela CGSN.
    // Ex: 171901 = Contabilidade (nota Pac #267).
    const codTribNacional = Number(
        codigoCGSN6Digitos(
            servico.codigo_tributacao_nacional ||
                empresa.codigo_tributacao_nacional ||
                servico.codigo_lc116
        )
    );

    // Numero DPS único 1..999999999999999. Timestamp em segundos.
    const numeroDps = Math.floor(Date.now() / 1000);

    const dataEmissao = agoraBrtIso();

    // codigo_tributacao_municipal_iss: padrão próprio do município.
    // Aparecida nota #267 usa 7 dígitos (cTribMun "6920601" = CNAE da
    // prefeitura). Aceita string até 7 dígitos.
    const codTribMunicipal = formatarCodTribMunNacional(
        servico.codigo_tributario_municipio ||
            empresa.codigo_atividade_municipal ||
            ""
    );

    const payload = {
        data_emissao: dataEmissao,
        serie_dps: 1,
        numero_dps: numeroDps,
        data_competencia: competencia,
        emitente_dps: "1", // Prestador
        codigo_municipio_emissora: Number(empresa.municipio_codigo),
        cnpj_prestador: empresa.cnpj,
        // IM só pode ser enviada se município integrado ao CNC NFS-e Nacional.
        // Goiânia/Aparecida hoje (mai/2026) fora do CNC → omitir IM (E0120).
        inscricao_municipal_prestador: empresa.municipio_no_cnc
            ? empresa.inscricao_municipal || undefined
            : undefined,
        razao_social_prestador: empresa.razao_social || undefined,
        codigo_opcao_simples_nacional: optanteSimples ? "3" : "1", // 3=ME/EPP, 1=Não Optante
        // regime_tributario_simples_nacional: 1=federal+municipal via SN (default ME/EPP)
        regime_tributario_simples_nacional: optanteSimples ? "1" : undefined,
        regime_especial_tributacao: "0", // Nenhum (Simples Nacional NÃO é regime especial)
        codigo_municipio_prestacao: Number(empresa.municipio_codigo),
        codigo_tributacao_nacional_iss: Number(codTribNacional),
        codigo_tributacao_municipal_iss: codTribMunicipal || undefined,
        descricao_servico: normalizarDiscriminacao(servico.descricao),
        valor_servico: Number(servico.valor_total),
        tributacao_iss: "1", // 1=Operação Tributável
        tipo_retencao_iss: "1", // 1=Não Retido
        // Reforma Tributária — campos OBRIGATÓRIOS pós-Reforma
        finalidade_emissao: "0", // NFS-e regular
        consumidor_final: tomador.tipo === "PF" ? "1" : "0",
        indicador_destinatario: "0", // tomador = destinatário
        codigo_indicador_operacao: empresa.cind_op_padrao || "030101",
        // IBS/CBS — Simples: CST=200, cClassTrib=200052 (DAS paga à parte)
        ibs_cbs_situacao_tributaria: optanteSimples ? "200" : undefined,
        ibs_cbs_classificacao_tributaria: optanteSimples ? "200052" : undefined,
        // Lei da Transparência (Lei 12.741) — Opção C (Simples Nacional):
        // percentual_total_tributos_simples_nacional. Pra HC consultoria
        // Anexo III, alíquota efetiva ~6% (inicio da faixa).
        percentual_total_tributos_simples_nacional: optanteSimples
            ? Number(empresa.aliquota_iss) || 6
            : undefined,
        codigo_nbs: empresa.codigo_nbs_padrao || undefined,
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
