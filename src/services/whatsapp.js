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
 * Mapa de mimetype → extensão de arquivo. Usado pra salvar o arquivo
 * baixado com a extensão correta (Whisper exige .ogg/.mp3/.wav, Claude
 * Vision aceita jpg/png/gif/webp, Claude Documents aceita .pdf).
 */
const MIME_TO_EXT = {
    "audio/ogg": "ogg",
    "audio/ogg; codecs=opus": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/webm": "webm",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "application/pdf": "pdf",
};

/**
 * Baixa qualquer mídia (áudio, imagem, documento) que o usuário mandou.
 * Evolution disponibiliza via /chat/getBase64FromMediaMessage.
 *
 * @param {string} messageId - id da mensagem
 * @returns {Promise<{path: string, base64: string, mimetype: string, ext: string, size: number}>}
 */
export async function baixarMidia(messageId) {
    const result = await evoFetch(
        "POST",
        `/chat/getBase64FromMediaMessage/${INSTANCE}`,
        { message: { key: { id: messageId } }, convertToMp4: false }
    );

    if (!result.base64) {
        throw new Error("Mídia não retornou base64");
    }

    const mimetype = result.mimetype || "application/octet-stream";
    // Normaliza mimetype (Evolution às vezes manda com codec após ;)
    const mimeBase = mimetype.split(";")[0].trim();
    const ext = MIME_TO_EXT[mimeBase] || MIME_TO_EXT[mimetype] || "bin";

    const tmpDir = "/tmp/agent-nfse-audio";
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const filePath = path.join(tmpDir, `${messageId}.${ext}`);
    const buf = Buffer.from(result.base64, "base64");
    fs.writeFileSync(filePath, buf);

    logger.info(
        { filePath, mimetype, ext, size: buf.length },
        "mídia baixada"
    );
    return {
        path: filePath,
        base64: result.base64,
        mimetype: mimeBase,
        ext,
        size: buf.length,
    };
}

/**
 * Wrapper de retrocompatibilidade — a maioria do código chama baixarAudio.
 * @deprecated use baixarMidia direto.
 */
export async function baixarAudio(messageId) {
    return baixarMidia(messageId);
}
