/**
 * src/handlers/financeiro-boleto.js
 * Handler do sub-fluxo de BOLETO/FATURA (a pagar futuro).
 *
 * Substitui o tool "cadastro-conta-pagar" do AI Agent do n8n. Insere em
 * poupeja_payables direto via Supabase service role e responde com voz
 * carismática.
 *
 * Fluxo:
 *   1. extrairBoleto(input) — Claude Vision lê o boleto
 *   2. Se status=ok → insert poupeja_payables → resposta com confirmação
 *      + acumulado de contas a pagar essa semana.
 *   3. Se status=incomplete → pergunta amigável o que falta.
 *   4. Se status=not_boleto → desvia pra handler de transação (pode ser
 *      comprovante).
 */
import { supabase } from "../supabase.js";
import { enviarTexto } from "../services/whatsapp.js";
import { extrairBoleto } from "../services/financeiro-extractor.js";
import { logger } from "../utils/logger.js";

function fmtBRL(v) {
    return Number(v).toLocaleString("pt-BR", {
        style: "currency",
        currency: "BRL",
    });
}

function fmtDataBR(iso) {
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

/**
 * Conta payables pendentes do user nos próximos 7 dias e total a pagar.
 * Usado pra dar contexto na resposta ("você tem X contas essa semana").
 */
async function resumoSemana(userId) {
    const hoje = new Date().toISOString().slice(0, 10);
    const fim = new Date();
    fim.setDate(fim.getDate() + 7);
    const fimISO = fim.toISOString().slice(0, 10);

    const { data, error } = await supabase
        .from("poupeja_payables")
        .select("amount")
        .eq("user_id", userId)
        .eq("status", "pending")
        .gte("due_date", hoje)
        .lte("due_date", fimISO);

    if (error) {
        logger.warn({ err: error.message }, "financeiro-boleto: falha buscando resumo semana");
        return { quantidade: 0, total: 0 };
    }
    const quantidade = (data || []).length;
    const total = (data || []).reduce((s, r) => s + Number(r.amount || 0), 0);
    return { quantidade, total };
}

/**
 * Entry point — chamado quando classificador diz subtipo=boleto.
 *
 * @param {Object} args
 * @param {Object} args.empresa - empresa com _supabaseUserId
 * @param {string} args.numero  - whatsapp
 * @param {string} args.texto   - texto/transcrição/caption
 * @param {Array}  args.imagens - [{base64, mimetype}]
 * @param {Object} args.pdf     - {base64}
 * @returns {Promise<{ok: boolean, motivo?: string}>}
 *   - {ok: true}    se processou (sucesso OU pergunta pendente OU not_boleto desviou)
 *   - {ok: false}   se erro técnico (pra webhook decidir fallback proxy n8n)
 */
export async function handleFinanceiroBoleto({ empresa, numero, texto, imagens, pdf }) {
    const userId = empresa.user_id || empresa._supabaseUserId;
    if (!userId) {
        logger.warn({ empresaId: empresa.id }, "financeiro-boleto: empresa sem user_id Supabase");
        await enviarTexto(numero,
            "💰 Pra eu cadastrar boleto, preciso que sua empresa esteja completa no painel. Acessa pacnobolso.com.br e termina em 2 minutos."
        );
        return { ok: true };
    }

    const extracao = await extrairBoleto({ texto, imagens, pdf });

    // Não é boleto — devolve pra webhook tentar outro handler (proxy n8n)
    if (extracao.status === "not_boleto") {
        logger.info(
            { motivo: extracao.motivo },
            "financeiro-boleto: não é boleto, desviando"
        );
        return { ok: false, motivo: "not_boleto" };
    }

    // Faltou info — pergunta de forma amigável
    if (extracao.status === "incomplete") {
        if (extracao.campos_faltantes?.includes("__erro_tecnico__")) {
            return { ok: false, motivo: "erro_tecnico" };
        }
        const faltam = (extracao.campos_faltantes || []).join(", ");
        await enviarTexto(numero,
            `🤔 Vi seu boleto mas faltou: *${faltam}*. Manda foto mais nítida ou me passa por texto que eu pego.`
        );
        return { ok: true };
    }

    // Status ok → insert
    try {
        const { error } = await supabase
            .from("poupeja_payables")
            .insert({
                user_id: userId,
                amount: Number(extracao.amount),
                description: extracao.description,
                entity_name: extracao.entity_name,
                due_date: extracao.due_date,
                category_id: null, // pode portar busca-categorias depois
                status: "pending",
            });

        if (error) {
            logger.error(
                { err: error.message, userId, extracao },
                "financeiro-boleto: erro inserindo poupeja_payables"
            );
            await enviarTexto(numero,
                "😬 Travei salvando seu boleto. Tenta de novo em 1 minutinho que eu resolvo."
            );
            return { ok: true }; // não devolve erro — já avisou o cliente
        }

        // Resumo da semana pra dar contexto
        const semana = await resumoSemana(userId);
        const sufixo = semana.quantidade > 1
            ? `\n\n📊 Você tem *${semana.quantidade} contas* a pagar essa semana — total ${fmtBRL(semana.total)}.`
            : "";

        await enviarTexto(numero,
            `💰 *Conta a pagar registrada!*\n` +
            `📝 ${extracao.description}\n` +
            `💵 ${fmtBRL(extracao.amount)}\n` +
            `🏢 ${extracao.entity_name}\n` +
            `📅 Vence ${fmtDataBR(extracao.due_date)}` +
            sufixo +
            `\n\n_Manda "já paguei ${extracao.description}" quando concluir._`
        );

        logger.info(
            {
                userId,
                amount: extracao.amount,
                entity: extracao.entity_name,
                due_date: extracao.due_date,
            },
            "financeiro-boleto: poupeja_payables inserido"
        );

        return { ok: true };
    } catch (err) {
        logger.error({ err: err.message }, "financeiro-boleto: exceção inesperada");
        return { ok: false, motivo: "exception" };
    }
}
