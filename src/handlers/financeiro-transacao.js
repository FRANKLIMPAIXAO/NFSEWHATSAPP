/**
 * src/handlers/financeiro-transacao.js
 * Handler do sub-fluxo de TRANSAÇÃO JÁ REALIZADA — Pix, comprovante,
 * texto "paguei X", áudio idem.
 *
 * Substitui os tools "cadastro-despesa" e "cadastro-receita" do AI Agent
 * do n8n. Tipo (income/expense) é detectado pelo Claude no extrator
 * cruzando texto + CNPJ da empresa (se o Pix foi PRA empresa = income,
 * SAIU da empresa = expense).
 *
 * Fluxo:
 *   1. extrairTransacao(input, empresa) — Claude lê e classifica
 *   2. status=ok → insert poupeja_transactions → resposta com acumulado
 *      mensal da categoria detectada.
 *   3. status=incomplete → pergunta amigável (já gerada pelo extractor).
 *   4. status=not_transacao → desvia (devolve {ok:false}).
 */
import { supabase } from "../supabase.js";
import { enviarTexto } from "../services/whatsapp.js";
import { extrairTransacao } from "../services/financeiro-extractor.js";
import { logger } from "../utils/logger.js";

function fmtBRL(v) {
    return Number(v).toLocaleString("pt-BR", {
        style: "currency",
        currency: "BRL",
    });
}

function fmtDataBR(iso) {
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

/**
 * Resolve o category_id a partir do nome textual (ex: "Alimentação").
 * Busca em poupeja_categories filtrado por user_id (do próprio user ou
 * default — user_id IS NULL).
 *
 * Retorna o id da categoria OU null se não achou (insert vai com null
 * mesmo — Categoria será atribuída depois pelo painel).
 */
async function resolverCategoryId(userId, nomeCategoria, type) {
    if (!nomeCategoria) return null;
    try {
        const { data, error } = await supabase
            .from("poupeja_categories")
            .select("id, name")
            .or(`user_id.eq.${userId},user_id.is.null`)
            .eq("type", type)
            .ilike("name", nomeCategoria);

        if (error) {
            logger.warn({ err: error.message }, "resolverCategoryId: erro Supabase");
            return null;
        }
        const match = (data || []).find(
            (c) => c.name?.toLowerCase() === nomeCategoria.toLowerCase()
        ) || (data || [])[0];
        return match?.id || null;
    } catch (err) {
        logger.warn({ err: err.message }, "resolverCategoryId: exceção");
        return null;
    }
}

/**
 * Calcula quanto o user já gastou/recebeu na MESMA categoria no mês
 * corrente. Inclui a transação que ACABOU de ser inserida (chamada
 * depois do insert).
 */
async function acumuladoMes(userId, categoryId, type) {
    if (!categoryId) return null;
    const hoje = new Date();
    const inicioMes = new Date(hoje.getFullYear(), hoje.getMonth(), 1)
        .toISOString().slice(0, 10);

    try {
        const { data, error } = await supabase
            .from("poupeja_transactions")
            .select("amount")
            .eq("user_id", userId)
            .eq("category_id", categoryId)
            .eq("type", type)
            .gte("date", inicioMes);

        if (error) {
            logger.warn({ err: error.message }, "acumuladoMes: erro Supabase");
            return null;
        }
        const total = (data || []).reduce((s, r) => s + Number(r.amount || 0), 0);
        const qtd = (data || []).length;
        return { total, qtd };
    } catch (err) {
        logger.warn({ err: err.message }, "acumuladoMes: exceção");
        return null;
    }
}

/**
 * Entry point — chamado quando classificador diz subtipo=pagamento_efetuado
 * ou recebimento ou outro (transação genérica).
 */
export async function handleFinanceiroTransacao({ empresa, numero, texto, imagens, pdf }) {
    const userId = empresa.user_id || empresa._supabaseUserId;
    if (!userId) {
        logger.warn({ empresaId: empresa.id }, "financeiro-transacao: empresa sem user_id");
        await enviarTexto(numero,
            "💰 Pra eu registrar essa movimentação, sua empresa precisa estar completa no painel. Acessa pacnobolso.com.br pra terminar o cadastro."
        );
        return { ok: true };
    }

    const extracao = await extrairTransacao({ texto, imagens, pdf, empresa });

    if (extracao.status === "not_transacao") {
        logger.info(
            { motivo: extracao.motivo },
            "financeiro-transacao: não é transação, desviando"
        );
        return { ok: false, motivo: "not_transacao" };
    }

    if (extracao.status === "incomplete") {
        if (extracao.campos_faltantes?.includes("__erro_tecnico__")) {
            return { ok: false, motivo: "erro_tecnico" };
        }
        const pergunta = extracao.pergunta ||
            `🤔 Faltou: *${(extracao.campos_faltantes || []).join(", ")}*. Me manda?`;
        await enviarTexto(numero, pergunta);
        return { ok: true };
    }

    // Status ok → insert
    try {
        const categoryId = await resolverCategoryId(
            userId,
            extracao.categoria_sugerida,
            extracao.type
        );

        const { error } = await supabase
            .from("poupeja_transactions")
            .insert({
                user_id: userId,
                amount: Number(extracao.amount),
                description: extracao.description,
                date: extracao.date || new Date().toISOString().slice(0, 10),
                type: extracao.type,
                category_id: categoryId,
                status: "pendente",
            });

        if (error) {
            logger.error(
                { err: error.message, userId, extracao },
                "financeiro-transacao: erro inserindo poupeja_transactions"
            );
            await enviarTexto(numero,
                "😬 Travei salvando sua transação. Tenta de novo em 1 minutinho que eu resolvo."
            );
            return { ok: true };
        }

        // Acumulado pra dar contexto na resposta
        const acumulado = await acumuladoMes(userId, categoryId, extracao.type);

        const tipoEmoji = extracao.type === "income" ? "💚" : "💸";
        const tipoLabel = extracao.type === "income" ? "Receita" : "Despesa";
        const categoriaTxt = extracao.categoria_sugerida && categoryId
            ? `\n🏷️ ${extracao.categoria_sugerida}`
            : "";

        let sufixoAcumulado = "";
        if (acumulado && acumulado.qtd > 1) {
            const verbo = extracao.type === "income" ? "recebeu" : "gastou";
            sufixoAcumulado = `\n\n📊 Você já ${verbo} *${fmtBRL(acumulado.total)}* em ${extracao.categoria_sugerida} esse mês (${acumulado.qtd} registros).`;
        }

        await enviarTexto(numero,
            `${tipoEmoji} *${tipoLabel} registrada!*\n` +
            `📝 ${extracao.description}\n` +
            `💵 ${fmtBRL(extracao.amount)}\n` +
            `📅 ${fmtDataBR(extracao.date)}` +
            categoriaTxt +
            sufixoAcumulado
        );

        logger.info(
            {
                userId,
                type: extracao.type,
                amount: extracao.amount,
                categoria: extracao.categoria_sugerida,
                categoryId,
            },
            "financeiro-transacao: poupeja_transactions inserido"
        );

        return { ok: true };
    } catch (err) {
        logger.error({ err: err.message }, "financeiro-transacao: exceção inesperada");
        return { ok: false, motivo: "exception" };
    }
}
