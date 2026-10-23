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
    open({ title: "Upload do comprovante", hideSources: true });
    const version = generation;
    const arr = Array.from(files || []).slice(0, 15);
    // Fotos e PDFs vão juntos para a IA; Excel é lido localmente
    const aiFiles = arr.filter((f) =>
      /^image\//.test(f.type) || /\.(png|jpe?g|webp|gif)$/i.test(f.name) ||
      f.type === "application/pdf" || /\.pdf$/i.test(f.name));
    const excels = arr.filter((f) => /\.(xlsx?|xlsm|csv)$/i.test(f.name));
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

  function renderReviewSummary() {
    const generated = rows.filter((r) => r.gen).length;
    $("#batch-generated-wrap").classList.toggle("hidden", generated === 0);
    $("#batch-include-generated").checked = includeGenerated;
    const messages = [...new Set(reviewWarnings)];
    if (excludedCount) messages.push(`${excludedCount} item(ns) não importado(s) por valor, moeda ou tipo ausente/inválido.`);
    const incomplete = rows.filter((r) => r.on && (!isValidISODate(r.date) || !r.desc.trim() || !Number.isFinite(r.amount) || r.amount <= 0)).length;
    if (incomplete) messages.push(`${incomplete} item(ns) selecionado(s) precisam de data, descrição ou valor antes de salvar.`);
    if (generated) messages.push(`${generated} lançamento(s) são projeções de parcelas ou repetições, não identificados no documento. ${includeGenerated ? "Revise as projeções selecionadas." : "Só serão incluídos se você ativar a opção abaixo."}`);
    if (rows.some((r) => !r.account) && (chosenAccount == null || chosenAccount === "original")) messages.push("Cartão não identificado em alguns itens: permanecerão sem cartão, a menos que você escolha um.");
    const el = $("#batch-review-summary");
    el.textContent = messages.join(" ");
    el.classList.toggle("hidden", !messages.length);
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
    $("#batch-tbody").innerHTML = rows.map((r, i) => r.gen && !includeGenerated ? "" : `
      <tr data-i="${i}" class="${r.on ? "" : "batch-off"}${r.dup ? " batch-dup" : ""}${r.gen ? " batch-generated" : ""}">
        <td><input type="checkbox" class="batch-check" data-i="${i}" aria-label="Selecionar ${escapeHtml(r.desc || "item")}${r.gen ? " (projeção)" : ""}" ${r.on ? "checked" : ""}>${r.dup ? '<span class="dup-flag" title="Possível duplicado: já está na pasta ou repetiu entre os arquivos enviados">⚠</span>' : ""}</td>
        <td><input type="date" data-f="date" data-i="${i}" aria-label="Data de ${escapeHtml(r.desc || "item")}" value="${escapeHtml(r.date)}"></td>
        <td><div class="batch-desc-cell"><input type="text" data-f="desc" data-i="${i}" value="${escapeHtml(r.desc)}">${
          r.installment
            ? `<span class="parc-tag" title="${r.gen ? "Projeção: parcela não identificada no documento" : "Parcela vista na fatura"}">${r.gen ? "Projeção · " : ""}${escapeHtml(r.installment)}</span>`
            : (r.fixed || r.fixa)
              ? `<span class="parc-tag" title="${r.gen ? "Projeção: repetição não identificada no documento" : "Assinatura/mensalidade detectada"}">${r.gen ? "Projeção · " : ""}fixa</span>`
              : ""
        }</div>${rowReview(r).length ? `<small class="hint">${escapeHtml(rowReview(r).join(" · "))}</small>` : ""}${r.account ? `<small class="hint">${escapeHtml(r.account)}</small>` : ""}</td>
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
      totals[cur] = (totals[cur] || 0) + (r.type === "despesa" ? r.amount : -r.amount);
    });
    const total = Object.entries(totals).map(([cur, amount]) => fmtMoney(amount, cur)).join(" · ") || fmtMoney(0, "BRL");
    $("#batch-count").textContent = `${on.length} de ${rows.length} selecionadas · líquido ${total}`;
    $("#btn-batch-save").textContent = `✅ Adicionar ${on.length} transaç${on.length === 1 ? "ão" : "ões"}`;
    $("#btn-batch-save").disabled = reading || on.length === 0;
    renderReviewSummary();
  }

  // Normaliza itens vindos da IA/Excel para o formato interno
  function normalize(items) {
    return (Array.isArray(items) ? items : []).map((it) => {
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

      return { date, desc, amount, type, currency, on: true, cat, parcNum, parcTotal, fixa, review,
        account: typeof it.account === "string" ? it.account.trim().slice(0, 80) : "",
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
          out.push({ ...r, serie, date: shiftMonths(r.date, k - r.parcNum), installment: `${k}/${r.parcTotal}`, gen, on: gen ? includeGenerated : r.on, monthOffset: k - r.parcNum });
        }
      } else if (r.fixa) {
        const serie = `s${srcSeq}_${idx}`;
        for (let i = 0; i < 12; i++) {
          out.push({ ...r, serie, date: shiftMonths(r.date, i), fixed: true, gen: i > 0, on: i > 0 ? includeGenerated : r.on, monthOffset: i });
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
    const normalized = normalize(itens).map((r) => ({ ...r, account: card }));
    const novos = expandSeries(normalized);
    if (novos.length) {
      const src = srcSeq++;
      novos.forEach((r) => { r.src = src; });
      rows.push(...novos);
    }
    return normalized.length;
  }

  /* ---------- Proteção anti-duplicados ----------
     Uma fatura enviada duas vezes (ou prints com sobreposição) fazia cada
     gasto entrar em dobro. Aqui NADA é apagado — linhas suspeitas só vêm
     DESMARCADAS, com aviso, e você marca de volta se forem compras reais.
     Duas checagens:
     1) Entre arquivos: para cada chave (data+descrição+valor+tipo), a lista
        mantém no máximo o MAIOR nº de ocorrências visto num arquivo SÓ.
        Assim "3× ELEVENLABS no mesmo dia" num arquivo continua válido, mas o
        mesmo trio vindo de novo em outro print é desmarcado.
     2) Contra a pasta: o que já existe lá (mesma chave) vem desmarcado —
        cobre o caso de importar a mesma fatura de novo. */
  function flagDuplicates() {
    // Parceladas e fixas usam chave de SÉRIE (sem data): a mesma compra
    // parcelada vista na fatura do mês seguinte ("X 4/12") bate com a parcela
    // 4/12 já criada antes — mesmo que os dias não coincidam.
    const serieKeyOf = (r) => {
      const suffix = `|${normCur(r.currency)}|${Number(r.amount).toFixed(curFrac(r.currency))}`;
      return r.installment ? `p|${stripAccents(r.desc)}|${r.type}|${r.installment}${suffix}`
        : (r.fixed || r.fixa) ? `f|${stripAccents(r.desc)}|${r.type}|${(r.date || "").slice(0, 7)}${suffix}`
          : null;
    };
    const keyOf = (r) => `${dupTxKey(r.date, r.desc, r.amount, r.type)}|${normCur(r.currency)}`;

    const perFile = {}; // chave -> { src: quantas vezes naquele arquivo }
    rows.forEach((r) => {
      if (serieKeyOf(r)) return; // séries têm checagem própria acima
      const k = keyOf(r);
      const bySrc = (perFile[k] = perFile[k] || {});
      bySrc[r.src || 0] = (bySrc[r.src || 0] || 0) + 1;
    });
    const allowed = {};
    for (const k in perFile) allowed[k] = Math.max(...Object.values(perFile[k]));

    const existing = Dashboard.existingTxKeys();
    const existingSeries = Dashboard.existingSeriesKeys();
    const seenSeries = new Set();
    const seen = {};
    let flagged = 0;
    // Um lançamento realmente visto tem prioridade sobre uma projeção da
    // mesma parcela criada ao ler outro documento.
    [...rows].sort((a, b) => Number(!!a.gen) - Number(!!b.gen)).forEach((r) => {
      const sk = serieKeyOf(r);
      if (sk) {
        const isDup = existingSeries.has(sk) || seenSeries.has(sk);
        seenSeries.add(sk);
        if (isDup && !r.dup && (!r.gen || includeGenerated)) flagged++;
        r.dup = isDup;
        if (isDup && !r.selectionTouched) r.on = false;
        return;
      }
      const k = keyOf(r);
      seen[k] = (seen[k] || 0) + 1;
      const isDup = existing.has(k) || seen[k] > allowed[k];
      if (isDup && !r.dup) flagged++;
      r.dup = isDup;
      if (isDup && !r.selectionTouched) r.on = false;
    });
    return flagged;
  }

  // Mensagem de sucesso do acúmulo (menciona o total quando já havia itens)
  function statusAcumulo(added) {
    if (!added) return;
    const observed = rows.filter((r) => !r.gen).length;
    const extra = observed !== added ? ` (total identificado: ${observed})` : "";
    setStatus(`${added} itens reconhecidos${extra} — confira e ajuste abaixo ✔`, "ok");
  }

  /* ---------- Origem: FOTO(s)/PDF(s) — fatura/planilha via IA no servidor ----------
     Aceita várias imagens/PDFs de uma vez (ex: 4 prints da fatura); lê em
     sequência e ACUMULA tudo numa lista só, para um único OK. */
  async function fromPhotos(files, version = generation) {
    if (!proxyAvailable()) {
      setStatus("Leitura de foto/PDF funciona no endereço da nuvem (Vercel). Para uso local, use o Arquivo Excel.", "err");
      return;
    }
    const token = (typeof Cloud !== "undefined" && Cloud.getToken) ? Cloud.getToken() : null;
    if (!token) { setStatus("Entre na sua conta (seção nuvem) para usar a leitura por foto/PDF.", "err"); return; }

    let added = 0;
    let falhas = [];
    for (let i = 0; i < files.length; i++) {
      if (version !== generation) return;
      setStatus(files.length > 1
        ? `Lendo arquivo ${i + 1} de ${files.length}… 🔎`
        : "Lendo o arquivo… isso pode levar alguns segundos 🔎");
      let image;
      try { image = await Receipt.prepareFile(files[i]); }
      catch (e) {
        if (version !== generation) return;
        falhas.push(e && e.message === "pdf_grande"
          ? `"${files[i].name}" é um PDF grande demais (máx. 3 MB)`
          : `arquivo ${i + 1} ilegível`);
        continue;
      }
      if (version !== generation) return;

      const postPhoto = () => fetch(PROXY_PATH, {
        signal: AbortSignal.timeout(65000),
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + token },
        body: JSON.stringify({
          image: { media_type: image.mediaType, data: image.data },
          multi: true,
          categories: Dashboard.getCats(), // a IA escolhe a categoria por item
          cards: CARDS,                    // e identifica de qual cartão é a fatura
        }),
      });
      try {
        let res = await postPhoto();
        if (version !== generation) return;
        let data = await res.json().catch(() => ({}));
        if (version !== generation) return;
        if (data.error === "auth_indisponivel") {
          setStatus("Não foi possível verificar sua sessão agora. Tente novamente mais tarde; seus dados continuam salvos.", "err");
          renderIfAny(added); return;
        }
        // 504/502 = a leitura demorou demais nesta imagem (fatura densa).
        // Espera um instante e tenta ela de novo antes de dar como falha.
        if (res.status === 504 || res.status === 502) {
          setStatus(`O arquivo ${i + 1} demorou mais que o normal — tentando de novo… ⏳`);
          await new Promise((r) => setTimeout(r, 2500));
          if (version !== generation) return;
          res = await postPhoto();
          if (version !== generation) return;
          data = await res.json().catch(() => ({}));
          if (version !== generation) return;
        }
        // Erros de conta/servidor interrompem tudo (repetir não resolveria)
        if (res.status === 401) { setStatus("Sua sessão expirou. Entre novamente na seção nuvem.", "err"); renderIfAny(added); return; }
        if (res.status === 503) { setStatus("A IA está sobrecarregada agora (pico de uso do Google). Aguarde alguns segundos e clique de novo.", "err"); renderIfAny(added); return; }
        if (res.status === 429) { setStatus("Limite de leituras atingido — aguarde um minuto e tente as imagens restantes.", "err"); renderIfAny(added); return; }
        if (res.status === 501) { setStatus("A leitura por IA ainda não foi ativada no servidor.", "err"); renderIfAny(added); return; }
        if (res.status === 504) {
          falhas.push(`arquivo ${i + 1} demorou demais mesmo repetindo — se for uma fatura muito longa, envie-a em 2 pedaços (topo e fim)`);
          continue;
        }
        if (!res.ok) {
          const detail = data?.detail || data?.error || "";
          falhas.push(`arquivo ${i + 1} falhou (${res.status}${detail ? " — " + detail : ""})`);
          continue;
        }
        if (data.partial) falhas.push(`arquivo ${i + 1} foi lido parcialmente; confira se faltam linhas e envie o restante`);
        if (data.error === "refusal") { falhas.push(`arquivo ${i + 1} não pôde ser lido`); continue; }
        const novosN = ingestAiResult(data.itens, data.cartao, data);
        if (!novosN) { falhas.push(`arquivo ${i + 1} sem itens reconhecidos`); continue; }
        added += novosN;
      } catch (e) {
        if (version !== generation) return;
        console.error(e);
        setStatus("Sem conexão — tente de novo.", "err");
        renderIfAny(added);
        return;
      }
    }
    if (version !== generation) return;
    reviewWarnings.push(...falhas);
    const flagged = flagDuplicates();
    if (added) {
      statusAcumulo(added);
      if (falhas.length || reviewWarnings.length || excludedCount) setStatus(`${added} itens lidos com avisos. Confira a revisão abaixo antes de adicionar.`, "warn");
      if (flagged) setStatus(`${added} itens lidos — ⚠ ${flagged} desmarcado(s) por parecerem duplicados. Se forem compras reais, marque-os de volta.${falhas.length ? " Atenção: " + falhas.join("; ") + "." : ""}`, "warn");
    } else {
      setStatus(falhas.length ? `Nada reconhecido: ${falhas.join("; ")}.` : "Não reconheci itens nesses arquivos. Tente fotos mais nítidas ou outro PDF.", "err");
    }
    renderPreview();
  }

  function renderIfAny(added) {
    if (added) { flagDuplicates(); renderPreview(); }
  }

  /* ---------- Origem: ARQUIVO(s) EXCEL (local, offline) ---------- */
  async function fromFiles(files, version = generation) {
    let added = 0;
    let falhas = [];
    for (const file of files) {
      if (version !== generation) return;
      if (file.size > 30 * 1024 * 1024) { falhas.push(`"${file.name}" grande demais (máx. 30 MB)`); continue; }
      setStatus(files.length > 1 ? `Lendo "${file.name}"…` : "Lendo a planilha…");
      try {
        const txs = await Importer.readForBatch(file);
        if (version !== generation) return;
        const novos = normalize(txs);
        if (!novos.length) { falhas.push(`"${file.name}" sem transações reconhecidas`); continue; }
        const src = srcSeq++;
        novos.forEach((r) => { r.src = src; });
        rows.push(...novos);
        added += novos.length;
        reviewWarnings.push("Confira a moeda sugerida pela planilha. O seletor do lote permite corrigi-la antes de salvar.");
      } catch (e) {
        if (version !== generation) return;
        console.error(e);
        falhas.push(`"${file.name}" inválido`);
      }
    }
    reviewWarnings.push(...falhas);
    const flagged = flagDuplicates();
    if (added) {
      statusAcumulo(added);
      if (falhas.length || excludedCount) setStatus(`${added} itens lidos com avisos. Confira a revisão abaixo antes de adicionar.`, "warn");
      if (flagged) setStatus(`${added} itens lidos — ⚠ ${flagged} desmarcado(s) por parecerem duplicados (já estão na pasta ou repetiram entre os arquivos). Se forem compras reais, marque-os de volta.`, "warn");
    } else {
      setStatus(falhas.length ? `Nada lido: ${falhas.join("; ")}.` : "Não reconheci transações. Confira o formato (Data, Descrição, Valor).", "err");
    }
    renderPreview();
  }

  function save() {
    if (reading) { toast("Aguarde a leitura terminar antes de adicionar."); return; }
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
    }));
    const n = Dashboard.appendImported(txs);
    close();
    toast(`${n} transaç${n === 1 ? "ão adicionada" : "ões adicionadas"} ✔`);
  }

  /* ---------- Eventos ---------- */
  document.addEventListener("DOMContentLoaded", () => {
    $("#btn-batch-photo").addEventListener("click", () => $("#batch-input-photo").click());
    $("#btn-batch-file").addEventListener("click", () => $("#batch-input-file").click());
    $("#batch-input-photo").addEventListener("change", (ev) => {
      const fs = Array.from(ev.target.files || []).slice(0, 15);
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
      if (!presetCat) {
        close();
        Importer.handleFile(fs[0], { addToCurrent: true });
        return;
      }
      runImport(fromFiles, fs.slice(0, 15));
    });
    $("#btn-batch-cancel").addEventListener("click", close);
    $("#btn-batch-save").addEventListener("click", save);
    // Trocar a moeda do lote reformata os valores das linhas e o total
    $("#batch-cur").addEventListener("change", renderPreview);
    // Trocar a categoria geral aplica a TODAS as linhas (elas voltam a segui-la)
    $("#batch-cat").addEventListener("change", () => { rows.forEach((r) => { r.cat = null; }); renderPreview(); });
    // Cartão escolhido à mão prevalece sobre o detectado pela IA
    $("#batch-acc").addEventListener("change", () => { chosenAccount = $("#batch-acc").value; renderReviewSummary(); });
    $("#batch-include-generated").addEventListener("change", () => {
      includeGenerated = $("#batch-include-generated").checked;
      flagDuplicates();
      rows.forEach((r) => {
        if (r.gen) { r.on = includeGenerated && !r.dup; r.selectionTouched = false; }
      });
      renderPreview();
    });

    // Edição inline da lista
    const tbody = $("#batch-tbody");
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
      if (el.dataset.f === "date") { renderPreview(); return; }
      if (!el.classList.contains("batch-check")) return;
      const i = Number(el.dataset.i);
      if (isNaN(i) || !rows[i]) return;
      rows[i].on = el.checked;
      rows[i].selectionTouched = true;
      el.closest("tr").classList.toggle("batch-off", !el.checked);
      updateCount();
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
