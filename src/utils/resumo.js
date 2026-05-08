/**
 * src/utils/resumo.js
 * Monta o resumo final que vai pro WhatsApp do cliente confirmar antes da emissão.
 *
 * Único ponto de auditoria do fluxo (modo auto, sem aprovação admin), então
 * precisa ter todos os campos relevantes em linguagem humana — sem códigos
 * técnicos da Reforma Tributária (cClassTrib, cIndOp, etc).
 */
import { formatarCpf } from "./cpf.js";
import { nomeLc116, normalizarCodigoLc } from "./lc116-nomes.js";

function formatarCnpj(cnpj) {
    const d = String(cnpj || "").replace(/\D/g, "");
    if (d.length !== 14) return String(cnpj || "");
    return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

function formatarCep(cep) {
    const d = String(cep || "").replace(/\D/g, "");
    if (d.length !== 8) return String(cep || "");
    return `${d.slice(0, 5)}-${d.slice(5)}`;
}

function formatarReal(valor) {
    const n = Number(valor);
    if (!Number.isFinite(n)) return "R$ —";
    return `R$ ${n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatarData(iso) {
    const s = String(iso || "");
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
}

function rotuloAmbiente() {
    const amb = (process.env.EPN_AMBIENTE || "homologacao").toLowerCase();
    return amb === "producao" ? "PRODUÇÃO" : "HOMOLOGAÇÃO (teste)";
}

function blocoTomador(tomador) {
    if (!tomador) return ["(tomador não informado)"];
    const linhas = [];
    if (tomador.razao_social) linhas.push(tomador.razao_social);

    if (tomador.documento) {
        const d = String(tomador.documento).replace(/\D/g, "");
        if (tomador.tipo === "PJ" || d.length === 14) {
            linhas.push(`CNPJ ${formatarCnpj(d)}`);
        } else {
            linhas.push(`CPF ${formatarCpf(d)}`);
        }
    }

    const e = tomador.endereco;
    if (e) {
        const ruaPartes = [e.logradouro, e.numero].filter(Boolean).join(", ");
        const compl = e.complemento ? ` — ${e.complemento}` : "";
        if (ruaPartes) linhas.push(`${ruaPartes}${compl}`);
        const localPartes = [];
        if (e.bairro) localPartes.push(e.bairro);
        const cidadeUf = [e.municipio, e.uf].filter(Boolean).join("/");
        if (cidadeUf) localPartes.push(cidadeUf);
        const cep = e.cep ? `CEP ${formatarCep(e.cep)}` : null;
        const segundaLinha = [localPartes.join(", "), cep].filter(Boolean).join(" — ");
        if (segundaLinha) linhas.push(segundaLinha);
    }

    return linhas;
}

function blocoServico(servico, competencia) {
    const linhas = [];
    if (servico?.descricao) linhas.push(servico.descricao);

    if (servico?.codigo_lc116) {
        const codChave = normalizarCodigoLc(servico.codigo_lc116);
        const nome = nomeLc116(servico.codigo_lc116);
        const sufixo = nome ? ` — ${nome}` : "";
        linhas.push(`Categoria: ${codChave}${sufixo}`);
    }

    if (servico?.valor_total != null) {
        linhas.push(`Valor: ${formatarReal(servico.valor_total)}`);
    }

    if (competencia) {
        linhas.push(`Competência: ${formatarData(competencia)}`);
    }

    return linhas;
}

/**
 * Formata o resumo final pro cliente confirmar antes da emissão.
 * @param {Object} extracao  - resultado do extractor (já enriquecido com BrasilAPI/ViaCEP)
 * @param {Object} empresa   - row da tabela `empresas`
 * @returns {string} texto pronto pra enviarTexto()
 */
export function formatarResumoCliente(extracao, empresa) {
    const partes = [
        "📋 *Confirme antes de emitir*",
        "",
        `*Prestador:* ${empresa?.razao_social || "—"}`,
        `*Ambiente:* ${rotuloAmbiente()}`,
        "",
        "*Tomador*",
        ...blocoTomador(extracao?.tomador),
        "",
        "*Serviço*",
        ...blocoServico(extracao?.servico, extracao?.competencia),
    ];

    if (extracao?.observacoes) {
        partes.push("", `_Obs: ${extracao.observacoes}_`);
    }

    partes.push("", "Responda *SIM* pra emitir ou *CANCELA* pra desistir.");
    return partes.join("\n");
}
