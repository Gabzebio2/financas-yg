/* ===== Finanças YG — importação de Excel (.xlsx) ===== */
"use strict";

const Importer = (() => {
  let workbook = null;
  let fileName = "";
  let pending = null; // { txs, notes }

  /* Meses em PT/ES (sem acento — comparação via stripAccents) */
  const MONTH_MAP = {
    janeiro: 0, enero: 0, jan: 0, ene: 0,
    fevereiro: 1, febrero: 1, fev: 1, feb: 1,
    marco: 2, marzo: 2, mar: 2,
    abril: 3, abr: 3,
    maio: 4, mayo: 4, mai: 4, may: 4,
    junho: 5, junio: 5, jun: 5,
    julho: 6, julio: 6, jul: 6,
    agosto: 7, ago: 7, aug: 7,
    setembro: 8, septiembre: 8, setiembre: 8, set: 8, sep: 8, sept: 8,
    outubro: 9, octubre: 9, out: 9, oct: 9,
    novembro: 10, noviembre: 10, nov: 10,
    dezembro: 11, diciembre: 11, dez: 11, dic: 11, dec: 11,
  };

  /* Sinônimos de cabeçalho (sem acento) */
  const SYN = {
    account: ["cartao", "conta", "tarjeta", "card", "banco", "cuenta", "carteira", "cartao/conta"],
    desc: ["o que e", "oque e", "o que foi", "descricao", "detalle", "descripcion", "historico", "item", "nome", "lancamento", "estabelecimento", "local", "memo", "observacao", "titulo"],
    totalValue: ["valor total", "total compra", "valor da compra", "valor compra", "monto total"],
    installment: ["parcelas", "parcela", "cuotas", "cuota", "parc", "parcelamento"],
    category: ["categoria", "category", "rubro", "classe", "grupo", "tipo de gasto", "tag"],
    date: ["data", "fecha", "date", "dia", "data compra", "data da compra", "vencimento"],
    amount: ["valor", "montante", "monto", "amount", "quantia", "preco", "importe", "valor (r$)"],
    type: ["tipo", "type", "movimento", "operacao", "natureza", "movimentacao"],
    income: ["receita", "receitas", "entrada", "entradas", "ingreso", "ingresos", "credito"],
    expense: ["despesa", "despesas", "saida", "saidas", "gasto", "gastos", "salida", "debito", "egreso"],
  };

  const INCOME_WORDS = ["receita", "entrada", "ingreso", "income", "credito", "deposito", "salario", "ganho"];
  const FOOTER_WORDS = ["total", "totais", "categoria", "gastou", "disponivel", "saldo", "soma"];

  function matchRole(cell) {
    const n = stripAccents(cell);
    if (!n) return null;
    for (const role of ["totalValue", "installment", "category", "date", "account", "desc", "income", "expense", "type", "amount"]) {
      if (SYN[role].includes(n)) return role;
    }
    return null;
  }

  // "setembro", "set/25", "outubro 2025" -> { m, y|null }
  function parseMonthHeader(cell) {
    if (cell == null) return null;
    const n = stripAccents(cell);
    const m = n.match(/^([a-z]+)[\s\/\-.]*'?(\d{2,4})?$/);
    if (!m || !(m[1] in MONTH_MAP)) return null;
    let y = m[2] ? Number(m[2]) : null;
    if (y != null && y < 100) y += 2000;
    if (y != null && (y < 2000 || y > 2100)) y = null;
    return { m: MONTH_MAP[m[1]], y };
  }

  /* ---------- Formato MATRIZ (planilha de cartão com colunas de meses) ---------- */
  function detectMatrix(rows) {
    const limit = Math.min(rows.length, 15);
    for (let r = 0; r < limit; r++) {
      const row = rows[r] || [];
      const monthCols = [];
      row.forEach((cell, c) => {
        const mh = parseMonthHeader(cell);
        if (mh) monthCols.push({ c, m: mh.m, y: mh.y });
      });
      if (monthCols.length < 2) continue;

      const layout = { headerRow: r, monthCols, cols: {} };
      row.forEach((cell, c) => {
        if (monthCols.some((mc) => mc.c === c)) return;
        const role = matchRole(cell);
        if (role && layout.cols[role] == null) layout.cols[role] = c;
      });

      // Coluna de data pode não ter título: procura coluna à esquerda dos meses cujo conteúdo são datas
      if (layout.cols.date == null) {
        const firstMonthCol = Math.min(...monthCols.map((mc) => mc.c));
        const used = new Set(Object.values(layout.cols));
        for (let c = 0; c < firstMonthCol; c++) {
          if (used.has(c)) continue;
          let ok = 0, filled = 0;
          for (let i = r + 1; i < Math.min(rows.length, r + 40); i++) {
            const v = (rows[i] || [])[c];
            if (v == null || v === "") continue;
            filled++;
            if (parseDateCell(v)) ok++;
          }
          if (ok >= 3 && ok >= filled * 0.5) { layout.cols.date = c; break; }
        }
      }
      if (layout.cols.date == null) continue; // sem data não é o formato matriz que conhecemos
      return layout;
    }
    return null;
  }

  // Define o ano de cada coluna de mês (viradas de ano: dez -> jan incrementa)
  function assignYears(monthCols, rows, layout) {
    if (monthCols.every((mc) => mc.y != null)) return;
    let anchorIdx = monthCols.findIndex((mc) => mc.y != null);
    let anchorYear;
    if (anchorIdx === -1) {
      // ano mais frequente nas datas de compra
      const count = {};
      for (let i = layout.headerRow + 1; i < rows.length; i++) {
        const d = parseDateCell((rows[i] || [])[layout.cols.date]);
        if (d) { const y = d.slice(0, 4); count[y] = (count[y] || 0) + 1; }
      }
      const years = Object.keys(count).sort((a, b) => count[b] - count[a]);
      anchorYear = years.length ? Number(years[0]) : new Date().getFullYear();
      anchorIdx = 0;
      monthCols[0].y = anchorYear;
    }
    for (let i = anchorIdx + 1; i < monthCols.length; i++) {
      if (monthCols[i].y != null) continue;
      monthCols[i].y = monthCols[i - 1].y + (monthCols[i].m < monthCols[i - 1].m ? 1 : 0);
    }
    for (let i = anchorIdx - 1; i >= 0; i--) {
      if (monthCols[i].y != null) continue;
      monthCols[i].y = monthCols[i + 1].y - (monthCols[i].m > monthCols[i + 1].m ? 1 : 0);
    }
  }

  function parseMatrix(rows, layout) {
    const { cols, monthCols } = layout;
    assignYears(monthCols, rows, layout);
    const txs = [];
    let skipped = 0;

    for (let i = layout.headerRow + 1; i < rows.length; i++) {
      const row = rows[i] || [];
      const hasContent = row.some((v) => v != null && v !== "");
      if (!hasContent) continue;

      const rawDesc = cols.desc != null && row[cols.desc] != null ? String(row[cols.desc]).trim() : "";
      if (FOOTER_WORDS.includes(stripAccents(rawDesc))) continue; // rodapé de totais

      const valued = [];
      monthCols.forEach((mc) => {
        const v = parseMoney(row[mc.c]);
        if (v != null && Math.abs(v) > 0.004) valued.push({ mc, value: v });
      });
      if (!valued.length) continue;

      const date = parseDateCell(row[cols.date]);
      if (!date) { skipped++; continue; } // linha com valores mas sem data (provável rodapé)

      const purchaseDay = Number(date.slice(8, 10));
      const category = cols.category != null && row[cols.category] != null && String(row[cols.category]).trim() !== ""
        ? String(row[cols.category]).trim() : "Outros";
      const account = cols.account != null && row[cols.account] != null ? String(row[cols.account]).trim() : "";
      const totalValue = cols.totalValue != null ? parseMoney(row[cols.totalValue]) : null;

      let parcStart = null, parcTotal = null;
      if (cols.installment != null && row[cols.installment] != null) {
        const pm = String(row[cols.installment]).match(/(\d+)\s*\/\s*(\d+)/);
        if (pm) { parcStart = Number(pm[1]); parcTotal = Number(pm[2]); }
      }

      const groupId = valued.length > 1 ? uid() : null; // liga as parcelas da mesma compra
      valued.forEach((v, idx) => {
        const y = v.mc.y, m = v.mc.m + 1;
        const day = Math.min(purchaseDay, daysInMonth(y, m));
        let installment = null;
        if (parcTotal) installment = `${Math.min(parcStart + idx, parcTotal)}/${parcTotal}`;
        else if (valued.length > 1) installment = `${idx + 1}/${valued.length}`;
        txs.push({
          id: uid(),
          groupId,
          date: `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
          desc: rawDesc || "(sem descrição)",
          category, account,
          type: "despesa",
          amount: Math.abs(v.value),
          installment,
          totalValue: totalValue != null ? Math.abs(totalValue) : null,
        });
      });
    }
    return { txs, skipped };
  }

  /* ---------- Formato SIMPLES (uma transação por linha) ---------- */
  function detectSimple(rows) {
    const limit = Math.min(rows.length, 15);
    for (let r = 0; r < limit; r++) {
      const row = rows[r] || [];
      const cols = {};
      row.forEach((cell, c) => {
        const role = matchRole(cell);
        if (role && cols[role] == null) cols[role] = c;
      });
      const hasValue = cols.amount != null || (cols.income != null || cols.expense != null);
      if (cols.date != null && hasValue) return { headerRow: r, cols };
    }
    return null;
  }

  function parseSimple(rows, layout) {
    const { cols } = layout;
    const txs = [];
    let skipped = 0;

    // Se não houver coluna "tipo", o sinal decide (negativo = despesa)
    let hasNegative = false;
    if (cols.amount != null) {
      for (let i = layout.headerRow + 1; i < rows.length; i++) {
        const v = parseMoney((rows[i] || [])[cols.amount]);
        if (v != null && v < 0) { hasNegative = true; break; }
      }
    }

    for (let i = layout.headerRow + 1; i < rows.length; i++) {
      const row = rows[i] || [];
      const hasContent = row.some((v) => v != null && v !== "");
      if (!hasContent) continue;

      const date = parseDateCell(row[cols.date]);
      const rawDesc = cols.desc != null && row[cols.desc] != null ? String(row[cols.desc]).trim() : "";
      if (!date) {
        if (!FOOTER_WORDS.includes(stripAccents(rawDesc))) skipped++;
        continue;
      }

      const base = {
        date,
        desc: rawDesc || "(sem descrição)",
        category: cols.category != null && row[cols.category] != null && String(row[cols.category]).trim() !== ""
          ? String(row[cols.category]).trim() : "Outros",
        account: cols.account != null && row[cols.account] != null ? String(row[cols.account]).trim() : "",
        installment: null,
        totalValue: null,
      };
      if (cols.installment != null && row[cols.installment] != null) {
        const pm = String(row[cols.installment]).match(/(\d+)\s*\/\s*(\d+)/);
        if (pm) base.installment = `${pm[1]}/${pm[2]}`;
      }
      if (cols.totalValue != null) {
        const tv = parseMoney(row[cols.totalValue]);
        if (tv != null) base.totalValue = Math.abs(tv);
      }

      // Colunas separadas de receita/despesa
      if (cols.income != null || cols.expense != null) {
        const inc = cols.income != null ? parseMoney(row[cols.income]) : null;
        const exp = cols.expense != null ? parseMoney(row[cols.expense]) : null;
        if (inc != null && Math.abs(inc) > 0.004) txs.push({ ...base, id: uid(), type: "receita", amount: Math.abs(inc) });
        if (exp != null && Math.abs(exp) > 0.004) txs.push({ ...base, id: uid(), type: "despesa", amount: Math.abs(exp) });
        if ((inc == null || Math.abs(inc) <= 0.004) && (exp == null || Math.abs(exp) <= 0.004)) skipped++;
        continue;
      }

      const amount = parseMoney(row[cols.amount]);
      if (amount == null || Math.abs(amount) <= 0.004) { skipped++; continue; }

      let type = null;
      if (cols.type != null && row[cols.type] != null) {
        const tn = stripAccents(row[cols.type]);
        type = INCOME_WORDS.some((w) => tn.includes(w)) ? "receita" : "despesa";
      } else if (hasNegative) {
        type = amount < 0 ? "despesa" : "receita";
      } else {
        type = "despesa";
      }
      txs.push({ ...base, id: uid(), type, amount: Math.abs(amount) });
    }
    return { txs, skipped };
  }

  /* ---------- Fluxo principal ---------- */
  async function handleFile(file) {
    if (file.size > 30 * 1024 * 1024) { toast("Arquivo grande demais (máx. 30 MB)."); return; }
    try {
      const buf = await file.arrayBuffer();
      workbook = XLSX.read(buf, { type: "array", cellDates: false });
    } catch (e) {
      console.error(e);
      toast("Não consegui abrir esse arquivo 😕 Confira se é um .xlsx válido.");
      return;
    }
    fileName = file.name.replace(/\.(xlsx?|xlsm|csv)$/i, "");

    const results = [];
    for (const name of workbook.SheetNames) {
      const rows = sheetRows(name);
      if (!rows.length) continue;

      const ml = detectMatrix(rows);
      if (ml) {
        const r = parseMatrix(rows, ml);
        if (r.txs.length) { results.push({ sheet: name, format: "matriz (meses em colunas)", ...r }); continue; }
      }
      const sl = detectSimple(rows);
      if (sl) {
        const r = parseSimple(rows, sl);
        if (r.txs.length) { results.push({ sheet: name, format: "lista de transações", ...r }); continue; }
      }
      results.push({ sheet: name, format: null, txs: [], skipped: 0 });
    }

    const all = results.flatMap((r) => r.txs);
    $("#import-title").textContent = `Importar: ${file.name}`;
    showScreen("screen-import");
    if (all.length) showPreview(results);
    else showMapping();
  }

  function sheetRows(sheetName) {
    const ws = workbook.Sheets[sheetName];
    if (!ws) return [];
    return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  }

  /* ---------- Pré-visualização ---------- */
  function showPreview(results) {
    const txs = results.flatMap((r) => r.txs);
    txs.sort((a, b) => a.date.localeCompare(b.date));
    const notes = [];
    results.forEach((r) => {
      if (r.format) notes.push(`Aba "${r.sheet}": ${r.txs.length} transações lidas (formato: ${r.format})${r.skipped ? `, ${r.skipped} linha(s) ignorada(s)` : ""}.`);
      else notes.push(`Aba "${r.sheet}": formato não reconhecido — ignorada.`);
    });
    pending = { txs, notes };

    $("#map-box").classList.add("hidden");
    $("#preview-box").classList.remove("hidden");
    $("#import-name").value = fileName || "Minhas finanças";

    // Cartões de resumo
    const receitas = txs.filter((t) => t.type === "receita").reduce((s, t) => s + t.amount, 0);
    const despesas = txs.filter((t) => t.type === "despesa").reduce((s, t) => s + t.amount, 0);
    const periodo = txs.length ? `${fmtDate(txs[0].date)} a ${fmtDate(txs[txs.length - 1].date)}` : "—";
    $("#import-stats").innerHTML = `
      <div class="sum-card"><span class="sum-label">Transações</span><span class="sum-value">${txs.length}</span></div>
      <div class="sum-card"><span class="sum-label">Período</span><span class="sum-value" style="font-size:15px">${periodo}</span></div>
      <div class="sum-card"><span class="sum-label">Receitas</span><span class="sum-value pos">${fmtBRL(receitas)}</span></div>
      <div class="sum-card"><span class="sum-label">Despesas</span><span class="sum-value neg">${fmtBRL(despesas)}</span></div>`;

    // Totais por mês
    const byMonth = {};
    txs.forEach((t) => {
      const ym = t.date.slice(0, 7);
      byMonth[ym] = byMonth[ym] || { receita: 0, despesa: 0 };
      byMonth[ym][t.type] += t.amount;
    });
    const months = Object.keys(byMonth).sort();
    $("#import-months").innerHTML =
      `<thead><tr><th>Mês</th><th class="num">Receitas</th><th class="num">Despesas</th></tr></thead><tbody>` +
      months.map((ym) => `<tr><td>${fmtMonthLong(ym)}</td>
        <td class="num">${byMonth[ym].receita ? fmtBRL(byMonth[ym].receita) : "—"}</td>
        <td class="num">${byMonth[ym].despesa ? fmtBRL(byMonth[ym].despesa) : "—"}</td></tr>`).join("") +
      `</tbody>`;

    // Amostra
    const sample = txs.slice(0, 15);
    $("#import-sample").innerHTML =
      `<thead><tr><th>Data</th><th>Descrição</th><th>Categoria</th><th>Cartão/Conta</th><th>Parcela</th><th class="num">Valor</th></tr></thead><tbody>` +
      sample.map((t) => `<tr>
        <td>${fmtDate(t.date)}</td><td>${escapeHtml(t.desc)}</td><td>${escapeHtml(t.category)}</td>
        <td>${escapeHtml(t.account)}</td><td>${t.installment || "—"}</td>
        <td class="num amount-${t.type}">${t.type === "despesa" ? "-" : "+"} ${fmtBRL(t.amount)}</td></tr>`).join("") +
      `</tbody>`;

    $("#import-note").textContent = notes.join(" ");
  }

  function savePending() {
    if (!pending || !pending.txs.length) return;
    const name = $("#import-name").value.trim() || fileName || "Minhas finanças";
    const now = new Date().toISOString();
    const ds = { id: uid(), name, createdAt: now, updatedAt: now, categories: [], transactions: pending.txs };
    ds.transactions.forEach((t) => ensureCat(ds, t.category));
    ensureCat(ds, "Outros");
    Store.saveDataset(ds);
    pending = null;
    toast(`Pasta "${name}" salva com ${ds.transactions.length} transações ✔`);
    Dashboard.open(ds.id);
  }

  /* ---------- Mapeamento manual ---------- */
  const MAP_ROLES = [
    ["", "Ignorar"], ["date", "Data"], ["desc", "Descrição"], ["amount", "Valor"],
    ["category", "Categoria"], ["type", "Tipo (receita/despesa)"], ["account", "Cartão/Conta"],
    ["installment", "Parcelas"], ["totalValue", "Valor total"], ["income", "Receita (coluna própria)"],
    ["expense", "Despesa (coluna própria)"],
  ];

  function guessHeaderRow(rows) {
    for (let r = 0; r < Math.min(rows.length, 10); r++) {
      const filled = (rows[r] || []).filter((v) => v != null && v !== "").length;
      if (filled >= 2) return r;
    }
    return 0;
  }

  function showMapping() {
    $("#preview-box").classList.add("hidden");
    $("#map-box").classList.remove("hidden");
    const sel = $("#map-sheet");
    sel.innerHTML = workbook.SheetNames.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("");
    populateHeaderRowSelect();
    renderMapTable();
  }

  function populateHeaderRowSelect() {
    const rows = sheetRows($("#map-sheet").value);
    const guess = guessHeaderRow(rows);
    const n = Math.min(rows.length, 10);
    $("#map-header-row").innerHTML = Array.from({ length: n }, (_, i) =>
      `<option value="${i}" ${i === guess ? "selected" : ""}>Linha ${i + 1}</option>`).join("");
  }

  function renderMapTable() {
    const rows = sheetRows($("#map-sheet").value);
    if (!rows.length) { $("#map-table").innerHTML = "<tr><td>Aba vazia</td></tr>"; return; }
    const hr = Number($("#map-header-row").value) || 0;
    const header = rows[hr] || [];
    const nCols = Math.max(header.length, ...rows.slice(hr, hr + 8).map((r) => (r || []).length));

    const selects = Array.from({ length: nCols }, (_, c) => {
      const guessed = matchRole(header[c]) || "";
      return `<th><select data-col="${c}">${MAP_ROLES.map(([v, l]) =>
        `<option value="${v}" ${v === guessed ? "selected" : ""}>${l}</option>`).join("")}</select></th>`;
    }).join("");

    const headCells = Array.from({ length: nCols }, (_, c) =>
      `<th>${escapeHtml(header[c] ?? `Coluna ${c + 1}`)}</th>`).join("");

    const dataRows = rows.slice(hr + 1, hr + 7).map((r) =>
      `<tr>${Array.from({ length: nCols }, (_, c) => {
        let v = (r || [])[c];
        if (typeof v === "number" && v > 20000 && v < 80000) { const d = parseDateCell(v); if (d) v = fmtDate(d); }
        return `<td>${escapeHtml(v ?? "")}</td>`;
      }).join("")}</tr>`).join("");

    $("#map-table").innerHTML = `<thead><tr>${selects}</tr><tr>${headCells}</tr></thead><tbody>${dataRows}</tbody>`;
  }

  function applyMapping() {
    const rows = sheetRows($("#map-sheet").value);
    const hr = Number($("#map-header-row").value) || 0;
    const cols = {};
    $$("#map-table select").forEach((s) => {
      if (s.value && cols[s.value] == null) cols[s.value] = Number(s.dataset.col);
    });
    if (cols.date == null) { toast("Marque qual coluna é a Data 📅"); return; }
    if (cols.amount == null && cols.income == null && cols.expense == null) { toast("Marque qual coluna é o Valor 💰"); return; }
    const r = parseSimple(rows, { headerRow: hr, cols });
    if (!r.txs.length) { toast("Nenhuma transação lida — confira o mapeamento e a linha do cabeçalho."); return; }
    showPreview([{ sheet: $("#map-sheet").value, format: "mapeamento manual", ...r }]);
  }

  /* ---------- Leitura para o modo LOTE (não cria pasta) ----------
     Lê um .xlsx e devolve só as transações detectadas, sem tela de
     importação. Usado pela importação em lote (Batch). */
  async function readForBatch(file) {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array", cellDates: false });
    const txs = [];
    for (const name of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null });
      if (!rows.length) continue;

      // 1) Formato matriz (meses em colunas) — o formato da planilha principal.
      const ml = detectMatrix(rows);
      if (ml) { const r = parseMatrix(rows, ml); if (r.txs.length) { txs.push(...r.txs); continue; } }

      // 2) Tabela simples (Data, Descrição/Local, Valor). Convenção de LOTE
      //    (fatura/cobrança): positivo = gasto (despesa); negativo = pagamento
      //    ou estorno (receita) — oposto da convenção bancária do importador.
      const sl = detectSimple(rows);
      if (sl && sl.cols.date != null && sl.cols.amount != null) {
        for (let i = sl.headerRow + 1; i < rows.length; i++) {
          const row = rows[i] || [];
          const date = parseDateCell(row[sl.cols.date]);
          const amt = parseMoney(row[sl.cols.amount]);
          if (!date || amt == null || Math.abs(amt) < 0.004) continue;
          const desc = sl.cols.desc != null && row[sl.cols.desc] != null ? String(row[sl.cols.desc]).trim() : "";
          txs.push({
            date, desc: desc || "(sem descrição)",
            amount: Math.abs(amt), type: amt < 0 ? "receita" : "despesa",
            installment: null, totalValue: null,
          });
        }
      }
    }
    return txs;
  }

  /* ---------- Eventos ---------- */
  document.addEventListener("DOMContentLoaded", () => {
    $("#btn-import-save").addEventListener("click", savePending);
    $("#btn-import-cancel").addEventListener("click", () => { pending = null; goHome(); });
    $("#map-sheet").addEventListener("change", () => { populateHeaderRowSelect(); renderMapTable(); });
    $("#map-header-row").addEventListener("change", renderMapTable);
    $("#btn-apply-map").addEventListener("click", applyMapping);
  });

  return { handleFile, readForBatch };
})();
