/**
 * scripts/cadastrar-roca.js
 * Cadastra/atualiza a empresa ROCA LTDA (Goiânia/GO) no banco.
 *
 * Lê variáveis sensíveis do .env:
 *   ROCA_FOCUS_TOKEN       — token Focus NFe (homologação)
 *   ROCA_CERT_PFX_PATH     — caminho do certificado A1 (.pfx/.p12)
 *   ROCA_CERT_PFX_PASSWORD — senha do certificado
 *   ROCA_WHATSAPP_DONO     — número do dono no WhatsApp (default: ADMIN_WHATSAPP)
 */
import "dotenv/config";
import path from "node:path";
import { db, insertEmpresa } from "../src/db/index.js";

const focusToken = process.env.ROCA_FOCUS_TOKEN;
const certPath = process.env.ROCA_CERT_PFX_PATH
    ? path.resolve(process.env.ROCA_CERT_PFX_PATH)
    : null;
const certPassword = process.env.ROCA_CERT_PFX_PASSWORD;
const whatsappDono =
    process.env.ROCA_WHATSAPP_DONO || process.env.ADMIN_WHATSAPP;

if (!focusToken) {
    console.error("❌ ROCA_FOCUS_TOKEN não definido no .env");
    process.exit(1);
}
if (!whatsappDono) {
    console.error("❌ ROCA_WHATSAPP_DONO ou ADMIN_WHATSAPP não definido no .env");
    process.exit(1);
}

const empresa = {
    cnpj: "63052142000112",
    razao_social: "ROCA LTDA",
    nome_fantasia: "ROCA SERVIÇOS",
    whatsapp_dono: whatsappDono,
    focus_token: focusToken,
    regime: "simples_nacional",
    aliquota_iss: 5.0,
    servico_padrao_lc116: "140101",
    municipio_codigo: "5208707",
    municipio_nome: "Goiânia",
    uf: "GO",
    inscricao_municipal: "7358865",
    endereco: {
        cep: "74870290",
        logradouro: "Rua 2A",
        numero: "111",
        complemento: "Quadra 05 Lote 09",
        bairro: "Conj. Fabiana",
    },
};

// Idempotente: se já existe, atualiza; senão, insere.
const existing = db.prepare("SELECT id FROM empresas WHERE cnpj = ?").get(empresa.cnpj);
if (existing) {
    db.prepare(`
        UPDATE empresas SET
            razao_social = ?, nome_fantasia = ?, whatsapp_dono = ?,
            focus_token = ?, regime = ?, aliquota_iss = ?,
            servico_padrao_lc116 = ?, municipio_codigo = ?, municipio_nome = ?,
            uf = ?, inscricao_municipal = ?, endereco_json = ?,
            cert_pfx_path = ?, cert_pfx_password = ?, emissor = 'epn',
            atualizada_em = datetime('now')
        WHERE id = ?
    `).run(
        empresa.razao_social, empresa.nome_fantasia, empresa.whatsapp_dono,
        empresa.focus_token, empresa.regime, empresa.aliquota_iss,
        empresa.servico_padrao_lc116, empresa.municipio_codigo, empresa.municipio_nome,
        empresa.uf, empresa.inscricao_municipal, JSON.stringify(empresa.endereco),
        certPath, certPassword, existing.id
    );
    console.log(`✓ ROCA atualizada (id=${existing.id})`);
} else {
    const r = insertEmpresa.run(
        empresa.cnpj, empresa.razao_social, empresa.nome_fantasia, empresa.whatsapp_dono,
        empresa.focus_token, empresa.regime, empresa.aliquota_iss,
        empresa.servico_padrao_lc116, empresa.municipio_codigo, empresa.municipio_nome,
        empresa.uf, empresa.inscricao_municipal, JSON.stringify(empresa.endereco)
    );
    if (certPath && certPassword) {
        db.prepare(`
            UPDATE empresas SET cert_pfx_path = ?, cert_pfx_password = ?, emissor = 'epn'
            WHERE id = ?
        `).run(certPath, certPassword, r.lastInsertRowid);
    }
    console.log(`✓ ROCA cadastrada (id=${r.lastInsertRowid})`);
}

console.log(`   Razão social : ${empresa.razao_social}`);
console.log(`   IM           : ${empresa.inscricao_municipal} | ISS ${empresa.aliquota_iss}%`);
console.log(`   Município    : ${empresa.municipio_nome}/${empresa.uf} (${empresa.municipio_codigo})`);
console.log(`   WhatsApp dono: ${whatsappDono}`);
console.log(`   Cert         : ${certPath || "(não configurado — emissor caía pra Focus)"}`);
