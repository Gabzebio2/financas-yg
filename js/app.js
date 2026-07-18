/* ===== Finanças YG — núcleo: utilidades, armazenamento, navegação, home ===== */
"use strict";

// Anti-clickjacking: impede que o app rode dentro de iframe de outro site
if (window.top !== window.self) {
  try { window.top.location = window.location.href; }
  catch { window.location.replace("about:blank"); }
}

/* ---------- Utilidades ---------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/* ---------- Moedas ----------
   O app guarda em cada transação a MOEDA em que ela foi lançada e exibe o
   painel numa moeda escolhida (ds.displayCurrency). A conversão só acontece
   quando a moeda exibida é diferente da moeda da transação (ver js/rates.js). */
const CURRENCIES = {
  BRL: { code: "BRL", name: "Real brasileiro", short: "Real", locale: "pt-BR", symbol: "R$", frac: 2 },
  CLP: { code: "CLP", name: "Peso chileno", short: "Peso CL", locale: "es-CL", symbol: "$", frac: 0 },
  PYG: { code: "PYG", name: "Guarani", short: "Guarani", locale: "es-PY", symbol: "₲", frac: 0 },
  USD: { code: "USD", name: "Dólar", short: "Dólar", locale: "en-US", symbol: "US$", frac: 2 },
};
const CURRENCY_CODES = ["BRL", "CLP", "PYG", "USD"];
function normCur(code) { return CURRENCY_CODES.includes(code) ? code : "BRL"; }
function curFrac(code) { return (CURRENCIES[normCur(code)]).frac; }

// Formata um valor numérico na moeda indicada (padrão Real)
function fmtMoney(v, code) {
  code = normCur(code);
  const c = CURRENCIES[code];
  try {
    return (Number(v) || 0).toLocaleString(c.locale, { style: "currency", currency: code });
  } catch {
    return `${c.symbol} ${(Number(v) || 0).toFixed(c.frac)}`;
  }
}
const fmtBRL = (v) => fmtMoney(v, "BRL");

const MESES = ["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];
const MESES_ABREV = ["jan","fev","mar","abr","mai","jun","jul","ago","set","out","nov","dez"];

const PALETTE = ["#8b5cf6","#45c483","#f5a524","#f06a5f","#38bdf8","#2dd4bf","#f472b6","#a3e635","#fb923c","#4ade80","#818cf8","#c084fc","#facc15","#94a3b8","#0ea5e9","#e879f9"];

const DEFAULT_CATS = ["Essencial","Lazer","Viagem","Moradia","Saúde","Transporte","Salário","Outros"];

// Cartões/contas disponíveis no seletor (C6 vem pré-selecionado)
const CARDS = ["C6","Nubank Yara","Nubank Gab","Picpay","Wise","Payoneer","Lily","Inter"];

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function stripAccents(s) {
  return String(s || "").normalize("NFD").replace(new RegExp("[\\u0300-\\u036f]", "g"), "").toLowerCase().trim();
}

// Chave para detectar lançamentos repetidos: mesma data + descrição + valor +
// tipo. Usada na importação em lote para avisar sobre possíveis duplicados
// (fatura enviada duas vezes, prints com sobreposição etc.).
function dupTxKey(date, desc, amount, type) {
  return `${date}|${stripAccents(desc)}|${(Number(amount) || 0).toFixed(2)}|${type}`;
}

// 'YYYY-MM-DD' -> 'dd/mm/aaaa'
function fmtDate(iso) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

// Número -> texto de campo já formatado na moeda: 10.25 -> "R$ 10,25"
function fmtMoneyInput(n, code) {
  return fmtMoney(Number(n) || 0, code);
}

// Máscara de moeda ao vivo: os dígitos digitados formam as casas decimais da
// moeda. Em Real (2 casas) digitar 1,0,2,5 mostra R$ 0,01 ... R$ 10,25; em
// moedas sem centavos (CLP/PYG) os dígitos formam o inteiro. A moeda vem do
// atributo data-cur do input (padrão Real).
function maskMoneyEl(el, code) {
  code = normCur(code || el.dataset.cur);
  const frac = curFrac(code);
  const digits = el.value.replace(/\D/g, "").slice(0, 15);
  el.value = digits ? fmtMoney(parseInt(digits, 10) / Math.pow(10, frac), code) : "";
}

// Valor numérico a partir dos dígitos crus de um texto mascarado (independe do
// separador local — evita a fragilidade do parseMoney em es-CL/es-PY).
function moneyStrValue(str, code) {
  code = normCur(code);
  const digits = String(str || "").replace(/\D/g, "").slice(0, 15);
  if (!digits) return null;
  return parseInt(digits, 10) / Math.pow(10, curFrac(code));
}
function moneyInputValue(el, code) {
  return moneyStrValue(el ? el.value : "", normCur(code || (el && el.dataset.cur)));
}

// Define a moeda de um input mascarado e reformata o que já estiver digitado.
function setMoneyMaskCurrency(el, code) {
  if (!el) return;
  el.dataset.cur = normCur(code);
  if (el.value) maskMoneyEl(el, el.dataset.cur);
}

// Liga a máscara num input (idempotente). Retorna o próprio elemento.
function attachMoneyMask(el) {
  if (!el || el.dataset.moneyMask) return el;
  el.dataset.moneyMask = "1";
  el.setAttribute("inputmode", "decimal");
  el.addEventListener("input", () => maskMoneyEl(el));
  return el;
}

// 'YYYY-MM' -> 'set/2025'
function fmtMonth(ym) {
  const [y, m] = ym.split("-");
  return `${MESES_ABREV[Number(m) - 1]}/${y}`;
}

// 'YYYY-MM' -> 'Setembro de 2025'
function fmtMonthLong(ym) {
  const [y, m] = ym.split("-");
  const nome = MESES[Number(m) - 1];
  return `${nome.charAt(0).toUpperCase() + nome.slice(1)} de ${y}`;
}

function daysInMonth(y, m) { // m: 1-12
  return new Date(y, m, 0).getDate();
}

// "1.234,56" / "R$ 65,00" / 65 -> número
function parseMoney(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  let s = String(v).replace(/[^\d.,-]/g, "");
  if (!s) return null;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (lastComma > -1) {
    s = s.replace(/\./g, "").replace(",", ".");
  }
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}

// Data de célula do Excel (serial, Date, 'dd/mm/aaaa', 'aaaa-mm-dd') -> 'YYYY-MM-DD' | null
function parseDateCell(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date && !isNaN(v)) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  }
  if (typeof v === "number") {
    if (v < 20000 || v > 80000) return null; // fora da faixa plausível de datas
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/); // dd/mm/aaaa
  if (m) {
    let [, d, mo, y] = m;
    y = Number(y); if (y < 100) y += 2000;
    if (Number(mo) >= 1 && Number(mo) <= 12 && Number(d) >= 1 && Number(d) <= 31)
      return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/); // aaaa-mm-dd
  if (m) {
    const [, y, mo, d] = m;
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})$/); // dd/mm (sem ano) -> ano atual (comum em faturas/planilhas)
  if (m) {
    const [, d, mo] = m;
    if (Number(mo) >= 1 && Number(mo) <= 12 && Number(d) >= 1 && Number(d) <= 31) {
      return `${new Date().getFullYear()}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }
  return null;
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

let toastTimer = null;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 2600);
}

/* ---------- Armazenamento (localStorage) ---------- */
const Store = {
  loadIndex() {
    try { return JSON.parse(localStorage.getItem("fyg:index")) || []; }
    catch { return []; }
  },
  saveIndex(idx) {
    localStorage.setItem("fyg:index", JSON.stringify(idx));
  },
  loadDataset(id) {
    try { return JSON.parse(localStorage.getItem("fyg:ds:" + id)); }
    catch { return null; }
  },
  saveDataset(ds) {
    ds.updatedAt = new Date().toISOString();
    localStorage.setItem("fyg:ds:" + ds.id, JSON.stringify(ds));
    const idx = this.loadIndex();
    const e = idx.find((x) => x.id === ds.id);
    if (e) {
      e.name = ds.name; e.updatedAt = ds.updatedAt; e.txCount = ds.transactions.length;
    } else {
      idx.unshift({ id: ds.id, name: ds.name, createdAt: ds.createdAt, updatedAt: ds.updatedAt, txCount: ds.transactions.length });
    }
    this.saveIndex(idx);
    this._notify();
  },
  deleteDataset(id) {
    localStorage.removeItem("fyg:ds:" + id);
    this.saveIndex(this.loadIndex().filter((x) => x.id !== id));
    if (typeof Cloud !== "undefined" && Cloud.onLocalDelete) Cloud.onLocalDelete(id);
  },
  // Avisa a sincronização (nuvem) que houve mudança local. A camada de sync
  // só age se estiver conectada e ignora enquanto está puxando da nuvem.
  _notify() {
    if (typeof Cloud !== "undefined" && Cloud.onLocalChange) Cloud.onLocalChange();
  },
  createDataset(name) {
    const now = new Date().toISOString();
    const ds = { id: uid(), name: name || "Sem nome", createdAt: now, updatedAt: now, displayCurrency: "BRL", categories: [], transactions: [] };
    DEFAULT_CATS.forEach((c) => ensureCat(ds, c));
    return ds;
  },
};

// Garante que a categoria existe no dataset, com cor fixa
function ensureCat(ds, name) {
  name = String(name || "Outros").trim() || "Outros";
  let c = ds.categories.find((x) => stripAccents(x.name) === stripAccents(name));
  if (!c) {
    c = { name, color: PALETTE[ds.categories.length % PALETTE.length] };
    ds.categories.push(c);
  }
  return c;
}

function catColor(ds, name) {
  const c = ds.categories.find((x) => stripAccents(x.name) === stripAccents(name));
  // Só cores #hex são aceitas — impede injeção de atributo via cor vinda de backup
  return c && /^#[0-9a-fA-F]{3,8}$/.test(c.color) ? c.color : "#64748b";
}

/* ---------- Navegação entre telas ---------- */
function showScreen(id) {
  $$(".screen").forEach((s) => s.classList.add("hidden"));
  $("#" + id).classList.remove("hidden");
  $("#btn-back").classList.toggle("hidden", id === "screen-home");
  window.scrollTo(0, 0);
}

function goHome() {
  showScreen("screen-home");
  renderFolders();
}

/* ---------- Modal de nome (prompt) ---------- */
let nameCallback = null;
function askName(title, initial, cb, opts) {
  opts = opts || {};
  $("#modal-name-title").textContent = title;
  const input = $("#modal-name-input");
  // Flag "money": o listener único (ver DOMContentLoaded) mascara na moeda
  // indicada (data-cur, padrão R$) só quando ligado — o mesmo input serve para
  // renomear pastas (texto normal).
  input.dataset.money = opts.money ? "1" : "";
  input.dataset.cur = opts.money ? normCur(opts.currency) : "";
  input.value = initial || "";
  nameCallback = cb;
  $("#modal-name").classList.remove("hidden");
  setTimeout(() => { input.focus(); input.select(); }, 50);
}
function closeNameModal() {
  $("#modal-name").classList.add("hidden");
  nameCallback = null;
}

/* ---------- Modal de confirmação ---------- */
let confirmCallback = null;
function askConfirm(title, text, cb) {
  $("#modal-confirm-title").textContent = title;
  $("#modal-confirm-text").textContent = text;
  confirmCallback = cb;
  $("#modal-confirm").classList.remove("hidden");
}
function closeConfirmModal() {
  $("#modal-confirm").classList.add("hidden");
  confirmCallback = null;
}

/* ---------- Home: pastas salvas ---------- */
function renderFolders() {
  const idx = Store.loadIndex();
  const grid = $("#folders-grid");
  if (!idx.length) {
    grid.innerHTML = `<div class="empty-folders">Nenhuma pasta salva ainda.<br>Importe um Excel ou comece do zero para criar a primeira. 📂</div>`;
    return;
  }
  grid.innerHTML = idx.map((e) => `
    <div class="folder-card" data-id="${escapeHtml(e.id)}">
      <div class="folder-icon">📂</div>
      <div class="folder-info">
        <div class="folder-name" data-name>${escapeHtml(e.name)}</div>
        <div class="folder-meta">${e.txCount} transaç${e.txCount === 1 ? "ão" : "ões"} · atualizada em ${fmtDate(e.updatedAt.slice(0, 10))}</div>
      </div>
      <div class="folder-actions">
        <button class="btn-icon" data-action="rename" title="Renomear">✎</button>
        <button class="btn-icon" data-action="delete" title="Excluir">🗑</button>
      </div>
    </div>`).join("");
}

function startRenameFolder(cardEl, id) {
  const idx = Store.loadIndex();
  const entry = idx.find((x) => x.id === id);
  if (!entry) return;
  const nameEl = cardEl.querySelector("[data-name]");
  const input = document.createElement("input");
  input.className = "folder-name-input";
  input.value = entry.name;
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return; done = true;
    const newName = input.value.trim();
    if (save && newName && newName !== entry.name) {
      const ds = Store.loadDataset(id);
      if (ds) { ds.name = newName; Store.saveDataset(ds); }
      else { entry.name = newName; Store.saveIndex(idx); }
      toast("Pasta renomeada ✔");
    }
    renderFolders();
  };
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") finish(true);
    if (ev.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}

/* ---------- Sanitização de dados importados ----------
   Um backup vem de fora do app: NUNCA confiar no conteúdo. Cada campo é
   validado/coagido ao tipo esperado e todos os IDs são regenerados. */
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RE_MONTH = /^(\d{4}-\d{2}|0000-00)$/;
const RE_COLOR = /^#[0-9a-fA-F]{3,8}$/;
const RE_PARC = /^\d{1,3}\/\d{1,3}$/;

function cleanStr(v, max) {
  return typeof v === "string" ? v.slice(0, max) : "";
}
function cleanNum(v) {
  const n = Number(v);
  return isFinite(n) ? Math.abs(n) : null;
}
function cleanCats(v, fallback) {
  const list = Array.isArray(v) ? v.map((c) => cleanStr(c, 40).trim()).filter(Boolean).slice(0, 30) : [];
  return list.length ? list : (fallback || []);
}

// IDs próprios do app são base36 (a-z0-9). Ao restaurar do Drive (dados do
// próprio usuário) preservamos IDs válidos p/ não duplicar no round-trip;
// em backups importados de terceiros, sempre regeramos.
const RE_SAFE_ID = /^[a-z0-9]{6,40}$/;
function keepOrNewId(v, preserve) {
  return preserve && typeof v === "string" && RE_SAFE_ID.test(v) ? v : uid();
}
function cleanISO(v, fallback) {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) && !isNaN(Date.parse(v)) ? v : fallback;
}

function sanitizeDataset(raw, opts) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.transactions)) return null;
  const preserve = !!(opts && opts.preserveIds);
  const now = new Date().toISOString();
  const ds = {
    id: keepOrNewId(raw.id, preserve),
    name: cleanStr(raw.name, 80).trim() || "Backup importado",
    createdAt: cleanISO(raw.createdAt, now),
    updatedAt: cleanISO(raw.updatedAt, now),
    displayCurrency: normCur(raw.displayCurrency),
    categories: [],
    transactions: [],
    limits: [],
    metas: [],
  };

  // Metas: poupança (target/saved) ou cobrança vinculada a categoria
  if (Array.isArray(raw.metas)) {
    raw.metas.slice(0, 100).forEach((m) => {
      const name = cleanStr(m?.name, 60).trim();
      if (!name) return;
      const category = cleanStr(m?.category, 40).trim();
      if (category) {
        ds.metas.push({ id: keepOrNewId(m?.id, preserve), name, category });
      } else {
        const target = cleanNum(m?.target);
        if (target == null || target <= 0) return;
        ds.metas.push({ id: keepOrNewId(m?.id, preserve), name, target, saved: cleanNum(m?.saved) ?? 0, currency: normCur(m?.currency) });
      }
    });
  }

  // Categorias: nome texto puro, cor só #hex
  if (Array.isArray(raw.categories)) {
    raw.categories.slice(0, 100).forEach((c) => {
      const name = cleanStr(c?.name, 40).trim();
      if (!name || ds.categories.some((x) => stripAccents(x.name) === stripAccents(name))) return;
      ds.categories.push({
        name,
        color: RE_COLOR.test(c?.color) ? c.color : PALETTE[ds.categories.length % PALETTE.length],
      });
    });
  }

  // Transações: campos validados, IDs regenerados preservando os grupos
  const groupMap = new Map();
  const mapGroup = (g) => {
    if (typeof g !== "string" || !g) return null;
    if (preserve && RE_SAFE_ID.test(g)) return g;
    if (!groupMap.has(g)) groupMap.set(g, uid());
    return groupMap.get(g);
  };
  raw.transactions.slice(0, 100000).forEach((t) => {
    if (!t || typeof t !== "object") return;
    const date = typeof t.date === "string" && RE_DATE.test(t.date) ? t.date : null;
    const amount = cleanNum(t.amount);
    if (!date || amount == null || amount <= 0) return;
    ds.transactions.push({
      id: keepOrNewId(t.id, preserve),
      groupId: mapGroup(t.groupId),
      fixed: t.fixed === true,
      date,
      desc: cleanStr(t.desc, 120).trim() || "(sem descrição)",
      category: cleanStr(t.category, 40).trim() || "Outros",
      account: cleanStr(t.account, 40).trim(),
      type: t.type === "receita" ? "receita" : "despesa",
      amount,
      currency: normCur(t.currency),
      installment: typeof t.installment === "string" && RE_PARC.test(t.installment) ? t.installment : null,
      totalValue: cleanNum(t.totalValue),
    });
  });
  ds.transactions.forEach((t) => ensureCat(ds, t.category));

  // Limites: valores numéricos, meses no formato AAAA-MM
  if (Array.isArray(raw.limits)) {
    raw.limits.slice(0, 50).forEach((L) => {
      const cats = cleanCats(L?.categories);
      const amount = cleanNum(L?.amount);
      if (!cats.length || amount == null || amount <= 0) return;
      const versions = [];
      if (Array.isArray(L.versions)) {
        L.versions.slice(0, 200).forEach((v) => {
          const from = typeof v?.from === "string" && RE_MONTH.test(v.from) ? v.from : null;
          const vAmount = cleanNum(v?.amount);
          const vCats = cleanCats(v?.categories, cats);
          if (from && vAmount != null && vAmount > 0) versions.push({ from, amount: vAmount, categories: vCats });
        });
      }
      if (!versions.length) versions.push({ from: "0000-00", amount, categories: cats });
      versions.sort((a, b) => a.from.localeCompare(b.from));
      const last = versions[versions.length - 1];
      ds.limits.push({
        id: keepOrNewId(L?.id, preserve),
        name: cleanStr(L?.name, 60).trim() || cats.join(" + "),
        amount: last.amount,
        categories: last.categories,
        currency: normCur(L?.currency),
        versions,
      });
    });
  }
  return ds;
}

/* ---------- Sincronização: mesclar datasets vindos da nuvem ----------
   Regra: por id, vence o de updatedAt mais recente. Ids novos são adicionados.
   Retorna quantos foram criados/atualizados. */
function mergeCloudDatasets(rawList) {
  if (!Array.isArray(rawList)) return { added: 0, updated: 0 };
  let added = 0, updated = 0;
  for (const raw of rawList.slice(0, 200)) {
    const ds = sanitizeDataset(raw, { preserveIds: true });
    if (!ds) continue;
    const local = Store.loadDataset(ds.id);
    if (!local) { Store.saveDataset(ds); added++; }
    else if ((ds.updatedAt || "") > (local.updatedAt || "")) {
      Store.saveDataset(ds); updated++;
    }
  }
  return { added, updated };
}

// Monta o payload de sincronização (mesmo formato do backup)
function buildSyncPayload() {
  const idx = Store.loadIndex();
  return {
    app: "financas-yg", version: 1, exportedAt: new Date().toISOString(),
    datasets: idx.map((e) => Store.loadDataset(e.id)).filter(Boolean),
  };
}

/* ---------- Backup ---------- */
function exportBackup() {
  const idx = Store.loadIndex();
  if (!idx.length) { toast("Nada para exportar ainda."); return; }
  const data = {
    app: "financas-yg", version: 1, exportedAt: new Date().toISOString(),
    datasets: idx.map((e) => Store.loadDataset(e.id)).filter(Boolean),
  };
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `financas-yg-backup-${todayISO()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast("Backup exportado ✔");
}

function importBackup(file) {
  if (file.size > 20 * 1024 * 1024) { toast("Arquivo de backup grande demais (máx. 20 MB)."); return; }
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data || data.app !== "financas-yg" || !Array.isArray(data.datasets)) throw new Error("formato");
      let count = 0;
      for (const raw of data.datasets.slice(0, 50)) {
        const ds = sanitizeDataset(raw); // valida tudo e regenera IDs
        if (!ds) continue;
        Store.saveDataset(ds);
        count++;
      }
      renderFolders();
      toast(count ? `${count} pasta(s) restaurada(s) do backup ✔` : "Nenhuma pasta válida no arquivo 😕");
    } catch {
      toast("Arquivo de backup inválido 😕");
    }
  };
  reader.readAsText(file);
}

/* ---------- Eventos globais ---------- */
document.addEventListener("DOMContentLoaded", () => {
  renderFolders();

  $("#btn-back").addEventListener("click", goHome);

  // Home: ações principais
  $("#card-upload").addEventListener("click", () => $("#file-input").click());
  $("#file-input").addEventListener("change", (ev) => {
    const file = ev.target.files[0];
    if (file) Importer.handleFile(file);
    ev.target.value = "";
  });
  $("#card-new").addEventListener("click", () => {
    askName("Nome da nova pasta", "Minhas finanças", (name) => {
      const ds = Store.createDataset(name);
      Store.saveDataset(ds);
      Dashboard.open(ds.id);
      toast("Pasta criada! Adicione sua primeira transação 👇");
      setTimeout(() => Dashboard.openTxModal(null), 350);
    });
  });

  // Home: pastas (delegação de eventos)
  $("#folders-grid").addEventListener("click", (ev) => {
    const card = ev.target.closest(".folder-card");
    if (!card) return;
    const id = card.dataset.id;
    const action = ev.target.closest("[data-action]")?.dataset.action;
    if (action === "rename") { ev.stopPropagation(); startRenameFolder(card, id); return; }
    if (action === "delete") {
      ev.stopPropagation();
      const entry = Store.loadIndex().find((x) => x.id === id);
      askConfirm("Excluir pasta?", `A pasta "${entry?.name}" e todas as suas transações serão apagadas. Essa ação não pode ser desfeita.`, () => {
        Store.deleteDataset(id);
        renderFolders();
        toast("Pasta excluída.");
      });
      return;
    }
    if (ev.target.closest(".folder-name-input")) return; // editando nome
    Dashboard.open(id);
  });

  // Backup
  $("#btn-export-backup").addEventListener("click", exportBackup);
  $("#btn-import-backup").addEventListener("click", () => $("#backup-input").click());
  $("#backup-input").addEventListener("change", (ev) => {
    const file = ev.target.files[0];
    if (file) importBackup(file);
    ev.target.value = "";
  });

  // Modal de nome
  $("#btn-name-ok").addEventListener("click", () => {
    const name = $("#modal-name-input").value.trim();
    if (!name) { $("#modal-name-input").focus(); return; }
    const cb = nameCallback;
    closeNameModal();
    if (cb) cb(name);
  });
  $("#btn-name-cancel").addEventListener("click", closeNameModal);
  // Máscara de moeda condicional: só quando o prompt está em modo dinheiro
  $("#modal-name-input").addEventListener("input", (ev) => {
    if (ev.target.dataset.money === "1") maskMoneyEl(ev.target);
  });
  $("#modal-name-input").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") $("#btn-name-ok").click();
    if (ev.key === "Escape") closeNameModal();
  });

  // Modal de confirmação
  $("#btn-confirm-ok").addEventListener("click", () => {
    const cb = confirmCallback;
    closeConfirmModal();
    if (cb) cb();
  });
  $("#btn-confirm-cancel").addEventListener("click", closeConfirmModal);

  // Fechar modais clicando fora
  $$(".modal-backdrop").forEach((bd) => {
    bd.addEventListener("mousedown", (ev) => {
      if (ev.target === bd) bd.classList.add("hidden");
    });
  });
});
