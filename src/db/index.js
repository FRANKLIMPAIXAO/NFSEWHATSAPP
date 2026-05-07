/**
 * src/db/index.js
 * Conexão SQLite + helpers de query com prepared statements.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || "./data/agent.db";

// garante diretório
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// roda schema na primeira vez
const schemaPath = path.join(__dirname, "schema.sql");
if (fs.existsSync(schemaPath)) {
    const schema = fs.readFileSync(schemaPath, "utf8");
    db.exec(schema);
}

// migrações idempotentes pra bancos já criados antes de mudanças no schema
function ensureColumn(table, column, definition) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
}
ensureColumn("empresas", "inscricao_municipal", "TEXT");
// Certificado A1 (.pfx/.p12) — necessário pra emissão direta na API do EPN.
ensureColumn("empresas", "cert_pfx_path", "TEXT");
ensureColumn("empresas", "cert_pfx_password", "TEXT");
// Emissor: 'focus' (default, via Focus NFe) ou 'epn' (direto na SEFAZ Nacional)
ensureColumn("empresas", "emissor", "TEXT NOT NULL DEFAULT 'focus'");

// =============================================================
// EMPRESAS
// =============================================================
export const findEmpresaByWhatsapp = db.prepare(
    "SELECT * FROM empresas WHERE whatsapp_dono = ? AND ativa = 1"
);

export const findEmpresaById = db.prepare(
    "SELECT * FROM empresas WHERE id = ?"
);

export const insertEmpresa = db.prepare(`
    INSERT INTO empresas
        (cnpj, razao_social, nome_fantasia, whatsapp_dono, focus_token,
         regime, aliquota_iss, servico_padrao_lc116,
         municipio_codigo, municipio_nome, uf, inscricao_municipal, endereco_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// =============================================================
// CONVERSAS
// =============================================================
export const findConversaAtiva = db.prepare(`
    SELECT * FROM conversas
    WHERE empresa_id = ? AND whatsapp = ?
      AND estado IN ('aguardando_confirmacao', 'aguardando_dados', 'aguardando_aprovacao_admin')
    ORDER BY iniciada_em DESC LIMIT 1
`);
// Nota: 'aguardando_aprovacao_admin' permanece na query para que o handler
// detecte e responda ao cliente com mensagem de aguardo (sem reextrair).

export const findConversaById = db.prepare(`
    SELECT * FROM conversas WHERE id = ?
`);

export const insertConversa = db.prepare(`
    INSERT INTO conversas (empresa_id, whatsapp, estado, payload_json, campos_faltantes)
    VALUES (?, ?, ?, ?, ?)
`);

export const updateConversa = db.prepare(`
    UPDATE conversas
    SET estado = ?, payload_json = ?, campos_faltantes = ?,
        atualizada_em = datetime('now')
    WHERE id = ?
`);

export const finalizarConversa = db.prepare(`
    UPDATE conversas
    SET estado = ?, finalizada_em = datetime('now'),
        atualizada_em = datetime('now')
    WHERE id = ?
`);

// =============================================================
// NOTAS EMITIDAS
// =============================================================
export const insertNota = db.prepare(`
    INSERT INTO notas_emitidas
        (empresa_id, conversa_id, referencia, status,
         tomador_documento, tomador_nome, descricao_servico,
         valor_total, codigo_lc116, audio_msg_id, transcricao,
         payload_enviado)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export const updateNotaStatus = db.prepare(`
    UPDATE notas_emitidas
    SET status = ?, numero_nfse = ?, codigo_verificacao = ?,
        url_pdf = ?, url_xml = ?, erro_mensagem = ?,
        response_focus = ?, autorizada_em = CASE WHEN ? = 'autorizada' THEN datetime('now') ELSE autorizada_em END
    WHERE id = ?
`);

// =============================================================
// DEDUPLICAÇÃO DE WEBHOOK
// =============================================================
const insertMensagemProcessadaStmt = db.prepare(`
    INSERT INTO mensagens_processadas (message_id, numero, tipo)
    VALUES (?, ?, ?)
`);

export function registrarMensagemProcessada(messageId, numero, tipo) {
    try {
        insertMensagemProcessadaStmt.run(messageId, numero || null, tipo || null);
        return true;
    } catch (err) {
        if (String(err.message || "").includes("UNIQUE")) {
            return false;
        }
        throw err;
    }
}

// =============================================================
// EVENTOS (audit log)
// =============================================================
const insertEvento = db.prepare(`
    INSERT INTO eventos (tipo, empresa_id, conversa_id, payload)
    VALUES (?, ?, ?, ?)
`);

export function logEvento(tipo, empresaId, conversaId, payload) {
    insertEvento.run(
        tipo,
        empresaId || null,
        conversaId || null,
        payload ? JSON.stringify(payload) : null
    );
}
