/**
 * src/handlers/api-cobrar-assinante.js
 * Endpoint admin pra disparar cobrança WhatsApp pra um user inadimplente.
 * Lógica de fato vive em src/services/cobranca-assinante.js (compartilhada
 * com o cron diário em src/jobs/cobrancas-cron.js).
 *
 * Autorização:
 *   1. JWT do Supabase Auth
 *   2. Role 'admin' em user_roles
 *
 * Body: { user_id, mensagem_extra? }
 *
 * Erros (JSON {error, message}):
 *   401 missing_token / invalid_token
 *   403 nao_e_admin / user_sem_telefone
 *   404 user_nao_encontrado
 *   400 invalid_payload
 *   500 internal_error / erro_envio
 */
import { supabase } from "../supabase.js";
import { enviarCobrancaAssinante } from "../services/cobranca-assinante.js";
import { logger } from "../utils/logger.js";

function jsonResponse(res, status, body) {
    res.status(status).json(body);
}

const MAPA_MOTIVO_HTTP = {
    user_nao_encontrado: 404,
    user_sem_telefone: 403,
    user_id_obrigatorio: 400,
    supabase_offline: 500,
    erro_envio: 500,
    ja_enviado_hoje: 200,
};

export async function handleApiCobrarAssinante(req, res) {
    try {
        // 1. Auth
        const authHeader = req.headers["authorization"] || "";
        const match = authHeader.match(/^Bearer\s+(.+)$/i);
        if (!match) {
            return jsonResponse(res, 401, {
                error: "missing_token",
                message: "Authorization: Bearer <jwt> obrigatório",
            });
        }
        if (!supabase) {
            return jsonResponse(res, 500, {
                error: "supabase_offline",
                message: "Cliente Supabase não inicializado",
            });
        }
        const { data: userData, error: authErr } = await supabase.auth.getUser(match[1]);
        if (authErr || !userData?.user?.id) {
            return jsonResponse(res, 401, {
                error: "invalid_token",
                message: authErr?.message || "Token inválido",
            });
        }
        const adminId = userData.user.id;

        // 2. Verifica role admin
        const { data: role } = await supabase
            .from("user_roles")
            .select("role")
            .eq("user_id", adminId)
            .eq("role", "admin")
            .maybeSingle();

        if (!role) {
            return jsonResponse(res, 403, {
                error: "nao_e_admin",
                message: "Apenas administradores podem cobrar assinantes.",
            });
        }

        // 3. Payload
        const { user_id, mensagem_extra } = req.body || {};
        if (!user_id || typeof user_id !== "string") {
            return jsonResponse(res, 400, {
                error: "invalid_payload",
                message: "user_id obrigatório",
            });
        }

        // 4. Dispara via service compartilhado
        const resultado = await enviarCobrancaAssinante({
            userId: user_id,
            tipo: "manual",
            fonte: "manual",
            mensagemExtra: mensagem_extra,
        });

        logger.info(
            { adminId, userId: user_id, ...resultado },
            "api-cobrar-assinante: resultado",
        );

        if (!resultado.ok) {
            const status =
                MAPA_MOTIVO_HTTP[resultado.motivo] || resultado.status || 500;
            return jsonResponse(res, status, {
                error: resultado.motivo || "erro",
                message: resultado.detalhe || resultado.motivo || "Erro ao enviar",
            });
        }

        return jsonResponse(res, 200, {
            ok: true,
            deduplicado: !!resultado.deduplicado,
            destinatario: resultado.destinatario || null,
            assinante: resultado.assinante || null,
            status_assinatura: resultado.status_assinatura || null,
            cobranca_asaas: resultado.cobrancaAsaas || null,
        });
    } catch (err) {
        logger.error(
            { err: err.message, stack: err.stack },
            "api-cobrar-assinante: erro",
        );
        return jsonResponse(res, 500, {
            error: "internal_error",
            message: err.message,
        });
    }
}
