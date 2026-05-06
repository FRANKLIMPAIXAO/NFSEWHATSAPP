/**
 * scripts/test-extractor.js
 * Testa o extrator de campos com inputs reais.
 *
 * Uso:
 *   node scripts/test-extractor.js
 *   node scripts/test-extractor.js "seu texto aqui"
 */
import "dotenv/config";
import { extrairCampos } from "../src/services/extractor.js";

const EXEMPLOS = [
    "Emite uma nota de quinhentos reais pro João da Silva CNPJ 12.345.678/0001-99 manutenção de impressora",
    "Faz aí uma NFS de mil e duzentos pra Maria Silva CPF 123.456.789-00 consultoria contábil de abril",
    "manda nota pro Pedro lá da oficina, oitocentos pila, troca de óleo e filtro",
];

const arg = process.argv.slice(2).join(" ");
const inputs = arg ? [arg] : EXEMPLOS;

for (const texto of inputs) {
    console.log("\n" + "═".repeat(70));
    console.log("INPUT:", texto);
    console.log("─".repeat(70));
    try {
        const result = await extrairCampos(texto);
        console.log(JSON.stringify(result, null, 2));
    } catch (err) {
        console.error("ERRO:", err.message);
    }
}
