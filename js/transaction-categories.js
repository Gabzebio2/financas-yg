/* Classifica somente a categoria de uma operação já identificada. */
"use strict";
const TransactionCategories = (() => {
  const normalize = value => typeof value === "string"
    ? value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim() : "";
  const words = value => normalize(value).replace(/[^a-z0-9]+/g, " ").trim();
  // Um aviso misto também pode indicar falha de leitura. Só dispense
  // frases cujo conteúdo inteiro trate da classificação.
  const warningWords = new Set(("a as o os de da do das dos e em na no uma um sua se por para que " +
    "categoria categorias classificacao rubrica sugerida sugestao sugerido informada indicada " +
    "incerta incerto duvida ambigua ambiguo indefinida indefinido desconhecida desconhecido " +
    "revisar revise revisao confira conferir verifique verificar confirme confirmar precisa " +
    "esta foi nao identificada identificado encontrada encontrado reconhecida reconhecido " +
    "confianca baixa sem correspondencia fora lista disponivel permitidas permitidos permitida " +
    "pasta outros ia modelo possivel foi determinar identificar classificar automaticamente").split(" "));
  function isCategoryOnlyWarning(reason) {
    const tokens = words(reason).split(" ");
    return tokens.some(word => /^(categorias?|classificacao)$/.test(word)) &&
      tokens.every(word => warningWords.has(word));
  }
  const descOf = tx => tx.desc || tx.descricao || tx.description || "";
  function typeOf(tx) {
    const value = normalize(tx.type || tx.tipo || tx.direcao);
    if (["receita", "recebido", "recebida", "income", "entrada"].includes(value)) return "receita";
    if (["despesa", "enviado", "enviada", "expense", "saida"].includes(value)) return "despesa";
    return "";
  }

  // A correspondência usa a descrição daquela linha. Rodapés, saldos e linhas
  // vizinhas de um extrato podem citar outros estabelecimentos.
  function merchantCategory(name) {
    if (/\b(?:ferrex|feria (?:de )?asuncion)\b/.test(name)) return "Essencial";
    if (/\b(?:farmacias?|drogarias?|farmaceutic[oa]s?|medicamentos?|remedios?|convenios?|seguro (?:de )?(?:saude|salud)|plan(?:o)? de (?:saude|salud)|posto de saude|hospita(?:l|is)|clinicas?|laboratori[oa]s?|odontolog\w*|dentist[ae]s?|drogasil|drogao|drogaraia|droga raia|neofarma|farmacenter|punto farma|unimed)\b/.test(name)) return "Saúde";
    if (/\b(?:postos? (?:de (?:combustivel|combustiveis|gasolina)|shell|ipiranga|petrobras)|auto postos?|gasoliner[ao]s?|gasolina|abasteciment[oa]|estacion(?:es)? de servicios?|combustive(?:l|is)|combustibles?|comercio de combu|pedagio|peaje|uber (?:trip|viagem)|taxi)\b/.test(name)) return "Transporte";
    // Processadores de pagamento e marketplaces podem aparecer ao lado do
    // nome de qualquer loja e, sozinhos, não indicam compra de supermercado.
    const merchant = name.replace(/\bmercado(?:\s*(?:pagos?|livre|libre)| de (?:acoes|capitais|cambio)| financeiro)\b/g, " ");
    if (/\b(?:super\s?mercados?|hiper\s?mercados?|mercados?|mercearias?|hortifruti|verdulerias?|carnicerias?|acougues?|superseis|super seis|stock supermercado)\b/.test(merchant)) return "Mercado";
    if (/\bpague menos \d+\b/.test(name)) return "Saúde";
    if (/\b(?:hotel(?:es)?|hoteis|pousada|hospedagem|hospedaje|airbnb|passagem aerea|pasaje aereo)\b/.test(name)) return "Viagem";
    if (/\b(?:praias?|playas?|lazer|cinemas?|cine|ingressos?|passeios?|parque (?:aquatico|de diversoes)|balnearios?)\b/.test(name)) return "Lazer";
    return "";
  }

  const genericWords = new Set(("pix spi ted doc pagamento pago pagto compra transferencia transferenc deposito credito debito mercado pago " +
    "cartao tarjeta conta cuentas pos qr interna online dinheiro valor en em de da do del la na no por via a " +
    "enviada enviado recebida recebido efectuada efetuada efetuado realizada realizado hecha").split(" "));
  function historyKey(tx) {
    const type = typeOf(tx);
    const desc = normalize(descOf(tx)).replace(/\s*[-–(]?\s*(?:parcela|cuota|parc\.?)\s*\d+\s*\/\s*\d+\)?$/i, "");
    const merchant = words(desc.replace(/^(?:mp|mercado\s?pago|pagseguro)\s*\*\s*/i, ""));
    // Uma descrição genérica de adquirente ou banco não identifica o
    // recebedor. Uma escolha feita para um Pix não deve valer para todos.
    if (!type || merchant.length < 3 || merchant.split(" ").every(word => /^\d+$/.test(word) || genericWords.has(word))) return "";
    return type + "|" + merchant;
  }
  function buildHistory(transactions) {
    const history = new Map();
    for (const tx of transactions || []) {
      if (!tx || typeof tx.category !== "string" || !tx.category.trim()) continue;
      const key = historyKey(tx);
      if (!key) continue;
      const manual = tx.categoryEdited === true || tx.categorySource === "user";
      if (!manual && normalize(tx.category) === "outros") continue;
      let entry = history.get(key);
      if (!entry) {
        entry = {manual:new Set(), previous:new Set()};
        history.set(key, entry);
      }
      (manual ? entry.manual : entry.previous).add(normalize(tx.category));
    }
    return history;
  }

  const refund = /\b(?:estornos?|reembolsos?|chargebacks?|devolucio(?:n|nes)|devoluc(?:ao|oes)|revers(?:ao|ion)|reintegros?)\b/;
  const cardPayment = /\b(?:inclusao de (?:pagamento|pagto)|(?:pagamento|pagto|liquidacao|pago) (?:de |da |de la )?(?:fatura|factura|tarjeta))\b/;
  const internal = /\b(?:entre (?:minhas |mis |as )?contas|entre (?:mis )?cuentas|(?:transferencia|transfer|pix) (?:interna|interno|entre contas|para (?:conta|cuenta) (?:propria|propia)))\b/;
  const isIncomeLabel = category => ["receita","salario"].includes(normalize(category));
  const expenseLabels = new Set(["mercado","saude","transporte","lazer","essencial","viagem","moradia"]);
  function classify(tx = {}, {categories = [], preferred = "", suggested = "", history} = {}) {
    const names = new Map();
    for (const value of categories) {
      const label = typeof value === "string" ? value : value?.name;
      if (typeof label === "string" && label.trim()) names.set(normalize(label), label);
    }
    const allowed = label => {
      const key = normalize(label);
      if (key === "salario" && names.has("receita")) return names.get("receita");
      return names.get(key) || "";
    };
    const explicit = allowed(preferred);
    if (explicit) return explicit;
    const type = typeOf(tx), description = descOf(tx), name = words(description);
    const entry = history?.get(historyKey(tx));
    const unique = labels => labels?.size === 1 ? allowed(labels.values().next().value) : "";
    const manual = unique(entry?.manual);
    if (manual) return manual;
    const other = allowed("Outros") || "Outros";
    const suggestion = allowed(suggested);
    const previous = unique(entry?.previous);
    if (type === "receita" && (tx.creditKind === "card_payment" || tx.c6Section === "card_payment" || cardPayment.test(name))) {
      return allowed("Fatura") || allowed("Cartão de crédito") || other;
    }
    if (internal.test(name)) return allowed("Transferências") || other;
    if (/\bcash\s?back\b/.test(name) && type === "receita" && !/\b(?:resgat\w*|rescate|canje\w*|retir\w*)\b/.test(name)) return allowed("Cashback") || other;
    const isRefund = refund.test(name);
    if (type === "receita" && !isRefund) {
      // Permite rubricas de recebimento já utilizadas na mesma pasta (por
      // exemplo, a conta de um cliente no painel empresarial).
      if (previous && !expenseLabels.has(normalize(previous))) return previous;
      return allowed("Receita") || suggestion || other;
    }
    const specific = allowed(merchantCategory(name));
    if (specific) return specific;
    if (previous && !isIncomeLabel(previous)) return previous;
    if (normalize(suggestion) === "mercado" && /^mercado\s*(?:pago|livre|libre)$/.test(name)) return other;
    if (suggestion && !isIncomeLabel(suggestion)) return suggestion;
    return other;
  }

  const prompt = "Para a categoria, use o estabelecimento e a finalidade econômica da operação. Supermercados, mercearias e compras de alimentos em mercado são Mercado. Praia, playa e passeios costumam ser Lazer. Farmácias, remédios, convênios e planos de saúde são Saúde. Postos de gasolina e abastecimento são Transporte. Ferrex e Feria Asunción são Essencial. Para um recebimento efetivo na conta, prefira Receita. Estorno, cashback acumulado, pagamento da própria fatura e transferência entre contas próprias têm tratamento distinto de um novo ganho. Um intermediador como Mercado Pago pode processar pagamentos a qualquer estabelecimento. Havendo evidência, use também outras categorias pertinentes disponíveis na pasta. Preserve a direção original da operação.";
  return {classify, buildHistory, isCategoryOnlyWarning, prompt};
})();
if (typeof module !== "undefined" && module.exports) module.exports = TransactionCategories;
else if (typeof globalThis !== "undefined") globalThis.TransactionCategories = TransactionCategories;
