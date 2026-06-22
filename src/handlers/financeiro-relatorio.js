/**
 * src/handlers/financeiro-relatorio.js
 * Gera relatório financeiro consolidado a partir do que está em
 * poupeja_transactions + poupeja_payables.
 *
 * Disparado quando o classificador retorna intencao=relatorio_financeiro
 * (palavras-chave: "relatorio", "resumo do mês", "quanto gastei", "balanço",
 *  "extrato", "fluxo de caixa", "como tô financeiramente").
 *
 * Período: tenta inferir do texto via regex (mês passado / semana / hoje
 * / ontem / ano). Default = mês corrente. Em BRT.
 *
 * Output: texto formatado pro WhatsApp com:
 *   - Período coberto
 *   - Total receitas / total despesas / saldo
 *   - Top categorias de gasto
 *   - Contas a pagar pendentes do período
 */
import { supabase } from "../supabase.js";
import { enviarTexto } from "../services/whatsapp.js";
import { logger } from "../utils/logger.js";

function fmtBRL(v) {
    return Number(v || 0).toLocaleString("pt-BR", {
        style: "currency",
        currency: "BRL",
    });
}

function fmtDataBR(iso) {
    if (!iso) return "-";
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

function hojeBRT() {
    const fmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Sao_Paulo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    });
    return fmt.format(new Date());
}

/**
 * Detecta o período a partir do texto. Retorna { inicio, fim, label }.
 * Default = mês corrente em BRT.
 */
function detectarPeriodo(texto) {
    const t = (texto || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    const hoje = hojeBRT();
    const [ano, mes] = hoje.split("-").map(Number);

    if (/(hoje|do dia)\b/.test(t)) {
        return { inicio: hoje, fim: hoje, label: "hoje" };
    }

    if (/\b(ontem)\b/.test(t)) {
        const d = new Date(`${hoje}T12:00:00`);
        d.setDate(d.getDate() - 1);
        const ontem = d.toISOString().slice(0, 10);
        return { inicio: ontem, fim: ontem, label: "ontem" };
    }

    if (/\b(semana|7 dias|ultim[oa]s? 7|ult\. ?7)\b/.test(t)) {
        const d = new Date(`${hoje}T12:00:00`);
        d.setDate(d.getDate() - 6);
        return {
            inicio: d.toISOString().slice(0, 10),
            fim: hoje,
            label: "últimos 7 dias",
        };
    }

    if (/\b(mes passado|ultimo mes|mes anterior)\b/.test(t)) {
        const mesPrev = mes === 1 ? 12 : mes - 1;
        const anoPrev = mes === 1 ? ano - 1 : ano;
        const inicio = `${anoPrev}-${String(mesPrev).padStart(2, "0")}-01`;
        const ultimoDia = new Date(anoPrev, mesPrev, 0).getDate();
        const fim = `${anoPrev}-${String(mesPrev).padStart(2, "0")}-${String(ultimoDia).padStart(2, "0")}`;
        return { inicio, fim, label: `${String(mesPrev).padStart(2, "0")}/${anoPrev}` };
    }

    if (/\b(ano|12 meses)\b/.test(t)) {
        return {
            inicio: `${ano}-01-01`,
            fim: `${ano}-12-31`,
            label: `${ano}`,
        };
    }

    // Default: mês corrente
    const inicio = `${ano}-${String(mes).padStart(2, "0")}-01`;
    const ultimoDia = new Date(ano, mes, 0).getDate();
    const fim = `${ano}-${String(mes).padStart(2, "0")}-${String(ultimoDia).padStart(2, "0")}`;
    return { inicio, fim, label: `${String(mes).padStart(2, "0")}/${ano}` };
}

async function buscarTransacoes(userId, inicio, fim) {
    const { data, error } = await supabase
        .from("poupeja_transactions")
        .select("amount, description, date, type, category_id, poupeja_categories(name)")
        .eq("user_id", userId)
        .gte("date", inicio)
        .lte("date", fim)
        .order("date", { ascending: false })
        .limit(500);
    if (error) {
        logger.warn({ err: error.message }, "financeiro-relatorio: erro buscando transações");
        return [];
    }
    return data || [];
}

async function buscarPayablesPendentes(userId, inicio, fim) {
    const { data, error } = await supabase
        .from("poupeja_payables")
        .select("amount, description, due_date, entity_name, status")
        .eq("user_id", userId)
        .eq("status", "pending")
        .gte("due_date", inicio)
        .lte("due_date", fim)
        .order("due_date", { ascending: true })
        .limit(50);
    if (error) {
        logger.warn({ err: error.message }, "financeiro-relatorio: erro buscando payables");
        return [];
    }
    return data || [];
}

function agruparPorCategoria(transacoes, type) {
    const grupos = {};
    for (const t of transacoes) {
        if (t.type !== type) continue;
        const nome = t.poupeja_categories?.name || "Sem categoria";
        if (!grupos[nome]) grupos[nome] = { total: 0, qtd: 0 };
        grupos[nome].total += Number(t.amount || 0);
        grupos[nome].qtd += 1;
    }
    return Object.entries(grupos)
        .map(([nome, dados]) => ({ nome, ...dados }))
        .sort((a, b) => b.total - a.total);
}

/**
 * @param {object} args
 * @param {object} args.empresa
 * @param {string} args.numero  - whatsapp do user (5562...)
 * @param {string} args.texto   - texto/transcrição
 */
export async function handleRelatorioFinanceiro({ empresa, numero, texto }) {
    const userId = empresa?._supabaseUserId;
    if (!userId) {
        await enviarTexto(
            numero,
            "Não consegui identificar sua conta. Tenta de novo daqui a pouco."
        );
        return { ok: false, motivo: "sem_user_id" };
    }

    const periodo = detectarPeriodo(texto);
    const [transacoes, payablesPendentes] = await Promise.all([
        buscarTransacoes(userId, periodo.inicio, periodo.fim),
        buscarPayablesPendentes(userId, periodo.inicio, periodo.fim),
    ]);

    const receitas = transacoes.filter((t) => t.type === "income");
    const despesas = transacoes.filter((t) => t.type === "expense");
    const totalReceitas = receitas.reduce((s, t) => s + Number(t.amount || 0), 0);
    const totalDespesas = despesas.reduce((s, t) => s + Number(t.amount || 0), 0);
    const saldo = totalReceitas - totalDespesas;
    const totalPayables = payablesPendentes.reduce((s, p) => s + Number(p.amount || 0), 0);

    // Se não há NADA, manda mensagem curta em vez de relatório vazio.
    if (transacoes.length === 0 && payablesPendentes.length === 0) {
        await enviarTexto(
            numero,
            `📊 *Relatório — ${periodo.label}*\n\nNenhuma movimentação registrada nesse período ainda. Manda foto de boleto, pix, ou um áudio descrevendo e eu registro pra você.`
        );
        return { ok: true, vazio: true };
    }

    const categoriasDespesa = agruparPorCategoria(transacoes, "expense");
    const categoriasReceita = agruparPorCategoria(transacoes, "income");

    const partes = [];
    partes.push(`📊 *Relatório financeiro — ${periodo.label}*`);
    partes.push("");
    partes.push(`💰 Receitas: *${fmtBRL(totalReceitas)}*  (${receitas.length})`);
    partes.push(`💸 Despesas: *${fmtBRL(totalDespesas)}*  (${despesas.length})`);
    const emoji = saldo >= 0 ? "✅" : "🔴";
    partes.push(`${emoji} Saldo: *${fmtBRL(saldo)}*`);

    if (categoriasDespesa.length > 0) {
        partes.push("");
        partes.push("*Gastos por categoria:*");
        for (const c of categoriasDespesa.slice(0, 8)) {
            const pct = totalDespesas > 0 ? Math.round((c.total / totalDespesas) * 100) : 0;
            partes.push(`• ${c.nome} — ${fmtBRL(c.total)} (${pct}%, ${c.qtd}x)`);
        }
        const restante = categoriasDespesa.length - 8;
        if (restante > 0) partes.push(`_…e mais ${restante} categoria(s)_`);
    }

    if (categoriasReceita.length > 0) {
        partes.push("");
        partes.push("*Receitas por categoria:*");
        for (const c of categoriasReceita.slice(0, 5)) {
            partes.push(`• ${c.nome} — ${fmtBRL(c.total)} (${c.qtd}x)`);
        }
    }

    if (payablesPendentes.length > 0) {
        partes.push("");
        partes.push(`💳 *Contas a pagar pendentes no período* (${payablesPendentes.length}):`);
        for (const p of payablesPendentes.slice(0, 6)) {
            const fornec = p.entity_name ? ` — ${p.entity_name}` : "";
            partes.push(`• ${fmtDataBR(p.due_date)} — ${p.description}${fornec} — ${fmtBRL(p.amount)}`);
        }
        const restante = payablesPendentes.length - 6;
        if (restante > 0) partes.push(`_…e mais ${restante}_`);
        partes.push(`💰 Total pendente: *${fmtBRL(totalPayables)}*`);
    }

    partes.push("");
    partes.push("_Pede *\"relatório do mês passado\"* ou *\"da semana\"* pra outros períodos._");

    await enviarTexto(numero, partes.join("\n"));
    return { ok: true };
}
