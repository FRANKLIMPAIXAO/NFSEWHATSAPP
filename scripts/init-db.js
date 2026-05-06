/**
 * scripts/init-db.js
 * Cria o schema do banco. Roda uma vez antes de subir o servidor.
 */
import "dotenv/config";
import { db } from "../src/db/index.js";

console.log("✓ Banco inicializado em:", process.env.DB_PATH || "./data/agent.db");
console.log("✓ Tabelas criadas:");
const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
).all();
tables.forEach((t) => console.log("  -", t.name));
