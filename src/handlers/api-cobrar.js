/**
 * src/handlers/api-cobrar.js
 * Endpoint HTTP pra disparar mensagem de cobrança via WhatsApp pro próprio
 * user (whatsapp_dono da empresa). Lembrete acionável: o user recebe info
 * do título pendente + link wa.me pra abrir conversa com o cliente.
 *
 * Fluxo:
 *   1. Valida JWT Supabase Auth
 *   2. Busca título em poupeja_receivables (RLS já filtra por user_id)
 *   3. Busca empresa ativa do user em poupeja_fiscal_emitentes (1ª default
 *      ou primeira da lista). Lê whatsapp_dono.
 *   4. Best-effort: busca destinatário por nome (entity_name do título) pra
 *      pegar telefone do cliente.
 *   5. Monta mensagem padronizada
 *   6. Envia via Evolution (enviarTexto do whatsapp.js)
 *
 * Erros (JSON {error, message}):
 *   400 invalid_payload
 *   401 missing_token / invalid_token
 *   404 titulo_nao_encontrado / empresa_sem_whatsapp
 *   500 erro_envio / internal_error
 */
import { supabase } from "../supabase.js";
import { enviarTexto } from "../services/whatsapp.js";
import { logger } from "../utils/logger.js";

function jsonResponse(res, status, body) {
    res.status(status).json(body);
}

function formatarValorBR(valor) {
    return Number(valor).toLocaleString("pt-BR", {
        style: "currency",
        currency: "BRL",
    });
}

function formatarDataBR(iso) {
    if (!iso) return "—";
    const [ano, mes, dia] = String(iso).slice(0, 10).split("-");
    if (!ano || !mes || !dia) return iso;
    return `${dia}/${mes}/${ano}`;
}

/**
 * Normaliza telefone pra formato wa.me (só dígitos, com 55 BR se faltar).
 * Retorna null se inválido.
 */
function paraWaMe(telefone) {
    if (!telefone) return null;
    let d = String(telefone).replace(/\D/g, "");
    if (d.length === 10 || d.length === 11) d = "55" + d; // BR sem código
    if (d.length < 12) return null;
    return d;
}

function montarMensagem({ titulo, telefoneClienteWaMe }) {
    const valor = formatarValorBR(titulo.amount);
    const dataVenc = formatarDataBR(titulo.due_date);
    const cliente = titulo.entity_name || "Cliente";

    const partes = [
        "📋 *Lembrete de cobrança*",
        "",
        `*Cliente:* ${cliente}`,
        `*Valor:* ${valor}`,
        `*Vencimento:* ${dataVenc}`,
    ];
    if (titulo.description) {
        partes.push(`*Descrição:* ${titulo.description}`);
    }
    if (telefoneClienteWaMe) {
        const textoEnc = encodeURIComponent(
            `Olá! Estamos entrando em contato sobre o título "${titulo.description || cliente}" no valor de ${valor}, com vencimento em ${dataVenc}. Pode confirmar a previsão de pagamento?`,
        );
        partes.push("");
        partes.push(`👉 Cobrar direto: https://wa.me/${telefoneClienteWaMe}?text=${textoEnc}`);
    } else {
        partes.push("");
        partes.push("ℹ️ Telefone do cliente não cadastrado em Destinatários.");
    }
    return partes.join("\n");
}

export async function handleApiCobrar(req, res) {
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
        const userId = userData.user.id;

        // 2. Payload
        const { titulo_id } = req.body || {};
        if (!titulo_id || typeof titulo_id !== "string") {
            return jsonResponse(res, 400, {
                error: "invalid_payload",
                message: "titulo_id obrigatório",
            });
        }

        // 3. Busca título (RLS filtra por user_id automaticamente via JWT do
        // user, mas estamos usando service_role aqui — então filtramos manual)
        const { data: titulo, error: tituloErr } = await supabase
            .from("poupeja_receivables")
            .select("id, user_id, description, amount, due_date, status, entity_name")
            .eq("id", titulo_id)
            .eq("user_id", userId)
            .maybeSingle();

        if (tituloErr || !titulo) {
            return jsonResponse(res, 404, {
                error: "titulo_nao_encontrado",
                message: "Título não encontrado ou não pertence ao usuário",
            });
        }

        // 4. Busca empresa do user pra pegar whatsapp_dono. Estratégia:
        // primeira empresa ativa do user (assume 1 empresa por user no MVP).
        const { data: empresa, error: empresaErr } = await supabase
            .from("poupeja_fiscal_emitentes")
            .select("id, nome, whatsapp_dono")
            .eq("user_id", userId)
            .limit(1)
            .maybeSingle();

        if (empresaErr || !empresa?.whatsapp_dono) {
            return jsonResponse(res, 404, {
                error: "empresa_sem_whatsapp",
                message: "Nenhuma empresa cadastrada com whatsapp_dono. Cadastre em Empresas / Emitentes.",
            });
        }

        // 5. Best-effort: pega telefone do destinatário pelo nome (entity_name)
        let telefoneClienteWaMe = null;
        if (titulo.entity_name) {
            const { data: dest } = await supabase
                .from("poupeja_destinatarios")
                .select("telefone")
                .eq("user_id", userId)
                .ilike("nome", titulo.entity_name.trim())
                .eq("ativo", true)
                .limit(1)
                .maybeSingle();
            if (dest?.telefone) {
                telefoneClienteWaMe = paraWaMe(dest.telefone);
            }
        }

        const mensagem = montarMensagem({ titulo, telefoneClienteWaMe });

        // 6. Envia
        await enviarTexto(empresa.whatsapp_dono, mensagem);

        logger.info(
            {
                userId,
                titulo_id,
                empresa_id: empresa.id,
                tem_telefone_cliente: !!telefoneClienteWaMe,
            },
            "api-cobrar: lembrete enviado",
        );

        return jsonResponse(res, 200, {
            ok: true,
            destinatario_da_mensagem: empresa.whatsapp_dono,
            tem_link_cliente: !!telefoneClienteWaMe,
        });
    } catch (err) {
        logger.error({ err: err.message, stack: err.stack }, "api-cobrar: erro");
        return jsonResponse(res, 500, {
            error: "internal_error",
            message: err.message,
        });
    }
}
