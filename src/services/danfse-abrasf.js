/**
 * src/services/danfse-abrasf.js
 * Gera DANFSe (PDF) a partir de XML ABRASF (v1, v2.x).
 * Necessário pra Aparecida/Goiânia e outros municípios que ainda emitem
 * em formato ABRASF — a lib `nfse-nacional` só sabe ler Nacional 1.01.
 *
 * Não tenta validar schema — tolerante: campo ausente vira "-".
 * Suporta diferentes prefixos de namespace (nfse:, ns2:, sem prefixo).
 */
import PDFDocument from "pdfkit";

/**
 * Extrai conteúdo de uma tag de qualquer namespace.
 * Ex: pickTag(xml, "Numero") casa <Numero>x</Numero>, <ns2:Numero>x</ns2:Numero>, etc.
 */
function pickTag(xml, tag) {
    const re = new RegExp(`<(?:[\\w-]+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${tag}>`, "i");
    const m = xml.match(re);
    if (!m) return null;
    return m[1].trim();
}

/**
 * Mesma coisa mas devolve o BLOCO INTEIRO (com as tags) — útil pra
 * delimitar áreas tipo <Servico>...</Servico> antes de procurar subtags.
 */
function pickBlock(xml, tag) {
    const re = new RegExp(`<(?:[\\w-]+:)?${tag}[^>]*>[\\s\\S]*?<\\/(?:[\\w-]+:)?${tag}>`, "i");
    const m = xml.match(re);
    return m ? m[0] : null;
}

function fmtMoeda(v) {
    const n = Number(v);
    if (!isFinite(n)) return "-";
    return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function fmtCnpjCpf(doc) {
    const s = String(doc || "").replace(/\D/g, "");
    if (s.length === 14) return s.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
    if (s.length === 11) return s.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
    return s || "-";
}

function fmtData(s) {
    if (!s) return "-";
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
}

/**
 * Extrai todos os campos relevantes do XML ABRASF.
 */
function parseAbrasf(xml) {
    const prestadorBlock = pickBlock(xml, "PrestadorServico") || pickBlock(xml, "Prestador") || xml;
    const tomadorBlock = pickBlock(xml, "TomadorServico") || pickBlock(xml, "Tomador") || xml;
    const servicoBlock = pickBlock(xml, "Servico") || xml;
    const valoresBlock = pickBlock(servicoBlock, "Valores") || servicoBlock;
    const enderecoPrestadorBlock = pickBlock(prestadorBlock, "Endereco") || prestadorBlock;
    const enderecoTomadorBlock = pickBlock(tomadorBlock, "Endereco") || tomadorBlock;

    return {
        numero: pickTag(xml, "Numero") || "-",
        codigoVerificacao: pickTag(xml, "CodigoVerificacao") || "-",
        dataEmissao: fmtData(pickTag(xml, "DataEmissao") || pickTag(xml, "DataEmissaoRps")),
        competencia: fmtData(pickTag(xml, "Competencia")),
        prestador: {
            cnpj: fmtCnpjCpf(pickTag(prestadorBlock, "Cnpj") || pickTag(prestadorBlock, "CpfCnpj")),
            im: pickTag(prestadorBlock, "InscricaoMunicipal") || "-",
            razao: pickTag(prestadorBlock, "RazaoSocial") || "-",
            nomeFantasia: pickTag(prestadorBlock, "NomeFantasia") || "",
            endereco: pickTag(enderecoPrestadorBlock, "Endereco") || "-",
            numero: pickTag(enderecoPrestadorBlock, "Numero") || "",
            bairro: pickTag(enderecoPrestadorBlock, "Bairro") || "",
            municipio: pickTag(enderecoPrestadorBlock, "CodigoMunicipio") || "",
            uf: pickTag(enderecoPrestadorBlock, "Uf") || "",
            cep: pickTag(enderecoPrestadorBlock, "Cep") || "",
        },
        tomador: {
            cnpj: fmtCnpjCpf(pickTag(tomadorBlock, "Cnpj") || pickTag(tomadorBlock, "Cpf") || pickTag(tomadorBlock, "CpfCnpj")),
            im: pickTag(tomadorBlock, "InscricaoMunicipal") || "",
            razao: pickTag(tomadorBlock, "RazaoSocial") || "-",
            endereco: pickTag(enderecoTomadorBlock, "Endereco") || "-",
            numero: pickTag(enderecoTomadorBlock, "Numero") || "",
            bairro: pickTag(enderecoTomadorBlock, "Bairro") || "",
            municipio: pickTag(enderecoTomadorBlock, "CodigoMunicipio") || "",
            uf: pickTag(enderecoTomadorBlock, "Uf") || "",
            cep: pickTag(enderecoTomadorBlock, "Cep") || "",
            email: pickTag(tomadorBlock, "Email") || "",
        },
        servico: {
            descricao: pickTag(servicoBlock, "Discriminacao") || "-",
            codigoLc116: pickTag(servicoBlock, "ItemListaServico") || "-",
            codigoMunicipio: pickTag(servicoBlock, "CodigoCnae") || pickTag(servicoBlock, "CodigoTributacaoMunicipio") || "-",
            municipioPrestacao: pickTag(servicoBlock, "MunicipioPrestacaoServico") || pickTag(servicoBlock, "CodigoMunicipio") || "-",
        },
        valores: {
            servicos: fmtMoeda(pickTag(valoresBlock, "ValorServicos")),
            iss: fmtMoeda(pickTag(valoresBlock, "ValorIss")),
            issRetido: pickTag(valoresBlock, "IssRetido") === "1" ? "Sim" : "Não",
            aliquota: pickTag(valoresBlock, "Aliquota") || "-",
            baseCalculo: fmtMoeda(pickTag(valoresBlock, "BaseCalculo")),
            valorLiquido: fmtMoeda(pickTag(valoresBlock, "ValorLiquidoNfse") || pickTag(valoresBlock, "ValorServicos")),
            pis: fmtMoeda(pickTag(valoresBlock, "ValorPis")),
            cofins: fmtMoeda(pickTag(valoresBlock, "ValorCofins")),
            inss: fmtMoeda(pickTag(valoresBlock, "ValorInss")),
            ir: fmtMoeda(pickTag(valoresBlock, "ValorIr")),
            csll: fmtMoeda(pickTag(valoresBlock, "ValorCsll")),
        },
    };
}

/**
 * Gera PDF DANFSe ABRASF e retorna Buffer.
 */
export async function gerarDanfseAbrasf(xml) {
    const dados = parseAbrasf(xml);

    return await new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: "A4", margin: 32 });
            const chunks = [];
            doc.on("data", (c) => chunks.push(c));
            doc.on("end", () => resolve(Buffer.concat(chunks)));
            doc.on("error", reject);

            // Cabeçalho
            doc.fontSize(14).font("Helvetica-Bold")
                .text("DOCUMENTO AUXILIAR DA NFS-e", { align: "center" });
            doc.fontSize(8).font("Helvetica")
                .text("Representação gráfica da NFS-e. Verifique a autenticidade pelo código no portal da prefeitura.",
                    { align: "center" });
            doc.moveDown(0.5);

            // Caixa de cabeçalho com número + código verificação
            const headerY = doc.y;
            doc.rect(32, headerY, 530, 50).stroke();
            doc.fontSize(8).font("Helvetica-Bold").text("NÚMERO DA NFS-e", 40, headerY + 6);
            doc.fontSize(14).font("Helvetica-Bold").text(dados.numero, 40, headerY + 18);
            doc.fontSize(8).font("Helvetica-Bold").text("CÓDIGO DE VERIFICAÇÃO", 200, headerY + 6);
            doc.fontSize(11).font("Helvetica").text(dados.codigoVerificacao, 200, headerY + 20);
            doc.fontSize(8).font("Helvetica-Bold").text("DATA DE EMISSÃO", 380, headerY + 6);
            doc.fontSize(11).font("Helvetica").text(dados.dataEmissao, 380, headerY + 20);
            doc.fontSize(8).font("Helvetica-Bold").text("COMPETÊNCIA", 480, headerY + 6);
            doc.fontSize(10).font("Helvetica").text(dados.competencia, 480, headerY + 20);
            doc.y = headerY + 55;

            // Prestador
            secao(doc, "PRESTADOR DOS SERVIÇOS");
            linha(doc, "CNPJ", dados.prestador.cnpj, "INSCRIÇÃO MUNICIPAL", dados.prestador.im);
            linha(doc, "RAZÃO SOCIAL", dados.prestador.razao);
            if (dados.prestador.nomeFantasia) linha(doc, "NOME FANTASIA", dados.prestador.nomeFantasia);
            linha(doc, "ENDEREÇO",
                `${dados.prestador.endereco}, ${dados.prestador.numero} — ${dados.prestador.bairro} — ${dados.prestador.uf} — CEP ${dados.prestador.cep}`);

            // Tomador
            secao(doc, "TOMADOR DOS SERVIÇOS");
            linha(doc, "CNPJ/CPF", dados.tomador.cnpj, "INSCRIÇÃO MUNICIPAL", dados.tomador.im || "-");
            linha(doc, "RAZÃO SOCIAL / NOME", dados.tomador.razao);
            linha(doc, "ENDEREÇO",
                `${dados.tomador.endereco}, ${dados.tomador.numero} — ${dados.tomador.bairro} — ${dados.tomador.uf} — CEP ${dados.tomador.cep}`);
            if (dados.tomador.email) linha(doc, "E-MAIL", dados.tomador.email);

            // Serviço
            secao(doc, "DISCRIMINAÇÃO DO SERVIÇO");
            doc.fontSize(10).font("Helvetica");
            doc.text(dados.servico.descricao, 40, doc.y, { width: 520 });
            doc.moveDown(0.5);
            linha(doc, "CÓDIGO LC 116", dados.servico.codigoLc116, "CÓD. MUNICÍPIO", dados.servico.codigoMunicipio);

            // Valores
            secao(doc, "VALORES");
            linha(doc, "VALOR DOS SERVIÇOS", dados.valores.servicos, "BASE DE CÁLCULO", dados.valores.baseCalculo);
            linha(doc, "ALÍQUOTA (%)", dados.valores.aliquota, "VALOR DO ISS", dados.valores.iss);
            linha(doc, "ISS RETIDO", dados.valores.issRetido, "VALOR LÍQUIDO", dados.valores.valorLiquido);

            // Retenções (se houver)
            const temRetencao = [dados.valores.pis, dados.valores.cofins, dados.valores.inss, dados.valores.ir, dados.valores.csll]
                .some((v) => v && v !== fmtMoeda(0) && v !== "-");
            if (temRetencao) {
                secao(doc, "RETENÇÕES FEDERAIS");
                linha(doc, "PIS", dados.valores.pis, "COFINS", dados.valores.cofins);
                linha(doc, "INSS", dados.valores.inss, "IR", dados.valores.ir);
                linha(doc, "CSLL", dados.valores.csll);
            }

            // Rodapé
            doc.moveDown(1);
            doc.fontSize(7).font("Helvetica-Oblique").fillColor("#666")
                .text("Gerado por PacNoBolso — pacnobolso.com.br", { align: "center" });

            doc.end();
        } catch (err) {
            reject(err);
        }
    });
}

function secao(doc, titulo) {
    doc.moveDown(0.4);
    doc.fontSize(9).font("Helvetica-Bold").fillColor("#000")
        .text(titulo, 40, doc.y);
    doc.moveTo(32, doc.y + 1).lineTo(562, doc.y + 1).stroke();
    doc.moveDown(0.3);
}

function linha(doc, label1, valor1, label2, valor2) {
    const y = doc.y;
    doc.fontSize(7).font("Helvetica-Bold").fillColor("#555")
        .text(label1, 40, y);
    doc.fontSize(10).font("Helvetica").fillColor("#000")
        .text(valor1 || "-", 40, y + 10, { width: label2 ? 250 : 520 });
    if (label2) {
        doc.fontSize(7).font("Helvetica-Bold").fillColor("#555")
            .text(label2, 300, y);
        doc.fontSize(10).font("Helvetica").fillColor("#000")
            .text(valor2 || "-", 300, y + 10, { width: 260 });
    }
    doc.y = y + 24;
}
