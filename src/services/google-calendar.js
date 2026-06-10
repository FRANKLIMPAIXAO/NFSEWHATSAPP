/**
 * src/services/google-calendar.js
 * Sync de compromissos pro Google Calendar do usuário.
 *
 * Estratégia v1: PUSH unilateral. Compromisso criado/editado/excluído
 * no PacNoBolso replica pro Google. Não fazemos pull (Google → Pac).
 *
 * Auth:
 *   - Refresh token vive em poupeja_users.google_refresh_token (setado
 *     pelo fluxo OAuth no painel pacnobolso.com.br).
 *   - Aqui geramos access_token sob demanda via POST oauth2.googleapis.com/token
 *   - Cache em memória do access_token por ~50 min (TTL real Google = 60min).
 *
 * Resiliência:
 *   - Cada operação em try/catch. Falha NUNCA derruba o fluxo principal —
 *     o compromisso fica salvo no Supabase mesmo sem aparecer no Google.
 *   - Log estruturado pra dashboards futuros mostrarem taxa de sucesso.
 *
 * Configuração via env:
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *
 * Sem essas envs, o módulo fica em "modo desligado" — todas as funções
 * retornam null sem erro (sync simplesmente não acontece).
 */
import { supabase, isEnabled as supabaseEnabled } from "../supabase.js";
import { logger } from "../utils/logger.js";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

// Cache de access_token em memória: userId → { token, expiresAt }
const tokenCache = new Map();

export function isGoogleEnabled() {
    return !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && supabaseEnabled());
}

/**
 * Busca o refresh_token do user no Supabase. Retorna null se não tem.
 */
async function buscarRefreshToken(userId) {
    if (!supabaseEnabled()) return null;
    try {
        const { data, error } = await supabase
            .from("poupeja_users")
            .select("google_refresh_token, google_calendar_id")
            .eq("id", userId)
            .maybeSingle();
        if (error || !data?.google_refresh_token) return null;
        return {
            refreshToken: data.google_refresh_token,
            calendarId: data.google_calendar_id || "primary",
        };
    } catch (err) {
        logger.warn({ err: err.message, userId }, "google-calendar: erro buscando refresh_token");
        return null;
    }
}

/**
 * Troca refresh_token por access_token. Cacheia em memória.
 * Retorna null em qualquer falha.
 */
async function obterAccessToken(userId) {
    if (!isGoogleEnabled()) return null;

    const cached = tokenCache.get(userId);
    if (cached && cached.expiresAt > Date.now() + 60_000) {
        return cached;
    }

    const ctx = await buscarRefreshToken(userId);
    if (!ctx) return null;

    try {
        const resp = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                client_id: GOOGLE_CLIENT_ID,
                client_secret: GOOGLE_CLIENT_SECRET,
                refresh_token: ctx.refreshToken,
                grant_type: "refresh_token",
            }),
            signal: AbortSignal.timeout(10000),
        });
        if (!resp.ok) {
            const body = await resp.text().catch(() => "");
            logger.warn(
                { userId, status: resp.status, body: body.slice(0, 300) },
                "google-calendar: refresh_token recusado"
            );
            // Token provavelmente revogado pelo user em myaccount.google.com
            // Limpa do banco pra não tentar mais.
            if (resp.status === 400 || resp.status === 401) {
                await supabase
                    .from("poupeja_users")
                    .update({ google_refresh_token: null, google_connected_at: null })
                    .eq("id", userId);
                tokenCache.delete(userId);
                logger.info({ userId }, "google-calendar: refresh_token apagado (revogado)");
            }
            return null;
        }
        const json = await resp.json();
        const tokenInfo = {
            accessToken: json.access_token,
            calendarId: ctx.calendarId,
            expiresAt: Date.now() + (Number(json.expires_in || 3600) - 60) * 1000,
        };
        tokenCache.set(userId, tokenInfo);
        return tokenInfo;
    } catch (err) {
        logger.warn({ err: err.message, userId }, "google-calendar: erro obtendo access_token");
        return null;
    }
}

/**
 * Converte um compromisso (poupeja_compromissos) num evento do Google
 * Calendar.
 */
function compromissoParaEvento(compromisso) {
    const dataISO = compromisso.data_proxima;
    const hora = compromisso.hora_proxima;

    let start;
    let end;
    if (hora) {
        // Evento com horário (ex: reunião 14h)
        const [hh, mm] = hora.split(":");
        const startDate = new Date(`${dataISO}T${hh.padStart(2, "0")}:${(mm || "00").padStart(2, "0")}:00-03:00`);
        const endDate = new Date(startDate.getTime() + 60 * 60 * 1000); // +1h default
        start = { dateTime: startDate.toISOString(), timeZone: "America/Sao_Paulo" };
        end = { dateTime: endDate.toISOString(), timeZone: "America/Sao_Paulo" };
    } else {
        // Evento dia inteiro (ex: aluguel, IPVA)
        const startDate = dataISO;
        const next = new Date(dataISO + "T00:00:00");
        next.setDate(next.getDate() + 1);
        const endDate = next.toISOString().slice(0, 10);
        start = { date: startDate };
        end = { date: endDate };
    }

    // Recorrência → RRULE simples
    const recurrence = [];
    if (compromisso.recorrencia === "semanal") {
        recurrence.push("RRULE:FREQ=WEEKLY");
    } else if (compromisso.recorrencia === "mensal") {
        const dia = compromisso.dia_recorrente
            ? `;BYMONTHDAY=${compromisso.dia_recorrente}`
            : "";
        recurrence.push(`RRULE:FREQ=MONTHLY${dia}`);
    } else if (compromisso.recorrencia === "anual") {
        recurrence.push("RRULE:FREQ=YEARLY");
    }

    const valorTxt = compromisso.valor
        ? `\n💰 R$ ${Number(compromisso.valor).toFixed(2).replace(".", ",")}`
        : "";
    const descricao = compromisso.descricao ? `\n\n${compromisso.descricao}` : "";

    return {
        summary: compromisso.titulo,
        description: `Compromisso do PacNoBolso${valorTxt}${descricao}\n\n_Criado via WhatsApp do PacNoBolso 🤖_`,
        start,
        end,
        ...(recurrence.length ? { recurrence } : {}),
        reminders: {
            useDefault: false,
            overrides: [
                { method: "popup", minutes: 60 * 24 }, // 1 dia antes
                ...(hora ? [{ method: "popup", minutes: 30 }] : []), // 30 min antes (se tem hora)
            ],
        },
    };
}

/**
 * Cria evento no Google Calendar. Retorna google_event_id ou null.
 */
export async function criarEventoGoogle(userId, compromisso) {
    const ctx = await obterAccessToken(userId);
    if (!ctx) return null;

    try {
        const evento = compromissoParaEvento(compromisso);
        const resp = await fetch(
            `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(ctx.calendarId)}/events`,
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${ctx.accessToken}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(evento),
                signal: AbortSignal.timeout(8000),
            }
        );
        if (!resp.ok) {
            const body = await resp.text().catch(() => "");
            logger.warn(
                { userId, status: resp.status, body: body.slice(0, 300) },
                "google-calendar: erro criando evento"
            );
            return null;
        }
        const json = await resp.json();
        logger.info(
            { userId, googleEventId: json.id, compromissoId: compromisso.id },
            "google-calendar: evento criado"
        );
        return json.id;
    } catch (err) {
        logger.warn({ err: err.message, userId }, "google-calendar: exceção criando evento");
        return null;
    }
}

/**
 * Atualiza evento existente. Retorna true/false.
 */
export async function atualizarEventoGoogle(userId, googleEventId, compromisso) {
    const ctx = await obterAccessToken(userId);
    if (!ctx) return false;

    try {
        const evento = compromissoParaEvento(compromisso);
        const resp = await fetch(
            `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(ctx.calendarId)}/events/${encodeURIComponent(googleEventId)}`,
            {
                method: "PATCH",
                headers: {
                    Authorization: `Bearer ${ctx.accessToken}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(evento),
                signal: AbortSignal.timeout(8000),
            }
        );
        if (!resp.ok) {
            logger.warn(
                { userId, googleEventId, status: resp.status },
                "google-calendar: erro atualizando evento"
            );
            return false;
        }
        return true;
    } catch (err) {
        logger.warn({ err: err.message }, "google-calendar: exceção atualizando evento");
        return false;
    }
}

/**
 * Exclui evento. Retorna true/false.
 */
export async function excluirEventoGoogle(userId, googleEventId) {
    const ctx = await obterAccessToken(userId);
    if (!ctx) return false;

    try {
        const resp = await fetch(
            `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(ctx.calendarId)}/events/${encodeURIComponent(googleEventId)}`,
            {
                method: "DELETE",
                headers: { Authorization: `Bearer ${ctx.accessToken}` },
                signal: AbortSignal.timeout(8000),
            }
        );
        // 410 = já apagado, conta como sucesso
        if (!resp.ok && resp.status !== 410) {
            logger.warn(
                { userId, googleEventId, status: resp.status },
                "google-calendar: erro excluindo evento"
            );
            return false;
        }
        return true;
    } catch (err) {
        logger.warn({ err: err.message }, "google-calendar: exceção excluindo evento");
        return false;
    }
}
