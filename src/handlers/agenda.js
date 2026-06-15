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
import {
    criarEventoGoogle,
    excluirEventoGoogle,
    atualizarEventoGoogle,
} from "../services/google-calendar.js";
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
   - titulo: nome curto COMEÇANDO com um emoji semântico relevante (ex:
     "💸 Aluguel", "🦷 Dentista", "📞 Reunião com João", "🚗 IPVA",
     "📄 DAS", "🛂 Renovar CNH", "🔐 Cert digital"). Escolha o emoji que
     melhor representa visualmente. Apenas 1 emoji no início.
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

VOZ NA resposta_amigavel:
   - Direto, brasileiro, sem floreio.
   - Tom de secretário esperto que entende o negócio (não robô).
   - Confirma a ação e dá próximo passo.
   - 1-2 frases, no máximo 1 emoji extra (além do título).

DEVOLVA APENAS o JSON:

{
  "operacao": "consulta" | "criar" | "concluir",
  "filtro_consulta": "hoje" | "amanha" | "semana" | "mes" | "todos" | null,
  "compromisso": null OU {
    "titulo": "emoji + nome curto",
    "categoria": "...",
    "data_proxima": "YYYY-MM-DD",
    "hora_proxima": "HH:MM" | null,
    "valor": number | null,
    "recorrencia": "...",
    "dia_recorrente": number | null
  },
  "titulo_aproximado": "string ou null (só pra concluir)",
  "resposta_amigavel": "frase curta confirmando o que vai fazer"
}`;

/**
 * Sub-classifica a operação dentro de "consultar_agenda".
 */
async function classificarOperacaoAgenda(texto) {
    const t0 = Date.now();
    const today = new Date().toISOString().slice(0, 10);
    const hojeBR = new Date().toLocaleDateString("pt-BR", {
        weekday: "long",
        day: "2-digit",
        month: "long",
        year: "numeric",
    });
    // Injeta data atual + instrução EXPLÍCITA pra LLM não chutar.
    // Sem isso o modelo às vezes inventa datas aleatórias quando o usuário
    // não especifica (ex: "lembra do aluguel" sem mencionar data).
    const userText =
        `DATA DE HOJE: ${today} (${hojeBR})\n` +
        `Use SEMPRE essa data como referência. "amanhã" = ${today} +1d, ` +
        `"semana que vem" = ${today} +7d, "todo dia 5" = próximo dia 5 a partir de hoje. ` +
        `Se NÃO mencionar data NENHUMA, use ${today}. NUNCA invente data fora desse contexto.\n\n` +
        `MENSAGEM:\n${texto}`;

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
 * Cria compromisso novo. Após salvar no Supabase, faz push pro Google
 * Calendar do user (se conectado). Falha do Google não bloqueia.
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

    // Push pro Google Calendar (silencioso — falha não derruba o fluxo)
    try {
        const googleEventId = await criarEventoGoogle(userId, data);
        if (googleEventId) {
            await supabase
                .from("poupeja_compromissos")
                .update({ google_event_id: googleEventId })
                .eq("id", data.id);
            data.google_event_id = googleEventId;
        }
    } catch (err) {
        logger.warn({ err: err.message, compromissoId: data.id }, "agenda: falha sync Google");
    }

    return data;
}

/**
 * Marca compromisso como concluído (busca o mais próximo do título aproximado).
 * Sync Google: se único, exclui evento; se recorrente, atualiza pra próxima
 * data. Falha do Google não bloqueia.
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

        // Apaga do Google (compromisso terminou)
        if (compromisso.google_event_id) {
            try {
                await excluirEventoGoogle(userId, compromisso.google_event_id);
            } catch (err) {
                logger.warn({ err: err.message }, "agenda: falha excluindo evento Google");
            }
        }
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

        // Compromisso recorrente: o Google já trata RRULE, não precisa
        // alterar o evento. A próxima ocorrência aparece automática.
        compromisso.data_proxima = proxima;
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
        if (filtro === "hoje") return "☀️ Tá tudo em dia, chefe. Hoje não tem nada. Aproveita.";
        if (filtro === "amanha") return "📭 Amanhã tá livre. Folga merecida.";
        if (filtro === "semana") return "🎯 Semana limpa por enquanto. Manda \"lembra de X\" se quiser anotar algo.";
        if (filtro === "mes") return "📭 Mês ainda sem nada anotado. Manda \"lembra de X\" pra eu adicionar.";
        return "🎯 Sem compromissos ativos no momento.";
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

    const titulo = filtro === "hoje" ? "📅 *Sua agenda de hoje*"
        : filtro === "amanha" ? "📅 *Amanhã*"
        : filtro === "semana" ? "📅 *Próximos 7 dias*"
        : "📅 *Sua agenda*";
    return `${titulo}\n\n${linhas.join("\n")}\n\n_Manda "já paguei X" quando concluir._`;
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
            "📅 A agenda tá em manutenção por aqui. Volta em alguns minutos, ou manda áudio/foto se for emitir nota — isso eu já consigo."
        );
        return;
    }

    if (!texto || !texto.trim()) {
        await enviarTexto(numero,
            "📅 Me fala o que precisa: *\"o que tenho hoje\"*, *\"lembra de pagar X dia Y\"* ou *\"já paguei o Z\"*."
        );
        return;
    }

    // Empresa do Supabase tem _supabaseId (UUID). Empresa SQLite não tem.
    // Pro user_id (pra RLS implícita no Supabase), precisamos do user dono.
    const userId = empresa.user_id || empresa._supabaseUserId;
    if (!userId) {
        logger.warn({ empresaId: empresa.id }, "agenda: empresa sem user_id Supabase");
        await enviarTexto(numero,
            "📅 Tô vendo aqui que sua empresa precisa terminar o cadastro no painel pra eu ativar sua agenda. Acessa pacnobolso.com.br/fiscal e completa em 2 minutos."
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
                .toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
            const recorrenciaTxt =
                criado.recorrencia === "mensal" ? " (todo mês)" :
                criado.recorrencia === "semanal" ? " (toda semana)" :
                criado.recorrencia === "anual" ? " (todo ano)" : "";
            await enviarTexto(numero,
                `📝 Anotado! *${criado.titulo}* no dia ${dataFmt}${recorrenciaTxt}. ` +
                `Te chamo aqui quando estiver chegando. 💪`
            );
            return;
        }

        if (op.operacao === "concluir" && op.titulo_aproximado) {
            const concluido = await concluirCompromisso(userId, op.titulo_aproximado);
            if (!concluido) {
                await enviarTexto(numero,
                    `🤔 Não achei "${op.titulo_aproximado}" na sua agenda ativa. Tenta com outras palavras, ou manda "minha agenda" pra ver o que tem cadastrado.`
                );
            } else {
                if (concluido.recorrencia !== "nenhuma") {
                    const proximaFmt = new Date(concluido.data_proxima + "T00:00:00")
                        .toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
                    await enviarTexto(numero,
                        `✅ Boa! *${concluido.titulo}* feito. Já marquei o próximo pra ${proximaFmt}.`
                    );
                } else {
                    await enviarTexto(numero,
                        `✅ Pode descansar: *${concluido.titulo}* concluído. 🎯`
                    );
                }
            }
            return;
        }

        // Fallback: resposta amigável do sub-classificador
        await enviarTexto(numero,
            op.resposta_amigavel ||
            `🤔 Não peguei o que você quer fazer. Manda algo tipo *"o que tenho hoje"*, *"lembra de pagar X dia 5"* ou *"já paguei X"*.`
        );
    } catch (err) {
        logger.error({ err: err.message, op }, "agenda: erro processando operação");
        await enviarTexto(numero,
            "😬 Travei aqui agora. Tenta de novo em 1 minutinho que eu resolvo."
        );
    }
}
