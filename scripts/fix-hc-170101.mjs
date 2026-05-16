/**
 * Volta codigo_servico_nacional da HC pra "170101" (que existia originalmente).
 *
 * 170101 = "Assessoria ou consultoria de qualquer natureza, não contida em
 * outros itens desta lista" (Tabela CGSN oficial, Anexo B).
 * Eu havia mudado pra '170100' achando que era o "raiz" mas esse código
 * NÃO existe na tabela Nacional pós-Reforma (E0310 da SEFAZ).
 */
import { createClient } from "@supabase/supabase-js";

const supa = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
);

const { data, error } = await supa
    .from("poupeja_fiscal_emitentes")
    .update({ codigo_servico_nacional: "170101" })
    .eq("cnpj", "47870071000109")
    .select("nome, codigo_servico_nacional, codigo_atividade_municipal");

if (error) {
    console.error(error);
    process.exit(1);
}
console.log("✅ DEPOIS:", JSON.stringify(data, null, 2));
