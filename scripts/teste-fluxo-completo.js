/**
 * scripts/teste-fluxo-completo.js
 * Teste do fluxo completo via roteador: emissor.js → EPN → persiste → DANF-Se.
 */
import "dotenv/config";
import { db, findEmpresaById } from "../src/db/index.js";
import { emitirNFSe } from "../src/services/emissor.js";

const empresa = findEmpresaById.get(2); // ROCA
if (!empresa) throw new Error("ROCA (id=2) não cadastrada");

console.log("=========================================");
console.log("FLUXO COMPLETO — ROTEADOR + PERSIST + PDF");
console.log("=========================================");
console.log("Empresa  :", empresa.razao_social);
console.log("Emissor  :", empresa.emissor);
console.log("");

const params = {
    empresa,
    competencia: new Date().toISOString().slice(0, 10),
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
};

const result = await emitirNFSe(params);

console.log("\n=== RESULTADO ===");
console.log("OK            :", result.ok);
console.log("Status        :", result.status);
console.log("Emissor       :", result.emissor);
console.log("Referência    :", result.referencia);
console.log("Nota DB id    :", result.notaId);
if (result.chaveAcesso) {
    console.log("Chave acesso  :", result.chaveAcesso);
    console.log("Número NFSe   :", result.numero);
    console.log("DANF-Se path  :", result.pdfPath);
}
if (result.erro) console.log("Erro          :", result.erro);

console.log("\n=== VALIDAÇÃO DB ===");
const row = db.prepare(`
    SELECT id, status, numero_nfse, codigo_verificacao, url_pdf, valor_total, criada_em, autorizada_em
    FROM notas_emitidas WHERE id = ?
`).get(result.notaId);
console.log(JSON.stringify(row, null, 2));
