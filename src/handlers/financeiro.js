/**
 * src/handlers/financeiro.js
 * Handler da intenção "registrar_financeiro" — proxy pro n8n.
 *
 * Quando o classificador identifica que a mensagem do cliente é financeira
 * (foto/PDF de boleto, comprovante de Pix, extrato bancário, áudio "paguei
 * X reais"), em vez de processar aqui (Semana 3), reencaminhamos a mensagem
 * pro workflow "Conciliação Bancária WhatsApp" do n8n via webhook HTTP
 * intermediário "PAC-NFSE → Conciliação (Proxy)".
 *
 * O proxy do n8n recebe o POST e republica na queue RabbitMQ `Meu_App`
 * — mesma queue que a Evolution legada (poupeja-demonstracao) publica
 * naturalmente. Pro workflow consumidor, a origem fica transparente.
 *
 * FORMATO_ALVO replicado (FORMATO_ALVO descoberto em 2026-06-09):
 *   {
 *     nomeApp, telefoneSuporte, emailSuporte, projectUrlSupabase, urlSite,
 *     data: { key, message, messageType, pushName, contextInfo },
 *     server_url, apikey, instance,
 *     body: { data: { key: { fromMe: false } }, event: "messages.upsert" }
 *   }
 *
 * Configuração via env:
 *   - N8N_PROXY_URL                 obrigatório (sem ele, fallback placeholder)
 *   - N8N_PROXY_SECRET              obrigatório (header x-pac-secret)
 *   - PAC_APP_NAME                  default "Pac no Bolso"
 *   - PAC_SUPORTE_PHONE             default "6286429305"
 *   - PAC_SUPORTE_EMAIL             default "paixaoassessoriacontabil@gmail.com"
 *   - PAC_SITE_URL                  default "https://pacnobolso.com.br/"
 *   - PAC_EVO_SERVER_URL            Evolution onde o n8n deve responder ao cliente
 *   - PAC_EVO_API_KEY               (pública — o n8n usa pra falar com a Evolution)
 *   - PAC_EVO_INSTANCE              nome da instância na Evolution acima
 */
import { logger } from "../utils/logger.js";
import { enviarTexto } from "../services/whatsapp.js";

const N8N_PROXY_URL = process.env.N8N_PROXY_URL;
const N8N_PROXY_SECRET = process.env.N8N_PROXY_SECRET;

// Identidade do app — replica o que a Evolution legada publica na Meu_App.
const PAC_APP_NAME = process.env.PAC_APP_NAME || "Pac no Bolso";
const PAC_SUPORTE_PHONE = process.env.PAC_SUPORTE_PHONE || "6286429305";
const PAC_SUPORTE_EMAIL =
    process.env.PAC_SUPORTE_EMAIL || "paixaoassessoriacontabil@gmail.com";
const PAC_SITE_URL = process.env.PAC_SITE_URL || "https://pacnobolso.com.br/";
const PAC_SUPABASE_URL = process.env.SUPABASE_URL || "";

// Credenciais Evolution que o n8n usa pra RESPONDER. Default deixado em
// branco — DEVE ser configurado em prod via env do EasyPanel.
const PAC_EVO_SERVER_URL = process.env.PAC_EVO_SERVER_URL || "";
const PAC_EVO_API_KEY = process.env.PAC_EVO_API_KEY || "";
const PAC_EVO_INSTANCE = process.env.PAC_EVO_INSTANCE || "";

// Mensagem amigável quando o proxy não tá configurado (fallback)
const FALLBACK_PLACEHOLDER =
    "💰 Recebi! Tô terminando de plugar a parte de financeiro " +
    "(boletos, pix, extrato) por aqui. Em poucos dias rola.";

const FALLBACK_ERRO_TECNICO =
    "😬 Travei processando seu financeiro. Tenta de novo em 1 minutinho.";

/**
 * Encaminha a mensagem financeira pro proxy do n8n.
 *
 * @param {Object} args
 * @param {Object} args.evt      - evento original do webhook Evolution
 * @param {Object} args.empresa  - empresa identificada (do Supabase)
 * @param {string} args.numero   - whatsapp do user
 * @param {string} args.texto    - texto/transcrição (pode ser vazio)
 * @param {Array}  args.imagens     - [{base64, mimetype}] se houver
 * @param {Object} args.pdf         - {base64} se houver
 * @param {string} args.audioBase64 - áudio em base64 (pra audioMessage)
 */
export async function handleFinanceiro({ evt, empresa, numero, texto, imagens, pdf, audioBase64 }) {
    // Sem URL/secret configurado, fica no placeholder (não derruba o fluxo)
    if (!N8N_PROXY_URL || !N8N_PROXY_SECRET) {
        logger.warn(
            { temUrl: !!N8N_PROXY_URL, temSecret: !!N8N_PROXY_SECRET },
            "financeiro: N8N_PROXY_URL/SECRET ausentes — usando fallback placeholder"
        );
        await enviarTexto(numero, FALLBACK_PLACEHOLDER);
        return;
    }

    // Clona o evt.data pra não mutar referência usada lá em cima
    const data = JSON.parse(JSON.stringify(evt?.data || {}));

    // A Evolution legada injeta a mídia em base64 dentro de data.message.base64
    // antes de publicar na queue. Como recebemos via webhook, a mídia chega só
    // como messageId — já fizemos download em webhook.js. Injetamos manualmente.
    // O nó "Convert to File" do workflow "Conciliação Bancária WhatsApp" exige
    // esse campo populado pra qualquer tipo de mídia (imagem, PDF ou áudio) —
    // sem isso ele crasha com "first argument must be of type string... Received null".
    if (imagens && imagens.length > 0 && imagens[0]?.base64) {
        data.message = { ...(data.message || {}), base64: imagens[0].base64 };
    } else if (pdf?.base64) {
        data.message = { ...(data.message || {}), base64: pdf.base64 };
    } else if (audioBase64) {
        data.message = { ...(data.message || {}), base64: audioBase64 };
    }

    // Texto / transcrição: alguns workflows usam isso pra detectar intenção.
    // Mantemos pra compatibilidade futura — o consumer pode ignorar.
    if (texto && !data.message?.conversation) {
        data.message = { ...(data.message || {}), conversation: texto };
    }

    const payload = {
        nomeApp: PAC_APP_NAME,
        telefoneSuporte: PAC_SUPORTE_PHONE,
        emailSuporte: PAC_SUPORTE_EMAIL,
        projectUrlSupabase: PAC_SUPABASE_URL,
        urlSite: PAC_SITE_URL,
        data,
        server_url: PAC_EVO_SERVER_URL,
        apikey: PAC_EVO_API_KEY,
        instance: PAC_EVO_INSTANCE,
        body: {
            data: { key: { fromMe: false } },
            event: "messages.upsert",
        },
    };

    const t0 = Date.now();
    try {
        const resp = await fetch(N8N_PROXY_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-pac-secret": N8N_PROXY_SECRET,
            },
            body: JSON.stringify(payload),
            // Timeout defensivo: se o proxy demorar mais que 10s, cancela e
            // avisa o cliente (n8n deve responder Immediately, então é mais
            // que suficiente).
            signal: AbortSignal.timeout(10000),
        });
        const latencyMs = Date.now() - t0;

        if (!resp.ok) {
            const body = await resp.text().catch(() => "");
            logger.error(
                {
                    status: resp.status,
                    body: body.slice(0, 400),
                    latencyMs,
                    numero,
                    tipo: data.messageType,
                },
                "financeiro: proxy n8n retornou erro"
            );
            await enviarTexto(numero, FALLBACK_ERRO_TECNICO);
            return;
        }

        logger.info(
            {
                latencyMs,
                numero,
                tipo: data.messageType,
                temImagem: !!(imagens && imagens.length),
                temPdf: !!pdf?.base64,
                temTexto: !!texto,
                empresaId: empresa?.id,
            },
            "financeiro: encaminhado pro n8n via proxy"
        );

        // NÃO enviamos confirmação ao cliente aqui — o n8n vai responder
        // direto pela Evolution configurada (PAC_EVO_INSTANCE). O cliente
        // já recebeu "📷 Recebi a imagem. Analisando..." durante o download
        // da mídia em webhook.js, então não tem vácuo.
    } catch (err) {
        const latencyMs = Date.now() - t0;
        const isTimeout = err.name === "TimeoutError" || err.name === "AbortError";
        logger.error(
            {
                err: err.message,
                isTimeout,
                latencyMs,
                numero,
                tipo: data.messageType,
            },
            "financeiro: falha chamando proxy n8n"
        );
        await enviarTexto(numero, FALLBACK_ERRO_TECNICO);
    }
}
