/**
 * src/jobs/cobrancas-cron.js
 * Cron diário que dispara cobranças WhatsApp pra assinantes em momentos
 * estratégicos do ciclo de pagamento.
 *
 * Cadência (relativa a poupeja_subscriptions.current_period_end):
 *   D-3  → lembrete amigável (vence em 3 dias)
 *   D    → vence hoje
 *   D+3  → atrasado há 3 dias
 *   D+7  → último aviso, suspensão iminente
 *
 * Anti-duplicação: poupeja_cobrancas_enviadas tem UNIQUE (user_id,
 * tipo_cobranca, data_referencia). Se o cron rodar 2x no mesmo dia
 * (ex: reboot do container), só envia 1 vez.
 *
 * Schedule: todo dia às 9h da manhã horário de São Paulo (BRT/BRST).
 * Sobrescrever via env COBRANCAS_CRON_EXPR (formato cron padrão de 5
 * campos) e COBRANCAS_CRON_TZ.
 *
 * Desabilita o cron via env COBRANCAS_CRON_ENABLED=false (default true).
 */
import cron from "node-cron";
import { supabase, isEnabled } from "../supabase.js";
import { enviarCobrancaAssinante } from "../services/cobranca-assinante.js";
import { logger } from "../utils/logger.js";

const SCHEDULE_DEFAULT = "0 9 * * *"; // 9h da manhã
const TZ_DEFAULT = "America/Sao_Paulo";

const DELTA_TIPOS = [
    { delta: -3, tipo: "d_minus_3" },
    { delta: 0, tipo: "d" },
    { delta: 3, tipo: "d_plus_3" },
    { delta: 7, tipo: "d_plus_7" },
];

function dataISO(dataObj) {
    return dataObj.toISOString().slice(0, 10);
}

function dataMaisDias(dias, base = new Date()) {
    const d = new Date(base);
    d.setDate(d.getDate() + dias);
    return dataISO(d);
}

/**
 * Roda 1 ciclo do cron: pra cada delta (-3, 0, +3, +7), busca subs cujo
 * current_period_end bate exatamente com hoje + delta, e dispara cobrança
 * pra cada user. Função exportada pra ser chamada manualmente em teste.
 */
export async function executarCicloCobrancas() {
    if (!isEnabled()) {
        logger.warn("cobrancas-cron: supabase off, skip");
        return { ok: false, motivo: "supabase_offline" };
    }

    const hoje = new Date();
    const resultados = {
        rodada_em: hoje.toISOString(),
        por_tipo: {},
        total_enviado: 0,
        total_skip_dedup: 0,
        total_erro: 0,
    };

    for (const { delta, tipo } of DELTA_TIPOS) {
        const alvoDate = dataMaisDias(delta, hoje);
        const { data: subs, error } = await supabase
            .from("poupeja_subscriptions")
            .select("user_id, status, current_period_end, plan_type")
            .eq("current_period_end", alvoDate)
            .not("status", "eq", "canceled");

        if (error) {
            logger.error(
                { tipo, alvoDate, err: error.message },
                "cobrancas-cron: erro buscando subs",
            );
            resultados.por_tipo[tipo] = { erro: error.message };
            continue;
        }

        const lista = subs || [];
        logger.info(
            { tipo, delta, alvoDate, total: lista.length },
            "cobrancas-cron: subs encontradas pra esse tipo",
        );

        const detalhes = { alvoDate, total: lista.length, enviadas: 0, dedup: 0, erros: 0 };

        for (const sub of lista) {
            try {
                const r = await enviarCobrancaAssinante({
                    userId: sub.user_id,
                    tipo,
                    fonte: "cron",
                });
                if (r.ok && r.deduplicado) {
                    detalhes.dedup += 1;
                    resultados.total_skip_dedup += 1;
                } else if (r.ok) {
                    detalhes.enviadas += 1;
                    resultados.total_enviado += 1;
                } else {
                    detalhes.erros += 1;
                    resultados.total_erro += 1;
                }
            } catch (err) {
                logger.error(
                    { err: err.message, userId: sub.user_id, tipo },
                    "cobrancas-cron: exceção ao enviar",
                );
                detalhes.erros += 1;
                resultados.total_erro += 1;
            }
        }

        resultados.por_tipo[tipo] = detalhes;
    }

    logger.info(resultados, "cobrancas-cron: ciclo concluído");
    return { ok: true, ...resultados };
}

/**
 * Inicializa o agendamento. Chamar UMA VEZ no startup do agent.
 * Retorna a handle do cron job (pra .stop() em testes/shutdown).
 */
export function iniciarCronCobrancas() {
    if (process.env.COBRANCAS_CRON_ENABLED === "false") {
        logger.warn(
            "cobrancas-cron: desabilitado via COBRANCAS_CRON_ENABLED=false",
        );
        return null;
    }
    const schedule = process.env.COBRANCAS_CRON_EXPR || SCHEDULE_DEFAULT;
    const timezone = process.env.COBRANCAS_CRON_TZ || TZ_DEFAULT;

    if (!cron.validate(schedule)) {
        logger.error({ schedule }, "cobrancas-cron: expressão cron inválida");
        return null;
    }

    const job = cron.schedule(
        schedule,
        async () => {
            logger.info({ schedule, timezone }, "cobrancas-cron: disparado");
            try {
                await executarCicloCobrancas();
            } catch (err) {
                logger.error(
                    { err: err.message, stack: err.stack },
                    "cobrancas-cron: erro no ciclo",
                );
            }
        },
        { timezone },
    );

    logger.info({ schedule, timezone }, "cobrancas-cron: agendado");
    return job;
}
