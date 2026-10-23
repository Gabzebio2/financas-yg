/* ===== Finanças YG — cotações diárias indicativas =====
   Taxas em unidades da moeda por 1 USD. USDT/USDC vêm do provedor, sem paridade
   presumida. Publicação e consulta têm datas distintas; falhas preservam cache.
   Fontes: https://www.exchangerate-api.com/docs/free (crédito na interface)
   e https://github.com/fawazahmed0/exchange-api (dois espelhos do mesmo dado). */
"use strict";

const Rates = (() => {
  const STORAGE = "fyg:rates";
  const MINUTE = 60 * 1000, HOUR = 60 * MINUTE;
  const FRESH_AGE = 48 * HOUR, MAX_RESPONSE_AGE = 7 * 24 * HOUR, CLOCK_SKEW = 5 * MINUTE;
  const PRIMARY = "https://open.er-api.com/v6/latest/USD";
  const FALLBACKS = [
    "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json",
    "https://latest.currency-api.pages.dev/v1/currencies/usd.min.json",
  ];
  const codes = Array.from(new Set(CURRENCY_CODES)), supported = new Set(codes);
  const quotedCodes = codes.filter((code) => code !== "USD");
  const cryptoCodes = quotedCodes.filter((code) => code === "USDT" || code === "USDC");
  const fiatCodes = quotedCodes.filter((code) => !cryptoCodes.includes(code));
  const quotes = Object.create(null), listeners = new Set();
  const providers = {
    fiat: { nextAt: fiatCodes.length ? 0 : Infinity, lastAttempt: null, failures: 0, blockedUntil: 0 },
    all: { nextAt: cryptoCodes.length ? 0 : Infinity, lastAttempt: null, failures: 0, blockedUntil: 0 },
  };
  let loaded = false, inflight = null, timer = null, lastError = "";

  function online() { return typeof navigator === "undefined" || navigator.onLine !== false; }
  function visible() { return typeof document === "undefined" || document.visibilityState !== "hidden"; }
  function positive(value) { return typeof value === "number" && Number.isFinite(value) && value > 0; }
  function currency(code) {
    if (typeof code !== "string") return null;
    const normalized = code.trim().toUpperCase();
    return supported.has(normalized) ? normalized : null;
  }
  function timestamp(value, now = Date.now()) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) return null;
    const ms = Date.parse(value);
    if (!Number.isFinite(ms) || ms < Date.UTC(2000, 0, 1) || ms > now + CLOCK_SKEW) return null;
    const iso = new Date(ms).toISOString();
    return iso.slice(0, 10) === value.slice(0, 10) ? iso : null;
  }
  function oldest(values) { return values.length ? values.sort()[0] : null; }
  function newest(values) { return values.length ? values.sort().at(-1) : null; }
  function snapshot() { return { USD: 1, ...Object.fromEntries(Object.entries(quotes).map(([code, q]) => [code, q.rate])) }; }
  function updatedAt(from, to) {
    const selected = arguments.length ? [currency(from), currency(to)].filter((code) => code && code !== "USD") : quotedCodes;
    return oldest(selected.map((code) => quotes[code]?.publishedAt).filter(Boolean));
  }
  function getState() {
    const now = Date.now();
    const missingCodes = quotedCodes.filter((code) => !quotes[code]);
    const staleCodes = quotedCodes.filter((code) => quotes[code] && now - Date.parse(quotes[code].publishedAt) > FRESH_AGE);
    const next = Math.min(...Object.values(providers).map((p) => p.nextAt));
    return {
      status: missingCodes.length ? (missingCodes.length === quotedCodes.length ? "unavailable" : "partial") : staleCodes.length ? "stale" : "ready",
      refreshing: !!inflight, online: online(), error: lastError,
      updatedAt: updatedAt(), fetchedAt: newest(Object.values(quotes).map((q) => q.fetchedAt).filter(Boolean)),
      nextRetryAt: Number.isFinite(next) && next > now ? new Date(next).toISOString() : null,
      missingCodes, staleCodes,
      quotes: Object.fromEntries(Object.entries(quotes).map(([code, q]) => [code, { ...q }])),
    };
  }
  function notify() { listeners.forEach((fn) => { try { fn(getState()); } catch { /* ouvinte isolado */ } }); }
  function save() { try { localStorage.setItem(STORAGE, JSON.stringify({ version: 2, quotes })); } catch { /* mantém na memória */ } }
  function restoreCache() {
    try {
      const cached = JSON.parse(localStorage.getItem(STORAGE));
      if (cached?.version === 2 && cached.quotes && typeof cached.quotes === "object") {
        quotedCodes.forEach((code) => {
          const q = cached.quotes[code], publishedAt = timestamp(q?.publishedAt);
          const fetchedAt = q?.fetchedAt === null ? null : timestamp(q?.fetchedAt);
          if (!positive(q?.rate) || !publishedAt || (q.fetchedAt !== null && !fetchedAt) ||
              (fetchedAt && Date.parse(publishedAt) > Date.parse(fetchedAt) + CLOCK_SKEW)) return;
          quotes[code] = { rate: q.rate, publishedAt, fetchedAt, source: typeof q.source === "string" ? q.source.slice(0, 80) : "cache" };
        });
      } else if (cached?.rate?.USD === 1) {
        const publishedAt = timestamp(cached.at);
        // O cache antigo não registrava a consulta; não inventar essa data.
        if (publishedAt) fiatCodes.forEach((code) => {
          if (positive(cached.rate[code])) quotes[code] = { rate: cached.rate[code], publishedAt, fetchedAt: null, source: "cache-legado" };
        });
      }
      for (const [name, wanted] of [["fiat", fiatCodes], ["all", cryptoCodes]]) {
        if (!wanted.length) { providers[name].nextAt = Infinity; continue; }
        if (wanted.every((code) => quotes[code]?.fetchedAt)) {
          const last = Math.min(...wanted.map((code) => Date.parse(quotes[code].fetchedAt)));
          const fresh = wanted.every((code) => Date.now() - Date.parse(quotes[code].publishedAt) <= FRESH_AGE);
          providers[name].nextAt = fresh ? Math.min(Date.now() + HOUR, last + HOUR) : 0;
        }
      }
    } catch { /* cache inválido ou armazenamento indisponível */ }
  }
  async function request(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(url, { cache: "no-store", credentials: "omit", signal: controller.signal });
      if (!response.ok) { const error = new Error("http_" + response.status); error.rateLimited = response.status === 429; throw error; }
      return await response.json();
    } finally { clearTimeout(timeout); }
  }
  function parseQuotes(data, source) {
    const now = Date.now();
    let map, publishedAt;
    if (source === "ExchangeRate-API") {
      if (data?.result !== "success" || data.base_code !== "USD" || !positive(data.time_last_update_unix)) throw new Error("resposta_invalida");
      const ms = data.time_last_update_unix * 1000;
      if (!Number.isFinite(ms) || ms > now + CLOCK_SKEW || ms < Date.UTC(2000, 0, 1)) throw new Error("data_invalida");
      publishedAt = new Date(ms).toISOString(); map = data.rates;
    } else {
      if (typeof data?.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(data.date)) throw new Error("data_invalida");
      publishedAt = timestamp(data.date, now); map = data.usd;
    }
    if (!publishedAt || now - Date.parse(publishedAt) > MAX_RESPONSE_AGE || !map || map[source === "ExchangeRate-API" ? "USD" : "usd"] !== 1) throw new Error("base_ou_data_invalida");
    const extracted = Object.create(null), fetchedAt = new Date(now).toISOString();
    (source === "ExchangeRate-API" ? fiatCodes : quotedCodes).forEach((code) => {
      const value = map[source === "ExchangeRate-API" ? code : code.toLowerCase()];
      if (positive(value)) extracted[code] = { rate: value, publishedAt, fetchedAt, source };
    });
    return extracted;
  }
  function freshComplete(map, wanted) { return wanted.every((code) => map[code] && Date.now() - Date.parse(map[code].publishedAt) <= FRESH_AGE); }
  async function primary() {
    try { return { quotes: parseQuotes(await request(PRIMARY), "ExchangeRate-API") }; }
    catch (error) { return { quotes: {}, error }; }
  }
  function merge(target, incoming) {
    for (const [code, q] of Object.entries(incoming)) {
      const previous = target[code];
      if (previous && q.publishedAt < previous.publishedAt) continue;
      if (previous && q.publishedAt === previous.publishedAt && previous.source === "ExchangeRate-API" && q.source !== previous.source) continue;
      target[code] = { ...q };
    }
  }
  async function fallback() {
    const collected = Object.create(null);
    let error = null, rateLimited = false;
    for (const url of FALLBACKS) {
      try {
        merge(collected, parseQuotes(await request(url), "Fawaz Currency API"));
        if (freshComplete(collected, quotedCodes)) return { quotes: collected };
        error = new Error("resposta_incompleta_ou_antiga");
      } catch (caught) { error = caught; rateLimited ||= !!caught.rateLimited; }
    }
    if (error) error.rateLimited ||= rateLimited;
    return { quotes: collected, error };
  }
  function due(provider, manual) {
    const now = Date.now();
    return now >= provider.blockedUntil && (manual ? provider.lastAttempt === null || now - provider.lastAttempt >= MINUTE : now >= provider.nextAt);
  }
  function finishProvider(provider, complete, error) {
    const now = Date.now();
    provider.failures = complete ? 0 : Math.min(provider.failures + 1, 5);
    if (error?.rateLimited) provider.blockedUntil = now + 20 * MINUTE;
    const delay = complete ? HOUR : Math.min(HOUR, 5 * MINUTE * 2 ** (provider.failures - 1));
    provider.nextAt = Math.max(now + delay, provider.blockedUntil);
  }
  function clearTimer() { if (timer !== null) clearTimeout(timer); timer = null; }
  function schedule() {
    clearTimer();
    if (!loaded || inflight || !online() || !visible()) return;
    const next = Math.min(...Object.values(providers).map((p) => p.nextAt));
    if (!Number.isFinite(next)) return;
    timer = setTimeout(() => { timer = null; refresh({ automatic: true }); }, Math.max(1000, next - Date.now()));
    if (typeof timer?.unref === "function") timer.unref();
  }
  function ensureLoaded() {
    if (loaded) return;
    loaded = true; restoreCache();
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("online", () => { refresh({ automatic: true }); notify(); });
      window.addEventListener("offline", () => { clearTimer(); notify(); });
    }
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", () => { if (visible()) refresh({ automatic: true }); else clearTimer(); });
    }
  }
  async function performRefresh(runFiat, runAll) {
    const started = Date.now();
    if (runFiat) providers.fiat.lastAttempt = started;
    if (runAll) providers.all.lastAttempt = started;
    let [fiatResult, allResult] = await Promise.all([runFiat ? primary() : null, runAll ? fallback() : null]);
    // Sem cripto, consultar a reserva apenas quando o primário falhar.
    if (runFiat && !freshComplete(fiatResult.quotes, fiatCodes) && !runAll && Date.now() >= providers.all.blockedUntil &&
        (providers.all.lastAttempt === null || Date.now() - providers.all.lastAttempt >= MINUTE)) {
      providers.all.lastAttempt = Date.now(); allResult = await fallback(); runAll = true;
    }
    const combined = Object.create(null);
    if (allResult) merge(combined, allResult.quotes);
    if (fiatResult) merge(combined, fiatResult.quotes);
    merge(quotes, combined);
    if (runFiat) finishProvider(providers.fiat, freshComplete(combined, fiatCodes), fiatResult.error);
    if (runAll) {
      finishProvider(providers.all, freshComplete(allResult.quotes, cryptoCodes.length ? cryptoCodes : quotedCodes), allResult.error);
      if (!cryptoCodes.length) providers.all.nextAt = Infinity;
    }
    const requested = [...(runFiat ? fiatCodes : []), ...(runAll ? cryptoCodes : [])];
    lastError = requested.length && !freshComplete(combined, requested)
      ? "Algumas cotações não puderam ser atualizadas. As últimas cotações disponíveis foram mantidas." : "";
    save();
  }
  function refresh(options) {
    ensureLoaded();
    if (inflight) return inflight;
    if (!online()) {
      lastError = "Sem conexão. Usando as últimas cotações disponíveis neste aparelho.";
      clearTimer(); notify(); return Promise.resolve(getState());
    }
    if (lastError.startsWith("Sem conexão.")) lastError = "";
    const manual = options?.automatic !== true;
    if (!manual && !visible()) { clearTimer(); return Promise.resolve(getState()); }
    const runFiat = fiatCodes.length > 0 && due(providers.fiat, manual);
    const runAll = cryptoCodes.length > 0 && due(providers.all, manual);
    if (!runFiat && !runAll) { schedule(); return Promise.resolve(getState()); }
    clearTimer();
    // Atribuir antes de emitir eventos evita reentrância de ouvintes.
    inflight = Promise.resolve().then(() => performRefresh(runFiat, runAll)).catch(() => {
      lastError = "Não foi possível consultar as cotações. As últimas cotações disponíveis foram mantidas.";
      if (runFiat) finishProvider(providers.fiat, false);
      if (runAll) finishProvider(providers.all, false);
    }).then(() => { inflight = null; schedule(); notify(); return getState(); });
    notify(); return inflight;
  }
  function load() { ensureLoaded(); refresh({ automatic: true }); return snapshot(); }
  function convert(value, from, to) {
    const source = currency(from), target = currency(to);
    if (!source || !target || (typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && !value.trim())) return NaN;
    const amount = Number(value);
    if (!Number.isFinite(amount)) return NaN;
    if (source === target) return amount;
    const sourceRate = source === "USD" ? 1 : quotes[source]?.rate, targetRate = target === "USD" ? 1 : quotes[target]?.rate;
    if (!positive(sourceRate) || !positive(targetRate)) return NaN;
    const converted = amount * (targetRate / sourceRate);
    return Number.isFinite(converted) ? converted : NaN;
  }
  function ready(from, to) {
    const source = currency(from), target = currency(to);
    return !!source && !!target && (source === target || (positive(source === "USD" ? 1 : quotes[source]?.rate) && positive(target === "USD" ? 1 : quotes[target]?.rate)));
  }
  function onUpdate(fn) { if (typeof fn === "function") listeners.add(fn); return () => listeners.delete(fn); }
  return { load, refresh, convert, ready, onUpdate, updatedAt, getState };
})();
