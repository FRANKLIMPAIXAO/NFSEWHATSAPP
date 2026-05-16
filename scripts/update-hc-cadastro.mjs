/**
 * One-shot pra corrigir cadastro HC GESTAO no Supabase com base na Ficha
 * Cadastral oficial da Prefeitura de Goiânia (11/11/2025).
 *
 * Atividade Principal: 17.01 (consultoria) — código municipal 1701
 * Alíquota Grupo Fiscal 17: 5%
 *
 * NÃO incluí codigo_atividade_municipal aqui porque a coluna ainda não
 * existe no Supabase — precisa ALTER TABLE manual antes.
 *
 * Rodar uma única vez: node scripts/update-hc-cadastro.mjs
 */
import { createClient } from "@supabase/supabase-js";

const supa = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
);

const CNPJ_HC = "47870071000109";

const { data: before, error: errBefore } = await supa
    .from("poupeja_fiscal_emitentes")
    .select("id, nome, cnpj, codigo_servico_nacional, aliquota_iss")
    .eq("cnpj", CNPJ_HC);

console.log("ANTES:", JSON.stringify(before, null, 2));
if (errBefore) {
    console.error("erro SELECT:", errBefore);
    process.exit(1);
}

const { data, error } = await supa
    .from("poupeja_fiscal_emitentes")
    .update({
        codigo_servico_nacional: "170100",
        aliquota_iss: 5.0,
    })
    .eq("cnpj", CNPJ_HC)
    .select();

console.log("DEPOIS:", JSON.stringify(data, null, 2));
if (error) {
    console.error("erro UPDATE:", error);
    process.exit(1);
}
console.log("✅ HC atualizada");
