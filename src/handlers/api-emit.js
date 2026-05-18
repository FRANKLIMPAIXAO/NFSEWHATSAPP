/**
 * src/handlers/api-emit.js
 * Endpoint HTTP pra emissão de NFS-e pelo painel PacNoBolso (ou qualquer
 * outro canal autenticado). Espelha o que o WhatsApp faz internamente, mas
 * pula a extração de áudio (o painel envia payload estruturado direto).
 *
 * Fluxo:
 *   1. Valida JWT do Supabase Auth no header Authorization
 *   2. Extrai user_id do token
 *   3. Busca empresa por (empresa_id, user_id) — guarda contra ID forjado
 *   4. Adapta empresa pelo mesmo supabaseRowToEmpresa que o WhatsApp usa
 *   5. Chama emitirNFSe() do emissor.js — mesma lógica, mesmo padrão de
 *      persistência no SQLite + Supabase, mesmo callback async via webhook
 *   6. Retorna JSON com referencia, status, numero, chave
 *
 * Erros (sempre JSON com {error, message}):
 *   400 — payload inválido / campos obrigatórios faltando
 *   401 — token ausente, inválido ou expirado
 *   403 — empresa não encontrada ou não pertence ao user
 *   422 — SEFAZ rejeitou (com motivo no message)
 *   500 — erro interno (logs do agent)
 */
import { supabase } from "../supabase.js";
import { findEmitenteByIdAndUser } from "../db/supabase-repo.js";
import { supabaseRowToEmpresa } from "../db/empresa-adapter.js";
import { getOrCreateMirrorEmpresa } from "../db/index.js";
import { emitirNFSe } from "../services/emissor.js";
import { logger } from "../utils/logger.js";

function jsonResponse(res, status, body) {
    res.status(status).json(body);
}

function validarPayload(body) {
    const erros = [];
    if (!body.empresa_id || typeof body.empresa_id !== "string") {
        erros.push("empresa_id obrigatório (UUID da empresa)");
    }
    if (!body.tomador || typeof body.tomador !== "object") {
        erros.push("tomador obrigatório");
    } else {
        if (!body.tomador.tipo || !["PF", "PJ"].includes(body.tomador.tipo)) {
            erros.push("tomador.tipo deve ser 'PF' ou 'PJ'");
        }
        if (!body.tomador.documento) {
            erros.push("tomador.documento obrigatório (CPF ou CNPJ)");
        }
        if (!body.tomador.razao_social) {
            erros.push("tomador.razao_social obrigatório");
        }
    }
    if (!body.servico || typeof body.servico !== "object") {
        erros.push("servico obrigatório");
    } else {
        if (!body.servico.descricao) erros.push("servico.descricao obrigatório");
        const valor = Number(body.servico.valor_total);
        if (!isFinite(valor) || valor <= 0) {
            erros.push("servico.valor_total deve ser número positivo");
        }
    }
    return erros;
}

/**
 * Handler principal. Compatível com signatura Express (req, res).
 */
export async function handleApiEmit(req, res) {
    try {
        // 1. Auth — Bearer <jwt> do Supabase
        const authHeader = req.headers["authorization"] || "";
        const match = authHeader.match(/^Bearer\s+(.+)$/i);
        if (!match) {
            return jsonResponse(res, 401, {
                error: "missing_token",
                message: "Header Authorization: Bearer <jwt> obrigatório",
            });
        }
        const jwt = match[1];

        if (!supabase) {
            return jsonResponse(res, 500, {
                error: "supabase_offline",
                message: "Cliente Supabase não inicializado no agent",
            });
        }

        const { data: userData, error: authErr } = await supabase.auth.getUser(jwt);
        if (authErr || !userData?.user?.id) {
            logger.warn({ err: authErr?.message }, "api-emit: token inválido");
            return jsonResponse(res, 401, {
                error: "invalid_token",
                message: authErr?.message || "Token JWT inválido ou expirado",
            });
        }
        const userId = userData.user.id;

        // 2. Validação do payload
        const body = req.body || {};
        const errosValidacao = validarPayload(body);
        if (errosValidacao.length > 0) {
            return jsonResponse(res, 400, {
                error: "invalid_payload",
                message: errosValidacao.join("; "),
            });
        }

        // 3. Busca empresa garantindo que pertence ao user
        const row = await findEmitenteByIdAndUser(body.empresa_id, userId);
        if (!row) {
            return jsonResponse(res, 403, {
                error: "empresa_nao_encontrada",
                message: "Empresa não existe ou não pertence ao usuário autenticado",
            });
        }

        // 4. Adapta empresa (preenche cert do disco, normaliza usa_nfse_nacional, etc)
        const empresa = supabaseRowToEmpresa(row);
        empresa._supabaseId = empresa.id;
        empresa.id = getOrCreateMirrorEmpresa(empresa); // ID INTEGER pro SQLite

        logger.info(
            { userId, empresaSupabaseId: empresa._supabaseId, empresaMirrorId: empresa.id, valor: body.servico.valor_total },
            "api-emit: emissão solicitada pelo painel"
        );

        // 5. Emite — mesma função que o WhatsApp usa
        const result = await emitirNFSe({
            empresa,
            tomador: body.tomador,
            servico: body.servico,
            competencia: body.competencia,
            // conversaId fica null aqui — não é fluxo WhatsApp
        });

        // 6. Mapeia resultado pra HTTP status
        if (result.status === "rejeitado" || result.status === "rejeitada") {
            return jsonResponse(res, 422, {
                error: "sefaz_rejeitou",
                message: result.erro || "SEFAZ rejeitou a emissão",
                referencia: result.referencia,
                response: result.response,
            });
        }

        // Sucesso (autorizado direto OU pendente — webhook async vai completar)
        return jsonResponse(res, 200, {
            ok: true,
            referencia: result.referencia,
            status: result.status,
            numero: result.numero || null,
            chave: result.chaveAcesso || null,
            emissor: result.emissor,
        });
    } catch (err) {
        logger.error({ err: err.message, stack: err.stack }, "api-emit: erro interno");
        return jsonResponse(res, 500, {
            error: "internal_error",
            message: err.message,
        });
    }
}
