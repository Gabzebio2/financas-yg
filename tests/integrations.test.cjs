const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const app = path.resolve(__dirname, '..');

function environment(extra = {}) {
  const nodes = new Map();
  const storage = new Map();
  const callbacks = [];
  const context = {
    console: { log() {}, warn() {}, error() {} }, AbortController, AbortSignal,
    setTimeout, clearTimeout, Date, Promise, Map, Set,
    localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k,v) => storage.set(k,v), removeItem: (k) => storage.delete(k) },
    document: { addEventListener: (_, fn) => callbacks.push(fn) },
    $: (id) => {
      if (!nodes.has(id)) nodes.set(id, { value: '', innerHTML: '', textContent: '', disabled: false, listeners: new Map(), classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } }, addEventListener(event, fn) { this.listeners.set(event, fn); }, focus() {} });
      return nodes.get(id);
    },
    CURRENCY_CODES: ['BRL', 'CLP', 'PYG', 'USD', 'EUR', 'GBP', 'USDT', 'USDC'],
    CURRENCIES: Object.fromEntries(['BRL', 'CLP', 'PYG', 'USD', 'EUR', 'GBP', 'USDT', 'USDC'].map((c) => [c, { name: c, symbol: c }])),
    normCur: (c) => ['BRL','CLP','PYG','USD','EUR','GBP','USDT','USDC'].includes(c) ? c : 'BRL',
    curFrac: (c) => ['USDT', 'USDC'].includes(c) ? 6 : ['CLP', 'PYG'].includes(c) ? 0 : 2,
    stripAccents: (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim(),
    escapeHtml: (s) => String(s || ''), fmtMoney: (v,c) => `${c}:${v}`, fmtMoneyInput: (v,c) => `${c}:${v}`,
    daysInMonth: (y,m) => new Date(y,m,0).getDate(),
    isValidISODate: (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0,10) === s,
    dupTxKey: (...parts) => parts.join('|'),
    CARDS: ['C6'], toast() {}, location: { protocol: 'https:', hostname: 'test.invalid' },
    ...extra,
  };
  return { context: vm.createContext(context), nodes, storage, callbacks };
}

function load(env, file, name, instrument) {
  let source = fs.readFileSync(path.join(app, file), 'utf8');
  if (instrument) source = instrument(source);
  vm.runInContext(source + `\nthis.subject = ${name};`, env.context);
  return env.context.subject;
}

function batchEnv() {
  let saved;
  const confirmations = [];
  const env = environment({
    askConfirm(title, text, callback, options) { confirmations.push({ title, text, callback, options }); },
    Dashboard: {
      getCats: () => ['Outros'], resolveImportDate: (s) => s || '2026-01-01',
      existingTxKeys: () => new Set(), existingSeriesKeys: () => new Set(),
      appendImported: (rows) => { saved = rows; return rows.length; },
    },
  });
  const core = fs.readFileSync(path.join(app, 'js/app.js'), 'utf8');
  vm.runInContext(core.slice(core.indexOf('const ImportMatch ='), core.indexOf("// 'YYYY-MM-DD'")), env.context);
  const batch = load(env, 'js/batch.js', 'Batch', (s) => s.replace('return { open, openWithFiles, ingestAiResult, refreshPreview };', 'return { open, close, openWithFiles, ingestAiResult, refreshPreview, save, fromFiles };'));
  env.callbacks.forEach((fn) => fn());
  return { ...env, batch, saved: () => saved, confirmations, confirm: () => confirmations.at(-1)?.callback() };
}

test('parcelas retroativas opcionais atravessam janeiro com datas reais e dias limitados ao mês', () => {
  const env = batchEnv();
  env.batch.open();
  assert.equal(env.batch.ingestAiResult([{ data: '2026-01-31', valor: 25, descricao: 'Compra', tipo: 'despesa', moeda: 'BRL', parcela: '3/4' }], ''), 1);
  env.batch.refreshPreview();
  const generated = env.context.$('#batch-include-generated');
  assert.equal(generated.checked, false);
  generated.checked = true; generated.listeners.get('change')();
  env.batch.save();
  assert.equal(env.saved(), undefined);
  assert.equal(env.confirmations.length, 1); env.confirm();
  assert.deepEqual(Array.from(env.saved(), (r) => r.date), ['2025-11-30','2025-12-31','2026-01-31','2026-02-28']);
  assert.equal(new Set(env.saved().map((r) => r.groupId)).size, 1);
});

test('lote preserva moeda individual, recusa infinito e não reescreve anos de datas válidas', () => {
  const env = batchEnv();
  env.batch.open();
  assert.equal(env.batch.ingestAiResult([
    { data: '1999-01-01', valor: 10, descricao: 'Dólar', tipo: 'despesa', moeda: 'USD' },
    { data: '2026-01-01', valor: 20, descricao: 'Real', tipo: 'despesa', moeda: 'BRL' },
    { data: '2026-01-01', valor: Infinity, descricao: 'Inválido' }, null,
  ], ''), 2);
  env.batch.refreshPreview();
  env.batch.save();
  assert.equal(env.saved(), undefined);
  assert.equal(env.confirmations.length, 1); env.confirm();
  assert.deepEqual(Array.from(env.saved(), (r) => [r.currency, r.amount, r.date]), [['USD',10,'1999-01-01'],['BRL',20,'2026-01-01']]);
});

test('arquivo que termina de ler após fechar o lote não contamina o lote seguinte', async () => {
  let finish;
  const env = batchEnv();
  env.context.Importer = { readForBatch: () => new Promise((resolve) => { finish = resolve; }) };
  env.batch.open();
  const reading = env.batch.fromFiles([{ name: 'demo.xlsx', size: 10 }]);
  env.batch.close();
  env.batch.open();
  finish([{ date: '2026-01-01', desc: 'Antigo', amount: 30 }]);
  await reading;
  env.batch.refreshPreview();
  assert.match(env.context.$('#batch-tbody').innerHTML, /Nada reconhecido/);
});

test('transações iguais em moedas diferentes continuam selecionadas', () => {
  const env = batchEnv();
  env.batch.open();
  env.batch.ingestAiResult([{ data:'2026-01-01', valor:10, descricao:'Compra', tipo:'despesa', moeda:'USD' }], '');
  env.batch.ingestAiResult([{ data:'2026-01-01', valor:10, descricao:'Compra', tipo:'despesa', moeda:'BRL' }], '');
  assert.equal(env.batch.refreshPreview(),0);
  env.batch.save();
  assert.equal(env.saved(), undefined);
  assert.equal(env.confirmations.length, 1); env.confirm();
  assert.equal(env.saved().length,2);
});

test('cache incompleto ou negativo de cotação é rejeitado e usa retorno validado', async () => {
  const calls = [];
  const env = environment({ fetch: async (url) => {
    calls.push(url);
    return { ok: true, json: async () => url.includes('open.er-api.com')
      ? { result: 'success', base_code: 'USD', time_last_update_unix: Math.floor(Date.now() / 1000), rates: { USD: 1, BRL: 5, CLP: 900, PYG: 7000, EUR: 0.9, GBP: 0.8 } }
      : { date: new Date().toISOString().slice(0, 10), usd: { usd: 1, brl: 5, clp: 900, pyg: 7000, eur: 0.9, gbp: 0.8, usdt: 1.001, usdc: 0.999 } } };
  } });
  env.storage.set('fyg:rates', JSON.stringify({ rate: { USD: 1, BRL: -7 }, at: '2099-01-01' }));
  const rates = load(env, 'js/rates.js', 'Rates');
  rates.load();
  assert.equal(rates.ready('USD','BRL'), false);
  assert.equal(Number.isNaN(rates.convert(10,'USD','BRL')), true);
  await new Promise(setImmediate);
  assert.deepEqual(calls, ['https://open.er-api.com/v6/latest/USD', 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json']);
  assert.equal(rates.convert(10, 'USD','BRL'), 50);
  assert.equal(Number.isNaN(rates.convert(Infinity, 'USD','BRL')), true);
  assert.equal(rates.convert(1, 'USD', 'USDT'), 1.001);
  assert.equal(rates.convert(1, 'USD', 'USDC'), 0.999);
});

test('importação de fatura respeita colunas explícitas de receita e despesa', async () => {
  const rows = [['Data', 'Descrição', 'Receita', 'Despesa'], ['2026-01-01', 'Entrada', 150, null], ['2026-01-02', 'Compra', null, 20]];
  const env = environment({
    parseMoney: (n) => typeof n === 'number' ? n : null,
    parseDateCell: (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s : null,
    uid: (() => { let n=0; return () => `t${++n}`; })(),
    XLSX: { read: () => ({ SheetNames: ['Sheet'], Sheets: { Sheet: {} } }), utils: { sheet_to_json: () => rows } },
  });
  const importer = load(env, 'js/importer.js', 'Importer');
  const items = await importer.readForBatch({ size: 10, arrayBuffer: async () => new ArrayBuffer(0) });
  assert.deepEqual(Array.from(items, (r) => [r.type,r.amount]), [['receita',150],['despesa',20]]);
});

function importerWithCore(rows, sheetName = 'Planilha') {
  let opened;
  const env = environment({
    window: { top: null, self: null, scrollTo() {} },
    setTimeout: () => 1, clearTimeout() {},
    Dashboard: { open: (id) => { opened = id; } },
    XLSX: { read: () => ({ SheetNames: [sheetName], Sheets: { [sheetName]: {} } }), utils: { sheet_to_json: () => rows } },
  });
  env.context.document.querySelector = env.context.$;
  env.context.document.querySelectorAll = () => [];
  Object.defineProperty(env.context.localStorage, 'length', { get: () => env.storage.size });
  env.context.localStorage.key = (index) => [...env.storage.keys()][index] ?? null;
  load(env, 'js/app.js', 'Store');
  const store = env.context.subject;
  const importer = load(env, 'js/importer.js', 'Importer', (s) => s.replace('return { handleFile, readForBatch };', 'return { handleFile, readForBatch, savePending };'));
  return { ...env, store, importer, opened: () => opened, file: { name: 'moedas.xlsx', size: 100, arrayBuffer: async () => new ArrayBuffer(0) } };
}

test('importador usa moeda por linha e parser real sem descartar microvalores ou assumir USD', async () => {
  const env = importerWithCore([
    ['Data', 'Descrição', 'Valor original', 'Moeda original'],
    ['2026-01-01', 'Euro', '€ 12,34', 'EUR'],
    ['2026-01-01', 'Libra', '£ 5.67', 'GBP'],
    ['2026-01-01', 'Tether', '1.234', 'USDT'],
    ['2026-01-01', 'USDC', '0.000001', 'USDC'],
    ['2026-01-01', 'USD', 'US$ 1.25', 'USD'],
    ['2026-01-01', 'Inválida', 5, 'DEFAULT'],
    ['2026-01-01', 'Desconhecida', 5, 'CHF'],
  ]);
  const items = await env.importer.readForBatch(env.file);
  assert.deepEqual(Array.from(items, (r) => [r.currency, r.amount]), [['EUR',12.34],['GBP',5.67],['USDT',1.234],['USDC',0.000001],['USD',1.25]]);
  assert.ok(items.every((row) => row.type === 'despesa'));
});

test('importação matriz e detecção de stablecoin mantêm moeda e sexta casa decimal', async () => {
  const matrix = importerWithCore([
    ['Data', 'Descrição', 'Moeda', 'Jan/2026', 'Fev/2026'],
    ['2026-01-31', 'Parcelas', 'USDC', '0.000001', '1.234'],
  ]);
  const items = await matrix.importer.readForBatch(matrix.file);
  assert.deepEqual(Array.from(items, (r) => [r.currency, r.amount, r.date]), [['USDC',0.000001,'2026-01-31'],['USDC',1.234,'2026-02-28']]);
  for (const code of ['USDT', 'USDC']) {
    const single = importerWithCore([['Data', 'Descrição', 'Valor'], ['2026-01-01', code, '1.234']], code);
    const result = await single.importer.readForBatch(single.file);
    assert.equal(result[0].currency, code);
    assert.equal(result[0].amount, 1.234);
  }
});

test('prévia separa totais por moeda e nova pasta importada usa DEFAULT sem converter valores', async () => {
  const env = importerWithCore([
    ['Data', 'Descrição', 'Tipo', 'Valor', 'Moeda'],
    ['2026-01-01', 'Euro', 'despesa', 12.34, 'EUR'],
    ['2026-01-02', 'Libra', 'despesa', 5.67, 'GBP'],
    ['2026-01-03', 'Tether', 'receita', 1.234567, 'USDT'],
    ['2026-01-04', 'USDC', 'despesa', 0.000001, 'USDC'],
  ]);
  await env.importer.handleFile(env.file);
  const stats = env.context.$('#import-stats').innerHTML;
  assert.match(stats, /€|EUR/); assert.match(stats, /£|GBP/);
  assert.match(stats, /USDT 1\.234567/); assert.match(stats, /USDC 0\.000001/);
  env.importer.savePending();
  const dataset = env.store.loadDataset(env.opened());
  assert.equal(dataset.displayCurrency, 'DEFAULT');
  assert.deepEqual(Array.from(dataset.transactions, (r) => [r.currency, r.amount]), [['EUR',12.34],['GBP',5.67],['USDT',1.234567],['USDC',0.000001]]);
});

test('planilha nova não elimina duas compras iguais e só salva após revisão contextual', async () => {
  const env = importerWithCore([
    ['Data','Descrição','Valor','Conta','Referência'],
    ['2026-01-01','Compra',25,'Wise','REF-1'],
    ['2026-01-01','Compra',25,'Wise','REF-2']
  ]);
  env.callbacks.at(-1)();
  await env.importer.handleFile(env.file);
  env.importer.savePending(); assert.equal(env.opened(), undefined);
  const review = env.context.$('#import-duplicate-review');
  assert.match(review.innerHTML, /referências diferentes/);
  review.listeners.get('click')({ target: { closest: () => ({ dataset: { importDistinct: '1' } }) } });
  env.importer.savePending();
  const saved = env.store.loadDataset(env.opened());
  assert.equal(saved.transactions.length, 2);
  assert.deepEqual(Array.from(saved.transactions, (t) => [t.account, t.referenceId]), [['Wise','REF-1'],['Wise','REF-2']]);
  env.context.rawImported = saved;
  const clean = vm.runInContext('sanitizeDataset(rawImported, {preserveIds:true,preserveContent:true,rejectInvalidTransactions:true})', env.context);
  assert.deepEqual(Array.from(clean.transactions, (t) => t.referenceId), ['REF-1','REF-2']);
});

test('importação para pasta atual reconsulta registros ao salvar e permite excluir só a repetição', async () => {
  const env = importerWithCore([['Data','Descrição','Valor','Conta'],['2026-01-01','Compra',25,'Wise'],['2026-01-02','Outra',26,'Wise']]);
  let existing = [], saved;
  Object.assign(env.context.Dashboard, { getImportTargetId: () => 'folder1', currentDatasetName: () => 'Teste', existingTransactions: () => existing,
    appendImported: (rows) => { saved = rows; return rows.length; } });
  env.callbacks.at(-1)();
  await env.importer.handleFile(env.file, { addToCurrent: true });
  existing = [{ id: 'new1', date: '2026-01-01', desc: 'Compra', amount: 25, type: 'despesa', currency: 'BRL', account: 'Wise' }];
  env.importer.savePending(); assert.equal(saved, undefined);
  const review = env.context.$('#import-duplicate-review');
  assert.match(review.innerHTML, /Já na pasta/);
  review.listeners.get('change')({ target: { dataset: { importSelect: '0' }, checked: false } });
  env.importer.savePending(); assert.equal(saved.length, 1); assert.equal(saved[0].desc, 'Outra');
});

test('planilha com linhas ignoradas exige revisão explícita e preserva referências no lote', async () => {
  const env = importerWithCore([['Data','Descrição','Valor','Conta','Referência'],['2026-01-01','Compra',25,'Wise','ABC'],['inválida','Incompleto',20,'Wise','DEF']]);
  env.callbacks.at(-1)();
  const list = await env.importer.readForBatch(env.file);
  assert.equal(list[0].account, 'Wise'); assert.equal(list[0].referenceId, 'ABC');
  assert.equal(list.readReport.skipped, 1);
  await env.importer.handleFile(env.file);
  env.importer.savePending(); assert.equal(env.opened(), undefined);
  const review = env.context.$('#import-duplicate-review');
  review.listeners.get('change')({ target: { hasAttribute: () => true, checked: true } });
  env.importer.savePending(); assert.equal(env.store.loadDataset(env.opened()).transactions.length, 1);
});

test('célula monetária ilegível é reportada mesmo quando outra célula da linha é válida', async () => {
  for (const rows of [
    [['Data','Descrição','Jan/2026','Fev/2026'], ['2026-01-10','Compra',10,'ilegível']],
    [['Data','Descrição','Receita','Despesa'], ['2026-01-10','Compra',10,'ilegível']]
  ]) {
    const env = importerWithCore(rows), result = await env.importer.readForBatch(env.file);
    assert.equal(result.length, 1); assert.equal(result.readReport.skipped, 1);
    await env.importer.handleFile(env.file); env.importer.savePending(); assert.equal(env.opened(), undefined);
  }
});

test('planilha não confirma comparação nova no clique antigo nem perde prévia se commit retorna zero', async () => {
  const env = importerWithCore([['Data','Descrição','Valor','Conta'], ['2026-01-01','Compra',25,'Wise']]);
  const existing = [{ id: 'old1', date: '2026-01-01', desc: 'Compra', amount: 25, type: 'despesa', currency: 'BRL', account: 'Wise' }];
  let attempts = 0;
  Object.assign(env.context.Dashboard, { getImportTargetId: () => 'folder1', currentDatasetName: () => 'Teste', existingTransactions: () => existing,
    appendImported: () => { attempts++; return 0; } });
  env.callbacks.at(-1)(); await env.importer.handleFile(env.file, { addToCurrent: true });
  const review = env.context.$('#import-duplicate-review');
  const confirm = () => review.listeners.get('click')({ target: { closest: () => ({ dataset: { importDistinct: '0' } }) } });
  existing.push({ ...existing[0], id: 'new1' }); confirm(); env.importer.savePending(); assert.equal(attempts, 0);
  confirm(); env.importer.savePending(); assert.equal(attempts, 1);
  env.importer.savePending(); assert.equal(attempts, 2); // prévia não foi descartada
});

test('loader CSV real preserva UTF-8, decimais e referências sem inferência do SheetJS', async () => {
  const csv = 'Data;Descrição;Valor;Tipo;Categoria;Conta;Moeda;Referência\r\n2026-10-27;DEMONSTRAÇÃO café;25.00;despesa;Alimentação;Itaú;BRL;000123\r\n2026-10-27;Microvalor;1.000001;receita;Outros;Wise;USDC;000124\r\n';
  const env = importerWithCore([]);
  env.context.XLSX = require('../lib/xlsx.min.js'); env.context.TextDecoder = TextDecoder;
  const file = { name: 'sintetico.csv', type: 'text/csv', size: Buffer.byteLength(csv), arrayBuffer: async () => Buffer.from(csv, 'utf8') };
  const items = await env.importer.readForBatch(file);
  assert.deepEqual(Array.from(items, (t) => [t.desc, t.amount, t.category, t.account, t.currency, t.referenceId]), [
    ['DEMONSTRAÇÃO café',25,'Alimentação','Itaú','BRL','000123'], ['Microvalor',1.000001,'Outros','Wise','USDC','000124']
  ]);
  await env.importer.handleFile(file); env.importer.savePending();
  const saved = env.store.loadDataset(env.opened());
  assert.equal(saved.transactions[0].amount, 25); assert.equal(saved.transactions[0].desc, 'DEMONSTRAÇÃO café');
});

test('loader CSV com vírgula e campos citados mantém valor decimal e descrição contendo vírgula', async () => {
  const csv = '\uFEFFData,Descrição,Valor,Tipo,Conta,Moeda\n2026-10-27,"Café, padaria","25,00",despesa,Itaú,BRL\n';
  const env = importerWithCore([]); env.context.XLSX = require('../lib/xlsx.min.js'); env.context.TextDecoder = TextDecoder;
  const items = await env.importer.readForBatch({ name: 'sintetico.csv', size: 200, arrayBuffer: async () => Buffer.from(csv, 'utf8') });
  assert.equal(items.length, 1); assert.equal(items[0].amount, 25); assert.equal(items[0].desc, 'Café, padaria');
});

test('CSV real com decimais brasileiros não multiplica valores por cem nem perde microvalor', async () => {
  const csv = '\uFEFFData;Descrição;Valor;Tipo;Moeda\n2026-10-27;Café;25,00;despesa;BRL\n2026-10-27;Compra;1.234,56;despesa;BRL\n2026-10-27;Micro;0,000001;receita;USDC\n';
  const env = importerWithCore([]); env.context.XLSX = require('../lib/xlsx.min.js'); env.context.TextDecoder = TextDecoder;
  const items = await env.importer.readForBatch({ name: 'sintetico.csv', size: 200, arrayBuffer: async () => Buffer.from(csv, 'utf8') });
  assert.deepEqual(Array.from(items, (r) => [r.amount,r.currency]), [[25,'BRL'],[1234.56,'BRL'],[0.000001,'USDC']]);
});

function apiEnv(providerReply) {
  let calls = 0;
  const env = environment({
    module: { exports: {} }, process: { env: { GEMINI_API_KEY: 'test-key' } },
    fetch: async (url) => { calls++; return { ok: true, status: 200, json: async () => url.includes('/auth/v1/user') ? { id: 'test-user' } : providerReply }; },
  });
  vm.runInContext(fs.readFileSync(path.join(app, 'api/receipt.js'), 'utf8'), env.context);
  const response = { headers: {}, setHeader(k,v) { this.headers[k]=v; }, status(n) { this.code=n; return this; }, json(body) { this.body=body; } };
  return { handler: env.context.module.exports, response, calls: () => calls };
}

test('API rejeita base64 inválido antes de chamar IA', async () => {
  const env = apiEnv({});
  await env.handler({ method:'POST', headers:{ authorization:'Bearer fake' }, body:{ image:{ media_type:'image/png', data:'not image' } } }, env.response);
  assert.equal(env.response.code,400);
  assert.equal(env.calls(),1);
  assert.equal(env.response.headers['Cache-Control'],'no-store');
});

test('API sinaliza extração parcial e remove valores e datas impossíveis', async () => {
  const text = JSON.stringify({ cartao:'C6', itens:[{ valor: 10, descricao:'Compra', data:'2026-02-31', moeda:'USD', categoria:'Outros', tipo:'despesa' }, { valor: -5 }] });
  const env = apiEnv({ candidates:[{ finishReason:'MAX_TOKENS', content:{ parts:[{ text }] } }] });
  await env.handler({ method:'POST', headers:{ authorization:'Bearer fake' }, body:{ image:{ media_type:'image/png', data:'aGVsbG8=' }, multi:true, cards:['C6'], categories:['Outros'] } }, env.response);
  assert.equal(env.response.code,200);
  assert.equal(env.response.body.partial,true);
  assert.equal(env.response.body.itens.length,1);
  assert.equal(env.response.body.itens[0].data,'');
  assert.equal(env.response.body.itens[0].moeda,'USD');
});

// Corridas de exclusão durante pull e logout estão em cloud-recovery.test.cjs,
// usando Store real, fila persistente e servidor simulado com controle de versão.

test('preparo de comprovantes rejeita limites de arquivo e falha de canvas sem travar', async () => {
  const env = environment({
    FileReader: class { readAsDataURL() { this.result='data:image/png;base64,aGVsbG8='; this.onload(); } },
    Image: class { constructor() { this.width=10; this.height=10; } set src(_) { this.onload(); } },
    document: { addEventListener() {}, createElement: () => ({ getContext: () => null }) },
  });
  const receipt = load(env, 'js/receipt.js', 'Receipt');
  await assert.rejects(receipt.prepareFile({ type:'application/pdf', size:4*1024*1024 }), /pdf_grande/);
  await assert.rejects(receipt.prepareImage({ size:21*1024*1024 }), /imagem_grande/);
  await assert.rejects(receipt.prepareImage({ size:10 }), /imagem/);
});
