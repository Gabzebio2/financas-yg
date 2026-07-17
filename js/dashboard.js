/* ===== Finanças YG — painel: resumo, gráficos, tabela, edição, limites ===== */
"use strict";

const Dashboard = (() => {
  let ds = null; // dataset aberto
  let fil = { mode: "month", month: null, from: "", to: "", cats: null, search: "" };
  let sort = { key: "date", dir: -1 };
  let rowLimit = 100;
  const charts = {};
  let editingId = null;
  let editingLimitId = null;
  let pendingParcTx = null; // transação parcelada aguardando escolha de exclusão
  const selectedTx = new Set(); // ids das transações marcadas (seleção em lote)

  const FIXA_MESES = 12; // quantos meses uma despesa fixa gera

  /* ---------- Abertura ---------- */
  function open(id) {
    const loaded = Store.loadDataset(id);
    if (!loaded) { toast("Pasta não encontrada 😕"); goHome(); return; }
    ds = loaded;
    if (!Array.isArray(ds.limits)) ds.limits = [];
    if (!Array.isArray(ds.metas)) ds.metas = [];
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
      month: months.includes(cur) ? cur : (months[months.length - 1] || cur),
      from: "", to: "", cats: null, search: "",
    };
    sort = { key: "date", dir: -1 };
    rowLimit = 100;
    selectedTx.clear();
    $("#tx-search").value = "";
    $("#filter-mode").value = "month";
    showScreen("screen-dash");
    renderAll();
  }

  function saveCur() {
    Store.saveDataset(ds);
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
    if (q) {
      list = list.filter((t) =>
        stripAccents(t.desc).includes(q) || stripAccents(t.category).includes(q) ||
        stripAccents(t.account).includes(q) || (t.installment || "").includes(q));
    }
    return list;
  }

  /* ---------- Renderização geral ---------- */
  function renderAll() {
    $("#ds-name").textContent = ds.name;
    renderPeriodControls();
    renderCatFilter();
    renderSummary();
    renderLimits();
    renderMetas();
    renderCharts();
    renderTable();
  }

  function renderPeriodControls() {
    $("#month-nav").classList.toggle("hidden", fil.mode !== "month");
    $("#range-nav").classList.toggle("hidden", fil.mode !== "range");
    if (fil.mode === "month" && fil.month) $("#month-label").textContent = fmtMonthLong(fil.month);
    $("#range-from").value = fil.from;
    $("#range-to").value = fil.to;
  }

  function stepMonth(delta) {
    let [y, m] = fil.month.split("-").map(Number);
    m += delta;
    if (m < 1) { m = 12; y--; }
    if (m > 12) { m = 1; y++; }
    fil.month = `${y}-${String(m).padStart(2, "0")}`;
    renderAll();
  }

  function renderCatFilter() {
    const btn = $("#cat-filter-btn");
    btn.textContent = fil.cats ? `${fil.cats.size} categoria(s) ▾` : "Todas as categorias ▾";
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
    const receitas = txs.filter((t) => t.type === "receita").reduce((s, t) => s + t.amount, 0);
    const despesas = txs.filter((t) => t.type === "despesa").reduce((s, t) => s + t.amount, 0);
    const saldo = receitas - despesas;

    const p = periodRange();
    const acumulado = ds.transactions
      .filter((t) => inCats(t) && (!p || !p.to || t.date <= p.to))
      .reduce((s, t) => s + (t.type === "receita" ? t.amount : -t.amount), 0);

    const label = fil.mode === "month" ? "do mês" : fil.mode === "range" ? "do período" : "total";
    $("#summary-cards").innerHTML = `
      <div class="sum-card">
        <span class="sum-label"><span class="sum-dot" style="background:var(--green)"></span>Receitas ${label}</span>
        <span class="sum-value pos">${fmtBRL(receitas)}</span>
      </div>
      <div class="sum-card">
        <span class="sum-label"><span class="sum-dot" style="background:var(--red)"></span>Despesas ${label}</span>
        <span class="sum-value neg">${fmtBRL(despesas)}</span>
      </div>
      <div class="sum-card">
        <span class="sum-label"><span class="sum-dot" style="background:var(--primary)"></span>Saldo ${label}</span>
        <span class="sum-value ${saldo >= 0 ? "pos" : "neg"}">${fmtBRL(saldo)}</span>
      </div>
      <div class="sum-card">
        <span class="sum-label"><span class="sum-dot" style="background:#8b5cf6"></span>Saldo acumulado</span>
        <span class="sum-value ${acumulado >= 0 ? "pos" : "neg"}">${fmtBRL(acumulado)}</span>
      </div>`;
  }

  /* ---------- Gráficos ---------- */
  function mkChart(canvasId, config) {
    if (charts[canvasId]) { charts[canvasId].destroy(); delete charts[canvasId]; }
    charts[canvasId] = new Chart($("#" + canvasId), config);
  }

  function setEmpty(canvasId, empty, msg) {
    const box = $("#" + canvasId).parentElement;
    let ov = box.querySelector(".chart-empty");
    if (empty) {
      if (!ov) {
        ov = document.createElement("div");
        ov.className = "chart-empty";
        ov.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#94a3b8;font-size:14px;text-align:center;padding:20px;";
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
      label: (ctx) => ` ${ctx.dataset.label || ctx.label}: ${fmtBRL(Math.abs(ctx.parsed.y ?? ctx.parsed.x ?? ctx.parsed))}`,
    },
  };
  const moneyTicks = { callback: (v) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }) };

  // Meses exibidos nos gráficos de evolução
  function chartMonths() {
    const months = allMonths();
    if (fil.mode === "range") {
      return months.filter((ym) => (!fil.from || ym >= fil.from.slice(0, 7)) && (!fil.to || ym <= fil.to.slice(0, 7)));
    }
    return months;
  }

  function renderCharts() {
    Chart.defaults.font.family = "'Segoe UI', system-ui, sans-serif";
    Chart.defaults.color = "#64748b";
    const txs = filteredTxs();

    /* 1. Rosca — gastos por categoria */
    const byCat = {};
    txs.filter((t) => t.type === "despesa").forEach((t) => { byCat[t.category] = (byCat[t.category] || 0) + t.amount; });
    const catEntries = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
    setEmpty("chart-cat", !catEntries.length, "Sem despesas no período selecionado");
    mkChart("chart-cat", {
      type: "doughnut",
      data: {
        labels: catEntries.map(([c]) => c),
        datasets: [{
          data: catEntries.map(([, v]) => v),
          backgroundColor: catEntries.map(([c]) => catColor(ds, c)),
          borderWidth: 2, borderColor: "#fff",
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: "62%",
        plugins: {
          legend: { position: "right" },
          tooltip: { callbacks: { label: (ctx) => ` ${ctx.label}: ${fmtBRL(ctx.parsed)}` } },
        },
      },
    });

    /* 2 e 3. Evolução mensal (linha) e saldo (barra + acumulado) */
    const months = chartMonths();
    const recM = {}, despM = {};
    ds.transactions.filter(inCats).forEach((t) => {
      const ym = t.date.slice(0, 7);
      if (t.type === "receita") recM[ym] = (recM[ym] || 0) + t.amount;
      else despM[ym] = (despM[ym] || 0) + t.amount;
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
          { label: "Receitas", data: recData, borderColor: "#16a34a", backgroundColor: "rgba(22,163,74,.12)", fill: true, tension: .3, pointRadius: 3 },
          { label: "Despesas", data: despData, borderColor: "#e11d48", backgroundColor: "rgba(225,29,72,.12)", fill: true, tension: .3, pointRadius: 3 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: "bottom" }, tooltip: moneyTip },
        scales: { y: { ticks: moneyTicks } },
      },
    });

    // Saldo acumulado inclui meses anteriores à janela exibida
    const allM = allMonths();
    let run = 0;
    const cumByMonth = {};
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
            backgroundColor: saldoData.map((v) => (v >= 0 ? "rgba(22,163,74,.65)" : "rgba(225,29,72,.65)")),
            borderRadius: 6,
          },
          { type: "line", label: "Acumulado", data: cumData, borderColor: "#4a6cf7", backgroundColor: "#4a6cf7", tension: .3, pointRadius: 3 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: "bottom" }, tooltip: moneyTip },
        scales: { y: { ticks: moneyTicks } },
      },
    });

    /* 4. Barras horizontais — gastos por cartão/conta */
    const byAcc = {};
    txs.filter((t) => t.type === "despesa").forEach((t) => {
      const a = t.account || "(sem cartão)";
      byAcc[a] = (byAcc[a] || 0) + t.amount;
    });
    const accEntries = Object.entries(byAcc).sort((a, b) => b[1] - a[1]).slice(0, 8);
    setEmpty("chart-conta", !accEntries.length, "Sem despesas no período selecionado");
    mkChart("chart-conta", {
      type: "bar",
      data: {
        labels: accEntries.map(([a]) => a),
        datasets: [{
          label: "Despesas", data: accEntries.map(([, v]) => v),
          backgroundColor: "#4a6cf7", borderRadius: 8, maxBarThickness: 34,
        }],
      },
      options: {
        indexAxis: "y", responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => ` ${fmtBRL(ctx.parsed.x)}` } } },
        scales: { x: { ticks: moneyTicks } },
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
    const spentByCat = {};
    ds.transactions
      .filter((t) => t.type === "despesa" && inPeriod(t, p))
      .forEach((t) => {
        const k = stripAccents(t.category);
        spentByCat[k] = (spentByCat[k] || 0) + t.amount;
      });
    return (ds.limits || []).map((base) => {
      const v = versionFor(base, ym);
      const L = { ...base, amount: v.amount, categories: v.categories, since: v.from !== "0000-00" ? v.from : null };
      // O filtro de categorias do painel também filtra os limites:
      // grupos sem nenhuma categoria selecionada somem; nos demais, só somam as categorias visíveis
      const visibleCats = L.categories.filter((c) => !fil.cats || fil.cats.has(stripAccents(c)));
      if (!visibleCats.length) return null;
      const spent = visibleCats.reduce((s, c) => s + (spentByCat[stripAccents(c)] || 0), 0);
      const pct = L.amount > 0 ? (spent / L.amount) * 100 : 0;
      return {
        ...L, visibleCats,
        filtered: visibleCats.length < L.categories.length,
        spent, remaining: L.amount - spent, pct,
      };
    }).filter(Boolean);
  }

  function renderLimits() {
    const groups = limitStats();
    const total = (ds.limits || []).length;
    const label = fil.mode === "month" ? "no mês" : fil.mode === "range" ? "no período" : "no total";

    // Linha de resumo no cabeçalho do bloco
    const ov = $("#limits-overview");
    if (!total) {
      ov.textContent = "Defina tetos de gasto por grupo de categorias e acompanhe tudo por aqui.";
    } else if (!groups.length) {
      ov.textContent = "Nenhum limite corresponde ao filtro de categorias atual.";
    } else {
      const totLim = groups.reduce((s, g) => s + g.amount, 0);
      const totSpent = groups.reduce((s, g) => s + g.spent, 0);
      const nOver = groups.filter((g) => g.remaining < 0).length;
      const pct = totLim > 0 ? Math.round((totSpent / totLim) * 100) : 0;
      ov.innerHTML = `${fmtBRL(totSpent)} gastos de ${fmtBRL(totLim)} ${label} (${pct}%)` +
        (nOver
          ? ` · <span class="limit-over-txt">${nOver} limite(s) estourado(s) ⚠</span>`
          : ` · <span class="limit-ok-txt">tudo dentro do limite ✔</span>`);
    }

    // Lista de grupos (barras de progresso compactas)
    const wrap = $("#limits-groups");
    if (!groups.length) {
      wrap.innerHTML = `<div class="empty-limits">${total
        ? "Os limites existentes não incluem as categorias filtradas — ajuste o filtro para vê-los."
        : `Nenhum limite criado ainda.<br>Ex: <b>Essencial + Compra do mês → R$ 3.340,00</b>. Clique em <b>＋ Novo limite</b> para começar.`}</div>`;
    } else {
      wrap.innerHTML = groups.map((g) => {
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
              <button class="btn-icon" data-action="edit-limit" title="Editar limite">✎</button>
              <button class="btn-icon" data-action="delete-limit" title="Excluir limite">🗑</button>
            </div>
          </div>
          <div class="progress"><div class="progress-bar ${barCls}" style="width:${Math.min(100, g.pct)}%"></div></div>
          <div class="limit-nums">
            <span>Gasto: <b class="${over ? "limit-over-txt" : ""}">${fmtBRL(g.spent)}</b> de ${fmtBRL(g.amount)} <span class="limit-pct">(${g.pct.toFixed(0)}%)</span></span>
            <span>${over
              ? `<span class="limit-over-txt">⚠ Ultrapassou em ${fmtBRL(-g.remaining)}</span>`
              : `<span class="limit-ok-txt">Falta ${fmtBRL(g.remaining)}</span>`}</span>
          </div>
        </div>`;
      }).join("");
    }

    // Gráfico gasto × limite (some quando não há grupos visíveis)
    $("#limits-chart-box").classList.toggle("hidden", !groups.length);
    $("#limits-body").classList.toggle("no-chart", !groups.length);
    if (!groups.length) {
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
            backgroundColor: groups.map((g) => (g.remaining < 0 ? "#e11d48" : g.pct >= 70 ? "#f59e0b" : "#4a6cf7")),
            borderRadius: 8, maxBarThickness: 30,
          },
          {
            label: "Limite", data: groups.map((g) => g.amount),
            backgroundColor: "#cbd5e1", borderRadius: 8, maxBarThickness: 30,
          },
        ],
      },
      options: {
        indexAxis: "y", responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: "bottom" }, tooltip: moneyTip },
        scales: { x: { ticks: moneyTicks } },
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

  // Calcula progresso da meta (vinculada = a partir das transações da categoria)
  function metaStats(m) {
    if (m.category) {
      const k = stripAccents(m.category);
      let owed = 0, paid = 0;
      ds.transactions.forEach((t) => {
        if (stripAccents(t.category) !== k) return;
        if (t.type === "despesa") owed += t.amount; else paid += t.amount;
      });
      const target = Math.round(owed * 100) / 100;
      const saved = Math.round(paid * 100) / 100;
      return { linked: true, target, saved, done: target > 0 && saved >= target - 0.004, pct: target > 0 ? (saved / target) * 100 : 0 };
    }
    const done = m.target > 0 && m.saved >= m.target - 0.004;
    return { linked: false, target: m.target, saved: m.saved, done, pct: m.target > 0 ? (m.saved / m.target) * 100 : 0 };
  }

  function renderMetas() {
    const metas = ds.metas || [];
    $("#metas-sec").classList.toggle("hidden", !metas.length);
    if (!metas.length) return;
    $("#metas-groups").innerHTML = metas.map((m) => {
      const s = metaStats(m);
      const empty = s.linked && s.target <= 0;
      const icon = s.done ? "🏆" : (s.linked ? "🤝" : "🎯");
      const catLine = s.linked ? `<span class="limit-cats-line">· cobrança de ${escapeHtml(m.category)}</span>` : "";
      // Meta de amigo: lançar gasto (dívida) + registrar pagamento + importar.
      // Meta de poupança: só o aporte.
      const chargeBtn = s.linked
        ? `<button class="btn btn-ghost btn-sm meta-add-btn" data-action="meta-charge" title="Adicionar manualmente um gasto que ${escapeHtml(m.name)} deve">＋ Gasto</button>`
        : "";
      const addBtn = (s.done && s.linked) ? "" :
        `<button class="btn btn-ghost btn-sm meta-add-btn" data-action="meta-add">${s.linked ? "＋ Pagamento" : "＋ Adicionar valor"}</button>`;
      const importBtn = s.linked
        ? `<button class="btn btn-ghost btn-sm meta-add-btn" data-action="meta-import" title="Ler foto de fatura/planilha ou Excel e lançar todos os gastos nesta categoria">📄 Importar</button>`
        : "";
      const leftNum = s.linked
        ? `<span>Pagaram: <b class="${s.done ? "limit-ok-txt" : ""}">${fmtBRL(s.saved)}</b> de ${fmtBRL(s.target)} <span class="limit-pct">(${s.pct.toFixed(0)}%)</span></span>`
        : `<span>Guardado: <b>${fmtBRL(s.saved)}</b> de ${fmtBRL(s.target)} <span class="limit-pct">(${s.pct.toFixed(0)}%)</span></span>`;
      const rightNum = empty
        ? `<span class="limit-cats-line">Sem despesas nessa categoria ainda</span>`
        : s.done
          ? `<span class="limit-ok-txt">${s.linked ? "Quitou tudo! 🎉" : "Meta alcançada! 🎉"}</span>`
          : `<span>${s.linked ? "Falta receber" : "Falta"} ${fmtBRL(Math.max(0, s.target - s.saved))}</span>`;
      return `
      <div class="limit-row meta-row ${s.done ? "meta-done" : ""}" data-id="${escapeHtml(m.id)}">
        <div class="limit-row-top">
          <div class="limit-name">${icon} ${escapeHtml(m.name)}${catLine}${s.done ? '<span class="meta-done-chip">Finalizada ✔</span>' : ""}</div>
          <div class="limit-actions">
            ${chargeBtn}
            ${importBtn}
            ${addBtn}
            <button class="btn-icon" data-action="edit-meta" title="Editar meta">✎</button>
            <button class="btn-icon" data-action="delete-meta" title="Excluir meta">🗑</button>
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
    $(".meta-modal-sub").textContent = linked
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
        if (t.type === "despesa") owed += t.amount; else paid += t.amount;
      });
      if (owed <= 0) return empty("Ainda não há despesas nessa categoria");
      target = owed; saved = paid;
    } else {
      target = parseMoney($("#meta-target").value);
      saved = Math.abs(parseMoney($("#meta-saved").value) ?? 0);
      if (target == null || target <= 0) return empty("Preencha os valores para ver o progresso");
    }

    const pct = (saved / target) * 100;
    const done = saved >= target - 0.004;
    bar.style.width = Math.min(100, pct) + "%";
    bar.classList.toggle("done", done);
    pctEl.textContent = pct.toFixed(0) + "%";
    txt.textContent = metaMode === "linked"
      ? (done ? "Quitou tudo! 🎉" : `Já pagaram ${fmtBRL(saved)} · falta ${fmtBRL(target - saved)}`)
      : (done ? "Meta alcançada! 🎉" : `Faltam ${fmtBRL(target - saved)} para o objetivo`);
  }

  function openMetaModal(id) {
    editingMetaId = id;
    const m = id ? ds.metas.find((x) => x.id === id) : null;
    $("#modal-meta-title").textContent = m ? "Editar Meta" : "Nova Meta";
    $("#meta-name").value = m ? m.name : "";
    $("#meta-cat").innerHTML = ds.categories.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join("");
    const linked = !!(m && m.category);
    if (linked && ds.categories.some((c) => stripAccents(c.name) === stripAccents(m.category))) $("#meta-cat").value = m.category;
    $("#meta-target").value = (m && !m.category) ? fmtMoneyInput(m.target) : "";
    $("#meta-saved").value = (m && !m.category) ? fmtMoneyInput(m.saved) : "";
    // Ao editar, o tipo é fixo (não converte poupança <-> cobrança)
    $("#meta-mode-toggle").classList.toggle("hidden", !!m);
    setMetaMode(linked ? "linked" : "manual");
    $("#modal-meta").classList.remove("hidden");
    setTimeout(() => $("#meta-name").focus(), 50);
  }

  function saveMetaModal() {
    const name = $("#meta-name").value.trim();
    if (!name) { toast("Dê um nome para a meta 🎯"); $("#meta-name").focus(); return; }

    if (metaMode === "linked") {
      const category = $("#meta-cat").value;
      if (!category) { toast("Escolha a categoria da cobrança 🏷️"); return; }
      if (editingMetaId) {
        const m = ds.metas.find((x) => x.id === editingMetaId);
        if (m) { m.name = name; m.category = category; delete m.target; delete m.saved; }
        toast("Meta atualizada ✔");
      } else {
        ds.metas.push({ id: uid(), name, category });
        toast("Meta de cobrança criada ✔");
      }
    } else {
      const target = parseMoney($("#meta-target").value);
      if (target == null || target <= 0) { toast("Informe o valor da meta 💰"); $("#meta-target").focus(); return; }
      const saved = Math.abs(parseMoney($("#meta-saved").value) ?? 0);
      if (editingMetaId) {
        const m = ds.metas.find((x) => x.id === editingMetaId);
        if (m) { m.name = name; m.target = Math.abs(target); m.saved = saved; delete m.category; }
        toast("Meta atualizada ✔");
      } else {
        ds.metas.push({ id: uid(), name, target: Math.abs(target), saved });
        toast("Meta criada ✔");
      }
    }
    $("#modal-meta").classList.add("hidden");
    editingMetaId = null;
    saveCur();
    renderMetas();
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
    askName(`Quanto adicionar em "${m.name}"?`, "", (v) => {
      const n = parseMoney(v);
      if (n == null || n <= 0) { toast("Valor inválido — use algo como R$ 150,00 💰"); return; }
      m.saved = Math.round((m.saved + n) * 100) / 100;
      saveCur();
      renderMetas();
      if (m.saved >= m.target - 0.004) toast("🎉 Parabéns! Meta \"" + m.name + "\" alcançada!");
      else toast(`${fmtBRL(n)} adicionados à meta ✔`);
    }, { money: true });
  }

  /* ---------- Modal de limite ---------- */
  function openLimitModal(id) {
    editingLimitId = id;
    const L = id ? ds.limits.find((x) => x.id === id) : null;
    const v = L ? versionFor(L, refMonth()) : null; // valores vigentes no mês em vista
    $("#modal-limit-title").textContent = L ? "Editar limite" : "Novo limite";
    $("#limit-name").value = L ? L.name : "";
    $("#limit-amount").value = v ? fmtMoneyInput(v.amount) : "";
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
    const amount = parseMoney($("#limit-amount").value);
    if (amount == null || amount <= 0) { toast("Informe o valor do limite 💰"); $("#limit-amount").focus(); return; }
    const cats = $$("#limit-cats input:checked").map((i) => i.value);
    if (!cats.length) { toast("Selecione pelo menos uma categoria 🏷️"); return; }
    let name = $("#limit-name").value.trim();
    if (!name) name = cats.join(" + ");
    const newVals = { amount: Math.abs(amount), categories: cats };

    if (editingLimitId) {
      const L = ds.limits.find((x) => x.id === editingLimitId);
      if (L) {
        L.name = name;
        const scopeFrom = fil.mode === "month" && fil.month &&
          $('input[name="limit-scope"]:checked')?.value === "from";
        if (scopeFrom) {
          // Deste mês em diante: meses anteriores mantêm as versões antigas
          const M = fil.month;
          L.versions = (L.versions || [])
            .filter((vv) => vv.from < M)
            .concat([{ from: M, ...newVals }])
            .sort((a, b) => a.from.localeCompare(b.from));
          toast(`Limite atualizado a partir de ${fmtMonthLong(M)} ✔`);
        } else {
          L.versions = [{ from: "0000-00", ...newVals }];
          toast("Limite atualizado em todos os meses ✔");
        }
        // Campos de topo refletem a versão mais recente (compatibilidade)
        const last = L.versions[L.versions.length - 1];
        L.amount = last.amount;
        L.categories = last.categories;
      }
    } else {
      ds.limits.push({
        id: uid(), name, ...newVals,
        versions: [{ from: "0000-00", ...newVals }],
      });
      toast("Limite criado ✔");
    }
    $("#modal-limit").classList.add("hidden");
    editingLimitId = null;
    saveCur();
    renderAll();
  }

  /* ---------- Tabela ---------- */
  function sortTxs(list) {
    const { key, dir } = sort;
    return list.slice().sort((a, b) => {
      let va = a[key], vb = b[key];
      if (key === "amount") {
        va = a.type === "despesa" ? -a.amount : a.amount;
        vb = b.type === "despesa" ? -b.amount : b.amount;
        return (va - vb) * dir;
      }
      va = String(va ?? ""); vb = String(vb ?? "");
      const cmp = va.localeCompare(vb, "pt-BR");
      return cmp !== 0 ? cmp * dir : a.date.localeCompare(b.date) * dir;
    });
  }

  function renderTable() {
    const list = sortTxs(tableTxs());
    $("#tx-count").textContent = list.length;

    $$("#tx-table thead th[data-sort]").forEach((th) => {
      th.querySelector(".sort-ind").textContent = th.dataset.sort === sort.key ? (sort.dir === 1 ? "▲" : "▼") : "";
    });

    const tbody = $("#tx-tbody");
    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="empty-table">Nenhuma transação no filtro atual.<br>Clique em <b>＋ Nova transação</b> para adicionar.</td></tr>`;
      $("#btn-more-rows").classList.add("hidden");
      updateBulkBar();
      return;
    }
    const visible = list.slice(0, rowLimit);
    tbody.innerHTML = visible.map((t) => {
      const sel = selectedTx.has(t.id);
      return `
      <tr data-id="${escapeHtml(t.id)}" class="${sel ? "tx-selected" : ""}">
        <td class="tx-check-col"><input type="checkbox" class="tx-sel" data-id="${escapeHtml(t.id)}" ${sel ? "checked" : ""}></td>
        <td style="white-space:nowrap">${fmtDate(t.date)}</td>
        <td>${escapeHtml(t.desc)}</td>
        <td><span class="cat-chip" style="background:${catColor(ds, t.category)}">${escapeHtml(t.category)}</span></td>
        <td>${escapeHtml(t.account || "—")}</td>
        <td>${t.installment ? escapeHtml(t.installment) : (t.fixed ? '<span class="fixa-chip">Fixa</span>' : "—")}</td>
        <td class="num amount-${t.type}">${t.type === "despesa" ? "-" : "+"} ${fmtBRL(t.amount)}</td>
        <td class="tx-actions">
          <button class="btn-icon" data-action="edit" title="Editar">✎</button>
          <button class="btn-icon" data-action="delete" title="Excluir">🗑</button>
        </td>
      </tr>`;
    }).join("");
    $("#btn-more-rows").classList.toggle("hidden", list.length <= rowLimit);
    $("#btn-more-rows").textContent = `Mostrar mais (${list.length - visible.length} restantes)`;

    // "selecionar todas" reflete o estado das visíveis
    const allSel = visible.length > 0 && visible.every((t) => selectedTx.has(t.id));
    $("#tx-sel-all").checked = allSel;
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
    $("#bulk-cat").innerHTML = ds.categories.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join("");
    const accounts = Array.from(new Set([...CARDS, ...ds.transactions.map((t) => t.account).filter(Boolean)]));
    $("#bulk-acc").innerHTML = accounts.map((a) => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join("")
      + `<option value="">(sem cartão)</option>`;
    ["bulk-cat", "bulk-acc", "bulk-type"].forEach((f) => { $(`#${f}-on`).checked = false; $(`#${f}-wrap`).classList.add("hidden"); });
    $("#modal-bulk-edit").classList.remove("hidden");
  }

  function saveBulkEdit() {
    const changes = {};
    if ($("#bulk-cat-on").checked) changes.category = $("#bulk-cat").value;
    if ($("#bulk-acc-on").checked) changes.account = $("#bulk-acc").value;
    if ($("#bulk-type-on").checked) changes.type = $("#bulk-type").value;
    if (!Object.keys(changes).length) { toast("Marque ao menos um campo para alterar ✎"); return; }
    if (changes.category) ensureCat(ds, changes.category);
    let n = 0;
    ds.transactions.forEach((t) => {
      if (!selectedTx.has(t.id)) return;
      Object.assign(t, changes);
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
    return ds.transactions.filter((t) =>
      installmentTotal(t) === n && t.desc === tx.desc && t.account === tx.account &&
      t.type === tx.type && (t.totalValue ?? null) === (tx.totalValue ?? null));
  }

  function fixedSiblings(tx) {
    if (tx.groupId) return ds.transactions.filter((t) => t.groupId === tx.groupId);
    return ds.transactions.filter((t) => t.fixed && t.desc === tx.desc && t.account === tx.account && t.type === tx.type);
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

    if (tx.fixed) {
      const ids = fixedSiblings(tx).filter((t) => t.date >= tx.date).map((t) => t.id);
      askConfirm("Excluir despesa fixa?",
        `"${tx.desc}" será excluída de ${fmtDate(tx.date)} em diante — este mês e todos os meses seguintes (${ids.length} lançamento(s)). Os meses anteriores são mantidos.`,
        () => removeTxs(ids, `Despesa fixa excluída deste mês em diante (${ids.length} lançamentos).`));
      return;
    }

    if (installmentTotal(tx) > 1) {
      pendingParcTx = tx;
      $("#modal-del-parc-text").textContent = `"${tx.desc}" — parcela ${tx.installment} de ${fmtBRL(tx.amount)} em ${fmtDate(tx.date)}. O que você quer excluir?`;
      $("#modal-del-parc").classList.remove("hidden");
      return;
    }

    askConfirm("Excluir transação?", `"${tx.desc}" de ${fmtBRL(tx.amount)} será removida.`, () =>
      removeTxs([tx.id], "Transação excluída."));
  }

  /* ---------- Modal de transação ---------- */
  let txType = "despesa";

  function populateAccountSelect(current) {
    // current: string (pode ser "") para edição; null para transação nova (padrão C6)
    const extras = Array.from(new Set(
      ds.transactions.map((t) => t.account).filter((a) => a && !CARDS.includes(a))
    )).sort();
    const sel = $("#tx-account-sel");
    const opts = CARDS.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`);
    extras.forEach((a) => opts.push(`<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`));
    if (current === "") opts.push(`<option value="">(sem cartão)</option>`);
    opts.push(`<option value="__other__">➕ Outro…</option>`);
    sel.innerHTML = opts.join("");
    sel.value = current == null ? "C6" : current;
    if (sel.selectedIndex === -1) sel.value = "C6";
    $("#tx-account-other-wrap").classList.add("hidden");
    $("#tx-account-other").value = "";
  }

  // opts (opcional, só para nova transação): { category, type, desc, title }
  // usado pelos atalhos de "Adicionar gasto/pagamento" nas metas de amigo.
  function openTxModal(txId, opts) {
    opts = opts || {};
    editingId = txId;
    const isEdit = !!txId;
    const tx = isEdit ? ds.transactions.find((t) => t.id === txId) : null;
    if (isEdit && !tx) return;

    $("#modal-tx-title").textContent = isEdit ? "Editar transação" : (opts.title || "Nova transação");
    txType = isEdit ? tx.type : (opts.type === "receita" ? "receita" : "despesa");
    updateTypeToggle();

    // Reseta o leitor de comprovante
    $("#apikey-wrap").classList.add("hidden");
    const rs = $("#receipt-status");
    rs.textContent = "";
    rs.className = "receipt-status hidden";

    $("#tx-amount").value = isEdit ? fmtMoneyInput(tx.amount) : "";
    $("#tx-desc").value = isEdit ? tx.desc : (opts.desc || "");
    populateAccountSelect(isEdit ? (tx.account || "") : null);

    // Data padrão: hoje se estiver no mês filtrado, senão o dia 1º do mês filtrado
    let defDate = todayISO();
    if (!isEdit && fil.mode === "month" && fil.month && defDate.slice(0, 7) !== fil.month) defDate = fil.month + "-01";
    $("#tx-date").value = isEdit ? tx.date : defDate;

    // Categorias
    const catSel = $("#tx-cat");
    catSel.innerHTML = ds.categories.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join("") +
      `<option value="__new__">➕ Nova categoria…</option>`;
    catSel.value = isEdit && ds.categories.some((c) => c.name === tx.category) ? tx.category
      : (opts.category && ds.categories.some((c) => c.name === opts.category) ? opts.category
        : (ds.categories[0]?.name || "__new__"));
    $("#tx-newcat-wrap").classList.add("hidden");
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
    const total = parseMoney($("#tx-amount").value);

    if (parcOn && total && total > 0) {
      const n = Math.max(2, Number($("#tx-nparc").value) || 2);
      hint.textContent = `Será criado 1 lançamento por mês: ${n}x de ${fmtBRL(Math.round((total / n) * 100) / 100)} (valor total ${fmtBRL(total)}).`;
      hint.classList.remove("hidden");
    } else if (fixaOn) {
      hint.textContent = `Serão criados ${FIXA_MESES} lançamentos mensais${total && total > 0 ? ` de ${fmtBRL(total)}` : ""}, a partir da data escolhida. Para encerrar, exclua a partir de um mês.`;
      hint.classList.remove("hidden");
    } else {
      hint.classList.add("hidden");
    }
  }

  function saveTxModal() {
    const amount = parseMoney($("#tx-amount").value);
    if (amount == null || amount <= 0) { toast("Informe um valor válido 💰"); $("#tx-amount").focus(); return; }
    const date = $("#tx-date").value;
    if (!date) { toast("Informe a data 📅"); $("#tx-date").focus(); return; }
    const desc = $("#tx-desc").value.trim() || "(sem descrição)";
    let category = $("#tx-cat").value;
    if (category === "__new__") {
      category = $("#tx-newcat").value.trim();
      if (!category) { toast("Dê um nome para a nova categoria 🏷️"); $("#tx-newcat").focus(); return; }
    }
    ensureCat(ds, category);

    let account = $("#tx-account-sel").value;
    if (account === "__other__") {
      account = $("#tx-account-other").value.trim();
      if (!account) { toast("Dê um nome para o cartão/conta 💳"); $("#tx-account-other").focus(); return; }
    }

    const monthlyDate = (i) => {
      const [y0, m0, d0] = date.split("-").map(Number);
      let y = y0, m = m0 + i;
      y += Math.floor((m - 1) / 12); m = ((m - 1) % 12) + 1;
      const day = Math.min(d0, daysInMonth(y, m));
      return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    };

    if (editingId) {
      const tx = ds.transactions.find((t) => t.id === editingId);
      if (tx) Object.assign(tx, { amount: Math.abs(amount), date, desc, category, account, type: txType });
      toast("Transação atualizada ✔");
    } else if ($("#tx-parcelado").checked && Number($("#tx-nparc").value) > 1) {
      const n = Math.min(48, Math.max(2, Number($("#tx-nparc").value)));
      const per = Math.round((amount / n) * 100) / 100;
      const last = Math.round((amount - per * (n - 1)) * 100) / 100;
      const groupId = uid();
      for (let i = 0; i < n; i++) {
        ds.transactions.push({
          id: uid(), groupId,
          date: monthlyDate(i),
          desc, category, account, type: txType,
          amount: i === n - 1 ? last : per,
          installment: `${i + 1}/${n}`,
          totalValue: amount,
        });
      }
      toast(`Compra parcelada criada: ${n} lançamentos ✔`);
    } else if ($("#tx-fixa").checked) {
      const groupId = uid();
      for (let i = 0; i < FIXA_MESES; i++) {
        ds.transactions.push({
          id: uid(), groupId, fixed: true,
          date: monthlyDate(i),
          desc, category, account, type: txType,
          amount: Math.abs(amount),
          installment: null, totalValue: null,
        });
      }
      toast(`Despesa fixa criada para os próximos ${FIXA_MESES} meses ✔`);
    } else {
      ds.transactions.push({
        id: uid(), date, desc, category, account, type: txType,
        amount: Math.abs(amount), installment: null, totalValue: null,
      });
      toast("Transação adicionada ✔");
    }
    $("#modal-tx").classList.add("hidden");
    editingId = null;
    saveCur();
    renderAll();
  }

  /* ---------- Preenchimento via comprovante (IA) ---------- */
  function getCats() {
    return ds ? ds.categories.map((c) => c.name) : DEFAULT_CATS.slice();
  }

  function fillTxFromReceipt(d) {
    if (!d) return;
    // Pix/transferência enviada = despesa (débito); comprovante de recebimento = receita
    txType = d.direcao === "recebido" ? "receita" : "despesa";
    updateTypeToggle();
    if (typeof d.valor === "number" && d.valor > 0) {
      $("#tx-amount").value = fmtMoneyInput(d.valor);
      $("#tx-amount").dispatchEvent(new Event("input"));
    }
    if (typeof d.data === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.data)) $("#tx-date").value = d.data;
    if (d.descricao) $("#tx-desc").value = String(d.descricao).slice(0, 120);
    if (d.categoria) {
      const sel = $("#tx-cat");
      const opt = Array.from(sel.options).find((o) => stripAccents(o.value) === stripAccents(d.categoria));
      if (opt) sel.value = opt.value;
    }
    // Cartão/conta: preenche só quando a instituição bate sem ambiguidade
    // ("Nubank" sozinho não decide entre Nubank Yara e Nubank Gab)
    const inst = stripAccents(d.instituicao || "");
    if (inst && !inst.includes("nubank")) {
      const match = CARDS.find((c) => inst.includes(stripAccents(c)) || stripAccents(c).includes(inst));
      if (match) {
        const sel = $("#tx-account-sel");
        sel.value = match;
        if (sel.selectedIndex === -1) sel.value = "C6";
      }
    }
  }

  /* ---------- Eventos ---------- */
  document.addEventListener("DOMContentLoaded", () => {
    // Máscara de moeda (R$ 10,25) em todos os campos fixos de valor
    ["#tx-amount", "#meta-target", "#meta-saved", "#limit-amount"].forEach((s) => attachMoneyMask($(s)));

    // Filtro de período
    $("#filter-mode").addEventListener("change", (ev) => {
      fil.mode = ev.target.value;
      if (fil.mode === "range" && !fil.from && !fil.to) {
        const months = allMonths();
        if (months.length) {
          fil.from = months[0] + "-01";
          const last = months[months.length - 1];
          const [y, m] = last.split("-").map(Number);
          fil.to = `${last}-${String(daysInMonth(y, m)).padStart(2, "0")}`;
        }
      }
      renderAll();
    });
    $("#month-prev").addEventListener("click", () => stepMonth(-1));
    $("#month-next").addEventListener("click", () => stepMonth(1));
    $("#range-from").addEventListener("change", (ev) => { fil.from = ev.target.value; renderAll(); });
    $("#range-to").addEventListener("change", (ev) => { fil.to = ev.target.value; renderAll(); });

    // Filtro de categorias
    $("#cat-filter-btn").addEventListener("click", (ev) => {
      ev.stopPropagation();
      $("#cat-dropdown").classList.toggle("hidden");
    });
    document.addEventListener("click", (ev) => {
      if (!ev.target.closest("#cat-filter")) $("#cat-dropdown").classList.add("hidden");
    });
    $("#cat-dropdown").addEventListener("change", (ev) => {
      const cat = ev.target.dataset.cat;
      if (!cat) return;
      if (cat === "__all__") {
        fil.cats = null;
      } else {
        if (!fil.cats) fil.cats = new Set(ds.categories.map((c) => stripAccents(c.name)));
        if (ev.target.checked) fil.cats.add(cat); else fil.cats.delete(cat);
        if (fil.cats.size === ds.categories.length || fil.cats.size === 0) fil.cats = null;
      }
      renderAll();
      $("#cat-dropdown").classList.remove("hidden"); // mantém aberto para multi-seleção
    });

    // Busca e ordenação
    $("#tx-search").addEventListener("input", (ev) => { fil.search = ev.target.value; rowLimit = 100; renderTable(); });
    $$("#tx-table thead th[data-sort]").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        if (sort.key === key) sort.dir *= -1;
        else { sort.key = key; sort.dir = key === "date" ? -1 : 1; }
        renderTable();
      });
    });
    $("#btn-more-rows").addEventListener("click", () => { rowLimit += 200; renderTable(); });

    // Ações da tabela
    $("#tx-tbody").addEventListener("click", (ev) => {
      const tr = ev.target.closest("tr[data-id]");
      if (!tr) return;
      const action = ev.target.closest("[data-action]")?.dataset.action;
      if (action === "delete") requestDeleteTx(tr.dataset.id);
      else if (action === "edit") openTxModal(tr.dataset.id);
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
      updateBulkBar();
    });
    // "selecionar todas as visíveis"
    $("#tx-sel-all").addEventListener("change", (ev) => {
      const on = ev.target.checked;
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
      askConfirm("Excluir selecionadas?", `${ids.length} transaç${ids.length === 1 ? "ão" : "ões"} selecionada(s) serão removidas. Essa ação não pode ser desfeita.`, () => {
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
    ["bulk-cat", "bulk-acc", "bulk-type"].forEach((f) => {
      $(`#${f}-on`).addEventListener("change", (ev) => $(`#${f}-wrap`).classList.toggle("hidden", !ev.target.checked));
    });

    // Modal de exclusão de parcelada
    $("#btn-delparc-cancel").addEventListener("click", () => { $("#modal-del-parc").classList.add("hidden"); pendingParcTx = null; });
    $("#btn-delparc-one").addEventListener("click", () => {
      if (pendingParcTx) removeTxs([pendingParcTx.id], "Parcela excluída.");
      $("#modal-del-parc").classList.add("hidden");
      pendingParcTx = null;
    });
    $("#btn-delparc-following").addEventListener("click", () => {
      if (pendingParcTx) {
        const idx = installmentIdx(pendingParcTx);
        const ids = parcSiblings(pendingParcTx).filter((t) => installmentIdx(t) >= idx).map((t) => t.id);
        removeTxs(ids, `${ids.length} parcela(s) excluída(s) — desta em diante.`);
      }
      $("#modal-del-parc").classList.add("hidden");
      pendingParcTx = null;
    });

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

    // Modal de transação
    $("#btn-add-tx").addEventListener("click", () => openTxModal(null));
    $("#btn-tx-save").addEventListener("click", saveTxModal);
    $("#btn-tx-cancel").addEventListener("click", () => { $("#modal-tx").classList.add("hidden"); editingId = null; });
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
      if (ev.key === "Enter" && ev.target.tagName !== "SELECT") saveTxModal();
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
      if (ev.key === "Enter") saveMetaModal();
      if (ev.key === "Escape") { $("#modal-meta").classList.add("hidden"); editingMetaId = null; }
    });
    $("#btn-limit-save").addEventListener("click", saveLimitModal);
    $("#btn-limit-cancel").addEventListener("click", () => { $("#modal-limit").classList.add("hidden"); editingLimitId = null; });
    $("#modal-limit").addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && ev.target.tagName === "INPUT" && ev.target.type === "text") saveLimitModal();
      if (ev.key === "Escape") { $("#modal-limit").classList.add("hidden"); editingLimitId = null; }
    });
  });

  // Adiciona várias transações de uma vez (importação em lote).
  // items: [{ date, desc, amount, type, category, account? }]
  function addBulk(items) {
    let n = 0;
    (items || []).forEach((it) => {
      const amount = Math.abs(Number(it.amount) || 0);
      if (!it.date || amount <= 0) return;
      const category = (it.category || "Outros").trim() || "Outros";
      ensureCat(ds, category);
      ds.transactions.push({
        id: uid(),
        date: it.date,
        desc: (it.desc || "").trim() || "(sem descrição)",
        category,
        account: (it.account || "").trim(),
        type: it.type === "receita" ? "receita" : "despesa",
        amount, installment: null, totalValue: null,
      });
      n++;
    });
    if (n) { saveCur(); renderAll(); }
    return n;
  }

  function currentDatasetName() { return ds ? ds.name : ""; }

  // Injeta na pasta atual transações JÁ no formato interno (vindas do
  // importador completo: preservam categoria, cartão, parcela, recorrente,
  // valor total e o vínculo entre parcelas). IDs são regerados.
  function appendImported(txs) {
    if (!ds || !Array.isArray(txs)) return 0;
    const groupMap = new Map();
    let n = 0;
    txs.forEach((t) => {
      if (!t || !t.date || !(Math.abs(t.amount) > 0)) return;
      const category = (t.category || "Outros").trim() || "Outros";
      ensureCat(ds, category);
      let groupId = null;
      if (t.groupId) {
        if (!groupMap.has(t.groupId)) groupMap.set(t.groupId, uid());
        groupId = groupMap.get(t.groupId);
      }
      ds.transactions.push({
        id: uid(), groupId, fixed: t.fixed === true,
        date: t.date,
        desc: (t.desc || "").trim() || "(sem descrição)",
        category,
        account: (t.account || "").trim(),
        type: t.type === "receita" ? "receita" : "despesa",
        amount: Math.abs(t.amount),
        installment: t.installment || null,
        totalValue: t.totalValue != null ? Math.abs(t.totalValue) : null,
      });
      n++;
    });
    if (n) { saveCur(); renderAll(); }
    return n;
  }

  return { open, openTxModal, fillTxFromReceipt, getCats, addBulk, appendImported, currentDatasetName };
})();
