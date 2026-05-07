/**
 * scripts/cadastrar-elshadai.js
 * Cadastra/atualiza a empresa Centro Automotivo El Shadai (Aparecida de Goiânia/GO).
 *
 * Lê do .env:
 *   ELSHADAI_FOCUS_TOKEN  — token Focus NFe
 *   ELSHADAI_WHATSAPP_DONO — número do dono no WhatsApp
 */
import "dotenv/config";
import { db, insertEmpresa } from "../src/db/index.js";

const focusToken = process.env.ELSHADAI_FOCUS_TOKEN;
const whatsappDono = process.env.ELSHADAI_WHATSAPP_DONO;

if (!focusToken) {
    console.error("❌ ELSHADAI_FOCUS_TOKEN não definido no .env");
    process.exit(1);
}
if (!whatsappDono) {
    console.error("❌ ELSHADAI_WHATSAPP_DONO não definido no .env");
    process.exit(1);
}

const empresa = {
    cnpj: "10930732000134",
    razao_social: "Jovelino e Acilda Ltda",
    nome_fantasia: "Centro Automotivo El Shadai",
    whatsapp_dono: whatsappDono,
    focus_token: focusToken,
    regime: "simples_nacional",
    aliquota_iss: 2.0,
    servico_padrao_lc116: "140101",
    municipio_codigo: "5201405",
    municipio_nome: "Aparecida de Goiânia",
    uf: "GO",
    inscricao_municipal: "424435",
    endereco: {
        cep: "74946530",
        logradouro: "Avenida Lago dos Patos",
        numero: "27",
        complemento: "Q:025 L:0027 - Conj. Lago das Garças",
        bairro: "Jardim Tropical",
    },
};

const existing = db.prepare("SELECT id FROM empresas WHERE cnpj = ?").get(empresa.cnpj);
if (existing) {
    db.prepare(`
        UPDATE empresas SET
            razao_social = ?, nome_fantasia = ?, whatsapp_dono = ?,
            focus_token = ?, regime = ?, aliquota_iss = ?,
            servico_padrao_lc116 = ?, municipio_codigo = ?, municipio_nome = ?,
            uf = ?, inscricao_municipal = ?, endereco_json = ?,
            atualizada_em = datetime('now')
        WHERE id = ?
    `).run(
        empresa.razao_social, empresa.nome_fantasia, empresa.whatsapp_dono,
        empresa.focus_token, empresa.regime, empresa.aliquota_iss,
        empresa.servico_padrao_lc116, empresa.municipio_codigo, empresa.municipio_nome,
        empresa.uf, empresa.inscricao_municipal, JSON.stringify(empresa.endereco),
        existing.id
    );
    console.log(`✓ El Shadai atualizada (id=${existing.id})`);
} else {
    const r = insertEmpresa.run(
        empresa.cnpj, empresa.razao_social, empresa.nome_fantasia, empresa.whatsapp_dono,
        empresa.focus_token, empresa.regime, empresa.aliquota_iss,
        empresa.servico_padrao_lc116, empresa.municipio_codigo, empresa.municipio_nome,
        empresa.uf, empresa.inscricao_municipal, JSON.stringify(empresa.endereco)
    );
    console.log(`✓ El Shadai cadastrada (id=${r.lastInsertRowid})`);
}
console.log(`   ${empresa.razao_social} (${empresa.nome_fantasia})`);
console.log(`   IM ${empresa.inscricao_municipal} | ISS ${empresa.aliquota_iss}% | WhatsApp ${whatsappDono}`);
