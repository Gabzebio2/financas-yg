const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SOURCE = fs.readFileSync(path.join(__dirname, '../js/rates.js'), 'utf8');
const CODES = ['BRL','CLP','PYG','USD','EUR','GBP','USDT','USDC'];
const NOW = Date.parse('2026-10-23T12:00:00.000Z');
const MINUTE = 60000, HOUR = 60 * MINUTE;
const PRIMARY = 'https://open.er-api.com/v6/latest/USD';
const CDN = 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json';
const MIRROR = 'https://latest.currency-api.pages.dev/v1/currencies/usd.min.json';
const VALUES = { USD: 1, BRL: 5, CLP: 950, PYG: 7000, EUR: .92, GBP: .77, USDT: 1.003, USDC: .998 };
function primary(extra = {}) { return { result: 'success', base_code: 'USD', time_last_update_unix: Date.parse('2026-10-23T00:02:00Z') / 1000, rates: { ...VALUES }, ...extra }; }
function fallback(extra = {}) { return { date: '2026-10-23', usd: Object.fromEntries(Object.entries(VALUES).map(([k,v]) => [k.toLowerCase(),v])), ...extra }; }
function ok(data) { return { ok: true, json: async () => data }; }
function cache(entries = {}) {
  return { version: 2, quotes: Object.fromEntries(CODES.filter(c => c !== 'USD').map(c => [c, { rate: VALUES[c], publishedAt: '2026-10-23T00:00:00.000Z', fetchedAt: '2026-10-23T12:00:00.000Z', source: 'cache-test', ...entries[c] }])) };
}
async function flush() { await new Promise(setImmediate); }
function setup(options = {}) {
  let now = options.now ?? NOW, seq = 0;
  const timers = new Map(), storage = new Map(), calls = [], events = new Map(), docEvents = new Map();
  const navigator = { onLine: options.online !== false };
  const document = { visibilityState: options.visible === false ? 'hidden' : 'visible', addEventListener(type, fn) { if (!docEvents.has(type)) docEvents.set(type, []); docEvents.get(type).push(fn); } };
  if (options.cache) storage.set('fyg:rates', JSON.stringify(options.cache));
  const RealDate = Date;
  class ClockDate extends RealDate { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const context = vm.createContext({
    CURRENCY_CODES: options.codes || CODES, Date: ClockDate, AbortController, navigator, document,
    window: { addEventListener(type, fn) { if (!events.has(type)) events.set(type, []); events.get(type).push(fn); } },
    setTimeout(fn, delay) { const timer = { id: ++seq, when: now + delay, fn, unref() { this.unrefed = true; } }; timers.set(timer.id, timer); return timer; },
    clearTimeout(timer) { timers.delete(timer?.id); },
    localStorage: { getItem: k => storage.get(k) ?? null, setItem(k,v) { if (options.storageFails) throw new Error('quota'); storage.set(k,v); } },
    fetch: async (url, init) => { calls.push({ url, init }); return (options.fetch || ((u) => ok(u === PRIMARY ? primary() : fallback())))(url, init); },
  });
  vm.runInContext(SOURCE + '\nthis.subject = Rates;', context);
  async function tick(ms) {
    const end = now + ms;
    let count = 0;
    while (true) {
      const next = [...timers.values()].sort((a,b) => a.when-b.when)[0];
      if (!next || next.when > end) break;
      if (++count > 100) throw new Error('timer loop');
      now = next.when; timers.delete(next.id); next.fn(); await flush();
    }
    now = end; await flush();
  }
  return { rates: context.subject, calls, storage, timers, events, docEvents, navigator, document, tick,
    now: () => now,
    async online(value) { navigator.onLine = value; for (const fn of events.get(value ? 'online' : 'offline') || []) fn(); await flush(); },
    async visibility(value) { document.visibilityState = value; for (const fn of docEvents.get('visibilitychange') || []) fn(); await flush(); },
  };
}

test('converte oito moedas com stablecoins reais e sem arredondar a taxa', async () => {
  const e = setup(); await e.rates.refresh();
  assert.equal(e.calls.length, 2);
  assert.equal(e.rates.getState().status, 'ready');
  assert.equal(e.rates.convert(100, 'USD', 'USDT'), 100 * 1.003);
  assert.equal(e.rates.convert(100, 'USD', 'USDC'), 99.8);
  assert.ok(Math.abs(e.rates.convert(10, 'EUR', 'BRL') - 10 * 5 / .92) < 1e-10);
  assert.ok(Math.abs(e.rates.convert(e.rates.convert(123.456, 'GBP', 'USDT'), 'USDT', 'GBP') - 123.456) < 1e-10);
  assert.equal(e.rates.ready(' usd ', 'usdc'), true);
  assert.equal(e.rates.getState().quotes.BRL.source, 'ExchangeRate-API');
  assert.equal(e.rates.getState().quotes.USDT.source, 'Fawaz Currency API');
  assert.equal(e.rates.getState().fetchedAt, '2026-10-23T12:00:00.000Z');
  assert.equal(e.rates.updatedAt(), '2026-10-23T00:00:00.000Z');
  assert.equal(e.rates.updatedAt('BRL','USD'), '2026-10-23T00:02:00.000Z');
  assert.equal(e.calls.every(c => c.init.credentials === 'omit'), true);
});

test('moedas e valores inválidos não viram BRL, USD ou zero', async () => {
  const e = setup(); await e.rates.refresh();
  for (const code of ['XXX','',null,undefined,{},'USDT.e']) {
    assert.equal(e.rates.ready(code, code), false);
    assert.equal(e.rates.ready(code, 'USD'), false);
    assert.equal(Number.isNaN(e.rates.convert(10, code, 'USD')), true);
  }
  for (const amount of [Infinity, -Infinity, NaN, '', '  ', null, undefined, {}, true]) assert.equal(Number.isNaN(e.rates.convert(amount,'BRL','BRL')), true);
  assert.equal(e.rates.convert(-10, 'USD', 'BRL'), -50);
  assert.equal(e.rates.convert('0', 'EUR', 'BRL'), 0);
});

test('falha de fiat usa a fonte alternativa completa', async () => {
  const e = setup({ fetch: (url) => { if (url === PRIMARY) throw new Error('network'); return ok(fallback()); } });
  await e.rates.refresh();
  assert.equal(e.rates.getState().status, 'ready');
  assert.equal(e.rates.getState().error, '');
  assert.equal(e.rates.convert(10,'USD','BRL'),50);
  assert.equal(e.rates.getState().quotes.BRL.source,'Fawaz Currency API');
});

test('falha dos dois espelhos de cripto não impede fiat nem cria stablecoins 1:1', async () => {
  const e = setup({ fetch: url => { if (url !== PRIMARY) throw new Error('offline'); return ok(primary()); } });
  await e.rates.refresh();
  assert.ok(Math.abs(e.rates.convert(10,'USD','EUR') - 9.2) < 1e-10);
  assert.equal(e.rates.ready('USD','USDT'), false);
  assert.equal(Number.isNaN(e.rates.convert(10,'USD','USDT')),true);
  assert.deepEqual(Array.from(e.rates.getState().missingCodes), ['USDT','USDC']);
  assert.equal(e.rates.getState().status,'partial');
  assert.match(e.rates.getState().error,/não puderam/);
});

test('falha do CDN usa o espelho documentado sem trocar a origem dos dados', async () => {
  const e = setup({ fetch: url => { if (url === CDN) return {ok:false,status:503}; return ok(url === PRIMARY ? primary() : fallback()); } });
  await e.rates.refresh();
  assert.equal(e.rates.getState().status,'ready');
  assert.deepEqual(e.calls.map(c => c.url),[PRIMARY,CDN,MIRROR]);
});

test('respostas parciais preservam cada moeda boa e completam pelo espelho', async () => {
  const first = fallback(); first.usd.usdt = -1;
  const second = fallback(); second.usd.usdc = null;
  const e = setup({ fetch: url => ok(url === PRIMARY ? primary() : url === CDN ? first : second) });
  await e.rates.refresh();
  assert.equal(e.rates.getState().status,'ready');
  assert.equal(e.rates.convert(1,'USD','USDT'),1.003);
  assert.equal(e.rates.convert(1,'USD','USDC'),.998);
});

test('uma moeda ausente mantém resultado parcial sem descartar as demais', async () => {
  const data = fallback(); delete data.usd.usdc;
  const e = setup({ fetch: url => ok(url === PRIMARY ? primary() : data) });
  await e.rates.refresh();
  assert.deepEqual(Array.from(e.rates.getState().missingCodes),['USDC']);
  assert.equal(e.rates.ready('BRL','EUR'),true);
  assert.equal(e.rates.ready('USDT','USD'),true);
  assert.equal(e.rates.ready('USDC','USD'),false);
});

test('recusa base e timestamps de origem inválidos; não inventa data de publicação', async () => {
  const invalid = [
    [primary({base_code:'EUR'}), fallback({date:'2026-02-30'})],
    [primary({time_last_update_unix:undefined}),fallback({date:undefined})],
    [primary({time_last_update_unix:(NOW + HOUR)/1000}),fallback({date:'2099-01-01'})],
    [primary({rates:{...VALUES,USD:2}}),fallback({usd:{...fallback().usd,usd:.9}})],
    [primary({time_last_update_unix:Date.parse('2020-01-01')/1000}),fallback({date:'2020-01-01'})],
  ];
  for (const [fiat, crypto] of invalid) {
    const e = setup({ fetch: url => ok(url === PRIMARY ? fiat : crypto) });
    await e.rates.refresh();
    assert.equal(e.rates.getState().status,'unavailable');
    assert.equal(e.rates.updatedAt(),null);
    assert.equal(e.rates.getState().fetchedAt,null);
  }
});

test('cache legado parcial migra com data de consulta desconhecida; sem inventar cripto', async () => {
  const e = setup({online:false, cache:{rate:{USD:1,BRL:5,EUR:.92,CLP:-2,USDT:1},at:'2026-10-20T00:00:00.000Z'}});
  e.rates.load();
  assert.equal(e.rates.convert(2,'USD','BRL'),10);
  assert.equal(e.rates.ready('USD','CLP'),false);
  assert.equal(e.rates.ready('USD','USDT'),false);
  assert.equal(e.rates.getState().quotes.BRL.fetchedAt,null);
  assert.equal(e.rates.getState().quotes.BRL.publishedAt,'2026-10-20T00:00:00.000Z');
  assert.equal(e.calls.length,0);
});

test('cache com futuros/valores inválidos rejeita apenas essas entradas', () => {
  const data = cache({ BRL:{fetchedAt:'2099-01-01'}, CLP:{rate:-1}, PYG:{publishedAt:'2026-02-30'}, EUR:{rate:'0.92'}, GBP:{publishedAt:'2026-10-23T12:10:00.000Z'} });
  const e = setup({online:false,cache:data}); e.rates.load();
  assert.deepEqual(Array.from(e.rates.getState().missingCodes),['BRL','CLP','PYG','EUR','GBP']);
  assert.equal(e.rates.ready('USDT','USDC'),true);
});

test('cache recém-consultado respeita fetchedAt, não faz loop pela publicação de ontem', async () => {
  const data = cache(); Object.values(data.quotes).forEach(q => q.publishedAt='2026-10-22T00:00:00.000Z');
  const e = setup({cache:data}); e.rates.load(); await flush();
  assert.equal(e.calls.length,0);
  await e.tick(HOUR - 1); assert.equal(e.calls.length,0);
  await e.tick(1); assert.equal(e.calls.length,2);
});

test('reload e falha de rede preservam taxa antiga com aviso de defasagem', async () => {
  const data = cache(); Object.values(data.quotes).forEach(q => { q.publishedAt='2026-10-19T00:00:00.000Z'; q.fetchedAt='2026-10-19T12:00:00.000Z'; });
  const e = setup({cache:data,fetch:()=>{throw new Error('network');}});
  e.rates.load(); await e.rates.refresh();
  assert.equal(e.rates.getState().status,'stale');
  assert.equal(e.rates.getState().staleCodes.length,7);
  assert.equal(e.rates.convert(10,'USD','BRL'),50);
  assert.equal(e.rates.getState().fetchedAt,'2026-10-19T12:00:00.000Z');
  const reloaded = setup({cache:JSON.parse(e.storage.get('fyg:rates')),online:false}); reloaded.rates.load();
  assert.equal(reloaded.rates.convert(10,'USD','BRL'),50);
});

test('resposta mais antiga não substitui cotação já guardada', async () => {
  const e = setup({cache:cache({BRL:{rate:5.5,publishedAt:'2026-10-23T02:00:00.000Z'}})});
  await e.rates.refresh();
  assert.equal(e.rates.convert(10,'USD','BRL'),55);
  assert.equal(e.rates.getState().quotes.BRL.publishedAt,'2026-10-23T02:00:00.000Z');
});

test('refresh concorrente compartilha Promise; load/ouvintes não duplicam pedidos', async () => {
  let release;
  const pending = new Promise(resolve => {release=resolve;});
  const e = setup({fetch:async url=>{await pending; return ok(url===PRIMARY?primary():fallback());}});
  let updates=0; const stop=e.rates.onUpdate(()=>updates++);
  const p=e.rates.refresh(); assert.equal(e.rates.refresh(),p); e.rates.load(); e.rates.load(); await flush();
  assert.equal(e.calls.length,2);
  assert.equal(e.rates.getState().refreshing,true);
  release(); await p;
  assert.equal(e.rates.getState().refreshing,false);
  assert.equal(updates,2); stop();
  await e.rates.refresh(); assert.equal(e.calls.length,2);
  assert.equal(e.docEvents.get('visibilitychange').length,1);
  assert.equal(e.events.get('online').length,1);
  assert.equal([...e.timers.values()].every(t=>t.unrefed),true);
});

test('backoff parcial não refaz fiat bom nem entra em loop; teto de uma hora', async () => {
  const e=setup({fetch:url=>{if(url!==PRIMARY)throw new Error('network');return ok(primary());}});
  await e.rates.refresh();
  assert.equal(e.calls.length,3);
  await e.tick(5*MINUTE-1); assert.equal(e.calls.length,3);
  await e.tick(1); assert.equal(e.calls.filter(c=>c.url===PRIMARY).length,1); assert.equal(e.calls.length,5);
  await e.tick(10*MINUTE); assert.equal(e.calls.length,7);
  await e.tick(20*MINUTE); assert.equal(e.calls.length,9);
  await e.tick(40*MINUTE); // inclui a única consulta horária de fiat
  assert.equal(e.calls.filter(c=>c.url===PRIMARY).length,2);
  assert.equal(e.calls.filter(c=>c.url===CDN).length,5);
  await e.tick(60*MINUTE);
  assert.equal(e.calls.filter(c=>c.url===CDN).length,6);
});

test('429 respeita 20 minutos mesmo com atualização manual repetida', async () => {
  const e=setup({fetch:()=>({ok:false,status:429})});
  await e.rates.refresh(); assert.equal(e.calls.length,3);
  await e.tick(MINUTE); await e.rates.refresh(); assert.equal(e.calls.length,3);
  await e.tick(19*MINUTE); assert.equal(e.calls.length,6);
});

test('online/visibility revalidam quando necessário; hidden e offline não deixam timer ativo', async () => {
  const e=setup({online:false}); e.rates.load(); assert.equal(e.calls.length,0);
  await e.online(true); assert.equal(e.calls.length,2);
  await e.visibility('hidden'); assert.equal(e.timers.size,0);
  await e.tick(2*HOUR); assert.equal(e.calls.length,2);
  await e.visibility('visible'); assert.equal(e.calls.length,4);
  await e.online(false); assert.equal(e.timers.size,0);
  await e.rates.refresh(); assert.match(e.rates.getState().error,/Sem conexão/);
  await e.online(true); assert.equal(e.calls.length,4);
  assert.equal(e.rates.getState().online,true);
  assert.equal(e.rates.getState().error,'');
});

test('carregamento em aba oculta aguarda visibilidade; atualização manual continua disponível', async () => {
  const e=setup({visible:false}); e.rates.load(); await flush();
  assert.equal(e.calls.length,0);
  assert.equal(e.timers.size,0);
  assert.equal(e.rates.getState().nextRetryAt,null);
  await e.online(true); assert.equal(e.calls.length,0);
  await e.visibility('visible'); assert.equal(e.calls.length,2);
  await e.visibility('hidden'); await e.tick(MINUTE);
  await e.rates.refresh(); assert.equal(e.calls.length,4);
  assert.equal(e.timers.size,0);
});

test('timeout aborta requisição travada e ainda publica os dados independentes', async () => {
  const e=setup({fetch:(url,init)=>url===PRIMARY?new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('timeout')))):ok(fallback())});
  const p=e.rates.refresh(); await flush(); await e.tick(8000); await p;
  assert.equal(e.calls[0].init.signal.aborted,true);
  assert.equal(e.rates.getState().status,'ready');
  assert.equal(e.rates.ready('USD','USDC'),true);
});

test('falha de persistência não perde cotações em memória; snapshots são cópias', async () => {
  const e=setup({storageFails:true}); await e.rates.refresh();
  const state=e.rates.getState(); state.quotes.BRL.rate=999; state.missingCodes.push('USD');
  const rates=e.rates.load(); rates.BRL=999;
  assert.equal(e.rates.convert(10,'USD','BRL'),50);
  assert.equal(e.rates.getState().status,'ready');
});

test('configuração anterior de quatro moedas usa só primário e tem fallback em falha', async () => {
  const codes=['BRL','CLP','PYG','USD'];
  const good=setup({codes}); await good.rates.refresh(); assert.equal(good.calls.length,1);
  const fail=setup({codes,fetch:url=>{if(url===PRIMARY)throw new Error('network');return ok(fallback());}});
  await fail.rates.refresh(); assert.equal(fail.calls.length,2);
  assert.equal(fail.rates.convert(10,'USD','BRL'),50);
});
