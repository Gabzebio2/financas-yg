/* ===== Finanças YG — importação em lote (fatura/planilha/Excel) =====
   Lê uma foto de fatura/planilha (via IA no servidor seguro) ou um arquivo
   Excel (local), extrai TODAS as transações e mostra uma lista para o usuário
   conferir e dar um OK — que lança tudo de uma vez na categoria escolhida. */
"use strict";

const Batch = (() => {
  const PROXY_PATH = "/api/receipt";
  let documentTasks = [];
  let backgroundJobId = null;
  let documentExclusions = [];
  let documentFailure = false;
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
  let targetId = null;
  let targetOwner = null;
  let processedParts = 0;
  let viewFilter = "all";
  let documentSeq = 0;
  let confirmationSeq = 0;
  let pendingConfirmation = null;
  let committing = false;
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
  }

  async function runImport(read, files) {
    if (reading) { toast("Aguarde a leitura atual terminar."); return; }
    const version = generation;
    reading = true;
    $("#batch-preview").inert = true;
    ["#btn-batch-photo", "#btn-batch-file", "#btn-batch-save"].forEach((id) => { $(id).disabled = true; });
    try { await read(files, version); }
    finally {
      if (version === generation) {
        reading = false;
        $("#batch-preview").inert = false;
        ["#btn-batch-photo", "#btn-batch-file"].forEach((id) => { $(id).disabled = false; });
        if(documentTasks.length)documentProgress();
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
    confirmationSeq++; pendingConfirmation = null; committing = false;
    reading = false;
    $("#batch-preview").inert = false;
    opts = opts || {};
    backgroundJobId = null;
    $("#btn-batch-delete").classList.add("hidden");
    $("#btn-batch-delete").disabled = false;
    presetCat = opts.category || null;
    rows = [];
    documentTasks = []; documentExclusions = []; documentFailure = false;
    $("#batch-phases").textContent = ""; $("#btn-batch-retry").classList.add("hidden");
    $("#batch-source-summary").textContent = ""; $("#batch-exclusions").innerHTML = "";
    srcSeq = 0;
    detectedCard = null;
    chosenAccount = null;
    includeGenerated = false;
    reviewWarnings = [];
    excludedCount = 0;
    coverage = []; processedParts = 0; documentSeq = 0;
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
    if(opts.backgroundJob)restoreBackgroundJob(opts.backgroundJob);
  }

  function restoreBackgroundJob(payload) {
    backgroundJobId=payload.job.id;
    $("#btn-batch-delete").classList.remove("hidden");
    rows=Array.isArray(payload.job.extra_rows)?payload.job.extra_rows:[];
    srcSeq=rows.reduce((n,r)=>Math.max(n,Number(r.src)||0),0);
    documentTasks=payload.pages.map(p=>({documentId:p.document_id,label:p.label,part:{documentContext:p.context},quick:p.quick,first:p.first_result,result:p.result,progress:{label:p.label,status:p.result?.partial?'partial':'complete',count:p.result?.itens?.length||0,auditStatus:p.result?.verified?'verified':'attention',message:(p.result?.avisos||[]).join(' ')}}));
    coverage=documentTasks.map(t=>t.progress);
    reviewWarnings=documentTasks.flatMap(t=>t.result?.avisos||[]);
    documentFailure=payload.job.status!=='ready'||documentTasks.some(t=>!t.result);
    rebuildDocumentPreview();flagDuplicates();renderPreview();
    setStatus('Leitura concluída e guardada com privacidade. Confira o resumo e clique em Incluir para salvar.','ok');
  }

  function close() {
    generation++;
    confirmationSeq++; pendingConfirmation = null;
    reading = false;
    $("#modal-batch").classList.add("hidden");
    rows = [];
  }

  function discardDocument() {
    if(!backgroundJobId||reading||committing||!contextValid())return;
    const id=backgroundJobId,version=generation,context={owner:targetOwner,folder:targetId};
    askConfirm('Excluir documento?',ReceiptJobs.discardText,async()=>{
      if(!contextValid(version)||backgroundJobId!==id||committing)return;
      committing=true;confirmationSeq++;pendingConfirmation=null;
      $("#btn-batch-delete").disabled=true;updateCount();
      try{
        await ReceiptJobs.discard(id,context);
        if(contextValid(version)){close();toast('Documento excluído. Você já pode enviá-lo novamente.');}
      }catch(e){if(contextValid(version))setStatus(ReceiptJobs.message(e),'err');}
      finally{if(version===generation){committing=false;$("#btn-batch-delete").disabled=false;updateCount();}}
    });
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
      t.totalValue, t.referenceId || "", t.sourceEvidence || "", t.sourcePage || null, t.cashback || null]);
  }
  function autoVerified(r) { return !r.gen && !r.dateEstimated && !!r.verifiedSnapshot && r.verifiedSnapshot === reviewSnapshot(r); }
  function needsReview(r) { return !!r.reviewRequired && !autoVerified(r); }
  function invalidRow(r) {
    const t = effectiveRow(r);
    return !isValidISODate(r.date) || !r.desc.trim() || !Number.isFinite(r.amount) || r.amount <= 0 || r.amount > Number.MAX_SAFE_INTEGER ||
      !["receita", "despesa"].includes(t.type) || !CURRENCY_CODES.includes(t.currency) || !availableCats().includes(t.cat || $("#batch-cat").value || "Outros");
  }
  function pendingRow(r) { return invalidRow(r) || needsReview(r) || r.dup || r.dateEstimated; }
  function prepareSelection() {
    if (typeof ImportDates !== "undefined") {
      const estimated = ImportDates.estimate(rows);
      estimated.forEach((r, i) => {
        delete rows[i].dateEstimated; delete rows[i].dateEstimate;
        Object.assign(rows[i], r);
      });
    }
    rows.forEach((r) => {
      if (invalidRow(r)) { r.on = false; r.autoInvalid = true; }
      else if (r.autoInvalid) {
        if (!r.selectionTouched && !r.duplicateExcluded) r.on = !r.gen || includeGenerated;
        r.autoInvalid = false;
      }
    });
  }
  function reviewHTML(r, index) {
    if (!r.reviewRequired) return "";
    if (autoVerified(r)) return '<div class="batch-verification-row verified">' + (r.quickRead ? 'Leitura rápida validada' : 'Conferido em duas leituras') + '</div>';
    const reasons = r.verifiedSnapshot ? ["Os dados foram alterados depois da conferência."] : r.auditReasons || ["A segunda leitura não confirmou este item."];
    return '<div class="batch-verification-row attention"><span>' + escapeHtml(reasons.join(" · ")) + '</span></div>';
  }
  function renderVerification() {
    const selected = rows.filter((r) => r.on);
    const pending = selected.filter(pendingRow).length;
    const automatic = selected.filter(autoVerified).length;
    const hasAI = rows.some((r) => r.reviewRequired);
    const quick = selected.some((r) => r.quickRead);
    const clean = hasAI && !reading && !incomplete() && !pending && selected.length > 0 && automatic === selected.length &&
      coverage.every((p) => !p.auditStatus || p.auditStatus === "verified");
    $("#batch-verification").classList.toggle("is-verified", clean);
    $("#batch-verification-title").textContent = reading ? "Conferindo seu documento" : !selected.length ? "Nenhum lançamento válido selecionado" : clean ? (quick ? "Pronto para incluir" : "Duas leituras, dados de acordo") : "Lote pronto para incluir";
    $("#batch-verification-note").textContent = !selected.length ? "Itens sem dados válidos ficaram fora. Abra os detalhes para corrigir." : clean ? (quick ? "Valores na moeda debitada. Cashback separado das receitas. Clique em Incluir." : "As duas leituras concordam. Inclua os lançamentos de uma vez.") : hasAI ? "Abra os detalhes se quiser editar. Apenas dúvidas que afetam os lançamentos pedem confirmação." : "Planilha lida no seu dispositivo, sem IA.";
    const selectedCurrency = $("#batch-cur").value;
    if (selectedCurrency && selectedCurrency !== "original") $("#batch-verification-note").textContent += ` Você alterou a moeda do lote para ${selectedCurrency}; os valores não são convertidos. O resumo abaixo conserva a moeda lida, e o Saldo da seleção mostra o que será incluído.`;
    $("#batch-verification-counts").textContent = hasAI ? (quick ? `${selected.length} selecionado(s) · ${automatic} validado(s)` : `${automatic} conferido(s) em duas leituras · ${selected.length} selecionado(s)`) + (pending ? ' · '+pending+' com aviso' : '') : `${selected.length} selecionado(s) · ${pending} com aviso · leitura local`;
    const totals = {};
    selected.forEach((r) => {
      const code = r.currency;
      if (!totals[code]) totals[code] = { receita: 0, despesa: 0 };
      if (Number.isFinite(r.amount)) totals[code][r.type] += r.amount;
    });
    $("#batch-currency-totals").innerHTML = Object.entries(totals).map(([code, t]) => '<div class="batch-currency-line"><strong>' + escapeHtml(code) + '</strong><span>Entradas <b>' + escapeHtml(fmtMoney(t.receita, code)) + '</b></span><span>Saídas <b>' + escapeHtml(fmtMoney(t.despesa, code)) + '</b></span></div>').join("");
    $("#batch-filter-pending").textContent = `Com avisos (${rows.filter((r) => (!r.gen || includeGenerated) && pendingRow(r)).length})`;
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
    const invalid = rows.filter((r) => !r.gen && invalidRow(r)).length;
    if (invalid) messages.push(`${invalid} item(ns) sem dados válidos ficaram fora da seleção. Você pode corrigi-los nos detalhes.`);
    const repeated = rows.filter((r) => r.duplicateExcluded && !r.on).length;
    if (repeated) messages.push(`${repeated} item(ns) com a mesma referência e dados já registrados ou repetidos ficaram fora. Você pode selecioná-los de volta nos detalhes.`);
    const unresolved = rows.filter((r) => r.on && r.dup).length;
    if (unresolved) messages.push(`${unresolved} possível(is) duplicata(s) estão selecionadas e serão informadas na confirmação do lote.`);
    const estimated = rows.filter((r) => r.on && r.dateEstimated).length;
    if (estimated) messages.push(`${estimated} data(s) estimada(s) pelos lançamentos vizinhos do mesmo documento. A estimativa ficará identificada após a inclusão.`);
    const invalidGenerated = rows.filter((r) => r.gen && invalidRow(r)).length;
    if (includeGenerated && invalidGenerated) messages.push(`${invalidGenerated} projeção(ões) sem data válida ficaram fora. Informe manualmente a data observada para gerar o planejamento.`);
    if (generated) messages.push(`${generated} lançamento(s) são projeções de parcelas ou repetições, não identificados no documento. ${includeGenerated ? "Revise as projeções selecionadas." : "Só serão incluídos se você ativar a opção abaixo."}`);
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
    const commonAccount = rows.length && rows[0].account && rows.every((r) => r.account === rows[0].account) ? rows[0].account : "original";
    accSel.value = chosenAccount != null ? chosenAccount : commonAccount;
    prepareSelection();
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
        }</div>${r.dateEstimated ? '<small class="batch-estimated-date">Data estimada pelos vizinhos do documento</small>' : ""}${rowReview(r).length ? `<small class="hint">${escapeHtml(rowReview(r).join(" · "))}</small>` : ""}${r.account ? `<small class="hint">${escapeHtml(r.account)}</small>` : ""}${r.sourceLabel ? `<small class="hint">${escapeHtml(r.sourceLabel)}</small>` : ""}${r.referenceId ? `<small class="hint">Referência: ${escapeHtml(r.referenceId)}</small>` : ""}${r.cashback ? `<small class="hint">Cashback informativo: ${escapeHtml(String(r.cashback.amount))} ${escapeHtml(r.cashback.currency)} · fora das receitas</small>` : ""}${reviewHTML(r, i)}${matchHTML(r, i)}</td>
        <td class="num"><input type="text" class="batch-val" data-f="amount" data-i="${i}" data-cur="${selectedCurrency === "original" ? r.currency : normCur(selectedCurrency)}" value="${Number.isFinite(r.amount)?fmtMoneyInput(r.amount, selectedCurrency === "original" ? r.currency : selectedCurrency):""}"><select data-f="currency" data-i="${i}" aria-label="Moeda debitada"><option value="">Definir moeda</option>${CURRENCY_CODES.map(c=>`<option value="${c}" ${r.currency===c?"selected":""}>${c}</option>`).join("")}</select></td>
        <td>
          <select data-f="cat" data-i="${i}">
            ${cats.map((c) => `<option value="${escapeHtml(c)}" ${(r.cat || fallCat) === c ? "selected" : ""}>${escapeHtml(c)}</option>`).join("")}
          </select>
        </td>
        <td>
          <select data-f="type" data-i="${i}">
            <option value="" ${!r.type?"selected":""}>Definir tipo</option>
            <option value="despesa" ${r.type === "despesa" ? "selected" : ""}>Despesa</option>
            <option value="receita" ${r.type === "receita" ? "selected" : ""}>Receita</option>
          </select>
        </td>
      </tr>`).join("");
    if (!$("#batch-tbody").innerHTML) $("#batch-tbody").innerHTML = '<tr><td colspan="6" class="empty-table">Nenhum aviso nesta seleção. Use Todos para ver ou ajustar os lançamentos.</td></tr>';

    $("#batch-preview").classList.remove("hidden");
    $("#btn-batch-save").classList.remove("hidden");
    updateCount();
  }

  function updateCount() {
    prepareSelection();
    const on = rows.filter((r) => r.on);
    const selectedCurrency = $("#batch-cur").value;
    const totals = {};
    on.forEach((r) => {
      const cur = selectedCurrency === "original" ? normCur(r.currency) : normCur(selectedCurrency);
      totals[cur] = (totals[cur] || 0) + (r.type === "receita" ? r.amount : -r.amount);
    });
    const total = Object.entries(totals).map(([cur, amount]) => fmtMoney(amount, cur)).join(" · ") || fmtMoney(0, "BRL");
    $("#batch-count").textContent = `${on.length} de ${rows.length} selecionadas · Saldo da seleção: ${total}`;
    $("#btn-batch-save").textContent = `Incluir ${on.length} lançamento${on.length === 1 ? "" : "s"}`;
    $("#btn-batch-save").disabled = reading || committing || documentFailure || on.length === 0;
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
      const review = Array.isArray(it.revisar) ? it.revisar.filter((v) => typeof v === "string" && v.trim()).map((v) => v.slice(0, 180)) : [];

      // Categoria sugerida pela IA por item (validada contra as da pasta).
      // Na cobrança de amigo (presetCat) tudo vai para a categoria do amigo —
      // a sugestão da IA é ignorada de propósito.
      const rawCat = presetCat || it.categoria || it.category || "";
      const cat = availableCats().find((c) => stripAccents(c) === stripAccents(rawCat)) || "Outros";
      // "Outros" is a valid default; categorization is optional editing, not a
      // financial ambiguity that should block an otherwise clear receipt.

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
        cashback: it.cashback && Number.isFinite(it.cashback.valor) && it.cashback.valor>0 ? {amount:it.cashback.valor,currency:it.cashback.moeda} : null,
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
      sourceDocumentId: metadata.sourceDocumentId || "",
      sourceLabel: metadata.sourceLabel || "", sourcePage: r.sourcePage && metadata.pageStart ? r.sourcePage + metadata.pageStart - 1 : r.sourcePage }));
    normalized.forEach((r) => { r.order = (r.sourcePage || metadata.pageStart || 1) * 10000 + (metadata.orderOffset || 0) + r.sourceIndex; });
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
    // Automatic preselection describes the rows; only an explicit user choice
    // overrides them. A later file from another bank must keep its own account.
    const cur = $("#batch-cur").value, account = chosenAccount == null ? "original" : chosenAccount;
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
      const exact = matches.some((m) => sameReferencedOperation(candidate, m.transaction));
      if (!r.selectionTouched && !r.gen) {
        if (exact) { r.on = false; r.duplicateExcluded = true; }
        else if (r.duplicateExcluded) { r.duplicateExcluded = false; r.on = !invalidRow(r); }
      }
      if (r.on) ImportMatch.addToIndex(seen, candidate);
    });
    return flagged;
  }
  function sameReferencedOperation(a, b) {
    const ref = (t) => String(t.referenceId || "").trim().toLowerCase();
    return !a.dateEstimated && !b.dateEstimated && ref(a) && ref(a) === ref(b) && a.date === b.date && a.amount === b.amount &&
      a.type === b.type && a.currency === b.currency && !!a.account.trim() && stripAccents(a.account) === stripAccents(b.account);
  }
  function independentReferences(a, b) {
    const ref = (t) => String(t.referenceId || "").trim().toLowerCase();
    return autoVerified(a) && autoVerified(b) && ref(a) && ref(b) && ref(a) !== ref(b) &&
      a.currency === b.currency && a.type === b.type && !!a.account.trim() &&
      stripAccents(a.account) === stripAccents(b.account);
  }
  function matchHTML(r, index) {
    if (!r.dup) return "";
    const comparisons = r.matches.slice(0, 3).map((m) => {
      const t = m.transaction;
      return '<small>' + escapeHtml(m.origin + ': ' + m.reason + '. ' + t.date + ' · ' + t.desc + ' · ' + fmtMoney(t.amount, t.currency) + ' · ' + (t.account || 'sem conta') + (t.referenceId ? ' · ref. ' + t.referenceId : '')) + '</small>';
    }).join("");
    return '<div class="batch-match">' + comparisons + (r.matches.length > 3 ? '<small>Mais ' + (r.matches.length - 3) + ' comparação(ões).</small>' : '') +
      (r.duplicateExcluded && !r.on ? '<strong>Fora da seleção: mesma referência e dados. Marque para incluir mesmo assim.</strong>' : '<small>Se mantiver selecionado, este aviso aparecerá na confirmação única do lote.</small>') + '</div>';
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
  function documentProgress() {
    const total=documentTasks.length, first=documentTasks.filter(t=>t.first).length, second=documentTasks.filter(t=>t.result).length;
    const firstItems=documentTasks.reduce((n,t)=>n+(t.first?.itens?.length||0),0), finalItems=documentTasks.reduce((n,t)=>n+(t.result?.itens?.length||0),0);
    const quick=documentTasks.filter(t=>t.result?.reviewMode==='automatic').length;
    $("#batch-phases").textContent = quick===total ? 'Leitura rápida concluída · '+finalItems+' operações identificadas.' : documentTasks.every(t=>t.quick)&&second===0 ? 'Lendo seus prints · '+first+'/'+total+' concluído(s)…' : '1. Leitura do original: '+first+'/'+total+' páginas · '+firstItems+' operações encontradas.\n2. '+(quick?quick+' print(s) validados automaticamente; ':'')+'comparação com o original: '+(second-quick)+'/'+(total-quick)+' páginas · '+finalItems+' operações na prévia final.';
    $("#btn-batch-retry").classList.toggle("hidden",!documentFailure||reading);
  }
  function rebuildDocumentPreview() {
    rows=rows.filter(r=>!r.documentTask);
    documentExclusions=[];
    for(const t of documentTasks){
      const data=t.result||t.first;if(!data)continue;
      const start=rows.length;
      ingestAiResult(data.itens,data.cartao,{sourceDocumentId:t.documentId,sourceLabel:t.label,pageStart:t.part.documentContext.pageStart,reviewRequired:true});
      rows.slice(start).forEach(r=>{
        r.documentTask=true;
        r.quickRead=t.result?.reviewMode==='automatic';
        r.auditReasons=t.result ? (r.review.length?r.review:['Comparado com a página original.']) : ['Aguardando comparação com o original.'];
        if(t.result && !r.review.length && !data.partial && !data.avisos?.length)r.verifiedSnapshot=reviewSnapshot(r);
      });
      if(t.result)documentExclusions.push(...(data.excluded||[]).map(x=>({...x,label:t.label})));
    }
    const rejected=documentExclusions.filter(x=>x.operacao!==false&&x.motivo==='recusado').length, cashback=documentExclusions.filter(x=>x.operacao!==false&&x.motivo==='cashback').length, others=documentExclusions.filter(x=>x.operacao!==false&&!['recusado','cashback','resumo'].includes(x.motivo)).length;
    const lines=documentTasks.reduce((n,t)=>n+(t.result?.ledger?.monetaryLines||0),0), covered=documentTasks.reduce((n,t)=>n+(t.result?.ledger?.accounted||0),0);
    const docCounts=new Map();for(const t of documentTasks)if(t.result?.expectedCount)docCounts.set(t.documentId,t.result.expectedCount);
    const summary=[];
    if(lines)summary.push(covered+' de '+lines+' linhas monetárias do texto original têm correspondência.');
    if(rejected||cashback)summary.push(rejected+' tentativa(s) recusada(s) e '+cashback+' registro(s) de cashback ficaram fora das receitas/despesas.');
    const cashbackTotals={};for(const r of rows)if(r.cashback?.amount>0)cashbackTotals[r.cashback.currency]=(cashbackTotals[r.cashback.currency]||0)+r.cashback.amount;
    if(Object.keys(cashbackTotals).length)summary.push('Cashback informativo: '+Object.entries(cashbackTotals).map(([c,v])=>fmtMoney(v,c)+' '+c).join(' · ')+'. Não soma nas receitas.');
    if(others)summary.push(others+' outra(s) exclusão(ões) explicada(s) abaixo.');
    for(const [doc,count] of docCounts){
      const tasks=documentTasks.filter(t=>t.documentId===doc);if(tasks.some(t=>!t.result))continue;
      const accounted=tasks.reduce((n,t)=>n+t.result.itens.length+(t.result.excluded||[]).filter(x=>x.operacao!==false&&x.motivo!=='resumo').length,0);
      summary.push('Documento informa '+count+' operações; '+accounted+' foram identificadas e explicadas.');
      if(count!==accounted){
        const message='A contagem impressa ('+count+') difere das operações identificadas ('+accounted+'). Confira as exclusões e o documento antes de incluir.';
        summary.push(message);if(!reviewWarnings.includes(message))reviewWarnings.push(message);
        rows.filter(r=>tasks.some(t=>t.documentId===r.sourceDocumentId)).forEach(r=>{delete r.verifiedSnapshot;});
      }
    }
    $("#batch-source-summary").textContent=summary.join(' ');
    $("#batch-exclusions").innerHTML=documentExclusions.filter(x=>x.motivo!=='resumo').map(x=>'<li>'+escapeHtml(x.descricao)+' — '+escapeHtml(x.explicacao)+(x.operacao===false?' (informação de resumo)':'')+' <small>'+escapeHtml(x.label)+'</small></li>').join('');
    renderPreview();documentProgress();
  }
  async function processDocumentTasks(version) {
    documentFailure=false;$("#btn-batch-retry").classList.add("hidden");
    const post=async(t,first)=>{
      const token=await Cloud.getToken();if(!token)throw Error('login_required');
      const headerPart=t.part.mediaType==='application/pdf'&&t.part.documentContext.pageStart>1?documentTasks.find(x=>x.documentId===t.documentId&&x.part.documentContext.pageStart===1&&x.part.mediaType==='application/pdf')?.part:null;
      const sourceHeader=headerPart?.data?.length<=262144&&headerPart.data.length+t.part.data.length<=4200000?headerPart.data:undefined;
      const res=await fetch('/api/receipt-document',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},signal:AbortSignal.timeout(175000),body:JSON.stringify({image:{media_type:t.part.mediaType,data:t.part.data},categories:Dashboard.getCats(),cards:CARDS,documentContext:t.part.documentContext,...(sourceHeader?{sourceHeader}:{}),mode:t.quick&&!first?'quick':'full',...(first?{first}: {})})});
      const data=await res.json().catch(()=>({}));
      if(!res.ok&&data.error==='resposta_incompleta'&&t.quick&&!first){
        t.quick=false;setStatus('Este print é mais extenso. Continuando com a leitura completa…');
        return post(t,null);
      }
      if(!res.ok||!Array.isArray(data.itens)||!data.ledger)throw Error(data.error||'leitura_indisponivel');return data;
    };
    // Complete the first stage across ALL pages, then compare the original to
    // each first draft. Completion is never inferred merely from equal counts.
    const processTask=async(t,stage)=>{
        if(t[stage]||documentFailure||!contextValid(version))return;
        setStatus((stage==='first'?'Etapa 1 · lendo':'Etapa 2 · comparando com o original')+' · '+t.label+'…');documentProgress();
        try {
          let data=await post(t,stage==='result'?t.first:null);
          if(!contextValid(version))return;
          // Missing text anchors are concrete evidence for a targeted reread.
          if(stage==='result'&&data.ledger.missing.length){
            setStatus('Rechecando linhas sem correspondência · '+t.label+'…');
            data=await post(t,{...data,avisos:data.avisos});if(!contextValid(version))return;
          }
          t[stage]=data;
          if(stage==='first'&&t.quick&&data.reviewMode==='automatic'&&data.verified&&!data.partial)t.result=data;
          if(stage==='result'||t.result){
            t.progress.status=data.partial?'partial':'complete';t.progress.count=data.itens.length;
            t.progress.auditStatus=data.verified?'verified':'attention';t.progress.message=(data.avisos||[]).join(' ');
            reviewWarnings.push(...(data.avisos||[]));
          }
          rebuildDocumentPreview();
        }catch(e){
          if(!contextValid(version))return;
          documentFailure=true;t.progress.status='failed';t.progress.message=stage==='first'?'Primeira leitura não concluída':'Comparação não concluída';
          setStatus('A leitura parou em '+t.label+'. '+(e.message==='saldo_ia'?'O serviço de IA está sem créditos. ':'')+'Use Continuar leitura para retomar desta etapa. Nenhum lançamento foi salvo.','err');
          documentProgress();$("#btn-batch-retry").classList.remove("hidden");renderPreview();return;
        }
    };
    // At most two independent small images in flight. Successful pages survive a
    // failure; retry resumes only missing work. PDFs keep the two-stage audit.
    for(const stage of ['first','result']){
      const tasks=documentTasks.filter(t=>!t[stage]);
      const concurrency=stage==='first'&&tasks.every(t=>t.quick)?2:1;
      for(let i=0;i<tasks.length;i+=concurrency){
        await Promise.all(tasks.slice(i,i+concurrency).map(t=>processTask(t,stage)));
        if(documentFailure||!contextValid(version))return;
      }
    }
    setStatus(documentTasks.every(t=>t.result?.reviewMode==='automatic')?'Leitura concluída. Clique em Incluir para salvar.':'Leitura e conferência concluídas. Clique em Incluir para salvar.','ok');
    rebuildDocumentPreview();
  }
  async function fromDocumentPages(files,version) {
    if(backgroundJobId){setStatus('Conclua a inclusão deste documento antes de enviar outro.','err');return;}
    if(documentTasks.some(t=>!t.result)){setStatus('Conclua a leitura atual antes de anexar mais arquivos.','err');return;}
    const prepared=[];
    try {
      if(files.length>MAX_FILES)throw Error('partes_demais');
      for(const file of files){
        const documentId='document-'+(++documentSeq);
        for await(const part of Receipt.prepareParts(file,{singlePage:true})){
          if(!contextValid(version))return;if(documentTasks.length+prepared.length>=MAX_PARTS)throw Error('partes_demais');
          const label=file.name+' · '+part.label,progress={label,status:'pending',message:'Aguardando leitura'};
          prepared.push({part,documentId,label,progress});
        }
      }
      const quick=prepared.length<=3&&prepared.every(t=>t.part.mediaType!=='application/pdf');
      prepared.forEach(t=>{t.quick=quick;});
      if(typeof ReceiptJobs!=='undefined'){
        try{
          setStatus('Preparando envio privado. Mantenha o app aberto até terminar o envio…');
          await ReceiptJobs.submit(prepared,rows.map(r=>({...r,documentTask:false})),msg=>{if(contextValid(version))setStatus(msg);});
          if(!contextValid(version))return;
          close();toast('Enviado! Pode apagar a tela. Acompanhe o resultado no sino de notificações.');
        }catch(e){if(contextValid(version))setStatus(ReceiptJobs.uploadMessage(e),'err');}
        return;
      }
      documentTasks.push(...prepared);coverage.push(...prepared.map(t=>t.progress));
      documentProgress();await processDocumentTasks(version);
    }catch(e){if(!contextValid(version))return;setStatus('Nenhuma página dos novos arquivos foi enviada. '+(Receipt.prepFailMsg?Receipt.prepFailMsg(e):'Não foi possível preparar todas as páginas.')+' Selecione os arquivos novamente.','err');}
  }

  async function fromPhotos(files, version = generation) {
    if (Receipt.documentReaderVersion === 2) return fromDocumentPages(files, version);
    const preflightFailure = (message) => {
      coverage.push(...Array.from(files, (f) => ({ label: f.name || "Imagem", status: "failed", message: "não lido: " + message })));
      setStatus(message, "err"); renderPreview();
    };
    if (!proxyAvailable()) { preflightFailure("Leitura de foto/PDF funciona no app publicado. Para uso local, use Excel."); return; }
    const token = typeof Cloud !== "undefined" && Cloud.getToken ? Cloud.getToken() : null;
    if (!token) { preflightFailure("Entre na sua conta (seção nuvem) para ler fotos/PDFs."); return; }
    if (files.length > MAX_FILES) { setStatus("Selecione até 15 arquivos. Nenhum arquivo foi lido.", "err"); return; }
    const fileRecords = Array.from(files, (file) => ({ label: file.name || "Imagem", sourceDocumentId: `doc${generation}_${documentSeq++}`, status: "pending", message: "aguardando leitura" }));
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
              const countAdded = ingestAiResult(data.itens, data.cartao, { ...data, reviewRequired: true, sourceDocumentId: record.sourceDocumentId, sourceLabel: label, pageStart: part.documentContext.pageStart });
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
                  const extraCount = ingestAiResult(extra, data.cartao, { reviewRequired: true, additional: true, sourceDocumentId: record.sourceDocumentId, orderOffset: data.itens.length, sourceLabel: label + " · segunda leitura", pageStart: part.documentContext.pageStart });
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
          record.message = "há partes incompletas; o aviso aparecerá na confirmação do lote";
        } catch (error) {
          if (!contextValid(version)) return;
          record.status = "failed";
          record.message = error?.message === "limite_lote" ? "Limite de 120 partes por lote atingido; envie o restante em outro lote." : Receipt.prepFailMsg ? Receipt.prepFailMsg(error) : "Arquivo ilegível ou acima do limite; confira as partes não lidas.";
          reviewWarnings.push(record.label + ": " + record.message);
        }
      }
      if (!contextValid(version)) return;
      setStatus(added + " lançamento(s) reconhecido(s). " + (incomplete() ? "Há avisos que aparecerão na confirmação única do lote." : "Leitura e conferência concluídas. Veja o resumo abaixo."), incomplete() ? "warn" : "ok");
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
    let added = 0;
    let falhas = [];
    for (const file of files) {
      if (!contextValid(version)) return;
      const progress = { label: file.name, sourceDocumentId: `doc${generation}_${documentSeq++}`, status: "pending", message: "aguardando leitura" };
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
        novos.forEach((r) => { r.src = src; r.sourceLabel = file.name; r.sourceDocumentId = progress.sourceDocumentId; r.order = r.sourceIndex; });
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

  function selectionPlan() {
    prepareSelection();
    flagDuplicates();
    const selected = rows.filter((r) => r.on && !invalidRow(r));
    const txs = selected.map((r) => {
      const t = effectiveRow(r);
      return {
        date: t.date, desc: t.desc, amount: t.amount, type: t.type,
        category: t.cat || $("#batch-cat").value, currency: t.currency, account: t.account,
        groupId: t.serie || t.groupId || null, installment: t.installment || null,
        totalValue: t.totalValue, fixed: t.fixed === true,
        ...(t.cashback ? {cashback:t.cashback} : {}),
        ...(t.referenceId ? { referenceId: t.referenceId } : {}),
        ...(t.sourceEvidence ? { sourceEvidence: t.sourceEvidence } : {}),
        ...(t.sourcePage ? { sourcePage: t.sourcePage } : {}),
        ...(t.dateEstimated ? { dateEstimated: true, dateEstimate: { ...t.dateEstimate } } : {})
      };
    });
    const counts = {
      differences: selected.filter((r) => needsReview(r) || rowReview(r).length).length,
      duplicates: selected.filter((r) => r.dup).length,
      estimated: selected.filter((r) => r.dateEstimated).length,
      skipped: excludedCount + rows.filter((r) => !r.gen && invalidRow(r)).length,
      repeated: rows.filter((r) => r.duplicateExcluded && !r.on).length,
      projections: selected.filter((r) => r.gen).length
    };
    const failedAudit = coverage.some((p) => p.auditStatus === "failed");
    const warnings = [];
    if (counts.differences) warnings.push(`${counts.differences} lançamento(s) com diferenças ou campos não confirmados nas duas leituras.`);
    if (counts.duplicates) warnings.push(`${counts.duplicates} possível(is) duplicata(s) serão incluídas porque continuam selecionadas.`);
    if (counts.skipped) warnings.push(`${counts.skipped} item(ns) sem dados válidos ficaram fora deste lote.`);
    if (counts.projections) warnings.push(`${counts.projections} projeção(ões) de parcelas ou meses foram selecionadas por você.`);
    if (incomplete()) warnings.push("Há partes não lidas ou cobertura incompleta. Este lote não representa necessariamente o documento inteiro.");
    if (failedAudit) warnings.push("A segunda conferência não foi concluída. A inclusão usará os dados disponíveis da primeira leitura.");
    warnings.push(...[...new Set(reviewWarnings)].slice(0, 6));
    const totals = {};
    txs.forEach((t) => {
      if (!totals[t.currency]) totals[t.currency] = { receita: 0, despesa: 0 };
      totals[t.currency][t.type] += t.amount;
    });
    const totalText = Object.entries(totals).map(([code, t]) => `${code}: entradas ${fmtMoney(t.receita, code)}; saídas ${fmtMoney(t.despesa, code)}.`).join("\n");
    const key = JSON.stringify({ rows: rows.map((r) => [r.on, reviewSnapshot(r), r.matchKey || "", r.auditReasons || [], r.review || [], !!r.dateEstimated, r.dateEstimate || null, !!r.duplicateExcluded]), coverage, reviewWarnings, excludedCount, txs, counts });
    return { txs, warnings, failedAudit, totalText, key };
  }

  async function commitPlan(plan, version) {
    if (committing || reading || !contextValid(version)) return;
    committing = true;
    pendingConfirmation = null;
    confirmationSeq++;
    updateCount();
    try {
      let n;
      if(backgroundJobId){
        const result=await ReceiptJobs.commit(backgroundJobId,plan.txs);
        // The server committed once, even if this browser loses the response.
        // Sync merges remote additions by their stable IDs, preserving local edits.
        await Cloud.syncNow({fresh:true});
        if(!contextValid(version))return;
        Dashboard.refreshFromStore({force:true});
        n=result.transactions.length;ReceiptJobs.refresh();
      }else n = Dashboard.appendImported(plan.txs);
      if (n !== plan.txs.length) { toast("Não foi possível adicionar todos os itens. A prévia foi mantida; confira se a pasta ainda está disponível."); return; }
      close();
      toast(`${n} transaç${n === 1 ? "ão adicionada" : "ões adicionadas"} ✔`);
    } catch (error) {
      toast(backgroundJobId?"Não foi possível confirmar a resposta. Confira o sino de notificações ou tente Incluir novamente; este lote está protegido contra gravação repetida.":"Não foi possível gravar o lote. A prévia foi mantida para tentar novamente.");
    } finally {
      committing = false;
      if (version === generation) updateCount();
    }
  }

  function confirmPlan(plan, version, changed = false) {
    const ticket = ++confirmationSeq;
    pendingConfirmation = ticket;
    const label = plan.failedAudit ? "Incluir sem a segunda conferência" : `Incluir ${plan.txs.length} lançamento${plan.txs.length === 1 ? "" : "s"}`;
    const text = `${changed ? "O lote mudou desde a confirmação anterior. Este é o resumo atualizado.\n\n" : ""}${plan.txs.length} lançamento(s) serão incluídos na pasta atual.\n\n${plan.totalText}\n\n${plan.warnings.join("\n")}\n\nConfirmar inclui todos os lançamentos válidos selecionados de uma vez.`;
    askConfirm("Incluir lote com avisos?", text, () => {
      if (ticket !== pendingConfirmation || ticket !== confirmationSeq || committing) return;
      pendingConfirmation = null;
      if (reading || !contextValid(version)) { toast("A pasta, conta ou leitura mudou. Reabra a inclusão na pasta desejada."); return; }
      const current = selectionPlan();
      if (!current.txs.length) { renderPreview(); toast("Nenhum lançamento válido está selecionado. Veja os detalhes do lote."); return; }
      if (current.key !== plan.key) { renderPreview(); confirmPlan(current, version, true); return; }
      commitPlan(current, version);
    }, { confirmLabel: label });
  }

  function save() {
    if (reading || committing || documentFailure) { toast("Conclua a leitura e a comparação antes de adicionar."); return; }
    if (!contextValid()) { toast("A pasta ou conta mudou. Reabra a importação na pasta desejada."); return; }
    if (pendingConfirmation && !$("#modal-confirm").classList.contains("hidden")) return;
    const plan = selectionPlan();
    renderPreview();
    if (!plan.txs.length) { toast("Nenhum lançamento válido está selecionado. Abra os detalhes para corrigir os dados ou selecionar itens."); return; }
    if (plan.warnings.length) confirmPlan(plan, generation);
    else commitPlan(plan, generation);
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
    $("#btn-batch-delete").addEventListener("click", discardDocument);
    $("#btn-batch-save").addEventListener("click", save);
    $("#btn-batch-retry").addEventListener("click",()=>runImport((_,version)=>processDocumentTasks(version),[]));
    ["pending", "all"].forEach((filter) => $("#batch-filter-" + filter).addEventListener("click", () => { viewFilter = filter; renderPreview(); $("#batch-details").open = true; }));
    // Trocar a moeda do lote reformata os valores das linhas e o total
    $("#batch-cur").addEventListener("change", renderPreview);
    // Trocar a categoria geral aplica a TODAS as linhas (elas voltam a segui-la)
    $("#batch-cat").addEventListener("change", () => { rows.forEach((r) => { r.cat = null; }); renderPreview(); });
    // Cartão escolhido à mão prevalece sobre o detectado pela IA
    $("#batch-acc").addEventListener("change", () => { chosenAccount = $("#batch-acc").value; renderPreview(); });
    $("#batch-include-generated").addEventListener("change", () => {
      includeGenerated = $("#batch-include-generated").checked;
      flagDuplicates();
      rows.forEach((r) => {
        if (r.gen) { r.on = includeGenerated && !invalidRow(r); r.selectionTouched = false; }
      });
      renderPreview();
    });

    // Edição inline da lista
    const tbody = $("#batch-tbody");
    tbody.addEventListener("input", (ev) => {
      if(reading)return;
      const el = ev.target;
      const i = Number(el.dataset.i);
      if (isNaN(i) || !rows[i]) return;
      const f = el.dataset.f;
      if (f === "date") {
        const current = rows[i];
        current.date = el.value;
        current.dateEdited = true;
        delete current.dateEstimated; delete current.dateEstimate;
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
      else if (f === "currency") rows[i].currency = el.value;
      updateCount();
    });
    tbody.addEventListener("change", (ev) => {
      if(reading)return;
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
