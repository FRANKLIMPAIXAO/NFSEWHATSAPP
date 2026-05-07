/**
 * scripts/teste-mtls-epn.js
 * Smoke test do mTLS contra o Emissor Público Nacional.
 * Faz um GET simples no endpoint de produção restrita usando o cert da ROCA.
 * Espera resposta autenticada (mesmo que seja 404/405 — basta NÃO ser 496/handshake error).
 */
import "dotenv/config";
import https from "node:https";
import { findEmpresaById } from "../src/db/index.js";
import { loadCertEmpresa } from "../src/services/cert.js";

const empresa = findEmpresaById.get(2);
if (!empresa) throw new Error("Empresa id=2 não cadastrada");

const { certPem, keyPem, chainPem, metadata } = loadCertEmpresa(empresa);

const baseUrl =
    process.env.EPN_AMBIENTE === "producao"
        ? process.env.EPN_BASE_URL_PRODUCAO
        : process.env.EPN_BASE_URL_HOMOLOGACAO;

console.log("→ Cert  :", metadata.cn);
console.log("→ URL   :", baseUrl);
console.log("→ Path  : / (smoke test mTLS)");
console.log("");

const url = new URL(baseUrl);

// O 'cert' option aceita o leaf concatenado com a cadeia (intermediários).
// Não passar 'ca' — o Node valida o servidor com suas CAs do sistema.
const certBundle = [certPem, ...chainPem].join("\n");

const options = {
    hostname: url.hostname,
    port: url.port || 443,
    path: process.argv[2] || "/",
    method: "GET",
    cert: certBundle,
    key: keyPem,
    rejectUnauthorized: true,
    headers: { Accept: "application/json, text/html, */*" },
};

const req = https.request(options, (res) => {
    console.log("✓ HTTP status:", res.statusCode);
    console.log("  TLS version :", res.socket.getProtocol?.());
    console.log("  Cipher      :", res.socket.getCipher?.()?.name);
    console.log("  Headers     :", JSON.stringify(res.headers, null, 2).slice(0, 600));

    let body = "";
    res.on("data", (c) => (body += c));
    res.on("end", () => {
        const preview = body.slice(0, 500);
        console.log("  Body (500c) :", preview);
    });
});

req.on("error", (err) => {
    console.error("❌ Erro mTLS:", err.code, "-", err.message);
    if (err.code === "EPROTO" || err.code === "ECONNRESET") {
        console.error("   → Servidor rejeitou o cert (handshake falhou).");
    }
    process.exit(1);
});

req.end();
