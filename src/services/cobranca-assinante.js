/**
 * src/services/cobranca-assinante.js
 * Lógica única de envio de cobrança WhatsApp pra assinante do SaaS.
 * Compartilhada entre:
 *   - Handler HTTP manual (api-cobrar-assinante.js)
 *   - Cron diário (jobs/cobrancas-cron.js)
 *
 * Responsabilidades:
 *   1. Resolver dados (user, subscription, cobrança Asaas)
 *   2. Aplicar idempotência (poupeja_cobrancas_enviadas UNIQUE diário)
 *   3. Montar mensagem
 *   4. Enviar via Evolution
 *   5. Persistir log do envio
 *
 * Retorna objeto estruturado com resultado pra caller decidir HTTP status
 * (handler manual) ou só logar (cron).
 */
import { supabase } from "../supabase.js";
import { enviarTexto } from "./whatsapp.js";
import { buscarCobrancaPendente } from "./asaas.js";
import { logger } from "../utils/logger.js";

function formatarDataBR(iso) {
    if (!iso) return "—";
    const [a, m, d] = String(iso).slice(0, 10).split("-");
    if (!a || !m || !d) return iso;
    return `${d}/${m}/${a}`;
}

function diasEntre(dataIso, hoje = new Date()) {
    if (!dataIso) return null;
    const d = new Date(dataIso);
    if (isNaN(d.getTime())) return null;
    return Math.floor((hoje.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
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

/**
 * Templates por tipo de cobrança. Cron escolhe tipo baseado no delta
 * entre current_period_end e hoje. Manual usa 'manual' (template padrão).
 */
function rotuloTipo(tipo) {
    switch (tipo) {
        case "d_minus_3":
            return "⏰ *Lembrete:* sua mensalidade vence em 3 dias";
        case "d":
            return "📅 *Vence hoje:* sua mensalidade do Pac no Bolso";
        case "d_plus_3":
            return "🔔 *Pagamento em atraso há 3 dias*";
        case "d_plus_7":
            return "⚠️ *Pagamento em atraso há 7 dias* — acesso será suspenso em breve";
        default:
            return "📋 Pagamento pendente do Pac no Bolso";
    }
}

function montarMensagem({
    nome,
    plano,
    vencimentoSub,
    diasAtraso,
    cobrancaAsaas,
    tipo,
}) {
    const partes = [
        `Olá, ${nome || "tudo bem"}! 👋`,
        "",
        rotuloTipo(tipo),
        "",
        `📦 *Plano:* ${plano}`,
    ];

    if (cobrancaAsaas) {
        if (cobrancaAsaas.value) {
            const valorFmt = Number(cobrancaAsaas.value).toLocaleString("pt-BR", {
                style: "currency",
                currency: "BRL",
            });
            partes.push(`💰 *Valor:* ${valorFmt}`);
        }
        if (cobrancaAsaas.dueDate) {
            const diasCobr = diasEntre(cobrancaAsaas.dueDate);
            const atraso =
                diasCobr !== null && diasCobr > 0
                    ? ` (${diasCobr} ${diasCobr === 1 ? "dia" : "dias"} em atraso)`
                    : "";
            partes.push(
                `📅 *Vencimento:* ${formatarDataBR(cobrancaAsaas.dueDate)}${atraso}`,
            );
        }
        partes.push("");
        if (cobrancaAsaas.invoiceUrl) {
            partes.push(
                "💳 *Pague online (PIX, cartão ou boleto):*",
                cobrancaAsaas.invoiceUrl,
            );
        }
        if (cobrancaAsaas.bankSlipUrl) {
            partes.push("", "📄 *Boleto direto:*", cobrancaAsaas.bankSlipUrl);
        }
    } else {
        if (vencimentoSub) {
            const atraso =
                diasAtraso !== null && diasAtraso > 0
                    ? ` (${diasAtraso} ${diasAtraso === 1 ? "dia" : "dias"} em atraso)`
                    : "";
            partes.push(`📅 *Vencimento:* ${formatarDataBR(vencimentoSub)}${atraso}`);
        }
        partes.push(
            "",
            "Pra regularizar:",
            "👉 https://www.pacnobolso.com.br/plans",
        );
    }

    partes.push(
        "",
        "Qualquer dúvida, é só responder essa mensagem.",
        "Equipe Pac no Bolso 🤖",
    );
    return partes.join("\n");
}

/**
 * Envia cobrança pra um assinante específico.
 *
 * @param {object} args
 * @param {string} args.userId
 * @param {'manual'|'d_minus_3'|'d'|'d_plus_3'|'d_plus_7'} args.tipo
 * @param {'manual'|'cron'} args.fonte
 * @param {string} [args.mensagemExtra] — sobrescreve template (só manual)
 *
 * @returns {Promise<{ok, status, motivo?, destinatario?, cobrancaAsaas?, deduplicado?}>}
 */
export async function enviarCobrancaAssinante({
    userId,
    tipo = "manual",
    fonte = "manual",
    mensagemExtra = null,
}) {
    if (!supabase) {
        return { ok: false, status: 500, motivo: "supabase_offline" };
    }
    if (!userId) {
        return { ok: false, status: 400, motivo: "user_id_obrigatorio" };
    }

    // 1. Idempotência: se já enviou esse tipo pro user hoje, skip
    const hoje = new Date().toISOString().slice(0, 10);
    const { data: jaEnviado } = await supabase
        .from("poupeja_cobrancas_enviadas")
        .select("id, enviado_em, sucesso")
        .eq("user_id", userId)
        .eq("tipo_cobranca", tipo)
        .eq("data_referencia", hoje)
        .maybeSingle();
    if (jaEnviado) {
        return {
            ok: true,
            status: 200,
            deduplicado: true,
            motivo: "ja_enviado_hoje",
            envio_anterior: jaEnviado,
        };
    }

    // 2. Busca user
    const { data: user, error: userErr } = await supabase
        .from("poupeja_users")
        .select("id, name, email, phone")
        .eq("id", userId)
        .maybeSingle();
    if (userErr || !user) {
        return { ok: false, status: 404, motivo: "user_nao_encontrado" };
    }
    if (!user.phone) {
        return { ok: false, status: 403, motivo: "user_sem_telefone" };
    }

    // 3. Busca subscription mais recente
    const { data: sub } = await supabase
        .from("poupeja_subscriptions")
        .select("status, plan_type, current_period_end, asaas_subscription_id, payment_gateway")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

    // 4. Cobrança Asaas pendente (PIX/boleto/cartão)
    let cobrancaAsaas = null;
    if (sub?.asaas_subscription_id) {
        cobrancaAsaas = await buscarCobrancaPendente(sub.asaas_subscription_id);
    }

    // 5. Mensagem
    const mensagem =
        mensagemExtra && mensagemExtra.trim()
            ? mensagemExtra.trim()
            : montarMensagem({
                  nome: user.name || user.email?.split("@")[0],
                  plano: mapaPlano(sub?.plan_type),
                  vencimentoSub: sub?.current_period_end || null,
                  diasAtraso: diasEntre(sub?.current_period_end),
                  cobrancaAsaas,
                  tipo,
              });

    // 6. Envio
    let sucesso = true;
    let erroEnvio = null;
    try {
        await enviarTexto(user.phone, mensagem);
    } catch (err) {
        sucesso = false;
        erroEnvio = err.message;
        logger.error(
            { err: err.message, userId, tipo, fonte },
            "cobranca-assinante: falha no envio Evolution",
        );
    }

    // 7. Log no Supabase (best-effort — não derruba o fluxo)
    try {
        await supabase.from("poupeja_cobrancas_enviadas").insert({
            user_id: userId,
            tipo_cobranca: tipo,
            fonte,
            data_referencia: hoje,
            destinatario_phone: user.phone,
            cobranca_asaas_id: cobrancaAsaas?.id || null,
            sucesso,
            erro: erroEnvio,
            payload_resposta: cobrancaAsaas
                ? {
                      asaas_id: cobrancaAsaas.id,
                      valor: cobrancaAsaas.value,
                      vencimento: cobrancaAsaas.dueDate,
                      status: cobrancaAsaas.status,
                      tem_link: !!cobrancaAsaas.invoiceUrl,
                  }
                : null,
        });
    } catch (logErr) {
        logger.warn(
            { err: logErr.message, userId },
            "cobranca-assinante: falha persistindo log (best-effort)",
        );
    }

    if (!sucesso) {
        return {
            ok: false,
            status: 500,
            motivo: "erro_envio",
            detalhe: erroEnvio,
        };
    }

    return {
        ok: true,
        status: 200,
        destinatario: user.phone,
        assinante: user.name || user.email,
        status_assinatura: sub?.status || null,
        cobrancaAsaas: cobrancaAsaas
            ? {
                  id: cobrancaAsaas.id,
                  valor: cobrancaAsaas.value,
                  vencimento: cobrancaAsaas.dueDate,
                  status: cobrancaAsaas.status,
                  tem_link: !!cobrancaAsaas.invoiceUrl,
              }
            : null,
    };
}
