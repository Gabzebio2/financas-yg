/* ===== Finanças YG — painel: resumo, gráficos, tabela, edição, limites ===== */
"use strict";

const Dashboard = (() => {
  let ds = null; // dataset aberto
  let fil = { mode: "month", month: null, from: "", to: "", cats: null, search: "", type: "all", account: "all" };
  let sort = { key: "date", dir: -1 };
  let rowLimit = 100;
  const charts = {};
  let editingId = null;
  let txDateEdited = false;
  let receiptRead = null;
  let txModalRevision = 0;
  let editingLimitId = null;
  let pendingAdvance = null;
  let pendingParcTx = null; // transação parcelada aguardando escolha de exclusão
  const selectedTx = new Set(); // ids das transações marcadas (seleção em lote)

  const FIXA_MESES = 12; // quantos meses uma despesa fixa gera
  let ratesHooked = false; // registra o ouvinte de cotação uma única vez

  const UI_ICON_PATHS = {
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
     converte os totais para ds.displayCurrency (PYG no modo Padrão).
     A lista de lançamentos sempre preserva a moeda e o valor originais. */
  function isDefaultMode() { return normDisplayCur(ds && ds.displayCurrency) === "DEFAULT"; }
  function dispCur() { return isDefaultMode() ? "PYG" : normCur(ds && ds.displayCurrency); }
  function entryCur() {
    if (!isDefaultMode()) return dispCur();
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
    const pending = ds.transactions.some((t) => !Number.isFinite(dispAmount(t))) ||
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
    const loaded = Store.loadDataset(id);
    if (!loaded) { toast("Não foi possível abrir esta pasta. Exporte um backup para preservar os dados e verificar o arquivo."); goHome(); return; }
    ds = loaded;
    // Lembra a última pasta pessoal aberta (usada no menu Pessoa física/Empresa)
    if (ds.profile !== "pj") {
      try { localStorage.setItem("fyg:pf-last", ds.id); } catch { /* sem storage */ }
    }
    // Migração para multi-moeda: pastas antigas eram 100% em Real
    ds.displayCurrency = normDisplayCur(ds.displayCurrency);
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
    const cur = todayISO().slice(0, 7);
    fil = {
      mode: "month",
      month: months.includes(cur) ? cur : (months.filter((ym) => ym <= cur).pop() || cur),
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
    if (pendingParcTx) {
      pendingParcTx = ds.transactions.find((t) => t.id === pendingParcTx.id) || null;
      if (!pendingParcTx) $("#modal-del-parc").classList.add("hidden");
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
    const set = new Set(ds.transactions.map((t) => t.date.slice(0, 7)));
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

  function inPeriod(t, p) {
    if (!p) return true;
    if (p.from && t.date < p.from) return false;
    if (p.to && t.date > p.to) return false;
    return true;
  }

  function inCats(t) {
    return !fil.cats || fil.cats.has(stripAccents(t.category));
  }

  function filteredTxs() {
    const p = periodRange();
    return ds.transactions.filter((t) => inPeriod(t, p) && inCats(t));
  }

  function tableTxs() {
    const q = stripAccents(fil.search);
    let list = filteredTxs();
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
    const rows = [["Data", "Descrição", "Categoria", "Conta", "Tipo", "Parcela", "Recorrente", "Valor original", "Moeda original", "Valor exibido", "Moeda de exibição"]];
    list.forEach((t) => rows.push([t.date, t.desc, t.category, t.account || "", t.type === "receita" ? "Receita" : "Despesa", t.installment || "", t.fixed ? "Sim" : "Não", number(t.amount, t.currency), normCur(t.currency), Number.isFinite(txDisplayAmount(t)) ? number(txDisplayAmount(t), txDisplayCurrency(t)) : "", txDisplayCurrency(t)]));
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
  function renderAll() {
    $("#ds-name").textContent = ds.name;
    renderPeriodControls();
    renderCurrencyControl();
    renderCurrencyWarning();
    renderCatFilter();
    renderSummary();
    renderCurrencyBreakdown();
    renderLimits();
    renderMetas();
    renderCharts();
    renderTable();
  }

  // Botão "BRL ▾" do cabeçalho + menu de moedas + linha de status da cotação
  function renderCurrencyControl() {
    $("#dash-hero")?.classList.toggle("precise-currency", curFrac(dispCur()) > 2);
    const code = $("#hero-cur-code");
    if (code) code.textContent = isDefaultMode() ? "Padrão" : dispCur();
    const caption = `Totais em ${isDefaultMode() ? "guaranis (PYG)" : dispCur()} · lançamentos na moeda original`;
    for (const id of ["#currency-mode-caption", "#tx-currency-mode-caption"]) {
      const node = $(id); if (node) node.textContent = caption;
    }
    $("#hero-cur")?.setAttribute("aria-label", "Moeda do painel: " + (isDefaultMode() ? "Padrão, totais em guaranis" : dispCur()));
    const menu = $("#cur-menu");
    if (menu) {
      menu.innerHTML = `<button type="button" class="pop-item pop-default ${isDefaultMode() ? "active" : ""}" data-cur="DEFAULT" aria-pressed="${isDefaultMode()}"><span>Padrão<small>Totais em guaranis (PYG). Cada lançamento na sua moeda.</small></span>${isDefaultMode() ? '<span class="pop-check">✓</span>' : ""}</button><div class="pop-sep"></div>` + CURRENCY_CODES.map((c) => `
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

  function renderCurrencyBreakdown() {
    const block = $("#currency-breakdown"); if (!block) return;
    const groups = currencyBreakdown();
    block.classList.toggle("hidden", groups.length < 2);
    if (groups.length < 2) return;
    const hint = $("#currency-breakdown-hint");
    if (hint) hint.textContent = `Valores originais. Barras comparadas pelo equivalente em ${dispCur()}.`;
    const max = Math.max(0, ...groups.flatMap(g => [g.incomeConverted, g.expenseConverted]).filter(Number.isFinite));
    const rows = $("#currency-breakdown-rows"); if (!rows) return;
    rows.innerHTML = groups.map(g => {
      const metric = (kind, label, converted) => {
        const native = g[kind], valid = Number.isFinite(converted);
        const width = valid && max > 0 ? Math.max(0, Math.min(100, converted / max * 100)) : 0;
        const value = fmtMoney(native, g.currency);
        const equivalent = g.currency !== dispCur() ? valid ? `≈ ${fmtD(converted)}` : "Cotação pendente" : !valid ? "Cotação pendente" : "";
        return `<div class="fx-metric fx-${kind}"><div class="fx-metric-value"><span>${label}</span><strong>${escapeHtml(value)}</strong></div><div class="fx-track" aria-hidden="true"><span style="width:${width.toFixed(4)}%"></span></div>${equivalent ? `<small>${escapeHtml(equivalent)}</small>` : ""}</div>`;
      };
      return `<div class="fx-row"><div class="fx-code"><strong>${g.currency}</strong><span>${g.count} ${g.count === 1 ? "lançamento" : "lançamentos"}</span></div>${metric("income", "Entradas", g.incomeConverted)}${metric("expense", "Saídas", g.expenseConverted)}</div>`;
    }).join("");
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

  function createEmpresaDataset() {
    const nds = Store.createDataset("Empresa");
    nds.profile = "pj";
    nds.categories = [];
    EMPRESA_CATS.forEach((c) => ensureCat(nds, c));
    Store.saveDataset(nds);
    open(nds.id);
    toast("Conta Empresa criada 🏢 — categorias de negócio já configuradas");
  }

  function renderAcctMenu() {
    const idx = Store.loadIndex();
    const isPj = (e) => e.profile === "pj";
    const pj = idx.find(isPj);
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
    html += pj
      ? `<button type="button" class="pop-item ${curIsPj ? "active" : ""}" data-ds="${escapeHtml(pj.id)}">
          ${uiIcon("business")} Empresa${curIsPj ? '<span class="pop-check">✓</span>' : ""}</button>`
      : `<button type="button" class="pop-item" data-create-pj="1">${uiIcon("plus")} Criar conta Empresa</button>`;
    html += `<div class="pop-sep"></div>
      <button type="button" class="pop-item" data-acct-home="1">${uiIcon("home")} Todas as pastas</button>`;
    $("#acct-menu").innerHTML = html;
  }

  function stepMonth(delta) {
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
      .filter((t) => inCats(t) && (!p || !p.to || t.date <= p.to))
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
    if (tSal) { tSal.textContent = fmtD(saldo); tSal.className = !Number.isFinite(saldo) ? "" : saldo >= 0 ? "pos" : "neg"; }
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
    Chart.defaults.font.size = 12;
    Chart.defaults.font.weight = "500";
    Chart.defaults.color = palette.muted;
    Chart.defaults.borderColor = palette.grid;
    Object.assign(Chart.defaults.plugins.legend.labels, {
      usePointStyle: true, pointStyle: "circle", boxWidth: 7, boxHeight: 7, padding: 18, color: palette.muted,
    });
    Object.assign(Chart.defaults.plugins.tooltip, {
      backgroundColor: palette.card, titleColor: palette.text, bodyColor: palette.muted,
      borderColor: palette.border, borderWidth: 1, padding: 13, cornerRadius: 10,
      boxPadding: 5, usePointStyle: true,
    });
    Chart.defaults.elements.line.borderWidth = 2.5;
    Chart.defaults.elements.point.hoverRadius = 5;
  }

  function mkChart(canvasId, config) {
    if (charts[canvasId]) { charts[canvasId].destroy(); delete charts[canvasId]; }
    if (typeof Chart === "undefined") {
      setEmpty(canvasId, true, "Os gráficos estão indisponíveis. Seus valores e transações continuam acessíveis.");
      return;
    }
    applyChartTheme();
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
  // Ticks compactos (sem casas decimais) na moeda de exibição
  const moneyTicks = {
    callback: (v) => fmtMoney(Number(v) || 0, dispCur()),
  };

  // Meses exibidos nos gráficos de evolução
  function chartMonths() {
    const months = allMonths();
    if (fil.mode === "range") {
      return months.filter((ym) => (!fil.from || ym >= fil.from.slice(0, 7)) && (!fil.to || ym <= fil.to.slice(0, 7)));
    }
    return months;
  }

  function renderCharts() {
    const palette = themePalette();
    if (ds.transactions.filter(inCats).some((t) => !Number.isFinite(dispAmount(t)))) {
      ["chart-cat", "chart-evo", "chart-saldo", "chart-conta"].forEach((id) => {
        if (charts[id]) { charts[id].destroy(); delete charts[id]; }
        setEmpty(id, true, "Cotação indisponível para comparar estas moedas. Os valores originais estão na lista de transações.");
      });
      return;
    }
    if (typeof Chart === "undefined") {
      ["chart-cat", "chart-evo", "chart-saldo", "chart-conta"].forEach((id) => setEmpty(id, true, "Os gráficos estão indisponíveis. Seus valores e transações continuam acessíveis."));
      return;
    }
    const txs = filteredTxs();

    /* 1. Rosca — gastos por categoria */
    const byCat = Object.create(null);
    txs.filter((t) => t.type === "despesa").forEach((t) => { byCat[t.category] = (byCat[t.category] || 0) + dispAmount(t); });
    const catEntries = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
    setEmpty("chart-cat", !catEntries.length, "Sem despesas no período selecionado");
    mkChart("chart-cat", {
      type: "doughnut",
      data: {
        labels: catEntries.map(([c]) => c),
        datasets: [{
          data: catEntries.map(([, v]) => v),
          backgroundColor: catEntries.map(([c]) => catColor(ds, c)),
          borderWidth: 4, borderColor: palette.card, hoverOffset: 5, borderRadius: 3,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: "72%",
        plugins: {
          legend: { position: "right" },
          tooltip: { callbacks: { label: (ctx) => ` ${ctx.label}: ${fmtD(ctx.parsed)}` } },
        },
      },
    });

    /* 2 e 3. Evolução mensal (linha) e saldo (barra + acumulado) */
    const months = chartMonths();
    const recM = Object.create(null), despM = Object.create(null);
    ds.transactions.filter(inCats).forEach((t) => {
      const ym = t.date.slice(0, 7);
      if (t.type === "receita") recM[ym] = (recM[ym] || 0) + dispAmount(t);
      else despM[ym] = (despM[ym] || 0) + dispAmount(t);
    });
    const labels = months.map(fmtMonth);
    const recData = months.map((ym) => recM[ym] || 0);
    const despData = months.map((ym) => despM[ym] || 0);

    setEmpty("chart-evo", !months.length, "Sem transações ainda");
    mkChart("chart-evo", {
      type: "line",
      data: {
        labels,
        datasets: [
          { label: "Receitas", data: recData, borderColor: palette.revenue, backgroundColor: chartTint(palette.revenue, .10), fill: true, tension: .3, pointRadius: 3, pointBackgroundColor: palette.card, pointBorderWidth: 2 },
          { label: "Despesas", data: despData, borderColor: palette.expense, backgroundColor: chartTint(palette.expense, .08), fill: true, tension: .3, pointRadius: 3, pointBackgroundColor: palette.card, pointBorderWidth: 2 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: "bottom" }, tooltip: moneyTip },
        scales: { x: { grid: { display: false }, border: { display: false } }, y: { ticks: { ...moneyTicks, padding: 10 }, border: { display: false }, grid: { color: palette.grid } } },
      },
    });

    // Saldo acumulado inclui meses anteriores à janela exibida
    const allM = allMonths();
    let run = 0;
    const cumByMonth = Object.create(null);
    allM.forEach((ym) => { run += (recM[ym] || 0) - (despM[ym] || 0); cumByMonth[ym] = run; });
    const saldoData = months.map((ym) => (recM[ym] || 0) - (despM[ym] || 0));
    const cumData = months.map((ym) => cumByMonth[ym]);

    setEmpty("chart-saldo", !months.length, "Sem transações ainda");
    mkChart("chart-saldo", {
      data: {
        labels,
        datasets: [
          {
            type: "bar", label: "Saldo do mês", data: saldoData,
            backgroundColor: saldoData.map((v) => chartTint(v >= 0 ? palette.revenue : palette.expense, .75)),
            borderRadius: 5, maxBarThickness: 38,
          },
          { type: "line", label: "Acumulado", data: cumData, borderColor: palette.balance, backgroundColor: palette.balance, tension: .3, pointRadius: 3, pointBackgroundColor: palette.card, pointBorderWidth: 2 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: "bottom" }, tooltip: moneyTip },
        scales: { x: { grid: { display: false }, border: { display: false } }, y: { ticks: { ...moneyTicks, padding: 10 }, border: { display: false }, grid: { color: palette.grid } } },
      },
    });

    /* 4. Barras horizontais — gastos por cartão/conta */
    const byAcc = Object.create(null);
    txs.filter((t) => t.type === "despesa").forEach((t) => {
      const a = t.account || "(sem cartão)";
      byAcc[a] = (byAcc[a] || 0) + dispAmount(t);
    });
    const accEntries = Object.entries(byAcc).sort((a, b) => b[1] - a[1]).slice(0, 8);
    setEmpty("chart-conta", !accEntries.length, "Sem despesas no período selecionado");
    mkChart("chart-conta", {
      type: "bar",
      data: {
        labels: accEntries.map(([a]) => a),
        datasets: [{
          label: "Despesas", data: accEntries.map(([, v]) => v),
          backgroundColor: chartTint(palette.primary, .8), borderRadius: 5, maxBarThickness: 28,
        }],
      },
      options: {
        indexAxis: "y", responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => ` ${fmtD(ctx.parsed.x)}` } } },
        scales: { x: { ticks: { ...moneyTicks, padding: 10 }, border: { display: false }, grid: { color: palette.grid } }, y: { grid: { display: false }, border: { display: false } } },
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

  function limitStats() {
    const p = periodRange();
    const ym = refMonth();
    const spentByCat = Object.create(null);
    ds.transactions
      .filter((t) => t.type === "despesa" && inPeriod(t, p))
      .forEach((t) => {
        const k = stripAccents(t.category);
        spentByCat[k] = (spentByCat[k] ?? 0) + dispAmount(t);
      });
    return (ds.limits || []).map((base) => {
      const v = versionFor(base, ym);
      // Valor do limite convertido da moeda em que foi definido para a do painel
      const amount = convertAmount(v.amount, base.currency, dispCur());
      const L = { ...base, amount, categories: v.categories, since: v.from !== "0000-00" ? v.from : null };
      // O filtro de categorias do painel também filtra os limites:
      // grupos sem nenhuma categoria selecionada somem; nos demais, só somam as categorias visíveis
      const visibleCats = L.categories.filter((c) => !fil.cats || fil.cats.has(stripAccents(c)));
      if (!visibleCats.length) return null;
      const spent = visibleCats.reduce((s, c) => s + (spentByCat[stripAccents(c)] ?? 0), 0);
      const pct = L.amount > 0 ? (spent / L.amount) * 100 : 0;
      return {
        ...L, visibleCats,
        filtered: visibleCats.length < L.categories.length,
        spent, remaining: L.amount - spent, pct, unavailable: !Number.isFinite(amount) || !Number.isFinite(spent),
      };
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
      const nOver = groups.filter((g) => g.remaining < 0).length;
      const pct = totLim > 0 ? Math.round((totSpent / totLim) * 100) : 0;
      ov.innerHTML = `${fmtD(totSpent)} gastos de ${fmtD(totLim)} ${label} (${pct}%)` +
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
        const over = g.remaining < 0;
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
              ? `<span class="limit-over-txt">Ultrapassou em ${fmtD(-g.remaining)}</span>`
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
            backgroundColor: groups.map((g) => (g.remaining < 0 ? palette.expense : g.pct >= 70 ? palette.primary : palette.revenue)),
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
        if (stripAccents(t.category) !== k) return;
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
        </div></div><p class="hint">Cotação indisponível para calcular o progresso nesta moeda.${s.linked ? "" : ` Guardado: ${fmtMoney(m.saved, normCur(m.currency))} de ${fmtMoney(m.target, normCur(m.currency))} (${normCur(m.currency)} original).`}</p></div>`;
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
        if (stripAccents(t.category) !== k) return;
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
      return `
      <tr data-id="${escapeHtml(t.id)}" class="${sel ? "tx-selected" : ""}">
        <td class="tx-check-col"><input type="checkbox" class="tx-sel" aria-label="Selecionar ${escapeHtml(t.desc)}" data-id="${escapeHtml(t.id)}" ${sel ? "checked" : ""}></td>
        <td style="white-space:nowrap">${fmtDate(t.date)}${cleanDateEstimate(t).dateEstimated ? '<br><span class="fixa-chip">Data aproximada</span>' : ""}</td>
        <td><span class="tx-desc-cell">${catAvatar(t.category)}<span class="tx-desc-text">${escapeHtml(t.desc) || '<span class="tx-desc-empty">Sem descrição</span>'}${t.cashback ? `<small class="hint cashback-info">Cashback: ${escapeHtml(String(t.cashback.amount))} ${escapeHtml(t.cashback.currency)} · informativo</small>` : ""}</span></span></td>
        <td><span class="cat-chip" style="background:color-mix(in srgb, ${catColor(ds, t.category)} 16%, var(--card,#24212e));color:var(--chip-text,var(--text,#f1eff5));border:1px solid color-mix(in srgb, ${catColor(ds, t.category)} 28%, var(--card,#24212e))">${escapeHtml(t.category)}</span></td>
        <td>${escapeHtml(t.account || "—")}</td>
        <td>${t.installment ? escapeHtml(t.installment) + (t.advance ? '<br><span class="fixa-chip">Adiantada</span>' : '') : (t.fixed ? '<span class="fixa-chip">Fixa</span>' : "—")}</td>
        <td class="num amount-${t.type}">${t.type === "despesa" ? "-" : "+"} ${fmtTxAmount(t)}</td>
        <td class="tx-actions">
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
      if (catMap && catMap[t.category]) t.category = catMap[t.category];
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
  function deleteSeries(mode) {
    const tx = pendingSeriesTx(pendingParcTx); pendingParcTx = null;
    $("#modal-del-parc").classList.add("hidden");
    if (!tx) return;
    const siblings = tx.fixed ? fixedSiblings(tx) : parcSiblings(tx);
    const chosen = mode === "one" ? [tx] : mode === "all" ? siblings : siblings.filter(t => tx.fixed ? t.date.slice(0,7) >= tx.date.slice(0,7) : installmentIdx(t) >= installmentIdx(tx));
    const folder=ds.id, owner=typeof Cloud !== "undefined" ? Cloud.getSyncState().owner : null;
    askConfirm("Confirmar exclusão", chosen.length + " lançamento(s) de “" + tx.desc + "” serão excluídos. " + (mode === "all" ? "Inclui os meses anteriores e seguintes desta série." : mode === "one" ? "As outras parcelas serão mantidas." : "Os meses anteriores serão mantidos."), () => {
      if(ds?.id!==folder || owner !== (typeof Cloud !== "undefined" ? Cloud.getSyncState().owner : null)) return;
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
    list.slice(0,count).forEach(t=>{t.advance={scheduledDate:t.date,paidDate:date};t.date=date;delete t.dateEstimated;delete t.dateEstimate;});
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
    const opts = CARDS.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`);
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
    receiptRead = null;
    txModalRevision++;

    $("#modal-tx-title").textContent = isEdit ? "Editar transação" : (opts.title || "Nova transação");
    txType = isEdit ? tx.type : (opts.type === "receita" ? "receita" : "despesa");
    updateTypeToggle();

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
    populateAccountSelect(isEdit ? (tx.account || "") : null);

    // Data padrão: hoje se estiver no mês filtrado, senão o dia 1º do mês filtrado
    let defDate = todayISO();
    if (!isEdit && fil.mode === "month" && fil.month && defDate.slice(0, 7) !== fil.month) defDate = fil.month + "-01";
    $("#tx-date").value = isEdit ? tx.date : defDate;

    // Categorias
    const catSel = $("#tx-cat");
    catSel.innerHTML = ds.categories.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join("") +
      `<option value="__new__">+ Nova categoria</option>`;
    catSel.value = isEdit && ds.categories.some((c) => c.name === tx.category) ? tx.category
      : (opts.category && ds.categories.some((c) => c.name === opts.category) ? opts.category
        : (ds.categories[0]?.name || "__new__"));
    $("#tx-newcat-wrap").classList.toggle("hidden", catSel.value !== "__new__");
    $("#tx-newcat").value = "";

    // Parcelamento e fixa só para transações novas
    $("#tx-parc-wrap").classList.toggle("hidden", isEdit);
    $("#tx-fixa-wrap").classList.toggle("hidden", isEdit);
    $("#tx-parcelado").checked = false;
    $("#tx-fixa").checked = false;
    $("#tx-nparc-wrap").classList.add("hidden");
    $("#tx-parc-hint").classList.add("hidden");
    $("#tx-nparc").value = 2;

    $("#modal-tx").classList.remove("hidden");
    setTimeout(() => $("#tx-amount").focus(), 50);
  }

  function updateTypeToggle() {
    $$("#tx-type-toggle button").forEach((b) => b.classList.toggle("active", b.dataset.type === txType));
  }

  function updateTxHints() {
    const parcOn = $("#tx-parcelado").checked;
    const fixaOn = $("#tx-fixa").checked;
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
      hint.textContent = `Serão criados ${FIXA_MESES} lançamentos mensais${total && total > 0 ? ` de ${f(total)}` : ""}, a partir da data escolhida. Para encerrar, exclua a partir de um mês.`;
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
    ensureCat(ds, category);

    const monthlyDate = (i) => {
      const [y0, m0, d0] = date.split("-").map(Number);
      let y = y0, m = m0 + i;
      y += Math.floor((m - 1) / 12); m = ((m - 1) % 12) + 1;
      const day = Math.min(d0, daysInMonth(y, m));
      return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    };

    let message;
    if (editingId) {
      const tx = ds.transactions.find((t) => t.id === editingId);
      if (!tx) { toast("Esta transação não está mais disponível. Abra a lista novamente."); return; }
      const dateChanged = txDateEdited || date !== tx.date;
      Object.assign(tx, { amount: Math.abs(amount), date, desc, category, account, type: txType, currency }, evidence);
      if (dateChanged) { delete tx.dateEstimated; delete tx.dateEstimate; }
      message = "Transação atualizada ✔";
    } else if (parts) {
      const n = parts.length;
      const groupId = uid();
      for (let i = 0; i < n; i++) {
        ds.transactions.push({
          id: uid(), groupId,
          date: monthlyDate(i),
          desc, category, account, type: txType,
          amount: parts[i],
          currency,
          installment: `${i + 1}/${n}`,
          totalValue: amount,
          ...(i === 0 ? evidence : {}),
        });
      }
      message = `Parcelamento criado: ${n} lançamentos ✔`;
    } else if ($("#tx-fixa").checked) {
      const groupId = uid();
      for (let i = 0; i < FIXA_MESES; i++) {
        ds.transactions.push({
          id: uid(), groupId, fixed: true,
          date: monthlyDate(i),
          desc, category, account, type: txType,
          amount: Math.abs(amount),
          currency,
          installment: null, totalValue: null,
          ...(i === 0 ? evidence : {}),
        });
      }
      message = `${txType === "receita" ? "Receita" : "Despesa"} fixa criada para os próximos ${FIXA_MESES} meses ✔`;
    } else {
      ds.transactions.push({
        id: uid(), date, desc, category, account, type: txType,
        amount: Math.abs(amount), currency, installment: null, totalValue: null,
        ...evidence,
      });
      message = "Transação adicionada ✔";
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
    const categories = ds?.categories || [];
    const category = categories.find((c) => stripAccents(c.name) === stripAccents(d.categoria || "")) || categories.find((c) => stripAccents(c.name) === "outros");
    $("#tx-cat").value = category?.name || "";
    $("#tx-newcat-wrap").classList.add("hidden");
    $("#tx-newcat").value = "";
    $("#tx-parcelado").checked = false;
    $("#tx-fixa").checked = false;
    updateTxHints();
    // Cartão/conta: preenche só quando a instituição bate sem ambiguidade
    // ("Nubank" sozinho não decide entre Nubank Yara e Nubank Gab)
    const inst = stripAccents(d.instituicao || "");
    const exact = CARDS.find((c) => stripAccents(c) === inst);
    const matches = inst ? CARDS.filter((c) => inst.includes(stripAccents(c)) || stripAccents(c).includes(inst)) : [];
    populateAccountSelect(exact || (matches.length === 1 ? matches[0] : ""));
  }

  /* ---------- Eventos ---------- */
  document.addEventListener("DOMContentLoaded", () => {
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
      fil.month = todayISO().slice(0, 7);
      rowLimit = 100;
      $("#month-menu").classList.add("hidden");
      renderAll();
    });
    $("#mm-grid").addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-ym]");
      if (!b) return;
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
    $("#btn-clear-tx-filters")?.addEventListener("click", () => {
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

    // Ações da tabela
    $("#tx-tbody").addEventListener("click", (ev) => {
      const tr = ev.target.closest("tr[data-id]");
      if (!tr) return;
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
      if (ev.target.classList.contains("tx-sel")) return;
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
    $("#tx-date").addEventListener("input", () => { txDateEdited = true; });
    $("#tx-date").addEventListener("change", () => { txDateEdited = true; });
    $$("#tx-type-toggle button").forEach((b) => {
      b.addEventListener("click", () => { txType = b.dataset.type; updateTypeToggle(); });
    });
    $("#tx-cat").addEventListener("change", (ev) => {
      $("#tx-newcat-wrap").classList.toggle("hidden", ev.target.value !== "__new__");
      if (ev.target.value === "__new__") $("#tx-newcat").focus();
    });
    $("#tx-account-sel").addEventListener("change", (ev) => {
      const other = ev.target.value === "__other__";
      $("#tx-account-other-wrap").classList.toggle("hidden", !other);
      if (other) $("#tx-account-other").focus();
    });
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
    const out = {...cleanDateEstimate(value),...cleanCashback(value)};
    for (const [key, max] of [["referenceId", 160], ["sourceEvidence", 300]]) {
      if (typeof value?.[key] === "string" && value[key].trim()) out[key] = value[key].trim().slice(0, max);
    }
    if (Number.isSafeInteger(value?.sourcePage) && value.sourcePage > 0) out.sourcePage = value.sourcePage;
    return out;
  }

  function getImportTargetId() { return ds?.id || null; }
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

  return { open, openTxModal, refreshFromStore, fillTxFromReceipt, getCats, addBulk, appendImported, currentDatasetName, getImportTargetId, existingTransactions, resolveImportDate, existingTxKeys, existingSeriesKeys, refitHero: fitHeroFlow };
})();
