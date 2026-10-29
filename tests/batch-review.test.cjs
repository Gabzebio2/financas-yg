const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../js/batch.js'), 'utf8');

function setup(extra = {}) {
  const nodes = new Map(), ready = [], notices = [];
  let saved;
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
    Dashboard: { getCats: () => ['Essencial', 'Outros'], existingTxKeys: () => new Set(), existingSeriesKeys: () => new Set(), appendImported(rows) { saved = JSON.parse(JSON.stringify(rows)); return rows.length; } },
    Receipt: { prepareFile: async () => ({ mediaType: 'image/png', data: 'fake' }) },
    Cloud: { getToken: () => 'test-token' },
    ...extra,
  };
  const context = vm.createContext(env);
  const core = fs.readFileSync(path.resolve(__dirname, '../js/app.js'), 'utf8');
  vm.runInContext(core.slice(core.indexOf('const ImportMatch ='), core.indexOf("// 'YYYY-MM-DD'")), context);
  vm.runInContext(source.replace('return { open, openWithFiles, ingestAiResult, refreshPreview };', 'return { open, close, openWithFiles, ingestAiResult, refreshPreview, save, fromPhotos, fromFiles };') + '\nthis.batch = Batch;', context);
  ready.forEach((fn) => fn());
  const batch = context.batch;
  batch.open();
  return { batch, node, notices, saved: () => saved, context };
}

const item = (changes = {}) => ({ data: '2026-01-31', descricao: 'Compra', valor: 25, moeda: 'BRL', tipo: 'despesa', categoria: 'Essencial', ...changes });
function includeGenerated(env) { const input = env.node('#batch-include-generated'); input.checked = true; input.fire('change'); }
function edit(env, index, field, value) { env.node('#batch-tbody').fire('input', { dataset: { i: String(index), f: field }, value }); }
function acknowledgePartial(env) { env.node('#batch-partial-ack').checked = true; env.node('#batch-partial-ack').fire('change'); }
function distinct(env, index) { env.node('#batch-tbody').fire('click', { closest: () => ({ dataset: { distinct: String(index) } }) }); }
function reviewed(env, index) { env.node('#batch-tbody').fire('click', { closest: (selector) => selector === '[data-reviewed]' ? ({ dataset: { reviewed: String(index) } }) : null }); }
function select(env, index, checked) { env.node('#batch-tbody').fire('change', { dataset: { i: String(index) }, checked, classList: { contains: () => true }, closest: () => ({ classList: { toggle() {} } }) }); }
const coverageComplete = (pagesRead = [1]) => ({ complete: true, pagesRead, unreadablePages: [] });
const verifiedReview = (itens, changes = {}) => ({ review: { status: 'verified', provider: 'openai', model: 'test-review', checkedCount: itens.length,
  items: itens.map((_, index) => ({ index, status: 'verified', reasons: [] })), additionalItems: [], issues: [], coverage: coverageComplete(), ...changes } });
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
function withDocument(itens, review = {}) {
  const calls = [];
  const env = setup({ fetch: async (_, request) => {
    const body = JSON.parse(request.body); calls.push(body);
    return response(body.reviewOf ? verifiedReview(itens, review) : { itens, cartao: 'C6', coverage: coverageComplete(), partial: false });
  } });
  return { ...env, calls, read: () => env.batch.fromPhotos([{ name: 'documento.png', size: 10 }]) };
}

test('lote preserva moedas novas e distingue parcelas que diferem na sexta casa', () => {
  const env = setup();
  for (const [moeda, valor] of [['EUR', 12.34], ['GBP', 5.67], ['USDT', 0.000001], ['USDC', 1.000001]]) env.batch.ingestAiResult([item({ moeda, valor, descricao: moeda })], '');
  env.batch.ingestAiResult([item({ moeda: 'USDC', valor: 1.000001, descricao: 'Parcelada', parcela: '1/2' })], '');
  env.batch.ingestAiResult([item({ moeda: 'USDC', valor: 1.000002, descricao: 'Parcelada', parcela: '1/2' })], '');
  env.batch.refreshPreview();
  distinct(env, 4); // mesmo valor da compra USDC avulsa, mas outra operação confirmada
  env.batch.save();
  assert.deepEqual(env.saved().map((row) => [row.currency, row.amount]), [['EUR',12.34],['GBP',5.67],['USDT',0.000001],['USDC',1.000001],['USDC',1.000001],['USDC',1.000002]]);
});

test('parcela vista é o único lançamento selecionado e total desconhecido não é inventado', () => {
  const env = setup();
  assert.equal(env.batch.ingestAiResult([item({ parcela: '3/4' })], ''), 1);
  env.batch.refreshPreview();
  assert.doesNotMatch(env.node('#batch-tbody').innerHTML, /Projeção/);
  assert.match(env.node('#batch-review-summary').textContent, /3 lançamento\(s\) são projeções/);
  env.batch.save();
  assert.equal(env.saved().length, 1);
  assert.equal(env.saved()[0].date, '2026-01-31');
  assert.equal(env.saved()[0].installment, '3/4');
  assert.equal(env.saved()[0].totalValue, null);
  assert.equal(env.saved()[0].account, '');
});

test('opt-in de planejamento inclui a série com datas calculadas e marcações visíveis', () => {
  const env = setup();
  env.batch.ingestAiResult([item({ parcela: '3/4' })], 'C6');
  env.batch.refreshPreview();
  includeGenerated(env);
  assert.match(env.node('#batch-tbody').innerHTML, /Projeção · 1\/4/);
  env.batch.save();
  assert.deepEqual(env.saved().map((r) => r.date), ['2025-11-30', '2025-12-31', '2026-01-31', '2026-02-28']);
  assert.equal(new Set(env.saved().map((r) => r.groupId)).size, 1);
});

test('mensalidade não cria onze despesas extras sem opt-in e a opção pode ser desfeita', () => {
  const env = setup();
  env.batch.ingestAiResult([item({ fixa: true })], 'C6');
  env.batch.refreshPreview();
  includeGenerated(env);
  const input = env.node('#batch-include-generated'); input.checked = false; input.fire('change');
  env.batch.save();
  assert.equal(env.saved().length, 1);
  assert.equal(env.saved()[0].fixed, true);
  assert.equal(env.saved()[0].date, '2026-01-31');
});

test('data ausente bloqueia todo o lote até correção, sem lançar parcialmente', () => {
  const env = setup();
  env.batch.ingestAiResult([item({ data: '' }), item({ descricao: 'Outra compra' })], '');
  env.batch.refreshPreview();
  env.batch.save();
  assert.equal(env.saved(), undefined);
  assert.match(env.node('#batch-tbody').innerHTML, /Informe a data/);
  edit(env, 0, 'date', '2025-12-17');
  env.batch.save();
  assert.equal(env.saved().length, 2);
  assert.equal(env.saved()[0].date, '2025-12-17');
});

test('corrigir data observada atualiza projeções antes da confirmação', () => {
  const env = setup();
  env.batch.ingestAiResult([item({ data: '', parcela: '2/3' })], '');
  env.batch.refreshPreview();
  edit(env, 1, 'date', '2026-03-31');
  includeGenerated(env);
  env.batch.save();
  assert.deepEqual(env.saved().map((r) => r.date), ['2026-02-28', '2026-03-31', '2026-04-30']);
});

test('tipo, moeda e valor inválidos são excluídos com aviso, sem assumir despesa ou BRL', () => {
  const env = setup();
  const n = env.batch.ingestAiResult([item({ moeda: '' }), item({ moeda: 'CHF' }), item({ tipo: '' }), item({ valor: true }), item({ valor: -12 }), item({ valor: Infinity }), item({ descricao: 'Válida', moeda: 'USD' })], '');
  assert.equal(n, 1);
  env.batch.refreshPreview();
  env.batch.save();
  assert.equal(env.saved(), undefined);
  acknowledgePartial(env);
  assert.match(env.node('#batch-review-summary').textContent, /6 item\(ns\) não importado/);
  env.batch.save();
  assert.equal(env.saved().length, 1);
  assert.equal(env.saved()[0].currency, 'USD');
});

test('categoria desconhecida não vira primeira categoria nem cartão por correspondência parcial', () => {
  const env = setup();
  env.batch.ingestAiResult([item({ categoria: 'Categoria inventada' })], 'C6 ou outro banco');
  env.batch.refreshPreview();
  assert.equal(env.node('#batch-acc').value, 'original');
  env.batch.save();
  assert.equal(env.saved()[0].category, 'Outros');
  assert.equal(env.saved()[0].account, '');
});

test('cartões de documentos diferentes são preservados e moeda de cada item permanece', () => {
  const env = setup();
  env.batch.ingestAiResult([item({ descricao: 'Primeira', moeda: 'USD' })], 'C6');
  env.batch.ingestAiResult([item({ descricao: 'Segunda' })], 'Nubank Gab');
  env.batch.refreshPreview();
  env.batch.save();
  assert.deepEqual(env.saved().map((r) => [r.account, r.currency]), [['C6', 'USD'], ['Nubank Gab', 'BRL']]);
});

test('projeções coincidentes exigem decisão e permitem manter a parcela observada do segundo documento', () => {
  const env = setup();
  env.batch.ingestAiResult([item({ parcela: '3/4' })], 'C6');
  env.batch.refreshPreview();
  env.batch.ingestAiResult([item({ parcela: '4/4', data: '2026-02-20' })], 'C6');
  env.batch.refreshPreview();
  includeGenerated(env);
  env.batch.save();
  assert.equal(env.saved(), undefined);
  // Escolha explícita: primeira série 1–3 e parcela observada da segunda.
  for (const index of [3, 4, 5, 6]) select(env, index, false);
  env.batch.save();
  assert.equal(env.saved().length, 4);
  assert.equal(env.saved().find((r) => r.installment === '4/4').date, '2026-02-20');
});

test('resultado parcial mostra avisos e mantém campos incertos para revisão', async () => {
  const env = setup({ fetch: async () => ({ ok: true, status: 200, json: async () => ({ itens: [item({ data: '', revisar: ['Data ilegível'] })], cartao: '', partial: true, avisos: ['Confira a última página.'] }) }) });
  await env.batch.fromPhotos([{ name: 'fatura.png', size: 10 }]);
  assert.match(env.node('#batch-review-summary').textContent, /Leitura parcial/);
  assert.match(env.node('#batch-review-summary').textContent, /Confira a última página/);
  assert.match(env.node('#batch-tbody').innerHTML, /Data ilegível/);
  assert.match(env.node('#batch-status').className, /warn/);
  env.batch.save();
  assert.equal(env.saved(), undefined);
});

test('falha de autenticação 502 não é confundida com demora da IA ou repetida', async () => {
  let calls = 0;
  const env = setup({ fetch: async () => { calls++; return { ok: false, status: 502, json: async () => ({ error: 'auth_indisponivel' }) }; } });
  await env.batch.fromPhotos([{ name: 'fatura.png', size: 10 }]);
  assert.equal(calls, 1);
  assert.match(env.node('#batch-status').textContent, /verificar sua sessão/);
});

test('fechar o lote durante a leitura descarta o retorno antigo', async () => {
  let finish;
  const env = setup({ Importer: { readForBatch: () => new Promise((resolve) => { finish = resolve; }) } });
  const pending = env.batch.fromFiles([{ name: 'fatura.xlsx', size: 10 }]);
  env.batch.close(); env.batch.open();
  finish([{ date: '2026-01-01', desc: 'Antigo', amount: 10, currency: 'BRL', type: 'despesa' }]);
  await pending;
  env.batch.refreshPreview();
  assert.match(env.node('#batch-tbody').innerHTML, /Nada reconhecido/);
});

test('duas compras legítimas iguais no mesmo documento não são removidas e exigem decisão', () => {
  const env = setup();
  env.batch.ingestAiResult([item(), item()], 'C6'); env.batch.refreshPreview();
  assert.match(env.node('#batch-count').textContent, /2 de 2 selecionadas/);
  assert.match(env.node('#batch-tbody').innerHTML, /Mesma data, descrição, valor/);
  env.batch.save(); assert.equal(env.saved(), undefined);
  distinct(env, 1); env.batch.save(); assert.equal(env.saved().length, 2);
});

test('só valor e data iguais, descrição ou conta diferentes, são suspeita e não exclusão', () => {
  const env = setup();
  env.batch.ingestAiResult([item({ descricao: 'Loja A', instituicao: 'C6' }), item({ descricao: 'Loja B', instituicao: 'Wise' })], '');
  env.batch.refreshPreview();
  assert.match(env.node('#batch-tbody').innerHTML, /contas diferentes/);
  assert.match(env.node('#batch-count').textContent, /2 de 2 selecionadas/);
  distinct(env, 1); env.batch.save();
  assert.deepEqual(env.saved().map((r) => r.account), ['C6', 'Wise']);
});

test('mesma referência com valor divergente nunca descarta nem altera a operação', () => {
  const env = setup();
  env.batch.ingestAiResult([item({ referencia: 'REF-1' }), item({ referencia: 'REF-1', valor: 30 })], '');
  env.batch.refreshPreview(); env.batch.save(); assert.equal(env.saved(), undefined);
  assert.match(env.node('#batch-tbody').innerHTML, /Mesma referência/);
  distinct(env, 1); env.batch.save();
  assert.deepEqual(env.saved().map((r) => [r.amount, r.referenceId]), [[25, 'REF-1'], [30, 'REF-1']]);
});

test('registro salvo por outra aba depois da prévia exige nova decisão no salvar', () => {
  let existing = [];
  const env = setup(); env.context.Dashboard.existingTransactions = () => existing;
  env.batch.ingestAiResult([item()], 'C6'); env.batch.refreshPreview();
  existing = [{ id: 'saved1', date: '2026-01-31', desc: 'Compra', amount: 25, type: 'despesa', currency: 'BRL', account: 'C6' }];
  env.batch.save(); assert.equal(env.saved(), undefined);
  assert.match(env.node('#batch-tbody').innerHTML, /Já na pasta/);
  distinct(env, 0);
  existing.push({ ...existing[0], id: 'saved2' });
  env.batch.save(); assert.equal(env.saved(), undefined);
  distinct(env, 0); env.batch.save(); assert.equal(env.saved().length, 1);
});

test('desmarcar uma repetição permite salvar só a operação escolhida', () => {
  const env = setup(); env.batch.ingestAiResult([item(), item()], ''); env.batch.refreshPreview();
  select(env, 0, false); env.batch.save(); assert.equal(env.saved().length, 1);
});

test('mudar moeda após confirmar reavalia coincidência usando moeda efetiva', () => {
  const env = setup(); env.batch.ingestAiResult([item(), item({ moeda: 'USD' })], ''); env.batch.refreshPreview();
  env.node('#batch-cur').value = 'BRL'; env.node('#batch-cur').fire('change');
  env.batch.save(); assert.equal(env.saved(), undefined);
  distinct(env, 1); env.batch.save(); assert.deepEqual(env.saved().map((r) => r.currency), ['BRL','BRL']);
});

test('mudança de pasta ou conta durante leitura descarta resposta e bloqueia gravação', async () => {
  let finish, owner = 'ownerA';
  const env = setup({ Cloud: { getToken: () => 'synthetic', getSyncState: () => ({ owner }) }, fetch: () => new Promise((r) => { finish = r; }) });
  const request = env.batch.fromPhotos([{ name: 'foto.png', size: 10 }]);
  await new Promise(setImmediate); owner = 'ownerB';
  finish({ ok: true, status: 200, json: async () => ({ itens: [item()], coverage: { complete: true, pagesRead: [1], unreadablePages: [] } }) });
  await request; env.batch.save(); assert.equal(env.saved(), undefined);
  assert.match(env.notices.at(-1), /pasta ou conta mudou/);
});

test('partes sequenciais enviam contexto, mantêm metadados e falha intermediária exige revisão', async () => {
  const calls = [];
  const env = setup({
    Receipt: { async *prepareParts() { for (let start = 1; start <= 5; start += 2) yield { data: 'fake', mediaType: 'application/pdf', documentContext: { pageStart: start, pageEnd: Math.min(start + 1, 5), totalPages: 5 }, label: 'páginas ' + start }; } },
    fetch: async (_, request) => {
      const body = JSON.parse(request.body); calls.push(body.documentContext);
      if (body.documentContext.pageStart === 3) return { ok: false, status: 400, json: async () => ({ error: 'ilegivel' }) };
      if (body.reviewOf) return response(verifiedReview(body.reviewOf.itens, { coverage: coverageComplete([1, 2]) }));
      return { ok: true, status: 200, json: async () => ({ itens: [item({ valor: body.documentContext.pageStart, referencia: 'REF-' + body.documentContext.pageStart, evidencia: 'linha explícita', pagina: 1 })], coverage: { complete: true, pagesRead: [1, 2], unreadablePages: [] } }) };
    }
  });
  await env.batch.fromPhotos([{ name: 'extrato.pdf', size: 10 }]);
  assert.deepEqual(calls.map((r) => r.pageStart), [1,1,3,5,5]);
  env.batch.save(); assert.equal(env.saved(), undefined);
  assert.match(env.node('#batch-coverage').innerHTML, /Não foi possível ler/);
  acknowledgePartial(env); env.batch.save();
  assert.deepEqual(env.saved().map((r) => [r.amount, r.referenceId, r.sourcePage]), [[1,'REF-1',1], [5,'REF-5',5]]);
});

test('coverage ausente em resposta antiga nunca afirma leitura integral', async () => {
  const env = setup({ fetch: async () => ({ ok: true, status: 200, json: async () => ({ itens: [item()] }) }) });
  await env.batch.fromPhotos([{ name: 'foto.png', size: 10 }]);
  env.batch.save(); assert.equal(env.saved(), undefined);
  assert.match(env.node('#batch-coverage').innerHTML, /não confirmada/);
  acknowledgePartial(env); env.batch.save(); assert.equal(env.saved(), undefined);
  reviewed(env, 0); env.batch.save(); assert.equal(env.saved().length, 1);
});

test('seleção acima do limite informa o problema sem ler apenas parte dos arquivos', async () => {
  let reads = 0;
  const env = setup({ fetch: async () => { reads++; } });
  await env.batch.openWithFiles(Array.from({ length: 16 }, (_, i) => ({ name: i + '.png', type: 'image/png', size: 10 })));
  assert.equal(reads, 0); assert.match(env.node('#batch-status').textContent, /Nenhum arquivo foi lido/);
});

test('clique olhando comparação antiga não confirma registros surgidos depois da renderização', () => {
  let existing = [{ id: 'existing1', date: '2026-01-31', desc: 'Compra', amount: 25, type: 'despesa', currency: 'BRL', account: 'C6' }];
  const env = setup(); env.context.Dashboard.existingTransactions = () => existing;
  env.batch.ingestAiResult([item()], 'C6'); env.batch.refreshPreview();
  existing.push({ ...existing[0], id: 'existing2' });
  distinct(env, 0); env.batch.save(); assert.equal(env.saved(), undefined);
  assert.ok(env.notices.some((message) => /comparação mudou/.test(message)));
  distinct(env, 0); env.batch.save(); assert.equal(env.saved().length, 1);
});

test('falha de commit mantém a prévia e não anuncia sucesso', () => {
  const env = setup(); env.context.Dashboard.appendImported = () => 0;
  env.batch.ingestAiResult([item()], 'C6'); env.batch.refreshPreview(); env.batch.save();
  assert.equal(env.node('#modal-batch').classList.contains('hidden'), false);
  assert.match(env.node('#batch-count').textContent, /1 de 1/);
  assert.match(env.notices.at(-1), /prévia foi mantida/);
});

test('saldo da seleção é receita menos despesa por moeda sem alterar os valores salvos', () => {
  const env = setup();
  env.batch.ingestAiResult([item({ tipo: 'receita', valor: 25 }), item({ valor: 10 }), item({ valor: 25, moeda: 'USD' })], '');
  env.batch.refreshPreview();
  assert.match(env.node('#batch-count').textContent, /Saldo da seleção: BRL 15 · USD -25/);
  env.batch.save(); assert.deepEqual(env.saved().map((t) => t.amount), [25,10,25]);
});

test('duas leituras concordantes usam o mesmo documento sem histórico e permitem inclusão em um clique', async () => {
  const originals = [item({ tipo: 'receita', valor: 100, moeda: 'USD' }), item({ valor: 40, referencia: 'OP-2' })];
  const env = withDocument(originals);
  env.context.Dashboard.existingTransactions = () => [{ id: 'private', date: '2025-01-01', desc: 'HISTORICO PRIVADO', amount: 999, type: 'despesa', currency: 'BRL' }];
  await env.read();
  assert.equal(env.calls.length, 2);
  const [first, second] = env.calls;
  assert.deepEqual(second.image, first.image);
  assert.deepEqual(second.categories, first.categories);
  assert.deepEqual(second.cards, first.cards);
  assert.deepEqual(second.documentContext, first.documentContext);
  assert.deepEqual(second.reviewOf, { itens: originals, cartao: 'C6', coverage: coverageComplete(), partial: false });
  assert.doesNotMatch(JSON.stringify(env.calls), /HISTORICO PRIVADO/);
  assert.equal(env.node('#batch-details').open, false);
  assert.match(env.node('#batch-verification-counts').textContent, /2 conferido\(s\) em duas leituras.*0 pendente/);
  assert.match(env.node('#batch-currency-totals').innerHTML, /Entradas <b>USD 100/);
  assert.match(env.node('#batch-currency-totals').innerHTML, /Saídas <b>BRL 40/);
  assert.equal(env.node('#btn-batch-save').disabled, false);
  env.node('#btn-batch-save').click();
  assert.deepEqual(env.saved().map((r) => [r.amount,r.currency,r.type]), [[100,'USD','receita'],[40,'BRL','despesa']]);
});

test('divergência preserva a primeira leitura e exige confirmação manual do item', async () => {
  const env = withDocument([item()], { status: 'attention', items: [{ index: 0, status: 'attention', reasons: ['Confira o valor indicado no comprovante.'] }] });
  await env.read();
  assert.match(env.node('#batch-tbody').innerHTML, /Confira o valor indicado/);
  assert.equal(env.node('#batch-details').open, true);
  env.batch.save(); assert.equal(env.saved(), undefined);
  reviewed(env, 0);
  assert.match(env.node('#batch-verification-counts').textContent, /1 conferido\(s\) por você.*0 pendente/);
  env.batch.save(); assert.equal(env.saved()[0].amount, 25);
});

test('itens adicionais entram como pendências sem substituir ou duplicar índices da primeira leitura', async () => {
  const env = withDocument([item({ valor: 15 })], { status: 'attention', additionalItems: [item({ valor: 40, descricao: 'Item adicional', pagina: 1 })] });
  await env.read();
  assert.match(env.node('#batch-count').textContent, /2 de 2/);
  assert.match(env.node('#batch-tbody').innerHTML, /Item encontrado somente na segunda leitura/);
  assert.match(env.node('#batch-verification-counts').textContent, /1 conferido\(s\) em duas leituras.*1 pendente/);
  env.batch.save(); assert.equal(env.saved(), undefined);
  reviewed(env, 1); env.batch.save();
  assert.deepEqual(env.saved().map((r) => [r.desc,r.amount]), [['Compra',15],['Item adicional',40]]);
});

test('desmarcar divergência permite escolher só o conferido, sem alegar concordância do documento inteiro', async () => {
  const env = withDocument([item({ valor: 15 })], { status: 'attention', additionalItems: [item({ valor: 40 })] });
  await env.read(); select(env, 1, false);
  assert.equal(env.node('#batch-verification').classList.contains('is-verified'), false);
  assert.doesNotMatch(env.node('#batch-verification-title').textContent, /dados de acordo/);
  env.batch.save(); assert.equal(env.saved().length, 1);
});

test('falha na segunda leitura preserva a primeira e não permite selo nem salvar só com cobertura aceita', async () => {
  const env = setup({ fetch: async (_, request) => response(JSON.parse(request.body).reviewOf ? { error: 'revisao_indisponivel' } : { itens: [item()], coverage: coverageComplete(), partial: false }, JSON.parse(request.body).reviewOf ? 503 : 200) });
  await env.batch.fromPhotos([{ name: 'foto.png', size: 10 }]);
  assert.match(env.node('#batch-tbody').innerHTML, /segunda conferência não foi concluída/);
  assert.match(env.node('#batch-count').textContent, /1 de 1/);
  acknowledgePartial(env); env.batch.save(); assert.equal(env.saved(), undefined);
  reviewed(env, 0); env.batch.save(); assert.equal(env.saved()[0].amount, 25);
});

test('cobertura parcial da segunda leitura bloqueia selo mesmo com todos itens verified', async () => {
  const env = withDocument([item()], { coverage: { complete: false, pagesRead: [], unreadablePages: [1] } });
  await env.read();
  assert.equal(env.node('#batch-verification').classList.contains('is-verified'), false);
  assert.match(env.node('#batch-verification-counts').textContent, /^0 conferido/);
  reviewed(env, 0); env.batch.save(); assert.equal(env.saved(), undefined);
  acknowledgePartial(env); env.batch.save(); assert.equal(env.saved().length, 1);
});

test('índices repetidos ou faltantes e checkedCount divergente nunca produzem selo automático', async () => {
  const inputs = [item({ valor: 10 }), item({ valor: 20 })];
  for (const change of [
    { items: [{ index: 0, status: 'verified', reasons: [] }, { index: 0, status: 'verified', reasons: [] }] },
    { checkedCount: 1 }, { items: [{ index: 1, status: 'verified', reasons: [] }] },
    { issues: ['O total do documento não foi confirmado.'] }
  ]) {
    const env = withDocument(inputs, change); await env.read();
    assert.match(env.node('#batch-verification-counts').textContent, /^0 conferido.*2 pendente/);
    env.batch.save(); assert.equal(env.saved(), undefined);
  }
});

test('índices da revisão sobrevivem a item excluído e expansão de parcelas', async () => {
  const originals = [item({ valor: -1 }), item({ valor: 20, parcela: '2/3' }), item({ valor: 40, descricao: 'Último' })];
  const env = withDocument(originals, { status: 'attention', items: [
    { index: 0, status: 'attention', reasons: ['Valor inválido'] },
    { index: 1, status: 'verified', reasons: [] },
    { index: 2, status: 'attention', reasons: ['Confira o último item'] }
  ] });
  await env.read();
  assert.match(env.node('#batch-verification-counts').textContent, /1 conferido\(s\) em duas leituras.*1 pendente/);
  assert.match(env.node('#batch-tbody').innerHTML, /data-reviewed="3"/);
  reviewed(env, 3); acknowledgePartial(env); env.batch.save();
  assert.deepEqual(env.saved().map((r) => [r.amount,r.installment]), [[20,'2/3'],[40,null]]);
});

test('editar valor, categoria, conta ou moeda invalida selo e confirmações manuais obsoletas', async () => {
  for (const field of ['amount','cat','account','currency']) {
    const env = withDocument([item()]); await env.read();
    env.node('#batch-filter-all').click();
    if (field === 'account' || field === 'currency') {
      const id = field === 'account' ? '#batch-acc' : '#batch-cur'; env.node(id).value = field === 'account' ? 'Nubank Gab' : 'USD'; env.node(id).fire('change');
    } else { edit(env, 0, field, field === 'amount' ? '30' : 'Outros'); env.batch.refreshPreview(); }
    assert.match(env.node('#batch-verification-counts').textContent, /^0 conferido.*1 pendente/);
    env.batch.save(); assert.equal(env.saved(), undefined);
    reviewed(env, 0);
    edit(env, 0, 'desc', 'Descrição atualizada');
    env.batch.save(); assert.equal(env.saved(), undefined);
    reviewed(env, 0); env.batch.save(); assert.equal(env.saved().length, 1);
    if (field === 'currency') {
      assert.equal(env.saved()[0].currency, 'USD');
      assert.match(env.node('#batch-currency-totals').innerHTML, /BRL/);
      assert.match(env.node('#batch-verification-note').textContent, /não são convertidos/);
    }
  }
});

test('override de moeda, conta ou categoria existente antes da leitura não recebe selo do documento', async () => {
  for (const field of ['currency','account','category']) {
    const env = withDocument([item()]);
    if (field === 'category') env.batch.open({ category: 'Outros' });
    else {
      const id = field === 'currency' ? '#batch-cur' : '#batch-acc';
      env.node(id).value = field === 'currency' ? 'USD' : 'Nubank Gab';
      env.node(id).fire('change');
    }
    await env.read();
    assert.match(env.node('#batch-verification-counts').textContent, /^0 conferido.*1 pendente/);
    env.batch.save(); assert.equal(env.saved(), undefined);
    reviewed(env, 0); env.batch.save();
    assert.equal(env.saved()[0][field], field === 'currency' ? 'USD' : field === 'account' ? 'Nubank Gab' : 'Outros');
  }
});

test('override durante arquivo repartido não carimba a moeda escolhida como verificada na próxima parte', async () => {
  let env;
  env = setup({ Receipt: { async *prepareParts() { for (let start = 1; start <= 2; start++) yield { data: 'fake', mediaType: 'application/pdf', documentContext: { pageStart: start, pageEnd: start, totalPages: 2 }, label: 'página ' + start }; } },
    fetch: async (_, request) => {
      const body = JSON.parse(request.body), itens = [item({ valor: body.documentContext.pageStart })];
      if (body.reviewOf && body.documentContext.pageStart === 1) { env.node('#batch-cur').value = 'USD'; env.node('#batch-cur').fire('change'); }
      return response(body.reviewOf ? verifiedReview(itens) : { itens, coverage: coverageComplete(), partial: false });
    } });
  await env.batch.fromPhotos([{ name: 'extrato.pdf', size: 10 }]);
  assert.match(env.node('#batch-verification-counts').textContent, /^0 conferido.*2 pendente/);
  env.batch.save(); assert.equal(env.saved(), undefined);
  reviewed(env, 0); reviewed(env, 1); env.batch.save();
  assert.deepEqual(env.saved().map((r) => r.currency), ['USD','USD']);
});

test('clique manual na representação antiga não aprova campo alterado antes de redesenhar', async () => {
  const env = withDocument([item()], { status: 'attention', items: [{ index: 0, status: 'attention', reasons: ['Confira a descrição'] }] });
  await env.read(); edit(env, 0, 'desc', 'Alterada'); reviewed(env, 0);
  assert.match(env.notices.at(-1), /dados mudaram/);
  env.batch.save(); assert.equal(env.saved(), undefined);
  reviewed(env, 0); env.batch.save(); assert.equal(env.saved()[0].desc, 'Alterada');
});

test('cancelamento e troca de owner durante segunda leitura não aplicam resultado tardio', async () => {
  for (const action of ['close','owner']) {
    let finish, owner = 'A', calls = 0;
    const env = setup({ Cloud: { getToken: () => 'fake', getSyncState: () => ({ owner }) }, fetch: async (_, request) => {
      calls++;
      if (JSON.parse(request.body).reviewOf) return new Promise((resolve) => { finish = resolve; });
      return response({ itens: [item()], coverage: coverageComplete(), partial: false });
    } });
    const pending = env.batch.fromPhotos([{ name: 'foto.png', size: 10 }]); await new Promise(setImmediate);
    assert.equal(calls, 2);
    if (action === 'close') { env.batch.close(); env.batch.open(); } else owner = 'B';
    finish(response(verifiedReview([item()]))); await pending;
    env.batch.save(); assert.equal(env.saved(), undefined);
    assert.doesNotMatch(env.node('#batch-verification-counts').textContent, /^1 conferido\(s\) em duas leituras/);
  }
});

test('edição feita durante a segunda chamada não recebe o selo da primeira versão', async () => {
  let finish;
  const env = setup({ fetch: async (_, request) => JSON.parse(request.body).reviewOf ? new Promise((resolve) => { finish = resolve; }) : response({ itens: [item()], coverage: coverageComplete(), partial: false }) });
  const request = env.batch.fromPhotos([{ name: 'foto.png', size: 10 }]); await new Promise(setImmediate);
  edit(env, 0, 'amount', '37');
  finish(response(verifiedReview([item()]))); await request;
  assert.match(env.node('#batch-verification-counts').textContent, /^0 conferido.*1 pendente/);
  env.batch.save(); assert.equal(env.saved(), undefined);
  reviewed(env, 0); env.batch.save(); assert.equal(env.saved()[0].amount, 37);
});

test('referências distintas verificadas separam cafés no lote, mas nunca registros existentes', async () => {
  const originals = [item({ referencia: 'CAFE-MANHA' }), item({ referencia: 'CAFE-TARDE' })];
  const env = withDocument(originals); await env.read(); env.batch.save(); assert.equal(env.saved().length, 2);
  const existingEnv = withDocument(originals);
  existingEnv.context.Dashboard.existingTransactions = () => [{ id: 'saved1', date: '2026-01-31', desc: 'Compra', amount: 25, type: 'despesa', currency: 'BRL', account: 'C6', referenceId: 'CAFE-ONTEM' }];
  await existingEnv.read();
  assert.match(existingEnv.node('#batch-tbody').innerHTML, /Já na pasta/);
  assert.match(existingEnv.node('#batch-filter-pending').textContent, /2/);
  existingEnv.batch.save(); assert.equal(existingEnv.saved(), undefined);
});

test('referência igual, ausente, conta diferente, confirmação manual e edição não suprimem coincidências', async () => {
  for (const [first, second] of [
    [{ referencia: 'A' }, { referencia: 'A' }], [{ referencia: 'A' }, {}],
    [{ referencia: 'A', instituicao: 'C6' }, { referencia: 'B', instituicao: 'Wise' }]
  ]) {
    const env = withDocument([item(first),item(second)]); await env.read();
    assert.match(env.node('#batch-tbody').innerHTML, /Neste lote/); env.batch.save(); assert.equal(env.saved(), undefined);
  }
  const env = withDocument([item({ referencia: 'A' }),item({ referencia: 'B' })]); await env.read();
  env.node('#batch-filter-all').click(); edit(env, 1, 'desc', 'Café da tarde'); env.batch.refreshPreview();
  assert.match(env.node('#batch-tbody').innerHTML, /Neste lote/);
  reviewed(env, 1); env.batch.save(); assert.equal(env.saved(), undefined);
  distinct(env, 1); env.batch.save(); assert.equal(env.saved().length, 2);
});

test('Excel permanece local e nunca recebe selo de duas leituras', async () => {
  let calls = 0;
  const env = setup({ fetch: async () => { calls++; }, Importer: { readForBatch: async () => [{ date: '2026-01-31', desc: 'Planilha', amount: 25, type: 'despesa', currency: 'BRL', category: 'Essencial' }] } });
  await env.batch.fromFiles([{ name: 'dados.xlsx', size: 10 }]);
  assert.equal(calls, 0); assert.match(env.node('#batch-verification-note').textContent, /Não houve conferência por IA/);
  assert.equal(env.node('#batch-verification').classList.contains('is-verified'), false);
  env.batch.save(); assert.equal(env.saved().length, 1);
});
