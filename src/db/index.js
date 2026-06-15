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
// Código NBS padrão (Nomenclatura Brasileira de Serviços, 9 dígitos sem pontos).
// Obrigatório no DPS quando há bloco IBS/CBS — Reforma Tributária. Ex: 120012000
// = manutenção de computadores; 120015000 = manutenção de máquinas industriais.
ensureColumn("empresas", "codigo_nbs_padrao", "TEXT");
// Flag: município do prestador tem cadastro complementar no CNC NFS-e Nacional?
//   0 = não (default seguro) — omite IM do prestador no DPS pra evitar E0120
//   1 = sim — envia IM normalmente. Setar quando município migrar pro CNC ou em produção.
ensureColumn("empresas", "municipio_no_cnc", "INTEGER NOT NULL DEFAULT 0");
// cIndOp padrão (Anexo VII NFS-e Nacional). 6 dígitos. Depende do tipo de
// serviço da empresa. Exemplos:
//   050101 = Inc. V, serviço sobre bem móvel material, estab. fornecedor (manutenção)
//   030101 = Inc. III, demais serviços, estab. fornecedor (consultoria comum)
//   100301 = Inc. X, serviços à distância, domicílio do adquirente
ensureColumn("empresas", "cind_op_padrao", "TEXT");
ensureColumn("empresas", "codigo_tributacao_nacional", "TEXT");
ensureColumn("empresas", "cnae", "TEXT");
// UUID da empresa no Supabase (Pac no Bolso). Quando preenchido, a row é
// "mirror" — serve só de âncora pras foreign keys (conversas, notas_emitidas,
// eventos) que exigem empresa_id INTEGER. A fonte da verdade dos dados é o
// Supabase; o mirror é re-sincronizado a cada mensagem via supabase-repo.
ensureColumn("empresas", "supabase_id", "TEXT");
db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_empresas_supabase_id
    ON empresas(supabase_id)
    WHERE supabase_id IS NOT NULL
`);

// =============================================================
// EMPRESAS
// =============================================================
const findEmpresaByWhatsappStmt = db.prepare(
    "SELECT * FROM empresas WHERE whatsapp_dono = ? AND ativa = 1"
);

// WhatsApp Cloud API ora entrega celular brasileiro com o "nono dígito"
// (5562 9 8642-9305 → 13 chars), ora sem (5562 8642-9305 → 12 chars).
// Geramos as variantes do número e tentamos cada uma — assim o cadastro
// funciona independente do formato que a operadora/Meta entrega no momento.
export function variantesNumeroBr(numero) {
    if (!numero) return [];
    const variants = new Set([numero]);
    // 12 chars: 55 + DDD(2) + 8 dígitos → adiciona o 9 após o DDD
    if (/^55\d{10}$/.test(numero)) {
        variants.add(numero.slice(0, 4) + "9" + numero.slice(4));
    }
    // 13 chars: 55 + DDD(2) + 9 + 8 dígitos → remove o 9 após o DDD
    if (/^55\d{2}9\d{8}$/.test(numero)) {
        variants.add(numero.slice(0, 4) + numero.slice(5));
    }
    return [...variants];
}

export function mesmoNumeroBr(a, b) {
    if (!a || !b) return false;
    const va = variantesNumeroBr(a);
    return va.includes(b) || variantesNumeroBr(b).some((x) => va.includes(x));
}

export const findEmpresaByWhatsapp = {
    get(numero) {
        for (const variant of variantesNumeroBr(numero)) {
            const row = findEmpresaByWhatsappStmt.get(variant);
            if (row) return row;
        }
        return undefined;
    },
};

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

// -------- Mirror Supabase --------
const findMirrorBySupabaseIdStmt = db.prepare(
    "SELECT id FROM empresas WHERE supabase_id = ?"
);
const insertMirrorStmt = db.prepare(`
    INSERT INTO empresas
        (cnpj, razao_social, nome_fantasia, whatsapp_dono, focus_token,
         regime, aliquota_iss, servico_padrao_lc116,
         municipio_codigo, municipio_nome, uf, inscricao_municipal, endereco_json,
         emissor, cert_pfx_path, cert_pfx_password, codigo_nbs_padrao,
         cind_op_padrao, municipio_no_cnc, codigo_tributacao_nacional, cnae,
         supabase_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const updateMirrorStmt = db.prepare(`
    UPDATE empresas
    SET razao_social = ?, nome_fantasia = ?, focus_token = ?,
        regime = ?, aliquota_iss = ?, servico_padrao_lc116 = ?,
        municipio_codigo = ?, uf = ?, inscricao_municipal = ?, endereco_json = ?,
        emissor = ?, cert_pfx_path = ?, cert_pfx_password = ?,
        codigo_nbs_padrao = ?, cind_op_padrao = ?, municipio_no_cnc = ?,
        codigo_tributacao_nacional = ?, cnae = ?,
        atualizada_em = datetime('now')
    WHERE id = ?
`);

/**
 * Garante uma row mirror no SQLite local pra uma empresa que veio do Supabase.
 * Retorna o `id INTEGER` da row local — usado nas foreign keys de conversas,
 * notas_emitidas e eventos.
 *
 * Comportamento: SINCRONIZA todos os campos relevantes a cada chamada
 * (não é "find or skip"). Garante que o mirror reflete o estado atual do
 * Supabase — se você mudar emissor/cert/IM no painel do Pac, próxima
 * mensagem do cliente já pega os valores novos.
 *
 * whatsapp_dono fica `supa:<uuid>` (placeholder único) pra NÃO bater com
 * findEmpresaByWhatsapp do fallback SQLite — assim Roca/El Shadai continuam
 * sendo identificadas pelo número real, e clientes do Pac vêm só via Supabase.
 *
 * @param {object} empresaSupa — objeto saído de supabaseRowToEmpresa
 * @returns {number} id INTEGER local
 */
export function getOrCreateMirrorEmpresa(empresaSupa) {
    const supabaseId = empresaSupa.id;
    if (!supabaseId) {
        throw new Error("getOrCreateMirrorEmpresa: empresa sem id (UUID)");
    }
    const existing = findMirrorBySupabaseIdStmt.get(supabaseId);
    if (existing) {
        updateMirrorStmt.run(
            empresaSupa.razao_social,
            empresaSupa.nome_fantasia,
            empresaSupa.focus_token || "-",
            empresaSupa.regime || "simples_nacional",
            Number(empresaSupa.aliquota_iss) || 0,
            empresaSupa.servico_padrao_lc116,
            empresaSupa.municipio_codigo,
            empresaSupa.uf,
            empresaSupa.inscricao_municipal,
            empresaSupa.endereco_json,
            empresaSupa.emissor || "focus",
            empresaSupa.cert_pfx_path,
            empresaSupa.cert_pfx_password,
            empresaSupa.codigo_nbs_padrao,
            empresaSupa.cind_op_padrao,
            empresaSupa.municipio_no_cnc ? 1 : 0,
            empresaSupa.codigo_tributacao_nacional,
            empresaSupa.cnae,
            existing.id
        );
        return existing.id;
    }
    const result = insertMirrorStmt.run(
        empresaSupa.cnpj,
        empresaSupa.razao_social,
        empresaSupa.nome_fantasia,
        `supa:${supabaseId}`,
        empresaSupa.focus_token || "-",
        empresaSupa.regime || "simples_nacional",
        Number(empresaSupa.aliquota_iss) || 0,
        empresaSupa.servico_padrao_lc116,
        empresaSupa.municipio_codigo,
        null,
        empresaSupa.uf,
        empresaSupa.inscricao_municipal,
        empresaSupa.endereco_json,
        empresaSupa.emissor || "focus",
        empresaSupa.cert_pfx_path,
        empresaSupa.cert_pfx_password,
        empresaSupa.codigo_nbs_padrao,
        empresaSupa.cind_op_padrao,
        empresaSupa.municipio_no_cnc ? 1 : 0,
        empresaSupa.codigo_tributacao_nacional,
        empresaSupa.cnae,
        supabaseId
    );
    return result.lastInsertRowid;
}

// =============================================================
// CONVERSAS
// =============================================================
export const findConversaAtiva = db.prepare(`
    SELECT * FROM conversas
    WHERE empresa_id = ? AND whatsapp = ?
      AND estado IN ('aguardando_confirmacao', 'aguardando_dados')
    ORDER BY iniciada_em DESC LIMIT 1
`);
// Modelo Pac multi-tenant: o dono confirma "Sim" e emite direto. Não tem mais
// estado intermediário 'aguardando_aprovacao_admin'. Conversas em
// 'aguardando_sefaz' (callback async pós-emissão) NÃO entram na query — uma
// nova msg do dono nesse estado cria conversa nova (paralela).

// Conversa FINANCEIRA aguardando complemento (ex: bot perguntou "no que
// gastou?" e tá esperando "Restaurante"). Separada da NFSe pra não
// confundir os handlers — cada tipo tem seu próprio estado intermediário.
export const findConversaFinanceiraAtiva = db.prepare(`
    SELECT * FROM conversas
    WHERE empresa_id = ? AND whatsapp = ?
      AND estado IN ('financeiro_aguardando_dados')
    ORDER BY iniciada_em DESC LIMIT 1
`);

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
        response_focus = ?, autorizada_em = CASE WHEN ? = 'autorizado' THEN datetime('now') ELSE autorizada_em END
    WHERE id = ?
`);

export const findNotaByReferencia = db.prepare(`
    SELECT * FROM notas_emitidas WHERE referencia = ?
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
