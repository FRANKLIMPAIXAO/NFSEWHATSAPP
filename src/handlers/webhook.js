/**
 * src/handlers/webhook.js
 * Handler principal: recebe webhook do WhatsApp e orquestra o fluxo.
 *
 * FLUXO COMPLETO:
 *  1. Identifica empresa pelo número
 *  2. Se mensagem é áudio: baixa, transcreve, extrai
 *     Se é texto: trata como confirmação ou complemento
 *  3. Se extração tá ok: pede confirmação
 *  4. Se cliente confirma: emite (com ou sem aprovação admin)
 *  5. Devolve PDF
 */
import { randomUUID } from "node:crypto";
import {
    findEmpresaByWhatsapp,
    findEmpresaById,
    findConversaAtiva,
    findConversaById,
    insertConversa,
    updateConversa,
    finalizarConversa,
    insertNota,
    updateNotaStatus,
    registrarMensagemProcessada,
    logEvento,
} from "../db/index.js";
import fs from "node:fs/promises";
import { transcrever } from "../services/whisper.js";
import { extrairCampos } from "../services/extractor.js";
import {
    emitirNFSe,
    consultarNFSe,
    baixarPdf,
} from "../services/focusnfe.js";
import {
    enviarTexto,
    enviarPdf,
    baixarAudio,
} from "../services/whatsapp.js";
import { logger } from "../utils/logger.js";

const APPROVAL_MODE = process.env.APPROVAL_MODE || "manual_approval";
const ADMIN_WHATSAPP = process.env.ADMIN_WHATSAPP;

/**
 * Entrada principal.
 * @param {Object} evt - payload do webhook Evolution
 */
export async function handleWebhook(evt) {
    // Evolution manda evento no formato:
    // { event: "messages.upsert", data: { key, message, messageType, ... } }
    if (evt.event !== "messages.upsert") return;

    const msg = evt.data;
    if (!msg || msg.key?.fromMe) return; // ignora mensagens enviadas pelo bot

    const numero = msg.key.remoteJid?.replace(/@.*$/, ""); // 5511999...@s.whatsapp.net
    const messageId = msg.key.id;
    const tipo = msg.messageType; // audioMessage | conversation | extendedTextMessage
    const texto =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        null;

    if (!messageId || !numero) {
        logger.warn({ messageId, numero }, "evento sem identificadores mínimos");
        return;
    }

    const inserted = registrarMensagemProcessada(messageId, numero, tipo);
    if (!inserted) {
        logger.info({ numero, tipo, messageId }, "evento duplicado ignorado");
        return;
    }

    logger.info({ numero, tipo, messageId }, "msg recebida");
    logEvento("msg_recebida", null, null, { numero, tipo, messageId });

    // ---------- 1. TRATAMENTO ESPECIAL: APROVAÇÃO ADMIN ----------
    // Precisa vir ANTES da identificação de empresa: o admin pode não ter
    // empresa cadastrada com o próprio número.
    if (numero === ADMIN_WHATSAPP && texto) {
        const tratado = await tratarRespostaAdmin(texto);
        if (tratado) return;
    }

    // ---------- 2. IDENTIFICAR EMPRESA ----------
    const empresa = findEmpresaByWhatsapp.get(numero);
    if (!empresa) {
        await enviarTexto(
            numero,
            "Olá! Este número não está cadastrado no agente PAC. Fale com a equipe pra ativar."
        );
        return;
    }

    // ---------- 3. CONVERSA EM ANDAMENTO? ----------
    const conversaAtiva = findConversaAtiva.get(empresa.id, numero);

    // Se a conversa está aguardando aprovação do admin, qualquer nova mensagem
    // do cliente deve só informar — não pode entrar no extrator e sobrescrever.
    if (conversaAtiva?.estado === "aguardando_aprovacao_admin") {
        await enviarTexto(
            numero,
            "Sua emissão está em validação com a equipe. Assim que aprovada eu te aviso. ⏳"
        );
        return;
    }

    // ---------- 4. PROCESSAR MENSAGEM ----------
    let textoExtracao = null;

    if (tipo === "audioMessage") {
        let audioPath = null;
        try {
            await enviarTexto(numero, "🎙️ Recebi seu áudio. Transcrevendo...");
            const audioResult = await baixarAudio(messageId);
            audioPath = audioResult.path;
            textoExtracao = await transcrever(audioPath);
            logEvento("audio_transcrito", empresa.id, conversaAtiva?.id, {
                texto: textoExtracao,
            });
        } catch (err) {
            logger.error({ err: err.message }, "falha no áudio");
            await enviarTexto(
                numero,
                "Ops, não consegui processar o áudio. Pode mandar de novo ou descrever por texto?"
            );
            return;
        } finally {
            if (audioPath) {
                await fs.unlink(audioPath).catch(() => {});
            }
        }
    } else if (texto) {
        // Texto pode ser:
        //  (a) confirmação de uma conversa em andamento ("sim", "confirma", "ok")
        //  (b) cancelamento ("não", "cancela")
        //  (c) novo pedido ou complemento
        const lower = texto.trim().toLowerCase();

        if (
            conversaAtiva?.estado === "aguardando_confirmacao" &&
            ["sim", "s", "confirma", "confirmar", "ok", "pode emitir"].includes(
                lower
            )
        ) {
            await processarConfirmacao(conversaAtiva, empresa, numero);
            return;
        }

        if (
            conversaAtiva &&
            ["nao", "não", "n", "cancela", "cancelar", "para"].includes(lower)
        ) {
            finalizarConversa.run("cancelada", conversaAtiva.id);
            await enviarTexto(numero, "Beleza, cancelado. Pode mandar outro quando quiser.");
            return;
        }

        textoExtracao = texto;
    } else {
        return; // tipo de mensagem que não interessa
    }

    // ---------- 5. EXTRAIR CAMPOS ----------
    const payloadAnterior = conversaAtiva?.payload_json
        ? JSON.parse(conversaAtiva.payload_json)
        : null;

    let extracao;
    try {
        extracao = await extrairCampos(textoExtracao, payloadAnterior);
        logEvento("extracao", empresa.id, conversaAtiva?.id, extracao);
    } catch (err) {
        await enviarTexto(
            numero,
            "Tive um problema interno aqui. Pode tentar de novo?"
        );
        return;
    }

    // ---------- 6. RESPONDER CONFORME O STATUS ----------
    if (extracao.status === "ok") {
        // Salva/atualiza conversa em estado de confirmação
        let conversaId;
        if (conversaAtiva) {
            updateConversa.run(
                "aguardando_confirmacao",
                JSON.stringify(extracao),
                null,
                conversaAtiva.id
            );
            conversaId = conversaAtiva.id;
        } else {
            const result = insertConversa.run(
                empresa.id,
                numero,
                "aguardando_confirmacao",
                JSON.stringify(extracao),
                null
            );
            conversaId = result.lastInsertRowid;
        }

        await enviarTexto(
            numero,
            `${extracao.resumo_confirmacao}\n\nResponda *SIM* pra emitir ou *CANCELA* pra desistir.`
        );
    } else if (extracao.status === "incomplete" || extracao.status === "ambiguous") {
        // Salva conversa parcial e pergunta o que falta
        if (conversaAtiva) {
            updateConversa.run(
                "aguardando_dados",
                JSON.stringify(extracao),
                JSON.stringify(extracao.campos_faltantes),
                conversaAtiva.id
            );
        } else {
            insertConversa.run(
                empresa.id,
                numero,
                "aguardando_dados",
                JSON.stringify(extracao),
                JSON.stringify(extracao.campos_faltantes)
            );
        }
        await enviarTexto(numero, extracao.resumo_confirmacao);
    }
}

/**
 * Processa quando o cliente confirma a emissão.
 */
async function processarConfirmacao(conversa, empresa, numero) {
    const payload = JSON.parse(conversa.payload_json);

    if (APPROVAL_MODE === "manual_approval" && ADMIN_WHATSAPP) {
        // Marca conversa como aguardando admin
        updateConversa.run(
            "aguardando_aprovacao_admin",
            conversa.payload_json,
            null,
            conversa.id
        );

        const resumo =
            `🔔 *Aprovação necessária*\n\n` +
            `Empresa: ${empresa.razao_social}\n` +
            `Cliente: ${numero}\n\n` +
            `${payload.resumo_confirmacao}\n\n` +
            `Responda *APROVAR ${conversa.id}* ou *REJEITAR ${conversa.id}*`;

        await enviarTexto(ADMIN_WHATSAPP, resumo);
        await enviarTexto(
            numero,
            "Confirmado! Estou validando com a equipe e já te aviso. ⏳"
        );
        return;
    }

    // Modo automático: emite direto
    await emitirEEnviarPdf(conversa, empresa, numero);
}

/**
 * Trata respostas do admin (APROVAR/REJEITAR).
 * @returns {boolean} true se a mensagem foi tratada como ação admin
 */
async function tratarRespostaAdmin(texto) {
    const matchAprovar = texto.match(/^aprovar\s+(\d+)/i);
    const matchRejeitar = texto.match(/^rejeitar\s+(\d+)/i);

    if (matchAprovar) {
        const conversaId = parseInt(matchAprovar[1], 10);
        const conv = findConversaById.get(conversaId);
        if (!conv) {
            await enviarTexto(ADMIN_WHATSAPP, `Conversa ${conversaId} não encontrada.`);
            return true;
        }

        const empresa = findEmpresaById.get(conv.empresa_id);
        if (!empresa) {
            await enviarTexto(
                ADMIN_WHATSAPP,
                `Empresa da conversa ${conversaId} não encontrada.`
            );
            return true;
        }

        await emitirEEnviarPdf(conv, empresa, conv.whatsapp);
        await enviarTexto(ADMIN_WHATSAPP, `✅ Conversa ${conversaId} emitida.`);
        return true;
    }

    if (matchRejeitar) {
        const conversaId = parseInt(matchRejeitar[1], 10);
        const conv = findConversaById.get(conversaId);
        if (conv) {
            finalizarConversa.run("cancelada", conv.id);
            await enviarTexto(
                conv.whatsapp,
                "Tive que cancelar essa emissão. Vou te chamar pra explicar."
            );
            await enviarTexto(ADMIN_WHATSAPP, `❌ Conversa ${conversaId} rejeitada.`);
        }
        return true;
    }

    return false;
}

/**
 * Emite a NFS-e na Focus e devolve o PDF pelo WhatsApp.
 */
async function emitirEEnviarPdf(conversa, empresa, numero) {
    const payload = JSON.parse(conversa.payload_json);
    const referencia = `pac-${empresa.id}-${randomUUID().slice(0, 8)}`;

    // 1. Salva nota como pendente (idempotência)
    const notaResult = insertNota.run(
        empresa.id,
        conversa.id,
        referencia,
        "pendente",
        payload.tomador.documento,
        payload.tomador.razao_social,
        payload.servico.descricao,
        payload.servico.valor_total,
        payload.servico.codigo_lc116,
        null, // audio_msg_id
        null, // transcricao
        null  // payload_enviado preenchemos depois
    );
    const notaId = notaResult.lastInsertRowid;

    try {
        // 2. Emite na Focus
        const { payload: payloadFocus, result } = await emitirNFSe({
            referencia,
            empresa,
            tomador: payload.tomador,
            servico: payload.servico,
            competencia: payload.competencia,
        });

        logEvento("emissao", empresa.id, conversa.id, { referencia, result });

        // 3. Status na Focus pode ser autorizada na hora ou processando
        let status = result.status;
        let consulta = result;

        if (status === "processando_autorizacao") {
            // pequeno polling — Focus geralmente autoriza em 5-30s
            for (let i = 0; i < 6; i++) {
                await new Promise((r) => setTimeout(r, 5000));
                consulta = await consultarNFSe(referencia, empresa.focus_token);
                status = consulta.status;
                if (status !== "processando_autorizacao") break;
            }
        }

        if (status === "autorizado") {
            const pdfBuffer = await baixarPdf(referencia, empresa.focus_token);
            updateNotaStatus.run(
                "autorizada",
                consulta.numero || null,
                consulta.codigo_verificacao || null,
                consulta.url || null,
                consulta.url_xml || null,
                null,
                JSON.stringify(consulta),
                "autorizada",
                notaId
            );

            await enviarPdf(
                numero,
                pdfBuffer,
                `NFS-e-${consulta.numero || referencia}.pdf`,
                `✅ Nota emitida! Número: ${consulta.numero || "—"}\nValor: R$ ${payload.servico.valor_total.toFixed(2)}`
            );
            finalizarConversa.run("finalizada", conversa.id);
        } else {
            // erro / rejeitada
            const erroMsg = consulta.mensagem_sefaz || consulta.erros?.join("; ") || "Status: " + status;
            updateNotaStatus.run(
                "rejeitada",
                null,
                null,
                null,
                null,
                erroMsg,
                JSON.stringify(consulta),
                "rejeitada",
                notaId
            );
            await enviarTexto(
                numero,
                `❌ A SEFAZ rejeitou a emissão: ${erroMsg}\n\nVou avisar a equipe pra investigar.`
            );
            if (ADMIN_WHATSAPP) {
                await enviarTexto(
                    ADMIN_WHATSAPP,
                    `Nota ${referencia} rejeitada: ${erroMsg}`
                );
            }
            finalizarConversa.run("finalizada", conversa.id);
        }
    } catch (err) {
        logger.error({ err: err.message, referencia }, "erro na emissão");
        updateNotaStatus.run(
            "rejeitada",
            null,
            null,
            null,
            null,
            err.message,
            null,
            "rejeitada",
            notaId
        );
        await enviarTexto(
            numero,
            `❌ Tive um erro técnico ao emitir. A equipe foi notificada.`
        );
        if (ADMIN_WHATSAPP) {
            await enviarTexto(
                ADMIN_WHATSAPP,
                `Erro técnico ref ${referencia}: ${err.message}`
            );
        }
        finalizarConversa.run("finalizada", conversa.id);
    }
}
