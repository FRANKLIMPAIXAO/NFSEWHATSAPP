/**
 * src/services/danfe.js
 * Geração de artefatos da NFS-e a partir do response de emissão.
 *
 *   - XML cru (sempre salvo) — comprovante oficial
 *   - HTML (sempre salvo) — visualização
 *   - PDF (best-effort) — pode falhar se Puppeteer travar; não bloqueia o fluxo
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { DanfeService } from "nfse-nacional";
import { logger } from "../utils/logger.js";

const PDF_DIR = path.resolve(process.env.NFSE_PDF_DIR || "data/notas");
fs.mkdirSync(PDF_DIR, { recursive: true });

/**
 * Decompacta gzip+base64 → string XML.
 */
function descomprimirGzipB64(b64) {
    const buf = Buffer.from(b64, "base64");
    return zlib.gunzipSync(buf).toString("utf8");
}

/**
 * Gera artefatos da NFS-e e salva em data/notas/{chave}.{xml,html,pdf}.
 * Nunca lança — falhas isoladas viram warnings no log e o caller decide.
 */
export async function gerarDanfse(response) {
    const chave = response.chaveAcesso;
    if (!chave) {
        logger.warn("DANF-Se: response sem chaveAcesso — pulando geração");
        return {};
    }

    const result = { chave };

    // 1) XML cru — sempre tenta salvar
    let xml = response.nfse?.originalXml;
    if (!xml && response.nfseXmlGZipB64) {
        try {
            xml = descomprimirGzipB64(response.nfseXmlGZipB64);
        } catch (e) {
            logger.warn({ err: e.message }, "Falha ao descomprimir gzipB64");
        }
    }
    if (xml) {
        result.xmlPath = path.join(PDF_DIR, `${chave}.xml`);
        fs.writeFileSync(result.xmlPath, xml);
    }

    // 2) HTML + PDF via DanfeService (best-effort, com timeout próprio)
    try {
        const danfe = new DanfeService();
        const t0 = Date.now();
        // race com timeout de 15s — se Puppeteer travar, a gente desiste
        const out = await Promise.race([
            response.nfseXmlGZipB64
                ? danfe.generateFromGzipB64(response.nfseXmlGZipB64, { chaveAcesso: chave })
                : danfe.generateFromXml(xml, { chaveAcesso: chave }),
            new Promise((_, rej) =>
                setTimeout(() => rej(new Error("DANF-Se timeout 15s")), 15000)
            ),
        ]);
        logger.info({ duration_ms: Date.now() - t0 }, "DANF-Se gerada");

        if (out.html) {
            result.htmlPath = path.join(PDF_DIR, `${chave}.html`);
            fs.writeFileSync(result.htmlPath, out.html);
        }
        if (out.pdfBytes) {
            result.pdfPath = path.join(PDF_DIR, `${chave}.pdf`);
            fs.writeFileSync(result.pdfPath, out.pdfBytes);
        }
    } catch (e) {
        logger.warn({ err: e.message }, "DANF-Se HTML/PDF falhou — só o XML foi salvo");
    }

    return result;
}
