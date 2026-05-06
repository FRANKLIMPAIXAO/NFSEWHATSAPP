-- =========================================================================
-- AGENT NFS-E — Schema SQLite
-- =========================================================================

-- ---------- EMPRESAS (clientes PAC cadastrados no agente) ----------
CREATE TABLE IF NOT EXISTS empresas (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    cnpj            TEXT    NOT NULL UNIQUE,
    razao_social    TEXT    NOT NULL,
    nome_fantasia   TEXT,
    -- número do WhatsApp do dono que pode emitir (formato 5511999998888)
    whatsapp_dono   TEXT    NOT NULL UNIQUE,
    -- token Focus NFe específico desta empresa
    focus_token     TEXT    NOT NULL,
    -- regime tributário: simples_nacional | lucro_presumido | lucro_real
    regime          TEXT    NOT NULL DEFAULT 'simples_nacional',
    -- alíquota ISS padrão municipal (ex: 5.0)
    aliquota_iss    REAL    NOT NULL DEFAULT 5.0,
    -- código serviço LC 116 padrão (pode ser sobreposto por nota)
    servico_padrao_lc116 TEXT,
    municipio_codigo TEXT,
    municipio_nome  TEXT,
    uf              TEXT,
    -- inscrição municipal (exigida pela maioria das prefeituras na NFS-e)
    inscricao_municipal TEXT,
    -- endereço prestador (compactado pra request da Focus)
    endereco_json   TEXT,
    ativa           INTEGER NOT NULL DEFAULT 1,
    criada_em       TEXT    NOT NULL DEFAULT (datetime('now')),
    atualizada_em   TEXT
);

CREATE INDEX IF NOT EXISTS idx_empresas_whatsapp ON empresas(whatsapp_dono);
CREATE INDEX IF NOT EXISTS idx_empresas_cnpj ON empresas(cnpj);


-- ---------- CONVERSAS (estado de cada interação em andamento) ----------
-- Quando o cliente manda áudio incompleto, salvamos o que temos aqui
-- pra retomar quando ele responder.
CREATE TABLE IF NOT EXISTS conversas (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id      INTEGER NOT NULL,
    whatsapp        TEXT    NOT NULL,
    -- estado: aguardando_confirmacao | aguardando_dados | aguardando_aprovacao_admin | finalizada | cancelada
    estado          TEXT    NOT NULL,
    -- payload parcial em JSON (estrutura da NFS-e em construção)
    payload_json    TEXT,
    -- o que ainda falta pro bot perguntar
    campos_faltantes TEXT,
    iniciada_em     TEXT    NOT NULL DEFAULT (datetime('now')),
    atualizada_em   TEXT    NOT NULL DEFAULT (datetime('now')),
    finalizada_em   TEXT,
    FOREIGN KEY (empresa_id) REFERENCES empresas(id)
);

CREATE INDEX IF NOT EXISTS idx_conversas_empresa ON conversas(empresa_id);
CREATE INDEX IF NOT EXISTS idx_conversas_estado ON conversas(estado);


-- ---------- NOTAS EMITIDAS (histórico oficial) ----------
CREATE TABLE IF NOT EXISTS notas_emitidas (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id      INTEGER NOT NULL,
    conversa_id     INTEGER,
    -- referência única enviada pra Focus (idempotência)
    referencia      TEXT    NOT NULL UNIQUE,
    -- status: pendente | autorizada | rejeitada | cancelada
    status          TEXT    NOT NULL DEFAULT 'pendente',
    tomador_documento TEXT,
    tomador_nome    TEXT,
    descricao_servico TEXT,
    valor_total     REAL,
    codigo_lc116    TEXT,
    -- retorno da Focus
    numero_nfse     TEXT,
    codigo_verificacao TEXT,
    url_pdf         TEXT,
    url_xml         TEXT,
    erro_mensagem   TEXT,
    -- audio original e transcrição pra debug
    audio_msg_id    TEXT,
    transcricao     TEXT,
    payload_enviado TEXT,
    response_focus  TEXT,
    criada_em       TEXT    NOT NULL DEFAULT (datetime('now')),
    autorizada_em   TEXT,
    FOREIGN KEY (empresa_id) REFERENCES empresas(id),
    FOREIGN KEY (conversa_id) REFERENCES conversas(id)
);

CREATE INDEX IF NOT EXISTS idx_notas_empresa ON notas_emitidas(empresa_id);
CREATE INDEX IF NOT EXISTS idx_notas_status ON notas_emitidas(status);
CREATE INDEX IF NOT EXISTS idx_notas_referencia ON notas_emitidas(referencia);


-- ---------- EVENTOS (log de tudo, pra debug e auditoria) ----------
CREATE TABLE IF NOT EXISTS eventos (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    -- tipo: msg_recebida | audio_transcrito | extracao | confirmacao | emissao | erro | aprovacao_admin
    tipo            TEXT    NOT NULL,
    empresa_id      INTEGER,
    conversa_id     INTEGER,
    payload         TEXT,
    criado_em       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_eventos_tipo ON eventos(tipo);
CREATE INDEX IF NOT EXISTS idx_eventos_empresa ON eventos(empresa_id);
CREATE INDEX IF NOT EXISTS idx_eventos_data ON eventos(criado_em);

-- ---------- MENSAGENS PROCESSADAS (deduplicação de webhook) ----------
CREATE TABLE IF NOT EXISTS mensagens_processadas (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id      TEXT    NOT NULL UNIQUE,
    numero          TEXT,
    tipo            TEXT,
    criado_em       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_msg_processadas_data ON mensagens_processadas(criado_em);
