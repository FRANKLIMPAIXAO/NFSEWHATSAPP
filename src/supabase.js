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
import { logger } from "./utils/logger.js";

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

let client = null;

if (url && serviceKey) {
    client = createClient(url, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false },
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
