/* ===== Finanças YG — importação em lote (fatura/planilha/Excel) =====
   Lê uma foto de fatura/planilha (via IA no servidor seguro) ou um arquivo
   Excel (local), extrai TODAS as transações e mostra uma lista para o usuário
   conferir e dar um OK — que lança tudo de uma vez na categoria escolhida. */
"use strict";

const Batch = (() => {
  const PROXY_PATH = "/api/receipt";
  let rows = [];          // [{ date, desc, amount, type, currency, on, src, dup }]
  let presetCat = null;   // categoria destino sugerida (ex: amigo)
  let srcSeq = 0;         // nº do arquivo de origem de cada linha (p/ detectar sobreposição)

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
    opts = opts || {};
    presetCat = opts.category || null;
    rows = [];
    srcSeq = 0;
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
    $("#modal-batch").classList.add("hidden");
    rows = [];
  }

  // Botão "Upload do comprovante": abre a lista e processa os arquivos escolhidos
  // (fotos, PDFs e/ou Excel) no mesmo fluxo — serve para um gasto só ou para lote.
  async function openWithFiles(files) {
    open({ title: "Upload do comprovante", hideSources: true });
    const arr = Array.from(files || []).slice(0, 15);
    // Fotos e PDFs vão juntos para a IA; Excel é lido localmente
    const aiFiles = arr.filter((f) =>
      /^image\//.test(f.type) || /\.(png|jpe?g|webp|gif)$/i.test(f.name) ||
      f.type === "application/pdf" || /\.pdf$/i.test(f.name));
    const excels = arr.filter((f) => /\.(xlsx|xls)$/i.test(f.name));
    if (!aiFiles.length && !excels.length) { setStatus("Envie uma foto ou PDF (comprovante/fatura) ou um arquivo Excel.", "err"); return; }
    if (excels.length) await fromFiles(excels);
    if (aiFiles.length) await fromPhotos(aiFiles);
  }

  /* ---------- Renderização da lista para conferência ---------- */
  function renderPreview() {
    const cats = Dashboard.getCats();
    const sel = $("#batch-cat");
    const escolhaAtual = sel.value; // preserva a escolha do usuário entre leituras
    sel.innerHTML = cats.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
    if (escolhaAtual && cats.includes(escolhaAtual)) sel.value = escolhaAtual;
    else if (presetCat && cats.some((c) => stripAccents(c) === stripAccents(presetCat))) sel.value = presetCat;

    // Moeda destino: padrão = a moeda mais comum detectada pela IA (preserva escolha)
    const curSel = $("#batch-cur");
    const curPrev = curSel.value;
    curSel.innerHTML = CURRENCY_CODES.map((c) => `<option value="${c}">${escapeHtml(CURRENCIES[c].name)} (${escapeHtml(CURRENCIES[c].symbol)})</option>`).join("");
    curSel.value = (curPrev && CURRENCY_CODES.includes(curPrev)) ? curPrev : majorityCurrency();

    if (!rows.length) {
      $("#batch-preview").classList.remove("hidden");
      $("#btn-batch-save").classList.add("hidden");
      $("#batch-tbody").innerHTML = `<tr><td colspan="5" class="empty-table">Nada reconhecido nesta imagem/arquivo. Tente uma foto mais nítida ou outro arquivo.</td></tr>`;
      $("#batch-count").textContent = "";
      return;
    }

    const cur = normCur($("#batch-cur").value);
    $("#batch-tbody").innerHTML = rows.map((r, i) => `
      <tr data-i="${i}" class="${r.on ? "" : "batch-off"}${r.dup ? " batch-dup" : ""}">
        <td><input type="checkbox" class="batch-check" data-i="${i}" ${r.on ? "checked" : ""}>${r.dup ? '<span class="dup-flag" title="Possível duplicado: já está na pasta ou repetiu entre os arquivos enviados">⚠</span>' : ""}</td>
        <td><input type="date" data-f="date" data-i="${i}" value="${escapeHtml(r.date)}"></td>
        <td><input type="text" data-f="desc" data-i="${i}" value="${escapeHtml(r.desc)}"></td>
        <td class="num"><input type="text" class="batch-val" data-f="amount" data-i="${i}" data-cur="${cur}" value="${fmtMoneyInput(r.amount, cur)}"></td>
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
    const total = on.reduce((s, r) => s + (r.type === "despesa" ? r.amount : -r.amount), 0);
    const cur = normCur($("#batch-cur").value);
    $("#batch-count").textContent = `${on.length} de ${rows.length} selecionadas · líquido ${fmtMoney(total, cur)}`;
    $("#btn-batch-save").textContent = `✅ Adicionar ${on.length} transaç${on.length === 1 ? "ão" : "ões"}`;
    $("#btn-batch-save").disabled = on.length === 0;
  }

  // Normaliza itens vindos da IA/Excel para o formato interno
  function normalize(items) {
    const cur = new Date().getFullYear();
    return (items || []).map((it) => {
      // A IA devolve o campo como "data" (pt); o Excel devolve "date". Aceita os dois.
      let date = typeof it.date === "string" ? it.date : (typeof it.data === "string" ? it.data : "");
      if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        const y = Number(date.slice(0, 4));
        if (y < 2000 || y > cur + 1) date = cur + date.slice(4); // conserta ano implausível
      }
      // Data real da IA -> usada exatamente; sem data -> mês em vista (via Dashboard)
      date = Dashboard.resolveImportDate(date);
      const amount = Math.abs(Number(it.amount ?? it.valor) || 0);
      const type = (it.type === "receita" || it.tipo === "receita") ? "receita" : "despesa";
      return { date, desc: String(it.desc ?? it.descricao ?? "").slice(0, 120), amount, type, currency: normCur(it.moeda ?? it.currency), on: amount > 0 };
    }).filter((r) => r.amount > 0);
  }

  // Moeda mais frequente entre as linhas lidas (default p/ o seletor)
  function majorityCurrency() {
    const count = {};
    rows.forEach((r) => { const c = normCur(r.currency); count[c] = (count[c] || 0) + 1; });
    return Object.keys(count).sort((a, b) => count[b] - count[a])[0] || "BRL";
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
    const perFile = {}; // chave -> { src: quantas vezes naquele arquivo }
    rows.forEach((r) => {
      const k = dupTxKey(r.date, r.desc, r.amount, r.type);
      const bySrc = (perFile[k] = perFile[k] || {});
      bySrc[r.src || 0] = (bySrc[r.src || 0] || 0) + 1;
    });
    const allowed = {};
    for (const k in perFile) allowed[k] = Math.max(...Object.values(perFile[k]));

    const existing = Dashboard.existingTxKeys();
    const seen = {};
    let flagged = 0;
    rows.forEach((r) => {
      const k = dupTxKey(r.date, r.desc, r.amount, r.type);
      seen[k] = (seen[k] || 0) + 1;
      if (r.dupHandled) return; // decisão do usuário em leituras anteriores é respeitada
      r.dupHandled = true;
      if (existing.has(k) || seen[k] > allowed[k]) {
        r.dup = true;
        r.on = false;
        flagged++;
      }
    });
    return flagged;
  }

  // Mensagem de sucesso do acúmulo (menciona o total quando já havia itens)
  function statusAcumulo(added) {
    if (!added) return;
    const extra = rows.length !== added ? ` (total na lista: ${rows.length})` : "";
    setStatus(`${added} itens reconhecidos${extra} — confira e ajuste abaixo ✔`, "ok");
  }

  /* ---------- Origem: FOTO(s)/PDF(s) — fatura/planilha via IA no servidor ----------
     Aceita várias imagens/PDFs de uma vez (ex: 4 prints da fatura); lê em
     sequência e ACUMULA tudo numa lista só, para um único OK. */
  async function fromPhotos(files) {
    if (!proxyAvailable()) {
      setStatus("Leitura de foto/PDF funciona no endereço da nuvem (Vercel). Para uso local, use o Arquivo Excel.", "err");
      return;
    }
    const token = (typeof Cloud !== "undefined" && Cloud.getToken) ? Cloud.getToken() : null;
    if (!token) { setStatus("Entre na sua conta (seção nuvem) para usar a leitura por foto/PDF.", "err"); return; }

    let added = 0;
    let falhas = [];
    for (let i = 0; i < files.length; i++) {
      setStatus(files.length > 1
        ? `Lendo arquivo ${i + 1} de ${files.length}… 🔎`
        : "Lendo o arquivo… isso pode levar alguns segundos 🔎");
      let image;
      try { image = await Receipt.prepareFile(files[i]); }
      catch (e) {
        falhas.push(e && e.message === "pdf_grande"
          ? `"${files[i].name}" é um PDF grande demais (máx. 3 MB)`
          : `arquivo ${i + 1} ilegível`);
        continue;
      }

      const postPhoto = () => fetch(PROXY_PATH, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + token },
        body: JSON.stringify({ image: { media_type: image.mediaType, data: image.data }, multi: true }),
      });
      try {
        let res = await postPhoto();
        // 504/502 = a leitura demorou demais nesta imagem (fatura densa).
        // Espera um instante e tenta ela de novo antes de dar como falha.
        if (res.status === 504 || res.status === 502) {
          setStatus(`O arquivo ${i + 1} demorou mais que o normal — tentando de novo… ⏳`);
          await new Promise((r) => setTimeout(r, 2500));
          res = await postPhoto();
        }
        // Erros de conta/servidor interrompem tudo (repetir não resolveria)
        if (res.status === 401) { setStatus("Sua sessão expirou. Entre novamente na seção nuvem.", "err"); renderIfAny(added); return; }
        if (res.status === 503) { setStatus("A IA está sobrecarregada agora (pico de uso do Google). Aguarde alguns segundos e clique de novo.", "err"); renderIfAny(added); return; }
        if (res.status === 429) { setStatus("Limite de leituras atingido — aguarde um minuto e tente as imagens restantes.", "err"); renderIfAny(added); return; }
        if (res.status === 501) { setStatus("A leitura por IA ainda não foi ativada no servidor.", "err"); return; }
        if (res.status === 504) {
          falhas.push(`arquivo ${i + 1} demorou demais mesmo repetindo — se for uma fatura muito longa, envie-a em 2 pedaços (topo e fim)`);
          continue;
        }
        if (!res.ok) {
          let detail = "";
          try { const j = await res.json(); detail = j?.detail || j?.error || ""; } catch { /* sem corpo */ }
          falhas.push(`arquivo ${i + 1} falhou (${res.status}${detail ? " — " + detail : ""})`);
          continue;
        }
        const data = await res.json();
        if (data.error === "refusal") { falhas.push(`arquivo ${i + 1} não pôde ser lido`); continue; }
        const novos = normalize(data.itens);
        if (!novos.length) { falhas.push(`arquivo ${i + 1} sem itens reconhecidos`); continue; }
        const src = srcSeq++;
        novos.forEach((r) => { r.src = src; });
        rows.push(...novos);
        added += novos.length;
      } catch (e) {
        console.error(e);
        setStatus("Sem conexão — tente de novo.", "err");
        renderIfAny(added);
        return;
      }
    }
    const flagged = flagDuplicates();
    if (added) {
      statusAcumulo(added);
      if (falhas.length) setStatus(`${added} itens lidos, mas: ${falhas.join("; ")}. Confira abaixo ✔`, "ok");
      if (flagged) setStatus(`${added} itens lidos — ⚠ ${flagged} desmarcado(s) por parecerem duplicados (já estão na pasta ou repetiram entre os arquivos). Se forem compras reais, marque-os de volta.`, "warn");
    } else {
      setStatus(falhas.length ? `Nada reconhecido: ${falhas.join("; ")}.` : "Não reconheci itens nesses arquivos. Tente fotos mais nítidas ou outro PDF.", "err");
    }
    renderPreview();
  }

  function renderIfAny(added) {
    if (added) renderPreview();
  }

  /* ---------- Origem: ARQUIVO(s) EXCEL (local, offline) ---------- */
  async function fromFiles(files) {
    let added = 0;
    let falhas = [];
    for (const file of files) {
      if (file.size > 30 * 1024 * 1024) { falhas.push(`"${file.name}" grande demais (máx. 30 MB)`); continue; }
      setStatus(files.length > 1 ? `Lendo "${file.name}"…` : "Lendo a planilha…");
      try {
        const txs = await Importer.readForBatch(file);
        const novos = normalize(txs.map((t) => ({ date: t.date, desc: t.desc, amount: t.amount, type: t.type })));
        if (!novos.length) { falhas.push(`"${file.name}" sem transações reconhecidas`); continue; }
        const src = srcSeq++;
        novos.forEach((r) => { r.src = src; });
        rows.push(...novos);
        added += novos.length;
      } catch (e) {
        console.error(e);
        falhas.push(`"${file.name}" inválido`);
      }
    }
    const flagged = flagDuplicates();
    if (added) {
      statusAcumulo(added);
      if (falhas.length) setStatus(`${added} itens lidos, mas: ${falhas.join("; ")}. Confira abaixo ✔`, "ok");
      if (flagged) setStatus(`${added} itens lidos — ⚠ ${flagged} desmarcado(s) por parecerem duplicados (já estão na pasta ou repetiram entre os arquivos). Se forem compras reais, marque-os de volta.`, "warn");
    } else {
      setStatus(falhas.length ? `Nada lido: ${falhas.join("; ")}.` : "Não reconheci transações. Confira o formato (Data, Descrição, Valor).", "err");
    }
    renderPreview();
  }

  function save() {
    const category = $("#batch-cat").value;
    const currency = normCur($("#batch-cur").value);
    const items = rows.filter((r) => r.on).map((r) => ({
      date: r.date, desc: r.desc, amount: r.amount, type: r.type, category, currency,
    }));
    if (!items.length) { toast("Selecione pelo menos um item ✔"); return; }
    const n = Dashboard.addBulk(items);
    close();
    toast(`${n} transaç${n === 1 ? "ão adicionada" : "ões adicionadas"} em "${category}" ✔`);
  }

  /* ---------- Eventos ---------- */
  document.addEventListener("DOMContentLoaded", () => {
    $("#btn-batch-photo").addEventListener("click", () => $("#batch-input-photo").click());
    $("#btn-batch-file").addEventListener("click", () => $("#batch-input-file").click());
    $("#batch-input-photo").addEventListener("change", (ev) => {
      const fs = Array.from(ev.target.files || []).slice(0, 15);
      if (fs.length) fromPhotos(fs);
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
      fromFiles(fs.slice(0, 15));
    });
    $("#btn-batch-cancel").addEventListener("click", close);
    $("#btn-batch-save").addEventListener("click", save);
    // Trocar a moeda do lote reformata os valores das linhas e o total
    $("#batch-cur").addEventListener("change", renderPreview);

    // Edição inline da lista
    const tbody = $("#batch-tbody");
    tbody.addEventListener("input", (ev) => {
      const el = ev.target;
      const i = Number(el.dataset.i);
      if (isNaN(i) || !rows[i]) return;
      const f = el.dataset.f;
      if (f === "date") rows[i].date = el.value;
      else if (f === "desc") rows[i].desc = el.value;
      else if (f === "amount") { maskMoneyEl(el); rows[i].amount = Math.abs(moneyInputValue(el) || 0); }
      else if (f === "type") rows[i].type = el.value === "receita" ? "receita" : "despesa";
      if (f === "amount" || f === "type") updateCount();
    });
    tbody.addEventListener("change", (ev) => {
      const el = ev.target;
      if (!el.classList.contains("batch-check")) return;
      const i = Number(el.dataset.i);
      if (isNaN(i) || !rows[i]) return;
      rows[i].on = el.checked;
      el.closest("tr").classList.toggle("batch-off", !el.checked);
      updateCount();
    });
  });

  return { open, openWithFiles };
})();
