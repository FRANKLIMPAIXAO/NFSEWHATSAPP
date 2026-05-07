/**
 * src/services/whatsapp.js
 * Cliente da Evolution API — envio de mensagens, download de áudio/PDF.
 *
 * Evolution API é open-source (MIT) e roda na própria VPS via Docker.
 * Doc: https://doc.evolution-api.com/
 */
import fs from "node:fs";
import path from "node:path";
import { logger } from "../utils/logger.js";

const BASE_URL = process.env.EVOLUTION_API_URL || "http://localhost:8080";
const API_KEY = process.env.EVOLUTION_API_KEY;
const INSTANCE = process.env.EVOLUTION_INSTANCE_NAME || "pac-bot";
// Modo dry-run: NÃO chama Evolution real, apenas loga as ações.
// Útil pra testar fluxo do bot sem ter Evolution rodando.
const DRY_RUN = process.env.WHATSAPP_DRY_RUN === "1";

async function evoFetch(method, path, body) {
    const response = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: {
            "Content-Type": "application/json",
            apikey: API_KEY,
        },
        body: body ? JSON.stringify(body) : undefined,
    });

    const text = await response.text();
    let data;
    try {
        data = text ? JSON.parse(text) : {};
    } catch {
        data = { raw: text };
    }

    if (!response.ok) {
        throw new Error(
            `Evolution ${response.status}: ${data.message || text}`
        );
    }

    return data;
}

/**
 * Envia mensagem de texto.
 * @param {string} numero - formato 5511999998888
 * @param {string} texto
 */
export async function enviarTexto(numero, texto) {
    if (DRY_RUN) {
        logger.info({ to: numero, texto }, "[DRY_RUN] enviarTexto");
        return { dry_run: true, to: numero, text: texto };
    }
    return evoFetch("POST", `/message/sendText/${INSTANCE}`, {
        number: numero,
        text: texto,
    });
}

/**
 * Envia documento PDF.
 * @param {string} numero
 * @param {Buffer} pdfBuffer
 * @param {string} fileName
 * @param {string} caption
 */
export async function enviarPdf(numero, pdfBuffer, fileName, caption = "") {
    if (DRY_RUN) {
        logger.info(
            { to: numero, fileName, caption, sizeBytes: pdfBuffer.length },
            "[DRY_RUN] enviarPdf"
        );
        return { dry_run: true, to: numero, fileName, sizeBytes: pdfBuffer.length };
    }
    const base64 = pdfBuffer.toString("base64");
    return evoFetch("POST", `/message/sendMedia/${INSTANCE}`, {
        number: numero,
        mediatype: "document",
        mimetype: "application/pdf",
        media: base64,
        fileName,
        caption,
    });
}

/**
 * Baixa o áudio que o usuário mandou.
 * Evolution disponibiliza o conteúdo via base64 no payload do webhook OU
 * via endpoint /chat/getBase64FromMediaMessage. Aqui usamos o endpoint.
 *
 * @param {string} messageId - id da mensagem
 * @returns {Promise<{path: string, mimetype: string}>} caminho local do arquivo salvo
 */
export async function baixarAudio(messageId) {
    const result = await evoFetch(
        "POST",
        `/chat/getBase64FromMediaMessage/${INSTANCE}`,
        { message: { key: { id: messageId } }, convertToMp4: false }
    );

    if (!result.base64) {
        throw new Error("Áudio não retornou base64");
    }

    const tmpDir = "/tmp/agent-nfse-audio";
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const filePath = path.join(tmpDir, `${messageId}.ogg`);
    fs.writeFileSync(filePath, Buffer.from(result.base64, "base64"));

    logger.info({ filePath, size: result.base64.length }, "audio baixado");
    return { path: filePath, mimetype: result.mimetype || "audio/ogg" };
}
