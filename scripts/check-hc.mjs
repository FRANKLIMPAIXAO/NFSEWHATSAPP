/**
 * Verifica estado atual do cadastro HC GESTAO no Supabase.
 * Apenas campos relevantes (sem expor cert/token).
 */
import { createClient } from "@supabase/supabase-js";

const supa = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
);

const { data, error } = await supa
    .from("poupeja_fiscal_emitentes")
    .select(
        "nome, cnpj, im, municipio, regime_tributario, codigo_servico_nacional, codigo_atividade_municipal, aliquota_iss, cnae, emissor, habilita_nfse"
    )
    .eq("cnpj", "47870071000109");

if (error) {
    console.error(error);
    process.exit(1);
}
console.log(JSON.stringify(data, null, 2));
