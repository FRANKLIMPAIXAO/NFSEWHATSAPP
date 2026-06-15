/**
 * src/handlers/api-enviar-nfse-whatsapp.js
 * Endpoint POST /api/enviar-nfse-whatsapp/:ref — gera DANFSe e envia
 * pro WhatsApp do dono da empresa. Usado como botão "Enviar no Zap"
 * no painel quando o webhook automático falhou ou foi engolido.
 *
 * Idempotente do ponto de vista do user: pode clicar várias vezes,
 * sempre re-envia o PDF.
 */
import { DanfeService } from "nfse-nacional";
import { supabase } from "../supabase.js";
import { baixarXml } from "../services/focusnfe.js";
import { gerarDanfseAbrasf, detectarFormatoXml } from "../services/danfse-abrasf.js";
import { enviarPdf } from "../services/whatsapp.js";
import { logger } from "../utils/logger.js";

function jsonResponse(res, status, body) {
    res.status(status).json(body);
}

export async function handleApiEnviarNfseWhatsapp(req, res) {
    try {
        const ref = req.params?.ref;
        if (!ref) {
            return jsonResponse(res, 400, { error: "invalid_ref", message: "Parâmetro ref obrigatório" });
        }

        // Auth JWT
        const authHeader = req.headers["authorization"] || "";
        const match = authHeader.match(/^Bearer\s+(.+)$/i);
        if (!match) {
            return jsonResponse(res, 401, { error: "missing_token", message: "Bearer JWT obrigatório" });
        }
        const { data: userData, error: authErr } = await supabase.auth.getUser(match[1]);
        if (authErr || !userData?.user?.id) {
            return jsonResponse(res, 401, { error: "invalid_token", message: "Token inválido" });
        }
        const userId = userData.user.id;

        // Busca nota
        const { data: nota } = await supabase
            .from("poupeja_nfse")
            .select("ref, cnpj_prestador, chave_nfse, numero_nfse, status, caminho_xml, valor_servico, payload")
            .eq("user_id", userId)
            .eq("ref", ref)
            .maybeSingle();

        if (!nota) {
            return jsonResponse(res, 404, { error: "nota_nao_encontrada", message: "Nota não pertence ao usuário" });
        }
        if (nota.status !== "autorizado") {
            return jsonResponse(res, 422, {
                error: "nota_nao_autorizada",
                message: `Status atual: ${nota.status}. Só envia notas autorizadas.`,
            });
        }

        // Busca empresa (foco token + whatsapp do dono)
        const cnpjLimpo = String(nota.cnpj_prestador || "").replace(/\D/g, "");
        const emitenteId = nota.payload?.emitenteSupabaseId || null;

        let empresa = null;
        if (emitenteId) {
            const r = await supabase
                .from("poupeja_fiscal_emitentes")
                .select("whatsapp_dono, focus_token_producao, focus_token_homologacao, usa_nfse_nacional")
                .eq("user_id", userId)
                .eq("id", emitenteId)
                .maybeSingle();
            empresa = r.data;
        }
        if (!empresa && cnpjLimpo) {
            const r = await supabase
                .from("poupeja_fiscal_emitentes")
                .select("whatsapp_dono, focus_token_producao, focus_token_homologacao, usa_nfse_nacional")
                .eq("user_id", userId)
                .eq("cnpj", cnpjLimpo)
                .maybeSingle();
            empresa = r.data;
        }

        if (!empresa) {
            return jsonResponse(res, 404, { error: "empresa_nao_encontrada", message: "Empresa emitente não encontrada" });
        }
        if (!empresa.whatsapp_dono) {
            return jsonResponse(res, 422, {
                error: "whatsapp_nao_cadastrado",
                message: "Empresa não tem WhatsApp do dono cadastrado",
            });
        }

        const ambiente = process.env.FOCUS_NFE_ENV === "producao" ? "producao" : "homologacao";
        const focusToken = ambiente === "homologacao"
            ? empresa.focus_token_homologacao
            : empresa.focus_token_producao;
        if (!focusToken) {
            return jsonResponse(res, 500, { error: "token_focus_ausente", message: "Token Focus ausente" });
        }

        // Baixa XML + gera PDF (mesma lógica do api-danfse)
        const empresaShim = {
            focus_token: focusToken,
            usa_nfse_nacional: !!empresa.usa_nfse_nacional,
        };
        const xml = await baixarXml(ref, focusToken, empresaShim, nota.caminho_xml || null);
        const formato = detectarFormatoXml(xml);

        let pdfBuffer;
        if (formato === "abrasf") {
            pdfBuffer = await gerarDanfseAbrasf(xml);
        } else {
            const danfe = new DanfeService();
            const out = await danfe.generateFromXml(xml, { chaveAcesso: nota.chave_nfse || nota.numero_nfse || ref });
            pdfBuffer = out?.pdfBytes ? Buffer.from(out.pdfBytes) : null;
        }
        if (!pdfBuffer) {
            return jsonResponse(res, 500, { error: "pdf_falhou", message: "Falha ao gerar PDF" });
        }

        const valorFmt = Number(nota.valor_servico || 0)
            .toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
        const caption = `🎉 *Nota nº ${nota.numero_nfse || ref} autorizada!*\n💰 ${valorFmt}`;

        await enviarPdf(empresa.whatsapp_dono, pdfBuffer, `NFS-e-${nota.numero_nfse || ref}.pdf`, caption);

        logger.info(
            { ref, whatsapp: empresa.whatsapp_dono, formato, tamanho: pdfBuffer.length },
            "api-enviar-nfse-whatsapp: PDF enviado manualmente"
        );
        return jsonResponse(res, 200, { ok: true, enviado_para: empresa.whatsapp_dono });
    } catch (err) {
        logger.error({ err: err.message, stack: err.stack }, "api-enviar-nfse-whatsapp: erro");
        return jsonResponse(res, 500, { error: "internal_error", message: err.message || "Erro inesperado" });
    }
}
