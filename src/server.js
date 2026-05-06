/**
 * src/server.js
 * Servidor Express. Recebe webhook da Evolution API.
 */
import "dotenv/config";
import express from "express";
import { timingSafeEqual } from "node:crypto";
import { handleWebhook } from "./handlers/webhook.js";
import { logger } from "./utils/logger.js";

const app = express();
app.use(express.json({ limit: "10mb" }));
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    logger.info({ port: PORT, env: process.env.NODE_ENV }, "agent-nfse no ar");
});
