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
  EUR: { code: "EUR", name: "Euro", short: "Euro", locale: "de-DE", symbol: "€", frac: 2 },
  GBP: { code: "GBP", name: "Libra esterlina", short: "Libra", locale: "en-GB", symbol: "£", frac: 2 },
  USDT: { code: "USDT", name: "Tether (USDT)", short: "USDT", locale: "en-US", symbol: "USDT", frac: 6, token: true },
  USDC: { code: "USDC", name: "USD Coin (USDC)", short: "USDC", locale: "en-US", symbol: "USDC", frac: 6, token: true },
};
const CURRENCY_CODES = Object.keys(CURRENCIES);
function normCur(code) { return CURRENCY_CODES.includes(code) ? code : "BRL"; }
// DEFAULT é uma preferência de exibição, nunca a moeda de uma transação.
// Pastas legadas sem preferência continuam em BRL; novas pastas optam por DEFAULT.
function normDisplayCur(code) { return code === "DEFAULT" ? "DEFAULT" : normCur(code); }
function curFrac(code) { return (CURRENCIES[normCur(code)]).frac; }

// Formata um valor numérico na moeda indicada (padrão Real)
function fmtMoney(v, code) {
  code = normCur(code);
  const c = CURRENCIES[code];
  try {
    const options = { minimumFractionDigits: c.frac, maximumFractionDigits: c.frac };
    if (c.token) return `${c.symbol} ${(Number(v) || 0).toLocaleString(c.locale, options)}`;
    return (Number(v) || 0).toLocaleString(c.locale, { ...options, style: "currency", currency: code });
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
  return `${date}|${stripAccents(desc)}|${(Number(amount) || 0).toFixed(6)}|${type}`;
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
  const value = moneyInputValue(el);
  el.dataset.cur = normCur(code);
  // Mudar apenas a unidade não deve transformar R$ 10,00 em CLP 1.000.
  if (value != null) el.value = fmtMoneyInput(value, el.dataset.cur);
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
function parseMoney(v, code) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const explicitCode = v.match(/\b(?:USDT|USDC|BRL|CLP|PYG|USD|EUR|GBP)\b/i)?.[0].toUpperCase();
  const fractionalToken = curFrac(code || explicitCode) === 6;
  let s = v.trim().replace(/(?:US\$|R\$|CL\$|\b(?:USDT|USDC|BRL|CLP|PYG|USD|EUR|GBP)\b|\$|₲|€|£)/gi, "").replace(/\s/g, "");
  const accountingNegative = /^\(.*\)$/.test(s);
  if (accountingNegative) s = s.slice(1, -1);
  if (!/^[+-]?\d[\d.,]*$/.test(s)) return null;
  let sign = accountingNegative ? -1 : 1;
  if (/^[+-]/.test(s)) {
    if (accountingNegative) return null;
    if (s[0] === "-") sign = -1;
    s = s.slice(1);
  }
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > -1 && lastDot > -1) {
    const decimal = lastComma > lastDot ? "," : ".";
    const grouping = decimal === "," ? "." : ",";
    const parts = s.split(decimal);
    if (parts.length !== 2 || !/^\d+$/.test(parts[1])) return null;
    const groups = parts[0].split(grouping);
    if (!/^\d{1,3}$/.test(groups[0]) || groups.slice(1).some((g) => !/^\d{3}$/.test(g))) return null;
    s = groups.join("") + "." + parts[1];
  } else if (lastComma > -1 || lastDot > -1) {
    const sep = lastComma > -1 ? "," : ".";
    const parts = s.split(sep);
    if (parts.some((p) => !/^\d+$/.test(p))) return null;
    // As planilhas brasileiras usam ponto para milhares; CSVs em inglês
    // usam vírgula. Uma única vírgula continua sendo decimal em pt-BR.
    const grouped = /^\d{1,3}$/.test(parts[0]) && parts[0] !== "0" && parts.slice(1).every((p) => p.length === 3);
    if (parts.length > 2) {
      if (!grouped) return null;
      s = parts.join("");
    } else s = grouped && sep === "." && !fractionalToken ? parts.join("") : parts.join(".");
  }
  const n = Number(s) * sign;
  return Number.isFinite(n) ? n : null;
}

function isValidISODate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

function validDateParts(year, month, day) {
  const value = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return isValidISODate(value) ? value : null;
}

// Data de célula do Excel (serial, Date, 'dd/mm/aaaa', 'aaaa-mm-dd') -> 'YYYY-MM-DD' | null
function parseDateCell(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date && !isNaN(v)) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  }
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v < 20000 || v > 80000) return null; // fora da faixa plausível de datas
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/); // dd/mm/aaaa
  if (m) {
    let [, d, mo, y] = m;
    y = Number(y); if (y < 100) y += 2000;
    return validDateParts(y, Number(mo), Number(d));
  }
  m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/); // aaaa-mm-dd / ISO
  if (m) {
    const [, y, mo, d] = m;
    if (s.includes("T") && !Number.isFinite(Date.parse(s))) return null;
    return validDateParts(Number(y), Number(mo), Number(d));
  }
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})$/); // dd/mm (sem ano) -> ano atual (comum em faturas/planilhas)
  if (m) {
    const [, d, mo] = m;
    return validDateParts(new Date().getFullYear(), Number(mo), Number(d));
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
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), Math.min(8500, Math.max(2600, String(msg).length * 45)));
}

/* ---------- Armazenamento (localStorage) ---------- */
const Store = {
  loadIndex() {
    let raw = [];
    try { raw = JSON.parse(localStorage.getItem("fyg:index")); } catch { /* recupera a partir das pastas */ }
    const ids = Array.isArray(raw) ? raw.filter((e) => e && RE_SAFE_ID.test(e.id)).map((e) => e.id) : [];
    // O índice é apenas um catálogo: uma falha antiga ao gravá-lo não deve
    // tornar invisível uma pasta que ainda existe no armazenamento.
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith("fyg:ds:") && RE_SAFE_ID.test(key.slice(7))) ids.push(key.slice(7));
      }
    } catch { /* navegador bloqueou acesso: lista vazia até liberar */ }
    return [...new Set(ids)].map((id) => {
      const ds = this.loadDataset(id);
      if (ds) return this._entry(ds);
      // Uma pasta com registro inconsistente continua visível e exportável.
      const raw = this._rawDataset(id);
      if (!raw) return null;
      const now = new Date().toISOString();
      return this._entry({ id, name: typeof raw.name === "string" ? raw.name : "Pasta para recuperar", profile: raw.profile, createdAt: cleanISO(raw.createdAt, now), updatedAt: cleanISO(raw.updatedAt, now), transactions: Array.isArray(raw.transactions) ? raw.transactions : [] });
    }).filter(Boolean);
  },
  saveIndex(idx) {
    if (!Array.isArray(idx)) throw new TypeError("Índice de pastas inválido.");
    this._commit([{ key: "fyg:index", value: JSON.stringify(idx) }]);
  },
  loadDataset(id) {
    try { return normalizeStoredDataset(this._rawDataset(id)); }
    catch { return null; }
  },
  _rawDataset(id) {
    if (typeof id !== "string" || !RE_SAFE_ID.test(id)) return null;
    try {
      const raw = JSON.parse(localStorage.getItem("fyg:ds:" + id));
      if (!raw || raw.id !== id) return null;
      return raw;
    }
    catch { return null; }
  },
  _entry(ds) {
    return { id: ds.id, name: ds.name, createdAt: ds.createdAt, updatedAt: ds.updatedAt, txCount: ds.transactions.length, profile: ds.profile === "pj" ? "pj" : "pf" };
  },
  // As escritas de um lote são revertidas se o navegador recusar qualquer
  // chave (por exemplo, cota cheia). Só notificamos a nuvem após concluir.
  _commit(changes) {
    const previous = new Map();
    const applied = [];
    try {
      changes.forEach(({ key }) => previous.set(key, localStorage.getItem(key)));
      changes.forEach(({ key, value }) => {
        if (value == null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
        applied.push(key);
      });
    } catch (cause) {
      // Desfaz na ordem inversa: cada passo volta a uma ocupação de espaço
      // já existente, inclusive quando duas pastas trocaram de tamanho.
      applied.reverse().forEach((key) => {
        try {
          if (previous.get(key) == null) localStorage.removeItem(key);
          else localStorage.setItem(key, previous.get(key));
        } catch { /* acesso bloqueado pelo navegador durante a operação */ }
      });
      const message = "Não foi possível salvar. O armazenamento do navegador pode estar cheio ou bloqueado. Exporte um backup e libere espaço antes de tentar novamente.";
      toast(message);
      const error = new Error(message);
      error.name = "StorageError";
      error.cause = cause;
      throw error;
    }
  },
  saveDataset(ds, opts) {
    this.saveDatasets([ds], opts);
  },
  saveDatasets(datasets, opts) {
    if (!Array.isArray(datasets) || !datasets.length) return;
    const seen = new Set();
    const now = new Date().toISOString();
    const saved = datasets.map((ds) => {
      if (!ds || !RE_SAFE_ID.test(ds.id) || !Array.isArray(ds.transactions) || seen.has(ds.id)) throw new TypeError("Pasta inválida ou repetida.");
      seen.add(ds.id);
      return { ...ds, updatedAt: opts?.preserveUpdatedAt ? cleanISO(ds.updatedAt, now) : now };
    });
    const idx = this.loadIndex();
    saved.forEach((ds) => {
      const position = idx.findIndex((entry) => entry.id === ds.id);
      if (position < 0) idx.unshift(this._entry(ds));
      else idx[position] = this._entry(ds);
    });
    const changes = saved.map((ds) => ({ key: "fyg:ds:" + ds.id, value: JSON.stringify(ds) }));
    changes.push({ key: "fyg:index", value: JSON.stringify(idx) });
    this._commit(changes);
    saved.forEach((ds, i) => { datasets[i].updatedAt = ds.updatedAt; });
    if (opts?.origin !== "remote") this._notify(saved.map((ds) => ds.id));
  },
  deleteDataset(id) {
    if (typeof id !== "string" || !RE_SAFE_ID.test(id)) return;
    const idx = this.loadIndex().filter((x) => x.id !== id);
    // A intenção de excluir vai para a mesma gravação reversível da pasta.
    // Se faltar espaço, mantemos a pasta e a fila como estavam.
    const cloudChanges = typeof Cloud !== "undefined" && Cloud.prepareLocalDelete ? Cloud.prepareLocalDelete(id) : [];
    this._commit([...cloudChanges, { key: "fyg:index", value: JSON.stringify(idx) }, { key: "fyg:ds:" + id, value: null }]);
    if (typeof Cloud !== "undefined" && Cloud.onLocalDelete) Cloud.onLocalDelete(id);
  },
  // Registra as pastas alteradas somente depois da gravação local completa.
  // A nuvem mantém as pendências mesmo sem conexão ou com o envio desativado.
  _notify(ids) {
    try { if (typeof Cloud !== "undefined" && Cloud.onLocalChange) Cloud.onLocalChange(ids); }
    catch (error) { console.error("Os dados foram salvos localmente, mas a sincronização falhou.", error); }
  },
  createDataset(name) {
    const now = new Date().toISOString();
    const ds = { id: uid(), name: String(name || "").trim().slice(0, 80) || "Sem nome", createdAt: now, updatedAt: now, displayCurrency: "DEFAULT", profile: "pf", categories: [], transactions: [], limits: [], metas: [] };
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
  return c && RE_COLOR.test(c.color) ? c.color : "#64748b";
}

/* ---------- Navegação entre telas ---------- */
function showScreen(id) {
  $$(".screen").forEach((s) => s.classList.add("hidden"));
  $("#" + id).classList.remove("hidden");
  $("#btn-back").classList.toggle("hidden", id === "screen-home");
  window.scrollTo(0, 0);
  // No celular quem rola é o <main> (evita o botão "voltar ao topo" do navegador)
  const m = $("#main");
  if (m && m.scrollTo) m.scrollTo(0, 0);
  // Ao voltar para o painel, reencaixa os valores do cabeçalho — eles podem
  // ter sido recalculados enquanto o painel estava oculto (tela de Transações).
  if (id === "screen-dash" && typeof Dashboard !== "undefined" && Dashboard.refitHero) {
    requestAnimationFrame(Dashboard.refitHero);
  }
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
    grid.innerHTML = `<div class="empty-folders"><strong>Um novo começo para suas finanças.</strong><span>Crie sua primeira pasta ou importe uma planilha para começar.</span></div>`;
    return;
  }
  grid.innerHTML = idx.map((e) => `
    <div class="folder-card" data-id="${escapeHtml(e.id)}">
      <div class="folder-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3z" stroke-linejoin="round"/><path d="M3 10h18"/></svg></div>
      <div class="folder-info">
        <div class="folder-name" data-name>${escapeHtml(e.name)}</div>
        <div class="folder-meta">${e.txCount} transaç${e.txCount === 1 ? "ão" : "ões"} · atualizada em ${new Date(e.updatedAt).toLocaleDateString("pt-BR")}</div>
      </div>
      <div class="folder-actions">
        <button class="btn-icon" data-action="rename" title="Renomear"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m15 5 4 4M4 20l4-1L20 7l-4-4L4 15z" stroke-linejoin="round"/></svg></button>
        <button class="btn-icon" data-action="delete" title="Excluir"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
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
const RE_MONTH = /^(?:\d{4}-(?:0[1-9]|1[0-2])|0000-00)$/;
const RE_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const RE_PARC = /^\d{1,3}\/\d{1,3}$/;

function cleanStr(v, max) {
  return typeof v === "string" ? v.slice(0, max) : "";
}
function cleanNum(v) {
  if (v == null || typeof v === "boolean" || (typeof v !== "number" && typeof v !== "string") || (typeof v === "string" && !v.trim())) return null;
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER ? Math.abs(n) : null;
}
function cleanCats(v, fallback, preserveContent) {
  const list = Array.isArray(v) ? [...new Set(v.map((c) => cleanStr(c, preserveContent ? undefined : 40).trim()).filter(Boolean))] : [];
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
  return typeof v === "string" && isValidISODate(v.slice(0, 10)) && v[10] === "T" && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : fallback;
}

// Dados locais já pertencem ao usuário. Uma simples leitura não pode
// descartar lançamentos antigos, alterar sinais nem regenerar vínculos.
// Só preenche campos adicionados em versões novas e protege a renderização.
function normalizeStoredDataset(raw) {
  if (!raw || !Array.isArray(raw.transactions)) return null;
  if ([raw.categories, raw.metas, raw.limits].some((value) => value != null && !Array.isArray(value))) return null;
  const validRecord = (value) => value && typeof value === "object" && !Array.isArray(value);
  const finiteValue = (value) => (typeof value === "number" || (typeof value === "string" && value.trim() !== "")) && Number.isFinite(Number(value));
  if (raw.transactions.some((t) => !validRecord(t) || !isValidISODate(t.date) || !finiteValue(t.amount))) return null;
  const now = new Date().toISOString();
  const ds = {
    ...raw,
    name: typeof raw.name === "string" ? raw.name : "Sem nome",
    createdAt: cleanISO(raw.createdAt, now),
    updatedAt: cleanISO(raw.updatedAt, now),
    displayCurrency: normDisplayCur(raw.displayCurrency),
    profile: raw.profile === "pj" ? "pj" : "pf",
    categories: [],
    transactions: raw.transactions.map((t) => ({
      ...t,
      id: typeof t.id === "string" && t.id ? t.id : uid(),
      date: t.date,
      amount: Number(t.amount),
      desc: String(t.desc ?? ""),
      category: String(t.category || "Outros"),
      account: String(t.account || ""),
      currency: normCur(t.currency),
      type: t.type === "receita" ? "receita" : "despesa",
    })),
    limits: Array.isArray(raw.limits) ? raw.limits : [],
    metas: Array.isArray(raw.metas) ? raw.metas : [],
  };
  if (ds.limits.some((L) => !validRecord(L) || !finiteValue(L.amount) || !Array.isArray(L.categories) || L.categories.some((c) => typeof c !== "string") || (L.versions != null && (!Array.isArray(L.versions) || L.versions.some((v) => !validRecord(v) || typeof v.from !== "string" || !finiteValue(v.amount) || !Array.isArray(v.categories)))))) return null;
  if (ds.metas.some((m) => !validRecord(m) || (!m.category && (!finiteValue(m.target) || (m.saved != null && !finiteValue(m.saved)))))) return null;
  ds.limits.forEach((L) => {
    L.amount = Number(L.amount);
    if (Array.isArray(L.versions)) L.versions.forEach((v) => { v.amount = Number(v.amount); });
  });
  ds.metas.forEach((m) => { if (!m.category) { m.target = Number(m.target); m.saved = Number(m.saved ?? 0); } });
  if (Array.isArray(raw.categories)) raw.categories.forEach((c) => {
    if (!validRecord(c) || typeof c.name !== "string" || !c.name.trim()) return;
    ds.categories.push({ ...c, color: RE_COLOR.test(c.color) ? c.color : PALETTE[ds.categories.length % PALETTE.length] });
  });
  ds.transactions.forEach((t) => ensureCat(ds, t.category));
  return ds;
}

function sanitizeDataset(raw, opts) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.transactions) || raw.transactions.length > 100000) return null;
  if (opts?.rejectInvalidTransactions && [raw.categories, raw.metas, raw.limits].some((value) => value != null && !Array.isArray(value))) return null;
  const preserve = !!(opts && opts.preserveIds);
  const preserveContent = !!opts?.preserveContent;
  const text = (value, max) => cleanStr(value, preserveContent ? undefined : max);
  const now = new Date().toISOString();
  const ds = {
    id: keepOrNewId(raw.id, preserve),
    name: text(raw.name, 80).trim() || "Backup importado",
    createdAt: cleanISO(raw.createdAt, now),
    updatedAt: cleanISO(raw.updatedAt, now),
    displayCurrency: normDisplayCur(raw.displayCurrency),
    profile: raw.profile === "pj" ? "pj" : "pf",
    categories: [],
    transactions: [],
    limits: [],
    metas: [],
  };
  const usedIds = new Set([ds.id]);
  const uniqueId = (value) => {
    let id = keepOrNewId(value, preserve);
    while (usedIds.has(id)) id = uid();
    usedIds.add(id);
    return id;
  };

  // Metas: poupança (target/saved) ou cobrança vinculada a categoria
  if (Array.isArray(raw.metas)) {
    raw.metas.forEach((m) => {
      const name = text(m?.name, 60).trim();
      if (!name) return;
      const category = text(m?.category, 40).trim();
      if (category) {
        ds.metas.push({ id: uniqueId(m?.id), name, category });
      } else {
        const target = cleanNum(m?.target);
        if (target == null || target <= 0) return;
        ds.metas.push({ id: uniqueId(m?.id), name, target, saved: cleanNum(m?.saved) ?? 0, currency: normCur(m?.currency) });
      }
    });
  }

  // Categorias: nome texto puro, cor só #hex
  if (Array.isArray(raw.categories)) {
    raw.categories.forEach((c) => {
      const name = text(c?.name, 40).trim();
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
  raw.transactions.forEach((t) => {
    if (!t || typeof t !== "object") return;
    const date = isValidISODate(t.date) ? t.date : null;
    const validAmount = cleanNum(t.amount);
    // O formato interno já registra o tipo separadamente. Preserve o valor
    // exato, inclusive zero e sinais de registros legados, no round-trip.
    const amount = validAmount == null ? null : Number(t.amount);
    if (!date || amount == null) return;
    ds.transactions.push({
      id: uniqueId(t.id),
      groupId: mapGroup(t.groupId),
      fixed: t.fixed === true,
      date,
      desc: text(t.desc, 120).trim() || "(sem descrição)",
      category: text(t.category, 40).trim() || "Outros",
      account: text(t.account, 40).trim(),
      type: t.type === "receita" ? "receita" : "despesa",
      amount,
      currency: normCur(t.currency),
      installment: typeof t.installment === "string" && RE_PARC.test(t.installment) && t.installment.split("/").every((p) => Number(p) > 0) && Number(t.installment.split("/")[0]) <= Number(t.installment.split("/")[1]) ? t.installment : null,
      totalValue: cleanNum(t.totalValue),
    });
  });
  if (opts?.rejectInvalidTransactions && ds.transactions.length !== raw.transactions.length) return null;
  ds.transactions.forEach((t) => ensureCat(ds, t.category));

  // Limites: valores numéricos, meses no formato AAAA-MM
  if (Array.isArray(raw.limits)) {
    raw.limits.forEach((L) => {
      const cats = cleanCats(L?.categories, null, preserveContent);
      const amount = cleanNum(L?.amount);
      if (!cats.length || amount == null || amount <= 0) return;
      const versions = [];
      if (Array.isArray(L.versions)) {
        L.versions.forEach((v) => {
          const from = typeof v?.from === "string" && RE_MONTH.test(v.from) ? v.from : null;
          const vAmount = cleanNum(v?.amount);
          const vCats = cleanCats(v?.categories, cats, preserveContent);
          if (from && vAmount != null && vAmount > 0) versions.push({ from, amount: vAmount, categories: vCats });
        });
      }
      if (opts?.rejectInvalidTransactions && Array.isArray(L.versions) && versions.length !== L.versions.length) return;
      if (!versions.length) versions.push({ from: "0000-00", amount, categories: cats });
      versions.sort((a, b) => a.from.localeCompare(b.from));
      const last = versions[versions.length - 1];
      ds.limits.push({
        id: uniqueId(L?.id),
        name: text(L?.name, 60).trim() || cats.join(" + "),
        amount: last.amount,
        categories: last.categories,
        currency: normCur(L?.currency),
        versions,
      });
    });
  }
  if (opts?.rejectInvalidTransactions && ((Array.isArray(raw.metas) && raw.metas.length !== ds.metas.length) || (Array.isArray(raw.limits) && raw.limits.length !== ds.limits.length))) return null;
  return ds;
}

/* ---------- Sincronização: mesclar datasets vindos da nuvem ----------
   Regra: por id, vence o de updatedAt mais recente. Ids novos são adicionados.
   Retorna quantos foram criados/atualizados. */
function mergeCloudDatasets(rawList) {
  if (!Array.isArray(rawList)) return { added: 0, updated: 0 };
  let added = 0, updated = 0;
  const pending = new Map();
  for (const raw of rawList) {
    const ds = sanitizeDataset(raw, { preserveIds: true, preserveContent: true, rejectInvalidTransactions: true });
    // Uma pasta corrompida não pode substituir uma versão íntegra.
    if (!ds || !RE_SAFE_ID.test(raw.id) || !cleanISO(raw.updatedAt, null)) continue;
    const duplicate = pending.get(ds.id);
    if (!duplicate || Date.parse(ds.updatedAt) > Date.parse(duplicate.updatedAt)) pending.set(ds.id, ds);
  }
  const changes = [];
  for (const ds of pending.values()) {
    // Uma pasta local que requer reparo ainda tem uma versão. Não a trate
    // como ausente para sobrescrevê-la com uma cópia remota mais antiga.
    const local = Store.loadDataset(ds.id) || Store._rawDataset(ds.id);
    if (!local) { changes.push(ds); added++; }
    else if (Date.parse(ds.updatedAt) > Date.parse(local.updatedAt)) {
      changes.push(ds); updated++;
    }
  }
  Store.saveDatasets(changes, { preserveUpdatedAt: true });
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
  // O backup preserva os objetos originais, inclusive registros que precisam
  // de reparo. A leitura da interface não deve reduzir o conteúdo exportado.
  const data = {
    app: "financas-yg", version: 1, exportedAt: new Date().toISOString(),
    datasets: Store.loadIndex().map((e) => Store._rawDataset(e.id)).filter(Boolean),
  };
  if (!data.datasets.length) { toast("Nada para exportar ainda."); return; }
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `financas-yg-backup-${todayISO()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast("Backup exportado ✔");
}

function importBackup(file) {
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) { toast("Arquivo de backup grande demais (máx. 20 MB)."); return; }
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data || data.app !== "financas-yg" || !Array.isArray(data.datasets) || (data.version != null && data.version !== 1)) throw new Error("formato");
      // Valida tudo antes de escrever; arquivos parcialmente inválidos não
      // geram pastas incompletas nem sucesso aparente com totais alterados.
      const datasets = data.datasets.map((raw) => sanitizeDataset(raw, { preserveContent: true, rejectInvalidTransactions: true }));
      if (datasets.some((ds) => !ds)) throw new Error("dados");
      Store.saveDatasets(datasets);
      const count = datasets.length;
      renderFolders();
      toast(count ? `${count} pasta(s) restaurada(s) do backup ✔` : "Nenhuma pasta válida no arquivo 😕");
    } catch (error) {
      if (error.name === "StorageError") return; // Store já mostrou a causa real
      toast("Backup inválido ou com datas/valores inconsistentes. Nenhuma pasta foi restaurada.");
    }
  };
  reader.onerror = () => toast("Não foi possível ler o backup. Selecione o arquivo novamente.");
  reader.onabort = () => toast("Leitura do backup cancelada.");
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
