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
 *   3. Se autorizado → baixa PDF da Focus, envia pro cliente, persiste
 *   4. Se rejeitado/cancelado → mensagem ao cliente + avisa admin
 */
import { findNotaByReferencia, updateNotaStatus, findConversaById, findEmpresaById, finalizarConversa } from "../db/index.js";
import { atualizarNotaResultado, buscarNotaPorRef } from "../db/supabase-nota-repo.js";
import { baixarPdf, baixarXml } from "../services/focusnfe.js";
import { enviarPdf, enviarTexto } from "../services/whatsapp.js";
import { DanfeService } from "nfse-nacional";
import { gerarDanfseAbrasf, detectarFormatoXml } from "../services/danfse-abrasf.js";
import { logger } from "../utils/logger.js";

const ADMIN_WHATSAPP = process.env.ADMIN_WHATSAPP;

// Status canônico (masculino) — alinha com check constraint do Supabase
// (poupeja_nfse_status_check) e formato nativo da Focus.
function statusFromPayload(body) {
    const raw = String(body.status || body.evento || "").toLowerCase();
    if (raw === "autorizado" || raw === "autorizada") return "autorizado";
    if (raw.startsWith("erro") || raw === "rejeitado" || raw === "rejeitada") return "rejeitado";
    if (raw === "cancelado" || raw === "cancelada") return "cancelado";
    if (raw === "processando_autorizacao" || raw === "pendente") return "pendente";
    return raw || "desconhecido";
}

function formatarMensagemNotaEmitida(nota, numeroFmt) {
    const valor = Number(nota.valor_total || 0)
        .toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
    return `🎉 *Nota nº ${numeroFmt} autorizada!*\n💰 ${valor}`;
}

function formatarMensagemSemPdfBinario(nota, numeroFmt, codVerif, urlPortal) {
    const cabecalho = formatarMensagemNotaEmitida(nota, numeroFmt);
    const partes = [cabecalho, ""];
    if (urlPortal) {
        partes.push(
            "📄 *PDF da nota* (página oficial da prefeitura):",
            urlPortal,
        );
    }
    if (codVerif) {
        partes.push(
            "",
            `🔐 Código de verificação: *${codVerif}*`,
        );
    }
    partes.push(
        "",
        "_Esse município entrega o PDF pela página da prefeitura, não como arquivo direto. Clica no link acima pra ver ou baixar._",
    );
    return partes.join("\n");
}

export async function handleFocusWebhook(body) {
    const referencia = body.ref || body.referencia;
    if (!referencia) {
        logger.warn({ body }, "focus-webhook: payload sem ref");
        return { ok: false, reason: "no_ref" };
    }

    // Tenta SQLite local primeiro (rápido + pode ter conversa_id).
    // Fallback: Supabase quando o agent reiniciou e perdeu o registro.
    let nota = findNotaByReferencia.get(referencia);
    let conversa = nota?.conversa_id ? findConversaById.get(nota.conversa_id) : null;
    let empresa = nota ? findEmpresaById.get(nota.empresa_id) : null;
    let fonteRemota = false;

    if (!nota) {
        const remoto = await buscarNotaPorRef(referencia);
        if (!remoto?.nota) {
            logger.warn({ referencia, body }, "focus-webhook: nota não encontrada (SQLite nem Supabase)");
            return { ok: false, reason: "nota_nao_encontrada" };
        }
        fonteRemota = true;
        // Adapta row do Supabase pra mesma forma esperada pelo resto da função.
        nota = {
            id: null, // SQLite id ausente — updates de SQLite serão pulados
            status: remoto.nota.status,
            numero_nfse: remoto.nota.numero_nfse,
            codigo_verificacao: null,
            empresa_id: null,
            conversa_id: null,
            valor_total: remoto.nota.valor_servico,
            referencia_supabase: remoto.nota.id,
        };
        conversa = remoto.whatsapp ? { whatsapp: remoto.whatsapp, id: null } : null;
        empresa = remoto.empresa
            ? {
                id: remoto.empresa.id,
                focus_token: process.env.FOCUS_NFE_ENV === "producao"
                    ? remoto.empresa.focus_token_producao
                    : remoto.empresa.focus_token_homologacao,
                usa_nfse_nacional: !!remoto.empresa.usa_nfse_nacional,
                razao_social: null,
            }
            : null;
        logger.info({ referencia, whatsapp: !!conversa?.whatsapp }, "focus-webhook: fallback Supabase OK");
    }

    if (nota.status === "autorizado" || nota.status === "rejeitado" || nota.status === "cancelado") {
        logger.info(
            { referencia, statusAtual: nota.status },
            "focus-webhook: nota já em estado final, ignorando (idempotente)"
        );
        return { ok: true, reason: "idempotente", statusAtual: nota.status };
    }

    const novoStatus = statusFromPayload(body);
    logger.info(
        { referencia, statusAnterior: nota.status, novoStatus, evento: body.evento, fonteRemota },
        "focus-webhook: processando callback"
    );

    if (!empresa) {
        logger.error({ referencia }, "focus-webhook: empresa não encontrada");
        return { ok: false, reason: "empresa_nao_encontrada" };
    }

    if (novoStatus === "autorizado") {
        const numero = body.numero || nota.numero_nfse || "—";
        const codVerif = body.codigo_verificacao || nota.codigo_verificacao || null;

        if (nota.id) {
            updateNotaStatus.run(
                "autorizado",
                numero,
                codVerif,
                body.url || null,
                null,
                null,
                JSON.stringify(body).slice(0, 50_000),
                "autorizado",
                nota.id
            );
        }
        // Focus envia URL do PDF (ou da página do portal pra ABRASF municipal)
        // em `body.url` ou `body.url_danfse`. Persistimos no Supabase
        // (caminho_pdf) pra o frontend do Pac mostrar o botão "Ver PDF".
        const urlPdf = body.url || body.url_danfse || null;
        const urlXml = body.caminho_xml_nota_fiscal || null;

        await atualizarNotaResultado({ ref: referencia }, {
            status: "autorizado",
            numero,
            chave: codVerif,
            dataEmissao: new Date().toISOString(),
            caminhoPdf: urlPdf,
            caminhoXml: urlXml,
            response: body,
        }).catch((err) => logger.warn({ err: err.message }, "focus-webhook: falha atualizando Supabase"));

        if (conversa?.whatsapp) {
            // Focus envia URL do "PDF" no payload (`url` ou `url_danfse`).
            // Pra NFSe Nacional/ISSNET (Aparecida), essa URL é uma PÁGINA HTML
            // do portal da prefeitura (issnetonline.com.br/.../*.aspx), não
            // PDF binário. Tentamos baixar como PDF mesmo — se vier HTML,
            // baixarPdf valida magic bytes e lança erro. No catch caímos pra
            // fallback que MANDA O LINK como página, que é o que cliente
            // precisa pra ver/imprimir a nota.
            const urlPdfPayload = body.url || body.url_danfse || null;
            // 1ª tentativa: PDF binário direto da Focus (funciona pra NFe/NFCe
            // e alguns municípios NFSe; falha em ISSNET/Aparecida que entrega
            // só HTML do portal)
            let pdfEnviado = false;
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
                pdfEnviado = true;
            } catch (err) {
                logger.info(
                    { err: err.message, referencia },
                    "focus-webhook: PDF binário indisponível, tentando gerar DANFSe local"
                );
            }

            // 2ª tentativa: gerar DANFSe localmente a partir do XML autorizado.
            // Detecta formato (ABRASF Aparecida/Goiânia vs Nacional 1.01) e
            // usa o renderer apropriado. ABRASF → pdfkit próprio, Nacional →
            // DanfeService da lib nfse-nacional.
            if (!pdfEnviado) {
                try {
                    const urlXmlPayload = body.caminho_xml_nota_fiscal || body.url_xml || null;
                    const xml = await baixarXml(referencia, empresa.focus_token, empresa, urlXmlPayload);
                    const formato = detectarFormatoXml(xml);
                    logger.info({ referencia, formato }, "focus-webhook: gerando DANFSe");

                    let pdfBytes = null;
                    if (formato === "abrasf") {
                        pdfBytes = await Promise.race([
                            gerarDanfseAbrasf(xml),
                            new Promise((_, rej) =>
                                setTimeout(() => rej(new Error("DANFSe ABRASF timeout 15s")), 15000)
                            ),
                        ]);
                    } else {
                        const danfe = new DanfeService();
                        const out = await Promise.race([
                            danfe.generateFromXml(xml, { chaveAcesso: codVerif || numero }),
                            new Promise((_, rej) =>
                                setTimeout(() => rej(new Error("DANFSe Nacional timeout 15s")), 15000)
                            ),
                        ]);
                        pdfBytes = out?.pdfBytes ? Buffer.from(out.pdfBytes) : null;
                    }

                    if (pdfBytes) {
                        await enviarPdf(
                            conversa.whatsapp,
                            pdfBytes,
                            `NFS-e-${numero}.pdf`,
                            formatarMensagemNotaEmitida(nota, numero)
                        );
                        pdfEnviado = true;
                        logger.info(
                            { referencia, formato, tamanho: pdfBytes.length },
                            "focus-webhook: DANFSe local gerado e enviado"
                        );
                    } else {
                        logger.warn(
                            { referencia, formato },
                            "focus-webhook: renderer não retornou pdfBytes"
                        );
                    }
                } catch (err) {
                    logger.warn(
                        { err: err.message, referencia },
                        "focus-webhook: falha gerando DANFSe local, caindo pro link"
                    );
                }
            }

            // 3ª tentativa (último recurso): link do portal da prefeitura.
            // Usado quando PDF binário falhou E DANFSe local também falhou
            // (XML indisponível ou DanfeService deu erro).
            if (!pdfEnviado) {
                if (urlPdfPayload) {
                    await enviarTexto(
                        conversa.whatsapp,
                        formatarMensagemSemPdfBinario(nota, numero, codVerif, urlPdfPayload)
                    ).catch(() => {});
                } else {
                    await enviarTexto(
                        conversa.whatsapp,
                        `${formatarMensagemNotaEmitida(nota, numero)}\n🔐 Código: ${codVerif || "—"}\n\n_Veja o PDF no painel pacnobolso.com.br/fiscal._`
                    ).catch(() => {});
                }
            }

            if (conversa.id) finalizarConversa.run("finalizada", conversa.id);
        }
        return { ok: true, status: "autorizado", numero };
    }

    if (novoStatus === "rejeitado" || novoStatus === "cancelado") {
        const motivo = body.mensagem || body.erros?.[0]?.mensagem || body.evento || "Sem detalhes";
        if (nota.id) {
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
        }
        await atualizarNotaResultado({ ref: referencia }, {
            status: novoStatus,
            erro: String(motivo),
            response: body,
        }).catch((err) => logger.warn({ err: err.message }, "focus-webhook: falha atualizando Supabase"));

        if (conversa?.whatsapp) {
            const acao = novoStatus === "cancelado" ? "cancelou" : "rejeitou";
            await enviarTexto(
                conversa.whatsapp,
                `⚠️ A prefeitura ${acao} a emissão:\n\n_${motivo}_\n\n` +
                `Não esquenta — já chamei minha equipe técnica pra ver o que rolou. A gente resolve.`
            );
            if (conversa.id) finalizarConversa.run("finalizada", conversa.id);
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
