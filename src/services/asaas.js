/**
 * src/services/asaas.js
 * Cliente da API Asaas — usado pra buscar cobranças pendentes e gerar
 * links de pagamento pra incluir nas mensagens de cobrança.
 *
 * Auth via header `access_token`. API key armazenada em poupeja_settings
 * (category='asaas', key='asaas_api_key') ou fallback em env var
 * ASAAS_API_KEY. Ambiente production por default; sandbox se
 * env ASAAS_ENV=sandbox.
 */
import { supabase } from "../supabase.js";
import { logger } from "../utils/logger.js";

const ASAAS_BASE_URL_PROD = "https://api.asaas.com/v3";
const ASAAS_BASE_URL_SANDBOX = "https://sandbox.asaas.com/api/v3";

let apiKeyCached = null;
let apiKeyCachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

async function getApiKey() {
    if (apiKeyCached && Date.now() - apiKeyCachedAt < CACHE_TTL_MS) {
        return apiKeyCached;
    }
    // Tenta env primeiro (mais rápido), depois Supabase
    const envKey = process.env.ASAAS_API_KEY?.trim();
    if (envKey) {
        apiKeyCached = envKey;
        apiKeyCachedAt = Date.now();
        return envKey;
    }
    if (!supabase) return null;
    const { data } = await supabase
        .from("poupeja_settings")
        .select("value")
        .eq("category", "asaas")
        .eq("key", "asaas_api_key")
        .maybeSingle();
    const key = data?.value?.trim() || null;
    if (key) {
        apiKeyCached = key;
        apiKeyCachedAt = Date.now();
    }
    return key;
}

function getBaseUrl() {
    return process.env.ASAAS_ENV === "sandbox"
        ? ASAAS_BASE_URL_SANDBOX
        : ASAAS_BASE_URL_PROD;
}

async function asaasFetch(path, apiKey) {
    const res = await fetch(`${getBaseUrl()}${path}`, {
        method: "GET",
        headers: {
            "Content-Type": "application/json",
            access_token: apiKey,
        },
    });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Asaas ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
}

/**
 * Busca a cobrança pendente mais recente de uma assinatura Asaas.
 * Retorna o objeto com invoiceUrl, bankSlipUrl, status, dueDate, value.
 * Null se não houver pendente ou se Asaas não configurado.
 *
 * Status pendentes considerados: PENDING, OVERDUE, AWAITING_RISK_ANALYSIS.
 *
 * @param {string} asaasSubscriptionId — ID da subscription no Asaas
 *   (vem de poupeja_subscriptions.asaas_subscription_id)
 */
export async function buscarCobrancaPendente(asaasSubscriptionId) {
    if (!asaasSubscriptionId) return null;
    try {
        const apiKey = await getApiKey();
        if (!apiKey) {
            logger.warn("asaas: API key não configurada — skip");
            return null;
        }
        // Asaas: GET /payments?subscription={id}&status=PENDING
        // Lista cobranças ordenadas por dueDate; pegamos a mais antiga pendente
        const path = `/payments?subscription=${encodeURIComponent(asaasSubscriptionId)}&status[]=PENDING&status[]=OVERDUE&limit=5`;
        const resp = await asaasFetch(path, apiKey);
        const lista = resp?.data || [];
        if (lista.length === 0) return null;
        // Ordena por dueDate ASC e pega a mais antiga em aberto
        lista.sort((a, b) =>
            String(a.dueDate || "").localeCompare(String(b.dueDate || "")),
        );
        const cobranca = lista[0];
        return {
            id: cobranca.id,
            invoiceUrl: cobranca.invoiceUrl || null,
            bankSlipUrl: cobranca.bankSlipUrl || null,
            pixCopiaECola: cobranca.pixCopiaECola || null,
            status: cobranca.status,
            dueDate: cobranca.dueDate,
            value: Number(cobranca.value) || 0,
            description: cobranca.description || null,
        };
    } catch (err) {
        logger.warn(
            { err: err.message, asaasSubscriptionId },
            "asaas: falha buscando cobrança pendente",
        );
        return null;
    }
}
