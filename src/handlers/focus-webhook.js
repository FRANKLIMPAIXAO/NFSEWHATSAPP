/**
 * src/handlers/focus-webhook.js
 * Recebe callback HTTP da Focus quando o status de uma nota muda
 * (autorização ou rejeição assíncrona pela SEFAZ).
 *
 * Configurar URL no painel Focus por empresa (https://app.focusnfe.com.br):
 *   Empresas → <empresa> → URL de notificação NFSe
 *   Valor: https://<dominio>/webhooks/focus?secret=<FOCUS_WEBHOOK_SECRET>
 *
 * Focus envia POST com JSON contendo no mínimo `ref` e o novo status.
 * O formato exato varia por evento; aqui aceitamos campos comuns:
 *   ref, status, evento, numero, codigo_verificacao, url, mensagem.
 *
 * Fluxo:
 *   1. Busca a nota local pela `ref`
 *   2. Idempotência: ignora se nota já está em estado final
 *   3. Se autorizada → baixa PDF da Focus, envia pro cliente, persiste
 *   4. Se rejeitada/cancelada → mensagem ao cliente + avisa admin
 */
import { findNotaByReferencia, updateNotaStatus, findConversaById, findEmpresaById, finalizarConversa } from "../db/index.js";
import { atualizarNotaResultado } from "../db/supabase-nota-repo.js";
import { baixarPdf } from "../services/focusnfe.js";
import { enviarPdf, enviarTexto } from "../services/whatsapp.js";
import { logger } from "../utils/logger.js";

const ADMIN_WHATSAPP = process.env.ADMIN_WHATSAPP;

function statusFromPayload(body) {
    const raw = String(body.status || body.evento || "").toLowerCase();
    if (raw === "autorizado" || raw === "autorizada") return "autorizada";
    if (raw.startsWith("erro") || raw === "rejeitada") return "rejeitada";
    if (raw === "cancelado" || raw === "cancelada") return "cancelada";
    if (raw === "processando_autorizacao" || raw === "pendente") return "pendente";
    return raw || "desconhecido";
}

function formatarMensagemNotaEmitida(nota, numeroFmt) {
    const valor = Number(nota.valor_total || 0).toFixed(2);
    return `✅ Nota emitida!\nNúmero: ${numeroFmt}\nValor: R$ ${valor}`;
}

export async function handleFocusWebhook(body) {
    const referencia = body.ref || body.referencia;
    if (!referencia) {
        logger.warn({ body }, "focus-webhook: payload sem ref");
        return { ok: false, reason: "no_ref" };
    }

    const nota = findNotaByReferencia.get(referencia);
    if (!nota) {
        logger.warn({ referencia, body }, "focus-webhook: nota não encontrada localmente");
        return { ok: false, reason: "nota_nao_encontrada" };
    }

    if (nota.status === "autorizada" || nota.status === "rejeitada" || nota.status === "cancelada") {
        logger.info(
            { referencia, statusAtual: nota.status },
            "focus-webhook: nota já em estado final, ignorando (idempotente)"
        );
        return { ok: true, reason: "idempotente", statusAtual: nota.status };
    }

    const novoStatus = statusFromPayload(body);
    logger.info(
        { referencia, statusAnterior: nota.status, novoStatus, evento: body.evento },
        "focus-webhook: processando callback"
    );

    const conversa = nota.conversa_id ? findConversaById.get(nota.conversa_id) : null;
    const empresa = findEmpresaById.get(nota.empresa_id);
    if (!empresa) {
        logger.error({ referencia, empresaId: nota.empresa_id }, "focus-webhook: empresa não encontrada");
        return { ok: false, reason: "empresa_nao_encontrada" };
    }

    if (novoStatus === "autorizada") {
        const numero = body.numero || nota.numero_nfse || "—";
        const codVerif = body.codigo_verificacao || nota.codigo_verificacao || null;

        updateNotaStatus.run(
            "autorizada",
            numero,
            codVerif,
            body.url || null,
            null,
            null,
            JSON.stringify(body).slice(0, 50_000),
            "autorizada",
            nota.id
        );
        await atualizarNotaResultado({ ref: referencia }, {
            status: "autorizada",
            numero,
            chave: codVerif,
            dataEmissao: new Date().toISOString(),
            response: body,
        }).catch((err) => logger.warn({ err: err.message }, "focus-webhook: falha atualizando Supabase"));

        if (conversa?.whatsapp) {
            // Focus envia URL do PDF no payload (`url` ou `url_danfse`). Quando
            // disponível, usar S3 direto evita race condition do endpoint
            // /v2/nfse/<ref>.pdf que pode retornar antes da Focus terminar
            // de gerar o arquivo.
            const urlPdfPayload = body.url || body.url_danfse || null;
            try {
                const pdfBuffer = await baixarPdf(
                    referencia,
                    empresa.focus_token,
                    empresa,
                    urlPdfPayload
                );
                await enviarPdf(
                    conversa.whatsapp,
                    pdfBuffer,
                    `NFS-e-${numero}.pdf`,
                    formatarMensagemNotaEmitida(nota, numero)
                );
            } catch (err) {
                logger.error({ err: err.message, referencia }, "focus-webhook: erro baixando/enviando PDF");
                // Fallback: manda texto com link direto pro PDF (se a Focus mandou)
                const linhaLink = urlPdfPayload ? `\nPDF: ${urlPdfPayload}` : "";
                await enviarTexto(
                    conversa.whatsapp,
                    `${formatarMensagemNotaEmitida(nota, numero)}\nCódigo de verificação: ${codVerif || "—"}${linhaLink}`
                ).catch(() => {});
            }
            finalizarConversa.run("finalizada", conversa.id);
        }
        return { ok: true, status: "autorizada", numero };
    }

    if (novoStatus === "rejeitada" || novoStatus === "cancelada") {
        const motivo = body.mensagem || body.erros?.[0]?.mensagem || body.evento || "Sem detalhes";
        updateNotaStatus.run(
            novoStatus,
            null,
            null,
            null,
            null,
            String(motivo).slice(0, 1000),
            JSON.stringify(body).slice(0, 50_000),
            novoStatus,
            nota.id
        );
        await atualizarNotaResultado({ ref: referencia }, {
            status: novoStatus,
            erro: String(motivo),
            response: body,
        }).catch((err) => logger.warn({ err: err.message }, "focus-webhook: falha atualizando Supabase"));

        if (conversa?.whatsapp) {
            await enviarTexto(
                conversa.whatsapp,
                `❌ A SEFAZ ${novoStatus === "cancelada" ? "cancelou" : "rejeitou"} a emissão: ${motivo}\n\nVou avisar a equipe pra investigar.`
            );
            finalizarConversa.run("finalizada", conversa.id);
        }
        if (ADMIN_WHATSAPP) {
            await enviarTexto(
                ADMIN_WHATSAPP,
                `Nota ${referencia} ${novoStatus} (${empresa.razao_social || empresa.nome || "—"}): ${motivo}`
            ).catch(() => {});
        }
        return { ok: true, status: novoStatus };
    }

    // Status intermediário (ainda processando) — só loga, não notifica.
    logger.info({ referencia, novoStatus }, "focus-webhook: status intermediário, aguardando próximo callback");
    return { ok: true, status: novoStatus, intermediario: true };
}
