/**
 * src/handlers/financeiro-extrato.js
 * Handler do sub-fluxo de EXTRATO BANCÁRIO (PDF ou foto com várias
 * transações em lote).
 *
 * Substitui o sub-fluxo "Extract from File → IA Extrair Transações →
 * Split Out → Create a row → Aggregate → Enviar Resumo" do n8n.
 *
 * Fluxo:
 *   1. extrairExtrato(input) — Claude Vision/PDF parseia tabela
 *   2. Pra cada transação extraída, normaliza e checa dedup (mesma data,
 *      valor, descrição similar nos últimos 30 dias).
 *   3. INSERT em batch das transações NOVAS em poupeja_transactions.
 *   4. Manda resumo "📊 N novas, X duplicadas puladas. Entradas/saídas/saldo."
 */
import { supabase } from "../supabase.js";
import { enviarTexto } from "../services/whatsapp.js";
import { extrairExtrato } from "../services/financeiro-extractor.js";
import { logger } from "../utils/logger.js";

function fmtBRL(v) {
    return Number(v).toLocaleString("pt-BR", {
        style: "currency",
        currency: "BRL",
    });
}

/**
 * Normaliza string pra comparação de dedup.
 * Lowercase, remove acentos, remove espaços extras.
 */
function normDesc(s) {
    return String(s || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "") // tira acentos
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Busca transações do user nos últimos N dias pra checar dedup.
 */
async function buscarTransacoesRecentes(userId, dias = 30) {
    const limite = new Date();
    limite.setDate(limite.getDate() - dias);
    const limiteISO = limite.toISOString().slice(0, 10);

    const { data, error } = await supabase
        .from("poupeja_transactions")
        .select("date, amount, description, type")
        .eq("user_id", userId)
        .gte("date", limiteISO);

    if (error) {
        logger.warn(
            { err: error.message, userId },
            "financeiro-extrato: erro buscando transações pra dedup"
        );
        return [];
    }
    return (data || []).map((r) => ({
        date: r.date,
        amount: Number(r.amount),
        desc: normDesc(r.description),
        type: r.type,
    }));
}

/**
 * Decide se uma transação extraída do extrato já existe no banco.
 * Critério: mesma data + mesmo valor (tolerância 0.01) + descrição
 * normalizada idêntica OU uma contém a outra (substring).
 */
function jaExiste(tNova, existentes) {
    const descNova = normDesc(tNova.descricao);
    for (const e of existentes) {
        if (e.date !== tNova.data) continue;
        if (Math.abs(e.amount - Number(tNova.valor)) > 0.01) continue;
        if (e.desc === descNova) return true;
        if (descNova.length >= 6 && (e.desc.includes(descNova) || descNova.includes(e.desc))) {
            return true;
        }
    }
    return false;
}

export async function handleFinanceiroExtrato({ empresa, numero, texto, imagens, pdf }) {
    const userId = empresa.user_id || empresa._supabaseUserId;
    if (!userId) {
        await enviarTexto(numero,
            "💰 Pra eu importar extrato, sua empresa precisa estar completa no painel."
        );
        return { ok: true };
    }

    // Aviso antecipado — extrato pode demorar uns segundos
    await enviarTexto(numero, "📊 Lendo seu extrato... me dá uns instantes.");

    const extracao = await extrairExtrato({ texto, imagens, pdf });

    if (extracao.status === "not_extrato") {
        logger.info(
            { motivo: extracao.motivo },
            "financeiro-extrato: não é extrato, desviando"
        );
        return { ok: false, motivo: "not_extrato" };
    }

    const transacoes = Array.isArray(extracao.transacoes) ? extracao.transacoes : [];
    if (transacoes.length === 0) {
        await enviarTexto(numero,
            "🤔 Não consegui identificar transações nessa imagem/PDF. Manda de novo com melhor qualidade?"
        );
        return { ok: true };
    }

    try {
        // Dedup: busca transações dos últimos 60 dias (cobre extrato mensal completo)
        const existentes = await buscarTransacoesRecentes(userId, 60);

        const novas = [];
        let duplicadas = 0;
        for (const t of transacoes) {
            // Validação básica
            const valor = Number(t.valor);
            if (!Number.isFinite(valor) || valor <= 0) continue;
            if (!t.data || !/^\d{4}-\d{2}-\d{2}$/.test(t.data)) continue;

            if (jaExiste(t, existentes)) {
                duplicadas++;
                continue;
            }

            novas.push({
                user_id: userId,
                date: t.data,
                description: t.descricao || "Transação importada",
                amount: valor,
                type: t.tipo === "D" ? "expense" : "income",
                category_id: null, // categoria fica como texto no description; portar busca-categorias depois
                status: "pendente",
            });
        }

        // Insert em batch
        if (novas.length > 0) {
            const { error } = await supabase
                .from("poupeja_transactions")
                .insert(novas);

            if (error) {
                logger.error(
                    { err: error.message, qtd: novas.length, userId },
                    "financeiro-extrato: erro no insert batch"
                );
                await enviarTexto(numero,
                    "😬 Travei salvando seu extrato. Tenta de novo em 1 minutinho."
                );
                return { ok: true };
            }
        }

        // Totais (das NOVAS — não inclui duplicadas)
        const entradas = novas.filter((n) => n.type === "income")
            .reduce((s, n) => s + Number(n.amount), 0);
        const saidas = novas.filter((n) => n.type === "expense")
            .reduce((s, n) => s + Number(n.amount), 0);
        const saldo = entradas - saidas;

        const linhaDup = duplicadas > 0
            ? `\n_(${duplicadas} já estavam registradas, pulei)_`
            : "";

        await enviarTexto(numero,
            `📊 *Extrato importado!*\n\n` +
            `✅ ${novas.length} novas transações${linhaDup}\n\n` +
            `💚 Entradas: *${fmtBRL(entradas)}*\n` +
            `💸 Saídas: *${fmtBRL(saidas)}*\n` +
            `${saldo >= 0 ? "📈" : "📉"} Saldo: *${fmtBRL(saldo)}*\n\n` +
            `Tudo organizado no painel pacnobolso.com.br 🚀`
        );

        logger.info(
            {
                userId,
                qtdNovas: novas.length,
                qtdDuplicadas: duplicadas,
                entradas,
                saidas,
            },
            "financeiro-extrato: extrato processado"
        );

        return { ok: true };
    } catch (err) {
        logger.error({ err: err.message }, "financeiro-extrato: exceção inesperada");
        return { ok: false, motivo: "exception" };
    }
}
