/**
 * src/db/supabase-nota-repo.js
 * Repositório de gravação de notas no Supabase do Pac no Bolso (`poupeja_nfse`).
 *
 * Etapa 6 do refactor. Comportamento BEST-EFFORT: se Supabase falhar (rede,
 * permissão, schema), loga o erro mas NÃO derruba o fluxo de emissão — a
 * gravação no SQLite local (`notas_emitidas`) sempre acontece e é a fonte
 * de verdade do agent. O `poupeja_nfse` é replicação pra cliente ver no
 * painel do Pac em tempo real.
 *
 * Só grava se a empresa veio do Supabase (`empresa._supabaseId` existe).
 * Pra empresas legadas do SQLite (Roca/El Shadai), retorna null silencioso.
 */
import { supabase, isEnabled } from "../supabase.js";
import { logger } from "../utils/logger.js";

/**
 * Insere row inicial em poupeja_nfse com status 'pendente'.
 *
 * @param {object} params
 * @param {object} params.empresa - precisa ter _supabaseId + _supabaseUserId
 * @param {object} params.tomador - {tipo:'PF'|'PJ', documento, razao_social}
 * @param {object} params.servico - {descricao, valor_total, codigo_lc116?}
 * @param {string} params.referencia
 * @param {string} params.competencia
 * @returns {Promise<string|null>} UUID da row criada, ou null se não gravou
 */
export async function inserirNotaPendente({
    empresa,
    tomador,
    servico,
    referencia,
    competencia,
}) {
    if (!isEnabled()) {
        logger.warn({ referencia }, "supabase-nota: skip (cliente desligado)");
        return null;
    }
    if (!empresa?._supabaseId) {
        logger.warn(
            { referencia, empresaId: empresa?.id },
            "supabase-nota: skip (empresa sem _supabaseId — origem SQLite legado)"
        );
        return null;
    }
    if (!empresa?._supabaseUserId) {
        logger.warn(
            { referencia, empresaSupabaseId: empresa._supabaseId },
            "supabase-nota: skip (empresa sem _supabaseUserId — coluna user_id NULL no Supabase?)"
        );
        return null;
    }

    try {
        const { data, error } = await supabase
            .from("poupeja_nfse")
            .insert({
                user_id: empresa._supabaseUserId,
                ref: referencia,
                status: "pendente",
                cnpj_prestador: empresa.cnpj,
                cnpj_tomador: tomador.tipo === "PJ" ? tomador.documento : null,
                cpf_tomador: tomador.tipo === "PF" ? tomador.documento : null,
                nome_tomador: tomador.razao_social || null,
                descricao_servico: servico.descricao || null,
                valor_servico: Number(servico.valor_total) || 0,
                competencia: competencia || null,
                payload: {
                    tomador,
                    servico,
                    competencia,
                    referencia,
                    emitenteSupabaseId: empresa._supabaseId,
                },
            })
            .select("id")
            .single();

        if (error) {
            logger.error(
                { err: error.message, referencia },
                "supabase-nota: erro inserindo pendente — segue só no SQLite"
            );
            return null;
        }
        return data.id;
    } catch (err) {
        logger.error(
            { err: err.message, referencia },
            "supabase-nota: exception inserindo pendente — segue só no SQLite"
        );
        return null;
    }
}

/**
 * Atualiza row de poupeja_nfse com resultado final (autorizada ou rejeitada).
 *
 * Aceita identificação por UUID OU por ref (string `<empresaId>-<ts>-<rnd>`).
 * A ref é a chave natural — gerada pelo emissor.js, sempre disponível no
 * fluxo síncrono e no webhook async. UUID é só convenience interna.
 *
 * @param {object} ident
 * @param {string} [ident.supabaseNotaId] - UUID retornado por inserirNotaPendente
 * @param {string} [ident.ref] - referência gerada pelo emissor (preferido em webhook async)
 * @param {object} params
 * @param {string} params.status - 'autorizada' | 'rejeitada' | 'cancelada'
 * @param {string} [params.numero]
 * @param {string} [params.chave]
 * @param {string} [params.dataEmissao] - ISO string
 * @param {string} [params.caminhoXml]
 * @param {string} [params.caminhoPdf]
 * @param {object} [params.response] - resposta SEFAZ (vai em response_payload jsonb)
 * @param {string} [params.erro]
 */
export async function atualizarNotaResultado(ident, params) {
    if (!isEnabled()) return;

    // Compat: chamadas antigas passavam só o supabaseNotaId como 1º argumento.
    // Se for string, trata como UUID. Se for objeto, lê {supabaseNotaId, ref}.
    let supabaseNotaId = null;
    let ref = null;
    if (typeof ident === "string") {
        supabaseNotaId = ident;
    } else if (ident && typeof ident === "object") {
        supabaseNotaId = ident.supabaseNotaId || null;
        ref = ident.ref || null;
    }
    if (!supabaseNotaId && !ref) {
        logger.warn({ params }, "supabase-nota: atualizar chamado sem id nem ref — skip");
        return;
    }

    const update = {
        status: params.status,
        updated_at: new Date().toISOString(),
    };
    if (params.numero) update.numero_nfse = params.numero;
    if (params.chave) update.chave_nfse = params.chave;
    if (params.dataEmissao) update.data_emissao = params.dataEmissao;
    if (params.caminhoXml) update.caminho_xml = params.caminhoXml;
    if (params.caminhoPdf) update.caminho_pdf = params.caminhoPdf;
    // response_payload é jsonb — guarda resposta SEFAZ completa + erro (se houver).
    // Pac vai conseguir mostrar o motivo da rejeição no painel a partir daqui.
    if (params.response || params.erro) {
        update.response_payload = {
            ...(params.response || {}),
            ...(params.erro ? { agent_erro: params.erro } : {}),
        };
    }

    try {
        let query = supabase.from("poupeja_nfse").update(update);
        if (supabaseNotaId) query = query.eq("id", supabaseNotaId);
        else query = query.eq("ref", ref);
        const { error } = await query;
        if (error) {
            logger.error(
                { err: error.message, supabaseNotaId, ref },
                "supabase-nota: erro atualizando resultado"
            );
        }
    } catch (err) {
        logger.error(
            { err: err.message, supabaseNotaId, ref },
            "supabase-nota: exception atualizando resultado"
        );
    }
}
