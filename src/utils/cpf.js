/**
 * src/utils/cpf.js
 * Validação de CPF via dígito verificador.
 *
 * Receita Federal não expõe consulta pública de CPF (diferente de CNPJ),
 * então a defesa fica só no DV — pega CPF inventado, digitado errado e
 * alucinação do LLM ao ler imagem com texto borrado.
 */

export function validarCpf(cpf) {
    const limpo = String(cpf || "").replace(/\D/g, "");
    if (limpo.length !== 11) return false;
    if (/^(\d)\1{10}$/.test(limpo)) return false;

    let soma = 0;
    for (let i = 0; i < 9; i++) soma += parseInt(limpo[i], 10) * (10 - i);
    let dv1 = soma % 11;
    dv1 = dv1 < 2 ? 0 : 11 - dv1;
    if (dv1 !== parseInt(limpo[9], 10)) return false;

    soma = 0;
    for (let i = 0; i < 10; i++) soma += parseInt(limpo[i], 10) * (11 - i);
    let dv2 = soma % 11;
    dv2 = dv2 < 2 ? 0 : 11 - dv2;
    return dv2 === parseInt(limpo[10], 10);
}

export function formatarCpf(cpf) {
    const limpo = String(cpf || "").replace(/\D/g, "");
    if (limpo.length !== 11) return String(cpf || "");
    return `${limpo.slice(0, 3)}.${limpo.slice(3, 6)}.${limpo.slice(6, 9)}-${limpo.slice(9)}`;
}
