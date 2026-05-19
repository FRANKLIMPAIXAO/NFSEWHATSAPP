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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    logger.info({ port: PORT, env: process.env.NODE_ENV }, "agent-nfse no ar");
});
