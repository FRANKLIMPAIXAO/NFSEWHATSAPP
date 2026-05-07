/**
 * src/services/cert.js
 * Lê o certificado A1 da empresa (.pfx / .p12) e extrai:
 *   - certificado público (PEM)
 *   - chave privada (PEM)
 *   - cadeia de certificados (chain)
 *   - metadados (CNPJ, validade, CN)
 *
 * Usado pelo cliente do Emissor Público Nacional pra:
 *   - mTLS HTTPS
 *   - assinatura XAdES do XML DPS
 */
import fs from "node:fs";
import forge from "node-forge";

/**
 * Carrega .pfx/.p12 e devolve cert + chave em formato PEM.
 *
 * @param {string} pfxPath - caminho absoluto do arquivo .pfx
 * @param {string} password - senha do PKCS#12
 * @returns {{ certPem: string, keyPem: string, chainPem: string[],
 *            metadata: { cnpj: string, cn: string, notBefore: Date, notAfter: Date } }}
 */
export function loadPfx(pfxPath, password) {
    if (!fs.existsSync(pfxPath)) {
        throw new Error(`Certificado não encontrado: ${pfxPath}`);
    }

    const pfxDer = fs.readFileSync(pfxPath, { encoding: "binary" });
    const p12Asn1 = forge.asn1.fromDer(pfxDer);
    const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, password);

    // Bag com chave privada (shrouded ou plain)
    const keyBags =
        p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[
            forge.pki.oids.pkcs8ShroudedKeyBag
        ] || [];
    const plainKeyBags =
        p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || [];
    const keyBag = keyBags[0] || plainKeyBags[0];
    if (!keyBag) throw new Error("Chave privada não encontrada no .pfx");
    const keyPem = forge.pki.privateKeyToPem(keyBag.key);

    // Bags com certificados (folha + cadeia)
    const certBags =
        p12.getBags({ bagType: forge.pki.oids.certBag })[
            forge.pki.oids.certBag
        ] || [];
    if (!certBags.length) throw new Error("Certificado não encontrado no .pfx");

    // O certificado folha é o que tem a chave privada associada (mesmo subject que o keyBag)
    const certs = certBags.map((b) => b.cert);
    const leaf = certs[0]; // forge põe o leaf primeiro normalmente
    const certPem = forge.pki.certificateToPem(leaf);
    const chainPem = certs.slice(1).map((c) => forge.pki.certificateToPem(c));

    // Metadados do leaf
    const cn = leaf.subject.getField("CN")?.value || "";
    // CN no formato "RAZAO SOCIAL:CNPJ"
    const cnpjMatch = cn.match(/:(\d{14})$/);
    const cnpj = cnpjMatch ? cnpjMatch[1] : "";

    return {
        certPem,
        keyPem,
        chainPem,
        metadata: {
            cnpj,
            cn,
            notBefore: leaf.validity.notBefore,
            notAfter: leaf.validity.notAfter,
        },
    };
}

/**
 * Carrega o certificado da empresa cadastrada no banco.
 * Lê empresa.cert_pfx_path + empresa.cert_pfx_password e usa loadPfx.
 *
 * Validação adicional: confere que o CNPJ do certificado bate com o da empresa.
 */
export function loadCertEmpresa(empresa) {
    if (!empresa.cert_pfx_path) {
        throw new Error(`Empresa ${empresa.id} sem certificado cadastrado (cert_pfx_path).`);
    }
    if (!empresa.cert_pfx_password) {
        throw new Error(`Empresa ${empresa.id} sem senha do certificado (cert_pfx_password).`);
    }

    const result = loadPfx(empresa.cert_pfx_path, empresa.cert_pfx_password);

    if (result.metadata.cnpj && result.metadata.cnpj !== empresa.cnpj) {
        throw new Error(
            `CNPJ do certificado (${result.metadata.cnpj}) não bate com CNPJ da empresa (${empresa.cnpj}).`
        );
    }

    const agora = new Date();
    if (agora < result.metadata.notBefore || agora > result.metadata.notAfter) {
        throw new Error(
            `Certificado fora da validade (${result.metadata.notBefore.toISOString()} → ${result.metadata.notAfter.toISOString()})`
        );
    }

    return result;
}
