/* ===== Finanças YG — cotação de moedas em tempo real =====
   Busca a cotação das moedas (BRL, CLP, PYG, USD) numa API pública e gratuita
   (sem chave). Guarda a última cotação boa em localStorage para funcionar
   offline / entre sessões, e revalida em segundo plano. A conversão só é usada
   quando a moeda exibida no painel difere da moeda em que a transação foi
   lançada — ver dispAmount() em js/dashboard.js. Depende de app.js
   (CURRENCY_CODES / normCur), então este script carrega DEPOIS de app.js. */
"use strict";

const Rates = (() => {
  const STORAGE = "fyg:rates";
  const TTL = 60 * 60 * 1000; // revalida se a cotação salva tiver mais de 1h
  const PRIMARY = "https://open.er-api.com/v6/latest/USD";
  const FALLBACK = "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json";

  // rate[code] = unidades da moeda por 1 USD (ex: rate.BRL ≈ 5.08)
  let rate = { USD: 1 };
  let at = null;             // ISO da última cotação válida
  const listeners = [];
  let fetching = false;

  function validRates(map) {
    return map && CURRENCY_CODES.every((k) => Number.isFinite(map[k]) && map[k] > 0) && map.USD === 1;
  }

  async function request(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(url, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("cotacao " + response.status);
      return await response.json();
    } finally { clearTimeout(timer); }
  }

  function save() {
    try { localStorage.setItem(STORAGE, JSON.stringify({ rate, at })); } catch { /* cota cheia */ }
  }

  // Aceita um mapa {BRL,CLP,PYG,USD} em unidades por 1 USD e publica se cobrir
  // todas as 4 moedas. Notifica quem estiver ouvindo (re-render do painel).
  function apply(map, when) {
    if (!validRates(map)) return false;
    const next = { USD: 1 };
    CURRENCY_CODES.forEach((k) => { next[k] = map[k]; });
    rate = next;
    at = when || new Date().toISOString();
    save();
    listeners.forEach((fn) => { try { fn(); } catch { /* ignora ouvinte com erro */ } });
    return true;
  }

  async function fetchPrimary() {
    const j = await request(PRIMARY);
    if (j.result !== "success" || !j.rates) throw new Error("primary_shape");
    const when = j.time_last_update_unix ? new Date(j.time_last_update_unix * 1000).toISOString() : null;
    if (!apply(j.rates, when)) throw new Error("primary_incompleto");
  }

  async function fetchFallback() {
    const j = await request(FALLBACK);
    const usd = j.usd || {};
    const map = { USD: 1 };
    CURRENCY_CODES.forEach((k) => { const v = usd[k.toLowerCase()]; if (typeof v === "number") map[k] = v; });
    const when = j.date ? new Date(j.date + "T00:00:00Z").toISOString() : null;
    if (!apply(map, when)) throw new Error("fallback_incompleto");
  }

  // Busca a cotação online (primária, depois reserva). Silenciosa: se falhar,
  // segue usando a última cotação salva (ou nenhuma conversão).
  async function refresh() {
    if (fetching) return;
    fetching = true;
    try {
      try { await fetchPrimary(); }
      catch { await fetchFallback(); }
    } catch (e) {
      console.warn("Cotação indisponível agora:", e && e.message);
    } finally {
      fetching = false;
    }
  }

  // Carrega o cache e agenda uma revalidação se estiver velho/ausente.
  function load() {
    try {
      const c = JSON.parse(localStorage.getItem(STORAGE));
      if (c && validRates(c.rate)) {
        rate = Object.fromEntries(CURRENCY_CODES.map((k) => [k, c.rate[k]]));
        at = typeof c.at === "string" && Number.isFinite(Date.parse(c.at)) ? c.at : null;
      }
    } catch { /* cache corrompido: ignora */ }
    if (!at || Date.parse(at) > Date.now() + TTL || (Date.now() - Date.parse(at)) > TTL) refresh();
    return rate;
  }

  // Converte 'v' da moeda 'from' para 'to' pela cotação atual.
  function convert(v, from, to) {
    v = Number(v);
    if (!Number.isFinite(v)) return 0;
    from = normCur(from); to = normCur(to);
    if (from === to) return v;
    const rf = rate[from], rt = rate[to];
    if (!rf || !rt) return NaN; // o painel deve indicar cotação indisponível, nunca trocar só o símbolo
    const converted = v * (rt / rf);
    return Number.isFinite(converted) ? converted : NaN;
  }

  // true se dá para converter esse par agora (mesma moeda ou cotação disponível)
  function ready(from, to) {
    from = normCur(from); to = normCur(to);
    return from === to || !!(rate[from] && rate[to]);
  }

  function onUpdate(fn) { if (typeof fn === "function") listeners.push(fn); }
  function updatedAt() { return at; }

  return { load, refresh, convert, ready, onUpdate, updatedAt };
})();
