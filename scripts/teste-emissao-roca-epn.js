/**
 * scripts/teste-emissao-roca-epn.js
 * Emite NFS-e de teste pra ROCA via API direta do EPN (sem Focus).
 * Tomador: Indústria Latícinio Claveaux (CNPJ 01060996000193).
 */
import "dotenv/config";
import { findEmpresaById } from "../src/db/index.js";
import { emitirEpn } from "../src/services/epn.js";

const empresa = findEmpresaById.get(2);
if (!empresa) throw new Error("ROCA (id=2) não cadastrada");
if (!empresa.cert_pfx_path) throw new Error("ROCA sem certificado configurado");

console.log("=========================================");
console.log("TESTE EMISSÃO EPN — ROCA → CLAVEAUX");
console.log("=========================================");
console.log("Prestador :", empresa.razao_social, "(", empresa.cnpj, ")");
console.log("Município :", empresa.municipio_nome, "(", empresa.municipio_codigo, ")");
console.log("Cert      :", empresa.cert_pfx_path);
console.log("Ambiente  :", process.env.EPN_AMBIENTE);
console.log("");

// Tomador hardcoded (dados confirmados via BrasilAPI)
const tomador = {
    cnpj: "01060996000193",
    razao_social: "INDUSTRIA DE LATICINIO CLAVEAUX LTDA",
    municipio_ibge: "5201405",  // Aparecida de Goiânia/GO
    cep: "74921303",
    logradouro: "Rua X 41",
    numero: "SN",
    bairro: "Setor Tocantins",
};
console.log(`→ Tomador: ${tomador.razao_social} (${tomador.cnpj})`);

const params = {
    empresa,
    competencia: new Date().toISOString().slice(0, 10),
    tomador: {
        tipo: "PJ",
        documento: tomador.cnpj,
        razao_social: tomador.razao_social,
        endereco: {
            cMun: tomador.municipio_ibge,
            cep: tomador.cep,
            xLgr: tomador.logradouro,
            nro: tomador.numero,
            xBairro: tomador.bairro,
        },
    },
    servico: {
        descricao: "Serviços prestados",
        // Para LC 14.01 (manutenção/reparação) — código nacional 140101.
        codigo_servico_nacional: empresa.servico_padrao_lc116,
        valor_total: 1.0,
    },
};

console.log("\n→ Emitindo DPS...");
try {
    const { response } = await emitirEpn(params);
    console.log("\n=== RESPOSTA SEFIN ===");
    console.log("cStat       :", response.cStat);
    console.log("xMotivo     :", response.xMotivo);
    console.log("ChaveAcesso :", response.chaveAcesso);
    console.log("Número NFSe :", response.nfse?.infNfse?.nNFSe);

    if (response.cStat === "100") {
        console.log("\n✅ NFS-E AUTORIZADA");
    } else {
        console.log("\n⚠️ Não autorizada — analisar erros/alertas:");
        console.log(JSON.stringify(response, null, 2).slice(0, 2000));
    }
} catch (err) {
    console.error("\n❌ ERRO:", err.constructor.name, "-", err.message);
    if (err.errors) console.error("validações:", JSON.stringify(err.errors, null, 2).slice(0, 1500));
    if (err.statusCode) console.error("HTTP status:", err.statusCode);
    if (err.body) console.error("body:", String(err.body).slice(0, 1500));
    process.exit(1);
}
