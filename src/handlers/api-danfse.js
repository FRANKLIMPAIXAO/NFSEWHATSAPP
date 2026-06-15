/**
 * src/handlers/api-danfse.js
 * Endpoint HTTP que gera DANFSe (PDF) a partir do XML autorizado.
 * Necessário porque a Focus NFe não entrega PDF binário pra NFSe ABRASF
 * municipal nem Nacional ISSNET (Aparecida) — só HTML do portal da
 * prefeitura. Para o painel PacNoBolso exibir um PDF real, baixamos o
 * XML autorizado e geramos a DANFSe localmente via lib `nfse-nacional`.
 *
 * Fluxo:
 *   1. Valida JWT do Supabase Auth
 *   2. Busca a nota em poupeja_nfse pelo ref (escopado por user_id)
 *   3. Busca a empresa correspondente pelo cnpj_prestador
 *   4. Baixa XML da Focus com o token da empresa
 *   5. Gera PDF via DanfeService.generateFromXml
 *   6. Retorna application/pdf inline
 */
import { DanfeService } from "nfse-nacional";
import { supabase } from "../supabase.js";
import { baixarXml } from "../services/focusnfe.js";
import { gerarDanfseAbrasf, detectarFormatoXml } from "../services/danfse-abrasf.js";
import { logger } from "../utils/logger.js";

function jsonResponse(res, status, body) {
    res.status(status).json(body);
}

export async function handleApiDanfse(req, res) {
    try {
        const ref = req.params?.ref || req.query?.ref;
        if (!ref || typeof ref !== "string") {
            return jsonResponse(res, 400, {
                error: "invalid_ref",
                message: "Parâmetro ref obrigatório",
            });
        }

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
            logger.warn({ err: authErr?.message }, "api-danfse: token inválido");
            return jsonResponse(res, 401, {
                error: "invalid_token",
                message: authErr?.message || "Token JWT inválido ou expirado",
            });
        }
        const userId = userData.user.id;

        // Busca nota escopada por user — guarda contra ref forjada
        const { data: nota, error: notaErr } = await supabase
            .from("poupeja_nfse")
            .select("ref, cnpj_prestador, chave_nfse, numero_nfse, status, caminho_xml, payload")
            .eq("user_id", userId)
            .eq("ref", ref)
            .maybeSingle();

        if (notaErr || !nota) {
            return jsonResponse(res, 404, {
                error: "nota_nao_encontrada",
                message: "Nota não existe ou não pertence ao usuário",
            });
        }

        if (nota.status !== "autorizado") {
            return jsonResponse(res, 422, {
                error: "nota_nao_autorizada",
                message: `Nota está em status '${nota.status}'. DANFSe só pra notas autorizadas.`,
            });
        }

        // Busca empresa pra pegar token Focus + flag nacional.
        // Tenta primeiro via payload.emitenteSupabaseId (UUID, salvo pelo
        // agent quando emite via WhatsApp). Fallback: CNPJ limpo.
        // Ambiente vem da env FOCUS_NFE_ENV (não há coluna no banco).
        const emitenteIdNoPayload = nota.payload?.emitenteSupabaseId
            || nota.payload?.empresa_id
            || null;
        const cnpjLimpo = String(nota.cnpj_prestador || "").replace(/\D/g, "");

        const selectCols = "focus_token_producao, focus_token_homologacao, usa_nfse_nacional";
        let empresa = null;
        let empErr = null;
        if (emitenteIdNoPayload) {
            const r = await supabase
                .from("poupeja_fiscal_emitentes")
                .select(selectCols)
                .eq("user_id", userId)
                .eq("id", emitenteIdNoPayload)
                .maybeSingle();
            empresa = r.data;
            empErr = r.error;
        }
        if (!empresa && cnpjLimpo) {
            const r = await supabase
                .from("poupeja_fiscal_emitentes")
                .select(selectCols)
                .eq("user_id", userId)
                .eq("cnpj", cnpjLimpo)
                .maybeSingle();
            empresa = r.data;
            empErr = r.error;
        }

        if (empErr || !empresa) {
            logger.warn(
                { err: empErr?.message, cnpjLimpo, emitenteIdNoPayload, userId, ref },
                "api-danfse: empresa não encontrada"
            );
            return jsonResponse(res, 404, {
                error: "empresa_nao_encontrada",
                message: "Empresa emitente não encontrada",
            });
        }

        const ambiente = process.env.FOCUS_NFE_ENV === "producao" ? "producao" : "homologacao";
        const focusToken = ambiente === "homologacao"
            ? empresa.focus_token_homologacao
            : empresa.focus_token_producao;

        if (!focusToken) {
            return jsonResponse(res, 500, {
                error: "token_focus_ausente",
                message: `Token Focus de ${ambiente} não configurado pra essa empresa`,
            });
        }

        // Baixa XML — passa nota.caminho_xml se já tiver (mais rápido)
        const empresaShim = {
            focus_token: focusToken,
            ambiente_focus: ambiente,
            usa_nfse_nacional: !!empresa.usa_nfse_nacional,
        };
        const xml = await baixarXml(ref, focusToken, empresaShim, nota.caminho_xml || null);
        const formato = detectarFormatoXml(xml);

        logger.info({ ref, formato, tamanho: xml.length }, "api-danfse: gerando PDF");

        let pdfBuffer;
        if (formato === "abrasf") {
            pdfBuffer = await gerarDanfseAbrasf(xml);
        } else {
            // Nacional 1.01 (ou desconhecido — tenta Nacional como fallback)
            const danfe = new DanfeService();
            const out = await Promise.race([
                danfe.generateFromXml(xml, { chaveAcesso: nota.chave_nfse || nota.numero_nfse || ref }),
                new Promise((_, rej) => setTimeout(() => rej(new Error("DANFSe timeout 20s")), 20000)),
            ]);
            if (!out?.pdfBytes) {
                return jsonResponse(res, 500, {
                    error: "danfse_falhou",
                    message: "DanfeService não retornou PDF",
                });
            }
            pdfBuffer = Buffer.from(out.pdfBytes);
        }
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `inline; filename="NFS-e-${nota.numero_nfse || ref}.pdf"`);
        res.setHeader("Content-Length", pdfBuffer.length);
        return res.status(200).send(pdfBuffer);
    } catch (err) {
        logger.error({ err: err.message, stack: err.stack }, "api-danfse: erro");
        return jsonResponse(res, 500, {
            error: "internal_error",
            message: err.message || "Erro inesperado",
        });
    }
}
