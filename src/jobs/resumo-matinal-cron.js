/**
 * src/jobs/resumo-matinal-cron.js
 * Cron diário que envia um resumo proativo da agenda pro empresário no
 * WhatsApp.
 *
 * Estratégia (inspirada no concorrente Meu Assessor): em vez de só responder
 * quando o cliente pergunta, o agent toma a iniciativa e abre o dia dele com
 * o panorama: compromissos de hoje, atrasados, próximos 7 dias, totais. É o
 * gancho de hábito — cliente acorda, abre o zap, já tem orientação.
 *
 * Quando dispara:
 *   - Segunda a sexta, 7h da manhã BRT (configurável).
 *   - Sábado e domingo pula por padrão (menos invasivo). Override via env.
 *
 * Quem recebe:
 *   - Usuários com pelo menos UM emitente cadastrado com whatsapp_dono.
 *   - Manda 1 mensagem por user (não 1 por empresa) usando o whatsapp_dono
 *     da empresa principal (is_default=true) ou da primeira encontrada.
 *
 * O que mostra:
 *   - 📅 Compromissos de hoje (com hora)
 *   - 🔴 Atrasados (data_proxima < hoje)
 *   - ⏰ Próximos 7 dias (preview, top 5)
 *   - 💰 Total a pagar hoje e na semana
 *
 * Não manda nada se o user não tem NENHUM compromisso ativo (evita spam pra
 * quem nem usa a agenda).
 *
 * Anti-spam: idempotência em memória dentro do mesmo processo. Se o container
 * reiniciar, é possível duplicar — risco baixo pra MVP (poucos users). Pode
 * migrar pra tabela poupeja_resumos_enviados se virar problema.
 *
 * Schedule: env RESUMO_MATINAL_CRON_EXPR (default "0 7 * * 1-5" = seg-sex 7h).
 * Desabilita via env RESUMO_MATINAL_CRON_ENABLED=false (default true).
 */
import cron from "node-cron";
import { supabase, isEnabled } from "../supabase.js";
import { enviarTexto } from "../services/whatsapp.js";
import { logger } from "../utils/logger.js";

const SCHEDULE_DEFAULT = "0 7 * * 1-5"; // seg-sex 7h
const TZ_DEFAULT = "America/Sao_Paulo";

// Idempotência em memória — chave: "userId:YYYY-MM-DD"
const enviadosNoDia = new Set();

function dataISOHoje(tz = "America/Sao_Paulo") {
    const fmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    });
    return fmt.format(new Date()); // YYYY-MM-DD em BRT
}

function dataMaisDias(iso, dias) {
    const d = new Date(iso + "T00:00:00");
    d.setDate(d.getDate() + dias);
    return d.toISOString().slice(0, 10);
}

function fmtDataBR(iso) {
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

function fmtValor(v) {
    if (v == null) return "";
    return Number(v).toLocaleString("pt-BR", {
        style: "currency",
        currency: "BRL",
    });
}

function diaDaSemana(iso) {
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("pt-BR", { weekday: "long" });
}

/**
 * Busca todos os users que têm pelo menos 1 emitente com whatsapp_dono.
 * Agrupa por user_id pra mandar 1 mensagem por user (não 1 por empresa).
 */
async function listarUsersComWhatsapp() {
    const { data, error } = await supabase
        .from("poupeja_fiscal_emitentes")
        .select("user_id, whatsapp_dono, nome_fantasia, nome, is_default")
        .not("whatsapp_dono", "is", null)
        .neq("whatsapp_dono", "");

    if (error) throw new Error(`listarUsersComWhatsapp: ${error.message}`);
    if (!data || data.length === 0) return [];

    // Agrupa por user_id, prioriza is_default=true
    const mapa = new Map();
    for (const row of data) {
        const existente = mapa.get(row.user_id);
        if (!existente || (row.is_default && !existente.is_default)) {
            mapa.set(row.user_id, row);
        }
    }
    return Array.from(mapa.values());
}

/**
 * Busca compromissos relevantes pro resumo de UM user.
 */
async function buscarCompromissosResumo(userId, hojeISO) {
    const limite7d = dataMaisDias(hojeISO, 7);

    const { data, error } = await supabase
        .from("poupeja_compromissos")
        .select("id, titulo, categoria, valor, data_proxima, hora_proxima")
        .eq("user_id", userId)
        .eq("ativo", true)
        .lte("data_proxima", limite7d)
        .order("data_proxima", { ascending: true })
        .limit(50);

    if (error) throw new Error(`buscarCompromissosResumo: ${error.message}`);
    return data || [];
}

/**
 * Busca contas a pagar do MÊS CORRENTE que ainda estão pendentes
 * (status = 'pending'). Inclui vencidas + futuras do mesmo mês.
 * Não inclui meses futuros — usuário pediu explicitamente "só do mês".
 */
async function buscarPayablesDoMes(userId, hojeISO) {
    const inicioMes = hojeISO.slice(0, 8) + "01";
    const ano = parseInt(hojeISO.slice(0, 4), 10);
    const mes = parseInt(hojeISO.slice(5, 7), 10);
    // Primeiro dia do mês seguinte (limite exclusivo)
    const proxAno = mes === 12 ? ano + 1 : ano;
    const proxMes = mes === 12 ? 1 : mes + 1;
    const fimMes = `${proxAno}-${String(proxMes).padStart(2, "0")}-01`;

    const { data, error } = await supabase
        .from("poupeja_payables")
        .select("id, description, amount, due_date, entity_name, status")
        .eq("user_id", userId)
        .eq("status", "pending")
        .gte("due_date", inicioMes)
        .lt("due_date", fimMes)
        .order("due_date", { ascending: true })
        .limit(50);

    if (error) {
        logger.warn({ err: error.message, userId }, "buscarPayablesDoMes: erro");
        return [];
    }
    return data || [];
}

/**
 * Monta a mensagem do resumo matinal. Retorna null se não vale a pena mandar
 * (zero compromissos = não polui o WhatsApp do cliente).
 */
function montarResumo({ nomeApresentacao, compromissos, payables, hojeISO }) {
    const temCompromissos = compromissos && compromissos.length > 0;
    const temPayables = payables && payables.length > 0;
    if (!temCompromissos && !temPayables) {
        return null; // nada a comunicar, pula
    }

    const limite7dISO = dataMaisDias(hojeISO, 7);
    const listaCompromissos = compromissos || [];
    const hoje = listaCompromissos.filter((c) => c.data_proxima === hojeISO);
    const atrasados = listaCompromissos.filter((c) => c.data_proxima < hojeISO);
    const proximos = listaCompromissos.filter(
        (c) => c.data_proxima > hojeISO && c.data_proxima <= limite7dISO
    );

    const totalPagarHoje = hoje
        .filter((c) => c.categoria === "pagamento" && c.valor != null)
        .reduce((s, c) => s + Number(c.valor || 0), 0);
    const totalPagarSemana = listaCompromissos
        .filter((c) => c.categoria === "pagamento" && c.valor != null && c.data_proxima >= hojeISO)
        .reduce((s, c) => s + Number(c.valor || 0), 0);

    const listaPayables = payables || [];
    const payablesVencidas = listaPayables.filter((p) => p.due_date < hojeISO);
    const payablesAVencer = listaPayables.filter((p) => p.due_date >= hojeISO);
    const totalPayablesMes = listaPayables.reduce((s, p) => s + Number(p.amount || 0), 0);

    const partes = [];
    partes.push(`☀️ Bom dia, *${nomeApresentacao}*!`);
    partes.push("");

    if (atrasados.length > 0) {
        partes.push("🔴 *Atrasado* — manda \"já paguei X\" se já resolveu:");
        for (const c of atrasados.slice(0, 5)) {
            const valor = c.valor ? ` (${fmtValor(c.valor)})` : "";
            partes.push(`• ${c.titulo} — venceu em ${fmtDataBR(c.data_proxima)}${valor}`);
        }
        partes.push("");
    }

    if (hoje.length > 0) {
        partes.push(`📅 *Hoje:*`);
        for (const c of hoje) {
            const hora = c.hora_proxima ? `${c.hora_proxima.slice(0, 5)} ` : "";
            const valor = c.valor ? ` — ${fmtValor(c.valor)}` : "";
            partes.push(`• ${hora}${c.titulo}${valor}`);
        }
        if (totalPagarHoje > 0) {
            partes.push(`💰 Total a pagar hoje: *${fmtValor(totalPagarHoje)}*`);
        }
        partes.push("");
    } else if (atrasados.length === 0) {
        partes.push("🎯 Hoje sua agenda tá limpa. Aproveita.");
        partes.push("");
    }

    if (proximos.length > 0) {
        partes.push(`⏰ *Próximos dias:*`);
        for (const c of proximos.slice(0, 5)) {
            const dia = diaDaSemana(c.data_proxima);
            const valor = c.valor ? ` — ${fmtValor(c.valor)}` : "";
            partes.push(`• ${dia} (${fmtDataBR(c.data_proxima)}) — ${c.titulo}${valor}`);
        }
        if (proximos.length > 5) {
            partes.push(`_…e mais ${proximos.length - 5} pra semana_`);
        }
        if (totalPagarSemana > 0) {
            partes.push(`💰 Total a pagar essa semana: *${fmtValor(totalPagarSemana)}*`);
        }
        partes.push("");
    }

    // Bloco de contas a pagar do MÊS — substitui o antigo cron n8n que mandava
    // 1 mensagem por parcela. Agora vai consolidado aqui, 1x por dia.
    if (listaPayables.length > 0) {
        partes.push(`💳 *Contas a pagar do mês* (${listaPayables.length}):`);
        if (payablesVencidas.length > 0) {
            for (const p of payablesVencidas.slice(0, 5)) {
                const fornecedor = p.entity_name ? ` — ${p.entity_name}` : "";
                partes.push(`🔴 ${p.description}${fornecedor} — venceu ${fmtDataBR(p.due_date)} — ${fmtValor(p.amount)}`);
            }
        }
        for (const p of payablesAVencer.slice(0, 8)) {
            const fornecedor = p.entity_name ? ` — ${p.entity_name}` : "";
            partes.push(`• ${fmtDataBR(p.due_date)} — ${p.description}${fornecedor} — ${fmtValor(p.amount)}`);
        }
        const restante = payablesAVencer.length - 8;
        if (restante > 0) {
            partes.push(`_…e mais ${restante} no mês_`);
        }
        partes.push(`💰 Total do mês: *${fmtValor(totalPayablesMes)}*`);
        partes.push("");
    }

    partes.push("_Manda *\"lembra de X dia Y\"* pra anotar algo, ou *\"já paguei X\"* pra concluir._");
    partes.push("Bom trabalho! 🚀");

    return partes.join("\n");
}

/**
 * Roda 1 ciclo do cron. Função exportada pra ser chamada manualmente em
 * teste (curl /api/resumo-matinal-dispatch idem ao cobrancas-cron).
 */
export async function executarCicloResumoMatinal() {
    if (!isEnabled()) {
        logger.warn("resumo-matinal-cron: supabase desligado, pulando ciclo");
        return { ok: false, motivo: "supabase_offline" };
    }

    const hojeISO = dataISOHoje();
    const resultados = {
        rodada_em: new Date().toISOString(),
        hoje: hojeISO,
        total_users: 0,
        enviadas: 0,
        sem_compromissos: 0,
        dedup: 0,
        erros: 0,
    };

    let users = [];
    try {
        users = await listarUsersComWhatsapp();
    } catch (err) {
        logger.error({ err: err.message }, "resumo-matinal-cron: falha listando users");
        return { ok: false, motivo: "erro_listar_users", erro: err.message };
    }
    resultados.total_users = users.length;

    for (const u of users) {
        const chaveDedup = `${u.user_id}:${hojeISO}`;
        if (enviadosNoDia.has(chaveDedup)) {
            resultados.dedup += 1;
            continue;
        }

        try {
            const [compromissos, payables] = await Promise.all([
                buscarCompromissosResumo(u.user_id, hojeISO),
                buscarPayablesDoMes(u.user_id, hojeISO),
            ]);
            const nomeApresentacao = u.nome_fantasia || u.nome || "chefe";
            const msg = montarResumo({
                nomeApresentacao,
                compromissos,
                payables,
                hojeISO,
            });

            if (!msg) {
                resultados.sem_compromissos += 1;
                // Marca como "enviado" pra não tentar de novo no mesmo dia
                enviadosNoDia.add(chaveDedup);
                continue;
            }

            await enviarTexto(u.whatsapp_dono, msg);
            enviadosNoDia.add(chaveDedup);
            resultados.enviadas += 1;

            logger.info(
                {
                    userId: u.user_id,
                    whatsapp: u.whatsapp_dono,
                    qtdCompromissos: compromissos.length,
                },
                "resumo-matinal-cron: enviado"
            );
        } catch (err) {
            logger.error(
                { err: err.message, userId: u.user_id, whatsapp: u.whatsapp_dono },
                "resumo-matinal-cron: falha no envio"
            );
            resultados.erros += 1;
        }
    }

    // Limpeza do cache de dedup (mantém só últimos 7 dias pra não vazar memória)
    if (enviadosNoDia.size > 5000) {
        const minDate = dataMaisDias(hojeISO, -7);
        for (const chave of enviadosNoDia) {
            const [, data] = chave.split(":");
            if (data < minDate) enviadosNoDia.delete(chave);
        }
    }

    logger.info(resultados, "resumo-matinal-cron: ciclo concluído");
    return { ok: true, ...resultados };
}

/**
 * Inicializa o agendamento. Chamar UMA VEZ no startup do agent.
 */
export function iniciarCronResumoMatinal() {
    if (process.env.RESUMO_MATINAL_CRON_ENABLED === "false") {
        logger.warn(
            "resumo-matinal-cron: desabilitado via RESUMO_MATINAL_CRON_ENABLED=false"
        );
        return null;
    }
    const schedule = process.env.RESUMO_MATINAL_CRON_EXPR || SCHEDULE_DEFAULT;
    const timezone = process.env.RESUMO_MATINAL_CRON_TZ || TZ_DEFAULT;

    if (!cron.validate(schedule)) {
        logger.error({ schedule }, "resumo-matinal-cron: expressão cron inválida");
        return null;
    }

    const job = cron.schedule(
        schedule,
        async () => {
            logger.info({ schedule, timezone }, "resumo-matinal-cron: disparado");
            try {
                await executarCicloResumoMatinal();
            } catch (err) {
                logger.error(
                    { err: err.message, stack: err.stack },
                    "resumo-matinal-cron: erro no ciclo"
                );
            }
        },
        { timezone }
    );

    logger.info({ schedule, timezone }, "resumo-matinal-cron: agendado");
    return job;
}
