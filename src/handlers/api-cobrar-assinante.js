/**
 * src/handlers/api-cobrar-assinante.js
 * Endpoint admin pra disparar cobrança via WhatsApp pra um user inadimplente
 * do SaaS PacNoBolso. Diferente de /api/cobrar (que é cobrança user→cliente
 * com lembrete pro próprio user), este envia mensagem direto pro WhatsApp
 * do assinante usando o telefone cadastrado em poupeja_users.phone.
 *
 * Autorização: o requester precisa ter role='admin' em user_roles.
 *
 * Fluxo:
 *   1. Valida JWT do admin
 *   2. Verifica role='admin' em user_roles
 *   3. Lê body {user_id, mensagem_extra?}
 *   4. Busca user em poupeja_users (nome, phone)
 *   5. Busca subscription pra contexto (plano, vencimento, status)
 *   6. Monta mensagem padrão (override com mensagem_extra se enviada)
 *   7. Envia via Evolution
 *
 * Erros (JSON {error, message}):
 *   401 missing_token / invalid_token
 *   403 nao_e_admin / user_sem_telefone
 *   404 user_nao_encontrado
 *   400 invalid_payload
 *   500 internal_error
 */
import { supabase } from "../supabase.js";
import { enviarTexto } from "../services/whatsapp.js";
import { logger } from "../utils/logger.js";

function jsonResponse(res, status, body) {
    res.status(status).json(body);
}

function formatarDataBR(iso) {
    if (!iso) return "—";
    const [ano, mes, dia] = String(iso).slice(0, 10).split("-");
    if (!ano || !mes || !dia) return iso;
    return `${dia}/${mes}/${ano}`;
}

function diasEntre(dataIso, hoje = new Date()) {
    if (!dataIso) return null;
    const d = new Date(dataIso);
    if (isNaN(d.getTime())) return null;
    const diffMs = hoje.getTime() - d.getTime();
    return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

function mapaPlano(planType) {
    switch ((planType || "").toLowerCase()) {
        case "monthly":
        case "mensal":
            return "Mensal";
        case "annual":
        case "anual":
        case "yearly":
            return "Anual";
        case "trial":
            return "Trial";
        default:
            return planType || "—";
    }
}

function montarMensagem({ nome, plano, vencimento, diasAtraso, mensagemExtra }) {
    if (mensagemExtra && mensagemExtra.trim()) {
        return mensagemExtra.trim();
    }
    const partes = [
        `Olá, ${nome || "tudo bem"}! 👋`,
        "",
        "Notamos que seu acesso ao *Pac no Bolso* está com pagamento pendente:",
        "",
        `📦 *Plano:* ${plano}`,
    ];
    if (vencimento) {
        const atraso =
            diasAtraso !== null && diasAtraso > 0
                ? ` (${diasAtraso} ${diasAtraso === 1 ? "dia" : "dias"} em atraso)`
                : "";
        partes.push(`📅 *Vencimento:* ${formatarDataBR(vencimento)}${atraso}`);
    }
    partes.push(
        "",
        "Pra manter o acesso ativo, regularize por aqui:",
        "👉 https://www.pacnobolso.com.br/plans",
        "",
        "Qualquer dúvida, é só responder essa mensagem.",
        "Equipe Pac no Bolso 🤖",
    );
    return partes.join("\n");
}

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
        const { data: role, error: roleErr } = await supabase
            .from("user_roles")
            .select("role")
            .eq("user_id", adminId)
            .eq("role", "admin")
            .maybeSingle();

        if (roleErr || !role) {
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
                message: "user_id obrigatório (UUID do assinante)",
            });
        }

        // 4. Busca user
        const { data: user, error: userErr } = await supabase
            .from("poupeja_users")
            .select("id, name, email, phone")
            .eq("id", user_id)
            .maybeSingle();

        if (userErr || !user) {
            return jsonResponse(res, 404, {
                error: "user_nao_encontrado",
                message: "Assinante não encontrado",
            });
        }
        if (!user.phone) {
            return jsonResponse(res, 403, {
                error: "user_sem_telefone",
                message: `Assinante ${user.name || user.email} não tem telefone cadastrado em poupeja_users.phone.`,
            });
        }

        // 5. Busca subscription pra contexto
        const { data: sub } = await supabase
            .from("poupeja_subscriptions")
            .select("status, plan_type, current_period_end")
            .eq("user_id", user_id)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

        // 6. Monta mensagem
        const mensagem = montarMensagem({
            nome: user.name || user.email?.split("@")[0],
            plano: mapaPlano(sub?.plan_type),
            vencimento: sub?.current_period_end || null,
            diasAtraso: diasEntre(sub?.current_period_end),
            mensagemExtra: mensagem_extra,
        });

        // 7. Envia via Evolution
        await enviarTexto(user.phone, mensagem);

        logger.info(
            {
                adminId,
                user_id,
                phone: user.phone,
                status: sub?.status,
                plan_type: sub?.plan_type,
            },
            "api-cobrar-assinante: cobrança enviada",
        );

        return jsonResponse(res, 200, {
            ok: true,
            destinatario: user.phone,
            assinante: user.name || user.email,
            status_assinatura: sub?.status || null,
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
