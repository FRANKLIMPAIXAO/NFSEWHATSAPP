/**
 * src/db/empresa-adapter.js
 * Converte row de `poupeja_fiscal_emitentes` (Supabase) → objeto `empresa`
 * no formato que `epn.js`, `focusnfe.js` e `emissor.js` consomem hoje.
 *
 * Etapa 3 do refactor. Sem efeito colateral no fluxo do agent ainda
 * (módulo é só chamado se a etapa 4 plugar). Cert .pfx é escrito em
 * `data/certs/<id>.pfx` na primeira leitura e cacheado em memória.
 */
import fs from "fs";
import path from "path";
import { logger } from "../utils/logger.js";

const CERTS_DIR = path.resolve(process.cwd(), "data", "certs");

// Cache emitente_id → cert_pfx_path. Evita re-escrever o arquivo a cada
// mensagem do WhatsApp. Invalidação manual: restart do container.
const certCache = new Map();

/**
 * Normaliza flag boolean lida do Supabase. Defensivo contra coluna criada
 * como TEXT (string "true"/"false") ou SMALLINT (0/1) por engano. Retorna
 * boolean estrito, default false quando indeterminado.
 */
function normalizarFlagBoolean(valor) {
    if (typeof valor === "boolean") return valor;
    if (typeof valor === "number") return valor !== 0;
    if (typeof valor === "string") {
        const s = valor.trim().toLowerCase();
        if (s === "true" || s === "t" || s === "1") return true;
        if (s === "false" || s === "f" || s === "0" || s === "") return false;
    }
    return false;
}

/**
 * Traduz regime_tributario (smallint do Pac, padrão CRT da NFe) → string
 * que o agent usa internamente. Só MEI + Simples são suportados — o
 * nicho-alvo (oficina/mecânica/pequeno prestador) não inclui Lucro Real
 * nem Lucro Presumido. Valores fora do esperado caem em fallback seguro
 * (simples_nacional) com warning.
 *
 * 1 = Simples Nacional ME/EPP
 * 4 = MEI
 */
function regimeNumericoToString(n) {
    switch (Number(n)) {
        case 1:
            return "simples_nacional";
        case 4:
            return "mei";
        default:
            logger.warn(
                { regime_tributario: n },
                "empresa-adapter: regime_tributario fora do esperado (1=Simples, 4=MEI). Assumindo simples_nacional"
            );
            return "simples_nacional";
    }
}

/**
 * Escreve o cert .pfx em disco se ainda não foi escrito nesta execução.
 * Retorna o path. Retorna null se a row não tem cert (caso típico de
 * empresa que só usa Focus — Focus não precisa de cert local).
 */
function escreverCertSeNecessario(row) {
    if (!row.cert_pfx_base64) return null;

    const cached = certCache.get(row.id);
    if (cached && fs.existsSync(cached)) return cached;

    if (!fs.existsSync(CERTS_DIR)) {
        fs.mkdirSync(CERTS_DIR, { recursive: true });
    }

    const certPath = path.join(CERTS_DIR, `${row.id}.pfx`);
    fs.writeFileSync(
        certPath,
        Buffer.from(row.cert_pfx_base64, "base64"),
        { mode: 0o600 }
    );
    certCache.set(row.id, certPath);

    logger.info(
        { emitenteId: row.id, certPath },
        "empresa-adapter: cert .pfx escrito em disco a partir do Supabase"
    );
    return certPath;
}

/**
 * Converte row do Supabase pra objeto empresa que o agent entende.
 *
 * @param {object} row — linha de poupeja_fiscal_emitentes
 * @returns {object|null} empresa no formato legado, ou null se row vazia
 */
export function supabaseRowToEmpresa(row) {
    if (!row) return null;

    const certPath = escreverCertSeNecessario(row);

    // Endereço — agent espera JSON string em endereco_json
    const endereco_json = JSON.stringify({
        logradouro: row.logradouro || "",
        numero: row.numero || "S/N",
        complemento: row.complemento || "",
        bairro: row.bairro || "",
        cep: String(row.cep || "").replace(/\D/g, ""),
    });

    // Focus token: usa producao ou homologacao baseado em FOCUS_NFE_ENV
    // (mesma env que focusnfe.js consome — alinha com convenção existente).
    // Se o cliente é puro EPN, esses campos são null e o focus_token sai null
    // (não usado).
    const focusAmbiente =
        process.env.FOCUS_NFE_ENV === "producao" ? "producao" : "homologacao";
    const focus_token =
        focusAmbiente === "producao"
            ? row.focus_token_producao
            : row.focus_token_homologacao;

    return {
        // identidade
        id: row.id,
        cnpj: row.cnpj,
        razao_social: row.nome,
        nome_fantasia: row.nome_fantasia,
        inscricao_municipal: row.im,

        // endereço/local
        municipio_codigo: row.municipio,
        uf: row.uf,
        endereco_json,

        // regime tributário (CRT → string)
        regime: regimeNumericoToString(row.regime_tributario),

        // backend de emissão
        emissor: row.emissor || "focus",

        // EPN — cert + tributação
        cert_pfx_path: certPath,
        cert_pfx_password: row.cert_pfx_password,
        municipio_no_cnc: row.municipio_no_cnc === true,
        servico_padrao_lc116: row.codigo_servico_nacional,
        codigo_nbs_padrao: row.codigo_nbs_padrao,
        cind_op_padrao: row.cind_op_padrao,
        aliquota_iss: row.aliquota_iss,

        // Focus
        focus_token,
        codigo_tributacao_nacional: row.codigo_servico_nacional,
        cnae: row.cnae, // obrigatório pra Goiânia (e outros municípios ABRASF)
        // Contador RPS — Aparecida exige sequencial (E090). Incrementado pelo agent
        // após cada emissão bem-sucedida.
        proximo_numero_rps: row.proximo_numero_rps || 1,
        serie_rps_padrao: row.serie_rps || undefined,
        // Código de atividade econômica cadastrado na prefeitura (Goiânia
        // exige no <cTribMun>). Sem isso, fallback pro LC 116 6 dígitos
        // (provavelmente rejeitado pelo XSD municipal).
        codigo_atividade_municipal: row.codigo_atividade_municipal || undefined,
        // Ambiente Nacional NFSe (LC 214/2025): true → endpoint /v2/nfsen +
        // montarPayloadNacional. Goiânia ainda usa ABRASF municipal em 2026
        // (false); Aparecida já migrou pro Nacional (true). Empresa precisa
        // ter "Ambiente da NFSe Nacional" habilitado no painel Focus.
        //
        // Normaliza valor: aceita boolean, "true"/"false" string (Supabase
        // pode armazenar como text se coluna foi criada errado), 0/1, null.
        // Default false (caminho municipal/ABRASF) quando indeterminado.
        usa_nfse_nacional: normalizarFlagBoolean(row.usa_nfse_nacional),

        // WhatsApp
        whatsapp_dono: row.whatsapp_dono,

        // Origem (debug)
        _source: "supabase",
        // user_id do Supabase Auth — usado pra gravar notas em poupeja_nfse
        // mantendo o RLS por usuário (cada cliente vê só as próprias notas).
        _supabaseUserId: row.user_id,
    };
}
