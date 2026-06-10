/**
 * src/handlers/agenda.js
 * Handler de intenção "consultar_agenda" — compromissos, lembretes, vencimentos.
 *
 * Sub-intenções suportadas (decididas por um mini-LLM dentro do handler):
 *   - consulta        : "o que tenho hoje", "minha agenda", "quando vence o cert"
 *   - criar_compromisso : "lembra de pagar o aluguel dia 5", "reunião com X amanhã 14h"
 *   - concluir_compromisso : "já paguei o aluguel", "fechei a reunião com Maria"
 *
 * Persistência: Supabase `poupeja_compromissos` (criada na sessão de 26/05).
 * Identificação do user: pelo emitente.user_id (FK).
 *
 * Se Supabase não estiver disponível (isEnabled=false), responde com fallback
 * amigável — não derruba o fluxo.
 */
import Anthropic from "@anthropic-ai/sdk";
import { supabase, isEnabled as supabaseEnabled } from "../supabase.js";
import { enviarTexto } from "../services/whatsapp.js";
import { logger } from "../utils/logger.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
// Default Haiku — sub-classificação simples (consulta vs criar vs concluir +
// extração de campos básicos). Override via env ANTHROPIC_MODEL_AGENDA.
const MODEL = process.env.ANTHROPIC_MODEL_AGENDA
    || "claude-haiku-4-5";

/**
 * System prompt do sub-classificador da agenda. Decide o tipo de operação e,
 * se for criação, extrai os campos do compromisso em linguagem do empresário.
 */
const AGENDA_SYSTEM_PROMPT = `Você processa mensagens de AGENDA/LEMBRETES de um empresário no WhatsApp.

A mensagem JÁ FOI CLASSIFICADA como "consultar_agenda" — agora você decide:

1. operacao = "consulta" — usuário quer SABER algo:
   - "o que tenho hoje", "minha agenda da semana"
   - "quando vence o certificado", "quanto falta pro DAS"

2. operacao = "criar" — usuário quer ADICIONAR um compromisso novo:
   - "lembra de pagar o aluguel dia 5"
   - "reunião com João amanhã às 14h"
   - "preciso pagar IPVA dia 30"
   Quando criar, EXTRAIA os campos:
   - titulo: nome curto ("Aluguel", "Reunião com João", "IPVA")
   - categoria: "pagamento" | "imposto" | "recebimento" | "vencimento_doc" | "reuniao" | "tarefa"
   - data_proxima: "YYYY-MM-DD" — calcule a partir do hoje
   - hora_proxima: "HH:MM" ou null se não tem horário
   - valor: número decimal ou null
   - recorrencia: "nenhuma" | "semanal" | "mensal" | "anual"
   - dia_recorrente: 1-31 ou null (se recorrencia=mensal)

3. operacao = "concluir" — usuário disse que FEZ algo:
   - "já paguei o aluguel"
   - "fechei a reunião com Maria"
   Você devolve um titulo aproximado pra eu achar o compromisso ativo.

DEVOLVA APENAS o JSON:

{
  "operacao": "consulta" | "criar" | "concluir",
  "filtro_consulta": "hoje" | "amanha" | "semana" | "mes" | "todos" | null,
  "compromisso": null OU {
    "titulo": "...",
    "categoria": "...",
    "data_proxima": "YYYY-MM-DD",
    "hora_proxima": "HH:MM" | null,
    "valor": number | null,
    "recorrencia": "...",
    "dia_recorrente": number | null
  },
  "titulo_aproximado": "string ou null (só pra concluir)",
  "resposta_amigavel": "1-2 frases pro WhatsApp confirmando o que vai fazer"
}`;

/**
 * Sub-classifica a operação dentro de "consultar_agenda".
 */
async function classificarOperacaoAgenda(texto) {
    const t0 = Date.now();
    const today = new Date().toISOString().slice(0, 10);
    const userText = `DATA DE HOJE: ${today}\n\nMENSAGEM:\n${texto}`;

    try {
        const response = await client.messages.create({
            model: MODEL,
            max_tokens: 512,
            system: AGENDA_SYSTEM_PROMPT,
            messages: [{ role: "user", content: userText }],
        });

        let raw = response.content[0].text.trim();
        raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
        const data = JSON.parse(raw);

        logger.info({ operacao: data.operacao, latenciaMs: Date.now() - t0 }, "agenda sub-class");
        return data;
    } catch (err) {
        logger.error({ err: err.message }, "agenda: erro sub-classificador");
        return {
            operacao: "consulta",
            filtro_consulta: "hoje",
            compromisso: null,
            titulo_aproximado: null,
            resposta_amigavel: "Tive um problema entendendo. Pode me dizer o que quer fazer? (ver agenda / criar lembrete / marcar como feito)",
        };
    }
}

// ───────────────────────────────────────────────────────────────────
// CRUD compromissos via Supabase
// ───────────────────────────────────────────────────────────────────

/**
 * Lista compromissos ativos do user (dono da empresa).
 * @param {string} userId - UUID do user (do emitente.user_id no Supabase)
 * @param {string} filtro - "hoje" | "amanha" | "semana" | "mes" | "todos"
 */
async function listarCompromissos(userId, filtro) {
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);

    let dataFim = new Date(hoje);
    if (filtro === "hoje") dataFim.setDate(dataFim.getDate() + 1);
    else if (filtro === "amanha") {
        hoje.setDate(hoje.getDate() + 1);
        dataFim = new Date(hoje);
        dataFim.setDate(dataFim.getDate() + 1);
    } else if (filtro === "semana") dataFim.setDate(dataFim.getDate() + 7);
    else if (filtro === "mes") dataFim.setMonth(dataFim.getMonth() + 1);
    else dataFim.setFullYear(dataFim.getFullYear() + 1); // "todos" = próximo ano

    const dataIni = hoje.toISOString().slice(0, 10);
    const dataFimStr = dataFim.toISOString().slice(0, 10);

    const { data, error } = await supabase
        .from("poupeja_compromissos")
        .select("*")
        .eq("user_id", userId)
        .eq("ativo", true)
        .gte("data_proxima", dataIni)
        .lt("data_proxima", dataFimStr)
        .order("data_proxima", { ascending: true })
        .limit(20);

    if (error) throw new Error(`Supabase listar: ${error.message}`);
    return data || [];
}

/**
 * Cria compromisso novo.
 */
async function criarCompromisso(userId, emitenteId, compromisso) {
    const payload = {
        user_id: userId,
        emitente_id: emitenteId,
        titulo: compromisso.titulo,
        categoria: compromisso.categoria || "tarefa",
        valor: compromisso.valor,
        data_proxima: compromisso.data_proxima,
        hora_proxima: compromisso.hora_proxima,
        recorrencia: compromisso.recorrencia || "nenhuma",
        dia_recorrente: compromisso.dia_recorrente,
        alertar_dias_antes: [1, 0],
        ativo: true,
    };

    const { data, error } = await supabase
        .from("poupeja_compromissos")
        .insert(payload)
        .select()
        .single();

    if (error) throw new Error(`Supabase criar: ${error.message}`);
    return data;
}

/**
 * Marca compromisso como concluído (busca o mais próximo do título aproximado).
 */
async function concluirCompromisso(userId, tituloAproximado) {
    // Busca por título com ilike (case-insensitive, contém)
    const { data: candidatos, error } = await supabase
        .from("poupeja_compromissos")
        .select("*")
        .eq("user_id", userId)
        .eq("ativo", true)
        .ilike("titulo", `%${tituloAproximado}%`)
        .order("data_proxima", { ascending: true })
        .limit(5);

    if (error) throw new Error(`Supabase buscar: ${error.message}`);
    if (!candidatos || candidatos.length === 0) return null;

    const compromisso = candidatos[0];

    // Se recorrente, avança data_proxima; se não, marca ativo=false
    if (compromisso.recorrencia === "nenhuma") {
        const { error: upErr } = await supabase
            .from("poupeja_compromissos")
            .update({ ativo: false, concluido_em: new Date().toISOString() })
            .eq("id", compromisso.id);
        if (upErr) throw new Error(`Supabase concluir: ${upErr.message}`);
    } else {
        const proxima = calcularProximaData(
            compromisso.data_proxima,
            compromisso.recorrencia,
            compromisso.dia_recorrente
        );
        const { error: upErr } = await supabase
            .from("poupeja_compromissos")
            .update({ data_proxima: proxima, concluido_em: null })
            .eq("id", compromisso.id);
        if (upErr) throw new Error(`Supabase reagendar: ${upErr.message}`);
    }

    return compromisso;
}

/**
 * Recorrência: avança a data conforme o tipo (espelha o helper do frontend).
 */
function calcularProximaData(dataAtual, recorrencia, diaRecorrente) {
    const d = new Date(dataAtual + "T00:00:00");
    if (recorrencia === "semanal") d.setDate(d.getDate() + 7);
    else if (recorrencia === "mensal") {
        d.setMonth(d.getMonth() + 1);
        if (diaRecorrente && diaRecorrente >= 1 && diaRecorrente <= 31) {
            const ultimoDia = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
            d.setDate(Math.min(diaRecorrente, ultimoDia));
        }
    } else if (recorrencia === "anual") d.setFullYear(d.getFullYear() + 1);
    return d.toISOString().slice(0, 10);
}

// ───────────────────────────────────────────────────────────────────
// Formatação de resposta
// ───────────────────────────────────────────────────────────────────

function formatarListaCompromissos(compromissos, filtro) {
    if (!compromissos.length) {
        const filtroTxt = filtro === "hoje" ? "pra hoje" : filtro === "amanha" ? "pra amanhã"
            : filtro === "semana" ? "pra essa semana" : filtro === "mes" ? "pra esse mês" : "ativo agora";
        return `📅 Nada ${filtroTxt}. Tá tudo em dia!`;
    }

    const fmtData = (d) => {
        const dt = new Date(d + "T00:00:00");
        return dt.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
    };
    const fmtValor = (v) => v ? ` — R$ ${Number(v).toFixed(2).replace(".", ",")}` : "";

    const linhas = compromissos.map((c) => {
        const hora = c.hora_proxima ? ` ${c.hora_proxima.slice(0, 5)}` : "";
        return `• ${fmtData(c.data_proxima)}${hora} — ${c.titulo}${fmtValor(c.valor)}`;
    });

    const titulo = filtro === "hoje" ? "🗓️ Hoje" : filtro === "amanha" ? "🗓️ Amanhã"
        : filtro === "semana" ? "🗓️ Próximos 7 dias" : "🗓️ Sua agenda";
    return `${titulo}:\n\n${linhas.join("\n")}`;
}

// ───────────────────────────────────────────────────────────────────
// Entry point
// ───────────────────────────────────────────────────────────────────

/**
 * Processa uma intenção "consultar_agenda".
 *
 * @param {Object} args
 * @param {Object} args.empresa - empresa identificada no webhook
 * @param {string} args.numero - whatsapp do user
 * @param {string} args.texto - texto extraído (mensagem ou transcrição)
 * @returns {Promise<void>}
 */
export async function handleAgenda({ empresa, numero, texto }) {
    if (!supabaseEnabled()) {
        await enviarTexto(numero,
            "📅 A agenda ainda não está disponível por aqui. Em breve! Por enquanto, posso te ajudar com emissão de nota."
        );
        return;
    }

    if (!texto || !texto.trim()) {
        await enviarTexto(numero,
            "📅 Me diga o que quer fazer na agenda: ver compromissos, criar lembrete ou marcar como feito?"
        );
        return;
    }

    // Empresa do Supabase tem _supabaseId (UUID). Empresa SQLite não tem.
    // Pro user_id (pra RLS implícita no Supabase), precisamos do user dono.
    const userId = empresa.user_id || empresa._supabaseUserId;
    if (!userId) {
        logger.warn({ empresaId: empresa.id }, "agenda: empresa sem user_id Supabase");
        await enviarTexto(numero,
            "📅 Sua empresa ainda não está totalmente configurada pra agenda. Acesse o painel pra ativar."
        );
        return;
    }

    const op = await classificarOperacaoAgenda(texto);

    try {
        if (op.operacao === "consulta") {
            const filtro = op.filtro_consulta || "hoje";
            const lista = await listarCompromissos(userId, filtro);
            await enviarTexto(numero, formatarListaCompromissos(lista, filtro));
            return;
        }

        if (op.operacao === "criar" && op.compromisso) {
            const criado = await criarCompromisso(
                userId,
                empresa._supabaseId || null,
                op.compromisso
            );
            const dataFmt = new Date(criado.data_proxima + "T00:00:00")
                .toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
            await enviarTexto(numero,
                `✅ Anotado: *${criado.titulo}* em ${dataFmt}` +
                (criado.recorrencia !== "nenhuma" ? ` (repete ${criado.recorrencia})` : "") +
                `. Vou te lembrar.`
            );
            return;
        }

        if (op.operacao === "concluir" && op.titulo_aproximado) {
            const concluido = await concluirCompromisso(userId, op.titulo_aproximado);
            if (!concluido) {
                await enviarTexto(numero,
                    `🔍 Não achei nenhum compromisso ativo com "${op.titulo_aproximado}". Tenta de novo com outras palavras?`
                );
            } else {
                const sufixo = concluido.recorrencia !== "nenhuma"
                    ? ` Já agendei o próximo pra ${concluido.recorrencia === "mensal" ? "o mês que vem" : "a próxima"}.`
                    : "";
                await enviarTexto(numero,
                    `✅ Marquei *${concluido.titulo}* como feito.${sufixo}`
                );
            }
            return;
        }

        // Fallback: resposta amigável do sub-classificador
        await enviarTexto(numero,
            op.resposta_amigavel ||
            "📅 Não entendi sua solicitação de agenda. Pode reformular?"
        );
    } catch (err) {
        logger.error({ err: err.message, op }, "agenda: erro processando operação");
        await enviarTexto(numero,
            "📅 Tive um problema técnico com sua agenda. Tenta de novo em 1 minuto?"
        );
    }
}
