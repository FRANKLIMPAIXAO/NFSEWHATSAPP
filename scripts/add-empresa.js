/**
 * scripts/add-empresa.js
 * Cadastra uma nova empresa cliente no agente.
 *
 * Uso:
 *   node scripts/add-empresa.js
 *
 * Você vai preencher os dados via prompt interativo.
 */
import "dotenv/config";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { insertEmpresa } from "../src/db/index.js";

const rl = readline.createInterface({ input, output });

async function ask(q, def = "") {
    const suffix = def ? ` [${def}]` : "";
    const r = await rl.question(`${q}${suffix}: `);
    return r.trim() || def;
}

console.log("=== CADASTRO DE EMPRESA NO AGENTE PAC ===\n");

const cnpj = (await ask("CNPJ (apenas números)")).replace(/\D/g, "");
const razao_social = await ask("Razão social");
const nome_fantasia = await ask("Nome fantasia (opcional)");
const whatsapp_dono = (await ask("WhatsApp do dono (5511999999999)")).replace(/\D/g, "");
const focus_token = await ask("Token Focus NFe (do painel da empresa)");
const regime = await ask(
    "Regime (simples_nacional/lucro_presumido/lucro_real)",
    "simples_nacional"
);
const aliquota_iss = parseFloat(await ask("Alíquota ISS %", "5.0"));
const servico_padrao_lc116 = await ask("Código LC 116 padrão (ex: 17.05)");
const municipio_codigo = await ask("Código IBGE do município (7 dígitos)");
const municipio_nome = await ask("Nome do município");
const uf = (await ask("UF (sigla)", "")).toUpperCase();
const cep = (await ask("CEP (apenas números)")).replace(/\D/g, "");
const logradouro = await ask("Logradouro");
const numero = await ask("Número");
const bairro = await ask("Bairro");
const inscricao_municipal = (
    await ask("Inscrição municipal (exigida pela maioria das prefeituras)")
).replace(/\D/g, "");

const endereco_json = JSON.stringify({
    cep,
    logradouro,
    numero,
    bairro,
});

try {
    const result = insertEmpresa.run(
        cnpj,
        razao_social,
        nome_fantasia || null,
        whatsapp_dono,
        focus_token,
        regime,
        aliquota_iss,
        servico_padrao_lc116 || null,
        municipio_codigo || null,
        municipio_nome || null,
        uf || null,
        inscricao_municipal || null,
        endereco_json
    );

    console.log(`\n✅ Empresa cadastrada (id=${result.lastInsertRowid})`);
    console.log(`   ${razao_social}`);
    console.log(`   WhatsApp do dono: ${whatsapp_dono}`);
    console.log(`\nO bot já reconhece esse número.`);
} catch (err) {
    console.error("\n❌ Erro:", err.message);
    if (err.message.includes("UNIQUE")) {
        console.error(
            "   CNPJ ou WhatsApp já cadastrados. Use UPDATE no banco se quiser editar."
        );
    }
}

rl.close();
