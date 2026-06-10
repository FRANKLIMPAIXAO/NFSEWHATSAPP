/**
 * src/services/whisper.js
 * Transcrição de áudio via OpenAI.
 *
 * O WhatsApp manda áudio em .ogg (codec opus). OpenAI aceita direto.
 *
 * Por que NÃO usamos mais "whisper-1" como default:
 *   - Modelo legado (2023), conhecido por latência alta e instável.
 *   - Em prod observamos 18s pra transcrever áudio de 9KB (~5s) — esperado <3s.
 *
 * Default agora: gpt-4o-mini-transcribe (lançado 03/2025).
 *   - 3-5x mais rápido que whisper-1
 *   - ~50% mais barato
 *   - Qualidade igual ou superior em português
 *
 * Override via env OPENAI_TRANSCRIBE_MODEL (ex: pra forçar gpt-4o-transcribe
 * em casos de áudio com ruído alto onde a qualidade do mini for limite).
 *
 * Resiliência:
 *   - Timeout 25s via AbortController (cliente não fica esperando minutos).
 *   - Retry 1x com whisper-1 como fallback (se modelo novo falhar).
 *   - Logging detalhado pra monitorar tempo + tamanho de arquivo.
 */
import OpenAI from "openai";
import fs from "node:fs";
import { logger } from "../utils/logger.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MODEL_DEFAULT = process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";
const MODEL_FALLBACK = "whisper-1";
const TIMEOUT_MS = Number(process.env.OPENAI_TRANSCRIBE_TIMEOUT_MS || 25000);

// Prompt contextual ajuda Whisper a reconhecer termos fiscais BR
const PROMPT_CONTEXTUAL =
    "Nota fiscal de serviço, NFS-e, CNPJ, CPF, valor, ISS, " +
    "manutenção, consultoria, prestação de serviços, " +
    "pagamento, recebimento, pix, boleto, aluguel, salário, DAS.";

/**
 * Tenta transcrever com um modelo específico, dentro de uma janela de timeout.
 * Lança erro se passar do TIMEOUT_MS — chamador decide se faz fallback.
 */
async function transcreverComModelo(filePath, modelo) {
    const t0 = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        const transcription = await openai.audio.transcriptions.create(
            {
                file: fs.createReadStream(filePath),
                model: modelo,
                language: "pt",
                response_format: "text",
                prompt: PROMPT_CONTEXTUAL,
            },
            { signal: controller.signal },
        );

        const texto =
            typeof transcription === "string"
                ? transcription
                : transcription.text || "";
        return { texto: texto.trim(), durationMs: Date.now() - t0 };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Transcreve um arquivo de áudio em texto português.
 * @param {string} filePath - caminho local do arquivo .ogg/.mp3/.wav
 * @returns {Promise<string>} texto transcrito
 */
export async function transcrever(filePath) {
    // Tamanho do arquivo pra logging (ajuda diagnosticar lentidão)
    let fileSizeBytes = 0;
    try {
        fileSizeBytes = fs.statSync(filePath).size;
    } catch {
        // ignora se não conseguir stat
    }

    // Tentativa 1: modelo default (gpt-4o-mini-transcribe ou env override)
    try {
        const { texto, durationMs } = await transcreverComModelo(filePath, MODEL_DEFAULT);
        logger.info(
            {
                duration_ms: durationMs,
                chars: texto.length,
                size_kb: Math.round(fileSizeBytes / 1024),
                model: MODEL_DEFAULT,
            },
            "audio transcrito"
        );
        return texto;
    } catch (err) {
        const isAbort = err.name === "AbortError" || err.name === "APIUserAbortError";
        const isQuota = err.status === 429;
        logger.warn(
            {
                err: err.message,
                isAbort,
                isQuota,
                model: MODEL_DEFAULT,
                size_kb: Math.round(fileSizeBytes / 1024),
            },
            "audio: tentativa primária falhou, indo pro fallback"
        );

        // Tentativa 2: fallback pra whisper-1 (lento mas mais estável às vezes)
        if (MODEL_DEFAULT === MODEL_FALLBACK) {
            // Já era whisper-1 — sem fallback, propaga
            throw new Error(`Whisper falhou: ${err.message}`);
        }
        try {
            const { texto, durationMs } = await transcreverComModelo(filePath, MODEL_FALLBACK);
            logger.info(
                {
                    duration_ms: durationMs,
                    chars: texto.length,
                    size_kb: Math.round(fileSizeBytes / 1024),
                    model: MODEL_FALLBACK,
                    fallback: true,
                },
                "audio transcrito (fallback)"
            );
            return texto;
        } catch (err2) {
            logger.error(
                { err: err2.message, model: MODEL_FALLBACK },
                "audio: fallback também falhou"
            );
            throw new Error(`Whisper falhou (primário + fallback): ${err.message} → ${err2.message}`);
        }
    }
}
