const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../js/batch.js'), 'utf8');

function setup(extra = {}) {
  const nodes = new Map(), ready = [], notices = [];
  let saved, savedCount = 0, activeConfirmation = null;
  const confirmations = [];
  function node(id) {
    if (!nodes.has(id)) {
      const events = new Map(), classes = new Set();
      nodes.set(id, {
        value: '', innerHTML: '', textContent: '', checked: false, disabled: false,
        dataset: {}, className: '',
        classList: { add: (s) => classes.add(s), remove: (s) => classes.delete(s), contains: (s) => classes.has(s), toggle(s, yes) { if (yes ?? !classes.has(s)) classes.add(s); else classes.delete(s); } },
        addEventListener(name, fn) { events.set(name, fn); },
        fire(name, target) { return events.get(name)?.({ target: target || this }); },
        focus() {}, click() { this.fire('click'); },
      });
    }
    return nodes.get(id);
  }
  const currencies = ['BRL', 'CLP', 'PYG', 'USD', 'EUR', 'GBP', 'USDT', 'USDC'];
  const env = {
    console: { error() {} }, setTimeout, clearTimeout, AbortSignal,
    document: { addEventListener: (name, fn) => ready.push(fn) }, $: node,
    location: { protocol: 'https:', hostname: 'test.invalid' },
    CURRENCY_CODES: currencies, CURRENCIES: Object.fromEntries(currencies.map((c) => [c, { name: c, symbol: c }])),
    CARDS: ['C6', 'Nubank Gab'],
    normCur: (c) => currencies.includes(c) ? c : 'BRL',
    curFrac: (c) => ['USDT', 'USDC'].includes(c) ? 6 : ['CLP', 'PYG'].includes(c) ? 0 : 2,
    stripAccents: (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim(),
    escapeHtml: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    fmtMoney: (n, c) => `${c} ${n}`, fmtMoneyInput: (n) => String(n),
    isValidISODate: (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s,
    daysInMonth: (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(),
    dupTxKey: (...v) => v.join('|'),
    maskMoneyEl() {}, moneyInputValue: (el) => Number(el.value),
    toast: (msg) => notices.push(msg),
    askConfirm(title, text, callback, options) {
      activeConfirmation = { title, text, callback, options }; confirmations.push(activeConfirmation);
      node('#modal-confirm').classList.remove('hidden');
    },
    Dashboard: { getCats: () => ['Essencial', 'Outros'], existingTxKeys: () => new Set(), existingSeriesKeys: () => new Set(), appendImported(rows) { savedCount++; saved = JSON.parse(JSON.stringify(rows)); return rows.length; } },
    Receipt: { prepareFile: async () => ({ mediaType: 'image/png', data: 'fake' }) },
    Cloud: { getToken: () => 'test-token' },
    ...extra,
  };
  const context = vm.createContext(env);
  const core = fs.readFileSync(path.resolve(__dirname, '../js/app.js'), 'utf8');
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../js/import-dates.js'), 'utf8'), context);
  vm.runInContext(core.slice(core.indexOf('const ImportMatch ='), core.indexOf("// 'YYYY-MM-DD'")), context);
  vm.runInContext(source.replace('return { open, openWithFiles, ingestAiResult, refreshPreview };', 'return { open, close, openWithFiles, ingestAiResult, refreshPreview, save, fromPhotos, fromFiles };') + '\nthis.batch = Batch;', context);
  ready.forEach((fn) => fn());
  const batch = context.batch;
  batch.open();
  node('#modal-confirm').classList.add('hidden');
  return { batch, node, notices, saved: () => saved, savedCount: () => savedCount, context, confirmations,
    confirm() { const c = activeConfirmation; activeConfirmation = null; node('#modal-confirm').classList.add('hidden'); c?.callback(); },
    cancel() { activeConfirmation = null; node('#modal-confirm').classList.add('hidden'); } };
}

const item = (changes = {}) => ({ data: '2026-01-31', descricao: 'Compra', valor: 25, moeda: 'BRL', tipo: 'despesa', categoria: 'Essencial', ...changes });
const complete = (pagesRead = [1]) => ({ complete: true, pagesRead, unreadablePages: [] });
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const verified = (itens, changes = {}) => ({ review: { status: 'verified', provider: 'openai', model: 'test-review', checkedCount: itens.length,
  items: itens.map((_, index) => ({ index, status: 'verified', reasons: [] })), additionalItems: [], issues: [], coverage: complete(), ...changes } });
function withDocument(itens, changes = {}) {
  const calls = [];
  const env = setup({ fetch: async (_, request) => {
    const body = JSON.parse(request.body); calls.push(body);
    return response(body.reviewOf ? verified(itens, changes) : { itens, cartao: 'C6', coverage: complete(), partial: false });
  } });
  return { ...env, calls, read: () => env.batch.fromPhotos([{ name: 'documento.png', size: 10 }]) };
}
function edit(env, index, field, value) { env.node('#batch-tbody').fire('input', { dataset: { i: String(index), f: field }, value }); }
test('retomar documento privado restaura USD e cashback; só Incluir confirma na nuvem',async()=>{
  const commits=[];let synced=0,refreshed=0;
  const env=setup({ReceiptJobs:{commit:async(id,txs)=>{commits.push({id,txs});return {transactions:txs};},refresh(){}},Cloud:{getToken:()=> 'session',syncNow:async()=>{synced++;return true;}}});
  env.context.Dashboard.refreshFromStore=()=>{refreshed++;};
  const data={itens:[item({valor:8.78,moeda:'USD',cashback:{valor:.08,moeda:'USD'},incertezas:[],revisar:[]})],cartao:'',excluded:[],avisos:[],partial:false,verified:true,reviewMode:'automatic',ledger:{monetaryLines:0,accounted:0,missing:[]}};
  env.batch.open({backgroundJob:{job:{id:'private-job',status:'ready',extra_rows:[]},pages:[{document_id:'doc1',label:'print',context:{pageStart:1,pageEnd:1,totalPages:1},quick:true,first_result:data,result:data}]}});
  assert.equal(commits.length,0);assert.equal(env.node('#btn-batch-save').disabled,false);
  env.batch.save();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(commits.length,1);assert.equal(commits[0].id,'private-job');assert.equal(commits[0].txs[0].currency,'USD');assert.equal(commits[0].txs[0].amount,8.78);assert.equal(commits[0].txs[0].cashback.amount,.08);assert.equal(synced,1);assert.equal(refreshed,1);assert.equal(env.savedCount(),0);
});
test('erro de confirmação mantém a prévia e permite repetir o mesmo job sem recriar lançamentos',async()=>{
 let attempts=0;const env=setup({ReceiptJobs:{commit:async()=>{attempts++;throw Error('network');},refresh(){}}});
 const data={itens:[item()],excluded:[],avisos:[],partial:false,verified:true,reviewMode:'automatic',ledger:{monetaryLines:0,accounted:0,missing:[]}};
 env.batch.open({backgroundJob:{job:{id:'same-job',status:'ready',extra_rows:[]},pages:[{document_id:'doc1',label:'print',context:{pageStart:1,pageEnd:1,totalPages:1},quick:true,first_result:data,result:data}]}});
 env.batch.save();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(env.node('#modal-batch').classList.contains('hidden'),false);assert.equal(env.savedCount(),0);
 env.batch.save();await new Promise(resolve=>setImmediate(resolve));assert.equal(attempts,2);
});
function select(env, index, checked) { env.node('#batch-tbody').fire('change', { dataset: { i: String(index) }, checked, classList: { contains: () => true }, closest: () => ({ classList: { toggle() {} } }) }); }
function projections(env, on = true) { env.node('#batch-include-generated').checked = on; env.node('#batch-include-generated').fire('change'); }
function ingest(env, items, card = 'C6', metadata = {}) { env.batch.ingestAiResult(items, card, metadata); env.batch.refreshPreview(); }

test('plataforma única fica pré-selecionada e é salva; lote misto preserva conta por arquivo', () => {
  const env = setup({CARDS:['Ether.fi','Ueno','Itaú','Ugly Cash']});
  ingest(env, [item({valor:8.78,moeda:'USD'})], 'Ether.fi');
  assert.equal(env.node('#batch-acc').value,'Ether.fi');
  ingest(env, [item({valor:15000,moeda:'PYG',descricao:'Mercado'})], 'Ueno');
  assert.equal(env.node('#batch-acc').value,'original');
  env.batch.save(); env.confirm();
  assert.deepEqual(env.saved().map(r=>[r.account,r.currency,r.amount]),[['Ether.fi','USD',8.78],['Ueno','PYG',15000]]);
});
test('conta desconhecida não herda a anterior e escolha manual permanece após nova leitura', () => {
  const env = setup({CARDS:['Ether.fi','Ueno','Itaú','Ugly Cash']});
  ingest(env, [item()], 'Ugly Cash');
  ingest(env, [item({valor:30})], '');
  assert.equal(env.node('#batch-acc').value,'original');
  env.node('#batch-acc').value='Itaú'; env.node('#batch-acc').fire('change');
  ingest(env, [item({valor:40})], 'Ueno');
  assert.equal(env.node('#batch-acc').value,'Itaú');
  env.batch.save(); env.confirm(); assert.deepEqual(env.saved().map(r=>r.account),['Itaú','Itaú','Itaú']);
});
test('retomar resultado privado mantém seleção da plataforma e inclusão direta após conferência automática', async () => {
  let transactions;
  const env = setup({CARDS:['Ugly Cash'],ReceiptJobs:{commit:async(_,txs)=>{transactions=txs;return {transactions:txs};},refresh(){}},Cloud:{getToken:()=> 'session',syncNow:async()=>true}});
  const data={itens:[item({instituicao:'Ugly Cash'})],cartao:'Ugly Cash',excluded:[],avisos:[],partial:false,verified:true,reviewMode:'automatic',ledger:{monetaryLines:0,accounted:0,missing:[]}};
  env.batch.open({backgroundJob:{job:{id:'job',status:'ready',extra_rows:[]},pages:[{document_id:'doc',label:'print',context:{pageStart:1,pageEnd:1,totalPages:1},quick:true,first_result:data,result:data}]}});
  assert.equal(env.node('#batch-acc').value,'Ugly Cash'); assert.equal(env.node('#btn-batch-save').disabled,false);
  env.batch.save(); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(env.confirmations.length,0); assert.equal(transactions[0].account,'Ugly Cash');
});

test('duas leituras automáticas concordantes incluem de uma vez sem enviar histórico local', async () => {
  const originals = [item({ tipo: 'receita', valor: 100, moeda: 'USD' }), item({ valor: 40 })];
  const env = withDocument(originals);
  env.context.Dashboard.existingTransactions = () => [{ id: 'private', date: '2025-01-01', desc: 'HISTORICO PRIVADO', amount: 999, type: 'despesa', currency: 'BRL' }];
  await env.read();
  assert.equal(env.calls.length, 2);
  const [first, second] = env.calls;
  assert.deepEqual(second.image, first.image); assert.deepEqual(second.documentContext, first.documentContext);
  assert.deepEqual(second.reviewOf, { itens: originals, cartao: 'C6', coverage: complete(), partial: false });
  assert.doesNotMatch(JSON.stringify(env.calls), /HISTORICO PRIVADO/);
  assert.equal(env.node('#batch-details').open, false);
  assert.equal(env.node('#btn-batch-save').disabled, false);
  env.node('#btn-batch-save').click();
  assert.equal(env.confirmations.length, 0); assert.equal(env.saved().length, 2);
});

test('divergência, adicional e coincidência fraca ficam selecionadas e uma confirmação inclui tudo', async () => {
  const env = withDocument([item(), item({ descricao: 'Outro café' })], { status: 'attention',
    items: [{ index: 0, status: 'verified', reasons: [] }, { index: 1, status: 'attention', reasons: ['Confira o valor'] }],
    additionalItems: [item({ valor: 40, descricao: 'Item adicional' })] });
  await env.read();
  assert.equal(env.node('#btn-batch-save').disabled, false);
  assert.doesNotMatch(env.node('#batch-tbody').innerHTML, /data-reviewed|data-distinct/);
  env.batch.save(); assert.equal(env.saved(), undefined); assert.equal(env.confirmations.length, 1);
  assert.match(env.confirmations[0].text, /3 lançamento\(s\)/);
  assert.match(env.confirmations[0].text, /possível\(is\) duplicata/);
  env.confirm(); assert.deepEqual(env.saved().map((r) => r.amount), [25,25,40]);
});

test('falha da segunda conferência preserva itens, habilita CTA e pede uma aceitação explícita', async () => {
  const env = setup({ fetch: async (_, request) => JSON.parse(request.body).reviewOf ? response({ error: 'revisao_indisponivel' }, 503) : response({ itens: [item()], coverage: complete(), partial: false }) });
  await env.batch.fromPhotos([{ name: 'foto.png', size: 10 }]);
  assert.equal(env.node('#btn-batch-save').disabled, false);
  assert.equal(env.node('#batch-verification').classList.contains('is-verified'), false);
  env.batch.save();
  assert.equal(env.confirmations[0].options.confirmLabel, 'Incluir sem a segunda conferência');
  assert.match(env.confirmations[0].text, /cobertura incompleta/);
  env.confirm(); assert.equal(env.saved()[0].amount, 25);
});

test('cobertura parcial e avisos de auditoria são aceitos juntos sem checkbox nem confirmação por linha', async () => {
  const env = withDocument([item()], { coverage: { complete: false, pagesRead: [], unreadablePages: [1] }, issues: ['Total não confirmado'] });
  await env.read(); env.batch.save();
  assert.equal(env.node('#btn-batch-save').disabled, false);
  assert.equal(env.confirmations.length, 1); assert.equal(env.saved(), undefined);
  env.confirm(); assert.equal(env.saved().length, 1);
});

test('data ausente com vizinhos do mesmo arquivo é estimada e incluída com metadados após uma confirmação', async () => {
  const env = withDocument([item({ data: '2026-01-10', valor: 10 }), item({ data: '', valor: 20 }), item({ data: '2026-01-14', valor: 30 })]);
  await env.read();
  assert.match(env.node('#batch-review-summary').textContent, /1 data\(s\) estimada/);
  assert.equal(env.node('#btn-batch-save').disabled, false);
  env.batch.save(); assert.equal(env.confirmations.length, 1); // estimate is already disclosed in the preview
  env.confirm();
  assert.equal(env.saved()[1].date, '2026-01-12'); assert.equal(env.saved()[1].dateEstimated, true);
  assert.deepEqual(env.saved()[1].dateEstimate, { method: 'between', previousDate: '2026-01-10', nextDate: '2026-01-14' });
  assert.equal(env.saved()[0].dateEstimated, undefined);
});

test('arquivo sem âncora não toma data emprestada de outro, e item inválido fica fora com razão visível', async () => {
  const env = setup({ fetch: async (_, request) => {
    const body = JSON.parse(request.body), itens = [item({ data: body.image.data === 'a' ? '' : '2026-01-15', valor: body.image.data === 'a' ? 10 : 20 })];
    return response(body.reviewOf ? verified(itens) : { itens, coverage: complete(), partial: false });
  }, Receipt: { async *prepareParts(file) { yield { data: file.name, mediaType: 'image/png', label: 'imagem', documentContext: { pageStart: 1, pageEnd: 1, totalPages: 1 } }; } } });
  await env.batch.fromPhotos([{ name: 'a', size: 10 },{ name: 'b', size: 10 }]);
  assert.match(env.node('#batch-count').textContent, /1 de 2 selecionadas/);
  assert.match(env.node('#batch-review-summary').textContent, /sem dados válidos ficaram fora/);
  env.batch.save(); env.confirm(); assert.equal(env.saved().length, 1); assert.equal(env.saved()[0].amount, 20);
});

test('nenhum item válido mantém botão desabilitado e a correção opcional permite inclusão', async () => {
  const env = withDocument([item({ data: '' })]); await env.read();
  assert.equal(env.node('#btn-batch-save').disabled, true);
  assert.match(env.node('#batch-verification-title').textContent, /Nenhum lançamento válido/);
  env.batch.save(); assert.equal(env.saved(), undefined); assert.equal(env.confirmations.length, 0);
  edit(env, 0, 'date', '2026-02-01');
  assert.equal(env.node('#btn-batch-save').disabled, false);
  env.batch.save(); env.confirm(); assert.equal(env.saved()[0].date, '2026-02-01');
});

test('edição manual de data estimada elimina sua marca e vira âncora observada', async () => {
  const env = withDocument([item({ data: '2026-01-10', valor: 10 }),item({ data: '', valor: 20 })]);
  await env.read(); edit(env, 1, 'date', '2026-01-20'); env.batch.save(); env.confirm();
  assert.equal(env.saved()[1].date, '2026-01-20'); assert.equal(env.saved()[1].dateEstimated, undefined);
  assert.equal(env.saved()[1].dateEstimate, undefined);
});

test('mesma referência e dados exatos são desmarcados, sem excluir compras só com valor/data iguais', () => {
  const env = setup();
  env.context.Dashboard.existingTransactions = () => [{ id: 'old', date: '2026-01-31', desc: 'Compra', amount: 25, currency: 'BRL', type: 'despesa', account: 'C6', referenceId: 'REF-A' }];
  ingest(env, [item({ referencia: 'REF-A' }),item({ referencia: 'REF-B' }),item({ descricao: 'Sem referência' })]);
  assert.match(env.node('#batch-count').textContent, /2 de 3 selecionadas/);
  assert.match(env.node('#batch-review-summary').textContent, /1 item\(ns\).*mesma referência/);
  env.batch.save(); assert.match(env.confirmations[0].text, /2 possível\(is\) duplicata/);
  env.confirm(); assert.deepEqual(env.saved().map((r) => r.referenceId || ''), ['REF-B','']);
});

test('repetição exata no lote vem fora e pode ser selecionada explicitamente com aviso global', () => {
  const env = setup(); ingest(env, [item({ referencia: 'REF' }),item({ referencia: 'REF' })]);
  assert.match(env.node('#batch-count').textContent, /1 de 2 selecionadas/);
  select(env, 1, true); env.batch.save();
  assert.match(env.confirmations[0].text, /possível\(is\) duplicata/);
  env.confirm(); assert.equal(env.saved().length, 2);
});

test('data estimada nunca comprova repetição exata para desmarcar automaticamente', async () => {
  const env = withDocument([item({ valor: 10 }),item({ data: '', referencia: 'REF' })]);
  env.context.Dashboard.existingTransactions = () => [{ id:'old',date:'2026-01-31',desc:'Compra',amount:25,currency:'BRL',type:'despesa',account:'C6',referenceId:'REF' }];
  await env.read(); assert.match(env.node('#batch-count').textContent,/2 de 2 selecionadas/);
  env.batch.save(); assert.match(env.confirmations[0].text,/possível\(is\) duplicata/); env.confirm();
  assert.equal(env.saved().length,2); assert.equal(env.saved()[1].dateEstimated,true);
  const previousEstimated = withDocument([item({ referencia: 'REF' })]);
  previousEstimated.context.Dashboard.existingTransactions = () => [{ id:'old',date:'2026-01-31',desc:'Compra',amount:25,currency:'BRL',type:'despesa',account:'C6',referenceId:'REF',dateEstimated:true,dateEstimate:{method:'nearest',previousDate:'2026-01-31'} }];
  await previousEstimated.read(); assert.match(previousEstimated.node('#batch-count').textContent,/1 de 1 selecionadas/);
  previousEstimated.batch.save(); previousEstimated.confirm(); assert.equal(previousEstimated.saved().length,1);
});

test('referência igual com conta, tipo, moeda, data ou valor diferente não é autoexcluída', () => {
  for (const change of [{ instituicao: 'Wise' },{ tipo: 'receita' },{ moeda: 'USD' },{ data: '2026-01-30' },{ valor: 30 }]) {
    const env = setup(); ingest(env, [item({ referencia: 'REF' }),item({ referencia: 'REF', ...change })]);
    assert.match(env.node('#batch-count').textContent, /2 de 2 selecionadas/);
    env.batch.save(); if (env.confirmations.length) env.confirm(); assert.equal(env.saved().length, 2);
  }
});

test('cancelar confirmação conserva a prévia e outra tentativa abre uma nova confirmação', () => {
  const env = setup(); ingest(env,[item(),item()]); env.batch.save(); env.cancel();
  assert.equal(env.saved(), undefined); assert.equal(env.node('#modal-batch').classList.contains('hidden'), false);
  env.batch.save(); assert.equal(env.confirmations.length, 2); env.confirm(); assert.equal(env.saved().length, 2);
});

test('edição, seleção ou novo registro local durante confirmação reapresentam resumo antes do commit', () => {
  for (const change of ['edit','selection','database']) {
    const env = setup(); let existing = [];
    env.context.Dashboard.existingTransactions = () => existing;
    ingest(env, [item(),item({ descricao: 'Outra' })]); env.batch.save();
    if (change === 'edit') edit(env, 0, 'amount', '37');
    if (change === 'selection') select(env, 1, false);
    if (change === 'database') existing = [{ id: 'new', date: '2026-01-31', desc: 'Nova', amount: 25, type: 'despesa', currency: 'BRL', account: 'C6' }];
    env.confirm(); assert.equal(env.saved(), undefined); assert.equal(env.confirmations.length, 2);
    assert.match(env.confirmations[1].text, /resumo atualizado/);
    env.confirm(); assert.equal(env.savedCount(), 1);
  }
});

test('mudança de pasta, conta ou geração cancela confirmação antiga sem gravar em outro destino', () => {
  for (const change of ['owner','folder','generation']) {
    let owner = 'A', folder = 'one';
    const env = setup({ Cloud: { getToken: () => 'fake', getSyncState: () => ({ owner }) } });
    env.context.Dashboard.getImportTargetId = () => folder; env.batch.open();
    ingest(env,[item(),item()]); env.batch.save();
    if (change === 'owner') owner = 'B'; if (change === 'folder') folder = 'two';
    if (change === 'generation') { env.batch.close(); env.batch.open(); }
    env.confirm(); assert.equal(env.savedCount(), 0);
  }
});

test('duplo clique no CTA ou no callback não duplica confirmação nem commit', () => {
  const env = setup(); ingest(env,[item(),item()]); env.batch.save(); env.batch.save();
  assert.equal(env.confirmations.length, 1);
  const callback = env.confirmations[0].callback;
  env.confirm(); callback(); env.batch.save(); assert.equal(env.savedCount(), 1);
});

test('erro de storage ou retorno zero mantém prévia e permite retentar sem sucesso falso', () => {
  for (const failure of ['zero','throw']) {
    const env = setup(); env.context.Dashboard.appendImported = () => { if (failure === 'throw') throw Error('quota'); return 0; };
    ingest(env,[item()]); env.batch.save();
    assert.equal(env.node('#modal-batch').classList.contains('hidden'), false);
    assert.match(env.notices.at(-1), /prévia foi mantida/i);
    assert.equal(env.node('#btn-batch-save').disabled, false);
  }
});

test('moedas e precisão são preservadas nos totais e commit, sem arredondar stablecoin', () => {
  const env = setup(); ingest(env,[item({ tipo: 'receita', valor: 25 }),item({ valor: 10 }),item({ moeda: 'USD', valor: 25 }),item({ moeda: 'USDC', valor: 0.000001 })]);
  assert.match(env.node('#batch-count').textContent, /BRL 15 · USD -25 · USDC -0.000001/);
  env.batch.save(); assert.deepEqual(env.saved().map((r) => r.amount), [25,10,25,0.000001]);
});

test('override anterior ou posterior à segunda leitura não recebe selo e exige só confirmação global', async () => {
  for (const before of [true,false]) {
    const env = withDocument([item()]);
    if (!before) await env.read();
    env.node('#batch-cur').value = 'USD'; env.node('#batch-cur').fire('change');
    if (before) await env.read();
    assert.equal(env.node('#batch-verification').classList.contains('is-verified'), false);
    assert.equal(env.node('#btn-batch-save').disabled, false);
    env.batch.save(); assert.match(env.confirmations[0].totalText || env.confirmations[0].text, /USD/);
    env.confirm(); assert.equal(env.saved()[0].currency, 'USD');
  }
});

test('projeções ficam fora por padrão; opt-in mantém datas reais e confirmação única', () => {
  const env = setup(); ingest(env,[item({ parcela: '3/4' })]);
  assert.match(env.node('#batch-count').textContent, /1 de 4 selecionadas/);
  projections(env); env.batch.save(); assert.match(env.confirmations[0].text, /3 projeção/); env.confirm();
  assert.deepEqual(env.saved().map((r) => r.date), ['2025-11-30','2025-12-31','2026-01-31','2026-02-28']);
  assert.equal(new Set(env.saved().map((r) => r.groupId)).size, 1);
});

test('projeções sem data de base observada permanecem fora mesmo com opt-in', async () => {
  const env = withDocument([item({ valor: 10 }),item({ data: '', valor: 20, parcela: '2/3' })]);
  await env.read(); projections(env); env.batch.save(); env.confirm();
  assert.equal(env.saved().length, 2); assert.equal(env.saved()[1].dateEstimated, true);
  assert.match(env.node('#batch-review-summary').textContent, /projeção\(ões\) sem data válida ficaram fora/);
});

test('resposta tardia de primeira ou segunda leitura é descartada após cancelamento', async () => {
  for (const phase of [1,2]) {
    let finish, calls = 0;
    const env = setup({ fetch: async (_, request) => {
      calls++; if (calls === phase) return new Promise((resolve) => { finish = resolve; });
      return response({ itens: [item()], coverage: complete(), partial: false });
    } });
    const pending = env.batch.fromPhotos([{ name: 'foto.png', size: 10 }]); await new Promise(setImmediate);
    env.batch.close(); env.batch.open(); finish(response(phase === 1 ? { itens: [item()] } : verified([item()]))); await pending;
    env.batch.save(); assert.equal(env.savedCount(), 0);
    assert.match(env.notices.at(-1), /Nenhum lançamento válido/);
  }
});

test('autenticação 502 não é repetida como erro de IA e nenhum retorno escreve dados', async () => {
  let calls = 0;
  const env = setup({ fetch: async () => { calls++; return response({ error: 'auth_indisponivel' },502); } });
  await env.batch.fromPhotos([{ name: 'foto.png', size: 10 }]);
  assert.equal(calls,1); assert.match(env.node('#batch-status').textContent,/verificar sua sessão/); assert.equal(env.savedCount(),0);
});

test('índices da segunda leitura sobrevivem a item inválido excluído e parcelas expandidas', async () => {
  const originals = [item({ valor: -1 }),item({ valor: 20, parcela: '2/3' }),item({ valor: 40 })];
  const env = withDocument(originals,{status:'attention',items:[{index:0,status:'attention',reasons:['Inválido']},{index:1,status:'verified',reasons:[]},{index:2,status:'attention',reasons:['Último item']} ]});
  await env.read(); assert.match(env.node('#batch-verification-counts').textContent,/1 conferido\(s\) em duas leituras/);
  env.batch.save(); env.confirm(); assert.deepEqual(env.saved().map((r)=>[r.amount,r.installment]),[[20,'2/3'],[40,null]]);
});

test('índices malformados nunca dão selo, mas um único aceite permite incluir dados válidos', async () => {
  for (const changes of [{checkedCount:0},{items:[{index:1,status:'verified',reasons:[]}]},{issues:['Total não confirmado']}]) {
    const env=withDocument([item()],changes); await env.read();
    assert.equal(env.node('#batch-verification').classList.contains('is-verified'),false);
    env.batch.save(); env.confirm(); assert.equal(env.saved().length,1);
  }
});

test('Excel usa leitura local e não alega segunda conferência, com avisos no resumo global', async () => {
  let calls=0;
  const env=setup({fetch:async()=>{calls++;},Importer:{readForBatch:async()=>[{date:'2026-01-31',desc:'Planilha',amount:25,type:'despesa',currency:'BRL',category:'Essencial'}]}});
  await env.batch.fromFiles([{name:'dados.xlsx',size:10}]);
  assert.equal(calls,0); assert.match(env.node('#batch-verification-note').textContent,/sem IA/);
  env.batch.save(); env.confirm(); assert.equal(env.saved().length,1);
});
