/**
 * src/supabase.js
 * Cliente Supabase singleton. Usa SERVICE_ROLE (bypassa RLS) — só backend.
 *
 * Modo desligado: se as envs não estiverem setadas, o módulo exporta
 * `supabase = null` e `isEnabled() = false`. Quem usa deve checar antes —
 * sem isso, o agent continua rodando 100% no SQLite local (Roca/El Shadai
 * em prod não são afetadas).
 */
import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import { logger } from "./utils/logger.js";

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

let client = null;

if (url && serviceKey) {
    // Node 20 não tem WebSocket nativo (só veio em 22+). O sub-módulo
    // realtime-js do @supabase/supabase-js crasha no construtor sem isso.
    // Não usamos realtime, mas o createClient instancia mesmo assim — então
    // injetamos `ws` como transporte pra não derrubar o startup do agent.
    client = createClient(url, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false },
        realtime: { transport: ws },
    });
    logger.info({ url }, "supabase: cliente inicializado");
} else {
    logger.warn(
        "supabase: SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausentes — modo desligado (agent segue 100% SQLite)"
    );
}

export const supabase = client;
export function isEnabled() {
    return client !== null;
}
