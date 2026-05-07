/**
 * src/utils/restore-certs.js
 *
 * No EasyPanel/Docker, /app/certs não é necessariamente um volume persistente.
 * Cada redeploy pode wipar os .p12 carregados manualmente. Pra evitar emissão
 * quebrada com ENOENT, este módulo roda no boot do servidor e regrava cada
 * cert ausente a partir de uma env var em base64.
 *
 * Convenção: pra empresa com cert_pfx_path = '/app/certs/roca.p12', a env var
 * esperada é ROCA_CERT_PFX_BASE64 (basename em UPPER_SNAKE + sufixo).
 */
import fs from "node:fs";
import path from "node:path";
import { db } from "../db/index.js";
import { logger } from "./logger.js";

function envVarNameFromPath(certPath) {
    const basename = path.basename(certPath, path.extname(certPath));
    return `${basename.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_CERT_PFX_BASE64`;
}

export function restoreCertsFromEnv() {
    const empresas = db
        .prepare(
            `SELECT id, razao_social, cert_pfx_path
               FROM empresas
              WHERE cert_pfx_path IS NOT NULL AND cert_pfx_path <> ''`
        )
        .all();

    const restored = [];

    for (const emp of empresas) {
        const certPath = emp.cert_pfx_path;
        if (fs.existsSync(certPath)) continue;

        const envName = envVarNameFromPath(certPath);
        const b64 = process.env[envName];

        if (!b64) {
            logger.warn(
                { empresa: emp.razao_social, certPath, envName },
                "cert ausente em disco e env var não definida — emissão vai falhar até alguém corrigir"
            );
            continue;
        }

        try {
            const dir = path.dirname(certPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const buf = Buffer.from(String(b64).replace(/\s+/g, ""), "base64");
            fs.writeFileSync(certPath, buf);
            fs.chmodSync(certPath, 0o600);
            restored.push({
                empresa: emp.razao_social,
                certPath,
                bytes: buf.length,
                envName,
            });
        } catch (err) {
            logger.error(
                { empresa: emp.razao_social, certPath, err: err.message },
                "falha ao restaurar cert da env var"
            );
        }
    }

    if (restored.length) {
        logger.info({ restored }, "certs restaurados de env vars no boot");
    }
    return restored;
}
