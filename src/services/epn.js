/**
 * src/services/epn.js
 * Cliente do Emissor Público Nacional NFS-e (SEFIN/União).
 * Wrapper fino sobre a lib `nfse-nacional` (npm).
 */
import {
    ContribuinteService,
    TipoAmbiente,
    EmitenteDPS,
    OpcaoSimplesNacional,
    RegimeEspecialTributacao,
    TributacaoIssqn,
    TipoRetencaoIssqn,
    generateDpsId,
    generateNumDps,
    formatDhEmissao,
    formatDataCompetencia,
} from "nfse-nacional";
import { logger } from "../utils/logger.js";

function ambienteAtual() {
    return process.env.EPN_AMBIENTE === "producao"
        ? TipoAmbiente.Producao
        : TipoAmbiente.Homologacao;
}

function buildContext(empresa) {
    return {
        ambiente: ambienteAtual(),
        certificatePath: empresa.cert_pfx_path,
        certificatePassword: empresa.cert_pfx_password,
        codigoMunicipio: empresa.municipio_codigo,
    };
}

/**
 * Monta o endereço do prestador (enderNac) a partir do que está cadastrado
 * em `empresa`. Devolve undefined se faltar IBGE — sem cMun o XSD rejeita.
 */
function prestadorEnderecoFromEmpresa(empresa) {
    if (!empresa.municipio_codigo) return undefined;
    let endJson = {};
    if (empresa.endereco_json) {
        try {
            endJson = JSON.parse(empresa.endereco_json);
        } catch {
            endJson = {};
        }
    }
    return {
        xLgr: endJson.logradouro || "",
        nro: endJson.numero || "S/N",
        ...(endJson.complemento && { xCpl: endJson.complemento }),
        xBairro: endJson.bairro || "",
        cMun: empresa.municipio_codigo,
        uf: empresa.uf || "",
        cep: String(endJson.cep || "").replace(/\D/g, ""),
    };
}

/**
 * Emite NFS-e via API direta da SEFIN Nacional.
 *
 * @param {Object} params
 * @param {Object} params.empresa - empresa cadastrada (precisa de cert_pfx_path/_password)
 * @param {Object} params.tomador - {tipo:'PF'|'PJ', documento, razao_social, endereco}
 *   endereco: {cMun, cep, xLgr, nro, xBairro}
 * @param {Object} params.servico - {descricao, codigo_servico_nacional, codigo_nbs?, valor_total}
 * @param {string} params.competencia - YYYY-MM-DD
 */
export async function emitirEpn({ empresa, tomador, servico, competencia }) {
    const ambiente = ambienteAtual();
    const ctx = buildContext(empresa);
    const numeroDps = generateNumDps();
    const optante = empresa.regime === "simples_nacional";

    const dps = {
        infDps: {
            id: generateDpsId(empresa.cnpj, empresa.municipio_codigo, "001", numeroDps),
            tipoAmbiente: ambiente,
            dataEmissao: formatDhEmissao(new Date(), -3),
            numeroDps,
            serie: "001",
            dataCompetencia: competencia
                ? competencia
                : formatDataCompetencia(),
            tipoEmitente: EmitenteDPS.Prestador,
            codigoLocalEmissao: empresa.municipio_codigo,

            prestador: {
                cnpj: empresa.cnpj,
                ...(empresa.inscricao_municipal && {
                    inscricaoMunicipal: empresa.inscricao_municipal,
                }),
                nome: empresa.razao_social,
                ...(prestadorEnderecoFromEmpresa(empresa) && {
                    endereco: prestadorEnderecoFromEmpresa(empresa),
                }),
                regimeTributario: {
                    // opSimpNac: 1=Não Optante | 2=MEI | 3=ME/EPP optante (XSD).
                    opSimpNac: optante
                        ? empresa.regime === "mei"
                            ? 2
                            : 3
                        : 1,
                    // regApurSN obrigatório pra ME/EPP (opSimpNac=3):
                    //  1=tributos federais e municipal pelo SN
                    //  2=federais pelo SN, ISSQN por fora
                    //  3=tudo por fora do SN
                    ...(optante && empresa.regime !== "mei"
                        ? { regApurSN: 1 }
                        : {}),
                    regEspTrib: RegimeEspecialTributacao.Nenhum,
                },
            },

            tomador: {
                [tomador.tipo === "PJ" ? "cnpj" : "cpf"]: tomador.documento,
                nome: tomador.razao_social,
                endereco: tomador.endereco
                    ? {
                          xLgr: tomador.endereco.logradouro,
                          nro: tomador.endereco.numero || "S/N",
                          ...(tomador.endereco.complemento && {
                              xCpl: tomador.endereco.complemento,
                          }),
                          xBairro: tomador.endereco.bairro,
                          cMun: tomador.endereco.ibge || tomador.endereco.cMun,
                          uf: tomador.endereco.uf,
                          cep: tomador.endereco.cep,
                      }
                    : undefined,
            },

            servico: {
                localPrestacao: { cLocPrestacao: empresa.municipio_codigo },
                codigoServico: {
                    cServTribNac: servico.codigo_servico_nacional,
                    // cNBSPrinc é obrigatório quando há bloco IBS/CBS (E0322).
                    // Prioridade: extraído pelo LLM > cadastrado na empresa.
                    ...((servico.codigo_nbs || empresa.codigo_nbs_padrao) && {
                        cNBSPrinc:
                            servico.codigo_nbs || empresa.codigo_nbs_padrao,
                    }),
                },
                xDescServ: servico.descricao,
            },

            valores: {
                vServico: Number(servico.valor_total),
            },

            tributacao: {
                issqn: {
                    tributacaoIssqn: TributacaoIssqn.TributadaMunicipioPrestador,
                    tipoRetencaoIssqn: TipoRetencaoIssqn.NaoRetido,
                    // pAliq em decimal (0.05 = 5%); empresa.aliquota_iss é em %
                    aliquota: (Number(empresa.aliquota_iss) || 0) / 100,
                    exigibilidadeISS: 1, // 1 = ISS exigível (default pra serviço comum)
                },
                federal: { cstPisCofins: "00" },
                percentualTotalTributosFederais: 0,
                percentualTotalTributosEstaduais: 0,
                percentualTotalTributosMunicipais: Number(empresa.aliquota_iss) || 0,
            },

            // Bloco ibsCbs no nível do infDps — campos da Reforma Tributária (LC 214/2025).
            // finNFSe = "0" (NFS-e regular), indDest = "0" (destinatário = tomador),
            // indFinal = "0" (não é consumo pessoal). cIndOp deve sair do Anexo VII.
            // CST 000 = Tributação Integral pelo IBS e CBS.
            // cClassTrib 000001 = "Situações tributadas integralmente pelo IBS e CBS" — único
            // código válido pra CST 000 em serviço comum (Informe Técnico RT 2025.002).
            // SEFAZ valida o par (CST, cClassTrib) e retorna E0959 se incompatível.
            ibsCbs: {
                finNFSe: "0",
                cIndOp: "100000", // operação interna padrão; consultar Anexo VII pra casos especiais
                indDest: "0",
                indFinal: "0",
                valores: {
                    trib: {
                        gIBSCBS: {
                            CST: "000",
                            cClassTrib: "000001",
                        },
                    },
                },
            },
        },
    };

    logger.info(
        { cnpj: empresa.cnpj, valor: servico.valor_total, ambiente },
        "EPN: emitindo DPS"
    );

    const service = new ContribuinteService(ctx);
    const t0 = Date.now();
    let response;
    try {
        response = await service.emitir(dps);
    } catch (err) {
        // Anexa o payload no erro pra que emissor.js consiga persistir
        // em notas_emitidas.payload_enviado e a gente possa cruzar payload x
        // resposta SEFAZ pra debug. Sem isso voamos cego em 400 Bad Request.
        err.dpsPayload = dps;
        throw err;
    }
    logger.info(
        {
            duration_ms: Date.now() - t0,
            cStat: response.cStat,
            chave: response.chaveAcesso,
        },
        "EPN: resposta SEFIN"
    );

    return { dps, response };
}

/**
 * Consulta NFS-e por chave de acesso.
 */
export async function consultarEpn(chaveAcesso, empresa) {
    const service = new ContribuinteService(buildContext(empresa));
    return service.consultar(chaveAcesso);
}

/**
 * Cancelamento de NFS-e (com pré-verificação).
 */
export async function cancelarEpn({ chaveAcesso, motivo, descricao, empresa }) {
    const { TipoEvento, MotivoEventoCancelamento } = await import("nfse-nacional");
    const service = new ContribuinteService(buildContext(empresa));
    return service.cancelar({
        chNFSe: chaveAcesso,
        tipoEvento: TipoEvento.Cancelamento,
        tipoAmbiente: ambienteAtual(),
        cnpjAutor: empresa.cnpj,
        cMotivo: motivo || MotivoEventoCancelamento.ErroNaEmissao,
        xMotivo: descricao || "Cancelamento via agente",
    });
}
