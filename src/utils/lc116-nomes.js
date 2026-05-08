/**
 * src/utils/lc116-nomes.js
 * Mapa código → nome legível dos itens da LC 116/2003.
 * Cobre ~60 códigos mais usados na prática. Migrar pra `tabela_lc116` no
 * Supabase quando a integração rodar (ver project_pendencias_agent_nfse).
 */

export const LC116_NOMES = {
    // 1 — Tecnologia da informação
    "1.01": "Análise e desenvolvimento de sistemas",
    "1.02": "Programação",
    "1.03": "Processamento, armazenamento ou hospedagem de dados",
    "1.04": "Elaboração de programas de computador",
    "1.05": "Licenciamento ou cessão de direito de uso de software",
    "1.06": "Assessoria e consultoria em informática",
    "1.07": "Suporte técnico em informática (instalação, configuração, manutenção)",
    "1.08": "Manutenção e atualização de páginas eletrônicas",
    "1.09": "Disponibilização de conteúdo de áudio, vídeo, imagem ou texto",

    // 5 — Saúde
    "5.01": "Medicina e biomedicina",
    "5.02": "Análises clínicas, patologia, radioterapia, quimioterapia",
    "5.03": "Hospitais, clínicas, laboratórios e sanatórios",
    "5.04": "Instrumentação cirúrgica",
    "5.05": "Acupuntura",
    "5.06": "Enfermagem",
    "5.07": "Serviços farmacêuticos",
    "5.08": "Fisioterapia, fonoaudiologia e terapia ocupacional",
    "5.09": "Terapias de tratamento físico, orgânico ou mental",

    // 6 — Cuidados pessoais e estética
    "6.01": "Barbearia, cabeleireiros, manicuros e pedicuros",
    "6.02": "Estética, tratamento de pele e depilação",
    "6.03": "Banhos, duchas, sauna e massagens",
    "6.04": "Ginástica, dança, esportes e atividades físicas",
    "6.05": "Centros de emagrecimento e spa",

    // 7 — Engenharia, construção e serviços prediais
    "7.01": "Engenharia, arquitetura, agronomia, urbanismo e paisagismo",
    "7.02": "Execução de obras de construção civil (empreitada/subempreitada)",
    "7.03": "Planejamento, estudos de viabilidade e organização técnica",
    "7.04": "Demolição",
    "7.05": "Reparação, conservação e reforma de edifícios e estradas",
    "7.06": "Colocação de tapetes, carpetes, assoalhos e cortinas",
    "7.07": "Recuperação, raspagem, polimento e lustração de pisos",
    "7.09": "Coleta, remoção, incineração e tratamento de resíduos",
    "7.10": "Limpeza, manutenção e conservação de vias e imóveis",
    "7.11": "Decoração, jardinagem, corte e poda de árvores",
    "7.13": "Dedetização, desinsetização, desratização e higienização",

    // 9 — Hospedagem e turismo
    "9.01": "Hospedagem em hotéis, pousadas e similares",
    "9.02": "Agenciamento e organização de programas de turismo",
    "9.03": "Guias de turismo",

    // 10 — Agenciamento, corretagem e intermediação
    "10.02": "Corretagem ou intermediação de títulos em geral",
    "10.05": "Corretagem ou intermediação de bens móveis ou imóveis",
    "10.08": "Agenciamento de publicidade e propaganda",
    "10.09": "Representação comercial e congêneres",

    // 12 — Lazer, cultura e diversões
    "12.07": "Shows, ballet, danças, óperas, recitais e concertos",
    "12.13": "Produção de eventos, espetáculos e festivais",

    // 13 — Fotografia, gráfica e cinematografia
    "13.03": "Fotografia e cinematografia",
    "13.04": "Reprografia, microfilmagem e digitalização",
    "13.05": "Composição gráfica, fotolitografia e impressão",

    // 14 — Manutenção e reparo
    "14.01": "Manutenção, conservação e reparo de máquinas, veículos e equipamentos",
    "14.02": "Assistência técnica",
    "14.03": "Recondicionamento de motores",
    "14.04": "Recauchutagem ou regeneração de pneus",
    "14.05": "Pintura, beneficiamento, lavagem e galvanoplastia",
    "14.06": "Instalação e montagem de aparelhos, máquinas e equipamentos",
    "14.09": "Alfaiataria e costura (material do cliente)",
    "14.10": "Tinturaria e lavanderia",
    "14.11": "Tapeçaria e reforma de estofamentos",
    "14.12": "Funilaria e lanternagem",
    "14.13": "Carpintaria e serralheria",

    // 17 — Serviços profissionais e administrativos
    "17.01": "Assessoria ou consultoria",
    "17.03": "Planejamento, coordenação e organização técnica/administrativa",
    "17.04": "Recrutamento, seleção e colocação de mão-de-obra",
    "17.05": "Fornecimento de mão-de-obra",
    "17.06": "Propaganda, publicidade e planejamento de campanhas",
    "17.09": "Perícias, laudos e análises técnicas",
    "17.10": "Organização de feiras, exposições e congressos",
    "17.11": "Organização de festas, recepções e bufê",
    "17.12": "Administração de bens e negócios de terceiros",
    "17.14": "Advocacia",
    "17.16": "Auditoria",
    "17.19": "Contabilidade",
    "17.20": "Consultoria econômica ou financeira",
    "17.22": "Cobrança em geral",
    "17.24": "Palestras, conferências e seminários",
};

/**
 * Normaliza o código LC 116 pra chave da tabela.
 *  "14.01"   → "14.01"
 *  "1401"    → "14.01"
 *  "140101"  → "14.01" (formato cServTribNac pós-Reforma — pega item.subitem)
 *  "1.01"    → "1.01"
 *  "101"     → "1.01"
 */
export function normalizarCodigoLc(cod) {
    const s = String(cod || "").trim();
    if (/^\d{1,2}\.\d{2}$/.test(s)) return s;
    const d = s.replace(/\D/g, "");
    if (d.length >= 4) return `${d.slice(0, 2)}.${d.slice(2, 4)}`;
    if (d.length === 3) return `${d.slice(0, 1)}.${d.slice(1, 3)}`;
    return s;
}

export function nomeLc116(cod) {
    if (!cod) return null;
    return LC116_NOMES[normalizarCodigoLc(cod)] || null;
}
