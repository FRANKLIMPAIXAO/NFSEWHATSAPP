/**
 * src/server.js
 * Servidor Express. Recebe webhook da Evolution API.
 */
import "dotenv/config";
import express from "express";
import { timingSafeEqual } from "node:crypto";
import { handleWebhook } from "./handlers/webhook.js";
import { handleFocusWebhook } from "./handlers/focus-webhook.js";
import { handleApiEmit } from "./handlers/api-emit.js";
import { handleApiCobrar } from "./handlers/api-cobrar.js";
import { handleApiCobrarAssinante } from "./handlers/api-cobrar-assinante.js";
import { iniciarCronCobrancas, executarCicloCobrancas } from "./jobs/cobrancas-cron.js";
import { iniciarCronResumoMatinal, executarCicloResumoMatinal } from "./jobs/resumo-matinal-cron.js";
import { supabase } from "./supabase.js";
import { logger } from "./utils/logger.js";
import { restoreCertsFromEnv } from "./utils/restore-certs.js";

restoreCertsFromEnv();

const app = express();
app.use(express.json({ limit: "10mb" }));
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const FOCUS_WEBHOOK_SECRET = process.env.FOCUS_WEBHOOK_SECRET;

// CORS pra endpoints /api/* — painel PacNoBolso (em outro subdomínio/domain)
// precisa enviar Authorization header. Lista explícita de origens é mais
// segura que '*'. Adicionar domínio de preview do Vercel quando necessário.
const ALLOWED_ORIGINS = new Set([
    "https://pacnobolso.com.br",
    "https://www.pacnobolso.com.br",
    "https://nfse.pacnobolso.com.br",
    "http://localhost:5173", // vite dev
    "http://localhost:3000",
    "http://localhost:8080",
]);

function aplicarCorsApi(req, res) {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.has(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Max-Age", "600");
}

function isValidWebhookSecret(receivedSecret) {
    if (!WEBHOOK_SECRET) return true;
    if (!receivedSecret) return false;

    const a = Buffer.from(String(receivedSecret));
    const b = Buffer.from(String(WEBHOOK_SECRET));
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}

// healthcheck
app.get("/health", (_req, res) => {
    res.json({
        ok: true,
        service: "agent-nfse",
        env: process.env.NODE_ENV,
        timestamp: new Date().toISOString(),
    });
});

// Webhook da Evolution API
app.post("/webhook", async (req, res) => {
    const providedSecret =
        req.headers["x-webhook-secret"] || req.headers["x-evolution-secret"];

    if (!isValidWebhookSecret(providedSecret)) {
        logger.warn({ ip: req.ip }, "webhook bloqueado por segredo inválido");
        return res.status(401).json({ error: "unauthorized" });
    }

    // Resposta rápida pra Evolution (ela tem timeout)
    res.status(200).json({ received: true });

    // Processa em background
    try {
        await handleWebhook(req.body);
    } catch (err) {
        logger.error({ err: err.message, stack: err.stack }, "erro no webhook");
    }
});

// Webhook da Focus NFe — callback quando SEFAZ autoriza/rejeita.
// Configurar URL no painel Focus por empresa:
//   https://<dominio>/webhooks/focus?secret=<FOCUS_WEBHOOK_SECRET>
app.post("/webhooks/focus", async (req, res) => {
    if (FOCUS_WEBHOOK_SECRET) {
        const provided = req.query.secret || req.headers["x-webhook-secret"];
        if (provided !== FOCUS_WEBHOOK_SECRET) {
            logger.warn({ ip: req.ip }, "focus-webhook bloqueado por segredo inválido");
            return res.status(401).json({ error: "unauthorized" });
        }
    }

    // Resposta rápida — Focus tem timeout e pode reenviar se demorarmos.
    res.status(200).json({ received: true });

    try {
        await handleFocusWebhook(req.body);
    } catch (err) {
        logger.error({ err: err.message, stack: err.stack }, "erro no focus-webhook");
    }
});

// Preflight CORS pra qualquer rota /api/*
app.options("/api/*", (req, res) => {
    aplicarCorsApi(req, res);
    res.status(204).end();
});

// API HTTP — emissão de NFS-e pelo painel PacNoBolso (autenticado via JWT
// do Supabase Auth). Mesma lógica interna do fluxo WhatsApp, sem extração
// de áudio (recebe payload estruturado direto).
app.post("/api/emit", async (req, res) => {
    aplicarCorsApi(req, res);
    await handleApiEmit(req, res);
});

// API HTTP — cobrança via WhatsApp. Dispara lembrete pro whatsapp_dono
// da empresa do user (Hipótese B: user recebe, vê cliente e link wa.me
// pra cobrar direto).
app.post("/api/cobrar", async (req, res) => {
    aplicarCorsApi(req, res);
    await handleApiCobrar(req, res);
});

// API HTTP — cobrança ADMIN pra assinante inadimplente. Mensagem vai
// direto pro WhatsApp do user (poupeja_users.phone), não pro próprio admin.
// Requer role='admin' em user_roles.
app.post("/api/cobrar-assinante", async (req, res) => {
    aplicarCorsApi(req, res);
    await handleApiCobrarAssinante(req, res);
});

// Dispatch manual do ciclo de cobranças automáticas (mesmo que o cron das 9h
// faria). Útil pra: testes em dev, força redispatch após corrigir um bug,
// botão de admin "rodar agora". Requer role='admin'.
app.post("/api/cobrancas-cron-dispatch", async (req, res) => {
    aplicarCorsApi(req, res);
    try {
        const authHeader = req.headers["authorization"] || "";
        const match = authHeader.match(/^Bearer\s+(.+)$/i);
        if (!match) {
            return res.status(401).json({ error: "missing_token" });
        }
        if (!supabase) {
            return res.status(500).json({ error: "supabase_offline" });
        }
        const { data: userData } = await supabase.auth.getUser(match[1]);
        if (!userData?.user?.id) {
            return res.status(401).json({ error: "invalid_token" });
        }
        const { data: role } = await supabase
            .from("user_roles")
            .select("role")
            .eq("user_id", userData.user.id)
            .eq("role", "admin")
            .maybeSingle();
        if (!role) {
            return res.status(403).json({ error: "nao_e_admin" });
        }
        const resultado = await executarCicloCobrancas();
        return res.status(200).json(resultado);
    } catch (err) {
        logger.error({ err: err.message }, "erro no dispatch manual");
        return res.status(500).json({ error: "internal_error", message: err.message });
    }
});

// Dispatch manual do resumo matinal (idem cobrancas-cron-dispatch). Útil pra
// testar formatação da mensagem sem esperar 7h da manhã. Requer role='admin'.
app.post("/api/resumo-matinal-dispatch", async (req, res) => {
    aplicarCorsApi(req, res);
    try {
        const authHeader = req.headers["authorization"] || "";
        const match = authHeader.match(/^Bearer\s+(.+)$/i);
        if (!match) {
            return res.status(401).json({ error: "missing_token" });
        }
        if (!supabase) {
            return res.status(500).json({ error: "supabase_offline" });
        }
        const { data: userData } = await supabase.auth.getUser(match[1]);
        if (!userData?.user?.id) {
            return res.status(401).json({ error: "invalid_token" });
        }
        const { data: role } = await supabase
            .from("user_roles")
            .select("role")
            .eq("user_id", userData.user.id)
            .eq("role", "admin")
            .maybeSingle();
        if (!role) {
            return res.status(403).json({ error: "nao_e_admin" });
        }
        const resultado = await executarCicloResumoMatinal();
        return res.status(200).json(resultado);
    } catch (err) {
        logger.error({ err: err.message }, "erro no dispatch do resumo matinal");
        return res.status(500).json({ error: "internal_error", message: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    logger.info({ port: PORT, env: process.env.NODE_ENV }, "agent-nfse no ar");
    // Inicia cron diário de cobranças (9h BRT por default).
    // Desabilita com COBRANCAS_CRON_ENABLED=false.
    iniciarCronCobrancas();
    // Cron matinal de resumo da agenda (seg-sex 7h BRT por default).
    // Desabilita com RESUMO_MATINAL_CRON_ENABLED=false.
    iniciarCronResumoMatinal();
});
