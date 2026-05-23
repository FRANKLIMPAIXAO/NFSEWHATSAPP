/**
 * src/services/focusnfe.js
 * Cliente da API Focus NFe — emissão e consulta de NFS-e.
 *
 * Suporta dois padrões:
 *   - NFS-e Municipal (ABRASF, ISSNet, etc)  — endpoint /v2/nfse   (payload aninhado)
 *   - NFS-e Nacional (LC 214/2025, Reforma)  — endpoint /v2/nfsen  (payload flat, DPS)
 *
 * Escolhe baseado em empresa.usa_nfse_nacional ou env FOCUS_NFE_PADRAO=nacional|municipal.
 *
 * NOTA sobre o nome do endpoint Nacional: a doc pública da Focus em
 * focusnfe.com.br/doc/ menciona "/v2/nfse-nacional" mas isso está errado/
 * desatualizado. O endpoint real em produção é "/v2/nfsen" — confirmado por
 * sondagem direta em 20/05/2026:
 *   GET /v2/nfsen/<ref>          → "Nota fiscal não encontrada" (endpoint existe)
 *   GET /v2/nfse-nacional/<ref>  → "Endpoint não encontrado"    (não existe!)
 *   GET /v2/nfse_nacional/<ref>  → "Endpoint não encontrado"
 *   GET /v2/dps_nacional/<ref>   → "Endpoint não encontrado"
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

// ABRASF v2.04 — ItemListaServico formato varia por município:
//   - Goiânia (5208707): "XX.XX" decimal (Roca "14.01", HC "17.01", Centro Oeste "11.04")
//   - Aparecida (5201405): "XXXX" 4 dígitos SEM ponto. Confirmado pela doc oficial
//     Focus NFe pra Aparecida (23/05/2026): exemplo "item_lista_servico": "0602"
//     https://focusnfe.com.br/guias/nfse/municipios-integrados/aparecida-de-goiania/
function formatarItemABRASF(codigo, codigoMunicipio) {
    const d = String(codigo || "").replace(/\D/g, "").slice(0, 4);
    if (d.length < 3) return d;
    const munNum = Number(codigoMunicipio);
    if (munNum === 5201405) {
        // Aparecida — sem ponto, 4 dígitos puros ("1719" pra contabilidade)
        return d.padEnd(4, "0");
    }
    // Goiânia e demais ABRASF clássicos — formato decimal XX.XX
    return d.slice(0, 2) + "." + d.slice(2).padEnd(2, "0");
}

// ABRASF v2.04 — CodigoTributacaoMunicipio:
//   - Goiânia: 4 dígitos sem ponto (Roca "1401", HC "1701", Centro Oeste "1104")
//   - Aparecida: 7 dígitos (= CNAE). Doc Focus oficial: "codigo_tributario_municipio":
//     "9602502" (= CNAE 9602502 cabeleireiro). Pra PAC contabilidade = "6920601".
function formatarCodTribMunABRASF(codigo, codigoMunicipio) {
    const d = String(codigo || "").replace(/\D/g, "");
    const munNum = Number(codigoMunicipio);
    if (munNum === 5201405) {
        return d.slice(0, 7); // Aparecida — CNAE 7 dígitos
    }
    return d.slice(0, 4); // Goiânia e demais — 4 dígitos
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
        err.statusCode = response.status; // alias usado pelo catch do emissor.js
        err.data = data;
        // err.body é a string raw esperada pelo catch do emissor.js pra
        // detectar "isso veio da SEFAZ, não devo re-throw como erro técnico".
        // Sem isso, qualquer 4xx vira HTTP 500 no api-emit, e o frontend
        // ativa o fallback errado (Edge Function direto pra Nacional).
        err.body = text;
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

    // ItemListaServico: formato varia por município (ver função pra detalhes).
    // Goiânia "17.01" decimal; Aparecida "171901" 6-dígitos CGSN.
    // Fonte: empresa.servico_padrao_lc116 — emissor.js já injetou em codigo_lc116.
    const itemListaServico = formatarItemABRASF(
        servico.codigo_lc116,
        empresa.municipio_codigo
    );

    // CodigoTributacaoMunicipio: formato varia por município (ver função).
    // Goiânia 4 dígitos "1701"; Aparecida 7 dígitos CNAE "6920601".
    const codigoTributarioMunicipio = formatarCodTribMunABRASF(
        servico.codigo_tributario_municipio ||
            empresa.codigo_atividade_municipal ||
            servico.codigo_lc116,
        empresa.municipio_codigo
    );

    // Número e série do RPS:
    // - Aparecida (5201405) exige sequencial (E090) e máx 5 dígitos (E093).
    //   Lê empresa.proximo_numero_rps do Supabase. Após emissão bem-sucedida,
    //   o emissor.js incrementa via UPDATE.
    // - Goiânia (e demais ABRASF clássicos) ainda aceita timestamp longo.
    // - Série RPS: lê de empresa.serie_rps_padrao (coluna serie_rps). Default "1".
    const munNumRps = Number(empresa.municipio_codigo);
    const numeroRps =
        munNumRps === 5201405
            ? Number(empresa.proximo_numero_rps) || 1
            : Math.floor(Date.now() / 1000); // Goiânia e demais
    const serieRps = empresa.serie_rps_padrao || "1";

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
        serie: serieRps,
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

    // codigo_tributacao_municipal_iss: XSD Nacional rev. 17/03/2026 exige
    // EXATAMENTE 3 dígitos (pattern `[0-9]{3}`). Probe Focus em 20/05/2026:
    //   "33:0: ERROR: cTribMun: '6920601' is not accepted by pattern '[0-9]{3}'."
    // Aparecida histórica usa CNAE (7 dígitos) que NÃO bate. Solução: omitir
    // quando o cadastro tiver formato incompatível. Focus aceita ausência
    // (campo "Não obrigatório" pela tabela de-para Focus).
    const codTribMunicipalRaw = String(
        servico.codigo_tributario_municipio ||
            empresa.codigo_atividade_municipal ||
            ""
    ).trim();
    const codTribMunicipal = /^[0-9]{3}$/.test(codTribMunicipalRaw)
        ? codTribMunicipalRaw
        : undefined;

    // Mapeamento Focus NFSe Nacional confirmado em 20/05/2026 via probe:
    //   data_emissao → dhEmi (Focus reconhece esse nome, mesmo que a tabela
    //   de-para tenha coluna B vazia — significa "mesmo nome").
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

    // Endereço do tomador — obrigatório quando cIndOp indica que o ISSQN
    // incide no local do estabelecimento/domicílio do tomador (E0234).
    // Pra Aparecida com cIndOp=100301, é mandatório. Mapeia o objeto
    // `tomador.endereco` que vem do frontend pros nomes Focus snake_case.
    const e = tomador.endereco || {};
    if (e.logradouro) payload.logradouro_tomador = e.logradouro;
    if (e.numero) payload.numero_tomador = e.numero;
    if (e.complemento) payload.complemento_tomador = e.complemento;
    if (e.bairro) payload.bairro_tomador = e.bairro;
    if (e.cep) payload.cep_tomador = String(e.cep).replace(/\D/g, "");
    const cMunTomador = e.codigo_municipio || e.ibge || e.cMun;
    if (cMunTomador) payload.codigo_municipio_tomador = Number(cMunTomador);
    if (e.uf) payload.uf_tomador = e.uf;
    if (tomador.email) payload.email_tomador = tomador.email;
    if (tomador.telefone) payload.telefone_tomador = String(tomador.telefone).replace(/\D/g, "");

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

// PDF válido começa com "%PDF-" (magic bytes). Se vier algo menor que isso
// ou sem o header, é resposta de erro (HTML/JSON pequeno) — útil pra detectar
// race condition quando webhook chega antes da Focus terminar de gerar o PDF.
function ehPdfValido(buffer) {
    if (!buffer || buffer.length < 100) return false;
    const header = buffer.subarray(0, 5).toString("ascii");
    return header === "%PDF-";
}

async function fetchPdfBuffer(url, headers) {
    const response = await fetch(url, { headers });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
}

/**
 * Baixa PDF da NFS-e. Tenta primeiro a URL S3 do payload (se vier do webhook
 * já assinada, é caminho direto). Se não tiver, ou se vier inválido, cai pro
 * endpoint /v2/nfse/<ref>.pdf da Focus.
 *
 * Race condition conhecida: webhook chega ~1s antes da Focus terminar de
 * gerar o PDF. Faz até 3 tentativas com backoff (2s/4s/8s) validando magic
 * bytes "%PDF-" antes de aceitar.
 */
export async function baixarPdf(referencia, focusToken, empresa, urlPayload) {
    const basePath = basePathPara(resolverPadrao(empresa));
    const urlFocus = `${BASE_URL}${basePath}/${encodeURIComponent(referencia)}.pdf`;
    const auth = Buffer.from(`${focusToken}:`).toString("base64");
    const authHeaders = { Authorization: `Basic ${auth}` };

    const tentativas = [
        { url: urlPayload, headers: {}, label: "url_payload" },
        { url: urlFocus, headers: authHeaders, label: "focus_pdf_endpoint" },
    ].filter((t) => !!t.url);

    let ultimoErro = null;
    for (let i = 0; i < 3; i++) {
        for (const tent of tentativas) {
            try {
                const buf = await fetchPdfBuffer(tent.url, tent.headers);
                if (ehPdfValido(buf)) {
                    logger.info(
                        { referencia, tamanho: buf.length, origem: tent.label, tentativa: i + 1 },
                        "PDF baixado e validado"
                    );
                    return buf;
                }
                logger.warn(
                    { referencia, tamanho: buf.length, origem: tent.label, tentativa: i + 1 },
                    "PDF inválido (sem magic bytes), tentando próxima fonte/retry"
                );
            } catch (err) {
                ultimoErro = err;
                logger.warn(
                    { referencia, origem: tent.label, tentativa: i + 1, err: err.message },
                    "falha baixando PDF, tentando próxima fonte/retry"
                );
            }
        }
        // backoff exponencial entre rodadas: 2s, 4s
        if (i < 2) await new Promise((r) => setTimeout(r, 2000 * (i + 1) * (i + 1)));
    }
    throw new Error(
        `Falha ao baixar PDF após 3 tentativas: ${ultimoErro?.message || "PDF inválido"}`
    );
}
