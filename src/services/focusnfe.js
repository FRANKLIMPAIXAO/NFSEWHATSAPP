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
// Default MUNICIPAL (ABRASF/IssNet) — esmagadora maioria dos municípios em
// 2026 ainda usa ISSNet próprio (Goiânia, Aparecida, etc). Só sobrescrever
// pra "nacional" se o município confirmadamente está parametrizado pro EPN
// da União (consultar nfse.gov.br). Empresa pode forçar via empresa.usa_nfse_nacional.
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

// Código do serviço NACIONAL (DPS) — 6 dígitos: 2 Item + 2 Subitem + 2 Desdobro
// Nacional. cServTribNac do XSD Nacional exige 6 dígitos puros (Tabela CGSN).
// "14.01" → "140100" | "1401" → "140100" | "171901" → "171901"
function codigoServico6Digitos(codigo) {
    const d = String(codigo || "").replace(/\D/g, "");
    return d.padEnd(6, "0").slice(0, 6);
}

// IMPORTANTE — Focus API vs XML final:
// O JSON enviado pra Focus usa 6 DÍGITOS no item_lista_servico ("170100"),
// e a Focus converte pra "X.XX" string ("17.01") no XML final pra Goiânia.
// XMLs reais (HC #15, Roca #11, CO #96) mostram "17.01" no <ItemListaServico>
// mas isso é o output da Focus, não o input. Mensagem 422 da Focus quando
// recebe "X.XX": "código composto por 6 dígitos numéricos". Reusa
// codigoServico6Digitos definido acima.

// cTribMun: XSD Nacional pós-Reforma (namespace sped.fazenda.gov.br/nfse)
// exige EXATAMENTE 3 dígitos (pattern [0-9]{3}). Goiânia migrou pra esse
// formato em prod 2026, mesmo emitindo via IssNet — Focus converte. XMLs
// antigos (ABRASF 2.04) tinham 4 dig — não mais aceitos.
// HC cadastrada com "1701" → enviamos "170" (Item LC 116 17 + dígito 0).
function codigoTribMun3Digitos(codigo) {
    return String(codigo || "").replace(/\D/g, "").slice(0, 3);
}

// Normaliza discriminacao pro charset aceito pelo ABRASF de Goiânia (XSD
// nfse_gyn_v02.xsd): "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789&$%()/+-.,;:=* ".
// Sem acentos, sem ç, sem minúsculas. Quebra de linha vira espaço.
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

function montarPayloadMunicipal({ referencia, empresa, tomador, servico, competencia }) {
    let inscricaoMunicipal = empresa.inscricao_municipal || null;
    let enderecoEmpresa = {};
    if (empresa.endereco_json) {
        try {
            enderecoEmpresa = JSON.parse(empresa.endereco_json) || {};
            if (!inscricaoMunicipal && enderecoEmpresa.inscricao_municipal) {
                inscricaoMunicipal = enderecoEmpresa.inscricao_municipal;
            }
        } catch {}
    }

    const optanteSimples = empresa.regime === "simples_nacional";
    const aliquotaServico = Number(empresa.aliquota_iss) || 0;

    // item_lista_servico: 6 dígitos no JSON pra Focus aceitar pre-validation.
    // Fonte: empresa.servico_padrao_lc116 (cadastrado no Pac) — emissor.js
    // já injeta no servico.codigo_lc116. Extractor LLM não é fonte confiável.
    const itemListaServico = codigoServico6Digitos(servico.codigo_lc116);

    // cTribMun: 3 dígitos exatos (XSD Nacional pós-Reforma pattern [0-9]{3}).
    // Trunca o que vier (cadastro municipal "1701" → "170").
    const codigoTributarioMunicipio = codigoTribMun3Digitos(
        servico.codigo_tributario_municipio ||
            empresa.codigo_atividade_municipal ||
            itemListaServico
    );

    const numeroRps = Math.floor(Date.now() / 1000);

    const tomadorEndereco = tomador.endereco || {};
    const temEnderecoReal = !!(
        tomadorEndereco.logradouro && tomadorEndereco.bairro
    );

    const payload = {
        data_emissao: agoraBrtIso(),
        // optante_simples_nacional: XMLs reais Goiânia têm <OptanteSimplesNacional>1</...>
        optante_simples_nacional: optanteSimples,
        // incentivador_cultural false → <IncentivoFiscal>2</IncentivoFiscal> (Não).
        // Visto em todos os XMLs reais Goiânia.
        incentivador_cultural: false,
        // regime_especial_tributacao 6 = Microempresa Municipal (cobre Simples).
        // Doc Focus pra Goiânia inclui esse campo. Sem ele, Focus mandava
        // opSimpNac=2 (Não optante) no DPS pós-Reforma → SEFAZ E0160.
        regime_especial_tributacao: optanteSimples ? 6 : undefined,
        // codigo_opcao_simples_nacional: "3" = ME/EPP. Reforço pro XSD Nacional
        // pós-Reforma mapear opSimpNac corretamente (3=optante ME/EPP).
        codigo_opcao_simples_nacional: optanteSimples ? "3" : "1",
        prestador: {
            cnpj: empresa.cnpj,
            // IM só pode ser enviada se município está integrado ao CNC NFS-e
            // Nacional. Caso contrário SEFAZ retorna E0120 ("IM do prestador
            // não deve ser informado"). Goiânia/Aparecida hoje (mai/2026)
            // estão FORA do CNC — empresa.municipio_no_cnc=false → omite IM.
            inscricao_municipal: empresa.municipio_no_cnc
                ? inscricaoMunicipal || undefined
                : undefined,
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
            // iss_retido false → <IssRetido>2</IssRetido> (Não retido).
            // Também resolve XSD pós-Reforma exigindo <tribMun><tpRetISSQN>.
            iss_retido: false,
            aliquota: aliquotaServico,
            discriminacao: normalizarDiscriminacao(servico.descricao),
            item_lista_servico: itemListaServico,
            codigo_tributario_municipio: codigoTributarioMunicipio,
            // CodigoCnae visto em todos os XMLs reais Goiânia (HC #15=8211300,
            // Roca #11=3314799, Centro Oeste #96=5212500). Vem do cadastro.
            codigo_cnae: empresa.cnae || undefined,
            codigo_municipio: empresa.municipio_codigo,
            // Lei da Transparência (Lei 12.741) — XSD Nacional pós-Reforma
            // exige <trib> com <tribFed> ou <totTrib>. Doc Focus oficial
            // tem apenas 2 campos: percentual_total_tributos + fonte.
            // Simples Nacional paga DAS à parte — 0% informativo é aceito.
            percentual_total_tributos: 0,
            fonte_total_tributos: "IBPT",
        },
        numero: numeroRps,
        serie: "1",
    };

    // Goiânia ABRASF v02: pra tomador PF sem endereço, NÃO enviar bloco
    // <Endereco> (doc oficial XSD). Pra PJ ou PF com endereço completo, envia.
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

    // Pra Simples Nacional NÃO enviar natureza_operacao (Base44 explícito:
    // enviar quebra validação XSD exigindo <trib><tribFed>/<totTrib>).
    if (!optanteSimples) {
        payload.natureza_operacao = 1;
    }

    return payload;
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
        // regime_tributario_simples_nacional (regApTribSN):
        // 1 = tributos federais E municipal pelo SN (default pra ME/EPP)
        regime_tributario_simples_nacional: optanteSimples ? "1" : undefined,
        regime_especial_tributacao: "0", // Nenhum
        codigo_municipio_prestacao: Number(empresa.municipio_codigo),
        codigo_tributacao_nacional_iss: Number(codTribNacional),
        descricao_servico: servico.descricao,
        valor_servico: Number(servico.valor_total),
        tributacao_iss: "1", // Operação tributável
        tipo_retencao_iss: "1", // Não Retido
        indicador_total_tributacao: "0",
        // Reforma Tributária (LC 214/2025) — campos OBRIGATÓRIOS
        finalidade_emissao: "0", // NFS-e regular
        consumidor_final: tomador.tipo === "PF" ? "1" : "0",
        indicador_destinatario: "0", // tomador = destinatário
        // Bloco IBS/CBS — obrigatório no XSD pós-Reforma (mesmo Simples Nacional).
        // Simples: CST=200, cClassTrib=200052 (referência XML real de empresa
        // do nicho. Tributos saem via DAS, então alíquotas/valores zerados).
        codigo_indicador_operacao: empresa.cind_op_padrao || "030101",
        ibs_cbs_situacao_tributaria: optanteSimples ? "200" : undefined,
        ibs_cbs_classificacao_tributaria: optanteSimples
            ? "200052"
            : undefined,
        // Pra Simples Nacional, indicador_total_tributacao="0" (default) +
        // optante_simples_nacional=true devem fazer Focus pular o <totTrib>
        // ou gerar formato vazio. Campos pTotTribSN/percentual_total_tributos
        // estavam gerando XML invalido (elemento em posicao errada).
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
