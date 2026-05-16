/**
 * Marca HC GESTAO como usa_nfse_nacional=true (Cenário C — Ambiente Nacional).
 *
 * Pré-requisito: coluna `usa_nfse_nacional` (boolean) já existe no Supabase.
 * Se não, rodar antes no SQL Editor:
 *   ALTER TABLE poupeja_fiscal_emitentes
 *     ADD COLUMN IF NOT EXISTS usa_nfse_nacional BOOLEAN DEFAULT FALSE;
 */
import { createClient } from "@supabase/supabase-js";

const supa = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
);

const { data, error } = await supa
    .from("poupeja_fiscal_emitentes")
    .update({ usa_nfse_nacional: true })
    .eq("cnpj", "47870071000109")
    .select("nome, codigo_servico_nacional, codigo_atividade_municipal, usa_nfse_nacional, municipio_no_cnc");

if (error) {
    console.error(error);
    process.exit(1);
}
console.log("✅ HC:", JSON.stringify(data, null, 2));
