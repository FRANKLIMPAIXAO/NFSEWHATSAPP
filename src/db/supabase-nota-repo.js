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
    if (!isEnabled()) return null;
    if (!empresa?._supabaseId || !empresa?._supabaseUserId) return null;

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
 * @param {string|null} supabaseNotaId - UUID retornado por inserirNotaPendente
 * @param {object} params
 * @param {string} params.status - 'autorizada' | 'rejeitada'
 * @param {string} [params.numero]
 * @param {string} [params.chave]
 * @param {string} [params.dataEmissao] - ISO string
 * @param {string} [params.caminhoXml]
 * @param {string} [params.caminhoPdf]
 * @param {object} [params.response] - resposta SEFAZ (vai em response_payload jsonb)
 * @param {string} [params.erro]
 */
export async function atualizarNotaResultado(supabaseNotaId, params) {
    if (!isEnabled() || !supabaseNotaId) return;

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
        const { error } = await supabase
            .from("poupeja_nfse")
            .update(update)
            .eq("id", supabaseNotaId);
        if (error) {
            logger.error(
                { err: error.message, supabaseNotaId },
                "supabase-nota: erro atualizando resultado"
            );
        }
    } catch (err) {
        logger.error(
            { err: err.message, supabaseNotaId },
            "supabase-nota: exception atualizando resultado"
        );
    }
}
