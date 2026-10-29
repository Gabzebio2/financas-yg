/* ===== Finanças YG — importação em lote (fatura/planilha/Excel) =====
   Lê uma foto de fatura/planilha (via IA no servidor seguro) ou um arquivo
   Excel (local), extrai TODAS as transações e mostra uma lista para o usuário
   conferir e dar um OK — que lança tudo de uma vez na categoria escolhida. */
"use strict";

const Batch = (() => {
  const PROXY_PATH = "/api/receipt";
  let rows = [];          // [{ date, desc, amount, type, currency, on, src, dup, cat, installment, fixa... }]
  let presetCat = null;   // categoria destino sugerida (ex: amigo)
  let srcSeq = 0;         // nº do arquivo de origem de cada linha (p/ detectar sobreposição)
  let detectedCard = null;  // cartão identificado pela IA na fatura (ex: "Nubank Gab")
  let chosenAccount = null; // cartão escolhido à mão pelo usuário (prevalece)
  let generation = 0;
  let reading = false;
  let includeGenerated = false;
  let reviewWarnings = [];
  let excludedCount = 0;
  let coverage = [];
  let partialReviewed = false;
  let targetId = null;
  let targetOwner = null;
  let processedParts = 0;
  let viewFilter = "all";
  const MAX_FILES = 15, MAX_PARTS = 120;

  function contextValid(version = generation) {
    return version === generation && (!Dashboard.getImportTargetId || Dashboard.getImportTargetId() === targetId) &&
      (typeof Cloud === "undefined" || !Cloud.getSyncState || Cloud.getSyncState().owner === targetOwner);
  }
  function incomplete() { return excludedCount > 0 || coverage.some((p) => p.status !== "complete"); }
  function coverageUI() {
    const el = $("#batch-coverage");
    el.innerHTML = coverage.map((p) => `<div>${escapeHtml(p.label)} · ${escapeHtml(p.status === "complete" ? `concluído${p.count != null ? " · " + p.count + " lançamento(s)" : ""}` : p.message || "ainda não lido")}</div>`).join("");
    el.classList.toggle("hidden", !coverage.length);
    $("#batch-partial-wrap").classList.toggle("hidden", !incomplete());
    $("#batch-partial-ack").checked = partialReviewed;
  }

  async function runImport(read, files) {
    if (reading) { toast("Aguarde a leitura atual terminar."); return; }
    const version = generation;
    reading = true;
    ["#btn-batch-photo", "#btn-batch-file", "#btn-batch-save"].forEach((id) => { $(id).disabled = true; });
    try { await read(files, version); }
    finally {
      if (version === generation) {
        reading = false;
        ["#btn-batch-photo", "#btn-batch-file"].forEach((id) => { $(id).disabled = false; });
        updateCount();
      }
    }
  }

  function proxyAvailable() {
    if (location.protocol === "file:") return false;
    const h = location.hostname;
    return !(h === "localhost" || h === "127.0.0.1" || h.endsWith("github.io"));
  }

  function setStatus(msg, cls) {
    const el = $("#batch-status");
    el.textContent = msg || "";
    el.className = "receipt-status" + (cls ? " " + cls : "") + (msg ? "" : " hidden");
  }

  function open(opts) {
    generation++;
    reading = false;
    opts = opts || {};
    presetCat = opts.category || null;
    rows = [];
    srcSeq = 0;
    detectedCard = null;
    chosenAccount = null;
    includeGenerated = false;
    reviewWarnings = [];
    excludedCount = 0;
    coverage = []; partialReviewed = false; processedParts = 0;
    viewFilter = "all";
    $("#batch-details").open = false;
    targetId = Dashboard.getImportTargetId?.() ?? null;
    targetOwner = typeof Cloud !== "undefined" && Cloud.getSyncState ? Cloud.getSyncState().owner : null;
    coverageUI();
    $("#batch-include-generated").checked = false;
    $("#batch-generated-wrap").classList.add("hidden");
    $("#batch-review-summary").textContent = "";
    $("#batch-review-summary").classList.add("hidden");
    $("#batch-cat").innerHTML = "";
    $("#batch-cur").innerHTML = "";
    ["#btn-batch-photo", "#btn-batch-file"].forEach((id) => { $(id).disabled = false; });
    $("#batch-title").textContent = opts.title || "Importar em lote";
    // Quando os arquivos já vieram do "Upload do comprovante", não repete os
    // botões de origem (foto/Excel) — o modal serve só para conferir e confirmar.
    const hide = !!opts.hideSources;
    $("#btn-batch-photo").classList.toggle("hidden", hide);
    $("#btn-batch-file").classList.toggle("hidden", hide);
    $(".batch-sources").classList.toggle("batch-sources-empty", hide);
    $("#batch-preview").classList.add("hidden");
    $("#btn-batch-save").classList.add("hidden");
    setStatus("");
    $("#modal-batch").classList.remove("hidden");
  }

  function close() {
    generation++;
    reading = false;
    $("#modal-batch").classList.add("hidden");
    rows = [];
  }

  // Botão "Upload do comprovante": abre a lista e processa os arquivos escolhidos
  // (fotos, PDFs e/ou Excel) no mesmo fluxo — serve para um gasto só ou para lote.
  async function openWithFiles(files) {
    open({ title: "Conferir documentos e lançamentos" });
    const version = generation;
    const arr = Array.from(files || []);
    if (arr.length > MAX_FILES) { setStatus(`Selecione até ${MAX_FILES} arquivos por lote. Nenhum arquivo foi lido.`, "err"); return; }
    // Fotos e PDFs vão juntos para a IA; Excel é lido localmente
    const aiFiles = arr.filter((f) =>
      /^image\//.test(f.type) || /\.(png|jpe?g|webp|gif)$/i.test(f.name) ||
      f.type === "application/pdf" || /\.pdf$/i.test(f.name));
    const excels = arr.filter((f) => /\.(xlsx?|xlsm|csv)$/i.test(f.name));
    arr.filter((f) => !aiFiles.includes(f) && !excels.includes(f)).forEach((f) => coverage.push({ label: f.name, status: "failed", message: "formato não aceito" }));
    if (!aiFiles.length && !excels.length) { setStatus("Envie uma foto ou PDF (comprovante/fatura) ou um arquivo Excel.", "err"); return; }
    if (excels.length) await runImport(fromFiles, excels);
    if (version !== generation) return;
    if (aiFiles.length) await runImport(fromPhotos, aiFiles);
  }

  /* ---------- Renderização da lista para conferência ---------- */
  function availableCats() {
    return [...new Set([...Dashboard.getCats(), "Outros"])];
  }

  function rowReview(r) {
    const issues = [...(r.review || [])];
    if (!isValidISODate(r.date)) issues.push("Informe a data");
    if (!r.desc.trim()) issues.push("Informe a descrição");
    if (!Number.isFinite(r.amount) || r.amount <= 0) issues.push("Confira o valor");
    return [...new Set(issues)];
  }

  // The seal and the manual decision belong to the exact values being saved.
  // No financial history is sent to either reading of the document.
  function reviewSnapshot(r, original = false) {
    const t = original ? r : effectiveRow(r);
    return JSON.stringify([t.date, t.desc, t.amount, t.type, t.currency, t.account,
      t.cat || $("#batch-cat").value, t.installment || null, t.fixed === true,
      t.totalValue, t.referenceId || "", t.sourceEvidence || "", t.sourcePage || null]);
  }
  function autoVerified(r) { return !r.gen && !!r.verifiedSnapshot && r.verifiedSnapshot === reviewSnapshot(r); }
  function manuallyReviewed(r) { return !!r.manualSnapshot && r.manualSnapshot === reviewSnapshot(r); }
  function needsReview(r) { return !!r.reviewRequired && !autoVerified(r) && !manuallyReviewed(r); }
  function invalidRow(r) { return !isValidISODate(r.date) || !r.desc.trim() || !Number.isFinite(r.amount) || r.amount <= 0 || r.amount > Number.MAX_SAFE_INTEGER; }
  function pendingRow(r) { return invalidRow(r) || needsReview(r) || (r.dup && r.confirmedMatch !== r.matchKey); }
  function reviewHTML(r, index) {
    if (!r.reviewRequired) return "";
    if (autoVerified(r)) return '<div class="batch-verification-row verified">Conferido em duas leituras</div>';
    if (manuallyReviewed(r)) return '<div class="batch-verification-row manual">Conferido por você</div>';
    r.displayedReviewSnapshot = reviewSnapshot(r);
    const reasons = r.verifiedSnapshot ? ["Os dados foram alterados depois da conferência."] : r.auditReasons || ["Conferência manual necessária."];
    return '<div class="batch-verification-row attention"><span>' + escapeHtml(reasons.join(" · ")) + '</span><button type="button" class="btn btn-ghost btn-sm" data-reviewed="' + index + '">Conferi este item</button></div>';
  }
  function renderVerification() {
    const selected = rows.filter((r) => r.on);
    const pending = selected.filter(pendingRow).length;
    const automatic = selected.filter(autoVerified).length;
    const manual = selected.filter((r) => !autoVerified(r) && manuallyReviewed(r)).length;
    const hasAI = rows.some((r) => r.reviewRequired);
    const clean = hasAI && !reading && !incomplete() && !pending && selected.length > 0 && automatic === selected.length &&
      coverage.every((p) => !p.auditStatus || p.auditStatus === "verified");
    $("#batch-verification").classList.toggle("is-verified", clean);
    $("#batch-verification-title").textContent = reading ? "Conferindo seu documento" : clean ? "Duas leituras, dados de acordo" : pending || incomplete() ? "Alguns pontos precisam de você" : "Seleção pronta para incluir";
    $("#batch-verification-note").textContent = clean ? "As duas leituras concordam nos itens selecionados. Confira o resumo e confirme a inclusão." : hasAI ? "Só os pontos pendentes exigem uma decisão. A conferência automática não elimina a possibilidade de erro." : "Planilha lida no seu dispositivo. Não houve conferência por IA.";
    const selectedCurrency = $("#batch-cur").value;
    if (selectedCurrency && selectedCurrency !== "original") $("#batch-verification-note").textContent += ` Você alterou a moeda do lote para ${selectedCurrency}; os valores não são convertidos. O resumo abaixo conserva a moeda lida, e o Saldo da seleção mostra o que será incluído.`;
    $("#batch-verification-counts").textContent = hasAI ? `${automatic} conferido(s) em duas leituras · ${manual} conferido(s) por você · ${pending} pendente(s)` : `${selected.length} selecionado(s) · ${pending} pendente(s) · leitura local`;
    const totals = {};
    selected.forEach((r) => {
      const code = r.currency;
      if (!totals[code]) totals[code] = { receita: 0, despesa: 0 };
      if (Number.isFinite(r.amount)) totals[code][r.type] += r.amount;
    });
    $("#batch-currency-totals").innerHTML = Object.entries(totals).map(([code, t]) => '<div class="batch-currency-line"><strong>' + escapeHtml(code) + '</strong><span>Entradas <b>' + escapeHtml(fmtMoney(t.receita, code)) + '</b></span><span>Saídas <b>' + escapeHtml(fmtMoney(t.despesa, code)) + '</b></span></div>').join("");
    $("#batch-filter-pending").textContent = `Pendências (${rows.filter((r) => (!r.gen || includeGenerated) && pendingRow(r)).length})`;
    ["pending", "all"].forEach((filter) => {
      const button = $("#batch-filter-" + filter);
      button.classList.toggle("active", viewFilter === filter);
      button.setAttribute?.("aria-pressed", String(viewFilter === filter));
    });
  }

  function renderReviewSummary() {
    const generated = rows.filter((r) => r.gen).length;
    $("#batch-generated-wrap").classList.toggle("hidden", generated === 0);
    $("#batch-include-generated").checked = includeGenerated;
    const messages = [...new Set(reviewWarnings)];
    if (excludedCount) messages.push(`${excludedCount} item(ns) não importado(s) por valor, moeda ou tipo ausente/inválido.`);
    const incomplete = rows.filter((r) => r.on && (!isValidISODate(r.date) || !r.desc.trim() || !Number.isFinite(r.amount) || r.amount <= 0)).length;
    if (incomplete) messages.push(`${incomplete} item(ns) selecionado(s) precisam de data, descrição ou valor antes de salvar.`);
    const unresolved = rows.filter((r) => r.on && r.dup && r.confirmedMatch !== r.matchKey).length;
    if (unresolved) messages.push(`${unresolved} coincidência(s) aguardam decisão: desmarque o item ou confirme que é um lançamento diferente.`);
    if (generated) messages.push(`${generated} lançamento(s) são projeções de parcelas ou repetições, não identificados no documento. ${includeGenerated ? "Revise as projeções selecionadas." : "Só serão incluídos se você ativar a opção abaixo."}`);
    if (rows.some((r) => !r.account) && (chosenAccount == null || chosenAccount === "original")) messages.push("Cartão não identificado em alguns itens: permanecerão sem cartão, a menos que você escolha um.");
    const el = $("#batch-review-summary");
    el.textContent = messages.join(" ");
    el.classList.toggle("hidden", !messages.length);
    coverageUI();
    renderVerification();
  }

  function renderPreview() {
    const cats = availableCats();
    const sel = $("#batch-cat");
    const escolhaAtual = sel.value; // preserva a escolha do usuário entre leituras
    sel.innerHTML = cats.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
    if (escolhaAtual && cats.includes(escolhaAtual)) sel.value = escolhaAtual;
    else sel.value = cats.find((c) => presetCat && stripAccents(c) === stripAccents(presetCat)) || "Outros";

    // Preserva moedas mistas; só aplica uma moeda ao lote se o usuário escolher.
    const curSel = $("#batch-cur");
    const curPrev = curSel.value;
    curSel.innerHTML = '<option value="original">Manter moeda de cada item</option>' + CURRENCY_CODES.map((c) => `<option value="${c}">${escapeHtml(CURRENCIES[c].name)} (${escapeHtml(CURRENCIES[c].symbol)})</option>`).join("");
    curSel.value = curPrev && (curPrev === "original" || CURRENCY_CODES.includes(curPrev)) ? curPrev : "original";

    // Cada arquivo mantém seu cartão identificado. Ausência não significa C6.
    const accSel = $("#batch-acc");
    const accounts = [...new Set([...CARDS, ...rows.map((r) => r.account).filter(Boolean)])];
    accSel.innerHTML = '<option value="original">Manter cartão de cada item</option><option value="">(sem cartão)</option>' +
      accounts.map((a) => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join("");
    accSel.value = chosenAccount != null ? chosenAccount : "original";
    flagDuplicates();
    renderReviewSummary();

    if (!rows.length) {
      $("#batch-preview").classList.remove("hidden");
      $("#btn-batch-save").classList.add("hidden");
      $("#batch-tbody").innerHTML = `<tr><td colspan="6" class="empty-table">Nada reconhecido nesta imagem/arquivo. Tente uma foto mais nítida ou outro arquivo.</td></tr>`;
      $("#batch-count").textContent = "";
      return;
    }

    const selectedCurrency = $("#batch-cur").value;
    const fallCat = sel.value; // linhas sem categoria da IA seguem o seletor geral
    $("#batch-tbody").innerHTML = rows.map((r, i) => (r.gen && !includeGenerated) || (viewFilter === "pending" && !pendingRow(r)) ? "" : `
      <tr data-i="${i}" class="${r.on ? "" : "batch-off"}${r.dup ? " batch-dup" : ""}${r.gen ? " batch-generated" : ""}">
        <td><input type="checkbox" class="batch-check" data-i="${i}" aria-label="Selecionar ${escapeHtml(r.desc || "item")}${r.gen ? " (projeção)" : ""}" ${r.on ? "checked" : ""}>${r.dup ? '<span class="dup-flag" title="Coincidência para revisão; isso não comprova duplicação">⚠</span>' : ""}</td>
        <td><input type="date" data-f="date" data-i="${i}" aria-label="Data de ${escapeHtml(r.desc || "item")}" value="${escapeHtml(r.date)}"></td>
        <td><div class="batch-desc-cell"><input type="text" data-f="desc" data-i="${i}" value="${escapeHtml(r.desc)}">${
          r.installment
            ? `<span class="parc-tag" title="${r.gen ? "Projeção: parcela não identificada no documento" : "Parcela vista na fatura"}">${r.gen ? "Projeção · " : ""}${escapeHtml(r.installment)}</span>`
            : (r.fixed || r.fixa)
              ? `<span class="parc-tag" title="${r.gen ? "Projeção: repetição não identificada no documento" : "Assinatura/mensalidade detectada"}">${r.gen ? "Projeção · " : ""}fixa</span>`
              : ""
        }</div>${rowReview(r).length ? `<small class="hint">${escapeHtml(rowReview(r).join(" · "))}</small>` : ""}${r.account ? `<small class="hint">${escapeHtml(r.account)}</small>` : ""}${r.sourceLabel ? `<small class="hint">${escapeHtml(r.sourceLabel)}</small>` : ""}${r.referenceId ? `<small class="hint">Referência: ${escapeHtml(r.referenceId)}</small>` : ""}${reviewHTML(r, i)}${matchHTML(r, i)}</td>
        <td class="num"><input type="text" class="batch-val" data-f="amount" data-i="${i}" data-cur="${selectedCurrency === "original" ? r.currency : normCur(selectedCurrency)}" value="${fmtMoneyInput(r.amount, selectedCurrency === "original" ? r.currency : selectedCurrency)}"></td>
        <td>
          <select data-f="cat" data-i="${i}">
            ${cats.map((c) => `<option value="${escapeHtml(c)}" ${(r.cat || fallCat) === c ? "selected" : ""}>${escapeHtml(c)}</option>`).join("")}
          </select>
        </td>
        <td>
          <select data-f="type" data-i="${i}">
            <option value="despesa" ${r.type === "despesa" ? "selected" : ""}>Despesa</option>
            <option value="receita" ${r.type === "receita" ? "selected" : ""}>Receita</option>
          </select>
        </td>
      </tr>`).join("");
    if (!$("#batch-tbody").innerHTML) $("#batch-tbody").innerHTML = '<tr><td colspan="6" class="empty-table">Nenhuma pendência nesta seleção. Use Todos para ver ou ajustar os lançamentos.</td></tr>';
    $("#batch-details").open = viewFilter === "all" || rows.some((r) => r.on && pendingRow(r));

    $("#batch-preview").classList.remove("hidden");
    $("#btn-batch-save").classList.remove("hidden");
    updateCount();
  }

  function updateCount() {
    const on = rows.filter((r) => r.on);
    const selectedCurrency = $("#batch-cur").value;
    const totals = {};
    on.forEach((r) => {
      const cur = selectedCurrency === "original" ? normCur(r.currency) : normCur(selectedCurrency);
      totals[cur] = (totals[cur] || 0) + (r.type === "receita" ? r.amount : -r.amount);
    });
    const total = Object.entries(totals).map(([cur, amount]) => fmtMoney(amount, cur)).join(" · ") || fmtMoney(0, "BRL");
    $("#batch-count").textContent = `${on.length} de ${rows.length} selecionadas · Saldo da seleção: ${total}`;
    $("#btn-batch-save").textContent = `Confirmar e incluir ${on.length} lançamento${on.length === 1 ? "" : "s"}`;
    $("#btn-batch-save").disabled = reading || on.length === 0 || on.some(pendingRow) || (incomplete() && !partialReviewed);
    renderReviewSummary();
  }

  // Normaliza itens vindos da IA/Excel para o formato interno
  function normalize(items) {
    return (Array.isArray(items) ? items : []).map((it, sourceIndex) => {
      if (!it || typeof it !== "object") { excludedCount++; return null; }
      // A IA devolve o campo como "data" (pt); o Excel devolve "date". Aceita os dois.
      let date = typeof it.date === "string" ? it.date : (typeof it.data === "string" ? it.data : "");
      date = isValidISODate(date) ? date : "";
      const rawAmount = it.amount ?? it.valor;
      const amount = (typeof rawAmount === "number" || (typeof rawAmount === "string" && rawAmount.trim())) ? Number(rawAmount) : NaN;
      const type = it.type ?? it.tipo;
      const currency = typeof (it.moeda ?? it.currency) === "string" ? (it.moeda ?? it.currency).trim().toUpperCase() : "";
      if (!Number.isFinite(amount) || amount <= 0 || amount > Number.MAX_SAFE_INTEGER || !["receita", "despesa"].includes(type) || !CURRENCY_CODES.includes(currency)) {
        excludedCount++;
        return null;
      }
      const review = Array.isArray(it.revisar) ? it.revisar.filter((v) => typeof v === "string" && v.trim()).map((v) => v.slice(0, 180)) : [];

      // Categoria sugerida pela IA por item (validada contra as da pasta).
      // Na cobrança de amigo (presetCat) tudo vai para a categoria do amigo —
      // a sugestão da IA é ignorada de propósito.
      const rawCat = presetCat || it.categoria || it.category || "";
      const cat = availableCats().find((c) => stripAccents(c) === stripAccents(rawCat)) || "Outros";
      if (!rawCat || (cat === "Outros" && stripAccents(rawCat) !== stripAccents("Outros"))) review.push("Confira a categoria (Outros)");

      // Parcela "3/12" detectada na fatura -> a série completa é gerada em expandSeries
      let parcNum = 0, parcTotal = 0;
      const rawParcela = String(it.parcela ?? it.installment ?? "").trim();
      const pm = rawParcela.match(/^(\d{1,2})\s*\/\s*(\d{1,2})$/);
      if (pm) {
        const a = Number(pm[1]), b = Number(pm[2]);
        if (a >= 1 && b >= 2 && a <= b && b <= 48) { parcNum = a; parcTotal = b; }
      }
      if (rawParcela && !parcTotal) review.push("Confira a parcela não reconhecida");
      const fixa = it.fixa === true && !parcTotal;

      let desc = String(it.desc ?? it.descricao ?? "").slice(0, 120);
      // Se a IA deixou o marcador de parcela na descrição, limpa ("LOJA 3/12" -> "LOJA")
      if (parcTotal) {
        desc = desc.replace(/[\s\-–(]*(?:parc\.?\w*|parcela|cuota)?\s*\d{1,2}\s*(?:\/|de|of)\s*\d{1,2}\s*\)?/i, "").trim() || desc;
      }

      return { date, desc, amount, type, currency, on: true, cat, parcNum, parcTotal, fixa, review, sourceIndex,
        account: typeof (it.account ?? it.instituicao) === "string" ? (it.account ?? it.instituicao).trim().slice(0, 80) : "",
        referenceId: String(it.referenceId ?? it.referencia ?? "").trim().slice(0, 160),
        sourceEvidence: String(it.sourceEvidence ?? it.evidencia ?? "").trim().slice(0, 300),
        sourcePage: Number.isInteger(it.sourcePage ?? it.pagina) && (it.sourcePage ?? it.pagina) > 0 ? (it.sourcePage ?? it.pagina) : undefined,
        installment: parcTotal ? `${parcNum}/${parcTotal}` : null, fixed: it.fixed === true, groupId: it.groupId || null,
        totalValue: typeof it.totalValue === "number" && Number.isFinite(it.totalValue) && it.totalValue > 0 ? it.totalValue : null };
    }).filter(Boolean);
  }

  // Desloca uma data ISO em N meses, mantendo o dia (limitado ao fim do mês)
  function shiftMonths(iso, delta) {
    if (!isValidISODate(iso)) return "";
    const [y0, m0, d0] = iso.split("-").map(Number);
    const absoluteMonth = y0 * 12 + m0 - 1 + delta;
    const y = Math.floor(absoluteMonth / 12);
    const m = ((absoluteMonth % 12) + 12) % 12 + 1;
    const day = Math.min(d0, daysInMonth(y, m));
    const result = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return isValidISODate(result) ? result : "";
  }

  /* Parcelas e repetições são propostas de planejamento. Só o lançamento
     observado vem selecionado; as demais datas dependem do opt-in explícito.
     Data ausente fica vazia em toda a série até a conferência do usuário. */
  function expandSeries(list) {
    const out = [];
    (list || []).forEach((r, idx) => {
      if (r.parcTotal >= 2) {
        const serie = `s${srcSeq}_${idx}`;
        for (let k = 1; k <= r.parcTotal; k++) {
          const gen = k !== r.parcNum;
          out.push({ ...r, ...(gen ? { referenceId: "", sourceEvidence: "", sourcePage: undefined } : {}), serie, date: shiftMonths(r.date, k - r.parcNum), installment: `${k}/${r.parcTotal}`, gen, on: gen ? includeGenerated : r.on, monthOffset: k - r.parcNum });
        }
      } else if (r.fixa) {
        const serie = `s${srcSeq}_${idx}`;
        for (let i = 0; i < 12; i++) {
          out.push({ ...r, ...(i > 0 ? { referenceId: "", sourceEvidence: "", sourcePage: undefined } : {}), serie, date: shiftMonths(r.date, i), fixed: true, gen: i > 0, on: i > 0 ? includeGenerated : r.on, monthOffset: i });
        }
      } else {
        out.push(r);
      }
    });
    return out;
  }

  // Processa um resultado da IA (itens + cartão detectado) e acumula na lista
  function ingestAiResult(itens, cartao, metadata = {}) {
    if (metadata.partial) reviewWarnings.push("Leitura parcial: alguns dados podem não ter sido reconhecidos. Confira o documento antes de adicionar.");
    if (Array.isArray(metadata.avisos)) reviewWarnings.push(...metadata.avisos.filter((v) => typeof v === "string" && v.trim()).map((v) => v.slice(0, 300)));
    const det = typeof cartao === "string" ? stripAccents(cartao) : "";
    const card = det ? CARDS.find((c) => stripAccents(c) === det) || "" : "";
    detectedCard = card || detectedCard;
    const normalized = normalize(itens).map((r) => ({ ...r, account: r.account || card,
      sourceLabel: metadata.sourceLabel || "", sourcePage: r.sourcePage && metadata.pageStart ? r.sourcePage + metadata.pageStart - 1 : r.sourcePage }));
    const novos = expandSeries(normalized);
    if (novos.length) {
      const src = srcSeq++;
      novos.forEach((r) => {
        r.src = src;
        r.reviewRequired = metadata.reviewRequired === true;
        r.auditReasons = [metadata.additional ? "Item encontrado somente na segunda leitura. Confira no documento." : "Aguardando a segunda leitura do documento."];
        const rawCategory = itens[r.sourceIndex]?.categoria || itens[r.sourceIndex]?.category || "";
        const extractedCategory = availableCats().find((c) => stripAccents(c) === stripAccents(rawCategory)) || "Outros";
        r.extractedSnapshot = reviewSnapshot({ ...r, cat: extractedCategory }, true);
      });
      rows.push(...novos);
    }
    return normalized.length;
  }

  // Coincidência não prova duplicação. Todas as observadas ficam selecionadas
  // até decisão explícita; a revisão é invalidada se qualquer comparação mudar.
  function effectiveRow(r) {
    const cur = $("#batch-cur").value, account = $("#batch-acc").value;
    return { ...r, currency: cur && cur !== "original" ? cur : r.currency,
      account: account && account !== "original" ? account : account === "" && chosenAccount !== null ? "" : r.account };
  }
  function flagDuplicates() {
    if (typeof ImportMatch === "undefined") return 0;
    const existing = ImportMatch.createIndex(Dashboard.existingTransactions?.() || []);
    const seen = ImportMatch.createIndex();
    let flagged = 0;
    [...rows].sort((a, b) => Number(!!a.gen) - Number(!!b.gen)).forEach((r) => {
      const candidate = effectiveRow(r);
      const matches = [
        ...ImportMatch.find(candidate, existing).map((m) => ({ ...m, origin: "Já na pasta" })),
        ...ImportMatch.find(candidate, seen).filter((m) => !independentReferences(candidate, m.transaction)).map((m) => ({ ...m, origin: "Neste lote" }))
      ];
      const key = ImportMatch.reviewKey(candidate, matches);
      if (matches.length && r.matchKey !== key) flagged++;
      r.matches = matches; r.matchKey = key; r.dup = matches.length > 0;
      if (r.on) ImportMatch.addToIndex(seen, candidate);
    });
    return flagged;
  }
  function independentReferences(a, b) {
    const ref = (t) => String(t.referenceId || "").trim().toLowerCase();
    return autoVerified(a) && autoVerified(b) && ref(a) && ref(b) && ref(a) !== ref(b) &&
      a.currency === b.currency && a.type === b.type && !!a.account.trim() &&
      stripAccents(a.account) === stripAccents(b.account);
  }
  function matchHTML(r, index) {
    if (!r.dup) return "";
    r.displayedMatchKey = r.matchKey;
    const comparisons = r.matches.slice(0, 3).map((m) => {
      const t = m.transaction;
      return '<small>' + escapeHtml(m.origin + ': ' + m.reason + '. ' + t.date + ' · ' + t.desc + ' · ' + fmtMoney(t.amount, t.currency) + ' · ' + (t.account || 'sem conta') + (t.referenceId ? ' · ref. ' + t.referenceId : '')) + '</small>';
    }).join("");
    return '<div class="batch-match">' + comparisons + (r.matches.length > 3 ? '<small>Mais ' + (r.matches.length - 3) + ' comparação(ões).</small>' : '') +
      (r.confirmedMatch === r.matchKey ? '<strong>Confirmado como lançamento diferente</strong>' : '<button type="button" class="btn btn-ghost btn-sm" data-distinct="' + index + '">É um lançamento diferente</button>') + '</div>';
  }

  // Mensagem de sucesso do acúmulo (menciona o total quando já havia itens)
  function statusAcumulo(added) {
    if (!added) return;
    const observed = rows.filter((r) => !r.gen).length;
    const extra = observed !== added ? ` (total identificado: ${observed})` : "";
    setStatus(`${added} itens reconhecidos${extra} — confira e ajuste abaixo ✔`, "ok");
  }

  function completeCoverage(c, count) {
    return c?.complete === true && Array.isArray(c.pagesRead) && Array.isArray(c.unreadablePages) &&
      c.unreadablePages.length === 0 && Array.from({ length: count }, (_, n) => n + 1).every((n) => c.pagesRead.includes(n));
  }
  function applyDocumentReview(first, review, partRows, pageCount) {
    const indexes = new Set();
    const items = Array.isArray(review?.items) ? review.items : [];
    const shape = ["verified", "attention"].includes(review?.status) && review.checkedCount === first.itens.length &&
      items.length === first.itens.length && items.every((it) => {
        if (!it || !Number.isInteger(it.index) || it.index < 0 || it.index >= first.itens.length || indexes.has(it.index) ||
          !["verified", "attention"].includes(it.status) || !Array.isArray(it.reasons) || !it.reasons.every((s) => typeof s === "string")) return false;
        indexes.add(it.index); return true;
      }) && Array.isArray(review.issues) && review.issues.every((s) => typeof s === "string") && Array.isArray(review.additionalItems);
    const complete = first.partial !== true && completeCoverage(first.coverage, pageCount) && completeCoverage(review?.coverage, pageCount);
    const issues = shape ? review.issues.filter((s) => s.trim()).map((s) => s.slice(0, 300)) : ["A segunda leitura não confirmou todos os itens. Confira manualmente."];
    if (!complete) issues.push("A cobertura das duas leituras não está completa. Compare com o documento.");
    // A global attention verdict without an identified reason cannot earn a seal.
    if (shape && review.status === "attention" && !issues.length && !review.additionalItems.length && items.every((it) => it.status === "verified" && !it.reasons.length)) issues.push("A segunda leitura pediu atenção sem indicar um item. Confira manualmente.");
    const byIndex = new Map(items.map((it) => [it.index, it]));
    partRows.forEach((r) => {
      const result = byIndex.get(r.sourceIndex);
      r.auditReasons = [...issues, ...(result?.reasons || []).map((s) => s.slice(0, 300)), ...rowReview(r)];
      if (r.gen) r.auditReasons.push("Projeção calculada: esta data não foi identificada no documento.");
      if (shape && complete && !issues.length && result?.status === "verified" && !r.auditReasons.length && !r.gen) r.verifiedSnapshot = r.extractedSnapshot;
      else if (!r.auditReasons.length) r.auditReasons.push("As leituras divergiram neste item. Confira no documento.");
    });
    return { complete: shape && complete && !issues.length, issues,
      verified: shape && complete && !issues.length && review.status === "verified" && !review.additionalItems.length && items.every((it) => it.status === "verified" && !it.reasons.length) };
  }

  /* ---------- Origem: FOTO(s)/PDF(s) — fatura/planilha via IA no servidor ----------
     Aceita várias imagens/PDFs de uma vez (ex: 4 prints da fatura); lê em
     sequência e ACUMULA tudo numa lista só, para um único OK. */
  async function fromPhotos(files, version = generation) {
    const preflightFailure = (message) => {
      partialReviewed = false;
      coverage.push(...Array.from(files, (f) => ({ label: f.name || "Imagem", status: "failed", message: "não lido: " + message })));
      setStatus(message, "err"); renderPreview();
    };
    if (!proxyAvailable()) { preflightFailure("Leitura de foto/PDF funciona no app publicado. Para uso local, use Excel."); return; }
    const token = typeof Cloud !== "undefined" && Cloud.getToken ? Cloud.getToken() : null;
    if (!token) { preflightFailure("Entre na sua conta (seção nuvem) para ler fotos/PDFs."); return; }
    if (files.length > MAX_FILES) { setStatus("Selecione até 15 arquivos. Nenhum arquivo foi lido.", "err"); return; }
    partialReviewed = false;
    const fileRecords = Array.from(files, (file) => ({ label: file.name || "Imagem", status: "pending", message: "aguardando leitura" }));
    coverage.push(...fileRecords);
    let added = 0;
    try {
      for (let i = 0; i < files.length; i++) {
        if (!contextValid(version)) return;
        const record = fileRecords[i];
        let allComplete = true, partCount = 0;
        try {
          const parts = Receipt.prepareParts ? Receipt.prepareParts(files[i]) : (async function* () { yield { ...await Receipt.prepareFile(files[i]), documentContext: { pageStart: 1, pageEnd: 1, totalPages: 1 }, label: "imagem 1 de 1" }; })();
          for await (const part of parts) {
            if (!contextValid(version)) return;
            if (processedParts >= MAX_PARTS) throw new Error("limite_lote");
            processedParts++;
            partCount++;
            const label = record.label + " · " + part.label;
            const progress = { label, status: "pending", message: "lendo" };
            coverage.push(progress);
            setStatus("Lendo · arquivo " + (i + 1) + " de " + files.length + " · " + part.label + "…");
            coverageUI();
            const payload = { image: { media_type: part.mediaType, data: part.data }, multi: true,
              categories: Dashboard.getCats(), cards: CARDS, documentContext: part.documentContext };
            const post = (reviewOf) => fetch(PROXY_PATH, {
              signal: AbortSignal.timeout(65000), method: "POST",
              headers: { "content-type": "application/json", authorization: "Bearer " + token },
              body: JSON.stringify({ ...payload, ...(reviewOf ? { reviewOf } : {}) })
            });
            try {
              let res = await post();
              if (!contextValid(version)) return;
              let data = await res.json().catch(() => ({}));
              if (!contextValid(version)) return;
              // Repetir somente falha transitória; não reenviar após erro de sessão.
              if ((res.status === 502 || res.status === 504) && data.error !== "auth_indisponivel") {
                res = await post(); if (!contextValid(version)) return;
                data = await res.json().catch(() => ({})); if (!contextValid(version)) return;
              }
              if (!res.ok || data.error || !Array.isArray(data.itens)) {
                const message = data.error === "auth_indisponivel" ? "Não foi possível verificar sua sessão agora." :
                  data.error === "saldo_ia" ? "O serviço de leitura está sem créditos. Os itens já lidos continuam na prévia." :
                  data.error === "configuracao_ia" ? "A leitura por IA precisa de ajuste na configuração do servidor. Os itens já lidos continuam na prévia." :
                  res.status === 401 ? "Sua sessão expirou. Entre novamente." : res.status === 429 ? "Limite de leitura atingido. Aguarde e envie as partes restantes." : "Não foi possível ler esta parte.";
                progress.status = "failed"; progress.message = message; allComplete = false;
                if ([401, 429, 501, 503].includes(res.status) || data.error === "auth_indisponivel") {
                  record.status = "partial"; record.message = "leitura interrompida; há partes não lidas";
                  setStatus(message, "err"); return;
                }
                continue;
              }
              const count = part.documentContext.pageEnd - part.documentContext.pageStart + 1;
              const complete = data.partial !== true && completeCoverage(data.coverage, count);
              const beforeExcluded = excludedCount;
              const rowStart = rows.length;
              const countAdded = ingestAiResult(data.itens, data.cartao, { ...data, reviewRequired: true, sourceLabel: label, pageStart: part.documentContext.pageStart });
              const partRows = rows.slice(rowStart);
              progress.count = countAdded; added += countAdded;
              progress.status = complete && excludedCount === beforeExcluded ? "complete" : "partial";
              progress.message = "cobertura incompleta ou não confirmada; compare com o documento";
              viewFilter = "pending";
              renderPreview();
              setStatus("Conferindo documento · arquivo " + (i + 1) + " de " + files.length + " · " + part.label + "…");
              try {
                const checked = await post({ itens: data.itens, cartao: data.cartao, coverage: data.coverage, partial: data.partial });
                if (!contextValid(version)) return;
                const checkedData = await checked.json().catch(() => ({}));
                if (!contextValid(version)) return;
                if (!checked.ok || checkedData.error || !checkedData.review) throw new Error("review_failed");
                const result = applyDocumentReview(data, checkedData.review, partRows, count);
                progress.auditStatus = result.verified ? "verified" : "attention";
                if (!result.complete) { progress.status = "partial"; progress.message = result.issues.join(" "); }
                const extra = checkedData.review.additionalItems;
                if (Array.isArray(extra) && extra.length) {
                  const extraCount = ingestAiResult(extra, data.cartao, { reviewRequired: true, additional: true, sourceLabel: label + " · segunda leitura", pageStart: part.documentContext.pageStart });
                  progress.count += extraCount; added += extraCount;
                }
                if (excludedCount !== beforeExcluded) { progress.status = "partial"; progress.message = "há itens não reconhecidos; compare com o documento"; }
              } catch (error) {
                if (!contextValid(version)) return;
                partRows.forEach((r) => { r.auditReasons = ["A segunda conferência não foi concluída. Confira este item manualmente no documento."]; });
                progress.auditStatus = "failed";
                progress.status = "partial"; progress.message = "segunda conferência indisponível; cobertura não confirmada pelas duas leituras. Primeira leitura preservada, revisão manual obrigatória";
              }
              if (progress.status !== "complete") allComplete = false;
            } catch (error) {
              if (!contextValid(version)) return;
              progress.status = "failed"; progress.message = "leitura falhou ou excedeu o tempo; parte não importada";
              allComplete = false;
            }
          }
          record.status = allComplete && partCount ? "complete" : "partial";
          record.message = "há partes incompletas; revisão obrigatória";
        } catch (error) {
          if (!contextValid(version)) return;
          record.status = "failed";
          record.message = error?.message === "limite_lote" ? "Limite de 120 partes por lote atingido; envie o restante em outro lote." : Receipt.prepFailMsg ? Receipt.prepFailMsg(error) : "Arquivo ilegível ou acima do limite; confira as partes não lidas.";
          reviewWarnings.push(record.label + ": " + record.message);
        }
      }
      if (!contextValid(version)) return;
      setStatus(added + " lançamento(s) reconhecido(s). " + (incomplete() ? "Há partes incompletas: confira a lista de leitura." : "Leitura e conferência concluídas. Veja o resumo abaixo."), incomplete() ? "warn" : "ok");
    } finally {
      if (contextValid(version)) {
        coverage.filter((p) => p.status === "pending").forEach((p) => { p.status = "failed"; p.message = "não lido: execução interrompida"; });
        flagDuplicates(); renderPreview();
      }
    }
  }

  function renderIfAny(added) {
    if (added) { flagDuplicates(); renderPreview(); }
  }

  /* ---------- Origem: ARQUIVO(s) EXCEL (local, offline) ---------- */
  async function fromFiles(files, version = generation) {
    if (files.length > MAX_FILES) { setStatus("Selecione até 15 arquivos. Nenhum arquivo foi lido.", "err"); return; }
    partialReviewed = false;
    let added = 0;
    let falhas = [];
    for (const file of files) {
      if (!contextValid(version)) return;
      const progress = { label: file.name, status: "pending", message: "aguardando leitura" };
      coverage.push(progress);
      if (file.size > 30 * 1024 * 1024) { falhas.push(`"${file.name}" grande demais (máx. 30 MB)`); progress.status = "failed"; progress.message = "acima de 30 MB"; continue; }
      setStatus(files.length > 1 ? `Lendo "${file.name}"…` : "Lendo a planilha…");
      try {
        const txs = await Importer.readForBatch(file);
        if (!contextValid(version)) return;
        const report = txs.readReport;
        if (report) reviewWarnings.push(...report.warnings);
        progress.status = report && (report.skipped || report.unknownSheets.length || report.warnings.length) ? "partial" : "complete";
        progress.message = "linhas/abas não reconhecidas ou dados estimados; compare com a planilha e confira os avisos";
        const novos = normalize(txs);
        if (!novos.length) { falhas.push(`"${file.name}" sem transações reconhecidas`); progress.status = "failed"; continue; }
        progress.count = novos.length;
        const src = srcSeq++;
        novos.forEach((r) => { r.src = src; r.sourceLabel = file.name; });
        rows.push(...novos);
        added += novos.length;
        reviewWarnings.push("Confira a moeda sugerida pela planilha. O seletor do lote permite corrigi-la antes de salvar.");
      } catch (e) {
        if (!contextValid(version)) return;
        progress.status = "failed"; progress.message = "arquivo não lido";
        console.error(e);
        falhas.push(`"${file.name}" inválido`);
      }
    }
    reviewWarnings.push(...falhas);
    const flagged = flagDuplicates();
    if (added) {
      statusAcumulo(added);
      if (falhas.length || excludedCount) setStatus(`${added} itens lidos com avisos. Confira a revisão abaixo antes de adicionar.`, "warn");
      if (flagged) setStatus(`${added} itens lidos — ${flagged} coincidência(s) precisam de revisão antes de adicionar.`, "warn");
    } else {
      setStatus(falhas.length ? `Nada lido: ${falhas.join("; ")}.` : "Não reconheci transações. Confira o formato (Data, Descrição, Valor).", "err");
    }
    renderPreview();
  }

  function save() {
    if (reading) { toast("Aguarde a leitura terminar antes de adicionar."); return; }
    if (!contextValid()) { toast("A pasta ou conta mudou. Reabra a importação na pasta desejada."); return; }
    if (incomplete() && !partialReviewed) { toast("Confira as partes incompletas e confirme a revisão antes de salvar."); return; }
    flagDuplicates();
    if (rows.some((r) => r.on && r.dup && r.confirmedMatch !== r.matchKey)) {
      renderPreview(); toast("Há coincidências para revisar. Desmarque o item ou confirme que é um lançamento diferente."); return;
    }
    if (rows.some((r) => r.on && needsReview(r))) {
      viewFilter = "pending"; renderPreview(); toast("Confira os itens pendentes no documento e use Conferi este item antes de incluir."); return;
    }
    const fallbackCat = $("#batch-cat").value;
    const selectedCurrency = $("#batch-cur").value;
    const account = $("#batch-acc").value;
    const on = rows.filter((r) => r.on);
    if (!on.length) { toast("Selecione pelo menos um item ✔"); return; }
    const invalid = on.find((r) => !isValidISODate(r.date) || !r.desc.trim() || !Number.isFinite(r.amount) || r.amount <= 0 || r.amount > Number.MAX_SAFE_INTEGER);
    if (invalid) { toast("Confira os itens selecionados: informe data válida, descrição e valor maior que zero."); return; }
    if (on.some((r) => !["receita", "despesa"].includes(r.type) || !CURRENCY_CODES.includes(selectedCurrency === "original" ? r.currency : selectedCurrency))) {
      toast("Confira o tipo e a moeda de todos os itens selecionados."); return;
    }
    if (on.some((r) => !availableCats().includes(r.cat || fallbackCat))) {
      toast("Escolha uma categoria válida para todos os itens selecionados."); return;
    }
    // Formato interno completo: parceladas viram séries ligadas (groupId) e
    // fixas ganham a marca "fixa" — igual às criadas à mão no app.
    const txs = on.map((r) => ({
      date: r.date, desc: r.desc, amount: r.amount, type: r.type,
      category: r.cat || fallbackCat, currency: selectedCurrency === "original" ? r.currency : selectedCurrency,
      account: account === "original" ? r.account : account,
      groupId: r.serie || r.groupId || null,
      installment: r.installment || null,
      totalValue: r.totalValue,
      fixed: r.fixed === true,
      ...(r.referenceId ? { referenceId: r.referenceId } : {}),
      ...(r.sourceEvidence ? { sourceEvidence: r.sourceEvidence } : {}),
      ...(r.sourcePage ? { sourcePage: r.sourcePage } : {}),
    }));
    const n = Dashboard.appendImported(txs);
    if (n !== txs.length) { toast("Não foi possível adicionar todos os itens. A prévia foi mantida; confira se a pasta ainda está disponível."); return; }
    close();
    toast(`${n} transaç${n === 1 ? "ão adicionada" : "ões adicionadas"} ✔`);
  }

  /* ---------- Eventos ---------- */
  document.addEventListener("DOMContentLoaded", () => {
    $("#btn-batch-photo").addEventListener("click", () => $("#batch-input-photo").click());
    $("#btn-batch-file").addEventListener("click", () => $("#batch-input-file").click());
    $("#batch-input-photo").addEventListener("change", (ev) => {
      const fs = Array.from(ev.target.files || []);
      if (fs.length) runImport(fromPhotos, fs);
      ev.target.value = "";
    });
    $("#batch-input-file").addEventListener("change", (ev) => {
      const fs = Array.from(ev.target.files || []);
      ev.target.value = "";
      if (!fs.length) return;
      // Contexto geral (Nova transação → Fatura/lista): usa o motor COMPLETO
      // da importação inicial (categoria/cartão/parcela/recorrente por linha),
      // adicionando à pasta atual. Contexto de amigo (categoria pré-definida):
      // mantém o modo simples que joga tudo na categoria do amigo.
      if (!presetCat && fs.length === 1 && !rows.length && !coverage.length) {
        close();
        Importer.handleFile(fs[0], { addToCurrent: true });
        return;
      }
      runImport(fromFiles, fs);
    });
    $("#btn-batch-cancel").addEventListener("click", close);
    $("#btn-batch-save").addEventListener("click", save);
    ["pending", "all"].forEach((filter) => $("#batch-filter-" + filter).addEventListener("click", () => { viewFilter = filter; renderPreview(); $("#batch-details").open = true; }));
    // Trocar a moeda do lote reformata os valores das linhas e o total
    $("#batch-cur").addEventListener("change", renderPreview);
    // Trocar a categoria geral aplica a TODAS as linhas (elas voltam a segui-la)
    $("#batch-cat").addEventListener("change", () => { rows.forEach((r) => { r.cat = null; }); renderPreview(); });
    // Cartão escolhido à mão prevalece sobre o detectado pela IA
    $("#batch-acc").addEventListener("change", () => { chosenAccount = $("#batch-acc").value; renderPreview(); });
    $("#batch-partial-ack").addEventListener("change", () => { partialReviewed = $("#batch-partial-ack").checked; updateCount(); });
    $("#batch-include-generated").addEventListener("change", () => {
      includeGenerated = $("#batch-include-generated").checked;
      flagDuplicates();
      rows.forEach((r) => {
        if (r.gen) { r.on = includeGenerated; r.selectionTouched = false; }
      });
      renderPreview();
    });

    // Edição inline da lista
    const tbody = $("#batch-tbody");
    tbody.addEventListener("click", (ev) => {
      const reviewed = ev.target.closest?.("[data-reviewed]");
      if (reviewed?.dataset.reviewed != null) {
        const row = rows[Number(reviewed.dataset.reviewed)];
        if (!row || reading || !contextValid()) return;
        if (row.displayedReviewSnapshot !== reviewSnapshot(row)) { renderPreview(); toast("Os dados mudaram. Confira a versão atual antes de confirmar."); return; }
        if (invalidRow(row)) { toast("Preencha data, descrição e valor válidos antes de confirmar a revisão."); return; }
        row.manualSnapshot = reviewSnapshot(row);
        renderPreview(); return;
      }
      const button = ev.target.closest?.("[data-distinct]");
      const index = button ? Number(button.dataset.distinct) : NaN;
      if (!Number.isInteger(index) || !rows[index]) return;
      const displayed = rows[index].displayedMatchKey;
      flagDuplicates();
      if (displayed !== rows[index].matchKey) { renderPreview(); toast("A comparação mudou. Confira os dados atualizados antes de confirmar."); return; }
      rows[index].confirmedMatch = rows[index].matchKey;
      rows[index].on = true;
      renderPreview();
    });
    tbody.addEventListener("input", (ev) => {
      const el = ev.target;
      const i = Number(el.dataset.i);
      if (isNaN(i) || !rows[i]) return;
      const f = el.dataset.f;
      if (f === "date") {
        const current = rows[i];
        current.date = el.value;
        current.dateEdited = true;
        if (!current.gen && current.serie) {
          rows.forEach((r) => {
            if (r.gen && r.serie === current.serie && !r.dateEdited) r.date = shiftMonths(current.date, r.monthOffset);
          });
        }
      }
      else if (f === "desc") rows[i].desc = el.value;
      else if (f === "amount") { maskMoneyEl(el); rows[i].amount = Math.abs(moneyInputValue(el) || 0); }
      else if (f === "cat") rows[i].cat = el.value;
      else if (f === "type") rows[i].type = el.value;
      updateCount();
    });
    tbody.addEventListener("change", (ev) => {
      const el = ev.target;
      if (el.dataset.f) { renderPreview(); return; }
      if (!el.classList.contains("batch-check")) return;
      const i = Number(el.dataset.i);
      if (isNaN(i) || !rows[i]) return;
      rows[i].on = el.checked;
      rows[i].selectionTouched = true;
      el.closest("tr").classList.toggle("batch-off", !el.checked);
      renderPreview();
    });
  });

  // Reaplica o anti-duplicados e redesenha a lista (usado após ingestões diretas)
  function refreshPreview() {
    const flagged = flagDuplicates();
    renderPreview();
    return flagged;
  }

  return { open, openWithFiles, ingestAiResult, refreshPreview };
})();
