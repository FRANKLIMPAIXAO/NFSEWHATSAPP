/**
 * src/services/whisper.js
 * Transcrição de áudio via OpenAI Whisper.
 *
 * O WhatsApp manda áudio em .ogg (codec opus). Whisper aceita direto.
 */
import OpenAI from "openai";
import fs from "node:fs";
import { logger } from "../utils/logger.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Transcreve um arquivo de áudio em texto português.
 * @param {string} filePath - caminho local do arquivo .ogg/.mp3/.wav
 * @returns {Promise<string>} texto transcrito
 */
export async function transcrever(filePath) {
    const t0 = Date.now();
    try {
        const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(filePath),
            model: "whisper-1",
            language: "pt",
            response_format: "text",
            // Prompt opcional ajuda Whisper a reconhecer termos fiscais
            prompt:
                "Nota fiscal de serviço, NFS-e, CNPJ, CPF, valor, ISS, " +
                "manutenção, consultoria, prestação de serviços.",
        });

        const texto =
            typeof transcription === "string"
                ? transcription
                : transcription.text || "";

        logger.info(
            { duration_ms: Date.now() - t0, chars: texto.length },
            "audio transcrito"
        );
        return texto.trim();
    } catch (err) {
        logger.error({ err: err.message }, "erro na transcrição");
        throw new Error(`Whisper falhou: ${err.message}`);
    }
}
