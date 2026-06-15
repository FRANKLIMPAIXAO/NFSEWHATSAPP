/**
 * src/services/danfse-abrasf.js
 * Gera DANFSe (PDF) a partir de XML ABRASF (v1, v2.x).
 * Necessário pra Aparecida/Goiânia e outros municípios que ainda emitem
 * em formato ABRASF — a lib `nfse-nacional` só sabe ler Nacional 1.01.
 *
 * Layout segue o padrão visual da NFS-e municipal (cabeçalho com
 * prefeitura, prestador/tomador em caixas, valores tabulados).
 */
import PDFDocument from "pdfkit";
import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    removeNSPrefix: true, // remove ns2:, nfse:, etc — fica só Tag
    parseTagValue: true,
    parseAttributeValue: false,
    trimValues: true,
});

/**
 * Caminha um path tipo "a.b.c" no objeto retornado pelo parser, tolerante
 * a undefined. Retorna string vazia se algum nó não existir.
 */
function pick(obj, path) {
    if (!obj) return "";
    const parts = path.split(".");
    let cur = obj;
    for (const p of parts) {
        if (cur == null) return "";
        cur = cur[p];
    }
    if (cur == null) return "";
    if (typeof cur === "object") return "";
    return String(cur);
}

/**
 * Procura o primeiro path que retorna valor não vazio. Útil pra cobrir
 * variações de schema ABRASF (v1.x vs v2.04 vs municipal customizado).
 */
function firstOf(obj, ...paths) {
    for (const p of paths) {
        const v = pick(obj, p);
        if (v !== "") return v;
    }
    return "";
}

/**
 * Encontra o nó <InfNfse> percorrendo as variações comuns. ABRASF 2.04
 * envia em GerarNfseResposta > ListaNfse > CompNfse > Nfse > InfNfse;
 * outros envelopes (ConsultarNfse, EnviarLoteRpsResposta) seguem
 * estruturas parecidas.
 */
function localizarInfNfse(root) {
    if (!root || typeof root !== "object") return null;
    const candidatos = [
        root?.GerarNfseResposta?.ListaNfse?.CompNfse?.Nfse?.InfNfse,
        root?.ConsultarNfseResposta?.ListaNfse?.CompNfse?.Nfse?.InfNfse,
        root?.ConsultarNfsePorRpsResposta?.CompNfse?.Nfse?.InfNfse,
        root?.EnviarLoteRpsSincronoResposta?.ListaNfse?.CompNfse?.Nfse?.InfNfse,
        root?.ListaNfse?.CompNfse?.Nfse?.InfNfse,
        root?.CompNfse?.Nfse?.InfNfse,
        root?.Nfse?.InfNfse,
        root?.InfNfse,
    ];
    for (const c of candidatos) if (c) return c;
    // Último recurso: procurar InfNfse em qualquer profundidade
    function walk(obj) {
        if (!obj || typeof obj !== "object") return null;
        if (obj.InfNfse) return obj.InfNfse;
        for (const k of Object.keys(obj)) {
            const r = walk(obj[k]);
            if (r) return r;
        }
        return null;
    }
    return walk(root);
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
    if (m) return `${m[3]}/${m[2]}/${m[1]}`;
    const m2 = String(s).match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    return m2 ? s.slice(0, 10) : s;
}

function fmtDataHora(s) {
    if (!s) return "-";
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (m) return `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}`;
    return fmtData(s);
}

function fmtCep(s) {
    const c = String(s || "").replace(/\D/g, "");
    if (c.length === 8) return c.replace(/^(\d{5})(\d{3})$/, "$1-$2");
    return c || "-";
}

function fmtAliquota(v) {
    const n = Number(v);
    if (!isFinite(n) || n === 0) return "-";
    // Alíquota pode vir como 0.03 (3%) ou 3
    const pct = n < 1 ? n * 100 : n;
    return `${pct.toFixed(2)}%`;
}

/**
 * Extrai todos os campos relevantes do XML ABRASF parseado.
 *
 * Estrutura ABRASF v2.04: alguns campos ficam em InfNfse direto
 * (PrestadorServico, ValoresNfse, OrgaoGerador), outros aninhados em
 * DeclaracaoPrestacaoServico > InfDeclaracaoPrestacaoServico (Servico,
 * Prestador.CpfCnpj, TomadorServico, Competencia). Esse merge é
 * necessário pra mapear corretamente os campos do PDF.
 */
function extrairDados(root) {
    const inf = localizarInfNfse(root) || {};
    const decl = inf.DeclaracaoPrestacaoServico?.InfDeclaracaoPrestacaoServico
        || inf.DeclaracaoPrestacaoServico
        || {};

    // PrestadorServico tem razão/endereço/contato; CNPJ + IM ficam em
    // DeclaracaoPrestacaoServico.Prestador.CpfCnpj.Cnpj
    const prestId = decl.Prestador || {};
    const prest = inf.PrestadorServico || decl.Prestador || {};

    // TomadorServico fica DENTRO da declaração na 2.04
    const tom = decl.TomadorServico || inf.TomadorServico || {};
    const serv = decl.Servico || inf.Servico || {};
    // Valores ABRASF: tem ValoresNfse (InfNfse) com totais e Servico.Valores
    // com unitários — usa Servico.Valores como fonte (tem alíquota etc) e
    // recorre a ValoresNfse pra ValorLiquidoNfse/BaseCalculo.
    const val = serv.Valores || {};
    const valNfse = inf.ValoresNfse || {};

    const endPrest = prest.Endereco || {};
    const endTom = tom.Endereco || {};

    return {
        numero: firstOf(inf, "Numero", "NumeroNfse"),
        codigoVerificacao: firstOf(inf, "CodigoVerificacao"),
        dataEmissao: fmtDataHora(firstOf(inf, "DataEmissao")),
        competencia: fmtData(firstOf(decl, "Competencia") || firstOf(inf, "Competencia")),
        prestador: {
            // CNPJ vem da DeclaracaoPrestacaoServico, não do PrestadorServico
            cnpj: fmtCnpjCpf(firstOf(
                prestId, "CpfCnpj.Cnpj", "CpfCnpj.Cpf", "Cnpj", "Cpf",
            ) || firstOf(prest, "IdentificacaoPrestador.Cnpj", "CpfCnpj.Cnpj", "Cnpj")),
            im: firstOf(prestId, "InscricaoMunicipal")
                || firstOf(prest, "IdentificacaoPrestador.InscricaoMunicipal", "InscricaoMunicipal"),
            razao: firstOf(prest, "RazaoSocial"),
            nomeFantasia: firstOf(prest, "NomeFantasia"),
            logradouro: firstOf(endPrest, "Endereco", "Logradouro"),
            numero: firstOf(endPrest, "Numero"),
            complemento: firstOf(endPrest, "Complemento"),
            bairro: firstOf(endPrest, "Bairro"),
            municipio: firstOf(endPrest, "CodigoMunicipio", "Municipio"),
            uf: firstOf(endPrest, "Uf"),
            cep: fmtCep(firstOf(endPrest, "Cep")),
            telefone: firstOf(prest, "Contato.Telefone"),
            email: firstOf(prest, "Contato.Email"),
        },
        tomador: {
            cnpjCpf: fmtCnpjCpf(firstOf(
                tom,
                "IdentificacaoTomador.CpfCnpj.Cnpj",
                "IdentificacaoTomador.CpfCnpj.Cpf",
                "IdentificacaoTomador.Cnpj",
                "IdentificacaoTomador.Cpf",
                "CpfCnpj.Cnpj",
                "CpfCnpj.Cpf",
                "Cnpj",
                "Cpf",
            )),
            im: firstOf(tom, "IdentificacaoTomador.InscricaoMunicipal", "InscricaoMunicipal"),
            razao: firstOf(tom, "RazaoSocial"),
            logradouro: firstOf(endTom, "Endereco", "Logradouro"),
            numero: firstOf(endTom, "Numero"),
            complemento: firstOf(endTom, "Complemento"),
            bairro: firstOf(endTom, "Bairro"),
            municipio: firstOf(endTom, "CodigoMunicipio", "Municipio"),
            uf: firstOf(endTom, "Uf"),
            cep: fmtCep(firstOf(endTom, "Cep")),
            email: firstOf(tom, "Contato.Email", "Email"),
        },
        servico: {
            descricao: firstOf(serv, "Discriminacao"),
            itemLista: firstOf(serv, "ItemListaServico"),
            codigoCnae: firstOf(serv, "CodigoCnae"),
            codigoTribMunicipio: firstOf(serv, "CodigoTributacaoMunicipio"),
            municipioPrestacao: firstOf(serv, "CodigoMunicipio", "MunicipioPrestacaoServico", "MunicipioIncidencia"),
            descricaoCodigoTrib: firstOf(inf, "DescricaoCodigoTributacaoMunicípio", "DescricaoCodigoTributacaoMunicipio"),
        },
        valores: {
            // ValorServicos sempre do Servico.Valores
            servicos: Number(firstOf(val, "ValorServicos")) || 0,
            iss: Number(firstOf(val, "ValorIss")) || Number(firstOf(valNfse, "ValorIss")) || 0,
            issRetido: firstOf(serv, "IssRetido") || firstOf(val, "IssRetido"),
            aliquota: firstOf(val, "Aliquota"),
            // BaseCalculo geralmente em ValoresNfse; cai pra ValorServicos
            baseCalculo: Number(firstOf(valNfse, "BaseCalculo")) || Number(firstOf(val, "BaseCalculo")) || Number(firstOf(val, "ValorServicos")) || 0,
            valorLiquido: Number(firstOf(valNfse, "ValorLiquidoNfse")) || Number(firstOf(val, "ValorLiquidoNfse")) || Number(firstOf(val, "ValorServicos")) || 0,
            pis: Number(firstOf(val, "ValorPis")) || 0,
            cofins: Number(firstOf(val, "ValorCofins")) || 0,
            inss: Number(firstOf(val, "ValorInss")) || 0,
            ir: Number(firstOf(val, "ValorIr")) || 0,
            csll: Number(firstOf(val, "ValorCsll")) || 0,
            deducoes: Number(firstOf(val, "ValorDeducoes")) || 0,
            outras: Number(firstOf(val, "OutrasRetencoes")) || 0,
        },
        orgaoGerador: {
            municipio: firstOf(inf, "OrgaoGerador.CodigoMunicipio"),
            uf: firstOf(inf, "OrgaoGerador.Uf"),
        },
        rps: {
            numero: firstOf(decl, "Rps.IdentificacaoRps.Numero"),
            serie: firstOf(decl, "Rps.IdentificacaoRps.Serie"),
        },
        outrasInformacoes: firstOf(inf, "OutrasInformacoes"),
        optanteSimples: firstOf(decl, "OptanteSimplesNacional") === "1" ? "Sim" : "Não",
    };
}

/**
 * Gera PDF DANFSe ABRASF e retorna Buffer.
 */
export async function gerarDanfseAbrasf(xmlString) {
    const root = parser.parse(xmlString);
    const d = extrairDados(root);

    return await new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: "A4", margin: 30 });
            const chunks = [];
            doc.on("data", (c) => chunks.push(c));
            doc.on("end", () => resolve(Buffer.concat(chunks)));
            doc.on("error", reject);

            const pageW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
            const left = doc.page.margins.left;

            // ── Cabeçalho ─────────────────────────────────────────────
            doc.rect(left, doc.y, pageW, 60).stroke();
            const headY = doc.y;
            doc.fontSize(11).font("Helvetica-Bold").fillColor("#000")
                .text("PREFEITURA MUNICIPAL", left + 8, headY + 8, { width: pageW - 16, align: "center" });
            doc.fontSize(13).font("Helvetica-Bold")
                .text("NOTA FISCAL DE SERVIÇOS ELETRÔNICA — NFS-e", left + 8, headY + 25, { width: pageW - 16, align: "center" });
            doc.fontSize(8).font("Helvetica")
                .text("Documento Auxiliar — Verifique a autenticidade no portal da prefeitura",
                    left + 8, headY + 45, { width: pageW - 16, align: "center" });
            doc.y = headY + 65;

            // ── Identificação da NFS-e ────────────────────────────────
            caixaTopo(doc, left, pageW, [
                { label: "NÚMERO DA NFS-e", valor: d.numero || "-", w: 0.20, big: true },
                { label: "CÓDIGO DE VERIFICAÇÃO", valor: d.codigoVerificacao || "-", w: 0.27 },
                { label: "DATA E HORA DE EMISSÃO", valor: d.dataEmissao || "-", w: 0.27 },
                { label: "COMPETÊNCIA", valor: d.competencia || "-", w: 0.26 },
            ]);

            // ── RPS + Simples Nacional ────────────────────────────────
            caixa(doc, left, pageW, [
                [
                    { label: "Nº RPS", valor: d.rps.numero || "-", w: 0.25 },
                    { label: "SÉRIE RPS", valor: d.rps.serie || "-", w: 0.25 },
                    { label: "OPTANTE SIMPLES NACIONAL", valor: d.optanteSimples, w: 0.5 },
                ],
            ]);

            // ── Prestador ─────────────────────────────────────────────
            secaoTitulo(doc, left, pageW, "PRESTADOR DOS SERVIÇOS");
            caixa(doc, left, pageW, [
                [{ label: "CPF/CNPJ", valor: d.prestador.cnpj, w: 0.5 }, { label: "INSCRIÇÃO MUNICIPAL", valor: d.prestador.im || "-", w: 0.5 }],
                [{ label: "NOME / RAZÃO SOCIAL", valor: d.prestador.razao || "-", w: 1 }],
                d.prestador.nomeFantasia ? [{ label: "NOME FANTASIA", valor: d.prestador.nomeFantasia, w: 1 }] : null,
                [{ label: "ENDEREÇO", valor: montarEndereco(d.prestador), w: 1 }],
                [
                    { label: "MUNICÍPIO", valor: d.prestador.municipio || "-", w: 0.4 },
                    { label: "UF", valor: d.prestador.uf || "-", w: 0.15 },
                    { label: "CEP", valor: d.prestador.cep, w: 0.25 },
                    { label: "TELEFONE", valor: d.prestador.telefone || "-", w: 0.2 },
                ],
                d.prestador.email ? [{ label: "E-MAIL", valor: d.prestador.email, w: 1 }] : null,
            ].filter(Boolean));

            // ── Tomador ───────────────────────────────────────────────
            secaoTitulo(doc, left, pageW, "TOMADOR DOS SERVIÇOS");
            caixa(doc, left, pageW, [
                [{ label: "CPF/CNPJ", valor: d.tomador.cnpjCpf, w: 0.5 }, { label: "INSCRIÇÃO MUNICIPAL", valor: d.tomador.im || "-", w: 0.5 }],
                [{ label: "NOME / RAZÃO SOCIAL", valor: d.tomador.razao || "-", w: 1 }],
                [{ label: "ENDEREÇO", valor: montarEndereco(d.tomador), w: 1 }],
                [
                    { label: "MUNICÍPIO", valor: d.tomador.municipio || "-", w: 0.4 },
                    { label: "UF", valor: d.tomador.uf || "-", w: 0.15 },
                    { label: "CEP", valor: d.tomador.cep, w: 0.45 },
                ],
                d.tomador.email ? [{ label: "E-MAIL", valor: d.tomador.email, w: 1 }] : null,
            ].filter(Boolean));

            // ── Discriminação ─────────────────────────────────────────
            secaoTitulo(doc, left, pageW, "DISCRIMINAÇÃO DOS SERVIÇOS");
            const descTexto = d.servico.descricao || "-";
            const descLines = doc.heightOfString(descTexto, { width: pageW - 16, fontSize: 10 });
            const descBoxH = Math.max(36, descLines + 14);
            doc.rect(left, doc.y, pageW, descBoxH).stroke();
            doc.fontSize(10).font("Helvetica").fillColor("#000")
                .text(descTexto, left + 8, doc.y + 7, { width: pageW - 16 });
            doc.y = doc.y + descBoxH - descLines - 7 + descBoxH; // ajusta cursor

            caixa(doc, left, pageW, [
                [
                    { label: "CÓDIGO LC 116", valor: d.servico.itemLista || "-", w: 0.25 },
                    { label: "CÓD. TRIBUTAÇÃO MUNICÍPIO", valor: d.servico.codigoTribMunicipio || "-", w: 0.35 },
                    { label: "CNAE", valor: d.servico.codigoCnae || "-", w: 0.20 },
                    { label: "MUNICÍPIO PRESTAÇÃO", valor: d.servico.municipioPrestacao || "-", w: 0.20 },
                ],
            ]);

            // ── Valores ───────────────────────────────────────────────
            secaoTitulo(doc, left, pageW, "VALORES");
            caixa(doc, left, pageW, [
                [
                    { label: "VALOR DOS SERVIÇOS", valor: fmtMoeda(d.valores.servicos), w: 0.25, destaque: true },
                    { label: "BASE DE CÁLCULO", valor: fmtMoeda(d.valores.baseCalculo || d.valores.servicos), w: 0.25 },
                    { label: "ALÍQUOTA", valor: fmtAliquota(d.valores.aliquota), w: 0.20 },
                    { label: "VALOR DO ISS", valor: fmtMoeda(d.valores.iss), w: 0.30 },
                ],
                [
                    { label: "DEDUÇÕES", valor: fmtMoeda(d.valores.deducoes), w: 0.25 },
                    { label: "OUTRAS RETENÇÕES", valor: fmtMoeda(d.valores.outras), w: 0.25 },
                    { label: "ISS RETIDO", valor: String(d.valores.issRetido) === "1" ? "SIM" : "NÃO", w: 0.20 },
                    { label: "VALOR LÍQUIDO", valor: fmtMoeda(d.valores.valorLiquido), w: 0.30, destaque: true },
                ],
            ]);

            // ── Retenções federais (se houver) ────────────────────────
            const temRet = (d.valores.pis + d.valores.cofins + d.valores.inss + d.valores.ir + d.valores.csll) > 0;
            if (temRet) {
                secaoTitulo(doc, left, pageW, "RETENÇÕES FEDERAIS");
                caixa(doc, left, pageW, [
                    [
                        { label: "PIS", valor: fmtMoeda(d.valores.pis), w: 0.2 },
                        { label: "COFINS", valor: fmtMoeda(d.valores.cofins), w: 0.2 },
                        { label: "INSS", valor: fmtMoeda(d.valores.inss), w: 0.2 },
                        { label: "IR", valor: fmtMoeda(d.valores.ir), w: 0.2 },
                        { label: "CSLL", valor: fmtMoeda(d.valores.csll), w: 0.2 },
                    ],
                ]);
            }

            // ── Outras informações ────────────────────────────────────
            if (d.outrasInformacoes && d.outrasInformacoes.trim()) {
                secaoTitulo(doc, left, pageW, "OUTRAS INFORMAÇÕES");
                const texto = d.outrasInformacoes.replace(/\\s\\n/g, "\n").replace(/&#x[0-9A-F]+;/g, "");
                const h = doc.heightOfString(texto, { width: pageW - 16, fontSize: 9 });
                doc.rect(left, doc.y, pageW, h + 12).stroke();
                doc.fontSize(9).font("Helvetica").fillColor("#000")
                    .text(texto, left + 8, doc.y + 6, { width: pageW - 16 });
                doc.y += h + 14;
            }

            // ── Rodapé ────────────────────────────────────────────────
            doc.moveDown(0.8);
            doc.fontSize(7).font("Helvetica-Oblique").fillColor("#666")
                .text(`Código de verificação: ${d.codigoVerificacao || "-"}`,
                    left, doc.y, { width: pageW, align: "center" });
            doc.text("Gerado por PacNoBolso — pacnobolso.com.br",
                left, doc.y + 2, { width: pageW, align: "center" });

            doc.end();
        } catch (err) {
            reject(err);
        }
    });
}

function montarEndereco(p) {
    const partes = [p.logradouro, p.numero, p.complemento, p.bairro].filter((x) => x && String(x).trim());
    return partes.length ? partes.join(", ") : "-";
}

function secaoTitulo(doc, left, pageW, titulo) {
    doc.moveDown(0.3);
    doc.fillColor("#000").fontSize(8).font("Helvetica-Bold")
        .text(titulo, left + 4, doc.y, { width: pageW - 8 });
    doc.moveDown(0.1);
}

function caixaTopo(doc, left, pageW, campos) {
    const h = 38;
    const y = doc.y;
    doc.rect(left, y, pageW, h).stroke();
    let x = left;
    campos.forEach((c, i) => {
        const w = pageW * c.w;
        if (i > 0) doc.moveTo(x, y).lineTo(x, y + h).stroke();
        doc.fontSize(7).font("Helvetica-Bold").fillColor("#555")
            .text(c.label, x + 4, y + 4, { width: w - 8 });
        doc.fontSize(c.big ? 14 : 10).font(c.big ? "Helvetica-Bold" : "Helvetica").fillColor("#000")
            .text(c.valor, x + 4, y + 16, { width: w - 8 });
        x += w;
    });
    doc.y = y + h + 2;
}

function caixa(doc, left, pageW, linhas) {
    const padY = 4;
    let y = doc.y;
    const linhasH = linhas.map((linha) => {
        let max = 0;
        for (const c of linha) {
            const w = pageW * c.w - 8;
            const valor = String(c.valor || "-");
            const h = doc.heightOfString(valor, { width: w, fontSize: c.destaque ? 11 : 10 });
            max = Math.max(max, h);
        }
        return max + 18; // label + valor + padding
    });
    const totalH = linhasH.reduce((a, b) => a + b, 0);
    doc.rect(left, y, pageW, totalH).stroke();

    let curY = y;
    linhas.forEach((linha, li) => {
        let x = left;
        if (li > 0) doc.moveTo(left, curY).lineTo(left + pageW, curY).stroke();
        linha.forEach((c, ci) => {
            const w = pageW * c.w;
            if (ci > 0) doc.moveTo(x, curY).lineTo(x, curY + linhasH[li]).stroke();
            doc.fontSize(7).font("Helvetica-Bold").fillColor("#555")
                .text(c.label, x + 4, curY + 3, { width: w - 8 });
            doc.fontSize(c.destaque ? 11 : 10).font(c.destaque ? "Helvetica-Bold" : "Helvetica").fillColor("#000")
                .text(String(c.valor || "-"), x + 4, curY + 13, { width: w - 8 });
            x += w;
        });
        curY += linhasH[li];
    });
    doc.y = y + totalH + padY;
}
