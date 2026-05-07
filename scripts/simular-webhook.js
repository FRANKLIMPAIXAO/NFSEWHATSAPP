/**
 * scripts/simular-webhook.js
 * Simula o fluxo completo do webhook do WhatsApp SEM precisar de Evolution real
 * nem de Anthropic API. Faz:
 *   1. Cria conversa no estado "aguardando_confirmacao" com payload pronto
 *   2. Dispara handleWebhook() com mensagem "SIM" do cliente
 *   3. Webhook chama o roteador → emissor → ROCA emite via EPN → DANF-Se
 *   4. WhatsApp em DRY_RUN só loga as mensagens (não vai pra Evolution real)
 *
 * Setup: WHATSAPP_DRY_RUN=1 obrigatório.
 */
import "dotenv/config";

if (process.env.WHATSAPP_DRY_RUN !== "1") {
    console.error("❌ Defina WHATSAPP_DRY_RUN=1 antes de rodar este script.");
    console.error("   Exemplo: WHATSAPP_DRY_RUN=1 node scripts/simular-webhook.js");
    process.exit(1);
}

const {
    findEmpresaById,
    insertConversa,
} = await import("../src/db/index.js");
const { handleWebhook } = await import("../src/handlers/webhook.js");

const empresa = findEmpresaById.get(2); // ROCA
if (!empresa) throw new Error("ROCA (id=2) não cadastrada");

const numero = empresa.whatsapp_dono;

// Payload da extração (como se Claude já tivesse extraído de um áudio)
const payloadExtracao = {
    status: "ok",
    tomador: {
        tipo: "PJ",
        documento: "01060996000193",
        razao_social: "INDUSTRIA DE LATICINIO CLAVEAUX LTDA",
        endereco: {
            cMun: "5201405",
            cep: "74921303",
            xLgr: "Rua X 41",
            nro: "SN",
            xBairro: "Setor Tocantins",
        },
    },
    servico: {
        descricao: "Serviços prestados",
        codigo_lc116: empresa.servico_padrao_lc116,
        codigo_servico_nacional: empresa.servico_padrao_lc116,
        valor_total: 1.0,
    },
    competencia: new Date().toISOString().slice(0, 10),
    resumo_confirmacao:
        "Vou emitir NFS-e de R$ 1,00 pra Indústria Laticínio Claveaux LTDA — Serviços prestados.",
};

console.log("==========================================");
console.log("SIMULADOR — webhook → roteador → EPN");
console.log("==========================================");
console.log("Empresa:", empresa.razao_social, "(id=" + empresa.id + ")");
console.log("Número :", numero);
console.log("Emissor:", empresa.emissor);
console.log("");

// 1. Cria conversa em "aguardando_confirmacao" com extração pronta
const c = insertConversa.run(
    empresa.id,
    numero,
    "aguardando_confirmacao",
    JSON.stringify(payloadExtracao),
    null
);
const conversaId = c.lastInsertRowid;
console.log(`→ Conversa criada (id=${conversaId})\n`);

// 2. Simula recebimento de "SIM" do cliente via webhook
const webhookEvent = {
    event: "messages.upsert",
    data: {
        key: {
            id: `sim-${Date.now()}`,
            remoteJid: `${numero}@s.whatsapp.net`,
            fromMe: false,
        },
        messageType: "conversation",
        message: { conversation: "SIM" },
    },
};

console.log("→ Disparando handleWebhook com 'SIM'...\n");
await handleWebhook(webhookEvent);

console.log("\n→ Aguardando 5s pra logs assíncronos...");
await new Promise((r) => setTimeout(r, 5000));

console.log("\n==========================================");
console.log("FIM — verifica os logs acima.");
console.log("==========================================");
process.exit(0);
