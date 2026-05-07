/**
 * src/services/emissor.js
 * Roteador único de emissão de NFS-e.
 * Escolhe Focus ou EPN direto baseado em empresa.emissor e persiste no DB.
 *
 *     emitirNFSe({ empresa, tomador, servico, competencia, conversaId? })
 *
 * Retorna estrutura comum independente do emissor.
 */
import { randomUUID } from "node:crypto";
import { db, insertNota, updateNotaStatus, logEvento } from "../db/index.js";
import { emitirNFSe as emitirFocus } from "./focusnfe.js";
import { emitirEpn, consultarEpn, cancelarEpn } from "./epn.js";
import { gerarDanfse } from "./danfe.js";
import { resolverCep } from "./viacep.js";
import { logger } from "../utils/logger.js";

/**
 * Se o tomador tem CEP mas faltam logradouro/bairro/IBGE/UF, consulta ViaCEP
 * e completa. Devolve um novo objeto tomador (não muta o original).
 */
async function completarEnderecoTomador(tomador) {
    const e = tomador?.endereco;
    if (!e?.cep) return tomador;
    const jaCompleto = e.logradouro && e.bairro && (e.ibge || e.cMun) && e.uf;
    if (jaCompleto) return tomador;

    const dados = await resolverCep(e.cep);
    if (!dados) return tomador; // ViaCEP falhou — deixa como está e EPN reclama com mensagem clara

    return {
        ...tomador,
        endereco: {
            ...e,
            logradouro: e.logradouro || dados.logradouro,
            bairro: e.bairro || dados.bairro,
            municipio: e.municipio || dados.municipio,
            uf: e.uf || dados.uf,
            ibge: e.ibge || dados.ibge,
        },
    };
}

function novaReferencia(empresa) {
    return `${empresa.id}-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

/**
 * Persiste a tentativa de emissão antes da chamada (status pendente).
 * Retorna o id da linha em notas_emitidas.
 */
function persistirInicio({ empresa, tomador, servico, referencia, conversaId }) {
    const r = insertNota.run(
        empresa.id,
        conversaId || null,
        referencia,
        "pendente",
        tomador.documento,
        tomador.razao_social,
        servico.descricao,
        Number(servico.valor_total),
        servico.codigo_lc116 || null,
        null, // audio_msg_id
        null, // transcricao
        null  // payload_enviado (preenchido depois)
    );
    return r.lastInsertRowid;
}

function persistirResultado({ notaId, status, numero, chave, urlPdf, urlXml, erro, response }) {
    updateNotaStatus.run(
        status,
        numero || null,
        chave || null,
        urlPdf || null,
        urlXml || null,
        erro || null,
        response ? JSON.stringify(response).slice(0, 50_000) : null,
        status,
        notaId
    );
}

/**
 * Emite NFS-e via Focus ou EPN baseado em empresa.emissor.
 * Persiste no DB e tenta gerar DANF-Se em PDF.
 */
export async function emitirNFSe({
    empresa,
    tomador,
    servico,
    competencia,
    conversaId,
}) {
    const emissor = empresa.emissor || "focus";
    const referencia = novaReferencia(empresa);
    competencia = competencia || new Date().toISOString().slice(0, 10);

    const notaId = persistirInicio({
        empresa,
        tomador,
        servico,
        referencia,
        conversaId,
    });

    logger.info(
        { empresaId: empresa.id, emissor, referencia, notaId },
        "emitirNFSe: roteando"
    );

    try {
        if (emissor === "epn") {
            // EPN exige cServTribNac (codigo_servico_nacional) — formato pós-Reforma.
            // O extractor hoje só produz codigo_lc116 (formato LC 116/2003), então
            // fazemos fallback pra empresa.servico_padrao_lc116 que está cadastrado
            // no formato correto do EPN.
            const servicoEpn = {
                ...servico,
                codigo_servico_nacional:
                    servico.codigo_servico_nacional ||
                    empresa.servico_padrao_lc116 ||
                    null,
            };
            if (!servicoEpn.codigo_servico_nacional) {
                throw new Error(
                    `Empresa ${empresa.id} (${empresa.razao_social}) sem servico_padrao_lc116 cadastrado — EPN exige cServTribNac.`
                );
            }

            // EPN exige endereço completo do tomador quando ele é identificado.
            // O extractor pede CEP+número do usuário; aqui completamos via ViaCEP.
            const tomadorCompleto = await completarEnderecoTomador(tomador);
            if (tomadorCompleto.documento && !tomadorCompleto.endereco?.cep) {
                throw new Error(
                    `Tomador identificado (${tomadorCompleto.documento}) sem endereço — EPN exige CEP do tomador.`
                );
            }

            const { response } = await emitirEpn({
                empresa,
                tomador: tomadorCompleto,
                servico: servicoEpn,
                competencia,
            });

            if (response.cStat !== "100") {
                const erroMsg =
                    response.xMotivo ||
                    JSON.stringify(response).slice(0, 500);
                persistirResultado({
                    notaId,
                    status: "rejeitada",
                    erro: erroMsg,
                    response,
                });
                logEvento("emissao_rejeitada", empresa.id, conversaId, {
                    cStat: response.cStat,
                    xMotivo: response.xMotivo,
                });
                return {
                    ok: false,
                    notaId,
                    referencia,
                    emissor,
                    status: "rejeitada",
                    erro: erroMsg,
                    response,
                };
            }

            // Autorizada — gera artefatos (XML/HTML/PDF best-effort)
            const artefatos = await gerarDanfse(response);

            persistirResultado({
                notaId,
                status: "autorizada",
                numero: response.nfse?.infNfse?.nNFSe,
                chave: response.chaveAcesso,
                urlPdf: artefatos.pdfPath || artefatos.htmlPath || null,
                urlXml: artefatos.xmlPath || null,
                response,
            });
            logEvento("emissao_autorizada", empresa.id, conversaId, {
                chaveAcesso: response.chaveAcesso,
            });

            return {
                ok: true,
                notaId,
                referencia,
                emissor,
                status: "autorizada",
                chaveAcesso: response.chaveAcesso,
                numero: response.nfse?.infNfse?.nNFSe,
                pdfPath: artefatos.pdfPath,
                htmlPath: artefatos.htmlPath,
                xmlPath: artefatos.xmlPath,
                response,
            };
        }

        // Default: Focus NFe
        const { result } = await emitirFocus({
            referencia,
            empresa,
            tomador,
            servico,
            competencia,
        });
        const focusStatus =
            result.status === "autorizado"
                ? "autorizada"
                : result.status === "erro_autorizacao"
                ? "rejeitada"
                : "pendente";
        persistirResultado({
            notaId,
            status: focusStatus,
            numero: result.numero,
            chave: result.codigo_verificacao,
            response: result,
            erro: result.erros?.[0]?.mensagem,
        });
        return {
            ok: focusStatus === "autorizada",
            notaId,
            referencia,
            emissor,
            status: focusStatus,
            response: result,
        };
    } catch (err) {
        persistirResultado({
            notaId,
            status: "rejeitada",
            erro: err.message,
            response: { error: err.message, stack: err.stack?.slice(0, 1000) },
        });
        logEvento("emissao_erro", empresa.id, conversaId, {
            error: err.message,
        });
        throw err;
    }
}

export { consultarEpn, cancelarEpn };
