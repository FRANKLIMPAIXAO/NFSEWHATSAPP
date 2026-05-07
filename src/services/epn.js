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
                endereco: tomador.endereco,
            },

            servico: {
                localPrestacao: { cLocPrestacao: empresa.municipio_codigo },
                codigoServico: {
                    cServTribNac: servico.codigo_servico_nacional,
                    ...(servico.codigo_nbs && { cNBSPrinc: servico.codigo_nbs }),
                },
                xDescServ: servico.descricao,
            },

            valores: { vServico: Number(servico.valor_total) },

            tributacao: {
                issqn: {
                    tributacaoIssqn: TributacaoIssqn.TributadaMunicipioPrestador,
                    tipoRetencaoIssqn: TipoRetencaoIssqn.NaoRetido,
                },
                federal: { cstPisCofins: "00" },
                percentualTotalTributosFederais: 0,
                percentualTotalTributosEstaduais: 0,
                percentualTotalTributosMunicipais: Number(empresa.aliquota_iss) || 0,
            },
        },
    };

    logger.info(
        { cnpj: empresa.cnpj, valor: servico.valor_total, ambiente },
        "EPN: emitindo DPS"
    );

    const service = new ContribuinteService(ctx);
    const t0 = Date.now();
    const response = await service.emitir(dps);
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
