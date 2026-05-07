/**
 * scripts/consultar-ultima.js
 * Consulta status da última referência usada no teste-emissao.
 * Aceita referência como argumento OU lê do .env temporário.
 */
import "dotenv/config";
import { findEmpresaById } from "../src/db/index.js";
import { consultarNFSe } from "../src/services/focusnfe.js";

const ref = process.argv[2];
const empresaId = Number(process.argv[3]) || 1;
if (!ref) {
    console.error("Uso: node scripts/consultar-ultima.js <referencia> [empresa_id]");
    process.exit(1);
}

const empresa = findEmpresaById.get(empresaId);
const result = await consultarNFSe(ref, empresa.focus_token, empresa);
console.log("Status:", result.status);
console.log(JSON.stringify(result, null, 2));
