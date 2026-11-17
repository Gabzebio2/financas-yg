/* ===== Finanças YG — painel: resumo, gráficos, tabela, edição, limites ===== */
"use strict";

const Dashboard = (() => {
  let ds = null; // dataset aberto
  let groupedC6Ids = new Set();
  const legacyBillOrigins = new Map();
  function refreshBillOrigins() {
    const origins = legacyBillReferenceOrigins(ds.transactions);
    legacyBillOrigins.clear();
    if (!origins.size) return;
    for (const t of ds.transactions) {
      const origin = origins.get(t.id);
      if (origin) legacyBillOrigins.set(t.id, {origin, desc:t.desc, groupId:t.groupId, account:t.account});
    }
  }
  function legacyBillOrigin(t) {
    const saved = legacyBillOrigins.get(t.id);
    return saved && saved.desc === t.desc && saved.groupId === t.groupId && saved.account === t.account
      ? saved.origin : undefined;
  }
  function resolvedBillMonth(t) { return billReferenceMonth(t, legacyBillOrigin(t)); }
  function pendingIndividualBill(t) { return isPendingBill(t) && !groupedC6Ids.has(t.id); }
  function reportDate(t) { return groupedC6Ids.has(t.id) ? accountingDate(t) : expenseReportDate(t, legacyBillOrigin(t)); }
  let fil = { mode: "month", month: null, from: "", to: "", cats: null, search: "", type: "all", account: "all" };
  let receiptFilter = null;
  let sort = { key: "date", dir: -1 };
  let rowLimit = 100;
  let originPage = 0, originGroups = [];
  const charts = {};
  let editingId = null;
  let txDateEdited = false;
  let txCategoryChosen = false;
  let txCategoryHistory = null;
  let txInitialCategory = "";
  let receiptRead = null;
  let txModalRevision = 0;
  let editingLimitId = null;
  let pendingAdvance = null;
  let pendingParcTx = null; // transação parcelada aguardando escolha de exclusão
  const selectedTx = new Set(); // ids das transações marcadas (seleção em lote)

  const FIXA_MESES = 12; // quantos meses uma despesa fixa gera
  let ratesHooked = false; // registra o ouvinte de cotação uma única vez

  const UI_ICON_PATHS = {
    calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v5m10-5v5M3 11h18m-13 5h3"/>',
    history: '<path d="M3 11a9 9 0 1 1 2 7M3 5v6h6m3-4v5l3 2"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    advance: '<path d="m4 5 7 7-7 7V5Zm9 0 7 7-7 7V5Z"/>',
    edit: '<path d="m15 5 4 4M4 20l4.5-1 11-11a2.8 2.8 0 0 0-4-4l-11 11L4 20Z"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5"/>',
    target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    people: '<path d="M3 20v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2M17 14a4 4 0 0 1 4 4v2"/><circle cx="9" cy="6" r="3"/><path d="M16 3a3 3 0 0 1 0 6"/>',
    person: '<circle cx="12" cy="7" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
    business: '<rect x="3" y="7" width="18" height="14" rx="2"/><path d="M8 7V3h8v4M3 12h18M10 12v3h4v-3"/>',
    home: '<path d="m3 10 9-7 9 7M5 9v12h14V9M9 21v-8h6v8"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    file: '<path d="M14 3H5v18h14V8l-5-5ZM14 3v5h5M8 12h8M8 16h5"/>',
  };

  function uiIcon(name, size = 18) {
    return `<svg class="ui-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" style="display:inline-block;vertical-align:-3px;flex-shrink:0">${UI_ICON_PATHS[name] || UI_ICON_PATHS.target}</svg>`;
  }

  /* ---------- Moeda de exibição ----------
     Cada transação guarda a moeda em que foi lançada (t.currency). O painel
     converte os totais para a moeda do painel (no padrão: USD para PJ e PYG para PF).
     A lista de lançamentos sempre preserva a moeda e o valor originais. */
  function defaultPanelCurrency() { return ds?.profile === "pj" ? "USD" : "PYG"; }
  function isDefaultMode() { return normDisplayCur(ds?.displayCurrency, ds?.profile) === "DEFAULT"; }
  function dispCur() { return isDefaultMode() ? defaultPanelCurrency() : normCur(ds && ds.displayCurrency); }
  function entryCur() {
    if (!isDefaultMode()) return dispCur();
    if (ds?.profile === "pj") return "USD";
    try {
      const remembered = localStorage.getItem("fyg:entry-currency:" + ds.id);
      if (CURRENCY_CODES.includes(remembered)) return remembered;
    } catch { /* preferência opcional */ }
    return "BRL";
  }
  function convertAmount(amount, from, to) {
    if (!Number.isFinite(Number(amount)) || !Rates.ready(normCur(from), normCur(to))) return NaN;
    const value = Rates.convert(amount, normCur(from), normCur(to));
    return Number.isFinite(value) ? value : NaN;
  }
  function dispAmount(t) { return convertAmount(t.amount, t.currency, dispCur()); }
  function txDisplayCurrency(t) { return normCur(t.currency); }
  function txDisplayAmount(t) { return Number(t.amount); }
  function fmtD(v) { return Number.isFinite(v) ? fmtMoney(v, dispCur()) : "—"; }
  function fmtTxAmount(t) {
    const value = txDisplayAmount(t);
    const currency = txDisplayCurrency(t);
    if (!Number.isFinite(value)) return "—";
    const formatted = fmtMoney(value, currency);
    return !formatted.includes(currency) ? `${formatted} · ${currency}` : formatted;
  }

  function renderCurrencyWarning() {
    const pending = ds.transactions.some((t) => !pendingIndividualBill(t) && !Number.isFinite(dispAmount(t))) ||
      ds.limits.some((l) => !Rates.ready(normCur(l.currency), dispCur())) ||
      ds.metas.some((m) => !m.category && !Rates.ready(normCur(m.currency), dispCur()));
    ["#currency-warning", "#tx-currency-warning"].forEach((id) => {
      const warning = $(id);
      if (!warning) return;
      warning.classList.toggle("hidden", !pending);
      warning.textContent = pending ? "Aguardando cotação para algumas moedas. Totais incompletos aparecem como —; os valores originais continuam disponíveis. O app tenta novamente automaticamente com internet." : "";
    });
  }

  /* ---------- Abertura ---------- */
  function open(id) {
    if (!accountFolderOwner() || !Cloud.ownsFolder(id)) { goHome(); return; }
    const loaded = Store.loadDataset(id);
    if (!loaded) { toast("Não foi possível abrir esta pasta. Exporte um backup para preservar os dados e verificar o arquivo."); goHome(); return; }
    billConfirmations.forEach(({timer}) => clearTimeout(timer));
    billConfirmations.clear();
    ds = loaded;
    legacyBillOrigins.clear();
    closeOriginReview();
    receiptFilter = null;
    // Lembra a última pasta pessoal aberta (usada no menu Pessoa física/Empresa)
    if (ds.profile !== "pj") {
      try { localStorage.setItem("fyg:pf-last", ds.id); } catch { /* sem storage */ }
    }
    // Migração para multi-moeda: pastas antigas eram 100% em Real
    ds.displayCurrency = normDisplayCur(ds.displayCurrency, ds.profile);
    ds.transactions.forEach((t) => { if (!t.currency) t.currency = "BRL"; });
    if (!Array.isArray(ds.limits)) ds.limits = [];
    if (!Array.isArray(ds.metas)) ds.metas = [];
    // Cotação: carrega o cache e revalida; re-renderiza quando chegar cotação nova
    Rates.load();
    if (!ratesHooked) {
      ratesHooked = true;
      Rates.onUpdate(() => {
        if (ds && ["#screen-dash", "#screen-txs"].some((id) => !$(id).classList.contains("hidden"))) renderAll();
      });
    }
    // Migração: limites antigos ganham histórico de versões ("0000-00" = desde sempre)
    ds.limits.forEach((L) => {
      if (!Array.isArray(L.versions) || !L.versions.length) {
        L.versions = [{ from: "0000-00", amount: L.amount, categories: L.categories }];
      }
    });
    const months = allMonths();
    billCalendarDate = todayISO();
    const cur = billCalendarDate.slice(0, 7);
    const hasBills = ds.transactions.some(t => t.paymentStatus || InstallmentSchedule.isC6InvoicePayable(t));
    fil = {
      mode: "month",
      month: hasBills || months.includes(cur) ? cur : (months.filter((ym) => ym <= cur).pop() || cur),
      from: "", to: "", cats: null, search: "", type: "all", account: "all",
    };
    sort = { key: "date", dir: -1 };
    rowLimit = 100;
    selectedTx.clear();
    undoStack.length = 0;
    updateUndoBtn();
    $("#tx-search").value = "";
    showScreen("screen-dash");
    renderAll();
    if(typeof ReceiptJobs!=="undefined")ReceiptJobs.refresh();
  }

  function closeFolder() {
    ds = null;
    legacyBillOrigins.clear();
    closeOriginReview();
    receiptFilter = null;
    editingId = null;
    receiptRead = null;
    txModalRevision++;
    selectedTx.clear();
    undoStack.length = 0;
    pendingParcTx = pendingAdvance = null;
    clearTimeout(billMidnightTimer);
    billConfirmations.forEach(({timer}) => clearTimeout(timer));
    billConfirmations.clear();
    $("#acct-menu").innerHTML = "";
  }

  // Uma sincronização pode atualizar a pasta enquanto a lista ou um
  // formulário está aberto. A próxima edição precisa partir desses dados,
  // sem gravar novamente a cópia antiga que estava apenas em memória.
  function refreshFromStore(opts) {
    if (!ds) return false;
    const loaded = Store.loadDataset(ds.id);
    if (!loaded || (!opts?.force && loaded.updatedAt === ds.updatedAt)) return false;
    ds = loaded;
    selectedTx.clear();
    undoStack.length = 0; // snapshots locais não podem reverter a sincronização
    updateUndoBtn();
    if (pendingParcTx && !ds.transactions.some(t => t.id === pendingParcTx.id)) {
      pendingParcTx = null;
      $("#modal-del-parc").classList.add("hidden");
    }
    renderAll();
    return true;
  }

  // Guarda o estado ANTES de cada alteração (para o botão Desfazer).
  // Lê o que está salvo agora (estado antigo) e empilha, depois grava o novo.
  const undoStack = [];
  const UNDO_MAX = 25;
  function saveCur() {
    if (!ds) return;
    const previous = Store.loadDataset(ds.id);
    const prev = previous ? JSON.stringify(previous) : null;
    try {
      Store.saveDataset(ds);
    } catch (error) {
      // Uma gravação recusada não pode deixar o painel exibindo dados que
      // desaparecerão ao recarregar a página.
      if (prev) ds = JSON.parse(prev);
      selectedTx.clear();
      renderAll();
      throw error;
    }
    if (prev) {
      undoStack.push(prev);
      if (undoStack.length > UNDO_MAX) undoStack.shift();
    }
    updateUndoBtn();
  }

  function updateUndoBtn() {
    const btn = $("#btn-undo");
    if (btn) btn.classList.toggle("hidden", undoStack.length === 0);
  }

  function undo() {
    const snap = undoStack[undoStack.length - 1];
    if (!snap) { toast("Nada para desfazer."); updateUndoBtn(); return; }
    let prev;
    try { prev = JSON.parse(snap); } catch { toast("Não consegui desfazer 😕"); return; }
    Store.saveDataset(prev); // mantém o histórico intacto se a gravação falhar
    ds = prev;
    undoStack.pop();
    selectedTx.clear();
    // não navega pra um mês inexistente após reverter
    const months = allMonths();
    if (fil.mode === "month" && fil.month && !months.includes(fil.month) && months.length) {
      fil.month = months[months.length - 1];
    }
    renderAll();
    updateUndoBtn();
    toast("Última alteração desfeita ↩");
  }

  /* ---------- Filtros ---------- */
  function allMonths() {
    const set = new Set();
    for (const t of ds.transactions) {
      set.add(accountingDate(t).slice(0, 7));
      if (t.paymentStatus && !groupedC6Ids.has(t.id)) set.add(billDueDate(t).slice(0, 7));
      if (!pendingIndividualBill(t)) set.add(reportDate(t).slice(0, 7));
    }
    return Array.from(set).sort();
  }

  function periodRange() {
    if (fil.mode === "month" && fil.month) {
      const [y, m] = fil.month.split("-").map(Number);
      return { from: `${fil.month}-01`, to: `${fil.month}-${String(daysInMonth(y, m)).padStart(2, "0")}` };
    }
    if (fil.mode === "range") {
      return { from: fil.from || null, to: fil.to || null };
    }
    return null; // tudo
  }

  function inPeriod(t, p, dateOf = reportDate) {
    if (!p) return true;
    const date = dateOf(t);
    if (p.from && date < p.from) return false;
    if (p.to && date > p.to) return false;
    return true;
  }

  function inCats(t) {
    return !fil.cats || fil.cats.has(stripAccents(t.category));
  }

  function filteredTxs(dateOf = reportDate, includePending = false) {
    const p = periodRange();
    return ds.transactions.filter((t) => (includePending || !pendingIndividualBill(t)) && inPeriod(t, p, dateOf) && inCats(t));
  }

  function tableTxs() {
    const q = stripAccents(fil.search);
    let list = receiptFilter ? ds.transactions.filter(t => receiptFilter.ids.has(t.id) || (!receiptFilter.printedOnly && typeof t.id === "string" && t.id.startsWith(receiptFilter.prefix))) : filteredTxs(accountingDate, true);
    if (fil.type !== "all") list = list.filter((t) => t.type === fil.type);
    if (fil.account !== "all") list = list.filter((t) => "account:" + (t.account || "") === fil.account);
    if (q) {
      list = list.filter((t) =>
        stripAccents(t.desc).includes(q) || stripAccents(t.category).includes(q) ||
        stripAccents(t.account).includes(q) || (t.installment || "").includes(q));
    }
    return list;
  }

  // Os filtros rápidos pertencem à lista; os cartões continuam mostrando o
  // período e as categorias escolhidos no cabeçalho.
  function renderTableFilters() {
    $("#tx-receipt-filter")?.classList.toggle("hidden", !receiptFilter);
    if (receiptFilter && $("#tx-receipt-label")) $("#tx-receipt-label").textContent = receiptFilter.printedOnly ? "Itens impressos na fatura" : "Lançamentos deste documento · todos os meses";
    const type = $("#tx-type-filter");
    if (type) type.value = fil.type;
    const account = $("#tx-account-filter");
    if (account) {
      const accounts = [...new Set(ds.transactions.map((t) => t.account || ""))]
        .sort((a, b) => a.localeCompare(b, "pt-BR"));
      if (fil.account !== "all" && !accounts.some((a) => "account:" + a === fil.account)) fil.account = "all";
      account.innerHTML = '<option value="all">Todas as contas</option>' + accounts.map((a) =>
        `<option value="${escapeHtml("account:" + a)}">${escapeHtml(a || "Sem conta")}</option>`).join("");
      account.value = fil.account;
    }
  }

  function exportCSV() {
    const list = sortTxs(tableTxs());
    if (!list.length) { toast("Não há transações neste filtro para exportar."); return; }
    // Aspas protegem separadores/quebras de linha; o apóstrofo impede que
    // descrições importadas sejam executadas como fórmulas em planilhas.
    const cell = (value) => {
      let s = String(value ?? "");
      if (/^[\s]*[=+@-]/.test(s)) s = "'" + s;
      return '"' + s.replace(/"/g, '""') + '"';
    };
    const number = (v, currency) => Number(v).toFixed(curFrac(currency)).replace(".", ",");
    const rows = [["Data", "Descrição", "Categoria", "Conta", "Tipo", "Parcela", "Recorrente", "Valor original", "Moeda original", "Valor exibido", "Moeda de exibição", "Pagamento", "Pago em", "Conta a pagar", "Data da compra", "Mês da fatura", "Mês da despesa", "Vencimento da conta"]];
    for (const t of list) {
      const individualBill = t.paymentStatus && !groupedC6Ids.has(t.id);
      rows.push([
        individualBill ? accountingDate(t) : t.date, t.desc, t.category, t.account || "",
        t.type === "receita" ? "Receita" : "Despesa", t.installment || "", t.fixed ? "Sim" : "Não",
        number(t.amount, t.currency), normCur(t.currency),
        Number.isFinite(txDisplayAmount(t)) ? number(txDisplayAmount(t), txDisplayCurrency(t)) : "", txDisplayCurrency(t),
        individualBill ? (isPendingBill(t) ? "Em aberto" : "Pago") : "", groupedC6Ids.has(t.id) ? "" : t.paidOn || "",
        individualBill ? "Sim" : "Não", t.purchaseDate || "", t.billClosingDate?.slice(0,7) || "",
        individualBill ? resolvedBillMonth(t) : "", individualBill ? billDueDate(t) : "",
      ]);
    }
    const csv = "\uFEFF" + rows.map((row) => row.map(cell).join(";")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `financas-${(ds.name || "pasta").replace(/[^a-zA-Z0-9_-]/g, "-")}-${fil.month || todayISO()}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`${list.length} transações exportadas em CSV.`);
  }

  /* ---------- Renderização geral ---------- */
  function renderCardCycle() {
    const el=$("#dashboard-card-cycle");
    if (!el) return;
    const latest=ds.transactions.reduce((found,t)=>t.billDateObserved && t.billDueDate && t.cardBestPurchaseDay && (!found || t.billDueDate>found.billDueDate) ? t : found,null);
    el.classList.toggle("hidden",!latest);
    el.innerHTML=latest ? `<strong>Última fatura · ${escapeHtml(latest.account)}</strong><dl>${latest.billClosingDate ? '<div><dt>Fechamento</dt><dd>'+fmtDate(latest.billClosingDate)+'</dd></div>' : ''}<div><dt>Vencimento</dt><dd>${fmtDate(latest.billDueDate)}</dd></div><div><dt>Melhor dia para comprar</dt><dd>Dia ${latest.cardBestPurchaseDay}</dd></div></dl>` : "";
  }
  function renderAll() {
    const today = todayISO();
    const beforeRenewal = ds;
    refreshBillOrigins();
    renewMonthlySeries(today.slice(0,7));
    if (ds !== beforeRenewal) refreshBillOrigins();
    if (billCalendarDate && billCalendarDate.slice(0,7) !== today.slice(0,7) &&
        fil.mode === "month" && fil.month === billCalendarDate.slice(0,7)) {
      fil.month = today.slice(0,7);
      rowLimit = 100;
    }
    billCalendarDate = today;
    const cycles = InstallmentSchedule.c6Invoices(ds.transactions, today);
    groupedC6Ids = new Set(cycles.filter(i => i.month >= "2026-11").flatMap(i => i.transactionIds));
    $("#ds-name").textContent = ds.name;
    if (typeof BusinessPanel !== "undefined") BusinessPanel.render(ds);
    renderPeriodControls();
    renderCurrencyControl();
    renderCurrencyWarning();
    renderCatFilter();
    renderSummary();
    renderCardCycle();
    renderBillBoard(cycles);
    renderCurrencyBreakdown();
    renderLimits();
    renderMetas();
    renderCharts();
    renderTable();
    if ($("#tx-origin-review").open) refreshOriginReview();
  }

  // Botão "BRL ▾" do cabeçalho + menu de moedas + linha de status da cotação
  function renderCurrencyControl() {
    $("#dash-hero")?.classList.toggle("precise-currency", curFrac(dispCur()) > 2);
    const code = $("#hero-cur-code");
    if (code) code.textContent = isDefaultMode() ? (ds?.profile === "pj" ? "Padrão · USD" : "Padrão") : dispCur();
    const defaultLabel = defaultPanelCurrency() === "USD" ? "dólares (USD)" : "guaranis (PYG)";
    const caption = `Totais em ${isDefaultMode() ? defaultLabel : dispCur()} · lançamentos na moeda original`;
    for (const id of ["#currency-mode-caption", "#tx-currency-mode-caption"]) {
      const node = $(id); if (node) node.textContent = caption;
    }
    $("#hero-cur")?.setAttribute("aria-label", "Moeda do painel: " + (isDefaultMode() ? "Padrão, totais em "+defaultLabel : dispCur()));
    const menu = $("#cur-menu");
    if (menu) {
      menu.innerHTML = `<button type="button" class="pop-item pop-default ${isDefaultMode() ? "active" : ""}" data-cur="DEFAULT" aria-pressed="${isDefaultMode()}"><span>Padrão<small>Totais em ${defaultLabel}. Cada lançamento na sua moeda.</small></span>${isDefaultMode() ? '<span class="pop-check">✓</span>' : ""}</button><div class="pop-sep"></div>` + CURRENCY_CODES.map((c) => `
        <button type="button" class="pop-item ${!isDefaultMode() && c === dispCur() ? "active" : ""}" data-cur="${c}" aria-pressed="${!isDefaultMode() && c === dispCur()}">
          ${escapeHtml(CURRENCIES[c].symbol)} — ${escapeHtml(CURRENCIES[c].name)}
          ${!isDefaultMode() && c === dispCur() ? '<span class="pop-check">✓</span>' : ""}
        </button>`).join("") +
        `<div class="pop-sep"></div><div class="pop-hint" id="rates-hint"></div><div class="pop-hint fx-sources">Cotações de referência: <a href="https://www.exchangerate-api.com" target="_blank" rel="noopener noreferrer">ExchangeRate-API</a> e <a href="https://github.com/fawazahmed0/exchange-api" target="_blank" rel="noopener noreferrer">Currency API</a>. Sem taxas de câmbio ou de rede.</div>`;
    }
    renderRatesHint();
  }

  function renderRatesHint() {
    const state = Rates.getState?.();
    const used = new Set([dispCur(), ...ds.transactions.map(t => normCur(t.currency)), ...ds.limits.map(l => normCur(l.currency)), ...ds.metas.filter(m => !m.category).map(m => normCur(m.currency))]);
    const relevant = [...used].filter(c => c !== "USD");
    const dates = relevant.map(c => state?.quotes?.[c]?.publishedAt).filter(Boolean).map(Date.parse).filter(Number.isFinite);
    const at = dates.length ? Math.min(...dates) : Date.parse(Rates.updatedAt() || "");
    const when = Number.isFinite(at) ? new Date(at).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" }) : "";
    const missing = relevant.some(c => !Rates.ready(c, "USD"));
    const stale = state?.staleCodes?.some(c => used.has(c));
    const status = state?.refreshing ? "Atualizando cotações…" : missing ? "Buscando cotações automaticamente" : stale || state?.error ? "Usando a última cotação salva · nova tentativa automática" : "Cotações automáticas";
    const details = status + (when ? ` · referência de ${when}` : "") + ". Conversão estimada; não altera os lançamentos.";
    const el = $("#rates-hint"); if (el) el.textContent = details;
    const visible = $("#currency-auto-status");
    if (visible) { visible.textContent = status + (when ? ` · ${when}` : ""); visible.title = details; }
  }

  function currencyBreakdown() {
    const grouped = new Map();
    filteredTxs().forEach(t => {
      const currency = normCur(t.currency);
      if (!grouped.has(currency)) grouped.set(currency, {currency, income: 0, expense: 0, count: 0});
      const group = grouped.get(currency);
      group[t.type === "receita" ? "income" : "expense"] += Number(t.amount);
      group.count++;
    });
    return [...grouped.values()].map(group => ({ ...group,
      incomeConverted: group.income === 0 ? 0 : convertAmount(group.income, group.currency, dispCur()),
      expenseConverted: group.expense === 0 ? 0 : convertAmount(group.expense, group.currency, dispCur()),
    })).sort((a, b) => a.currency.localeCompare(b.currency));
  }

  function currencyDistribution(groups, kind, label) {
    const converted = kind + "Converted";
    const total = groups.reduce((sum, g) => sum + g[converted], 0);
    let message = "";
    if (!Number.isFinite(total)) message = "Aguardando cotação para calcular as porcentagens.";
    else if (groups.some(g => g[converted] < 0)) message = "Há ajustes negativos. Veja os valores por moeda abaixo.";
    else if (total === 0) message = `O total de ${label.toLowerCase()} é zero neste período.`;
    const parts = message ? [] : groups.filter(g => g[converted] > 0).map(g => {
      const share = g[converted] / total * 100;
      return {currency:g.currency, width:share.toFixed(4), percent:share < 0.1 ? "<0,1%" : share.toLocaleString("pt-BR", {maximumFractionDigits:1}) + "%"};
    });
    const track = parts.map(p => `<span style="background:var(--fx-${p.currency});width:${p.width}%"></span>`).join("");
    const legend = parts.map(p => `<li style="--fx-color:var(--fx-${p.currency})"><span>${p.currency}</span> <b>${escapeHtml(p.percent)}</b></li>`).join("");
    return `<section class="fx-flow fx-${kind}"><h4><span aria-hidden="true">${kind === "expense" ? "↗" : "↙"}</span>${label}</h4>
      <div class="fx-total">${Number.isFinite(total) ? escapeHtml(fmtD(total)) : "Cotação pendente"}</div>
      ${message ? `<p class="fx-no-share">${message}</p>` : `<div class="fx-strip" aria-hidden="true">${track}</div><ul class="fx-legend" aria-label="Participação nas ${label.toLowerCase()}">${legend}</ul>`}
    </section>`;
  }

  function renderCurrencyBreakdown() {
    const block = $("#currency-breakdown"); if (!block) return;
    const groups = currencyBreakdown();
    block.classList.toggle("hidden", groups.length < 2);
    if (groups.length < 2) return;
    const hint = $("#currency-breakdown-hint");
    if (hint) hint.textContent = `Cada faixa representa 100% das saídas ou das entradas do período. As porcentagens usam o equivalente em ${dispCur()}.`;
    const rows = $("#currency-breakdown-rows"); if (!rows) return;
    const flows = currencyDistribution(groups, "expense", "Saídas") + currencyDistribution(groups, "income", "Entradas");
    const detail = groups.map(g => {
      const metric = (kind, label, converted) => {
        const native = g[kind], valid = Number.isFinite(converted);
        const value = fmtMoney(native, g.currency);
        const equivalent = g.currency !== dispCur() ? valid ? `≈ ${fmtD(converted)}` : "Cotação pendente" : !valid ? "Cotação pendente" : "";
        return `<div class="fx-metric fx-${kind}"><div class="fx-metric-value"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>${equivalent ? `<small>${escapeHtml(equivalent)}</small>` : ""}</div>`;
      };
      return `<div class="fx-row"><div class="fx-code"><strong>${g.currency}</strong><span>${g.count} ${g.count === 1 ? "lançamento" : "lançamentos"}</span></div>${metric("income", "Entradas", g.incomeConverted)}${metric("expense", "Saídas", g.expenseConverted)}</div>`;
    }).join("");
    rows.innerHTML = `<div class="fx-flows">${flows}</div><h4 class="fx-detail-title">Valores na moeda original</h4>${detail}`;
  }

  function renderPeriodControls() {
    // Só o nome do mês ("Janeiro"); o ano aparece junto apenas quando não é o atual
    let lbl = "—";
    if (fil.month) {
      const [y, m] = fil.month.split("-").map(Number);
      const nome = MESES[m - 1] || "";
      const cap = nome.charAt(0).toUpperCase() + nome.slice(1);
      lbl = y === new Date().getFullYear() ? cap : `${cap} ${y}`;
    }
    $("#month-label").textContent = lbl;
    const t = $("#txs-month-label");
    if (t) t.textContent = lbl;
  }

  /* ---------- Calendário de meses (popup do cabeçalho) ---------- */
  let mmYear = null;

  function renderMonthMenu() {
    $("#mm-year").textContent = mmYear;
    const cur = todayISO().slice(0, 7);
    $("#mm-grid").innerHTML = MESES_ABREV.map((m, i) => {
      const ym = `${mmYear}-${String(i + 1).padStart(2, "0")}`;
      const cls = ym === fil.month ? "mm-sel" : ym === cur ? "mm-cur" : "";
      return `<button type="button" class="${cls}" data-ym="${ym}">${m}.</button>`;
    }).join("");
  }

  function openMonthMenu() {
    mmYear = Number((fil.month || todayISO()).slice(0, 4));
    renderMonthMenu();
    $("#month-menu").classList.remove("hidden");
  }

  /* ---------- Menu de contas (ícone do topo esquerdo) ----------
     Mostra dois perfis: "Pessoa física" (a pasta pessoal em uso) e
     "Empresa" — que vira "Criar conta Empresa" enquanto não existir. */
  const EMPRESA_CATS = [
    "Receita de vendas", "Serviços", "Impostos", "Folha de pagamento",
    "Fornecedores", "Marketing", "Operacional", "Pró-labore",
    "Software e assinaturas", "Outros",
  ];

  function createEmpresaDataset(name = "Empresa") {
    if (!accountFolderOwner()) { goHome(); showFolderLogin(); return; }
    const nds = Store.createDataset(name);
    nds.profile = "pj";
    nds.categories = [];
    EMPRESA_CATS.forEach((c) => ensureCat(nds, c));
    Store.saveDataset(nds);
    open(nds.id);
    toast("Conta Empresa criada 🏢 — categorias de negócio já configuradas");
  }

  function renderAcctMenu() {
    const idx = accountFolderIndex();
    const isPj = (e) => e.profile === "pj";
    const companies = idx.filter(isPj);
    const curIsPj = !!(ds && ds.profile === "pj");
    // "Pessoa física" = a pasta pessoal aberta (ou a última pessoal usada)
    let pf = null;
    if (ds && !curIsPj) pf = idx.find((e) => e.id === ds.id) || null;
    if (!pf) {
      let lastPf = null;
      try { lastPf = localStorage.getItem("fyg:pf-last"); } catch { /* sem storage */ }
      pf = idx.find((e) => !isPj(e) && e.id === lastPf) || idx.find((e) => !isPj(e)) || null;
    }
    let html = "";
    if (pf) {
      html += `<button type="button" class="pop-item ${!curIsPj ? "active" : ""}" data-ds="${escapeHtml(pf.id)}">
        ${uiIcon("person")} Pessoa física${!curIsPj ? '<span class="pop-check">✓</span>' : ""}</button>`;
    }
    html += companies.map(company => `<button type="button" class="pop-item ${ds?.id===company.id?'active':''}" data-ds="${escapeHtml(company.id)}">
      ${uiIcon("business")} ${escapeHtml(company.name)}${ds?.id===company.id?'<span class="pop-check">✓</span>':''}</button>`).join("");
    if(!companies.length) html += `<button type="button" class="pop-item" data-create-pj="1">${uiIcon("plus")} Criar conta Empresa</button>`;
    html += `<div class="pop-sep"></div>
      <button type="button" class="pop-item" data-acct-home="1">${uiIcon("home")} Todas as pastas</button>`;
    $("#acct-menu").innerHTML = html;
  }

  function stepMonth(delta) {
    receiptFilter = null;
    let [y, m] = fil.month.split("-").map(Number);
    m += delta;
    if (m < 1) { m = 12; y--; }
    if (m > 12) { m = 1; y++; }
    fil.month = `${y}-${String(m).padStart(2, "0")}`;
    rowLimit = 100;
    renderAll();
  }

  function renderCatFilter() {
    // O botão é um funil fixo no cabeçalho; só sinaliza (bolinha) quando há filtro
    const btn = $("#cat-filter-btn");
    btn.classList.toggle("cat-filtered", !!fil.cats);
    btn.title = fil.cats
      ? `Filtro ativo: ${fil.cats.size} categoria(s) — toque para ajustar`
      : "Filtrar categorias (todas vêm selecionadas)";
    const dd = $("#cat-dropdown");
    const allChecked = !fil.cats;
    dd.innerHTML =
      `<label class="cat-all"><input type="checkbox" data-cat="__all__" ${allChecked ? "checked" : ""}> Todas as categorias</label>` +
      ds.categories.map((c) => {
        const key = stripAccents(c.name);
        const checked = allChecked || fil.cats.has(key);
        return `<label><input type="checkbox" data-cat="${escapeHtml(key)}" ${checked ? "checked" : ""}>
          <span class="sum-dot" style="background:${c.color}"></span> ${escapeHtml(c.name)}</label>`;
      }).join("");
  }

  /* ---------- Resumo ---------- */
  function renderSummary() {
    const txs = filteredTxs();
    const receitas = txs.filter((t) => t.type === "receita").reduce((s, t) => s + dispAmount(t), 0);
    const despesas = txs.filter((t) => t.type === "despesa").reduce((s, t) => s + dispAmount(t), 0);
    const saldo = receitas - despesas;

    const p = periodRange();
    const acumulado = ds.transactions
      .filter((t) => !pendingIndividualBill(t) && inCats(t) && (!p || !p.to || accountingDate(t) <= p.to))
      .reduce((s, t) => s + (t.type === "receita" ? dispAmount(t) : -dispAmount(t)), 0);

    const label = fil.mode === "month" ? "do mês" : fil.mode === "range" ? "do período" : "total";
    // Cabeçalho estilo app Mobills: saldo grande centralizado + Receitas × Despesas
    $("#hero-saldo-label").textContent = `Saldo ${label}`;
    const saldoEl = $("#hero-saldo");
    saldoEl.textContent = fmtD(saldo);
    saldoEl.classList.toggle("is-neg", saldo < 0);
    $("#hero-rec").textContent = fmtD(receitas);
    $("#hero-desp").textContent = fmtD(despesas);
    const accEl = $("#hero-acc");
    accEl.textContent = fmtD(acumulado);
    accEl.classList.toggle("pos", acumulado >= 0);
    accEl.classList.toggle("neg", acumulado < 0);
    // Mini-resumo da tela de Transações ("Saldo atual" = acumulado)
    const tAcc = $("#txs-acc");
    if (tAcc) { tAcc.textContent = fmtD(acumulado); tAcc.className = !Number.isFinite(acumulado) ? "" : acumulado >= 0 ? "pos" : "neg"; }
    const tSal = $("#txs-saldo");
    if (tSal) {
      const movementBalance = filteredTxs(accountingDate).reduce((sum, t) => sum + (t.type === "receita" ? 1 : -1) * dispAmount(t), 0);
      tSal.textContent = fmtD(movementBalance);
      tSal.className = !Number.isFinite(movementBalance) ? "" : movementBalance >= 0 ? "pos" : "neg";
    }
    fitHeroFlow();
  }

  // Encolhe os valores de Receitas/Despesas só o necessário para caberem
  // lado a lado na tela (o tamanho base é o do print: 26px no celular)
  function fitHeroFlow() {
    const flow = document.querySelector(".hero-flow");
    // Painel oculto (ex.: tela de Transações aberta) tem largura 0: não dá
    // para medir. Sai sem mexer para não zerar os tamanhos e deixar os
    // valores estourarem quando o painel voltar a aparecer.
    if (!flow || !flow.clientWidth) return;
    const vals = flow.querySelectorAll(".hero-flow-value");
    vals.forEach((el) => { el.style.fontSize = ""; });
    let guard = 16;
    while (guard-- > 0 && flow.scrollWidth > flow.clientWidth + 1) {
      let shrunk = false;
      vals.forEach((el) => {
        const s = parseFloat(getComputedStyle(el).fontSize);
        if (s > 14) { el.style.fontSize = (s - 1) + "px"; shrunk = true; }
      });
      if (!shrunk) break;
    }
  }

  /* ---------- Gráficos ---------- */
  function themePalette() {
    const light = document.documentElement?.dataset?.theme === "light";
    const fallback = light
      ? { text: "#272332", muted: "#635c71", border: "#dfd8e8", card: "#ffffff", bg: "#f7f4fa", primary: "#7843be", green: "#297442", red: "#b33e50", grid: "#e5dfec", balance: "#7843be", limit: "#d8c9ec" }
      : { text: "#f1eff5", muted: "#b5b2c2", border: "#38323f", card: "#24212e", bg: "#17161e", primary: "#aa83ed", green: "#87d392", red: "#ff8a8e", grid: "#38323f", balance: "#aa83ed", limit: "#514360" };
    let styles = null;
    // O teste de regras financeiras roda sem CSSOM; o app também pode
    // inicializar antes de uma folha opcional terminar de carregar.
    try {
      if (typeof getComputedStyle === "function" && document.documentElement) styles = getComputedStyle(document.documentElement);
    } catch { /* usa a paleta correspondente ao tema */ }
    const token = (name, value) => styles?.getPropertyValue?.(name)?.trim() || value;
    const green = token("--green", fallback.green), red = token("--red", fallback.red);
    const primary = token("--primary", fallback.primary);
    return {
      text: token("--text", fallback.text), muted: token("--text-soft", fallback.muted),
      border: token("--border", fallback.border), card: token("--card", fallback.card), bg: token("--bg", fallback.bg),
      primary, green, red, grid: token("--chart-grid", fallback.grid),
      revenue: token("--chart-revenue", green), expense: token("--chart-expense", red),
      balance: token("--chart-balance", primary), limit: token("--chart-limit", fallback.limit),
    };
  }

  function chartTint(color, opacity) {
    let hex = String(color).match(/^#([\da-f]{3,8})$/i)?.[1];
    if (hex && (hex.length === 3 || hex.length === 4)) hex = [...hex].map((c) => c + c).join("");
    if (hex && (hex.length === 6 || hex.length === 8)) {
      return `rgba(${parseInt(hex.slice(0, 2), 16)},${parseInt(hex.slice(2, 4), 16)},${parseInt(hex.slice(4, 6), 16)},${opacity})`;
    }
    const rgb = String(color).match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
    return rgb ? `rgba(${rgb[1]},${rgb[2]},${rgb[3]},${opacity})` : color;
  }

  function applyChartTheme() {
    const palette = themePalette();
    Chart.defaults.font.family = "'Open Sans', 'Segoe UI', system-ui, sans-serif";
    Chart.defaults.font.size = 11;
    Chart.defaults.font.weight = "500";
    Chart.defaults.color = palette.muted;
    Chart.defaults.borderColor = palette.grid;
    Object.assign(Chart.defaults.plugins.legend.labels, {
      usePointStyle: true, boxWidth: 9, boxHeight: 9, padding: 14, color: palette.text,
    });
    Object.assign(Chart.defaults.plugins.tooltip, {
      backgroundColor: palette.card, titleColor: palette.text, bodyColor: palette.muted,
      borderColor: palette.border, borderWidth: 1, padding: 13, cornerRadius: 10,
      boxPadding: 5, usePointStyle: true,
    });
    Chart.defaults.elements.line.borderWidth = 3;
    Chart.defaults.elements.point.hoverRadius = 5;
  }

  function mkChart(canvasId, config) {
    if (charts[canvasId]) { charts[canvasId].destroy(); delete charts[canvasId]; }
    if (typeof Chart === "undefined") {
      setEmpty(canvasId, true, "Os gráficos estão indisponíveis. Seus valores e transações continuam acessíveis.");
      return;
    }
    applyChartTheme();
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) config.options.animation = false;
    charts[canvasId] = new Chart($("#" + canvasId), config);
  }

  function setEmpty(canvasId, empty, msg) {
    const box = $("#" + canvasId).parentElement;
    let ov = box.querySelector(".chart-empty");
    if (empty) {
      if (!ov) {
        ov = document.createElement("div");
        ov.className = "chart-empty";
        ov.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--text-soft,#b5b2c2);font-size:13px;line-height:1.7;text-align:center;padding:28px;";
        box.appendChild(ov);
      }
      ov.textContent = msg;
    } else if (ov) {
      ov.remove();
    }
    $("#" + canvasId).style.visibility = empty ? "hidden" : "visible";
  }

  const moneyTip = {
    callbacks: {
      label: (ctx) => {
        const value = typeof ctx.parsed === "number" ? ctx.parsed : ctx.chart.options.indexAxis === "y" ? ctx.parsed.x : ctx.parsed.y;
        return ` ${ctx.dataset.label || ctx.label}: ${fmtD(value)}`;
      },
    },
  };
  const compactMoney = new Intl.NumberFormat("pt-BR", {notation:"compact", maximumFractionDigits:1});
  const moneyTicks = {
    callback: (v) => Math.abs(v) >= 1000
      ? CURRENCIES[dispCur()].symbol + " " + compactMoney.format(v)
      : fmtMoney(Number(v) || 0, dispCur()),
  };

  function timeChartOptions(palette) {
    return {
      responsive:true, maintainAspectRatio:false,
      interaction:{mode:"index", axis:"x", intersect:false},
      plugins:{legend:{position:"bottom", align:"start"}, tooltip:moneyTip},
      scales:{
        x:{grid:{display:false}, border:{display:false}, ticks:{
          autoSkip:true, maxTicksLimit:6, maxRotation:0, padding:6,
          callback(value) {
            const labels = this.getLabels();
            const [month, year] = this.getLabelForValue(value).split("/");
            if (value && labels[0].slice(-4) === labels.at(-1).slice(-4)) return month;
            return month + "/" + year.slice(-2);
          },
        }},
        y:{border:{display:false, dash:[3, 4]}, grid:{color:chartTint(palette.muted,.2), drawTicks:false}, ticks:{...moneyTicks, maxTicksLimit:5, padding:8}},
      },
    };
  }

  // O guia acompanha o mês sob o dedo ou cursor nas duas séries.
  const monthGuide = {
    id:"monthGuide",
    beforeDatasetsDraw(chart) {
      const [active] = chart.getActiveElements();
      if (!active) return;
      const {ctx, chartArea} = chart;
      ctx.save();
      ctx.strokeStyle = chart.options.color;
      ctx.globalAlpha = .5;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(active.element.x, chartArea.top);
      ctx.lineTo(active.element.x, chartArea.bottom);
      ctx.stroke();
      ctx.restore();
    },
  };

  function trendLine(label, data, color, filled = false) {
    return {
      label, data, borderColor:color, cubicInterpolationMode:"monotone",
      pointRadius:data.length === 1 ? 4 : 0, pointHitRadius:12, pointBackgroundColor:color, pointStyle:"line",
      fill:filled, backgroundColor:filled ? ({chart}) => {
        const area = chart.chartArea;
        if (!area) return "transparent";
        const fade = chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
        fade.addColorStop(0, chartTint(color,.24));
        fade.addColorStop(1, chartTint(color,.015));
        return fade;
      } : color,
    };
  }

  function categoryLegend(entries) {
    const legend = $("#chart-cat-legend");
    const total = entries.reduce((sum, [, value]) => sum + value, 0);
    const hasShares = entries.every(([, value]) => value >= 0);
    const formatShare = (value, sum) => hasShares && sum > 0
      ? (value / sum).toLocaleString("pt-BR",{style:"percent",maximumFractionDigits:1}) : "";
    $("#chart-cat-total").textContent = entries.length ? fmtD(total) : "—";
    $("#chart-cat-center").hidden = !entries.length;
    const updateCount = count => {
      $("#chart-cat-count").textContent = count;
      $("#chart-cat-unit").textContent = count === 1 ? "categoria" : "categorias";
    };
    updateCount(entries.length);
    legend.innerHTML = entries.map(([name, value], index) => {
      return `<li><button type="button" aria-pressed="true" data-category-index="${index}" title="Mostrar ou ocultar ${escapeHtml(name)} no gráfico">
        <i aria-hidden="true" style="background:${catColor(ds,name)}"></i><span class="chart-cat-name">${escapeHtml(name)}</span>
        <strong class="chart-amount">${escapeHtml(fmtD(value))}</strong><small class="chart-share">${formatShare(value,total)}</small></button></li>`;
    }).join("");
    legend.onclick = event => {
      const button = event.target.closest("button[data-category-index]");
      if (!button) return;
      const chart = charts["chart-cat"];
      const index = Number(button.dataset.categoryIndex);
      chart.toggleDataVisibility(index);
      button.setAttribute("aria-pressed", chart.getDataVisibility(index));
      const visible = entries.filter((_, i) => chart.getDataVisibility(i));
      const sum = visible.reduce((acc, [, value]) => acc + value, 0);
      legend.querySelectorAll(".chart-share").forEach((part, i) => {
        part.textContent = chart.getDataVisibility(i) ? formatShare(entries[i][1],sum) : "";
      });
      updateCount(visible.length);
      chart.update();
    };
  }

  // Meses exibidos nos gráficos de evolução
  function chartMonths(dateOf) {
    const months = [...new Set(ds.transactions.filter(t => !pendingIndividualBill(t)).map(t => dateOf(t).slice(0,7)))].sort();
    if (fil.mode === "range") {
      return months.filter((ym) => (!fil.from || ym >= fil.from.slice(0, 7)) && (!fil.to || ym <= fil.to.slice(0, 7)));
    }
    return months;
  }

  function renderCharts() {
    const palette = themePalette();
    const posted = ds.transactions.filter(t => !pendingIndividualBill(t) && inCats(t));
    if (typeof Chart === "undefined") {
      categoryLegend([]);
      ["chart-cat", "chart-evo", "chart-saldo", "chart-conta"].forEach((id) => setEmpty(id, true, "Os gráficos estão indisponíveis. Seus valores e transações continuam acessíveis."));
      return;
    }
    const expenses = filteredTxs().filter(t => t.type === "despesa");
    const missingExpenseRate = expenses.some(t => !Number.isFinite(dispAmount(t)));
    const comparable = missingExpenseRate ? [] : expenses;
    const expenseMessage = missingExpenseRate ? "Falta cotação para somar os gastos deste período." : "Sem despesas no período selecionado";

    /* 1. Rosca — gastos por categoria */
    const byCat = Object.create(null);
    comparable.forEach((t) => { byCat[t.category] = (byCat[t.category] || 0) + dispAmount(t); });
    const catEntries = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
    categoryLegend(catEntries);
    setEmpty("chart-cat", !catEntries.length, expenseMessage);
    mkChart("chart-cat", {
      type: "doughnut",
      data: {
        labels: catEntries.map(([c]) => c),
        datasets: [{
          data: catEntries.map(([, v]) => v),
          backgroundColor: catEntries.map(([c]) => catColor(ds, c)),
          borderWidth: 0, spacing: 3, hoverOffset: 3, borderRadius: 4,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: "78%", layout:{padding:4},
        plugins: {
          legend: { display:false },
          tooltip: { callbacks: { label: (ctx) => ` ${ctx.label}: ${fmtD(ctx.parsed)}` } },
        },
      },
    });

    /* 2 e 3. Evolução mensal (linha) e saldo (barra + acumulado) */
    const months = chartMonths(reportDate);
    const recM = Object.create(null), despM = Object.create(null);
    const movementByMonth = Object.create(null);
    posted.forEach((t) => {
      const ym = reportDate(t).slice(0, 7);
      const group = t.type === "receita" ? recM : despM;
      const amount = dispAmount(t);
      group[ym] = (group[ym] ?? 0) + amount;
      const movementMonth = accountingDate(t).slice(0, 7);
      movementByMonth[movementMonth] = (movementByMonth[movementMonth] ?? 0) + (t.type === "receita" ? amount : -amount);
    });
    const labels = months.map(fmtMonth);
    const point = value => Number.isFinite(value) ? value : null;
    const recData = months.map((ym) => point(recM[ym] ?? 0));
    const despData = months.map((ym) => point(despM[ym] ?? 0));
    $("#chart-evo-note").hidden = !recData.includes(null) && !despData.includes(null);

    setEmpty("chart-evo", !months.length, "Sem transações ainda");
    mkChart("chart-evo", {
      type: "line",
      plugins:[monthGuide],
      data: {
        labels,
        datasets: [
          trendLine("Receitas", recData, palette.revenue, true),
          { ...trendLine("Despesas", despData, palette.expense), borderDash:[6,3] },
        ],
      },
      options:timeChartOptions(palette),
    });

    // Saldo acumulado inclui meses anteriores à janela exibida
    const movementMonths = chartMonths(accountingDate);
    let run = 0;
    const cumByMonth = Object.create(null);
    const monthBalance = ym => movementByMonth[ym] ?? 0;
    for (const ym of [...new Set([...Object.keys(movementByMonth), ...movementMonths])].sort()) {
      run += monthBalance(ym);
      cumByMonth[ym] = run;
    }
    const saldoData = movementMonths.map((ym) => point(monthBalance(ym)));
    const cumData = movementMonths.map((ym) => point(cumByMonth[ym]));
    $("#chart-saldo-note").hidden = !saldoData.includes(null) && !cumData.includes(null);

    setEmpty("chart-saldo", !movementMonths.length, "Sem transações ainda");
    mkChart("chart-saldo", {
      plugins:[monthGuide],
      data: {
        labels: movementMonths.map(fmtMonth),
        datasets: [
          {
            type: "bar", label: "Saldo do mês", data: saldoData,
            backgroundColor: saldoData.map((v) => chartTint(v >= 0 ? palette.revenue : palette.expense, .75)),
            borderRadius: 6, maxBarThickness: 24, pointStyle:"rectRounded", order:1,
          },
          { type:"line", ...trendLine("Acumulado", cumData, palette.balance), order:0 },
        ],
      },
      options:timeChartOptions(palette),
    });

    /* 4. Barras horizontais — gastos por cartão/conta */
    const byAcc = Object.create(null);
    comparable.forEach((t) => {
      const a = t.account || "(sem cartão)";
      byAcc[a] = (byAcc[a] || 0) + dispAmount(t);
    });
    const accEntries = Object.entries(byAcc).sort((a, b) => b[1] - a[1]).slice(0, 8);
    setEmpty("chart-conta", !accEntries.length, expenseMessage);
    mkChart("chart-conta", {
      type: "bar",
      data: {
        labels: accEntries.map(([a]) => a),
        datasets: [{
          label: "Despesas", data: accEntries.map(([, v]) => v),
          backgroundColor: accEntries.map((_,i) => i === 0 ? palette.balance : chartTint(palette.balance,.55)),
          borderRadius: 8, maxBarThickness: 14,
        }],
      },
      options: {
        indexAxis: "y", responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => ` ${fmtD(ctx.parsed.x)}` } } },
        scales: { x: { ticks: { ...moneyTicks, padding: 6, maxTicksLimit:4, maxRotation:0 }, border: { display: false, dash:[3,4] }, grid: { color:chartTint(palette.muted,.2), drawTicks:false } }, y: { grid: { display: false }, border: { display: false } } },
      },
    });
  }

  /* ---------- Controle de Limites ---------- */
  // Mês de referência para escolher a versão do limite
  function refMonth() {
    if (fil.mode === "month" && fil.month) return fil.month;
    if (fil.mode === "range" && fil.to) return fil.to.slice(0, 7);
    return todayISO().slice(0, 7);
  }

  // Versão do limite vigente em um mês ("YYYY-MM"): a última com from <= mês
  function versionFor(L, ym) {
    const vs = (L.versions || []).slice().sort((a, b) => a.from.localeCompare(b.from));
    let cur = vs[0];
    for (const v of vs) if (v.from <= ym) cur = v;
    return cur || { from: "0000-00", amount: L.amount, categories: L.categories };
  }

  function nextCalendarMonth(ym) {
    const [year,month] = ym.split("-").map(Number);
    return month === 12 ? String(year + 1).padStart(4,"0") + "-01" : ym.slice(0,5) + String(month + 1).padStart(2,"0");
  }

  function stopRenewal(anchor) {
    delete anchor.repeatMonthlyDay;
    delete anchor.repeatThrough;
    delete anchor.repeatKey;
    delete anchor.repeatBillReferenceMonth;
  }

  // O último mês gerado faz parte da mesma gravação das novas ocorrências.
  // Isso também preserva exclusões individuais e edições na data de vencimento.
  function renewMonthlySeries(through) {
    const due = t => t.fixed && t.groupId && Number.isInteger(t.repeatMonthlyDay) && t.repeatMonthlyDay >= 1 && t.repeatMonthlyDay <= 31 &&
      /^[a-z0-9]{6,24}$/.test(t.repeatKey || "") && isValidISODate(t.repeatThrough + "-01") && t.repeatThrough < through;
    if (!ds.transactions.some(due)) return;
    if (typeof Cloud !== "undefined" && typeof Cloud.ownsFolder === "function" && !Cloud.ownsFolder(ds.id)) return;
    const latest = Store.loadDataset(ds.id);
    if (!latest) return;
    const anchors = latest.transactions.filter(due);
    if (!anchors.length) { ds = latest; return; }
    const ids = new Set(latest.transactions.map(t => t.id));
    for (const anchor of anchors) {
      const months = new Set(latest.transactions.filter(t => t.fixed && t.groupId === anchor.groupId).map(t => t.repeatMonth || t.date.slice(0,7)));
      const referenceAnchor = {...anchor, billReferenceOrigin:anchor.billReferenceOrigin || legacyBillOrigin(anchor)};
      if (anchor.repeatBillReferenceMonth) Object.assign(referenceAnchor, {
        date:(anchor.repeatMonth || anchor.date.slice(0,7))+"-01", advance:undefined, billReferenceMonth:anchor.repeatBillReferenceMonth,
      });
      for (let month = nextCalendarMonth(anchor.repeatThrough); month.length === 7 && month <= through; month = nextCalendarMonth(month)) {
        const id = "mr" + anchor.repeatKey + "x" + month.replace("-","");
        if (months.has(month)) continue;
        if (ids.has(id) || latest.transactions.length >= 100000) {
          toast("Revise a série fixa antes de continuar a renovação desta pasta."); return;
        }
        const [year,number] = month.split("-").map(Number);
        const day = Math.min(anchor.repeatMonthlyDay,daysInMonth(year,number));
        const date = month+"-"+String(day).padStart(2,"0");
        latest.transactions.push({id,groupId:anchor.groupId,fixed:true,repeatMonth:month,date,
          amount:anchor.amount,currency:anchor.currency,type:anchor.type,desc:anchor.desc,category:anchor.category,account:anchor.account,
          installment:null,totalValue:null,...(anchor.c6Section && {c6Section:anchor.c6Section}),
          ...(anchor.type === "despesa" && anchor.paymentStatus && {paymentStatus:"pending",...nextBillReferenceField(referenceAnchor,date)})});
        ids.add(id);
      }
      anchor.repeatThrough = through;
    }
    try { Store.saveDataset(latest); ds = latest; }
    catch { /* Store notifica o erro. A próxima abertura tenta de novo. */ }
  }

  function limitStats() {
    if (!ds.limits?.length) return [];
    const period = periodRange();
    const spentByMonth = new Map();
    let first = "", last = "";
    for (const t of ds.transactions) {
      if (pendingIndividualBill(t) || !inPeriod(t, period)) continue;
      const month = reportDate(t).slice(0,7);
      if (!first || month < first) first = month;
      if (month > last) last = month;
      if (t.type !== "despesa" || !inCats(t)) continue;
      if (!spentByMonth.has(month)) spentByMonth.set(month,new Map());
      const byCategory = spentByMonth.get(month), category = stripAccents(t.category);
      byCategory.set(category,(byCategory.get(category) ?? 0) + dispAmount(t));
    }
    first = period?.from?.slice(0,7) || first || period?.to?.slice(0,7) || refMonth();
    last = period?.to?.slice(0,7) || last || first;
    return ds.limits.map(base => {
      const versions = base.versions?.length ? base.versions.slice().sort((a,b) => a.from.localeCompare(b.from)) : [{from:"0000-00",amount:base.amount,categories:base.categories}];
      const visible = new Set(), overMonths = [];
      let amount = 0, spent = 0, filtered = false, vi = -1;
      for (let month = first; month <= last && month.length === 7; month = nextCalendarMonth(month)) {
        while (vi + 1 < versions.length && versions[vi+1].from <= month) vi++;
        if (vi < 0) continue;
        const version = versions[vi];
        const categories = version.categories.filter(c => !fil.cats || fil.cats.has(stripAccents(c)));
        if (!categories.length) continue;
        filtered ||= categories.length < version.categories.length;
        const cap = convertAmount(version.amount,base.currency,dispCur());
        const expenses = spentByMonth.get(month);
        const used = categories.reduce((sum,c) => sum + (expenses?.get(stripAccents(c)) ?? 0),0);
        categories.forEach(c => visible.add(c));
        amount += cap;
        spent += used;
        if (used > cap) overMonths.push(month);
      }
      if (!visible.size) return null;
      const since = first === last && versions[vi].from !== "0000-00" ? versions[vi].from : null;
      return {...base,amount,spent,remaining:amount-spent,pct:amount>0 ? spent/amount*100 : 0,
        since,visibleCats:[...visible],filtered,overMonths,unavailable:!Number.isFinite(amount) || !Number.isFinite(spent)};
    }).filter(Boolean);
  }

  function renderLimits() {
    const palette = themePalette();
    const groups = limitStats();
    const total = (ds.limits || []).length;
    const unavailable = groups.some((g) => g.unavailable);
    const label = fil.mode === "month" ? "no mês" : fil.mode === "range" ? "no período" : "no total";

    // Linha de resumo no cabeçalho do bloco
    const ov = $("#limits-overview");
    if (!total) {
      ov.textContent = "Defina tetos de gasto por grupo de categorias e acompanhe tudo por aqui.";
    } else if (!groups.length) {
      ov.textContent = "Nenhum limite corresponde ao filtro de categorias atual.";
    } else if (unavailable) {
      ov.textContent = "Cotação indisponível para calcular alguns limites. Os valores originais foram preservados.";
    } else {
      const totLim = groups.reduce((s, g) => s + g.amount, 0);
      const totSpent = groups.reduce((s, g) => s + g.spent, 0);
      const nOver = groups.filter((g) => g.overMonths.length).length;
      const pct = totLim > 0 ? Math.round((totSpent / totLim) * 100) : 0;
      ov.innerHTML = `<span class="private-total">${fmtD(totSpent)} gastos de ${fmtD(totLim)} ${label} (${pct}%)</span>` +
        (nOver
          ? ` · <span class="limit-over-txt">${nOver} limite(s) ultrapassado(s)</span>`
          : ` · <span class="limit-ok-txt">Tudo dentro do limite</span>`);
    }

    // Lista de grupos (barras de progresso compactas)
    const wrap = $("#limits-groups");
    if (!groups.length) {
      wrap.innerHTML = `<div class="empty-limits">${total
        ? "Os limites existentes não incluem as categorias filtradas — ajuste o filtro para vê-los."
        : `Nenhum limite criado ainda.<br>Ex: <b>Essencial + Compra do mês → R$ 3.340,00</b>. Clique em <b>＋ Novo limite</b> para começar.`}</div>`;
    } else {
      wrap.innerHTML = groups.map((g) => {
        if (g.unavailable) return `<div class="limit-row" data-id="${escapeHtml(g.id)}">
          <div class="limit-row-top"><div class="limit-name">${escapeHtml(g.name)}</div><div class="limit-actions">
            <button class="btn-icon" data-action="edit-limit" title="Editar limite" aria-label="Editar limite">${uiIcon("edit")}</button>
            <button class="btn-icon" data-action="delete-limit" title="Excluir limite" aria-label="Excluir limite">${uiIcon("trash")}</button>
          </div></div><p class="hint">Cotação indisponível para comparar os gastos e este limite.</p></div>`;
        const over = g.overMonths.length > 0;
        const warn = !over && g.pct >= 70;
        const barCls = over ? "over" : warn ? "warn" : "";
        return `
        <div class="limit-row ${over ? "limit-over" : warn ? "limit-warn" : ""}" data-id="${escapeHtml(g.id)}">
          <div class="limit-row-top">
            <div class="limit-name">${escapeHtml(g.name)}
              <span class="limit-cats-line">· ${g.visibleCats.map(escapeHtml).join(" + ")}${g.filtered ? " (filtro ativo)" : ""}${g.since ? ` · <b>valor desde ${fmtMonth(g.since)}</b>` : ""}</span>
            </div>
            <div class="limit-actions">
              <button class="btn-icon" data-action="edit-limit" title="Editar limite" aria-label="Editar limite">${uiIcon("edit")}</button>
              <button class="btn-icon" data-action="delete-limit" title="Excluir limite" aria-label="Excluir limite">${uiIcon("trash")}</button>
            </div>
          </div>
          <div class="progress"><div class="progress-bar ${barCls}" style="width:${Math.min(100, g.pct)}%"></div></div>
          <div class="limit-nums">
            <span>Gasto: <b class="${over ? "limit-over-txt" : ""}">${fmtD(g.spent)}</b> de ${fmtD(g.amount)} <span class="limit-pct">(${g.pct.toFixed(0)}%)</span></span>
            <span>${over
              ? `<span class="limit-over-txt">${fil.mode === "month" ? "Ultrapassou em " + fmtD(-g.remaining) : "Acima do teto em " + g.overMonths.map(fmtMonth).join(", ")}</span>`
              : `<span class="limit-ok-txt">Falta ${fmtD(g.remaining)}</span>`}</span>
          </div>
        </div>`;
      }).join("");
    }

    // Gráfico gasto × limite (some quando não há grupos visíveis)
    $("#limits-chart-box").classList.toggle("hidden", !groups.length || unavailable);
    $("#limits-body").classList.toggle("no-chart", !groups.length || unavailable);
    if (!groups.length || unavailable) {
      if (charts["chart-limits"]) { charts["chart-limits"].destroy(); delete charts["chart-limits"]; }
      return;
    }
    mkChart("chart-limits", {
      type: "bar",
      data: {
        labels: groups.map((g) => g.name),
        datasets: [
          {
            label: "Gasto", data: groups.map((g) => g.spent),
            backgroundColor: groups.map((g) => (g.overMonths.length ? palette.expense : g.pct >= 70 ? palette.primary : palette.revenue)),
            borderRadius: 5, maxBarThickness: 24,
          },
          {
            label: "Limite", data: groups.map((g) => g.amount),
            backgroundColor: palette.limit, borderRadius: 5, maxBarThickness: 24,
          },
        ],
      },
      options: {
        indexAxis: "y", responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: "bottom" }, tooltip: moneyTip },
        scales: { x: { ticks: { ...moneyTicks, padding: 10 }, border: { display: false }, grid: { color: palette.grid } }, y: { grid: { display: false }, border: { display: false } } },
      },
    });
  }

  /* ---------- Metas ----------
     Dois tipos:
     - Poupança (manual): { id, name, target, saved } — aportes à mão.
     - Cobrança de amigo (vinculada): { id, name, category } — o valor devido
       é a soma das DESPESAS da categoria; a barra enche com as RECEITAS
       (pagamentos) da mesma categoria. Assim registrar um pagamento abate a
       fatura de verdade, sem número duplicado. */
  let editingMetaId = null;
  let metaMode = "manual";
  let metaEditCurrency = "BRL";
  let limitEditCurrency = "BRL";

  // Calcula progresso da meta (vinculada = a partir das transações da categoria)
  function metaStats(m) {
    if (m.category) {
      const k = stripAccents(m.category);
      let owed = 0, paid = 0;
      ds.transactions.forEach((t) => {
        if (pendingIndividualBill(t) || stripAccents(t.category) !== k) return;
        if (t.type === "despesa") owed += dispAmount(t); else paid += dispAmount(t);
      });
      const target = Math.round(owed * 100) / 100;
      const saved = Math.round(paid * 100) / 100;
      return { linked: true, target, saved, unavailable: !Number.isFinite(target) || !Number.isFinite(saved), done: target > 0 && saved >= target - 0.004, pct: target > 0 ? (saved / target) * 100 : 0 };
    }
    // Meta de poupança: valores guardados na moeda em que foram digitados,
    // convertidos para a moeda do painel só na exibição.
    const target = convertAmount(m.target, m.currency, dispCur());
    const saved = convertAmount(m.saved, m.currency, dispCur());
    const done = target > 0 && saved >= target - 0.004;
    return { linked: false, target, saved, unavailable: !Number.isFinite(target) || !Number.isFinite(saved), done, pct: target > 0 ? (saved / target) * 100 : 0 };
  }

  function renderMetas() {
    const metas = ds.metas || [];
    $("#metas-sec").classList.toggle("hidden", !metas.length);
    if (!metas.length) return;
    $("#metas-groups").innerHTML = metas.map((m) => {
      const s = metaStats(m);
      if (s.unavailable) return `<div class="limit-row meta-row" data-id="${escapeHtml(m.id)}">
        <div class="limit-row-top"><div class="limit-name">${escapeHtml(m.name)}</div><div class="limit-actions">
          <button class="btn-icon" data-action="edit-meta" title="Editar meta" aria-label="Editar meta">${uiIcon("edit")}</button>
          <button class="btn-icon" data-action="delete-meta" title="Excluir meta" aria-label="Excluir meta">${uiIcon("trash")}</button>
        </div></div><p class="hint">Cotação indisponível para calcular o progresso nesta moeda.${s.linked ? "" : ` <span class="private-total">Guardado: ${fmtMoney(m.saved, normCur(m.currency))} de ${fmtMoney(m.target, normCur(m.currency))} (${normCur(m.currency)} original).</span>`}</p></div>`;
      const empty = s.linked && s.target <= 0;
      const icon = uiIcon(s.done ? "check" : (s.linked ? "people" : "target"), 20);
      const catLine = s.linked ? `<span class="limit-cats-line">· cobrança de ${escapeHtml(m.category)}</span>` : "";
      // Meta de amigo: lançar gasto (dívida) + registrar pagamento + importar.
      // Meta de poupança: só o aporte.
      const chargeBtn = s.linked
        ? `<button class="btn btn-ghost btn-sm meta-add-btn" data-action="meta-charge" title="Adicionar manualmente um gasto que ${escapeHtml(m.name)} deve">${uiIcon("plus", 15)} Gasto</button>`
        : "";
      const addBtn = (s.done && s.linked) ? "" :
        `<button class="btn btn-ghost btn-sm meta-add-btn" data-action="meta-add">${uiIcon("plus", 15)} ${s.linked ? "Pagamento" : "Adicionar valor"}</button>`;
      const importBtn = s.linked
        ? `<button class="btn btn-ghost btn-sm meta-add-btn" data-action="meta-import" title="Ler foto de fatura/planilha ou Excel e lançar todos os gastos nesta categoria">${uiIcon("file", 15)} Importar</button>`
        : "";
      const leftNum = s.linked
        ? `<span>Pagaram: <b class="${s.done ? "limit-ok-txt" : ""}">${fmtD(s.saved)}</b> de ${fmtD(s.target)} <span class="limit-pct">(${s.pct.toFixed(0)}%)</span></span>`
        : `<span>Guardado: <b>${fmtD(s.saved)}</b> de ${fmtD(s.target)} <span class="limit-pct">(${s.pct.toFixed(0)}%)</span></span>`;
      const rightNum = empty
        ? `<span class="limit-cats-line">Sem despesas nessa categoria ainda</span>`
        : s.done
          ? `<span class="limit-ok-txt">${s.linked ? "Pagamento concluído" : "Meta alcançada"}</span>`
          : `<span>${s.linked ? "Falta receber" : "Falta"} ${fmtD(Math.max(0, s.target - s.saved))}</span>`;
      return `
      <div class="limit-row meta-row ${s.done ? "meta-done" : ""}" data-id="${escapeHtml(m.id)}">
        <div class="limit-row-top">
          <div class="limit-name">${icon} ${escapeHtml(m.name)}${catLine}${s.done ? '<span class="meta-done-chip">Finalizada</span>' : ""}</div>
          <div class="limit-actions">
            ${chargeBtn}
            ${importBtn}
            ${addBtn}
            <button class="btn-icon" data-action="edit-meta" title="Editar meta" aria-label="Editar meta">${uiIcon("edit")}</button>
            <button class="btn-icon" data-action="delete-meta" title="Excluir meta" aria-label="Excluir meta">${uiIcon("trash")}</button>
          </div>
        </div>
        <div class="progress"><div class="progress-bar ${s.done ? "done" : ""}" style="width:${Math.min(100, s.pct)}%"></div></div>
        <div class="limit-nums">${leftNum}${rightNum}</div>
      </div>`;
    }).join("");
  }

  function setMetaMode(mode) {
    metaMode = mode;
    $$("#meta-mode-toggle button").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    const linked = mode === "linked";
    $("#meta-f-target").classList.toggle("hidden", linked);
    $("#meta-f-saved").classList.toggle("hidden", linked);
    $("#meta-f-cat").classList.toggle("hidden", !linked);
    $("#meta-linked-hint").classList.toggle("hidden", !linked);
    $("#modal-meta .meta-modal-sub").textContent = linked
      ? "Cobre o que um amigo te deve por gastos no seu cartão"
      : "Defina o objetivo e veja a barrinha encher";
    updateMetaPreview();
  }

  // Prévia ao vivo da barrinha dentro do modal de meta
  function updateMetaPreview() {
    const bar = $("#meta-preview-bar");
    const txt = $("#meta-preview-txt");
    const pctEl = $("#meta-preview-pct");
    const empty = (msg) => { bar.style.width = "0%"; bar.classList.remove("done"); txt.textContent = msg; pctEl.textContent = ""; };
    let target, saved;

    if (metaMode === "linked") {
      const cat = $("#meta-cat").value;
      if (!cat) return empty("Escolha a categoria");
      const k = stripAccents(cat);
      let owed = 0, paid = 0;
      ds.transactions.forEach((t) => {
        if (pendingIndividualBill(t) || stripAccents(t.category) !== k) return;
        if (t.type === "despesa") owed += dispAmount(t); else paid += dispAmount(t);
      });
      if (!Number.isFinite(owed) || !Number.isFinite(paid)) return empty("Cotação indisponível para calcular o progresso dessa categoria");
      if (owed <= 0) return empty("Ainda não há despesas nessa categoria");
      target = owed; saved = paid;
    } else {
      target = moneyInputValue($("#meta-target"), metaEditCurrency);
      saved = Math.abs(moneyInputValue($("#meta-saved"), metaEditCurrency) ?? 0);
      if (target == null || target <= 0) return empty("Preencha os valores para ver o progresso");
    }

    const pct = (saved / target) * 100;
    const done = saved >= target - 0.004;
    bar.style.width = Math.min(100, pct) + "%";
    bar.classList.toggle("done", done);
    pctEl.textContent = pct.toFixed(0) + "%";
    txt.textContent = metaMode === "linked"
      ? (done ? "Pagamento concluído" : `Já pagaram ${fmtD(saved)} · falta ${fmtD(target - saved)}`)
      : (done ? "Meta alcançada" : `Faltam ${fmtMoney(target - saved, metaEditCurrency)} para o objetivo`);
  }

  function openMetaModal(id) {
    editingMetaId = id;
    const m = id ? ds.metas.find((x) => x.id === id) : null;
    $("#modal-meta-title").textContent = m ? "Editar Meta" : "Nova Meta";
    $("#meta-name").value = m ? m.name : "";
    $("#meta-cat").innerHTML = ds.categories.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join("");
    const linked = !!(m && m.category);
    if (linked && ds.categories.some((c) => stripAccents(c.name) === stripAccents(m.category))) $("#meta-cat").value = m.category;
    // Editar apenas o nome não pode converter o patrimônio nem perder
    // centavos por arredondamento em moedas sem casas decimais.
    const dc = metaEditCurrency = m && !linked ? normCur(m.currency) : entryCur();
    const sym = CURRENCIES[dc].symbol;
    $("#meta-f-target").childNodes[0].nodeValue = `Valor da meta (${sym}) `;
    $("#meta-f-saved").childNodes[0].nodeValue = `Já guardado (${sym}) `;
    setMoneyMaskCurrency($("#meta-target"), dc);
    setMoneyMaskCurrency($("#meta-saved"), dc);
    $("#meta-target").value = (m && !m.category) ? fmtMoneyInput(m.target, dc) : "";
    $("#meta-saved").value = (m && !m.category) ? fmtMoneyInput(m.saved, dc) : "";
    // Ao editar, o tipo é fixo (não converte poupança <-> cobrança)
    $("#meta-mode-toggle").classList.toggle("hidden", !!m);
    setMetaMode(linked ? "linked" : "manual");
    $("#modal-meta").classList.remove("hidden");
    setTimeout(() => $("#meta-name").focus(), 50);
  }

  function saveMetaModal() {
    const name = $("#meta-name").value.trim();
    if (!name) { toast("Dê um nome para a meta 🎯"); $("#meta-name").focus(); return; }
    let message;

    if (metaMode === "linked") {
      const category = $("#meta-cat").value;
      if (!category) { toast("Escolha a categoria da cobrança 🏷️"); return; }
      if (editingMetaId) {
        const m = ds.metas.find((x) => x.id === editingMetaId);
        if (m) { m.name = name; m.category = category; delete m.target; delete m.saved; }
        message = "Meta atualizada ✔";
      } else {
        ds.metas.push({ id: uid(), name, category });
        message = "Meta de cobrança criada ✔";
      }
    } else {
      const dc = metaEditCurrency;
      const target = moneyInputValue($("#meta-target"), dc);
      if (!Number.isFinite(target) || target <= 0) { toast("Informe o valor da meta 💰"); $("#meta-target").focus(); return; }
      const saved = Math.abs(moneyInputValue($("#meta-saved"), dc) ?? 0);
      if (!Number.isFinite(saved)) { toast("Informe um valor guardado válido."); return; }
      if (editingMetaId) {
        const m = ds.metas.find((x) => x.id === editingMetaId);
        if (m) { m.name = name; m.target = Math.abs(target); m.saved = saved; m.currency = dc; delete m.category; }
        message = "Meta atualizada ✔";
      } else {
        ds.metas.push({ id: uid(), name, target: Math.abs(target), saved, currency: dc });
        message = "Meta criada ✔";
      }
    }
    saveCur();
    $("#modal-meta").classList.add("hidden");
    editingMetaId = null;
    renderMetas();
    toast(message);
  }

  // Meta vinculada: registrar PAGAMENTO recebido = receita na categoria do amigo
  function addPaymentToMeta(m) {
    ensureCat(ds, m.category);
    openTxModal(null, {
      title: `Pagamento de ${m.name}`,
      type: "receita",
      category: m.category,
      desc: "Pagamento — " + m.name,
    });
  }

  // Meta vinculada: lançar um GASTO manual (dívida) = despesa na categoria do amigo
  function addChargeToMeta(m) {
    ensureCat(ds, m.category);
    openTxModal(null, {
      title: `Gasto de ${m.name}`,
      type: "despesa",
      category: m.category,
    });
  }

  // Meta de poupança: aporte manual (só atualiza o guardado, sem virar transação)
  function addToMeta(m) {
    if (m.category) { addPaymentToMeta(m); return; }
    const dc = isDefaultMode() ? normCur(m.currency) : dispCur();
    askName(`Quanto adicionar em "${m.name}"?`, "", (v) => {
      const n = moneyStrValue(v, dc); // valor digitado na moeda do painel
      if (!Number.isFinite(n) || n <= 0) { toast("Valor inválido 💰"); return; }
      // O modal pode permanecer aberto durante uma sincronização.
      const current = ds.metas.find((meta) => meta.id === m.id);
      if (!current || current.category) { toast("Esta meta mudou. Abra a meta novamente para adicionar o valor."); return; }
      // Converte para a moeda em que a meta está guardada antes de somar
      const add = convertAmount(n, dc, current.currency);
      if (!Number.isFinite(add)) { toast("Aguardando cotação automática. Você também pode adicionar na moeda original da meta."); return; }
      const scale = 10 ** curFrac(current.currency);
      current.saved = Math.round((Number(current.saved || 0) + add) * scale) / scale;
      saveCur();
      renderMetas();
      if (current.saved >= current.target - 0.004) toast("🎉 Parabéns! Meta \"" + current.name + "\" alcançada!");
      else toast(`${fmtMoney(n, dc)} adicionados à meta ✔`);
    }, { money: true, currency: dc });
  }

  /* ---------- Modal de limite ---------- */
  function openLimitModal(id) {
    editingLimitId = id;
    const L = id ? ds.limits.find((x) => x.id === id) : null;
    const v = L ? versionFor(L, refMonth()) : null; // valores vigentes no mês em vista
    $("#modal-limit-title").textContent = L ? "Editar limite" : "Novo limite";
    $("#limit-name").value = L ? L.name : "";
    // Mantém a moeda original para preservar inclusive o histórico de limites.
    const dc = limitEditCurrency = L ? normCur(L.currency) : entryCur();
    $("#limit-amount").parentElement.childNodes[0].nodeValue = `Valor do limite (${CURRENCIES[dc].symbol}) `;
    setMoneyMaskCurrency($("#limit-amount"), dc);
    $("#limit-amount").value = v ? fmtMoneyInput(v.amount, dc) : "";
    $("#limit-cats").innerHTML = ds.categories.map((c) => {
      const checked = v && v.categories.some((x) => stripAccents(x) === stripAccents(c.name));
      return `<label><input type="checkbox" value="${escapeHtml(c.name)}" ${checked ? "checked" : ""}>
        <span class="sum-dot" style="background:${c.color}"></span> ${escapeHtml(c.name)}</label>`;
    }).join("");

    // Escopo: só faz sentido ao editar um limite existente no modo "por mês"
    const showScope = !!L && fil.mode === "month" && !!fil.month;
    $("#limit-scope-wrap").classList.toggle("hidden", !showScope);
    if (showScope) {
      $("#limit-scope-month").textContent = fmtMonthLong(fil.month);
      $$('input[name="limit-scope"]').forEach((r) => { r.checked = r.value === "from"; });
    }

    $("#modal-limit").classList.remove("hidden");
    setTimeout(() => $("#limit-name").focus(), 50);
  }

  function saveLimitModal() {
    const dc = limitEditCurrency;
    const amount = moneyInputValue($("#limit-amount"), dc);
    if (!Number.isFinite(amount) || amount <= 0) { toast("Informe o valor do limite 💰"); $("#limit-amount").focus(); return; }
    const cats = $$("#limit-cats input:checked").map((i) => i.value);
    if (!cats.length) { toast("Selecione pelo menos uma categoria 🏷️"); return; }
    let name = $("#limit-name").value.trim();
    if (!name) name = cats.join(" + ");
    const newVals = { amount: Math.abs(amount), categories: cats };
    let message;

    if (editingLimitId) {
      const L = ds.limits.find((x) => x.id === editingLimitId);
      if (L) {
        L.name = name;
        const scopeFrom = fil.mode === "month" && fil.month &&
          $('input[name="limit-scope"]:checked')?.value === "from";
        if (scopeFrom) {
          // Deste mês em diante: mantém valores e moeda do histórico.
          const M = fil.month;
          L.versions = (L.versions || [])
            .filter((vv) => vv.from < M)
            .concat([{ from: M, ...newVals }])
            .sort((a, b) => a.from.localeCompare(b.from));
          message = `Limite atualizado a partir de ${fmtMonthLong(M)} ✔`;
        } else {
          L.versions = [{ from: "0000-00", ...newVals }];
          message = "Limite atualizado em todos os meses ✔";
        }
        L.currency = dc;
        // Campos de topo refletem a versão mais recente (compatibilidade)
        const last = L.versions[L.versions.length - 1];
        L.amount = last.amount;
        L.categories = last.categories;
      }
    } else {
      ds.limits.push({
        id: uid(), name, ...newVals, currency: dc,
        versions: [{ from: "0000-00", ...newVals }],
      });
      message = "Limite criado ✔";
    }
    saveCur();
    $("#modal-limit").classList.add("hidden");
    editingLimitId = null;
    renderAll();
    toast(message);
  }

  /* ---------- Tabela ---------- */
  function sortTxs(list) {
    const { key, dir } = sort;
    return list.slice().sort((a, b) => {
      let va = a[key], vb = b[key];
      if (key === "date") { va = accountingDate(a); vb = accountingDate(b); }
      if (key === "amount") {
        va = a.type === "despesa" ? -dispAmount(a) : dispAmount(a);
        vb = b.type === "despesa" ? -dispAmount(b) : dispAmount(b);
        if (!Number.isFinite(va) || !Number.isFinite(vb)) {
          // Valores sem conversão vêm após os comparáveis; entre eles,
          // agrupa pela moeda original antes de ordenar o valor nominal.
          if (Number.isFinite(va)) return -1;
          if (Number.isFinite(vb)) return 1;
          const byCurrency = normCur(a.currency).localeCompare(normCur(b.currency));
          return byCurrency || (a.amount - b.amount) * dir;
        }
        return (va - vb) * dir;
      }
      va = String(va ?? ""); vb = String(vb ?? "");
      const cmp = va.localeCompare(vb, "pt-BR");
      return cmp !== 0 ? cmp * dir : a.date.localeCompare(b.date) * dir;
    });
  }

  /* ---------- Avatar de categoria (círculo colorido + ícone, estilo Mobills) ----------
     Ícone escolhido por palavra-chave no nome da categoria; o círculo usa a
     cor da própria categoria. Ícones são linhas brancas (mesmo traço do app). */
  const CAT_ICON_SVG = {
    food: '<path d="M8 3v18M6 3v6a2 2 0 0 0 4 0V3M16 3c-1.4 0-2 1.8-2 4.5S15 12 16 12v9"/>',
    cart: '<circle cx="9" cy="20" r="1.3"/><circle cx="17" cy="20" r="1.3"/><path d="M2 3h2.3l2 12a1.5 1.5 0 0 0 1.5 1.2h8.7a1.5 1.5 0 0 0 1.5-1.2L20 7H5.5"/>',
    home: '<path d="M3 11 12 4l9 7"/><path d="M5 10v9h14v-9"/>',
    plane: '<path d="M21 4 3 11l6 2.5M21 4 11 20l-2-6.5M21 4 9 13.5"/>',
    health: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
    car: '<path d="M3 13h18l-1.6-5.2A2 2 0 0 0 17.5 6h-11a2 2 0 0 0-1.9 1.8L3 13v4h2m14 0h-2M5 17h14"/><circle cx="7.5" cy="15" r="1.2"/><circle cx="16.5" cy="15" r="1.2"/>',
    money: '<rect x="2.5" y="7" width="19" height="10" rx="2.5"/><circle cx="12" cy="12" r="2.2"/>',
    fun: '<rect x="2.5" y="8" width="19" height="9" rx="4"/><path d="M7.5 11v3M6 12.5h3M15.5 12h.01M17.5 13.5h.01"/>',
    chart: '<path d="M4 19V5M4 19h16M7.5 15l3.5-3.5 3 2 4.5-5.5"/>',
    tool: '<path d="M14.5 6.5a3.5 3.5 0 0 0-4.6 4.6L4 17v3h3l5.9-5.9a3.5 3.5 0 0 0 4.6-4.6l-2.5 2.5-2-2 2.5-2.5z"/>',
    receipt: '<path d="M6 3h12v18l-2.5-1.6L13 21l-2.5-1.6L8 21l-2-1.6V3z"/><path d="M9 8h6M9 12h6"/>',
    people: '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-5 6-5s6 1.7 6 5"/><path d="M16 5.5a3 3 0 0 1 0 5.5M21 20c0-2.4-1.4-4.1-3.6-4.8"/>',
    box: '<path d="M3 8l9-4 9 4-9 4-9-4z"/><path d="M3 8v8l9 4 9-4V8M12 12v8"/>',
    mega: '<path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1z"/><path d="M15 8.5a5 5 0 0 1 0 7"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.2 5.2l2.1 2.1M16.7 16.7l2.1 2.1M18.8 5.2l-2.1 2.1M7.3 16.7l-2.1 2.1"/>',
    monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    tv: '<rect x="3" y="7" width="18" height="12" rx="2"/><path d="M8 3l4 4 4-4"/>',
    gift: '<path d="M4 11h16v9H4zM2 7h20v4H2zM12 7V20M12 7S10.5 3 8.5 3 6 5.5 8.5 7M12 7s1.5-4 3.5-4S18 5.5 15.5 7"/>',
    cap: '<path d="M12 4 2 9l10 5 10-5-10-5z"/><path d="M6 11v5c0 1.1 2.7 2.5 6 2.5s6-1.4 6-2.5v-5"/>',
    paw: '<circle cx="7" cy="9" r="1.6"/><circle cx="12" cy="7" r="1.6"/><circle cx="17" cy="9" r="1.6"/><path d="M12 12c-2.6 0-5 2-5 4.6C7 18.5 9 20 12 20s5-1.5 5-3.4C17 14 14.6 12 12 12z"/>',
    tag: '<path d="M3 12l8.6-8.6a2 2 0 0 1 1.4-.6H19a2 2 0 0 1 2 2v6a2 2 0 0 1-.6 1.4L12 20.8a2 2 0 0 1-2.8 0L3 14.6a2 2 0 0 1 0-2.6z"/><circle cx="16" cy="8" r="1.3"/>',
  };
  const CAT_ICON_RULES = [
    [/aliment|comida|superm|mercado|restaur|lanche|food|refei|padaria|bar\b/, "food"],
    [/compra|essencial|shopping/, "cart"],
    [/morad|casa|alug|lar\b|imovel|rent|conta.*casa/, "home"],
    [/viagem|viaje|travel|passag|turis|hotel|ferias/, "plane"],
    [/saude|farmac|medic|hospital|dentist|remedio|plano de saude/, "health"],
    [/transport|uber|combustivel|gasolina|carro|onibus|metro|taxi|posto/, "car"],
    [/salario|renda|pro-labore|pro labore|prolabore|freela|honorario|receita de vend|vendas?\b|faturamento/, "money"],
    [/lazer|divers|entreten|jogo|game|cinema|festa|hobby/, "fun"],
    [/servico|manuten|reparo|conserto/, "tool"],
    [/imposto|taxa|tributo|fiscal|das\b|darf/, "receipt"],
    [/folha|pagamento de pessoal|colaborador|funcionar|equipe|rh\b/, "people"],
    [/fornecedor|insumo|estoque|materia/, "box"],
    [/marketing|anuncio|publicidade|ads?\b|trafego|propaganda/, "mega"],
    [/operacional|operac|logistica|infra/, "gear"],
    [/software|assinatura|saas|sistema|licenca|app\b|tecnologia/, "monitor"],
    [/streaming|netflix|spotify|youtube|prime|disney|tv\b/, "tv"],
    [/presente|gift|doacao|caridade/, "gift"],
    [/educa|curso|escola|faculdade|estudo|livro/, "cap"],
    [/pet|animal|cachorro|gato|veterin/, "paw"],
    [/receita|entrada|ganho|invest|dividendo|lucro/, "chart"],
  ];
  function catIcon(name) {
    const key = stripAccents(name);
    for (const [re, ic] of CAT_ICON_RULES) if (re.test(key)) return CAT_ICON_SVG[ic];
    return CAT_ICON_SVG.tag;
  }
  function catAvatar(name) {
    return `<span class="tx-avatar" style="background:color-mix(in srgb, ${catColor(ds, name)} 20%, var(--card,#24212e));color:var(--chip-text,var(--text,#f1eff5))">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${catIcon(name)}</svg>
    </span>`;
  }

  function billPayButton(t, confirming = false) {
    if (confirming) return `<button type="button" class="bill-pay is-paid" aria-disabled="true">${uiIcon("check", 15)} Pago</button>`;
    const pending = isPendingBill(t);
    const label = (pending ? "Marcar como paga" : "Reabrir conta") + " · " + t.desc + (t.invoice ? " · " + fmtMonthLong(t.invoice.month) : "");
    return `<button type="button" class="bill-pay ${pending ? "is-open" : "is-paid"}" data-bill-action="${pending ? "pay" : "reopen"}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">${uiIcon("check", 15)} ${pending ? "Marcar como paga" : "Pago"}</button>`;
  }

  function invoiceBill(invoice, today) {
    const payment = ds.c6InvoicePayments?.[invoice.month];
    const remaining = {};
    for (const currency of CURRENCY_CODES) {
      const amount = (invoice.totals[currency] || 0) - (payment?.totals[currency] || 0);
      const rounded = Number(amount.toFixed(curFrac(currency)));
      if (rounded) remaining[currency] = rounded;
    }
    const open = Object.values(remaining).some(amount => amount > 0);
    const current = invoice.startDate <= today && today <= invoice.closingDate;
    if (!open && !payment && !current) return null;
    const paidOn = payment?.paidOn;
    const version = [paidOn, ...CURRENCY_CODES.map(c => `${invoice.totals[c] || 0}/${payment?.totals[c] || 0}`)].join("|");
    return {
      id:"c6-invoice:" + invoice.month, type:"despesa", desc:"Cartão de crédito C6",
      date:invoice.dueDate, paidOn, paymentStatus:open ? "pending" : payment ? "paid" : "empty",
      invoice, version, amounts:open || !payment ? remaining : payment.totals,
      status:!open && payment ? "Paga" : (current ? "Aberta" : "Fechada") + (payment ? " · Saldo a pagar" : ""),
    };
  }

  function billDueDate(t) {
    return t.advance?.scheduledDate || t.date;
  }

  function billRow(t, today, confirming = false) {
    const pending = isPendingBill(t);
    const empty = t.paymentStatus === "empty";
    const date = billDueDate(t);
    const [year, month, day] = date.split("-");
    const monthLabel = MESES_ABREV[Number(month) - 1] + (year === today.slice(0,4) ? "" : "/" + year);
    const when = "Vencimento em " + fmtDate(date);
    const invoice = t.invoice;
    const paidOn = t.paymentStatus === "paid" && (t.paidOn || t.advance?.paidDate);
    const paidLabel = paidOn && "Pago em " + fmtDate(paidOn);
    const reference = invoice ? "" : resolvedBillMonth(t);
    const details = invoice
      ? [fmtMonthLong(invoice.month), t.status, (invoice.dueDateObserved ? "Vencimento " : "Vencimento previsto ") + fmtDate(date), paidLabel]
      : [t.account, t.category, paidLabel, reference && "Ref. " + fmtMonth(reference), t.installment && "Parcela " + t.installment];
    const detail = details.filter(Boolean).join(" · ");
    const period = invoice ? (invoice.closingDateObserved ? "Período" : "Período previsto") + " de " +
      fmtDate(invoice.startDate).slice(0,5) + " a " + fmtDate(invoice.closingDate).slice(0,5) : "";
    const amount = invoice ? Object.entries(t.amounts).filter(([,v]) => v).map(([c,v]) =>
      c === "BRL" ? fmtBRL(v) : fmtTxAmount({amount:v, currency:c})).join(" / ") || fmtBRL(0) : fmtTxAmount(t);
    const invoiceData = invoice ? ` data-invoice-month="${invoice.month}" data-invoice-version="${escapeHtml(t.version)}" data-folder="${escapeHtml(ds.id)}"` : "";
    return `<div class="bill-row ${pending ? "bill-open" : empty ? "bill-current" : "bill-settled"}" data-id="${escapeHtml(t.id)}"${invoiceData}${pending ? ' title="Dois cliques ou dois toques para marcar como paga"' : ""}>
      <time class="bill-date" datetime="${date}" title="${when}" aria-label="${when}"><b>${day}</b><span>${monthLabel}</span></time>
      <div class="bill-title"><strong>${escapeHtml(t.desc)}</strong>${detail ? `<small>${escapeHtml(detail)}</small>` : ""}${period ? `<small>${escapeHtml(period)}</small>` : ""}</div>
      <b class="bill-amount">${escapeHtml(amount)}</b><div class="bill-actions">${empty ? '<small>Sem valor a pagar</small>' : billPayButton(t, confirming)}</div>
    </div>`;
  }

  let billMidnightTimer;
  let billCalendarDate = "";
  const billConfirmations = new Map(); // Só a apresentação espera. O pagamento já está salvo.
  function renderBillBoard(invoiceCycles) {
    const panel = $("#dash-bills");
    if (!ds || !panel) return;
    const today = todayISO();
    if (!invoiceCycles && billCalendarDate !== today) { renderAll(); return; }
    const currentMonth = today.slice(0,7);
    const month = fil.mode === "month" && fil.month ? fil.month : currentMonth;
    const cycles = invoiceCycles || InstallmentSchedule.c6Invoices(ds.transactions, today);
    // Após o fechamento, a fatura a vencer e a nova em curso coexistem.
    const started = cycles.filter(i => i.month >= "2026-11" && i.startDate <= today);
    const invoices = [];
    const pastDue = [];
    for (const i of started) {
      const bill = invoiceBill(i, today);
      if (!bill) continue;
      if (i.month === month || i.dueDate.slice(0,7) === month || month === currentMonth && today <= i.closingDate) {
        invoices.push(bill);
      } else if (month === currentMonth && i.dueDate < today && (isPendingBill(bill) || billConfirmations.has(bill.id))) {
        pastDue.push(bill);
      }
    }
    const bills = ds.transactions.filter(t => t.paymentStatus && !groupedC6Ids.has(t.id) && billDueDate(t).slice(0,7) === month).concat(invoices);
    const active = bills.filter(isPendingBill);
    const settled = bills.filter(t => t.type === "despesa" && t.paymentStatus === "paid")
      .sort((a,b) => accountingDate(b).localeCompare(accountingDate(a)));
    const confirmingInAgenda = t => billConfirmations.get(t.id)?.source === "agenda";
    const visible = [...active, ...settled.filter(confirmingInAgenda)].sort((a,b) => billDueDate(a).localeCompare(billDueDate(b)));
    const historyItems = settled.filter(t => !confirmingInAgenda(t));
    const count = active.length;
    const header = `<div class="bill-head"><div class="bill-heading"><span class="bill-emblem">${uiIcon("calendar", 24)}</span><div><h2>Contas a pagar</h2>
      <p>${fmtMonthLong(month)} · ${count ? (count === 1 ? "1 conta em aberto" : count + " contas em aberto") : "Nenhuma pendente"}</p></div></div>
      <button type="button" class="btn bill-add" data-bill-action="new" aria-label="Nova conta a pagar">${uiIcon("plus", 16)} Nova conta</button></div>`;
    const groups = [
      ["late", "Em atraso", visible.filter(t => billDueDate(t) < today)],
      ["today", "Vencem hoje", visible.filter(t => billDueDate(t) === today)],
      ["upcoming", "Próximos vencimentos", visible.filter(t => billDueDate(t) > today)],
      ["cycle", "Fatura em andamento", invoices.filter(t => t.paymentStatus === "empty")],
    ];
    const agenda = groups.filter(([, , items]) => items.length).map(([key, label, items]) =>
      `<section class="bill-group" data-due="${key}"><h3>${label}</h3>${items.map(t => billRow(t, today, t.paymentStatus === "paid")).join("")}</section>`).join("");
    const list = agenda ? `<div class="bill-list bill-agenda">${agenda}</div>` :
      `<div class="bill-empty"><span class="bill-empty-icon">${uiIcon("check", 17)}</span>
        <p>${settled.length ? "Todas as contas deste mês estão pagas." : "Nenhuma conta a pagar neste mês."}</p></div>`;
    const expanded = panel.querySelector(".bill-history[data-paid]")?.open;
    const overdue = pastDue.length ? `<details class="bill-history bill-overdue" ${panel.querySelector(".bill-overdue")?.open ? "open" : ""}><summary>${uiIcon("calendar", 17)} Faturas anteriores em atraso (${pastDue.length}) <span class="bill-chevron">${uiIcon("down", 16)}</span></summary>
      <div class="bill-list">${pastDue.map(t => billRow(t, today, !isPendingBill(t))).join("")}</div></details>` : "";
    const history = historyItems.length ? `<details class="bill-history" data-paid ${expanded ? "open" : ""}><summary>${uiIcon("history", 17)} Contas pagas (${historyItems.length}) <span class="bill-chevron">${uiIcon("down", 16)}</span></summary>
      <div class="bill-list">${historyItems.map(t => billRow(t, today)).join("")}</div></details>` : "";
    const scroll = panel.querySelector(".bill-agenda")?.scrollTop || 0;
    const focused = document.activeElement;
    const refocus = focused && panel.contains(focused);
    const focusedRow = refocus && focused.closest(".bill-row")?.dataset.id;
    panel.innerHTML = header + overdue + list + history;
    if (scroll && agenda) panel.querySelector(".bill-agenda").scrollTop = scroll;
    if (refocus) {
      const sameRow = Array.from(panel.querySelectorAll(".bill-row")).find(row => row.dataset.id === focusedRow && !row.closest("details:not([open])"));
      const fallback = focused.matches("summary") ? "summary" : focusedRow ? ".bill-agenda button, summary" : ".bill-add";
      const next = sameRow?.querySelector("button") || panel.querySelector(fallback);
      (next || panel.querySelector(".bill-add")).focus({preventScroll:true});
    }
    clearTimeout(billMidnightTimer);
    const midnight = new Date();
    midnight.setHours(24, 0, 0, 0);
    billMidnightTimer = setTimeout(() => { if (ds) renderAll(); }, Math.max(1, midnight.getTime() - Date.now()));
  }

  function changeAgendaBill(row, action) {
    if (!row.dataset.invoiceMonth) {
      changeBill(row.dataset.id, action, "agenda");
      return;
    }
    if (row.dataset.folder !== ds?.id || !refreshImportTarget()) return;
    const today = todayISO();
    const month = row.dataset.invoiceMonth;
    const invoice = InstallmentSchedule.c6Invoices(ds.transactions, today).find(i => i.month === month);
    if (!invoice || month < "2026-11" || invoice.startDate > today) return;
    const bill = invoiceBill(invoice, today);
    if (!bill || bill.paymentStatus === "empty" || action !== (isPendingBill(bill) ? "pay" : "reopen")) return;
    if (bill.version !== row.dataset.invoiceVersion) {
      renderBillBoard();
      toast("O valor da fatura mudou. Confira o saldo atualizado.");
      return;
    }
    if (action === "pay") {
      ds.c6InvoicePayments ||= {};
      ds.c6InvoicePayments[month] = {paidOn:today, totals:{...invoice.totals}};
    } else {
      delete ds.c6InvoicePayments[month];
    }
    finishBillChange(bill.id, action, "agenda");
    toast(action === "pay" ? "Fatura C6 marcada como paga." : "Fatura C6 reaberta.");
  }

  function changeBill(id, action, source) {
    if (!refreshImportTarget()) return;
    const t = ds.transactions.find(tx => tx.id === id);
    if (!t) { toast("Esta conta não está mais na pasta."); return; }
    const previous = {pay:"pending", reopen:"paid"};
    if (groupedC6Ids.has(id) || t.type !== "despesa" || !Object.hasOwn(previous, action) || previous[action] !== t.paymentStatus) return;
    t.paymentStatus = action === "pay" ? "paid" : "pending";
    if (action === "pay") t.paidOn = todayISO(); else delete t.paidOn;
    finishBillChange(id, action, source);
    toast(action === "pay" ? "Conta paga. Despesa contabilizada." : "Conta em aberto. O valor só entra nas despesas após o pagamento.");
  }

  function finishBillChange(id, action, source) {
    saveCur();
    clearTimeout(billConfirmations.get(id)?.timer);
    billConfirmations.delete(id);
    if (action === "pay" && source) {
      const timer = setTimeout(() => {
        billConfirmations.delete(id);
        if (source === "agenda") renderBillBoard(); else renderTable();
      }, 1600);
      billConfirmations.set(id, {source, timer});
    }
    renderAll();
    if (action === "pay" && source) {
      const selector = source === "agenda" ? "#dash-bills .bill-row" : "#tx-tbody tr";
      $$(selector).find(row => row.dataset.id === id)?.classList.add("bill-just-paid");
    }
  }

  function transactionDateCell(t) {
    const date = accountingDate(t);
    const label = date === t.date && cleanDateEstimate(t).dateEstimated
      ? '<span title="Data aproximada">' + fmtDate(date) + '</span>'
      : fmtDate(date);
    if (installmentTotal(t) > 1 && isValidISODate(t.purchaseDate)) {
      return label + '<br><span title="Data da compra">Cpr. ' + fmtDate(t.purchaseDate) + '</span>';
    }
    return label;
  }

  function historicalOrigins(transactions) {
    const matches = new Map();
    function note(key, label, index) {
      const id = JSON.stringify(key);
      if (!matches.has(id)) matches.set(id,{label,indices:[]});
      matches.get(id).indices.push(index);
    }
    transactions.forEach((tx,index) => {
      const ref = typeof tx.referenceId === "string" && tx.referenceId.trim();
      const account = stripAccents(tx.account).replace(/\s+/g," ");
      if (ref && !/^(?:[-–—]+|n\/?a|s\/?n|sem refer[eê]ncia|null|undefined)$/i.test(ref) && account &&
          isValidISODate(tx.date) && !tx.dateEstimated && Number.isFinite(tx.amount) &&
          CURRENCY_CODES.includes(tx.currency) && ["receita","despesa"].includes(tx.type)) {
        const bank = ["banco c6","c6 bank"].includes(account) ? "c6" : account;
        note(["banco",bank,ref,tx.date,tx.amount,tx.currency,tx.type,tx.installment || "",tx.c6Section || "",tx.billClosingDate || ""],
          "Referência bancária " + ref + " · mesma conta, data, valor, moeda, tipo e parcela",index);
      }
      const week = tx.weeklyRevenue && tx.weeklySource;
      if (week && typeof week.account === "string" && week.account.trim() && isValidISODate(week.date) && CURRENCY_CODES.includes(week.currency)) {
        note(["planilha",stripAccents(week.account),week.date,week.currency],
          "Mesma célula da planilha · " + week.account + " · semana de " + fmtDate(week.date) + " · " + week.currency,index);
      }
      const photo = tx.photoSource;
      if (photo && /^[a-f0-9]{64}$/.test(photo.hash) && /^[a-f0-9]{32}$/.test(photo.row) &&
          Number.isSafeInteger(photo.occurrence) && photo.occurrence > 0) {
        note(["foto",photo.hash,photo.row,photo.occurrence],"Mesma foto, linha e ocorrência (" + photo.occurrence + ")",index);
      }
    });
    const groups = new Map();
    for (const {label,indices} of matches.values()) {
      if (indices.length < 2) continue;
      // Se duas evidências apontam exatamente para o mesmo grupo, exiba-o uma vez.
      const id = indices.join(",");
      if (!groups.has(id)) groups.set(id,{labels:[],items:indices.map(i => transactions[i])});
      groups.get(id).labels.push(label);
    }
    return [...groups.values()];
  }
  function closeOriginReview() {
    $("#tx-origin-review").open = false;
    $("#tx-origin-results").innerHTML = "";
    $("#tx-origin-status").textContent = "";
    originPage = 0; originGroups = [];
  }
  function refreshOriginReview() {
    if (!ds || !$("#tx-origin-review").open) return;
    originGroups = historicalOrigins(ds.transactions);
    renderOriginPage();
  }
  function renderOriginPage() {
    const size = 20, count = originGroups.reduce((sum,g) => sum + g.items.length,0);
    const pages = Math.max(1,Math.ceil(count/size));
    originPage = Math.min(Math.max(0,originPage),pages-1);
    const start = originPage*size, end = start+size;
    let offset = 0, html = "";
    for (const group of originGroups) {
      const first = Math.max(0,start-offset), last = Math.min(group.items.length,end-offset);
      offset += group.items.length;
      if (last > first) {
        html += '<section><h4>' + escapeHtml(group.labels.join(" / ")) + '</h4><ul>' + group.items.slice(first,last).map(tx =>
          '<li><span><strong>' + escapeHtml(tx.desc || "Sem descrição") + '</strong><small>' + escapeHtml([fmtDate(tx.date),tx.account,tx.installment && "Parcela "+tx.installment].filter(Boolean).join(" · ")) +
          '</small></span><span class="origin-amount">' + (tx.type === "despesa" ? "− " : "+ ") + escapeHtml(fmtTxAmount(tx)) + '</span></li>'
        ).join("") + '</ul></section>';
      }
      if (offset >= end) break;
    }
    $("#tx-origin-results").innerHTML = html;
    $("#tx-origin-prev").classList.toggle("hidden",pages===1);
    $("#tx-origin-next").classList.toggle("hidden",pages===1);
    $("#tx-origin-prev").disabled = originPage===0;
    $("#tx-origin-next").disabled = originPage===pages-1;
    $("#tx-origin-status").textContent = count ? originGroups.length +
      (originGroups.length===1 ? " grupo com origem coincidente" : " grupos com origem coincidente") +
      (pages>1 ? " · Página " + (originPage+1) + " de " + pages : "") :
      "Nenhuma coincidência encontrada entre as referências bancárias, semanas de origem e fotos identificadas.";
  }

  function renderTable() {
    renderTableFilters();
    const list = sortTxs(tableTxs());
    const matchingIds = new Set(list.map((t) => t.id));
    // Seleções ocultas por um filtro jamais participam de exclusão em lote.
    [...selectedTx].forEach((id) => { if (!matchingIds.has(id)) selectedTx.delete(id); });
    $("#tx-count").textContent = list.length;
    const exportBtn = $("#btn-export-csv");
    if (exportBtn) exportBtn.disabled = !list.length;

    $$("#tx-table thead th[data-sort]").forEach((th) => {
      th.querySelector(".sort-ind").textContent = th.dataset.sort === sort.key ? (sort.dir === 1 ? "▲" : "▼") : "";
      th.setAttribute("aria-sort", th.dataset.sort === sort.key ? (sort.dir === 1 ? "ascending" : "descending") : "none");
    });

    const tbody = $("#tx-tbody");
    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="empty-table">${ds.transactions.length ? "Nenhuma transação corresponde aos filtros.<br>Experimente outro mês ou ajuste a busca, o tipo e a conta." : "Seu histórico começa aqui.<br>Adicione a primeira receita ou despesa para acompanhar suas finanças."}</td></tr>`;
      $("#btn-more-rows").classList.add("hidden");
      $("#tx-sel-all").checked = false;
      $("#tx-sel-all").indeterminate = false;
      updateBulkBar();
      return;
    }
    const visible = list.slice(0, rowLimit);
    tbody.innerHTML = visible.map((t) => {
      const sel = selectedTx.has(t.id);
      const paid = !groupedC6Ids.has(t.id) && t.type === "despesa" && t.paymentStatus === "paid";
      const title = `<span class="tx-desc-text">${escapeHtml(t.desc) || '<span class="tx-desc-empty">Sem descrição</span>'}${t.creditKind === "card_payment" ? '<small class="hint">Pg recebido</small>' : ""}${t.cashback ? `<small class="hint cashback-info">Cashback: ${escapeHtml(String(t.cashback.amount))} ${escapeHtml(t.cashback.currency)} · informativo</small>` : ""}</span>`;
      return `
      <tr data-id="${escapeHtml(t.id)}" class="${sel ? "tx-selected" : ""}${paid ? " bill-settled" : ""}">
        <td class="tx-check-col"><input type="checkbox" class="tx-sel" aria-label="Selecionar ${escapeHtml(t.desc)}" data-id="${escapeHtml(t.id)}" ${sel ? "checked" : ""}></td>
        <td style="white-space:nowrap">${transactionDateCell(t)}</td>
        <td><span class="tx-desc-cell">${catAvatar(t.category)}${paid
          ? `<span class="tx-paid-caption">${title}${billPayButton(t, billConfirmations.get(t.id)?.source === "transactions")}</span>`
          : title}</span></td>
        <td><span class="cat-chip" style="background:color-mix(in srgb, ${catColor(ds, t.category)} 16%, var(--card,#24212e));color:var(--chip-text,var(--text,#f1eff5));border:1px solid color-mix(in srgb, ${catColor(ds, t.category)} 28%, var(--card,#24212e))">${escapeHtml(t.category)}</span></td>
        <td>${escapeHtml(t.account || "—")}</td>
        <td>${t.installment ? escapeHtml(t.installment) + (t.advance ? '<br><span class="fixa-chip">Adiantada</span>' : '') : (t.fixed ? '<span class="fixa-chip">Fixa</span>' : "—")}</td>
        <td class="num amount-${t.type}">${t.type === "despesa" ? "-" : "+"} ${fmtTxAmount(t)}</td>
        <td class="tx-actions">
          ${pendingIndividualBill(t) ? billPayButton(t) : ""}
          <button class="btn-icon" data-action="edit" title="Editar" aria-label="Editar transação">${uiIcon("edit")}</button>
          ${installmentTotal(t) > 1 ? `<button class="btn-icon" data-action="advance" title="Adiantar parcelas" aria-label="Adiantar parcelas">${uiIcon("advance")}</button>` : ""}
          <button class="btn-icon" data-action="delete" title="Excluir" aria-label="Excluir transação">${uiIcon("trash")}</button>
        </td>
      </tr>`;
    }).join("");
    $("#btn-more-rows").classList.toggle("hidden", list.length <= rowLimit);
    $("#btn-more-rows").textContent = `Mostrar mais (${list.length - visible.length} restantes)`;

    // "selecionar todas" reflete o estado das visíveis
    const allSel = visible.length > 0 && visible.every((t) => selectedTx.has(t.id));
    $("#tx-sel-all").checked = allSel;
    $("#tx-sel-all").indeterminate = !allSel && visible.some((t) => selectedTx.has(t.id));
    updateBulkBar();
  }

  // Mostra/atualiza a barra de ações em lote conforme a seleção
  function updateBulkBar() {
    // Remove da seleção ids que não existem mais
    const existing = new Set(ds ? ds.transactions.map((t) => t.id) : []);
    [...selectedTx].forEach((id) => { if (!existing.has(id)) selectedTx.delete(id); });
    const n = selectedTx.size;
    $("#tx-bulk-bar").classList.toggle("hidden", n === 0);
    if (n) $("#tx-bulk-count").textContent = `${n} selecionada${n === 1 ? "" : "s"}`;
  }

  function openBulkEdit() {
    if (!selectedTx.size) return;
    $("#bulk-edit-title").textContent = `Editar ${selectedTx.size} selecionada${selectedTx.size === 1 ? "" : "s"}`;

    // Mapa de categorias: uma linha por categoria presente na seleção (com a
    // contagem) e um destino próprio — assim dá para mexer só num grupo.
    const counts = Object.create(null);
    ds.transactions.forEach((t) => { if (selectedTx.has(t.id)) counts[t.category] = (counts[t.category] || 0) + 1; });
    const optsCat = ds.categories.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join("");
    const groups = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    $("#bulk-cat-map").innerHTML = groups.map((cat) => `
      <div class="bulk-map-row">
        <span class="bulk-map-from"><span class="cat-chip" style="background:color-mix(in srgb, ${catColor(ds, cat)} 16%, var(--card,#24212e));color:var(--chip-text,var(--text,#f1eff5));border:1px solid color-mix(in srgb, ${catColor(ds, cat)} 28%, var(--card,#24212e))">${escapeHtml(cat)}</span><span class="bulk-map-count">${counts[cat]}</span></span>
        <span class="bulk-map-arrow">→</span>
        <select data-from="${escapeHtml(cat)}"><option value="">Manter</option>${optsCat}</select>
      </div>`).join("");

    // Moeda: destino único aplicado a todas as selecionadas (corrige detecção errada)
    $("#bulk-cur").innerHTML = CURRENCY_CODES.map((c) =>
      `<option value="${c}">${escapeHtml(CURRENCIES[c].name)} (${escapeHtml(CURRENCIES[c].symbol)})</option>`).join("");
    $("#bulk-cur").value = entryCur();

    const accounts = Array.from(new Set([...CARDS, ...ds.transactions.map((t) => t.account).filter(Boolean)]));
    $("#bulk-acc").innerHTML = accounts.map((a) => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join("")
      + `<option value="">(sem cartão)</option>`;
    ["bulk-cat", "bulk-cur", "bulk-acc", "bulk-type"].forEach((f) => { $(`#${f}-on`).checked = false; $(`#${f}-wrap`).classList.add("hidden"); });
    $("#modal-bulk-edit").classList.remove("hidden");
  }

  function saveBulkEdit() {
    // Remapeamento de categoria por grupo: { categoria atual → destino }
    let catMap = null;
    if ($("#bulk-cat-on").checked) {
      catMap = Object.create(null);
      $$("#bulk-cat-map select").forEach((sel) => {
        if (sel.value) { catMap[sel.dataset.from] = sel.value; ensureCat(ds, sel.value); }
      });
      if (!Object.keys(catMap).length) catMap = null; // nada além de "Manter"
    }
    // Campos aplicados igualmente a todas as selecionadas
    const common = {};
    if ($("#bulk-cur-on").checked) common.currency = normCur($("#bulk-cur").value);
    if ($("#bulk-acc-on").checked) common.account = $("#bulk-acc").value;
    if ($("#bulk-type-on").checked) common.type = $("#bulk-type").value;

    if (!catMap && !Object.keys(common).length) { toast("Marque ao menos um campo para alterar ✎"); return; }

    let n = 0;
    ds.transactions.forEach((t) => {
      if (!selectedTx.has(t.id)) return;
      if (catMap && catMap[t.category] && t.category !== catMap[t.category]) {
        t.category = catMap[t.category]; t.categoryEdited = true;
      }
      Object.assign(t, common);
      n++;
    });
    $("#modal-bulk-edit").classList.add("hidden");
    selectedTx.clear();
    saveCur();
    renderAll();
    toast(`${n} transaç${n === 1 ? "ão atualizada" : "ões atualizadas"} ✔`);
  }

  /* ---------- Exclusão inteligente (fixas e parceladas) ---------- */
  function installmentIdx(t) {
    const m = (t.installment || "").match(/(\d+)\s*\/\s*(\d+)/);
    return m ? Number(m[1]) : 0;
  }
  function installmentTotal(t) {
    const m = (t.installment || "").match(/(\d+)\s*\/\s*(\d+)/);
    return m ? Number(m[2]) : 0;
  }

  // Irmãs de uma parcelada: mesmo groupId; fallback p/ dados antigos sem groupId
  function parcSiblings(tx) {
    if (tx.seriesKey) return ds.transactions.filter(t => t.seriesKey === tx.seriesKey || (tx.groupId && t.groupId === tx.groupId));
    if (tx.groupId) return ds.transactions.filter((t) => t.groupId === tx.groupId);
    const n = installmentTotal(tx);
    const originMonth = (t) => {
      const [y, m] = t.date.split("-").map(Number);
      return y * 12 + m - installmentIdx(t);
    };
    return ds.transactions.filter((t) =>
      installmentTotal(t) === n && t.desc === tx.desc && t.account === tx.account &&
      t.type === tx.type && normCur(t.currency) === normCur(tx.currency) &&
      originMonth({ ...t, date: t.advance?.scheduledDate || t.date }) === originMonth({ ...tx, date: tx.advance?.scheduledDate || tx.date }) && (t.totalValue ?? null) === (tx.totalValue ?? null));
  }

  function fixedSiblings(tx) {
    if (tx.groupId) return ds.transactions.filter((t) => t.groupId === tx.groupId);
    return ds.transactions.filter((t) => t.fixed && t.desc === tx.desc && t.account === tx.account && t.type === tx.type &&
      normCur(t.currency) === normCur(tx.currency) && t.amount === tx.amount && t.category === tx.category);
  }

  function removeTxs(ids, msg) {
    const set = new Set(ids);
    ds.transactions = ds.transactions.filter((t) => !set.has(t.id));
    saveCur();
    renderAll();
    toast(msg);
  }

  function requestDeleteTx(id) {
    const tx = ds.transactions.find((t) => t.id === id);
    if (!tx) return;

    if (tx.fixed || installmentTotal(tx) > 1) {
      pendingParcTx = { id: tx.id, folder: ds.id, owner: typeof Cloud !== "undefined" ? Cloud.getSyncState().owner : null };
      $("#modal-del-parc-title").textContent = tx.fixed ? "Excluir lançamento fixo" : "Excluir compra parcelada";
      $("#modal-del-parc-text").textContent = '"' + tx.desc + '" em ' + fmtDate(tx.date) + '. Escolha o alcance da exclusão.';
      $("#btn-delparc-one").classList.toggle("hidden", !!tx.fixed);
      $("#btn-delparc-following").textContent = tx.fixed ? "Deste mês em diante" : "Esta e as seguintes";
      $("#modal-del-parc").classList.remove("hidden");
      return;
    }

    askConfirm("Excluir transação?", `"${tx.desc}" de ${fmtTxAmount(tx)} será removida.`, () =>
      removeTxs([tx.id], "Transação excluída."));
  }

  function pendingSeriesTx(pending) {
    if (!pending || ds?.id !== pending.folder || pending.owner !== (typeof Cloud !== "undefined" ? Cloud.getSyncState().owner : null)) return null;
    return ds.transactions.find(t => t.id === pending.id);
  }
  function deletionScope(tx, mode) {
    const siblings = tx.fixed ? fixedSiblings(tx) : parcSiblings(tx);
    const fixedMonth = t => t.repeatMonth || t.date.slice(0,7);
    if (mode === "one") return [tx];
    if (mode === "all") return siblings;
    return siblings.filter(t => tx.fixed ? fixedMonth(t) >= fixedMonth(tx) : installmentIdx(t) >= installmentIdx(tx));
  }
  function deleteSeries(mode) {
    const tx = pendingSeriesTx(pendingParcTx); pendingParcTx = null;
    $("#modal-del-parc").classList.add("hidden");
    if (!tx) return;
    const chosen = deletionScope(tx,mode);
    const folder=ds.id, owner=typeof Cloud !== "undefined" ? Cloud.getSyncState().owner : null;
    askConfirm("Confirmar exclusão", chosen.length + " lançamento(s) de “" + tx.desc + "” serão excluídos. " + (mode === "all" ? "Inclui os meses anteriores e seguintes desta série." : mode === "one" ? "As outras parcelas serão mantidas." : "Os meses anteriores serão mantidos."), () => {
      if(ds?.id!==folder || owner !== (typeof Cloud !== "undefined" ? Cloud.getSyncState().owner : null)) return;
      if (!refreshImportTarget()) return;
      const current = ds.transactions.find(t => t.id === tx.id);
      const previousIds = new Set(chosen.map(t => t.id));
      const latest = current ? deletionScope(current,mode) : [];
      if (!current || latest.length !== previousIds.size || latest.some(t => !previousIds.has(t.id))) {
        toast("A série mudou em outro aparelho. Confira as ocorrências antes de excluir."); return;
      }
      if (tx.fixed && mode !== "one" && tx.groupId) {
        const anchor = ds.transactions.find(t => t.groupId === tx.groupId && t.repeatMonthlyDay);
        if (anchor) stopRenewal(anchor);
      }
      removeTxs(chosen.map(t=>t.id), chosen.length + " lançamento(s) excluído(s).");
    });
  }
  function advanceCandidates(tx,date) {
    return parcSiblings(tx).filter(t=>!t.advance && t.date>date && installmentIdx(t)>=installmentIdx(tx)).sort((a,b)=>installmentIdx(a)-installmentIdx(b));
  }
  function updateAdvance() {
    const tx=pendingSeriesTx(pendingAdvance), date=$("#advance-date").value;
    const list=tx && isValidISODate(date) ? advanceCandidates(tx,date) : [];
    const input=$("#advance-count"); input.max=String(list.length);
    if(Number(input.value)>list.length) input.value=String(list.length);
    const count=$("#advance-all").checked ? list.length : Number(input.value);
      if($("#advance-all").checked)input.value=String(list.length);
    input.disabled=$("#advance-all").checked;
    const valid=Number.isInteger(count)&&count>0&&count<=list.length;
    $("#btn-advance-save").disabled=!valid;
    $("#advance-summary").textContent=valid ? count+" parcela(s), total "+fmtTxAmount({...tx,amount:list.slice(0,count).reduce((n,t)=>n+t.amount,0)})+". Serão movidas para a data do pagamento, sem duplicar despesas." : "Escolha uma data anterior às parcelas e uma quantidade disponível.";
  }
  function openAdvance(id) {
    const tx=ds.transactions.find(t=>t.id===id);if(!tx)return;
    pendingAdvance={id,folder:ds.id,owner:typeof Cloud!=="undefined"?Cloud.getSyncState().owner:null};
    $("#advance-description").textContent=tx.desc+" · a partir da parcela "+tx.installment;
    $("#advance-date").value=todayISO();$("#advance-count").value="1";$("#advance-all").checked=false;
    updateAdvance();$("#modal-advance").classList.remove("hidden");
  }
  function saveAdvance() {
    const tx=pendingSeriesTx(pendingAdvance),date=$("#advance-date").value;if(!tx||!isValidISODate(date))return;
    const list=advanceCandidates(tx,date),count=$("#advance-all").checked?list.length:Number($("#advance-count").value);
    if(!Number.isInteger(count)||count<1||count>list.length)return;
    list.slice(0,count).forEach(t=>{
      t.advance={scheduledDate:t.date,paidDate:date};t.date=date;delete t.dateEstimated;delete t.dateEstimate;
      if(t.paymentStatus){t.paymentStatus="paid";t.paidOn=date;}
      else if(t.paidOn)t.paidOn=date;
    });
    saveCur();renderAll();pendingAdvance=null;$("#modal-advance").classList.add("hidden");toast(count+" parcela(s) adiantada(s).");
  }

  /* ---------- Modal de transação ---------- */
  let txType = "despesa";

  function populateAccountSelect(current) {
    // Nenhum cartão é presumido ao criar uma receita ou despesa.
    const extras = Array.from(new Set(
      ds.transactions.map((t) => t.account).filter((a) => a && !CARDS.includes(a))
    )).sort();
    const sel = $("#tx-account-sel");
    const opts = CARDS.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c === "C6" ? "C6 · Crédito" : c)}</option>`);
    extras.forEach((a) => opts.push(`<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`));
    opts.unshift(`<option value="">Sem conta/cartão</option>`);
    opts.push(`<option value="__other__">+ Outra conta ou cartão</option>`);
    sel.innerHTML = opts.join("");
    sel.value = current == null ? "" : current;
    if (sel.selectedIndex === -1) sel.value = "";
    $("#tx-account-other-wrap").classList.add("hidden");
    $("#tx-account-other").value = "";
  }

  // Atualiza o rótulo (símbolo) e a máscara do campo de valor conforme a moeda
  function applyTxCurrency(code) {
    code = normCur(code);
    $("#tx-amount-label").childNodes[0].nodeValue = `Valor (${CURRENCIES[code].symbol}) `;
    setMoneyMaskCurrency($("#tx-amount"), code);
  }

  // opts (opcional, só para nova transação): { category, type, desc, title }
  // usado pelos atalhos de "Adicionar gasto/pagamento" nas metas de amigo.
  function openTxModal(txId, opts) {
    if (!ds) { toast("Abra ou crie uma pasta antes de adicionar transações."); return; }
    opts = opts || {};
    editingId = txId;
    txDateEdited = false;
    const isEdit = !!txId;
    const tx = isEdit ? ds.transactions.find((t) => t.id === txId) : null;
    if (isEdit && !tx) return;
    txCategoryChosen = !!opts.category && ds.categories.some(c => c.name === opts.category);
    txInitialCategory = tx?.category || "";
    txCategoryHistory = isEdit ? null : TransactionCategories.buildHistory(ds.transactions);
    receiptRead = null;
    txModalRevision++;

    $("#modal-tx-title").textContent = isEdit ? "Editar transação" : (opts.title || "Nova transação");
    txType = isEdit ? tx.type : (opts.type === "receita" ? "receita" : "despesa");
    const paidBox = $("#tx-paid"), trackBox = $("#tx-payable");
    trackBox.checked = trackBox.defaultChecked = isEdit ? !!tx.paymentStatus : !!opts.pending;
    paidBox.checked = paidBox.defaultChecked = tx?.paymentStatus === "paid";
    $("#tx-bill-reference").open = false;
    const referenceInput = $("#tx-reference-month");
    referenceInput.value = referenceInput.defaultValue = tx?.billReferenceMonth || "";
    $("#tx-reference-repeat").checked = false;
    // Reseta o leitor de comprovante
    $("#apikey-wrap").classList.add("hidden");
    const rs = $("#receipt-status");
    rs.textContent = "";
    rs.className = "receipt-status hidden";

    // Moeda: ao editar, a da transação; nova, a do painel (a IA pode trocar via comprovante)
    const curSel = $("#tx-currency");
    curSel.innerHTML = CURRENCY_CODES.map((c) =>
      `<option value="${c}">${escapeHtml(CURRENCIES[c].name)} (${escapeHtml(CURRENCIES[c].symbol)})</option>`).join("");
    const txCurCode = isEdit ? normCur(tx.currency) : entryCur();
    curSel.value = txCurCode;
    applyTxCurrency(txCurCode);

    $("#tx-amount").value = isEdit ? fmtMoneyInput(tx.amount, txCurCode) : "";
    $("#tx-desc").value = isEdit ? tx.desc : (opts.desc || "");
    populateAccountSelect(isEdit && tx.account === "C6" && tx.c6Section === "transfer"
      ? C6_CHECKING : isEdit ? tx.account : null);

    // Data padrão: hoje se estiver no mês filtrado, senão o dia 1º do mês filtrado
    let defDate = todayISO();
    if (!isEdit && fil.mode === "month" && fil.month && defDate.slice(0, 7) !== fil.month) defDate = fil.month + "-01";
    $("#tx-date").value = isEdit ? tx.date : defDate;
    updateTypeToggle();

    // Categorias
    const catSel = $("#tx-cat");
    catSel.innerHTML = ds.categories.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join("") +
      `<option value="__new__">+ Nova categoria</option>`;
    catSel.value = isEdit && ds.categories.some((c) => c.name === tx.category) ? tx.category
      : (opts.category && ds.categories.some((c) => c.name === opts.category) ? opts.category
        : (ds.categories[0]?.name || "__new__"));
    $("#tx-newcat-wrap").classList.toggle("hidden", catSel.value !== "__new__");
    $("#tx-newcat").value = "";
    if (!isEdit) suggestTxCategory();

    $("#tx-parc-wrap").classList.toggle("hidden", isEdit);
    $("#tx-parcelado").checked = false;
    $("#tx-fixa").checked = !!tx?.fixed;
    const renew = $("#tx-renew");
    renew.checked = renew.defaultChecked = !!(tx?.fixed && tx.groupId && ds.transactions.some(t => t.groupId === tx.groupId && t.repeatMonthlyDay));
    updateFixedOption(tx);
    $("#tx-nparc-wrap").classList.add("hidden");
    $("#tx-parc-hint").classList.add("hidden");
    $("#tx-nparc").value = 2;
    updateTxHints();

    $("#modal-tx").classList.remove("hidden");
    setTimeout(() => $("#tx-amount").focus(), 50);
  }

  function suggestTxCategory(suggested = "", clearMissing = false) {
    if (editingId || txCategoryChosen || !ds?.categories.length) return;
    const category = TransactionCategories.classify({ desc: $("#tx-desc").value, type: txType }, {
      categories: ds.categories, history: txCategoryHistory, suggested,
    });
    if (ds.categories.some(c => c.name === category)) $("#tx-cat").value = category;
    else if (clearMissing) $("#tx-cat").value = "";
  }

  function formUsesC6Invoice() {
    const selected = $("#tx-account-sel").value;
    const account = selected === "__other__" ? $("#tx-account-other").value.trim() : selected;
    if (txType !== "despesa" || !account || account === C6_CHECKING) return false;
    const original = editingId && ds.transactions.find(t => t.id === editingId);
    const creditSelected = account === "C6" && (!original || original.account !== account || original.c6Section === "transfer");
    return InstallmentSchedule.isC6InvoicePayable({
      ...original, account, date:$("#tx-date").value, type:txType, desc:$("#tx-desc").value,
      ...(creditSelected && {c6Section:"card"}),
    }, ds.transactions);
  }

  function updateTypeToggle() {
    $$("#tx-type-toggle button").forEach((b) => b.classList.toggle("active", b.dataset.type === txType));
    const expense = txType === "despesa" && !formUsesC6Invoice();
    const tracked = expense && $("#tx-payable").checked;
    $("#tx-bill-options").classList.toggle("hidden", !expense);
    $("#tx-paid-wrap").classList.toggle("hidden", !tracked || !editingId);
    $("#tx-date-label").textContent = tracked ? "Vencimento" : "Data";
    const tx = editingId && ds.transactions.find(t => t.id === editingId);
    $("#tx-bill-reference").classList.toggle("hidden", !tracked);
    if (tracked) {
      const input = $("#tx-reference-month");
      const reference = resolvedBillMonth({...tx, ...receiptRead, type:txType, paymentStatus:"pending", date:$("#tx-date").value,
        desc:$("#tx-desc").value, account:$("#tx-account-sel").value, billReferenceMonth:input.value});
      $("#tx-reference-label").textContent = reference ? "Mês da despesa · " + fmtMonthLong(reference) : "Mês da despesa";
      $("#tx-reference-auto").classList.toggle("hidden", !input.value);
      $("#tx-reference-repeat-wrap").classList.toggle("hidden", !(tx?.fixed && tx.groupId));
    }
    if (tracked && tx?.fixed && tx.groupId && !$("#tx-payable").defaultChecked) {
      $("#tx-bill-hint").textContent = "Os próximos vencimentos desta série também ficarão em aberto. Cada mês entra nas despesas quando for pago.";
    } else {
      $("#tx-bill-hint").textContent = tracked
        ? "A conta aparece no dashboard. O valor entra nas despesas quando você marcar como paga."
        : "Compras no débito já entram no total ao salvar. Selecione apenas se a conta ainda precisa ser paga.";
    }
  }

  function updateFixedOption(tx) {
    const fixed = $("#tx-fixa");
    const show = !tx || (!tx.installment && (tx.fixed || txType === "despesa"));
    $("#tx-fixa-wrap").classList.toggle("hidden", !show);
    fixed.disabled = !show || !!tx?.fixed;
    if (!show) fixed.checked = false;
    else if (tx?.fixed) fixed.checked = true;
    $("#tx-fixa-label").textContent = (txType === "receita" ? "Receita fixa" : "Despesa fixa") + " (repete todo mês)";
  }

  function updateTxHints() {
    const parcOn = $("#tx-parcelado").checked;
    const fixaOn = $("#tx-fixa").checked;
    const edited = editingId && ds.transactions.find(t => t.id === editingId);
    $("#tx-renew-wrap").classList.toggle("hidden", !fixaOn || !!(edited?.fixed && !edited.groupId));
    $("#tx-nparc-wrap").classList.toggle("hidden", !parcOn);
    const hint = $("#tx-parc-hint");
    const code = normCur($("#tx-currency").value);
    const total = moneyInputValue($("#tx-amount"), code);
    const f = (v) => fmtMoney(v, code);

    if (parcOn && total && total > 0) {
      const n = Number($("#tx-nparc").value);
      const parts = splitInstallments(total, n, code);
      hint.textContent = parts
        ? `Serão ${n} lançamentos mensais de ${f(parts[0])}${parts.some((v) => v !== parts[0]) ? ` a ${f(parts[parts.length - 1])}, com ajuste de arredondamento` : ""}. Total exato: ${f(total)}.`
        : "Escolha de 2 a 48 parcelas inteiras. O valor deve permitir pelo menos uma unidade mínima da moeda por parcela.";
      hint.classList.remove("hidden");
    } else if (fixaOn) {
      const renew = $("#tx-renew");
      hint.textContent = renew.checked
        ? "Após a última ocorrência cadastrada, o app acrescenta cada mês ao abrir a pasta. Para encerrar, escolha “Deste mês em diante” ao excluir."
        : renew.defaultChecked ? "A renovação automática termina na última ocorrência cadastrada."
        : editingId
        ? ($("#tx-fixa").disabled ? "Este lançamento já faz parte de uma série mensal. Valor e vencimento podem ser editados para este mês."
          : `Este lançamento será o primeiro da série. Ao salvar, serão adicionadas ${FIXA_MESES-1} repetições mensais a partir do mês seguinte.`)
        : `Serão criados ${FIXA_MESES} lançamentos mensais${total && total > 0 ? ` de ${f(total)}` : ""}, a partir da data escolhida. Para encerrar, exclua a partir de um mês.`;
      hint.classList.remove("hidden");
    } else {
      hint.classList.add("hidden");
    }
  }

  // Divide em unidades inteiras da moeda. Distribui a sobra em vez de
  // concentrá-la na última parcela (que antes podia ficar zero ou negativa).
  function splitInstallments(amount, count, currency) {
    if (!Number.isFinite(amount) || !Number.isInteger(count) || count < 2 || count > 48) return null;
    const scale = 10 ** curFrac(currency);
    const units = Math.round(amount * scale);
    if (!Number.isSafeInteger(units) || units < count) return null;
    const base = Math.floor(units / count);
    const extra = units % count;
    return Array.from({ length: count }, (_, i) => (base + (i >= count - extra ? 1 : 0)) / scale);
  }

  function saveTxModal(approvedReceipt) {
    if (!ds || $("#modal-tx").classList.contains("hidden")) return;
    if (editingId && !refreshImportTarget()) return;
    const currency = normCur($("#tx-currency").value);
    const amount = moneyInputValue($("#tx-amount"), currency);
    if (!Number.isFinite(amount) || amount <= 0) { toast("Informe um valor válido 💰"); $("#tx-amount").focus(); return; }
    const date = $("#tx-date").value;
    if (!isValidISODate(date)) { toast("Informe uma data válida 📅"); $("#tx-date").focus(); return; }
    let parts = null;
    if (!editingId && $("#tx-parcelado").checked) {
      parts = splitInstallments(amount, Number($("#tx-nparc").value), currency);
      if (!parts) { toast("Use de 2 a 48 parcelas inteiras, com valor suficiente para cada parcela."); $("#tx-nparc").focus(); return; }
    }
    const desc = $("#tx-desc").value.trim() || "(sem descrição)";
    let category = $("#tx-cat").value;
    if (category === "__new__") {
      category = $("#tx-newcat").value.trim();
      if (!category) { toast("Dê um nome para a nova categoria 🏷️"); $("#tx-newcat").focus(); return; }
    }
    if (!category) { toast("Escolha uma categoria."); $("#tx-cat").focus(); return; }

    let account = $("#tx-account-sel").value;
    if (account === "__other__") {
      account = $("#tx-account-other").value.trim();
      if (!account) { toast("Dê um nome para o cartão/conta 💳"); $("#tx-account-other").focus(); return; }
    }
    const evidence = receiptRead ? importEvidence(receiptRead) : {};
    if (!editingId && receiptRead) {
      const owner = typeof Cloud !== "undefined" && Cloud.getSyncState ? Cloud.getSyncState().owner : null;
      if (receiptRead.folderId !== ds?.id || receiptRead.modalRevision !== txModalRevision || receiptRead.owner !== owner) {
        toast("A pasta, a conta ou o formulário mudou. Abra o comprovante novamente antes de salvar."); return;
      }
      if (!refreshImportTarget()) return;
      const candidate = { date, desc, amount: Math.abs(amount), currency, type: txType, category, account, ...evidence };
      if (typeof ImportMatch !== "undefined") {
        const matches = ImportMatch.find(candidate, existingTransactions());
        const reviewKey = JSON.stringify([ImportMatch.reviewKey(candidate, matches), candidate, parts, $("#tx-fixa").checked]);
        if (matches.length && approvedReceipt?.reviewKey !== reviewKey) {
          const folderId = ds.id, modalRevision = txModalRevision;
          const describe = t => `${fmtDate(t.date)} · ${t.desc || "Sem descrição"} · ${fmtTxAmount(t)} · ${t.account || "Sem conta/cartão"}`;
          const comparisons = matches.slice(0, 6).map((match, index) => `${index + 1}. Já lançado: ${describe(match.transaction)}\n${match.reason}`).join("\n\n");
          askConfirm("Este comprovante pode já ter sido lançado", `Novo lançamento: ${describe(candidate)}\n\n${comparisons}${matches.length > 6 ? `\n\nE mais ${matches.length - 6} coincidência(s).` : ""}\n\nConfira as operações. Adicione novamente somente se forem lançamentos distintos.`, () => {
            if (ds?.id !== folderId || txModalRevision !== modalRevision || $("#modal-tx").classList.contains("hidden")) return;
            saveTxModal({ reviewKey });
          }, { confirmLabel: "Adicionar mesmo assim" });
          return;
        }
      }
    }
    const monthlyDate = (i) => {
      const [y0, m0, d0] = date.split("-").map(Number);
      let y = y0, m = m0 + i;
      y += Math.floor((m - 1) / 12); m = ((m - 1) % 12) + 1;
      const day = Math.min(d0, daysInMonth(y, m));
      return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    };

    const edited = editingId ? ds.transactions.find(t => t.id === editingId) : null;
    if (editingId && !edited) { toast("Esta transação não está mais disponível. Abra a lista novamente."); return; }
    if (edited && !txCategoryChosen && category === txInitialCategory) category = edited.category;
    // Imported transfers retain the statement account for matching on a later import.
    const previousSelection = edited?.account === "C6" && edited.c6Section === "transfer" ? C6_CHECKING : edited?.account;
    const accountChanged = !!edited && account !== previousSelection;
    if (edited && !accountChanged) account = edited.account || "";
    const startFixed = !parts && $("#tx-fixa").checked &&
      (!edited || (txType === "despesa" && !edited.fixed && !edited.installment));
    if (startFixed && !isValidISODate(monthlyDate(FIXA_MESES-1))) { toast("Escolha uma data que permita criar a série mensal."); return; }
    category = ensureCat(ds, category).name;
    const section = !edited || accountChanged ? (account === "C6" ? "card" : undefined) : edited.c6Section;
    const fields = { amount: Math.abs(amount), date, desc, category, type: txType, currency,
      ...((edited ? edited.category !== category : txCategoryChosen) && {categoryEdited:true}),
      ...InstallmentSchedule.c6AccountFields(account, section) };
    const paidBox = $("#tx-paid"), trackBox = $("#tx-payable");
    // Controles intocados mantêm o último pagamento salvo, inclusive por outra tela.
    const tracked = !formUsesC6Invoice() && (edited && trackBox.checked === trackBox.defaultChecked ? !!edited.paymentStatus : trackBox.checked);
    const paid = edited && paidBox.checked === paidBox.defaultChecked ? edited.paymentStatus === "paid" : paidBox.checked;
    const paymentStatus = tracked ? (paid ? "paid" : "pending") : undefined;
    let paidOn = edited?.paidOn;
    if (paymentStatus === "paid" && edited?.paymentStatus !== "paid" && !isValidISODate(paidOn)) paidOn = todayISO();
    if (edited && !tracked && !edited.paymentStatus && date !== edited.date) paidOn = undefined;
    const referenceInput = $("#tx-reference-month");
    const reference = edited && referenceInput.value === referenceInput.defaultValue
      ? edited.billReferenceMonth : referenceInput.value;
    const draft = {...edited, ...fields, ...evidence, paymentStatus, paidOn, billReferenceMonth:reference};
    const bill = cleanBillFields({...fields, paymentStatus, paidOn, billReferenceMonth:reference,
      billReferenceOrigin:draft.billReferenceOrigin || legacyBillOrigin(draft)});
    const sourceBill = {...draft, ...bill, billReferenceMonth:bill.billReferenceMonth};
    const nextBill = nextDate => bill.paymentStatus ? {paymentStatus:"pending", ...nextBillReferenceField(sourceBill,nextDate)} : {};
    if (edited) {
      const applyReference = bill.paymentStatus && edited.fixed && edited.groupId && $("#tx-reference-repeat").checked;
      if (bill.paymentStatus && edited.fixed && edited.groupId && trackBox.checked && !trackBox.defaultChecked) {
        const today = todayISO(), anchorMonth = edited.date.slice(0,7);
        for (const other of ds.transactions) {
          if (other.groupId === edited.groupId && other.fixed && other.type === "despesa" &&
              !other.paymentStatus && !other.paidOn && !other.installment && other.date >= today &&
              other.date.slice(0,7) > anchorMonth && !InstallmentSchedule.isC6InvoicePayable(other,ds.transactions)) {
            Object.assign(other,nextBill(billDueDate(other)));
          }
        }
      }
      if (applyReference) {
        const due = billDueDate(sourceBill);
        for (const other of ds.transactions) {
          if (other.id === edited.id || !other.fixed || other.groupId !== edited.groupId || !isPendingBill(other) ||
              billDueDate(other) <= due || InstallmentSchedule.isC6InvoicePayable(other,ds.transactions)) continue;
          delete other.billReferenceMonth;
          Object.assign(other,nextBillReferenceField(sourceBill,billDueDate(other)));
        }
      }
      if (bill.paymentStatus && edited.fixed && edited.groupId) {
        const anchor = ds.transactions.find(t => t.groupId === edited.groupId && t.repeatMonthlyDay);
        if (anchor && applyReference) {
          // O modelo dos próximos meses é independente da despesa já lançada na âncora.
          const anchorDate = (anchor.repeatMonth || anchor.date.slice(0,7)) + "-01";
          const rule = {...sourceBill, billReferenceMonth:resolvedBillMonth(sourceBill)};
          anchor.repeatBillReferenceMonth = nextBillReferenceField(rule,anchorDate).billReferenceMonth;
        } else if (anchor === edited && !anchor.repeatBillReferenceMonth && edited.paymentStatus) {
          const previous = resolvedBillMonth(edited);
          if (previous && (previous !== resolvedBillMonth(sourceBill) || billDueDate(edited) !== billDueDate(sourceBill))) {
            const anchorDate = (anchor.repeatMonth || anchor.date.slice(0,7)) + "-01";
            anchor.repeatBillReferenceMonth = nextBillReferenceField({...edited,billReferenceMonth:previous},anchorDate).billReferenceMonth;
          }
        }
      }
      const dateChanged = txDateEdited || date !== edited.date;
      if (accountChanged) {
        delete edited.c6Section;
        delete edited.creditKind;
      }
      delete edited.paymentStatus; delete edited.paidOn; delete edited.billReferenceMonth; delete edited.billReferenceOrigin;
      if (edited.weeklyRevenue) WeeklyRevenue.rememberSource(edited);
      Object.assign(edited, fields, evidence, bill);
      if (dateChanged) { delete edited.dateEstimated; delete edited.dateEstimate; }
    }
    let message;
    let fixedGroup = edited?.fixed ? edited.groupId : null;
    if (startFixed) {
      const groupId = uid();
      fixedGroup = groupId;
      if (edited) Object.assign(edited, { groupId, fixed:true });
      for (let i = edited ? 1 : 0; i < FIXA_MESES; i++) {
        ds.transactions.push({ ...fields, id:uid(), groupId, fixed:true, date:monthlyDate(i),
          installment:null, totalValue:null, ...(i === 0 ? {...evidence, ...bill} : nextBill(monthlyDate(i))) });
      }
      message = edited ? `Despesa fixa: este lançamento e mais ${FIXA_MESES-1} meses.`
        : `${txType === "receita" ? "Receita" : "Despesa"} fixa criada para ${FIXA_MESES} meses.`;
    } else if (edited) {
      message = "Transação atualizada ✔";
    } else if (parts) {
      const n = parts.length;
      const groupId = uid();
      for (let i = 0; i < n; i++) {
        ds.transactions.push({
          ...fields, id: uid(), groupId,
          date: monthlyDate(i),
          amount: parts[i],
          installment: `${i + 1}/${n}`,
          totalValue: amount,
          ...(i === 0 ? {...evidence, ...bill} : nextBill(monthlyDate(i))),
        });
      }
      message = `Parcelamento criado: ${n} lançamentos ✔`;
    } else {
      ds.transactions.push({
        id: uid(), ...fields, installment: null, totalValue: null,
        ...evidence, ...bill,
      });
      message = "Transação adicionada ✔";
    }
    const renew = $("#tx-renew");
    if (fixedGroup && renew.checked !== renew.defaultChecked) {
      const siblings = ds.transactions.filter(t => t.fixed && t.groupId === fixedGroup);
      const active = siblings.find(t => t.repeatMonthlyDay);
      if (active && !renew.checked) stopRenewal(active);
      if (!active && renew.checked) {
        const anchors = siblings.slice().sort((a,b) => (b.repeatMonth || b.date).localeCompare(a.repeatMonth || a.date));
        const anchor = anchors[0];
        anchor.repeatMonth ||= anchor.date.slice(0,7);
        Object.assign(anchor,{repeatThrough:anchor.repeatMonth,repeatKey:uid(),repeatMonthlyDay:Number(date.slice(8))});
      }
    }
    saveCur();
    $("#modal-tx").classList.add("hidden");
    if (!editingId) { try { localStorage.setItem("fyg:entry-currency:" + ds.id, currency); } catch { /* preferência opcional */ } }
    editingId = null;
    receiptRead = null;
    txModalRevision++;
    renderAll();
    toast(message);
  }

  /* ---------- Preenchimento via comprovante (IA) ---------- */
  function getCats() {
    return ds ? ds.categories.map((c) => c.name) : DEFAULT_CATS.slice();
  }

  // Data de um item importado (comprovante avulso, foto de fatura/lista ou
  // Excel). Se a IA/planilha traz uma data real, ela é usada EXATAMENTE — assim
  // cada gasto/receita é contabilizado no dia certo. Só quando NÃO há data
  // legível é que cai no mês em vista (dia 1º), ou em hoje se for o mês atual.
  function importFallbackDate() {
    const today = todayISO();
    if (fil.mode === "month" && fil.month && fil.month !== today.slice(0, 7)) return fil.month + "-01";
    return today;
  }
  function resolveImportDate(iso) {
    return isValidISODate(iso) ? iso : importFallbackDate();
  }

  function fillTxFromReceipt(d) {
    if (!d) return;
    if (!["enviado", "recebido"].includes(d.direcao) || !CURRENCY_CODES.includes(d.moeda) || !Number.isFinite(d.valor) || d.valor <= 0) {
      toast("O comprovante não identificou valor, moeda ou direção com segurança. Confira e preencha manualmente.");
      return;
    }
    receiptRead = { ...importEvidence(d), folderId: ds?.id, modalRevision: ++txModalRevision,
      owner: typeof Cloud !== "undefined" && Cloud.getSyncState ? Cloud.getSyncState().owner : null };
    // Pix/transferência enviada = despesa (débito); comprovante de recebimento = receita
    txType = d.direcao === "recebido" ? "receita" : "despesa";
    updateTypeToggle();
    // Moeda detectada pela IA — define antes de formatar o valor
    if (d.moeda && CURRENCY_CODES.includes(d.moeda)) {
      $("#tx-currency").value = d.moeda;
      applyTxCurrency(d.moeda);
    }
    const code = normCur($("#tx-currency").value);
    if (typeof d.valor === "number" && d.valor > 0) {
      $("#tx-amount").value = fmtMoneyInput(d.valor, code);
      $("#tx-amount").dispatchEvent(new Event("input"));
    }
    // Campo ausente continua vazio para revisão; não herda data, categoria ou
    // parcelamento digitado antes da leitura de outro comprovante.
    $("#tx-date").value = isValidISODate(d.data) ? d.data : "";
    $("#tx-desc").value = String(d.descricao || "").slice(0, 120);
    suggestTxCategory(d.categoria, true);
    $("#tx-parcelado").checked = false;
    $("#tx-fixa").checked = false;
    updateFixedOption(editingId ? ds.transactions.find(t=>t.id===editingId) : null);
    updateTxHints();
    // Cartão/conta: preenche só quando a instituição bate sem ambiguidade
    // ("Nubank" sozinho não decide entre Nubank Yara e Nubank Gab)
    const inst = stripAccents(d.instituicao || "");
    const exact = CARDS.find((c) => stripAccents(c) === inst);
    const matches = inst ? CARDS.filter((c) => inst.includes(stripAccents(c)) || stripAccents(c).includes(inst)) : [];
    populateAccountSelect(exact || (matches.length === 1 ? matches[0] : ""));
    updateTypeToggle();
  }

  /* ---------- Eventos ---------- */
  document.addEventListener("DOMContentLoaded", () => {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && ds && billCalendarDate !== todayISO()) renderAll();
    });
    document.addEventListener("fyg:themechange", () => {
      if (!ds) return;
      // Apenas os canvas precisam ser recriados. Cores inline de chips e
      // avatares usam CSS vars, inclusive dentro de modais abertos. Não
      // refaz a tabela: foco, seleção, busca e valores digitados permanecem.
      renderCharts();
      renderLimits();
    });
    // Máscara de moeda (R$ 10,25) em todos os campos fixos de valor
    ["#tx-amount", "#meta-target", "#meta-saved", "#limit-amount"].forEach((s) => attachMoneyMask($(s)));

    // Navegação de mês (setas do cabeçalho e da tela de Transações)
    $("#month-prev").addEventListener("click", () => stepMonth(-1));
    $("#month-next").addEventListener("click", () => stepMonth(1));
    $("#hero-month-prev").addEventListener("click", () => stepMonth(-1));
    $("#hero-month-next").addEventListener("click", () => stepMonth(1));

    // Calendário de meses: clique no mês do cabeçalho
    $("#hero-month").addEventListener("click", (ev) => {
      ev.stopPropagation();
      if ($("#month-menu").classList.contains("hidden")) openMonthMenu();
      else $("#month-menu").classList.add("hidden");
    });
    $("#mm-prev").addEventListener("click", () => { mmYear--; renderMonthMenu(); });
    $("#mm-next").addEventListener("click", () => { mmYear++; renderMonthMenu(); });
    $("#mm-cancel").addEventListener("click", () => $("#month-menu").classList.add("hidden"));
    $("#mm-today").addEventListener("click", () => {
      receiptFilter = null;
      fil.month = todayISO().slice(0, 7);
      rowLimit = 100;
      $("#month-menu").classList.add("hidden");
      renderAll();
    });
    $("#mm-grid").addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-ym]");
      if (!b) return;
      receiptFilter = null;
      fil.month = b.dataset.ym;
      rowLimit = 100;
      $("#month-menu").classList.add("hidden");
      renderAll();
    });

    // Moeda do painel: botão "BRL ▾" no topo direito do cabeçalho
    $("#hero-cur").addEventListener("click", (ev) => {
      ev.stopPropagation();
      $("#cur-menu").classList.toggle("hidden");
    });
    $("#cur-menu").addEventListener("click", (ev) => {
      if (ev.target.closest("#btn-rates-refresh")) {
        Rates.refresh(); toast("Buscando a cotação mais recente… 🌐"); return;
      }
      const item = ev.target.closest("[data-cur]");
      if (!item) return;
      const previousCurrency = ds.displayCurrency;
      ds.displayCurrency = normDisplayCur(item.dataset.cur);
      try { Store.saveDataset(ds); } // preferência: não empilha no "Desfazer"
      catch (error) { ds.displayCurrency = previousCurrency; throw error; }
      $("#cur-menu").classList.add("hidden");
      renderAll();
      // Revalida automaticamente quando necessário, sem uma consulta por clique.
      Rates.load();
    });

    // Menu de pastas: ícone de conta no topo esquerdo (pessoa física / empresa…)
    $("#hero-acct").addEventListener("click", (ev) => {
      ev.stopPropagation();
      const menu = $("#acct-menu");
      if (menu.classList.contains("hidden")) { renderAcctMenu(); menu.classList.remove("hidden"); }
      else menu.classList.add("hidden");
    });
    $("#acct-menu").addEventListener("click", (ev) => {
      if (ev.target.closest("[data-acct-home]")) {
        $("#acct-menu").classList.add("hidden"); goHome(); return;
      }
      if (ev.target.closest("[data-create-pj]")) {
        $("#acct-menu").classList.add("hidden"); createEmpresaDataset(); return;
      }
      const item = ev.target.closest("[data-ds]");
      if (!item) return;
      $("#acct-menu").classList.add("hidden");
      if (!ds || item.dataset.ds !== ds.id) open(item.dataset.ds);
    });

    // Receitas/Despesas do cabeçalho abrem a transação já no tipo certo
    $("#hero-flow-rec").addEventListener("click", () => openTxModal(null, { type: "receita" }));
    $("#hero-flow-desp").addEventListener("click", () => openTxModal(null, { type: "despesa" }));

    // Reencaixa os valores do cabeçalho ao girar/redimensionar a tela
    window.addEventListener("resize", fitHeroFlow);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitHeroFlow);

    // Filtro de categorias
    $("#cat-filter-btn").addEventListener("click", (ev) => {
      ev.stopPropagation();
      $("#cat-dropdown").classList.toggle("hidden");
    });
    // Fecha os menus flutuantes ao clicar fora deles
    document.addEventListener("click", (ev) => {
      if (!ev.target.closest("#cat-filter")) $("#cat-dropdown").classList.add("hidden");
      if (!ev.target.closest("#month-menu") && !ev.target.closest("#hero-month")) $("#month-menu").classList.add("hidden");
      if (!ev.target.closest("#cur-menu") && !ev.target.closest("#hero-cur")) $("#cur-menu").classList.add("hidden");
      if (!ev.target.closest("#acct-menu") && !ev.target.closest("#hero-acct")) $("#acct-menu").classList.add("hidden");
    });
    $("#cat-dropdown").addEventListener("change", (ev) => {
      const cat = ev.target.dataset.cat;
      if (!cat) return;
      if (cat === "__all__") {
        fil.cats = ev.target.checked ? null : new Set();
      } else {
        if (!fil.cats) fil.cats = new Set(ds.categories.map((c) => stripAccents(c.name)));
        if (ev.target.checked) fil.cats.add(cat); else fil.cats.delete(cat);
        if (fil.cats.size === ds.categories.length) fil.cats = null;
      }
      rowLimit = 100;
      renderAll();
      $("#cat-dropdown").classList.remove("hidden"); // mantém aberto para multi-seleção
    });

    // Busca e ordenação
    $("#tx-search").addEventListener("input", (ev) => { fil.search = ev.target.value; rowLimit = 100; renderTable(); });
    $("#tx-type-filter")?.addEventListener("change", (ev) => {
      fil.type = ["receita", "despesa"].includes(ev.target.value) ? ev.target.value : "all";
      rowLimit = 100;
      renderTable();
    });
    $("#tx-account-filter")?.addEventListener("change", (ev) => {
      fil.account = ev.target.value;
      rowLimit = 100;
      renderTable();
    });
    $("#btn-export-csv")?.addEventListener("click", exportCSV);
    $("#btn-close-receipt-filter")?.addEventListener("click", () => {
      receiptFilter = null;
      rowLimit = 100;
      renderTable();
    });
    $("#btn-clear-tx-filters")?.addEventListener("click", () => {
      receiptFilter = null;
      fil.search = ""; fil.type = "all"; fil.account = "all"; fil.cats = null;
      $("#tx-search").value = "";
      rowLimit = 100;
      renderAll();
    });
    $$("#tx-table thead th[data-sort]").forEach((th) => {
      const sortColumn = () => {
        const key = th.dataset.sort;
        if (sort.key === key) sort.dir *= -1;
        else { sort.key = key; sort.dir = key === "date" ? -1 : 1; }
        renderTable();
      };
      th.tabIndex = 0;
      th.addEventListener("click", sortColumn);
      th.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); sortColumn(); }
      });
    });
    $("#btn-more-rows").addEventListener("click", () => { rowLimit += 200; renderTable(); });
    $("#tx-origin-review").addEventListener("toggle", () => {
      if ($("#tx-origin-review").open) { originPage = 0; refreshOriginReview(); }
      else closeOriginReview();
    });
    $("#tx-origin-prev").addEventListener("click", () => { originPage--; renderOriginPage(); });
    $("#tx-origin-next").addEventListener("click", () => { originPage++; renderOriginPage(); });

    // Ações da tabela
    $("#tx-paid").addEventListener("change", updateTypeToggle);
    $("#tx-payable").addEventListener("change", updateTypeToggle);
    const billPanel = $("#dash-bills");
    let lastBillTap = null;
    billPanel.addEventListener("click", ev => {
      const button = ev.target.closest("[data-bill-action]");
      if (button) {
        lastBillTap = null;
        if (button.dataset.billAction === "new") openTxModal(null, {pending:true, title:"Nova conta a pagar"});
        else changeAgendaBill(button.closest("[data-id]"), button.dataset.billAction);
        return;
      }
      // Alguns celulares enviam dois cliques simples e nenhum evento dblclick.
      const row = ev.target.closest(".bill-row.bill-open");
      if (!row || ev.target.closest("button, a") || !(ev.pointerType === "touch" || (!ev.pointerType && window.matchMedia("(pointer: coarse)").matches))) {
        lastBillTap = null;
        return;
      }
      const previous = lastBillTap;
      lastBillTap = {row, time:ev.timeStamp, x:ev.clientX, y:ev.clientY};
      if (previous?.row === row && ev.timeStamp - previous.time <= 400 && Math.hypot(ev.clientX-previous.x, ev.clientY-previous.y) <= 26) {
        lastBillTap = null;
        changeAgendaBill(row, "pay");
      }
    });
    billPanel.addEventListener("dblclick", ev => {
      const row = ev.target.closest(".bill-row.bill-open");
      if (row && !ev.target.closest("button, a")) changeAgendaBill(row, "pay");
    });
    $("#tx-tbody").addEventListener("click", (ev) => {
      const tr = ev.target.closest("tr[data-id]");
      if (!tr) return;
      const billAction = ev.target.closest("[data-bill-action]")?.dataset.billAction;
      if (billAction) { changeBill(tr.dataset.id, billAction, "transactions"); return; }
      const action = ev.target.closest("[data-action]")?.dataset.action;
      if (action === "advance") { openAdvance(tr.dataset.id); return; }
      if (action === "delete") { requestDeleteTx(tr.dataset.id); return; }
      if (action === "edit") { openTxModal(tr.dataset.id); return; }
      // Celular: toque na linha abre a edição (como no Mobills). Ignora a
      // caixinha de seleção e qualquer campo interativo.
      if (window.matchMedia("(max-width: 640px)").matches &&
          !ev.target.closest("input, button, a, label")) {
        openTxModal(tr.dataset.id);
      }
    });
    $("#tx-tbody").addEventListener("dblclick", (ev) => {
      if (ev.target.closest("input, button")) return;
      const tr = ev.target.closest("tr[data-id]");
      if (tr) openTxModal(tr.dataset.id);
    });

    // Seleção em lote: caixinha por linha
    $("#tx-tbody").addEventListener("change", (ev) => {
      if (!ev.target.classList.contains("tx-sel")) return;
      const id = ev.target.dataset.id;
      if (ev.target.checked) selectedTx.add(id); else selectedTx.delete(id);
      ev.target.closest("tr")?.classList.toggle("tx-selected", ev.target.checked);
      // atualiza "selecionar todas" e a barra sem re-renderizar a tabela toda
      const visibleIds = $$("#tx-tbody .tx-sel").map((c) => c.dataset.id);
      $("#tx-sel-all").checked = visibleIds.length > 0 && visibleIds.every((v) => selectedTx.has(v));
      $("#tx-sel-all").indeterminate = !$("#tx-sel-all").checked && visibleIds.some((v) => selectedTx.has(v));
      updateBulkBar();
    });
    // "selecionar todas as visíveis"
    $("#tx-sel-all").addEventListener("change", (ev) => {
      const on = ev.target.checked;
      ev.target.indeterminate = false;
      $$("#tx-tbody .tx-sel").forEach((c) => {
        c.checked = on;
        if (on) selectedTx.add(c.dataset.id); else selectedTx.delete(c.dataset.id);
        c.closest("tr")?.classList.toggle("tx-selected", on);
      });
      updateBulkBar();
    });
    // Ações em lote
    $("#btn-bulk-clear").addEventListener("click", () => { selectedTx.clear(); renderTable(); });
    $("#btn-bulk-delete").addEventListener("click", () => {
      const ids = [...selectedTx];
      if (!ids.length) return;
      askConfirm("Excluir selecionadas?", `${ids.length} transaç${ids.length === 1 ? "ão selecionada será removida" : "ões selecionadas serão removidas"}. Você poderá usar Desfazer enquanto esta pasta estiver aberta.`, () => {
        const set = new Set(ids);
        ds.transactions = ds.transactions.filter((t) => !set.has(t.id));
        selectedTx.clear();
        saveCur();
        renderAll();
        toast(`${ids.length} transaç${ids.length === 1 ? "ão excluída" : "ões excluídas"}.`);
      });
    });
    $("#btn-bulk-edit").addEventListener("click", openBulkEdit);
    $("#btn-bulk-edit-cancel").addEventListener("click", () => $("#modal-bulk-edit").classList.add("hidden"));
    $("#btn-bulk-edit-save").addEventListener("click", saveBulkEdit);
    ["bulk-cat", "bulk-cur", "bulk-acc", "bulk-type"].forEach((f) => {
      $(`#${f}-on`).addEventListener("change", (ev) => $(`#${f}-wrap`).classList.toggle("hidden", !ev.target.checked));
    });

    // Modal de exclusão de parcelada
    $("#btn-delparc-cancel").addEventListener("click", () => { $("#modal-del-parc").classList.add("hidden"); pendingParcTx = null; });
    ["one","following","all"].forEach(mode=>$("#btn-delparc-"+mode).addEventListener("click",()=>deleteSeries(mode)));
    ["#advance-date","#advance-count","#advance-all"].forEach(id=>$(id).addEventListener("input",updateAdvance));
    $("#btn-advance-save").addEventListener("click",saveAdvance);
    $("#btn-advance-cancel").addEventListener("click",()=>{$("#modal-advance").classList.add("hidden");pendingAdvance=null;});

    // Renomear pasta pelo painel
    const renameDs = () => {
      askName("Renomear pasta", ds.name, (name) => {
        ds.name = name;
        saveCur();
        $("#ds-name").textContent = name;
        toast("Pasta renomeada ✔");
      });
    };
    $("#ds-name").addEventListener("click", renameDs);
    $("#btn-rename-ds").addEventListener("click", renameDs);

    // Desfazer última alteração
    $("#btn-undo").addEventListener("click", undo);
    document.addEventListener("keydown", (ev) => {
      // Ctrl/Cmd+Z no painel, fora de campos de texto (lá o desfazer é do navegador)
      if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && (ev.key === "z" || ev.key === "Z")) {
        const el = document.activeElement;
        const editando = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
        const noPainel = ["#screen-dash", "#screen-txs"].some((id) => !$(id).classList.contains("hidden"));
        const modalAberto = $$(".modal-backdrop").some((m) => !m.classList.contains("hidden"));
        if (noPainel && !editando && !modalAberto) { ev.preventDefault(); undo(); }
      }
    });

    // Modal de transação
    $("#btn-add-tx").addEventListener("click", () => openTxModal(null));
    $("#btn-tx-save").addEventListener("click", saveTxModal);
    $("#btn-tx-cancel").addEventListener("click", () => { $("#modal-tx").classList.add("hidden"); editingId = null; });
    $("#tx-desc").addEventListener("input", () => { suggestTxCategory(); updateTypeToggle(); });
    $("#tx-reference-month").addEventListener("input", updateTypeToggle);
    $("#tx-reference-month").addEventListener("change", updateTypeToggle);
    $("#tx-reference-auto").addEventListener("click", () => {
      $("#tx-reference-month").value = "";
      updateTypeToggle();
      $("#tx-reference-month").focus();
    });
    $("#tx-date").addEventListener("input", () => { txDateEdited = true; updateTypeToggle(); });
    $("#tx-date").addEventListener("change", () => { txDateEdited = true; updateTypeToggle(); });
    $$("#tx-type-toggle button").forEach((b) => {
      b.addEventListener("click", () => {
        txType = b.dataset.type; updateTypeToggle(); suggestTxCategory();
        updateFixedOption(editingId ? ds.transactions.find(t=>t.id===editingId) : null); updateTxHints();
      });
    });
    $("#tx-cat").addEventListener("change", (ev) => {
      txCategoryChosen = true;
      $("#tx-newcat-wrap").classList.toggle("hidden", ev.target.value !== "__new__");
      if (ev.target.value === "__new__") $("#tx-newcat").focus();
    });
    $("#tx-account-sel").addEventListener("change", (ev) => {
      const other = ev.target.value === "__other__";
      $("#tx-account-other-wrap").classList.toggle("hidden", !other);
      if (other) $("#tx-account-other").focus();
      updateTypeToggle();
    });
    $("#tx-account-other").addEventListener("input", updateTypeToggle);
    // Trocar a moeda da transação reformata o campo de valor e os avisos
    $("#tx-currency").addEventListener("change", (ev) => { applyTxCurrency(ev.target.value); updateTxHints(); });
    // Parcelada e fixa são mutuamente exclusivas
    $("#tx-parcelado").addEventListener("change", () => {
      if ($("#tx-parcelado").checked) $("#tx-fixa").checked = false;
      updateTxHints();
    });
    $("#tx-fixa").addEventListener("change", () => {
      if ($("#tx-fixa").checked) $("#tx-parcelado").checked = false;
      updateTxHints();
    });
    $("#tx-renew").addEventListener("change", updateTxHints);
    $("#tx-nparc").addEventListener("input", updateTxHints);
    $("#tx-amount").addEventListener("input", updateTxHints);
    $("#modal-tx").addEventListener("keydown", (ev) => {
      if (ev.isComposing) return;
      if (ev.key === "Enter" && ev.target.tagName === "INPUT" && ev.target.type !== "checkbox") { ev.preventDefault(); saveTxModal(); }
      if (ev.key === "Escape") { $("#modal-tx").classList.add("hidden"); editingId = null; }
    });

    // Limites e Metas
    $("#limits-block").addEventListener("click", (ev) => {
      if (ev.target.closest('[data-action="add-limit"]')) { openLimitModal(null); return; }
      if (ev.target.closest('[data-action="add-meta"]')) { openMetaModal(null); return; }

      // Metas primeiro: .meta-row também tem a classe .limit-row (estilo compartilhado)
      const metaRow = ev.target.closest(".meta-row[data-id]");
      if (metaRow) {
        const m = ds.metas.find((x) => x.id === metaRow.dataset.id);
        if (!m) return;
        const action = ev.target.closest("[data-action]")?.dataset.action;
        if (action === "meta-add") addToMeta(m);
        else if (action === "meta-charge") addChargeToMeta(m);
        else if (action === "meta-import") Batch.open({ category: m.category, title: `Importar gastos de ${m.name}` });
        else if (action === "edit-meta") openMetaModal(m.id);
        else if (action === "delete-meta") {
          askConfirm("Excluir meta?", `A meta "${m.name}" será removida. Suas transações não são afetadas.`, () => {
            ds.metas = ds.metas.filter((x) => x.id !== m.id);
            saveCur();
            renderMetas();
            toast("Meta excluída.");
          });
        }
        return;
      }

      const card = ev.target.closest(".limit-row[data-id]");
      if (!card) return;
      const action = ev.target.closest("[data-action]")?.dataset.action;
      if (action === "edit-limit") openLimitModal(card.dataset.id);
      else if (action === "delete-limit") {
        const L = ds.limits.find((x) => x.id === card.dataset.id);
        askConfirm("Excluir limite?", `O limite "${L?.name}" será removido. As transações não são afetadas.`, () => {
          ds.limits = ds.limits.filter((x) => x.id !== card.dataset.id);
          saveCur();
          renderAll();
          toast("Limite excluído.");
        });
      }
    });

    // Modal de meta
    $("#btn-meta-save").addEventListener("click", saveMetaModal);
    $("#btn-meta-cancel").addEventListener("click", () => { $("#modal-meta").classList.add("hidden"); editingMetaId = null; });
    $("#meta-target").addEventListener("input", updateMetaPreview);
    $("#meta-saved").addEventListener("input", updateMetaPreview);
    $("#meta-cat").addEventListener("change", updateMetaPreview);
    $("#meta-mode-toggle").addEventListener("click", (ev) => {
      const b = ev.target.closest("button[data-mode]");
      if (b) setMetaMode(b.dataset.mode);
    });
    $("#modal-meta").addEventListener("keydown", (ev) => {
      if (ev.isComposing) return;
      if (ev.key === "Enter" && ev.target.tagName === "INPUT") { ev.preventDefault(); saveMetaModal(); }
      if (ev.key === "Escape") { $("#modal-meta").classList.add("hidden"); editingMetaId = null; }
    });
    $("#btn-limit-save").addEventListener("click", saveLimitModal);
    $("#btn-limit-cancel").addEventListener("click", () => { $("#modal-limit").classList.add("hidden"); editingLimitId = null; });
    $("#modal-limit").addEventListener("keydown", (ev) => {
      if (ev.isComposing) return;
      if (ev.key === "Enter" && ev.target.tagName === "INPUT" && ev.target.type === "text") { ev.preventDefault(); saveLimitModal(); }
      if (ev.key === "Escape") { $("#modal-limit").classList.add("hidden"); editingLimitId = null; }
    });
  });

  // Adiciona várias transações de uma vez (importação em lote).
  // items: [{ date, desc, amount, type, category, account? }]
  function addBulk(items) {
    if (!ds || !Array.isArray(items)) return 0;
    if (!refreshImportTarget()) return 0;
    let n = 0;
    items.forEach((it) => {
      if (!it) return;
      const amount = Math.abs(Number(it.amount));
      if (!isValidISODate(it.date) || !Number.isFinite(amount) || amount <= 0) return;
      const category = String(it.category || "Outros").trim() || "Outros";
      ensureCat(ds, category);
      ds.transactions.push({
        id: uid(),
        date: it.date,
        desc: String(it.desc || "").trim() || "(sem descrição)",
        category,
        account: String(it.account || "").trim(),
        type: it.type === "receita" ? "receita" : "despesa",
        amount, currency: normCur(it.currency), installment: null, totalValue: null,
        ...importEvidence(it),
      });
      n++;
    });
    if (n) { saveCur(); renderAll(); }
    return n;
  }

  function currentDatasetName() { return ds ? ds.name : ""; }

  function importEvidence(value) {
    const out = {...cleanDateEstimate(value),...cleanCashback(value),...cleanPurchaseSchedule(value),...cleanCardCycle(value)};
    if (value?.categoryEdited === true) out.categoryEdited = true;
    for (const [key, max] of [["referenceId", 160], ["sourceEvidence", 300]]) {
      if (typeof value?.[key] === "string" && value[key].trim()) out[key] = value[key].trim().slice(0, max);
    }
    if (Number.isSafeInteger(value?.sourcePage) && value.sourcePage > 0) out.sourcePage = value.sourcePage;
    return out;
  }

  function getImportTargetId() { return ds?.id || null; }
  function receiptJobIds() {
    const ids = new Set();
    for (const tx of ds?.transactions || []) {
      const match = /^receipt_([a-f0-9-]{36})_\d+$/i.exec(tx.id);
      if (match) ids.add(match[1]);
    }
    return ids;
  }
  function showReceiptTransactions(jobId, expectedIds = [], {matchedIds = [], printedIds = null} = {}) {
    if (!ds || !jobId) return false;
    refreshFromStore({force:true});
    const prefix = "receipt_" + jobId + "_";
    const ids = new Set(ds.transactions.filter(t => typeof t.id === "string" && t.id.startsWith(prefix)).map(t => t.id));
    if (!expectedIds.every(id => ids.has(id))) return false;
    receiptFilter = {prefix, printedOnly:Array.isArray(printedIds), ids:new Set(printedIds || matchedIds)};
    fil.search = ""; fil.type = "all"; fil.account = "all";
    $("#tx-search").value = "";
    selectedTx.clear();
    rowLimit = 100;
    showScreen("screen-txs");
    renderTable();
    return true;
  }
  function existingTransactions() {
    if (!ds) return [];
    const current = Store.loadDataset(ds.id) || ds;
    return JSON.parse(JSON.stringify(current.transactions || []));
  }

  function refreshImportTarget() {
    if (!ds) return false;
    const current = Store.loadDataset(ds.id);
    if (!current) { toast("A pasta não está disponível. Abra uma pasta válida antes de importar."); return false; }
    if (JSON.stringify(current) !== JSON.stringify(ds)) {
      ds = current;
      selectedTx.clear();
      undoStack.length = 0;
      updateUndoBtn();
      renderAll();
    }
    return true;
  }

  // Chaves (data+descrição+valor+tipo+moeda) da pasta aberta —
  // usadas pelo lote para avisar quando uma fatura é importada de novo.
  function existingTxKeys() {
    const set = new Set();
    if (ds) ds.transactions.forEach((t) => set.add(`${dupTxKey(t.date, t.desc, t.amount, t.type)}|${normCur(t.currency)}`));
    return set;
  }

  // Chaves de SÉRIE do que já está na pasta — parceladas (descrição+parcela,
  // sem data: a fatura pode datar a parcela num dia diferente do lançamento)
  // e fixas (descrição+mês). Usadas pelo lote para não duplicar uma compra
  // parcelada já adicionada num mês anterior.
  function existingSeriesKeys() {
    const set = new Set();
    if (ds) ds.transactions.forEach((t) => {
      const valueKey = `${normCur(t.currency)}|${Number(t.amount).toFixed(curFrac(t.currency))}`;
      if (t.installment) set.add(`p|${stripAccents(t.desc)}|${t.type}|${t.installment}|${valueKey}`);
      if (t.fixed) set.add(`f|${stripAccents(t.desc)}|${t.type}|${(t.date || "").slice(0, 7)}|${valueKey}`);
    });
    return set;
  }

  // Injeta na pasta atual transações JÁ no formato interno (vindas do
  // importador completo: preservam categoria, cartão, parcela, recorrente,
  // valor total e o vínculo entre parcelas). IDs são regerados.
  function appendImported(txs) {
    if (!ds || !Array.isArray(txs)) return 0;
    // Valide o lote inteiro antes de alterar categorias, dados ou histórico.
    // Uma prévia rejeitada precisa poder ser corrigida e reenviada sem duplicar
    // os itens válidos de uma tentativa parcialmente gravada.
    if (txs.some((t) => !t || !isValidISODate(t.date) || !Number.isFinite(t.amount) ||
        !(Math.abs(t.amount) > 0) || Math.abs(t.amount) > Number.MAX_SAFE_INTEGER ||
        !["receita", "despesa"].includes(t.type) || !CURRENCY_CODES.includes(t.currency))) {
      toast("Confira a data, o valor, o tipo e a moeda de todos os itens. Nenhum lançamento foi adicionado.");
      return 0;
    }
    if (!refreshImportTarget()) return 0;
    const groupMap = new Map();
    for (const tx of txs) {
      if (!tx.seriesKey) continue;
      const related=ds.transactions.filter(t => t.seriesKey === tx.seriesKey || (tx.groupId && t.groupId === tx.groupId));
      if (related.some(t => t.installment === tx.installment)) return 0;
      const existing=related.find(t => t.groupId);
      if (existing && tx.groupId) groupMap.set(tx.groupId,existing.groupId);
    }
    let n = 0;
    txs.forEach((t) => {
      const category = String(t.category || "Outros").trim() || "Outros";
      ensureCat(ds, category);
      let groupId = null;
      if (t.groupId) {
        if (!groupMap.has(t.groupId)) groupMap.set(t.groupId, uid());
        groupId = groupMap.get(t.groupId);
      }
      ds.transactions.push({
        id: uid(), groupId, fixed: t.fixed === true,
        date: t.date,
        desc: String(t.desc || "").trim() || "(sem descrição)",
        category,
        account: String(t.account || "").trim(),
        type: t.type === "receita" ? "receita" : "despesa",
        amount: Math.abs(t.amount),
        currency: normCur(t.currency),
        installment: t.installment || null,
        totalValue: t.totalValue != null && Number.isFinite(Number(t.totalValue)) ? Math.abs(t.totalValue) : null,
        ...importEvidence(t),
      });
      n++;
    });
    if (n) { saveCur(); renderAll(); }
    return n;
  }

  return { open, openTxModal, closeFolder, createEmpresaDataset, refreshFromStore, showReceiptTransactions, receiptJobIds, fillTxFromReceipt, getCats, addBulk, appendImported, currentDatasetName, currentProfile: () => ds?.profile || "pf", getImportTargetId, existingTransactions, resolveImportDate, existingTxKeys, existingSeriesKeys, isEditingTransaction: () => !!editingId, refitHero: fitHeroFlow };
})();
