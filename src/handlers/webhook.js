/**
 * src/handlers/webhook.js
 * Handler principal: recebe webhook do WhatsApp e orquestra o fluxo.
 *
 * Modelo Pac no Bolso multi-tenant: cada empresa cadastrada tem 1 dono
 * (whatsapp_dono no Supabase) que é o responsável legal. A própria
 * autenticação acontece via mesmoNumeroBr(numero_recebido, whatsapp_dono).
 * Sem aprovação central — o dono confirma e emite direto. Comando "cancelar"
 * (ou variantes) aborta a conversa em qualquer estado intermediário.
 *
 * FLUXO:
 *  1. Identifica empresa pelo número que mandou a msg
 *  2. Se for áudio: baixa, transcreve, extrai
 *     Se for texto: trata como confirmação/complemento/cancelamento
 *  3. Se extração ok: pede confirmação
 *  4. Se o dono confirma "Sim": emite direto
 *  5. Devolve PDF (síncrono via emitirEEnviarPdf ou async via focus-webhook)
 *
 * ADMIN_WHATSAPP: continua usado APENAS pra alertas operacionais (rejeição
 * SEFAZ, erro técnico) — monitoramento, não aprovação.
 */
import fs from "node:fs/promises";
import fsSync from "node:fs";
import {
    findEmpresaByWhatsapp,
    findConversaAtiva,
    findConversaFinanceiraAtiva,
    insertConversa,
    updateConversa,
    finalizarConversa,
    registrarMensagemProcessada,
    logEvento,
    getOrCreateMirrorEmpresa,
} from "../db/index.js";
import { findEmitenteByWhatsapp } from "../db/supabase-repo.js";
import { supabaseRowToEmpresa } from "../db/empresa-adapter.js";
import { transcrever } from "../services/whisper.js";
import { extrairCampos } from "../services/extractor.js";
import { classificarIntencao } from "../services/classificador.js";
import { emitirNFSe } from "../services/emissor.js";
import {
    enviarTexto,
    enviarPdf,
    baixarAudio,
    baixarMidia,
} from "../services/whatsapp.js";
import { handleAgenda } from "./agenda.js";
import { handleFinanceiro } from "./financeiro.js";
import { handleFinanceiroBoleto } from "./financeiro-boleto.js";
import { handleFinanceiroTransacao } from "./financeiro-transacao.js";
import { handleFinanceiroExtrato } from "./financeiro-extrato.js";
import { formatarResumoCliente } from "../utils/resumo.js";
import { logger } from "../utils/logger.js";

const ADMIN_WHATSAPP = process.env.ADMIN_WHATSAPP;

// Regex de cancelamento explícito pelo dono. Match exato (palavra sozinha ou
// no início) pra não pegar falso-positivo quando "cancelar" aparece dentro
// de uma descrição de serviço maior.
const CANCELAR_REGEX = /^(cancelar|cancela|cancelo|desistir|desisto|parar|para)\b\.?\s*$/i;

/**
 * Entrada principal — wrapper com fallback global.
 * Se qualquer erro inesperado vazar do miolo, tentamos avisar o cliente
 * em vez de deixar ele esperando indefinidamente.
 *
 * @param {Object} evt - payload do webhook Evolution
 */
export async function handleWebhook(evt) {
    try {
        await _handleWebhookInner(evt);
    } catch (err) {
        logger.error(
            { err: err.message, stack: err.stack?.slice(0, 800) },
            "webhook: erro não tratado no miolo — tentando avisar o cliente"
        );
        // Tenta extrair número pra mandar fallback amigável
        const remoteJid = evt?.data?.key?.remoteJid || "";
        if (remoteJid && !remoteJid.endsWith("@g.us") && !evt?.data?.key?.fromMe) {
            const numero = remoteJid.replace(/@.*$/, "");
            try {
                await enviarTexto(
                    numero,
                    "😬 Travei aqui agora. Tenta de novo em 1 minutinho, ou manda *\"oi\"* que eu reinicio nossa conversa."
                );
            } catch (sendErr) {
                logger.error({ err: sendErr.message }, "webhook: falha enviando fallback ao cliente");
            }
        }
    }
}

/**
 * Miolo do webhook (separado do wrapper pra garantir fallback global em caso
 * de erro não tratado).
 */
async function _handleWebhookInner(evt) {
    // Evolution manda evento no formato:
    // { event: "messages.upsert", data: { key, message, messageType, ... } }
    if (evt.event !== "messages.upsert") return;

    const msg = evt.data;
    if (!msg || msg.key?.fromMe) return; // ignora mensagens enviadas pelo bot

    // Ignora mensagens de grupo: remoteJid de grupo termina em @g.us (e o número
    // tem 18 dígitos no formato do WhatsApp). Bot é 1:1 com o dono cadastrado.
    const remoteJid = msg.key.remoteJid || "";
    if (remoteJid.endsWith("@g.us")) {
        logger.info({ remoteJid }, "msg de grupo ignorada");
        return;
    }

    const numero = remoteJid.replace(/@.*$/, "");
    const messageId = msg.key.id;
    const tipo = msg.messageType; // audioMessage | conversation | extendedTextMessage | imageMessage | documentMessage
    const texto =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        // Imagens e documentos podem vir com legenda (caption) — tratar como texto
        msg.message?.imageMessage?.caption ||
        msg.message?.documentMessage?.caption ||
        msg.message?.documentWithCaptionMessage?.message?.documentMessage?.caption ||
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

    // ---------- 1. IDENTIFICAR EMPRESA ----------
    // Estratégia dual-mode: tenta Supabase (Pac no Bolso) primeiro.
    // Se Supabase está desligado, não acha o número, ou falha → cai pro
    // SQLite local. Garante que Roca/El Shadai (cadastradas só no SQLite)
    // continuem funcionando enquanto novos clientes vêm pelo painel do Pac.
    let empresa = null;
    try {
        const row = await findEmitenteByWhatsapp(numero);
        if (row) {
            empresa = supabaseRowToEmpresa(row);
            // Empresa do Supabase tem `id` UUID. As tabelas conversas/notas/
            // eventos do SQLite usam FK pra empresas(id) INTEGER — então
            // criamos/usamos um mirror local e trocamos o id pelo INTEGER.
            // _supabaseId guarda o UUID original pra futura escrita em
            // poupeja_nfse (etapa 6 do refactor).
            empresa._supabaseId = empresa.id;
            empresa.id = getOrCreateMirrorEmpresa(empresa);
        }
    } catch (err) {
        logger.error(
            { err: err.message, numero },
            "supabase: falha buscando emitente, caindo pra SQLite"
        );
    }
    if (!empresa) empresa = findEmpresaByWhatsapp.get(numero);

    if (!empresa) {
        await enviarTexto(
            numero,
            "👋 Oi! Esse número ainda não está cadastrado no PacNoBolso. " +
            "Pra ativar, cadastra sua empresa em pacnobolso.com.br e cola esse mesmo WhatsApp lá no campo *\"WhatsApp do dono\"*. " +
            "Em 2 minutos a gente conversa de novo."
        );
        return;
    }

    // ---------- 2. CONVERSA EM ANDAMENTO? ----------
    const conversaAtiva = findConversaAtiva.get(empresa.id, numero);
    // Conversa financeira aguardando complemento (estado
    // financeiro_aguardando_dados). Quando existir, vamos PULAR o
    // classificador e ir direto pro handleFinanceiroTransacao com o
    // payload parcial anterior — assim "Restaurante" como resposta ao
    // "no que gastou?" mescla com o que já tinha (valor R$ 55).
    const conversaFinanceira = findConversaFinanceiraAtiva.get(empresa.id, numero);

    // Comando "cancelar" do próprio dono — aborta a conversa em qualquer
    // estado intermediário. Não confunde com conteúdo da nota porque o
    // regex casa só a palavra sozinha.
    if (texto && CANCELAR_REGEX.test(texto.trim())) {
        // Cancela qualquer conversa ativa (NFSe OU financeira)
        const algumaConversa = conversaAtiva || conversaFinanceira;
        if (algumaConversa) {
            finalizarConversa.run("cancelada", algumaConversa.id);
            await enviarTexto(
                numero,
                "👍 Cancelei aqui. Quando quiser recomeçar, manda áudio, foto ou descreve por texto."
            );
            logEvento("conversa_cancelada_dono", empresa.id, algumaConversa.id, {});
        } else {
            await enviarTexto(
                numero,
                "🤔 Sem emissão em andamento por aqui. Manda áudio, foto do orçamento ou descreve o serviço pra eu começar."
            );
        }
        return;
    }

    // ---------- 3. PROCESSAR MENSAGEM ----------
    let textoExtracao = null;
    // Mídia visual coletada da mensagem (imagens e/ou PDF) pra extractor multimodal
    let imagensExtracao = [];
    let pdfExtracao = null;
    // Áudio em base64 (usado pelo handler financeiro quando encaminha pro
    // proxy n8n — o nó "Convert to File" do workflow Conciliação Bancária
    // espera `data.message.base64` pra qualquer tipo de mídia).
    let audioBase64Extracao = null;
    // Caminhos pra cleanup no final
    const arquivosTemp = [];

    if (tipo === "audioMessage") {
        let audioPath = null;
        let etapa = "inicio";
        try {
            await enviarTexto(numero, "🎙️ Ouvindo seu áudio... me dá um instante.");
            etapa = "baixar";
            const audioResult = await baixarAudio(messageId);
            audioPath = audioResult.path;
            // Lê o áudio como base64 ANTES do unlink (no finally) — necessário
            // pra encaminhar pro proxy n8n quando intenção for financeira.
            etapa = "ler_base64";
            const audioBytes = await fs.readFile(audioPath);
            audioBase64Extracao = audioBytes.toString("base64");
            etapa = "transcrever";
            textoExtracao = await transcrever(audioPath);
            logEvento("audio_transcrito", empresa.id, conversaAtiva?.id, {
                texto: textoExtracao,
                chars: textoExtracao?.length || 0,
            });
        } catch (err) {
            logger.error({ err: err.message, etapa }, "falha no áudio");
            // Persiste no DB também (logger só vai pro stdout)
            logEvento("audio_erro", empresa.id, conversaAtiva?.id, {
                etapa,
                error: err.message,
                stack: err.stack?.slice(0, 500),
                messageId,
            });
            await enviarTexto(
                numero,
                `😬 Travei no seu áudio (etapa: ${etapa}). Manda de novo ou descreve por texto que eu pego.`
            );
            return;
        } finally {
            if (audioPath) {
                await fs.unlink(audioPath).catch(() => {});
            }
        }
    } else if (tipo === "imageMessage" || tipo === "documentMessage" || tipo === "documentWithCaptionMessage") {
        // Mídia visual: imagem ou PDF. Baixa via Evolution e passa pro extractor
        // multimodal. Caption (legenda) já foi capturada acima como `texto`.
        let etapa = "inicio";
        try {
            const aviso =
                tipo === "imageMessage"
                    ? "📷 Olhando sua imagem... me dá um instante."
                    : "📄 Lendo seu documento... me dá um instante.";
            await enviarTexto(numero, aviso);
            etapa = "baixar";
            const midia = await baixarMidia(messageId);
            arquivosTemp.push(midia.path);
            etapa = "preparar";
            if (midia.mimetype === "application/pdf") {
                pdfExtracao = { base64: midia.base64 };
            } else if (midia.mimetype.startsWith("image/")) {
                imagensExtracao.push({
                    base64: midia.base64,
                    mimetype: midia.mimetype,
                });
            } else {
                throw new Error(`Tipo de mídia não suportado: ${midia.mimetype}`);
            }
            textoExtracao = texto || ""; // legenda (pode ser vazia)
            logEvento("midia_recebida", empresa.id, conversaAtiva?.id, {
                tipo,
                mimetype: midia.mimetype,
                size: midia.size,
                temLegenda: !!texto,
            });
        } catch (err) {
            logger.error({ err: err.message, etapa, tipo }, "falha na mídia");
            logEvento("midia_erro", empresa.id, conversaAtiva?.id, {
                tipo,
                etapa,
                error: err.message,
                stack: err.stack?.slice(0, 500),
                messageId,
            });
            await enviarTexto(
                numero,
                `😬 Não consegui abrir esse arquivo (etapa: ${etapa}). Manda de novo ou descreve por texto que eu pego.`
            );
            return;
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
            await enviarTexto(numero, "👍 Cancelei. Quando quiser, é só me chamar.");
            return;
        }

        textoExtracao = texto;
    } else {
        return; // tipo de mensagem que não interessa
    }

    // ---------- 4.4 CONVERSA FINANCEIRA EM CURSO? ----------
    // Se conversa financeira está aguardando complemento, PULAMOS o
    // classificador e mandamos direto pro handler financeiro com o
    // payload anterior. Senão a próxima resposta curta do user (ex:
    // "Restaurante" depois de "no que gastou os 55?") cai como
    // duvida_geral.
    if (conversaFinanceira && !conversaAtiva) {
        await handleFinanceiroTransacao({
            empresa,
            numero,
            texto: textoExtracao,
            imagens: imagensExtracao,
            pdf: pdfExtracao,
            conversaAtiva: conversaFinanceira,
        });
        for (const p of arquivosTemp) {
            await fs.unlink(p).catch(() => {});
        }
        return;
    }

    // ---------- 4.5 CLASSIFICAR INTENÇÃO ----------
    // Só roda quando NÃO TEM conversa em andamento. Se já tem conversa
    // (aguardando_confirmacao ou aguardando_dados), assumimos que o usuário
    // está continuando o fluxo de NFSe que já estava aberto — sem classificar
    // de novo (evita router mandar a próxima mensagem pra outro handler e
    // quebrar a conversa).
    if (!conversaAtiva) {
        const inputClass =
            imagensExtracao.length || pdfExtracao
                ? { texto: textoExtracao, imagens: imagensExtracao, pdf: pdfExtracao }
                : textoExtracao;
        const intencao = await classificarIntencao(inputClass);
        logEvento("intencao_classificada", empresa.id, null, {
            intencao: intencao.intencao,
            subtipo: intencao.subtipo,
            confianca: intencao.confianca,
            motivo: intencao.motivo,
            latenciaMs: intencao.latenciaMs,
        });

        // ROTEAMENTO POR INTENÇÃO
        if (intencao.intencao === "consultar_agenda") {
            await handleAgenda({ empresa, numero, texto: textoExtracao });
            // Cleanup arquivos temp (mídia visual)
            for (const p of arquivosTemp) {
                await fs.unlink(p).catch(() => {});
            }
            return;
        }

        if (intencao.intencao === "registrar_financeiro") {
            // FASE 3 — roteamento por subtipo pra handler LOCAL (Node),
            // substituindo o AI Agent do workflow n8n "Conciliação Bancária
            // WhatsApp". Cada handler insere direto em poupeja_payables /
            // poupeja_transactions via Supabase service role.
            //
            // Subtipo do classificador define o handler:
            //   boleto              → financeiro-boleto.js     → poupeja_payables
            //   pagamento_efetuado  → financeiro-transacao.js → poupeja_transactions
            //   recebimento         → financeiro-transacao.js → poupeja_transactions
            //   extrato_bancario    → financeiro-extrato.js   → poupeja_transactions (batch)
            //   outro / desconhecido → tenta transacao, depois boleto, depois extrato
            //
            // FALLBACK: se o handler local devolver {ok:false} (não conseguiu
            // classificar ou erro técnico), encaminha pro proxy n8n antigo.
            // n8n vira "rede de segurança" durante validação em prod (7 dias).
            const subtipo = intencao.subtipo || "outro";
            const args = {
                empresa,
                numero,
                texto: textoExtracao,
                imagens: imagensExtracao,
                pdf: pdfExtracao,
            };

            let resultado = { ok: false, motivo: "subtipo_nao_roteado" };
            try {
                if (subtipo === "boleto") {
                    resultado = await handleFinanceiroBoleto(args);
                } else if (subtipo === "extrato_bancario") {
                    resultado = await handleFinanceiroExtrato(args);
                } else if (
                    subtipo === "pagamento_efetuado" ||
                    subtipo === "recebimento"
                ) {
                    resultado = await handleFinanceiroTransacao(args);
                } else {
                    // outro / desconhecido: tenta transação primeiro (mais comum),
                    // depois boleto, depois extrato. Cada handler tem detecção
                    // interna (not_transacao, not_boleto, not_extrato) que
                    // sinaliza pra próxima tentativa.
                    resultado = await handleFinanceiroTransacao(args);
                    if (!resultado.ok && resultado.motivo === "not_transacao") {
                        resultado = await handleFinanceiroBoleto(args);
                    }
                    if (!resultado.ok && resultado.motivo === "not_boleto") {
                        resultado = await handleFinanceiroExtrato(args);
                    }
                }
            } catch (err) {
                logger.error(
                    { err: err.message, subtipo },
                    "financeiro: exceção no handler local — vai pro fallback proxy"
                );
                resultado = { ok: false, motivo: "exception" };
            }

            // Fallback: handler local não deu conta → tenta proxy n8n
            if (!resultado.ok) {
                logger.info(
                    { subtipo, motivo: resultado.motivo },
                    "financeiro: handler local falhou, fallback pro proxy n8n"
                );
                await handleFinanceiro({
                    evt,
                    empresa,
                    numero,
                    texto: textoExtracao,
                    imagens: imagensExtracao,
                    pdf: pdfExtracao,
                    audioBase64: audioBase64Extracao,
                });
            } else {
                logEvento("financeiro_local", empresa.id, null, { subtipo });
            }

            for (const p of arquivosTemp) {
                await fs.unlink(p).catch(() => {});
            }
            return;
        }

        if (intencao.intencao === "duvida_geral") {
            // Mensagem de ajuda / saudação — voz: secretário esperto, direto.
            const nomeEmpresa = empresa.nome_fantasia || empresa.razao_social || empresa.nome || "chefe";
            await enviarTexto(
                numero,
                `👋 Oi, ${nomeEmpresa}! Pra organizar a *${nomeEmpresa}*, eu cuido de 3 frentes:\n\n` +
                `📄 *Nota fiscal* — manda áudio, foto do orçamento ou descreve o serviço que eu emito.\n` +
                `📅 *Agenda* — *"o que tenho hoje"*, *"lembra do aluguel dia 5"*, *"já paguei o IPVA"*.\n` +
                `💰 *Financeiro* — foto de boleto, pix recebido, extrato — eu registro tudo.\n\n` +
                `Manda aí o que precisa. 🚀`
            );
            for (const p of arquivosTemp) {
                await fs.unlink(p).catch(() => {});
            }
            return;
        }

        // intencao === "emitir_nfse" — continua pro extractor (fluxo legado)
    }

    // ---------- 5. EXTRAIR CAMPOS ----------
    const payloadAnterior = conversaAtiva?.payload_json
        ? JSON.parse(conversaAtiva.payload_json)
        : null;

    let extracao;
    try {
        const inputExtracao =
            imagensExtracao.length || pdfExtracao
                ? { texto: textoExtracao, imagens: imagensExtracao, pdf: pdfExtracao }
                : textoExtracao;
        extracao = await extrairCampos(inputExtracao, payloadAnterior);
        logEvento("extracao", empresa.id, conversaAtiva?.id, extracao);
    } catch (err) {
        logger.error({ err: err.message }, "erro na extração");
        logEvento("extracao_erro", empresa.id, conversaAtiva?.id, {
            error: err.message,
            stack: err.stack?.slice(0, 500),
        });
        await enviarTexto(
            numero,
            "😬 Travei aqui agora. Tenta de novo em 1 minutinho que eu resolvo."
        );
        return;
    } finally {
        // Cleanup de arquivos temp (áudio já é limpo no try específico dele)
        for (const p of arquivosTemp) {
            await fs.unlink(p).catch(() => {});
        }
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

        await enviarTexto(numero, formatarResumoCliente(extracao, empresa));
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
 * Processa quando o dono confirma a emissão ("Sim").
 * O dono é o responsável legal pela empresa cadastrada — autenticação
 * implícita via número. Emite direto, sem aprovação de admin central.
 */
async function processarConfirmacao(conversa, empresa, numero) {
    await emitirEEnviarPdf(conversa, empresa, numero);
}


/**
 * Emite a NFS-e via roteador (Focus ou EPN) e devolve o PDF pelo WhatsApp.
 * Toda a persistência (notas_emitidas) e geração de DANF-Se ficam dentro
 * do emissor.js — aqui só interpretamos o resultado e respondemos.
 */
async function emitirEEnviarPdf(conversa, empresa, numero) {
    const payload = JSON.parse(conversa.payload_json);

    try {
        const result = await emitirNFSe({
            empresa,
            tomador: payload.tomador,
            servico: payload.servico,
            competencia: payload.competencia,
            conversaId: conversa.id,
        });

        logEvento("emissao", empresa.id, conversa.id, {
            referencia: result.referencia,
            status: result.status,
            chaveAcesso: result.chaveAcesso,
        });

        if (result.status === "autorizado") {
            const numero_nfse = result.numero || result.chaveAcesso?.slice(-8) || "—";
            const valorFmt = Number(payload.servico.valor_total)
                .toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

            // Tenta mandar PDF; se não tiver, manda só o texto com a chave.
            const pdfPath = result.pdfPath;
            if (pdfPath && fsSync.existsSync(pdfPath)) {
                const pdfBuffer = fsSync.readFileSync(pdfPath);
                await enviarPdf(
                    numero,
                    pdfBuffer,
                    `NFS-e-${numero_nfse}.pdf`,
                    `🎉 *Nota nº ${numero_nfse} autorizada!*\n💰 ${valorFmt}\n\nPDF tá aí ⬇️`
                );
            } else {
                await enviarTexto(
                    numero,
                    `🎉 *Nota nº ${numero_nfse} autorizada!*\n` +
                    `💰 ${valorFmt}\n` +
                    `🔑 Chave: ${result.chaveAcesso || "—"}\n\n` +
                    `_(PDF deve cair em instantes, prefeitura tá liberando.)_`
                );
            }
            finalizarConversa.run("finalizada", conversa.id);
        } else if (result.status === "pendente") {
            // Emissão assíncrona — Focus aceitou, SEFAZ ainda vai processar.
            // O webhook /webhooks/focus vai entregar o PDF ao cliente quando
            // a SEFAZ retornar autorização (ver focus-webhook.js).
            await enviarTexto(
                numero,
                `⏳ Mandei pra prefeitura — eles aceitaram e tão processando. ` +
                `Te chamo aqui assim que sair (geralmente uns minutos). ☕`
            );
            finalizarConversa.run("aguardando_sefaz", conversa.id);
        } else {
            const erroMsg = result.erro || `Status: ${result.status}`;
            await enviarTexto(
                numero,
                `⚠️ A prefeitura recusou a emissão:\n\n_${erroMsg}_\n\n` +
                `Não esquenta — já chamei minha equipe técnica pra ver o que rolou. A gente resolve.`
            );
            if (ADMIN_WHATSAPP) {
                await enviarTexto(
                    ADMIN_WHATSAPP,
                    `🚨 Nota ${result.referencia} rejeitada (${empresa.razao_social}): ${erroMsg}`
                );
            }
            finalizarConversa.run("finalizada", conversa.id);
        }
    } catch (err) {
        logger.error({ err: err.message }, "erro na emissão (roteador)");
        await enviarTexto(
            numero,
            `😬 Travei na hora de emitir. Já chamei a equipe técnica — me dá uns minutos que volto pra você.`
        );
        if (ADMIN_WHATSAPP) {
            await enviarTexto(
                ADMIN_WHATSAPP,
                `🚨 Erro técnico emissão (${empresa.razao_social}): ${err.message}`
            );
        }
        finalizarConversa.run("finalizada", conversa.id);
    }
}
