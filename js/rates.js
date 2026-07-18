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

  function save() {
    try { localStorage.setItem(STORAGE, JSON.stringify({ rate, at })); } catch { /* cota cheia */ }
  }

  // Aceita um mapa {BRL,CLP,PYG,USD} em unidades por 1 USD e publica se cobrir
  // todas as 4 moedas. Notifica quem estiver ouvindo (re-render do painel).
  function apply(map, when) {
    const next = { USD: 1 };
    CURRENCY_CODES.forEach((k) => { if (typeof map[k] === "number" && map[k] > 0) next[k] = map[k]; });
    if (!CURRENCY_CODES.every((k) => next[k])) return false;
    rate = next;
    at = when || new Date().toISOString();
    save();
    listeners.forEach((fn) => { try { fn(); } catch { /* ignora ouvinte com erro */ } });
    return true;
  }

  async function fetchPrimary() {
    const r = await fetch(PRIMARY, { cache: "no-store" });
    if (!r.ok) throw new Error("primary " + r.status);
    const j = await r.json();
    if (j.result !== "success" || !j.rates) throw new Error("primary_shape");
    const when = j.time_last_update_unix ? new Date(j.time_last_update_unix * 1000).toISOString() : null;
    if (!apply(j.rates, when)) throw new Error("primary_incompleto");
  }

  async function fetchFallback() {
    const r = await fetch(FALLBACK, { cache: "no-store" });
    if (!r.ok) throw new Error("fallback " + r.status);
    const j = await r.json();
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
      if (c && c.rate && c.rate.USD) { rate = c.rate; at = c.at || null; }
    } catch { /* cache corrompido: ignora */ }
    if (!at || (Date.now() - Date.parse(at)) > TTL) refresh();
    return rate;
  }

  // Converte 'v' da moeda 'from' para 'to' pela cotação atual.
  function convert(v, from, to) {
    v = Number(v) || 0;
    from = normCur(from); to = normCur(to);
    if (from === to) return v;
    const rf = rate[from], rt = rate[to];
    if (!rf || !rt) return v; // sem cotação para o par: melhor esforço (não converte)
    return v * (rt / rf);
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
