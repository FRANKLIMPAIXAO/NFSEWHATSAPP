/**
 * src/db/supabase-repo.js
 * Repositório de leitura do Pac no Bolso (Supabase) — só leitura por enquanto.
 *
 * Etapa 2 do refactor. Função pura, não plugada no fluxo do webhook ainda
 * — ativada só na etapa 4. Pra ativar agora, basta chamar.
 */
import { supabase, isEnabled } from "../supabase.js";
import { variantesNumeroBr } from "./index.js";
import { logger } from "../utils/logger.js";

/**
 * Busca emitente no Pac no Bolso pelo número do WhatsApp do dono.
 *
 * - Tenta as 2 variantes do número BR (com e sem nono dígito).
 * - Devolve null se Supabase estiver desligado, não achou, ou deu erro.
 *   Quem chama deve cair pro SQLite local em qualquer um desses casos.
 *
 * @param {string} numero — formato "5562999999999" (só dígitos, sem +)
 * @returns {Promise<object|null>} row de poupeja_fiscal_emitentes ou null
 */
export async function findEmitenteByWhatsapp(numero) {
    if (!isEnabled()) return null;
    if (!numero) return null;

    const variantes = variantesNumeroBr(numero);
    if (!variantes.length) return null;

    const { data, error } = await supabase
        .from("poupeja_fiscal_emitentes")
        .select("*")
        .in("whatsapp_dono", variantes)
        .limit(1)
        .maybeSingle();

    if (error) {
        logger.error(
            { err: error.message, numero },
            "supabase-repo: erro buscando emitente por whatsapp"
        );
        return null;
    }
    return data;
}
