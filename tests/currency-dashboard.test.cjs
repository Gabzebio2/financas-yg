const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Somente valores sintéticos, cotações fixas e Store em memória. Nenhuma API,
// conta ou base financeira real participa destas verificações.
class Element {
  constructor() {
    this.value = ''; this.textContent = ''; this.innerHTML = ''; this.dataset = {};
    this.style = {setProperty(name, value) { this[name] = value; }};
    this.childNodes = [{nodeValue:''}]; this.parentElement = this;
    this.checked = false; this.hidden = false; this.selectedIndex = 0;
    this.listeners = new Map(); this.children = [];
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      contains: name => classes.has(name),
      toggle(name, force) {
        const enabled = force === undefined ? !classes.has(name) : !!force;
        if (enabled) classes.add(name); else classes.delete(name);
        return enabled;
      },
    };
  }
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  setAttribute(name, value) { this[name] = String(value); }
  getAttribute(name) { return this[name] ?? null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  appendChild(child) { this.children.push(child); }
  focus() {}
  click() {}
  dispatchEvent() {}
  remove() {}
}

function harness() {
  const nodes = new Map(), values = new Map(), domReady = [];
  const get = selector => {
    if (!nodes.has(selector)) nodes.set(selector, new Element());
    return nodes.get(selector);
  };
  const localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
  const win = {addEventListener() {}, matchMedia: () => ({matches:false})};
  win.self = win; win.top = win;
  let csvBlob;
  const rate = {USD:1, BRL:0.2, PYG:0.0002, CLP:0.001, EUR:1.1, GBP:1.25, USDT:1.003, USDC:0.998};
  const unavailable = new Set();
  const rates = {
    ready: (from, to) => from === to || (!unavailable.has(from) && !unavailable.has(to) && rate[from] > 0 && rate[to] > 0),
    convert(value, from, to) { return this.ready(from, to) ? Number(value) * rate[from] / rate[to] : NaN; },
    load() {}, refresh() {}, onUpdate() {}, updatedAt: () => Date.UTC(2026, 9, 23, 12),
  };
  const chartConfigs = new Map();
  class Chart {
    static defaults = {
      font:{}, plugins:{legend:{labels:{}},tooltip:{}}, elements:{line:{},point:{}},
    };
    constructor(canvas, config) { chartConfigs.set(canvas, config); }
    destroy() {}
  }
  const ctx = vm.createContext({
    console, Blob, Event, Chart, window:win, localStorage, Rates:rates,
    URL:{createObjectURL(blob) { csvBlob = blob; return 'blob:synthetic'; }, revokeObjectURL() {}},
    document:{
      body:new Element(), documentElement:new Element(), createElement:() => new Element(),
      querySelector:get, querySelectorAll:() => [],
      addEventListener(name, fn) { if (name === 'DOMContentLoaded') domReady.push(fn); },
    },
    setTimeout:() => 0, clearTimeout() {},
  });
  const appDir = path.join(__dirname, '..');
  vm.runInContext(fs.readFileSync(path.join(appDir, 'js/app.js'), 'utf8'), ctx);
  const source = fs.readFileSync(path.join(appDir, 'js/dashboard.js'), 'utf8');
  const anchor = '  return { open, openTxModal,';
  assert(source.includes(anchor), 'Instrumentação deve encontrar a API existente do painel');
  vm.runInContext(source.replace(anchor, `
    globalThis.currencyAudit = {
      dispCur, dispAmount, txDisplayCurrency, txDisplayAmount, fmtTxAmount, entryCur,
      currencyBreakdown, renderCurrencyBreakdown, renderSummary, renderTable, renderAll,
      exportCSV, limitStats, metaStats, moneyTicks, openTxModal, saveTxModal, fillTxFromReceipt,
      openMetaModal, openLimitModal,
      setDataset(value) { ds = value; }, getDataset() { return ds; },
      setFilters(value = {}) { fil = {mode:'month',month:'2026-10',from:'',to:'',cats:null,search:'',type:'all',account:'all',...value}; },
    };
  return { open, openTxModal,`), ctx);
  domReady.at(-1)();
  const api = ctx.currencyAudit;
  return {
    api, get, values, unavailable, rate, chartConfigs,
    money: (amount, code) => vm.runInContext(`fmtMoney(${amount}, ${JSON.stringify(code)})`, ctx),
    load(ds) {
      values.set('fyg:ds:' + ds.id, JSON.stringify(ds));
      values.set('fyg:index', JSON.stringify([{id:ds.id,name:ds.name}]));
      api.setDataset(ds); api.setFilters();
    },
    csv: async () => csvBlob.text(),
  };
}

const tx = (id, extra = {}) => ({
  id, date:'2026-10-09', desc:'Lançamento sintético', category:'Mercado',
  account:'Conta de teste', type:'despesa', amount:10, currency:'BRL', ...extra,
});
const dataset = (extra = {}) => ({
  id:'currencyaudit', name:'Teste de moedas', categories:[{name:'Mercado',color:'#123456'},{name:'Lazer',color:'#654321'}],
  transactions:[], limits:[], metas:[], displayCurrency:'DEFAULT', ...extra,
});
const equalNumber = (actual, expected) => assert(Math.abs(actual - expected) < 1e-9, `${actual} deve ser ${expected}`);
const plain = value => JSON.parse(JSON.stringify(value));
const breakdownValues = html => new Map([...html.matchAll(/<div class="fx-row">([\s\S]*?)(?=<div class="fx-row">|$)/g)].map(([, row]) => [
  row.match(/class="fx-code"><strong>([^<]+)<\/strong>/)[1],
  [...row.matchAll(/class="fx-metric-value"><span>([^<]+)<\/span><strong>([^<]*)<\/strong>/g)].map(([, label, value]) => ({ label, value })),
]));

test('Padrão soma PYG convertido e mantém a moeda original dos lançamentos', () => {
  const h = harness();
  const ds = dataset({transactions:[
    tx('usd-income',{amount:100,currency:'USD',type:'receita'}),
    tx('pyg-expense',{amount:50000,currency:'PYG'}),
    tx('brl-expense',{amount:50,currency:'BRL'}),
  ]});
  const before = JSON.stringify(ds); h.load(ds); h.api.renderAll();
  assert.equal(h.api.dispCur(),'PYG');
  assert.equal(h.get('#hero-rec').textContent,h.money(500000,'PYG'));
  assert.equal(h.get('#hero-desp').textContent,h.money(100000,'PYG'));
  assert.equal(h.get('#hero-saldo').textContent,h.money(400000,'PYG'));
  assert.match(h.get('#currency-mode-caption').textContent,/PYG/);
  for (const item of ds.transactions) {
    assert.equal(h.api.txDisplayCurrency(item),item.currency);
    assert.equal(h.api.txDisplayAmount(item),item.amount);
    assert(h.api.fmtTxAmount(item).includes(h.money(item.amount,item.currency)));
  }
  assert.equal(JSON.stringify(ds),before,'Renderização não pode regravar amounts/currencies nem o dataset');
});

test('lista distingue USD e CLP em qualquer modo sem repetir códigos de stablecoins', () => {
  const h = harness();
  const ds = dataset({transactions:[
    tx('dollar',{amount:10,currency:'USD'}), tx('peso',{amount:10,currency:'CLP'}),
    tx('tether',{amount:10,currency:'USDT'}), tx('coin',{amount:10,currency:'USDC'}),
  ]});
  h.load(ds); h.api.renderTable();
  for (const item of ds.transactions) {
    const label=h.api.fmtTxAmount(item);
    assert(label.includes(h.money(item.amount,item.currency)));
    assert.equal((label.match(new RegExp(`\\b${item.currency}\\b`,'g')) || []).length,1,
      'Cada lançamento identifica sua moeda exatamente uma vez');
    assert(h.get('#tx-tbody').innerHTML.includes(label),'A identificação precisa aparecer na linha da tabela');
  }
  assert.match(h.api.fmtTxAmount(ds.transactions[0]),/\bUSD\b/);
  assert.match(h.api.fmtTxAmount(ds.transactions[1]),/\bCLP\b/);
  ds.displayCurrency='BRL';
  assert.equal(h.api.fmtTxAmount(ds.transactions[0]),`${h.money(10,'USD')} · USD`,
    'A moeda escolhida para os totais não altera a identificação original da linha');
});

test('modo explícito converte resumos, limites e metas e preserva a lista original', () => {
  const h = harness();
  const ds = dataset({displayCurrency:'BRL',transactions:[tx('usd',{amount:10,currency:'USD'})],
    limits:[{id:'lim',name:'Compras',amount:30,currency:'USD',categories:['Mercado'],versions:[{from:'0000-00',amount:30,categories:['Mercado']}]}],
    metas:[{id:'goal',name:'Reserva',target:100,saved:25,currency:'USD'}],
  });
  const before = JSON.stringify(ds); h.load(ds); h.api.renderAll();
  assert.equal(h.api.txDisplayCurrency(ds.transactions[0]),'USD');
  equalNumber(h.api.txDisplayAmount(ds.transactions[0]),10);
  assert.equal(h.get('#hero-desp').textContent,h.money(50,'BRL'));
  equalNumber(h.api.limitStats()[0].amount,150);
  equalNumber(h.api.metaStats(ds.metas[0]).target,500);
  equalNumber(h.api.metaStats(ds.metas[0]).saved,125);
  assert.equal(JSON.stringify(ds),before);
});

test('oito moedas e Padrão preservam origem no Por moeda, lista e CSV, com resumo e gráfico convertidos', async () => {
  const h = harness();
  const currencies=['BRL','CLP','PYG','USD','EUR','GBP','USDT','USDC'];
  const ds=dataset({transactions:currencies.map((currency,index)=>tx('multi'+index,{
    currency, amount:currency === 'USDT' || currency === 'USDC' ? 1.234567 : 10+index,
    type:index % 2 === 0 ? 'receita' : 'despesa',
  }))});
  const original=JSON.stringify(ds.transactions); h.load(ds);
  for (const selected of ['DEFAULT',...currencies]) {
    ds.displayCurrency=selected;
    const totalCurrency=selected === 'DEFAULT' ? 'PYG' : selected;
    const amountInTotalCurrency=item=>item.amount*h.rate[item.currency]/h.rate[totalCurrency];
    const income=ds.transactions.filter(item=>item.type==='receita').reduce((sum,item)=>sum+amountInTotalCurrency(item),0);
    const expense=ds.transactions.filter(item=>item.type==='despesa').reduce((sum,item)=>sum+amountInTotalCurrency(item),0);
    h.api.renderAll();
    assert.equal(h.api.dispCur(),totalCurrency);
    assert.equal(h.get('#hero-rec').textContent,h.money(income,totalCurrency),selected+' receitas');
    assert.equal(h.get('#hero-desp').textContent,h.money(expense,totalCurrency),selected+' despesas');
    assert.equal(h.get('#hero-saldo').textContent,h.money(income-expense,totalCurrency),selected+' saldo');
    const categoryChart=h.chartConfigs.get(h.get('#chart-cat'));
    equalNumber(categoryChart.data.datasets[0].data[0],expense);
    const nativeRows=breakdownValues(h.get('#currency-breakdown-rows').innerHTML);
    assert.equal(nativeRows.size,currencies.length);
    assert.equal(h.get('#currency-breakdown-hint').textContent,`Valores originais. Barras comparadas pelo equivalente em ${totalCurrency}.`);
    for (const item of ds.transactions) {
      assert.equal(h.api.txDisplayCurrency(item),item.currency,selected+' origem');
      assert.equal(h.api.txDisplayAmount(item),item.amount,selected+' valor original');
      const label=h.api.fmtTxAmount(item);
      assert(label.includes(h.money(item.amount,item.currency)),selected+' formato original');
      assert.equal((label.match(new RegExp(`\\b${item.currency}\\b`,'g')) || []).length,1,selected+' código da moeda');
      assert(h.get('#tx-tbody').innerHTML.includes(label),selected+' linha original');
      assert.deepEqual(nativeRows.get(item.currency),[
        {label:'Entradas',value:h.money(item.type==='receita'?item.amount:0,item.currency)},
        {label:'Saídas',value:h.money(item.type==='despesa'?item.amount:0,item.currency)},
      ],selected+' Por moeda deve mostrar '+item.currency+' original, não '+totalCurrency);
    }
    h.api.exportCSV();
    const rows=(await h.csv()).replace(/^\uFEFF/,'').split('\r\n').slice(1);
    assert.equal(rows.length,ds.transactions.length);
    for (const row of rows) {
      const fields=row.split(';');
      assert.equal(fields[7],fields[9],selected+' CSV valor exibido é original');
      assert.equal(fields[8],fields[10],selected+' CSV moeda de exibição é original');
    }
    assert.equal(JSON.stringify(ds.transactions),original,selected+' não altera lançamentos persistidos');
  }
});

test('Padrão converte limites e metas à mesma base PYG dos resumos', () => {
  const h = harness();
  const ds = dataset({transactions:[tx('expense',{amount:50,currency:'BRL'})],
    limits:[{id:'lim',name:'Compras',amount:150,currency:'BRL',categories:['Mercado'],versions:[{from:'0000-00',amount:150,categories:['Mercado']}]}],
    metas:[{id:'goal',name:'Reserva',target:500,saved:125,currency:'BRL'}],
  });
  h.load(ds);
  equalNumber(h.api.limitStats()[0].amount,150000);
  equalNumber(h.api.limitStats()[0].spent,50000);
  equalNumber(h.api.metaStats(ds.metas[0]).target,500000);
  equalNumber(h.api.metaStats(ds.metas[0]).saved,125000);
});

test('Por moeda usa período e categorias visíveis, sem aplicar os filtros exclusivos da tabela', () => {
  const h = harness();
  h.load(dataset({transactions:[
    tx('pyg-in',{amount:50000,currency:'PYG',type:'receita'}),
    tx('pyg-out',{amount:25000,currency:'PYG'}),
    tx('usd-out',{amount:10,currency:'USD'}),
    tx('brl-other-month',{amount:999,currency:'BRL',date:'2026-09-30'}),
    tx('clp-other-category',{amount:999,currency:'CLP',category:'Lazer'}),
  ]}));
  h.api.setFilters({cats:new Set(['mercado']),type:'receita',account:'account:Outra',search:'não encontra'});
  const rows = plain(h.api.currencyBreakdown());
  assert.deepEqual(rows.map(row=>row.currency).sort(),['PYG','USD']);
  const pyg = rows.find(row=>row.currency === 'PYG');
  assert.equal(pyg.count,2); assert.equal(pyg.income,50000); assert.equal(pyg.expense,25000);
  equalNumber(pyg.incomeConverted,50000); equalNumber(pyg.expenseConverted,25000);
  const usd = rows.find(row=>row.currency === 'USD');
  equalNumber(usd.expenseConverted,50000);
  h.api.renderCurrencyBreakdown();
  assert.equal(h.get('#currency-breakdown').classList.contains('hidden'),false);
  assert.match(h.get('#currency-breakdown-hint').textContent,/PYG/);
  const html = h.get('#currency-breakdown-rows').innerHTML;
  assert(html.includes('PYG') && html.includes('USD'));
  assert(!html.includes('BRL') && !html.includes('CLP'));
  assert(!/NaN|Infinity/.test(html));
  assert.deepEqual([...html.matchAll(/width:([\d.]+)%/g)].map(match=>Number(match[1])),[100,50,0,100],
    'Barras usam a base PYG: PYG 25.000 é metade de USD 10 convertido para PYG 50.000');
  assert(html.includes(h.money(50000,'PYG')),'A equivalência em guaranis precisa acompanhar o valor original USD');
});

test('Por moeda fica oculto com uma moeda, nenhuma moeda ou outra moeda só fora do período', () => {
  const h = harness();
  h.load(dataset({transactions:[tx('current'),tx('old',{currency:'USD',date:'2026-09-30'})]}));
  h.api.renderCurrencyBreakdown();
  assert.equal(h.get('#currency-breakdown').classList.contains('hidden'),true);
  h.api.setFilters({cats:new Set()}); h.api.renderCurrencyBreakdown();
  assert.equal(h.get('#currency-breakdown').classList.contains('hidden'),true);
});

test('Por moeda respeita os dias exatos de um intervalo e a moeda explícita escolhida', () => {
  const h = harness();
  h.load(dataset({displayCurrency:'BRL',transactions:[
    tx('before',{date:'2026-10-08',currency:'CLP'}),
    tx('first',{date:'2026-10-09',currency:'USD',amount:10}),
    tx('last',{date:'2026-10-12',currency:'PYG',amount:25000}),
    tx('after',{date:'2026-10-13',currency:'USDT'}),
  ]}));
  h.api.setFilters({mode:'range',from:'2026-10-09',to:'2026-10-12'});
  const rows = h.api.currencyBreakdown();
  assert.equal(rows.length,2);
  equalNumber(rows.find(row=>row.currency==='USD').expenseConverted,50);
  equalNumber(rows.find(row=>row.currency==='PYG').expenseConverted,25);
});

test('cotação ausente não vira valor nominal ou zero e preserva os originais em qualquer modo', () => {
  const h = harness();
  const ds = dataset({transactions:[tx('usd',{amount:10,currency:'USD'}),tx('brl',{amount:50,currency:'BRL'})]});
  h.unavailable.add('BRL'); h.load(ds); h.api.renderAll();
  assert.equal(h.get('#hero-desp').textContent,'—');
  assert.equal(h.api.txDisplayAmount(ds.transactions[1]),50);
  const row = h.api.currencyBreakdown().find(item=>item.currency==='BRL');
  assert.equal(row.expense,50); assert.equal(Number.isFinite(row.expenseConverted),false);
  const html = h.get('#currency-breakdown-rows').innerHTML;
  assert(!/NaN|Infinity/.test(html),'Barras e textos nunca recebem NaN/Infinity');
  assert(h.api.fmtTxAmount(ds.transactions[1]).includes(h.money(50,'BRL')));
  for (const selected of ['DEFAULT','PYG','EUR']) {
    ds.displayCurrency=selected;h.api.renderAll();
    const rows=breakdownValues(h.get('#currency-breakdown-rows').innerHTML);
    assert.deepEqual(rows.get('BRL'),[{label:'Entradas',value:h.money(0,'BRL')},{label:'Saídas',value:h.money(50,'BRL')}]);
    assert.match(h.get('#currency-breakdown-rows').innerHTML,/Cotação pendente/);
    assert.equal(h.get('#hero-desp').textContent,'—','Um total sem cotação continua indisponível');
  }
});

test('novas contas estão disponíveis para receitas e despesas e preservam contas personalizadas', () => {
  const h=harness();h.load(dataset({transactions:[tx('custom',{account:'Conta personalizada'}),tx('existing-ueno',{account:'Ueno'})]}));
  const added=['Ether.fi','Ugly Cash','Ueno','Mercury','Itaú'];
  for (const type of ['receita','despesa']) for (const account of added) {
    h.api.openTxModal(null,{type});
    const options=h.get('#tx-account-sel').innerHTML;
    assert(options.includes('<option value="Conta personalizada">Conta personalizada</option>'));
    assert.equal(options.split(`<option value="${account}">`).length-1,1,account+' deve aparecer uma única vez');
    assert.equal(h.get('#tx-account-sel').value,'','Nenhuma conta deve ser presumida');
    h.get('#tx-account-sel').value=account;h.get('#tx-amount').value=h.money(12.34,'BRL');
    h.get('#tx-currency').value='BRL';h.get('#tx-date').value='2026-10-09';h.get('#tx-cat').value='Mercado';
    h.api.saveTxModal();
    const saved=h.api.getDataset().transactions.at(-1);
    assert.equal(saved.account,account);assert.equal(saved.type,type);assert.equal(saved.amount,12.34);assert.equal(saved.currency,'BRL');
  }
});

test('CSV audita moedas originais, modo Padrão e modo explícito sem executar fórmulas', async () => {
  const h = harness();
  const ds = dataset({transactions:[tx('stablecoin',{amount:1.234567,currency:'USDT',desc:'=SUM(A1:A2)'})]});
  h.load(ds); h.api.exportCSV();
  let csv = await h.csv();
  assert(csv.includes("'=SUM(A1:A2)"));
  assert(csv.includes('"1,234567";"USDT";"1,234567";"USDT"'));
  ds.displayCurrency='BRL'; h.api.exportCSV(); csv = await h.csv();
  assert(csv.includes('"1,234567";"USDT";"1,234567";"USDT"'));
  assert.equal(ds.transactions[0].amount,1.234567); assert.equal(ds.transactions[0].currency,'USDT');
});

test('USDT e USDC são distintos, mantêm seis casas e usam cotação própria', () => {
  const h = harness();
  const ds = dataset({transactions:[tx('tether',{amount:1.234567,currency:'USDT'}),tx('coin',{amount:2.345678,currency:'USDC'})]});
  h.load(ds);
  for (const item of ds.transactions) {
    equalNumber(h.api.dispAmount(item),item.amount*h.rate[item.currency]/h.rate.PYG);
    assert(h.api.fmtTxAmount(item).includes(item.currency));
    assert(h.api.fmtTxAmount(item).includes(item.amount.toFixed(6)));
  }
  for (const code of ['USDT','USDC']) {
    ds.displayCurrency=code;
    assert.doesNotThrow(()=>h.api.moneyTicks.callback(123.456));
    assert(h.api.moneyTicks.callback(123.456).includes(code));
    h.api.renderAll();
    assert(h.get('#hero-desp').textContent.includes(code));
  }
});

test('nova entrada no Padrão usa última moeda da pasta e edição conserva sua moeda', () => {
  const h = harness();
  const ds = dataset({transactions:[tx('original',{amount:12.345678,currency:'USDC'})]});
  h.load(ds);
  assert.equal(h.api.entryCur(),'BRL');
  h.values.set('fyg:entry-currency:'+ds.id,'PYG');
  assert.equal(h.api.entryCur(),'PYG'); h.api.openTxModal(null);
  assert.equal(h.get('#tx-currency').value,'PYG');
  ds.displayCurrency='EUR'; h.api.openTxModal(null);
  assert.equal(h.get('#tx-currency').value,'EUR');
  h.api.openTxModal('original');
  assert.equal(h.get('#tx-currency').value,'USDC');
  assert.equal(h.get('#tx-amount').value,h.money(12.345678,'USDC'));
  h.api.saveTxModal();
  assert.equal(h.api.getDataset().transactions[0].amount,12.345678);
  assert.equal(h.api.getDataset().transactions[0].currency,'USDC');
});

test('salvar nova entrada lembra a moeda para essa pasta sem alterar a preferência Padrão', () => {
  const h = harness(); h.load(dataset()); h.api.openTxModal(null);
  h.get('#tx-currency').value='USDT';
  h.get('#tx-amount').value=h.money(4.123456,'USDT');
  h.get('#tx-date').value='2026-10-09'; h.get('#tx-cat').value='Mercado';
  h.api.saveTxModal();
  const ds=h.api.getDataset();
  assert.equal(ds.displayCurrency,'DEFAULT');
  assert.equal(ds.transactions.length,1); assert.equal(ds.transactions[0].amount,4.123456);
  assert.equal(ds.transactions[0].currency,'USDT');
  assert.equal(h.values.get('fyg:entry-currency:'+ds.id),'USDT');
  h.api.openTxModal(null); assert.equal(h.get('#tx-currency').value,'USDT');
});

test('editar meta e limite em outro modo não arredonda nem converte os valores persistidos', () => {
  const h = harness();
  const ds=dataset({displayCurrency:'PYG',
    metas:[{id:'goal',name:'Reserva',currency:'USDT',target:50.123456,saved:1.234567}],
    limits:[{id:'lim',name:'Limite',currency:'USDC',amount:20.123456,categories:['Mercado'],versions:[{from:'0000-00',amount:20.123456,categories:['Mercado']}]}],
  });
  const before=JSON.stringify(ds); h.load(ds);
  h.api.openMetaModal('goal');
  assert.equal(h.get('#meta-target').value,h.money(50.123456,'USDT'));
  assert.equal(h.get('#meta-saved').value,h.money(1.234567,'USDT'));
  h.api.openLimitModal('lim');
  assert.equal(h.get('#limit-amount').value,h.money(20.123456,'USDC'));
  assert.equal(JSON.stringify(ds),before);
});

test('transferências lidas mantêm a moeda do comprovante, direção e revisão antes de salvar', () => {
  const h = harness(); h.load(dataset({displayCurrency:'BRL'}));
  for (const [direcao, type, moeda, valor] of [
    ['enviado','despesa','PYG',50000], ['recebido','receita','USDC',1.234567],
  ]) {
    h.api.openTxModal(null);
    const before = h.api.getDataset().transactions.length;
    h.api.fillTxFromReceipt({direcao,moeda,valor,data:'2026-10-09',categoria:'Mercado',descricao:'Transferência de teste'});
    assert.equal(h.api.getDataset().transactions.length,before,'Leitura deve aguardar confirmação do formulário');
    assert.equal(h.get('#tx-currency').value,moeda);
    assert.equal(h.get('#tx-amount').value,h.money(valor,moeda));
    h.api.saveTxModal();
    const saved = h.api.getDataset().transactions.at(-1);
    assert.equal(saved.type,type); assert.equal(saved.amount,valor); assert.equal(saved.currency,moeda);
    for (const selected of ['DEFAULT','BRL','CLP','PYG','USD','EUR','GBP','USDT','USDC']) {
      h.api.getDataset().displayCurrency=selected;
      assert.equal(h.api.txDisplayCurrency(saved),moeda); assert.equal(h.api.txDisplayAmount(saved),valor);
      assert(h.api.fmtTxAmount(saved).includes(h.money(valor,moeda)),selected+' transferência original');
    }
  }
});
