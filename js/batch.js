/* ===== Finanças YG — importação em lote (fatura/planilha/Excel) =====
   Lê uma foto de fatura/planilha (via IA no servidor seguro) ou um arquivo
   Excel (local), extrai TODAS as transações e mostra uma lista para o usuário
   conferir e dar um OK — que lança tudo de uma vez na categoria escolhida. */
"use strict";

const Batch = (() => {
  const PROXY_PATH = "/api/receipt";
  let rows = [];          // [{ date, desc, amount, type, on }]
  let presetCat = null;   // categoria destino sugerida (ex: amigo)

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
    $("#batch-title").textContent = opts.title || "Importar em lote";
    $("#batch-preview").classList.add("hidden");
    $("#btn-batch-save").classList.add("hidden");
    setStatus("");
    $("#modal-batch").classList.remove("hidden");
  }

  function close() {
    $("#modal-batch").classList.add("hidden");
    rows = [];
  }

  /* ---------- Renderização da lista para conferência ---------- */
  function renderPreview() {
    const cats = Dashboard.getCats();
    const sel = $("#batch-cat");
    sel.innerHTML = cats.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
    if (presetCat && cats.some((c) => stripAccents(c) === stripAccents(presetCat))) sel.value = presetCat;

    if (!rows.length) {
      $("#batch-preview").classList.remove("hidden");
      $("#btn-batch-save").classList.add("hidden");
      $("#batch-tbody").innerHTML = `<tr><td colspan="5" class="empty-table">Nada reconhecido nesta imagem/arquivo. Tente uma foto mais nítida ou outro arquivo.</td></tr>`;
      $("#batch-count").textContent = "";
      return;
    }

    $("#batch-tbody").innerHTML = rows.map((r, i) => `
      <tr data-i="${i}" class="${r.on ? "" : "batch-off"}">
        <td><input type="checkbox" class="batch-check" data-i="${i}" ${r.on ? "checked" : ""}></td>
        <td><input type="date" data-f="date" data-i="${i}" value="${escapeHtml(r.date)}"></td>
        <td><input type="text" data-f="desc" data-i="${i}" value="${escapeHtml(r.desc)}"></td>
        <td class="num"><input type="text" class="batch-val" data-f="amount" data-i="${i}" value="${r.amount.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}"></td>
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
    $("#batch-count").textContent = `${on.length} de ${rows.length} selecionadas · líquido ${fmtBRL(total)}`;
    $("#btn-batch-save").textContent = `✅ Adicionar ${on.length} transaç${on.length === 1 ? "ão" : "ões"}`;
    $("#btn-batch-save").disabled = on.length === 0;
  }

  // Normaliza itens vindos da IA/Excel para o formato interno
  function normalize(items) {
    const cur = new Date().getFullYear();
    return (items || []).map((it) => {
      let date = typeof it.date === "string" ? it.date : "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) date = todayISO();
      const y = Number(date.slice(0, 4));
      if (y < 2000 || y > cur + 1) date = cur + date.slice(4); // conserta ano implausível
      const amount = Math.abs(Number(it.amount ?? it.valor) || 0);
      const type = (it.type === "receita" || it.tipo === "receita") ? "receita" : "despesa";
      return { date, desc: String(it.desc ?? it.descricao ?? "").slice(0, 120), amount, type, on: amount > 0 };
    }).filter((r) => r.amount > 0);
  }

  /* ---------- Origem: FOTO (IA no servidor) ---------- */
  async function fromPhoto(file) {
    if (!proxyAvailable()) {
      setStatus("Leitura de foto funciona no endereço da nuvem (Vercel). Para uso local, use o Arquivo Excel.", "err");
      return;
    }
    const token = (typeof Cloud !== "undefined" && Cloud.getToken) ? Cloud.getToken() : null;
    if (!token) { setStatus("Entre na sua conta (seção nuvem) para usar a leitura por foto.", "err"); return; }

    setStatus("Lendo a imagem… isso pode levar alguns segundos 🔎");
    let image;
    try { image = await Receipt.prepareImage(file); }
    catch { setStatus("Não consegui abrir essa imagem 😕", "err"); return; }

    try {
      const res = await fetch(PROXY_PATH, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + token },
        body: JSON.stringify({ image: { media_type: image.mediaType, data: image.data }, multi: true }),
      });
      if (res.status === 401) { setStatus("Sua sessão expirou. Entre novamente na seção nuvem.", "err"); return; }
      if (res.status === 429) { setStatus("Muitas leituras em sequência — aguarde um minuto e tente de novo.", "err"); return; }
      if (res.status === 501) { setStatus("A leitura por IA ainda não foi ativada no servidor.", "err"); return; }
      if (!res.ok) {
        let detail = "";
        try { const j = await res.json(); detail = j?.detail || j?.error || ""; } catch { /* sem corpo */ }
        setStatus(`A leitura falhou (erro ${res.status}${detail ? " — " + detail : ""}).`, "err");
        return;
      }
      const data = await res.json();
      if (data.error === "refusal") { setStatus("A IA não conseguiu ler esta imagem. Tente uma foto mais nítida.", "err"); return; }
      rows = normalize(data.itens);
      setStatus(rows.length ? `${rows.length} itens reconhecidos — confira e ajuste abaixo ✔` : "", rows.length ? "ok" : "err");
      if (!rows.length) setStatus("Não reconheci itens nessa imagem. Tente uma foto mais nítida.", "err");
      renderPreview();
    } catch (e) {
      console.error(e);
      setStatus("Sem conexão — tente de novo.", "err");
    }
  }

  /* ---------- Origem: ARQUIVO EXCEL (local, offline) ---------- */
  async function fromFile(file) {
    if (file.size > 30 * 1024 * 1024) { setStatus("Arquivo grande demais (máx. 30 MB).", "err"); return; }
    setStatus("Lendo a planilha…");
    try {
      const txs = await Importer.readForBatch(file);
      rows = normalize(txs.map((t) => ({ date: t.date, desc: t.desc, amount: t.amount, type: t.type })));
      if (!rows.length) { setStatus("Não reconheci transações nessa planilha. Confira o formato (Data, Descrição, Valor).", "err"); renderPreview(); return; }
      setStatus(`${rows.length} itens lidos — confira e ajuste abaixo ✔`, "ok");
      renderPreview();
    } catch (e) {
      console.error(e);
      setStatus("Não consegui ler esse arquivo. Confira se é um .xlsx válido.", "err");
    }
  }

  function save() {
    const category = $("#batch-cat").value;
    const items = rows.filter((r) => r.on).map((r) => ({
      date: r.date, desc: r.desc, amount: r.amount, type: r.type, category,
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
    $("#batch-input-photo").addEventListener("change", (ev) => { const f = ev.target.files[0]; if (f) fromPhoto(f); ev.target.value = ""; });
    $("#batch-input-file").addEventListener("change", (ev) => { const f = ev.target.files[0]; if (f) fromFile(f); ev.target.value = ""; });
    $("#btn-batch-cancel").addEventListener("click", close);
    $("#btn-batch-save").addEventListener("click", save);

    // Edição inline da lista
    const tbody = $("#batch-tbody");
    tbody.addEventListener("input", (ev) => {
      const el = ev.target;
      const i = Number(el.dataset.i);
      if (isNaN(i) || !rows[i]) return;
      const f = el.dataset.f;
      if (f === "date") rows[i].date = el.value;
      else if (f === "desc") rows[i].desc = el.value;
      else if (f === "amount") rows[i].amount = Math.abs(parseMoney(el.value) || 0);
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

  return { open };
})();
