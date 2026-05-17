/**
 * src/server.js
 * Servidor Express. Recebe webhook da Evolution API.
 */
import "dotenv/config";
import express from "express";
import { timingSafeEqual } from "node:crypto";
import { handleWebhook } from "./handlers/webhook.js";
import { handleFocusWebhook } from "./handlers/focus-webhook.js";
import { logger } from "./utils/logger.js";
import { restoreCertsFromEnv } from "./utils/restore-certs.js";

restoreCertsFromEnv();

const app = express();
app.use(express.json({ limit: "10mb" }));
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const FOCUS_WEBHOOK_SECRET = process.env.FOCUS_WEBHOOK_SECRET;

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    logger.info({ port: PORT, env: process.env.NODE_ENV }, "agent-nfse no ar");
});
