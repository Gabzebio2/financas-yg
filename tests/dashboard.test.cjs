const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// VM isolada: usa os utilitários e Store reais, DOM mínimo e armazenamento
// em memória. Nenhuma conta, API ou base financeira do usuário é acessada.
class Element {
  constructor() {
    this.value = ''; this.textContent = ''; this.innerHTML = ''; this.dataset = {};
    this.style = {}; this.childNodes = [{ nodeValue: '' }]; this.parentElement = this;
    this.checked = false; this.selectedIndex = 0; this.listeners = new Map();
    this.children = []; const classes = new Set();
    this.classList = {
      add: (...cs) => cs.forEach(c => classes.add(c)), remove: (...cs) => cs.forEach(c => classes.delete(c)),
      contains: c => classes.has(c), toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : !!force;
        if (on) classes.add(c); else classes.delete(c); return on;
      },
    };
  }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  setAttribute(name, value) { this[name] = value; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  appendChild(child) { this.children.push(child); }
  focus() {}
  click() { this.clicked = true; }
  dispatchEvent() {}
  remove() {}
}
const nodes = new Map();
const selectorGroups = new Map();
const get = selector => { if (!nodes.has(selector)) nodes.set(selector, new Element()); return nodes.get(selector); };
const documentCallbacks = [];
const storage = new Map();
const memoryStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: key => storage.delete(key),
};
const win = { addEventListener() {}, matchMedia: () => ({matches:false}) };
win.self = win; win.top = win;
let csvBlob;
let ratesAvailable = true;
const ctx = vm.createContext({
  console, Blob, Event, URL: { createObjectURL(blob) { csvBlob = blob; return 'blob:test'; }, revokeObjectURL() {} },
  window: win, localStorage: memoryStorage, InstallmentSchedule: require('../js/installment-schedule.js'),
  TransactionCategories: require('../js/transaction-categories.js'),
  document: {
    body: new Element(), createElement: () => new Element(),
    querySelector: get, querySelectorAll: selector => selectorGroups.get(selector) || [],
    addEventListener: (event, callback) => { if (event === 'DOMContentLoaded') documentCallbacks.push(callback); },
  },
  setTimeout: () => 0, clearTimeout() {},
  Rates: { ready: (from,to) => from===to || ratesAvailable, convert: (v, from, to) => Number(v) * ({BRL:1, USD:5, CLP:0.005, PYG:0.001}[from] / {BRL:1, USD:5, CLP:0.005, PYG:0.001}[to]), load() {}, onUpdate() {}, updatedAt: () => null },
});
const appDir = path.join(__dirname, '..');
vm.runInContext(fs.readFileSync(path.join(appDir, 'js/app.js'), 'utf8'), ctx);
let source = fs.readFileSync(path.join(appDir, 'js/dashboard.js'), 'utf8');
source = source.replace('  return { open, openTxModal,', `
  globalThis.audit = {
    requestDeleteTx, deleteSeries, openAdvance, saveAdvance, advanceCandidates, updateAdvance,
    splitInstallments, tableTxs, sortTxs, allMonths, renderCharts, saveTxModal, openTxModal, openMetaModal, saveMetaModal,
    openLimitModal, saveLimitModal, renderTable, renderSummary, parcSiblings, fixedSiblings,
    resolveImportDate, appendImported, addBulk, exportCSV, saveCur, undo, moneyTip, refreshFromStore,
    existingTxKeys, existingSeriesKeys, existingTransactions, getImportTargetId, renderAll, limitStats, metaStats, addToMeta, fillTxFromReceipt, changeBill, currencyBreakdown,
    setDataset(value) { ds = value; billCalendarDate = todayISO(); }, getDataset() { return ds; },
    setFilters(value) { fil = {mode:'month', month:'2026-10', from:'', to:'', cats:null, search:'', type:'all', account:'all', ...value}; },
    setSort(value) { sort = value; }, selectedTx, undoStack,
  };
  return { open, openTxModal,`);
vm.runInContext(source, ctx);
documentCallbacks.at(-1)();
const api = ctx.audit;
const tx = (id, extra = {}) => ({id, date:'2026-10-09', desc:'Compra', category:'Mercado', account:'Banco', type:'despesa', amount:10, currency:'BRL', ...extra});
const dataset = () => ({id:'audit001', name:'Teste', categories:[{name:'Mercado',color:'#123456'}], transactions:[], limits:[], metas:[], displayCurrency:'BRL'});
const saveBase = ds => {
  storage.set('fyg:ds:' + ds.id, JSON.stringify(ds));
  storage.set('fyg:index', JSON.stringify([{id:ds.id, name:ds.name}]));
  api.setDataset(ds); api.setFilters({}); api.undoStack.length = 0;
};
const cases = [];
const test = (name, fn) => cases.push([name, fn]);
const receipt = (extra={}) => ({direcao:'enviado',moeda:'BRL',valor:10,data:'2026-10-09',categoria:'Mercado',instituicao:'C6',descricao:'Compra',referenceId:'synthetic-reference',sourceEvidence:'Trecho sintético de comprovante',sourcePage:2,...extra});
function acceptReceiptConfirmation() {
  const cb=vm.runInContext('confirmCallback',ctx);
  assert.equal(typeof cb,'function','Deve haver confirmação pendente');
  vm.runInContext('closeConfirmModal()',ctx);cb();
}

test('digitar sugere a categoria e respeita escolhas explícitas, inclusive em leituras posteriores', () => {
  const ds = dataset();
  for (const name of ['Saúde', 'Lazer', 'Receita', 'Outros']) ds.categories.push({name, color:'#123456'});
  saveBase(ds);
  const description = get('#tx-desc'), category = get('#tx-cat');
  const type = value => { description.value = value; description.listeners.get('input')(); };
  api.openTxModal(null);
  type('Farmácia Modelo'); assert.equal(category.value,'Saúde');
  type('Supermercado Central'); assert.equal(category.value,'Mercado');
  category.value = 'Lazer'; category.listeners.get('change')({target:category});
  api.fillTxFromReceipt(receipt({descricao:'Supermercado Central', categoria:'Mercado'}));
  assert.equal(category.value,'Lazer');
  api.saveTxModal();
  const saved = api.getDataset().transactions[0];
  assert.equal(saved.category,'Lazer'); assert.equal(saved.categoryEdited,true);
  api.openTxModal(null);
  type('Supermercado Central'); assert.equal(category.value,'Lazer');
  api.openTxModal(null, {type:'receita'}); assert.equal(category.value,'Receita');
  api.openTxModal(saved.id);
  type('Farmácia Modelo'); assert.equal(category.value,'Lazer');
});

test('importação mantém indicador de data aproximada e o apresenta na tabela', () => {
  saveBase(dataset());
  const item=tx('incoming',{date:'2026-10-09',dateEstimated:true,dateEstimate:{method:'between',previousDate:'2026-10-07',nextDate:'2026-10-11'}});
  assert.equal(api.appendImported([item]),1);
  const saved=JSON.parse(storage.get('fyg:ds:audit001')).transactions[0];
  assert.equal(saved.dateEstimated,true);
  assert.deepEqual(saved.dateEstimate,item.dateEstimate);
  assert.match(get('#tx-tbody').innerHTML,/Data aproximada/);
  api.refreshFromStore();
  assert.equal(api.getDataset().transactions[0].dateEstimated,true);
});

test('edição de descrição preserva aproximação e alteração manual da data a remove', () => {
  const ds=dataset();ds.transactions=[tx('estimated',{dateEstimated:true,dateEstimate:{method:'nearest',previousDate:'2026-10-09'}})];saveBase(ds);
  api.openTxModal('estimated');get('#tx-desc').value='Descrição revisada';api.saveTxModal();
  assert.equal(api.getDataset().transactions[0].dateEstimated,true);
  api.openTxModal('estimated');get('#tx-date').value='2026-10-10';api.saveTxModal();
  const saved=JSON.parse(storage.get('fyg:ds:audit001')).transactions[0];
  assert.equal(saved.date,'2026-10-10');assert.equal(saved.dateEstimated,undefined);assert.equal(saved.dateEstimate,undefined);
  assert(!get('#tx-tbody').innerHTML.includes('Data aproximada'));
});

test('redigitar a mesma data também remove aproximação, sem apagar antes de salvar', () => {
  const ds=dataset();ds.transactions=[tx('estimated',{dateEstimated:true,dateEstimate:{method:'nearest',nextDate:'2026-10-09'}})];saveBase(ds);
  api.openTxModal('estimated');get('#tx-date').listeners.get('input')();
  assert.equal(api.getDataset().transactions[0].dateEstimated,true,'A edição pendente não altera os dados salvos');
  api.saveTxModal();
  const saved=JSON.parse(storage.get('fyg:ds:audit001')).transactions[0];
  assert.equal(saved.date,'2026-10-09');assert.equal(saved.dateEstimated,undefined);assert.equal(saved.dateEstimate,undefined);
});

test('comprovante repetido pede comparação e só salva após confirmação explícita', () => {
  const ds=dataset();ds.transactions=[tx('original',{account:'C6',referenceId:'synthetic-reference'})];saveBase(ds);
  api.openTxModal(null);api.fillTxFromReceipt(receipt());api.saveTxModal();
  assert.equal(api.getDataset().transactions.length,1);
  assert.equal(get('#modal-confirm').classList.contains('hidden'),false);
  assert.match(get('#modal-confirm-text').textContent,/Novo lançamento:.*10,00.*BRL/);
  assert.match(get('#modal-confirm-text').textContent,/Já lançado:/);
  assert.equal(get('#btn-confirm-ok').textContent,'Adicionar mesmo assim');
  acceptReceiptConfirmation();
  const saved=api.getDataset().transactions.at(-1);
  assert.equal(api.getDataset().transactions.length,2);assert.notEqual(saved.id,'original');
  assert.equal(saved.referenceId,'synthetic-reference');assert.equal(saved.sourceEvidence,'Trecho sintético de comprovante');assert.equal(saved.sourcePage,2);
  vm.runInContext('askConfirm("Excluir?","Texto",()=>{})',ctx);
  assert.equal(get('#btn-confirm-ok').textContent,'Excluir','Uma confirmação posterior deve recuperar o rótulo padrão');
  vm.runInContext('closeConfirmModal()',ctx);
});

test('editar formulário invalida confirmação antiga e cancelar mantém apenas o original', () => {
  const ds=dataset();ds.transactions=[tx('original',{account:'C6',referenceId:'synthetic-reference'})];saveBase(ds);
  api.openTxModal(null);api.fillTxFromReceipt(receipt());api.saveTxModal();
  get('#tx-desc').value='Descrição revisada';acceptReceiptConfirmation();
  assert.equal(api.getDataset().transactions.length,1);
  assert.equal(get('#modal-confirm').classList.contains('hidden'),false,'Mudança exige nova comparação');
  assert.match(get('#modal-confirm-text').textContent,/Descrição revisada/);
  vm.runInContext('closeConfirmModal()',ctx);
  assert.equal(api.getDataset().transactions.length,1);
});

test('nova gravação externa é comparada e preservada ao confirmar recibo', () => {
  saveBase(dataset());api.openTxModal(null);api.fillTxFromReceipt(receipt());
  const latest=dataset();latest.transactions=[tx('external',{account:'C6',referenceId:'synthetic-reference',custom:{preserve:true}})];
  storage.set('fyg:ds:'+latest.id,JSON.stringify(latest));
  const copied=api.existingTransactions();assert.equal(copied.length,1);copied[0].custom.preserve=false;
  assert.equal(JSON.parse(storage.get('fyg:ds:'+latest.id)).transactions[0].custom.preserve,true,'Leitura devolve cópia');
  assert.equal(api.getImportTargetId(),latest.id);
  api.saveTxModal();assert.equal(api.getDataset().transactions.length,1);
  acceptReceiptConfirmation();
  const saved=JSON.parse(storage.get('fyg:ds:'+latest.id));assert.equal(saved.transactions.length,2);
  assert.equal(saved.transactions[0].id,'external');assert.equal(saved.transactions[0].custom.preserve,true);
});

test('alteração do lançamento comparado durante confirmação exige revisão nova', () => {
  const ds=dataset();ds.transactions=[tx('original',{account:'C6',referenceId:'synthetic-reference'})];saveBase(ds);
  api.openTxModal(null);api.fillTxFromReceipt(receipt());api.saveTxModal();
  const latest=JSON.parse(storage.get('fyg:ds:'+ds.id));latest.transactions[0].amount=11;
  storage.set('fyg:ds:'+ds.id,JSON.stringify(latest));acceptReceiptConfirmation();
  assert.equal(api.getDataset().transactions.length,1);
  assert.equal(get('#modal-confirm').classList.contains('hidden'),false);assert.match(get('#modal-confirm-text').textContent,/11,00/);
  acceptReceiptConfirmation();
  const saved=api.getDataset().transactions;assert.equal(saved.length,2);assert.equal(saved[0].amount,11);assert.equal(saved[1].amount,10);
});

test('confirmação pendente não salva em formulário novo ou em outra pasta', () => {
  const ds=dataset();ds.transactions=[tx('original',{account:'C6'})];saveBase(ds);
  api.openTxModal(null);api.fillTxFromReceipt(receipt());api.saveTxModal();
  api.openTxModal(null);acceptReceiptConfirmation();assert.equal(api.getDataset().transactions.length,1);
  api.fillTxFromReceipt(receipt());api.saveTxModal();
  const other=dataset();other.id='otherfolder';saveBase(other);
  acceptReceiptConfirmation();assert.equal(api.getDataset().transactions.length,0);
});

test('abrir novo formulário limpa evidência do recibo e entrada manual não dispara guard de leitura', () => {
  saveBase(dataset());api.openTxModal(null);api.fillTxFromReceipt(receipt());
  api.openTxModal(null);get('#tx-amount').value='R$ 10,00';get('#tx-date').value='2026-10-09';get('#tx-cat').value='Mercado';
  api.saveTxModal();const saved=api.getDataset().transactions[0];
  assert.equal(saved.referenceId,undefined);assert.equal(saved.sourceEvidence,undefined);assert.equal(saved.sourcePage,undefined);
});

test('trocar conta após leitura ou durante confirmação não grava o comprovante anterior', () => {
  let owner='owner-A';ctx.Cloud={getSyncState:()=>({owner})};
  try {
    saveBase(dataset());api.openTxModal(null);api.fillTxFromReceipt(receipt());
    owner='owner-B';api.saveTxModal();assert.equal(api.getDataset().transactions.length,0);
    assert.match(get('#toast').textContent,/conta.*mudou/);
    owner='owner-A';const ds=dataset();ds.transactions=[tx('original',{account:'C6',referenceId:'synthetic-reference'})];saveBase(ds);
    api.openTxModal(null);api.fillTxFromReceipt(receipt());api.saveTxModal();
    const before=new Map(storage);owner=null;acceptReceiptConfirmation();
    assert.equal(api.getDataset().transactions.length,1);assert.deepEqual(storage,before);
    assert.match(get('#toast').textContent,/conta.*mudou/);
  } finally { delete ctx.Cloud;vm.runInContext('closeConfirmModal()',ctx); }
});

test('importações mantêm evidência limitada, IDs novos e registros externos sem copiar referência para projeções', () => {
  saveBase(dataset());
  const latest=dataset();latest.transactions=[tx('external')];storage.set('fyg:ds:'+latest.id,JSON.stringify(latest));
  assert.equal(api.addBulk([tx('incoming',{referenceId:'r'.repeat(170),sourceEvidence:'e'.repeat(320),sourcePage:3})]),1);
  assert.equal(api.getDataset().transactions.length,2);let saved=api.getDataset().transactions.at(-1);
  assert.notEqual(saved.id,'incoming');assert.equal(saved.referenceId.length,160);assert.equal(saved.sourceEvidence.length,300);assert.equal(saved.sourcePage,3);
  assert.equal(api.appendImported([tx('incoming',{referenceId:'other',sourceEvidence:'evidence',sourcePage:0})]),1);
  saved=api.getDataset().transactions.at(-1);assert.equal(saved.referenceId,'other');assert.equal(saved.sourceEvidence,'evidence');assert.equal(saved.sourcePage,undefined);
  saveBase(dataset());api.openTxModal(null);api.fillTxFromReceipt(receipt());get('#tx-parcelado').checked=true;get('#tx-nparc').value='2';api.saveTxModal();
  assert.equal(api.getDataset().transactions[0].referenceId,'synthetic-reference');assert.equal(api.getDataset().transactions[1].referenceId,undefined);
});

test('pasta removida durante leitura não é recriada ao salvar ou importar', () => {
  const ds=dataset();saveBase(ds);api.openTxModal(null);api.fillTxFromReceipt(receipt());storage.delete('fyg:ds:'+ds.id);
  api.saveTxModal();assert.equal(api.getDataset().transactions.length,0);assert.equal(storage.has('fyg:ds:'+ds.id),false);
  assert.equal(api.addBulk([tx('new')]),0);assert.equal(api.appendImported([tx('new')]),0);assert.equal(storage.has('fyg:ds:'+ds.id),false);
});

test('comprovante sem data e categoria não herda valores anteriores nem gera séries', () => {
  saveBase(dataset()); api.openTxModal(null);
  get('#tx-date').value = '2026-10-09'; get('#tx-cat').value = 'Mercado';
  get('#tx-account-sel').value = 'C6'; get('#tx-parcelado').checked = true; get('#tx-fixa').checked = true;
  api.fillTxFromReceipt({direcao:'enviado', moeda:'BRL', valor:100, data:'', categoria:'Sem evidência', instituicao:'', descricao:'Compra'});
  assert.equal(get('#tx-date').value,'');
  assert.equal(get('#tx-cat').value,'');
  assert.equal(get('#tx-account-sel').value,'');
  assert.equal(get('#tx-parcelado').checked,false);
  assert.equal(get('#tx-fixa').checked,false);
  api.saveTxModal();
  assert.equal(api.getDataset().transactions.length,0);
});

test('sincronização forçada atualiza conteúdo mesmo com timestamp igual', () => {
  const ds = dataset(); ds.updatedAt='2026-10-09T10:00:00.000Z'; saveBase(ds);
  const remote = {...ds, transactions:[tx('remote-01')]};
  storage.set('fyg:ds:' + ds.id, JSON.stringify(remote));
  assert.equal(api.refreshFromStore({force:true}),true);
  assert.equal(api.getDataset().transactions[0].id,'remote-01');
});

test('parcelas conservam centavos e nunca ficam negativas', () => {
  for (const total of [0.10, 1, 10, 100.01, 999.99]) {
    for (let n = 2; n <= Math.min(48, Math.round(total*100)); n++) {
      const parts = api.splitInstallments(total, n, 'BRL');
      assert.equal(parts.length, n);
      assert.equal(parts.reduce((s,v) => s + Math.round(v*100), 0), Math.round(total*100));
      assert(parts.every(v => v > 0));
    }
  }
  assert.equal(api.splitInstallments(10, 2.5, 'BRL'), null);
  assert.equal(api.splitInstallments(10, 49, 'BRL'), null);
  assert.equal(api.splitInstallments(0.01, 2, 'BRL'), null);
  assert.equal(api.splitInstallments(Infinity, 2, 'BRL'), null);
});
test('parcelas CLP/PYG são inteiras e fecham o total', () => {
  for (const currency of ['CLP','PYG']) {
    const parts = api.splitInstallments(100, 3, currency);
    assert.equal(parts.reduce((s,v)=>s+v,0),100);
    assert(parts.every(Number.isInteger));
  }
});
test('salvar parcelamento preserva o dia-base após fevereiro', () => {
  saveBase(dataset()); api.openTxModal(null);
  get('#tx-amount').value = 'R$ 0,10'; get('#tx-date').value = '2027-01-31';
  get('#tx-cat').value = 'Mercado'; get('#tx-parcelado').checked = true; get('#tx-nparc').value = '6';
  api.saveTxModal();
  const txs = api.getDataset().transactions;
  assert.equal(txs.length,6);
  assert.equal(txs[1].date,'2027-02-28'); assert.equal(txs[2].date,'2027-03-31');
  assert.equal(txs.reduce((s,t)=>s+Math.round(t.amount*100),0),10);
});
test('datas impossíveis e parcelas fracionárias não são salvas', () => {
  saveBase(dataset()); api.openTxModal(null);
  get('#tx-amount').value = 'R$ 10,00'; get('#tx-date').value = '2027-02-30'; get('#tx-cat').value = 'Mercado';
  api.saveTxModal(); assert.equal(api.getDataset().transactions.length,0);
  get('#tx-date').value = '2027-02-28'; get('#tx-parcelado').checked = true; get('#tx-nparc').value = '2.5';
  api.saveTxModal(); assert.equal(api.getDataset().transactions.length,0);
});
test('converter uma despesa usa o original e repete só os 11 meses seguintes',()=>{
  const ds=dataset();ds.transactions=[tx('original',{date:'2027-01-31',currency:'USD',referenceId:'ref1',cashback:{amount:.25,currency:'USD'}})];
  saveBase(ds);api.openTxModal('original');
  assert.equal(get('#tx-fixa-wrap').classList.contains('hidden'),false);
  assert.equal(get('#tx-fixa').checked,false);assert.equal(get('#tx-fixa').disabled,false);
  get('#tx-fixa').checked=true;get('#tx-desc').value='Assinatura';api.saveTxModal();api.saveTxModal();
  const rows=api.getDataset().transactions;
  assert.equal(rows.length,12);assert.equal(new Set(rows.map(t=>t.id)).size,12);
  assert.equal(rows[0].id,'original');assert.equal(rows[0].referenceId,'ref1');assert.equal(rows[0].cashback.amount,.25);
  assert(rows[0].groupId&&rows.every(t=>t.fixed&&t.groupId===rows[0].groupId&&t.currency==='USD'&&t.desc==='Assinatura'&&t.amount===10));
  assert(rows.slice(1).every(t=>!t.referenceId&&!t.cashback));
  assert.deepEqual(Array.from(rows.slice(0,3),t=>t.date),['2027-01-31','2027-02-28','2027-03-31']);
  assert.equal(rows[11].date,'2027-12-31');
  api.openTxModal(rows[1].id);assert(get('#tx-fixa').checked&&get('#tx-fixa').disabled);
  get('#tx-desc').value='Só fevereiro';api.saveTxModal();
  assert.equal(api.getDataset().transactions.length,12);assert.equal(api.getDataset().transactions[2].desc,'Assinatura');
});
test('cancelar, desfazer e editar uma parcela não criam recorrências',()=>{
  const ds=dataset();ds.transactions=[tx('one'),tx('part',{groupId:'series',installment:'1/3'})];saveBase(ds);
  api.openTxModal('one');get('#tx-fixa').checked=true;get('#btn-tx-cancel').listeners.get('click')();
  assert.equal(api.getDataset().transactions.length,2);
  api.openTxModal('one');get('#tx-fixa').checked=true;api.saveTxModal();api.undo();
  assert.equal(api.getDataset().transactions.length,2);assert(!api.getDataset().transactions[0].fixed);
  api.openTxModal('part');assert(get('#tx-fixa-wrap').classList.contains('hidden'));
  get('#tx-fixa').checked=true;api.saveTxModal();assert.equal(api.getDataset().transactions.length,2);
  assert.equal(api.getDataset().transactions[1].installment,'1/3');assert(!api.getDataset().transactions[1].fixed);
});
test('filtros por tipo, conta, busca e categoria combinam corretamente', () => {
  const ds=dataset(); ds.transactions=[tx('trans001'),tx('trans002',{type:'receita',account:'',desc:'Salário'}),tx('trans003',{date:'2026-09-01'})]; saveBase(ds);
  api.setFilters({type:'receita', account:'account:',search:'salario'});
  assert.equal(api.tableTxs().length,1);
  api.setFilters({cats:new Set()}); assert.equal(api.tableTxs().length,0);
  get('#cat-dropdown').listeners.get('change')({target:{dataset:{cat:'__all__'},checked:false}});
  assert.equal(api.tableTxs().length,0);
});
test('seleção escondida pelo filtro não permanece no lote', () => {
  const ds=dataset(); ds.transactions=[tx('trans001'),tx('trans002',{type:'receita'})]; saveBase(ds);
  api.selectedTx.add('trans001'); api.selectedTx.add('trans002');
  api.setFilters({type:'receita'}); api.renderTable();
  assert.deepEqual([...api.selectedTx],['trans002']);
  api.setFilters({cats:new Set()}); api.renderTable();
  assert.equal(api.selectedTx.size,0); assert.equal(get('#tx-sel-all').checked,false);
});
test('ordenação financeira usa moeda de exibição', () => {
  saveBase(dataset()); api.setSort({key:'amount',dir:1});
  const list=api.sortTxs([tx('usd',{amount:3,currency:'USD'}),tx('brl',{amount:10})]);
  assert.deepEqual(Array.from(list,t=>t.id),['usd','brl']);
});
test('tooltip horizontal usa valor X e mantém sinal do saldo', () => {
  saveBase(dataset());
  assert.match(api.moneyTip.callbacks.label({dataset:{label:'Gasto'},parsed:{x:125,y:0},chart:{options:{indexAxis:'y'}}}),/125/);
  assert.match(api.moneyTip.callbacks.label({dataset:{label:'Saldo'},parsed:{x:0,y:-50},chart:{options:{}}}),/-/);
});
test('edição de metas mantém moeda e valores originais', () => {
  const ds=dataset(); ds.displayCurrency='CLP'; ds.metas=[{id:'meta001',name:'Reserva',target:100.13,saved:25.07,currency:'USD'}]; saveBase(ds);
  api.openMetaModal('meta001'); get('#meta-name').value='Reserva atualizada'; api.saveMetaModal();
  const m=api.getDataset().metas[0]; assert.equal(m.currency,'USD'); assert.equal(m.target,100.13); assert.equal(m.saved,25.07);
  assert.equal(get('.meta-modal-sub').textContent,'');
  assert(get('#modal-meta .meta-modal-sub').textContent.length > 0);
});
test('edição de limite preserva moeda e histórico anterior', () => {
  const ds=dataset(); ds.displayCurrency='CLP'; ds.limits=[{id:'limit001',name:'Mercado',amount:20.13,currency:'USD',categories:['Mercado'],versions:[{from:'0000-00',amount:10.17,categories:['Mercado']},{from:'2026-10',amount:20.13,categories:['Mercado']}]}]; saveBase(ds);
  selectorGroups.set('#limit-cats input:checked',[{value:'Mercado'}]);
  get('input[name="limit-scope"]:checked').value='from';
  api.openLimitModal('limit001'); get('#limit-name').value='Novo nome'; api.saveLimitModal();
  const l=api.getDataset().limits[0]; assert.equal(l.currency,'USD'); assert.equal(l.amount,20.13); assert.equal(l.versions[0].amount,10.17);
});
test('fallback de parcelas antigas não une compras de meses/moedas diferentes', () => {
  const ds=dataset(); const a=tx('part001',{installment:'1/3',date:'2026-10-10',totalValue:30});
  ds.transactions=[a,tx('part002',{installment:'2/3',date:'2026-11-10',totalValue:30}),tx('part003',{installment:'1/3',date:'2026-11-10',totalValue:30}),tx('part004',{installment:'2/3',date:'2026-11-10',totalValue:30,currency:'USD'})]; saveBase(ds);
  assert.deepEqual(Array.from(api.parcSiblings(a),t=>t.id),['part001','part002']);
});
test('importações rejeitam datas inválidas e valores não finitos', () => {
  saveBase(dataset());
  const values=[tx('ok'),tx('bad',{date:'2026-02-30'}),tx('infinity',{amount:Infinity})];
  assert.equal(api.appendImported(values),0);
  assert.equal(api.addBulk(values),1);
  api.setFilters({month:'2026-09'});
  assert.equal(api.resolveImportDate('2026-02-30'),'2026-09-01');
});

test('lote misto é rejeitado integralmente antes de gravar, criar categorias ou consumir histórico', () => {
  const ds=dataset();ds.transactions=[tx('existing')];saveBase(ds);
  api.undoStack.push('historico-preservado');api.selectedTx.clear();api.selectedTx.add('existing');
  const beforeStorage=new Map(storage),beforeDataset=JSON.stringify(api.getDataset());
  const originalSave=vm.runInContext('Store.saveDataset',ctx),store=vm.runInContext('Store',ctx);let writes=0;
  ctx.countImportSave=(...args)=>{writes++;return originalSave.apply(store,args);};
  vm.runInContext('Store.saveDataset = countImportSave',ctx);
  try {
    for(const invalid of [null,tx('invalid',{date:'2026-02-30'}),tx('invalid',{amount:Infinity}),
      tx('invalid',{amount:0}),tx('invalid',{amount:true}),tx('invalid',{amount:Number.MAX_SAFE_INTEGER+1}),
      tx('invalid',{type:'duvidoso'}),tx('invalid',{currency:'INVALID'})]) {
      const incoming=[tx('valid',{category:'Categoria inédita'}),invalid,tx('valid-last',{currency:'USD'})];
      const originalInput=JSON.stringify(incoming);
      assert.equal(api.appendImported(incoming),0);
      assert.equal(JSON.stringify(incoming),originalInput);
      assert.equal(JSON.stringify(api.getDataset()),beforeDataset);
      assert.deepEqual(storage,beforeStorage);
      assert.deepEqual(Array.from(api.undoStack),['historico-preservado']);
      assert.deepEqual(Array.from(api.selectedTx),['existing']);
    }
    assert.equal(writes,0);
    assert.match(get('#toast').textContent,/Nenhum lançamento foi adicionado/);
    assert.equal(api.appendImported([tx('valid',{referenceId:'DEMONSTRACAO-1'}),tx('valid-last',{currency:'USD'})]),2);
    assert.equal(writes,1);
    assert.equal(api.getDataset().transactions.length,3);
  } finally { ctx.originalSave=originalSave;vm.runInContext('Store.saveDataset = originalSave',ctx);api.selectedTx.clear(); }
});
test('falha de gravação restaura dados e não consome histórico do desfazer', () => {
  const ds=dataset(); ds.transactions=[tx('trans001')]; saveBase(ds);
  const originalSave=vm.runInContext('Store.saveDataset',ctx);
  vm.runInContext('Store.saveDataset = () => { throw new Error("quota"); }',ctx);
  ds.transactions.push(tx('trans002'));
  assert.throws(()=>api.saveCur(),/quota/);
  assert.equal(api.getDataset().transactions.length,1); assert.equal(api.undoStack.length,0);
  api.undoStack.push(JSON.stringify(dataset()));
  assert.throws(()=>api.undo(),/quota/); assert.equal(api.undoStack.length,1);
  ctx.originalSave=originalSave; vm.runInContext('Store.saveDataset = originalSave',ctx);
});
test('CSV respeita filtro, moeda original e neutraliza fórmulas', async () => {
  const ds=dataset(); ds.transactions=[tx('trans001',{desc:'=SUM(A1:A3)',amount:3,currency:'USD'}),tx('trans002',{type:'receita',desc:'Não exportar'})]; saveBase(ds);
  api.setFilters({type:'despesa'}); api.exportCSV();
  const csv=await csvBlob.text();
  assert(csv.includes("'=SUM(A1:A3)")); assert(!csv.includes('Não exportar'));
  assert(csv.includes('"3,00";"USD";"3,00";"USD"'));
});
test('sync atualiza pasta em memória, preserva filtros e invalida undo antigo', () => {
  const ds=dataset(); ds.updatedAt='2026-10-09T10:00:00.000Z'; ds.transactions=[tx('trans001')]; saveBase(ds);
  api.setFilters({type:'receita'}); api.undoStack.push(JSON.stringify(dataset()));
  const remote={...ds, updatedAt:'2026-10-09T11:00:00.000Z',transactions:[...ds.transactions,tx('trans002',{type:'receita'})]};
  storage.set('fyg:ds:'+ds.id,JSON.stringify(remote));
  assert.equal(api.refreshFromStore(),true); assert.equal(api.getDataset().transactions.length,2);
  assert.equal(api.tableTxs().length,1); assert.equal(api.undoStack.length,0);
  assert.equal(api.refreshFromStore(),false);
});
test('chaves de duplicação distinguem moedas e valores das séries', () => {
  const ds=dataset(); ds.transactions=[tx('trans001',{installment:'1/3',currency:'USD'}),tx('trans002',{installment:'1/3',currency:'BRL'}),tx('trans003',{installment:'1/3',amount:11})]; saveBase(ds);
  assert.equal(api.existingTxKeys().size,3); assert.equal(api.existingSeriesKeys().size,3);
});
test('Enter em Cancelar, botões, selects e composição não salva transação', () => {
  saveBase(dataset()); api.openTxModal(null);
  get('#tx-amount').value='R$ 10,00'; get('#tx-date').value='2026-10-09'; get('#tx-cat').value='Mercado';
  const listener=get('#modal-tx').listeners.get('keydown');
  for(const tagName of ['BUTTON','SELECT']) listener({key:'Enter',target:{tagName},preventDefault(){}});
  listener({key:'Enter',isComposing:true,target:{tagName:'INPUT',type:'text'},preventDefault(){}});
  assert.equal(api.getDataset().transactions.length,0);
});
test('sem cotação não inventa totais, limites ou metas convertidas', async () => {
  ratesAvailable=false;
  try {
    const ds=dataset(); ds.transactions=[tx('trans001',{currency:'USD',amount:10}),tx('trans002',{amount:20})];
    ds.limits=[{id:'limit001',name:'Mercado',amount:100,currency:'BRL',categories:['Mercado'],versions:[{from:'0000-00',amount:100,categories:['Mercado']}]}];
    ds.metas=[{id:'meta001',name:'Reserva',currency:'USD',target:100,saved:20},{id:'meta002',name:'Cobrança',category:'Mercado'}]; saveBase(ds);
    api.renderAll();
    assert.equal(get('#hero-saldo').textContent,'—'); assert.equal(get('#hero-desp').textContent,'—'); assert.equal(get('#hero-acc').textContent,'—');
    assert(get('#tx-tbody').innerHTML.includes('$10.00 · USD'));
    assert(get('#limits-groups').innerHTML.includes('Cotação indisponível'));
    assert(get('#metas-groups').innerHTML.includes('Cotação indisponível'));
    assert.equal(api.limitStats()[0].unavailable,true); assert.equal(api.metaStats(ds.metas[1]).unavailable,true);
    api.exportCSV(); const csv=await csvBlob.text();
    assert(csv.includes('"10,00";"USD";"10,00";"USD"')); assert(!csv.includes('NaN'));
    api.addToMeta(ds.metas[0]); vm.runInContext('nameCallback("R$ 10,00")',ctx);
    assert.equal(ds.metas[0].saved,20);
  } finally { ratesAvailable=true; }
});
test('sem cotação valores da própria moeda continuam válidos', () => {
  ratesAvailable=false;
  try {
    const ds=dataset(); ds.transactions=[tx('trans001',{amount:20})]; saveBase(ds); api.renderSummary();
    assert.match(get('#hero-desp').textContent,/20/); assert.match(get('#hero-saldo').textContent,/-/);
  } finally { ratesAvailable=true; }
});

const series = (fixed=false) => Array.from({length:4},(_,i)=>tx('series'+i,{date:`2026-${String(i+8).padStart(2,'0')}-15`,groupId:'series-group',fixed,installment:fixed?null:`${i+1}/4`}));
test('fixa: excluir deste mês em diante mantém meses anteriores e outra série',()=>{
 const ds=dataset();ds.transactions=[...series(true),tx('outside',{groupId:'other'})];saveBase(ds);
 api.requestDeleteTx('series2');api.deleteSeries('following');assert.equal(ds.transactions.length,5);acceptReceiptConfirmation();
 assert.deepEqual(Array.from(api.getDataset().transactions,t=>t.id),['series0','series1','outside']);api.undo();assert.equal(api.getDataset().transactions.length,5);
});
test('fixa: excluir tudo remove apenas a série, incluindo meses anteriores',()=>{
 const ds=dataset();ds.transactions=[...series(true),tx('outside')];saveBase(ds);api.requestDeleteTx('series2');api.deleteSeries('all');acceptReceiptConfirmation();
 assert.deepEqual(Array.from(api.getDataset().transactions,t=>t.id),['outside']);
});
test('parcelas: apagar somente a escolhida preserva anteriores e seguintes',()=>{
 const ds=dataset();ds.transactions=series();saveBase(ds);api.requestDeleteTx('series2');api.deleteSeries('one');acceptReceiptConfirmation();
 assert.deepEqual(Array.from(api.getDataset().transactions,t=>t.id),['series0','series1','series3']);
});
test('parcelas: apagar tudo inclui parcelas anteriores e posteriores',()=>{
 const ds=dataset();ds.transactions=series();saveBase(ds);api.requestDeleteTx('series2');api.deleteSeries('all');acceptReceiptConfirmation();assert.equal(api.getDataset().transactions.length,0);
});
test('exclusão pendente não atravessa troca de pasta',()=>{
 const ds=dataset();ds.transactions=series();saveBase(ds);api.requestDeleteTx('series2');api.deleteSeries('all');const next=dataset();next.id='other';next.transactions=series();saveBase(next);acceptReceiptConfirmation();assert.equal(api.getDataset().transactions.length,4);
});
test('adiantar N parcelas move datas, conserva valor total e não cria lançamentos',()=>{
 const ds=dataset();ds.transactions=series();saveBase(ds);api.openAdvance('series2');get('#advance-date').value='2026-09-20';get('#advance-count').value='2';api.saveAdvance();
 const saved=api.getDataset().transactions;assert.equal(saved.length,4);assert.equal(saved.reduce((n,t)=>n+t.amount,0),40);assert.equal(saved[0].date,'2026-08-15');assert.equal(saved[1].date,'2026-09-15');assert.equal(saved[2].date,'2026-09-20');assert.equal(saved[3].date,'2026-09-20');assert.equal(saved[3].advance.scheduledDate,'2026-11-15');
 api.refreshFromStore();assert.equal(api.getDataset().transactions[3].advance.scheduledDate,'2026-11-15');api.setFilters({mode:'all'});api.renderTable();assert.match(get('#tx-tbody').innerHTML,/Adiantada/);
});
test('adiantar todas não reaplica adiantadas e valor inválido não grava',()=>{
 const ds=dataset();ds.transactions=series();saveBase(ds);api.openAdvance('series1');get('#advance-date').value='2026-08-20';get('#advance-count').value='99';api.saveAdvance();assert(!ds.transactions.some(t=>t.advance));get('#advance-all').checked=true;api.saveAdvance();assert.equal(api.getDataset().transactions.filter(t=>t.advance).length,3);api.openAdvance('series1');api.saveAdvance();assert.equal(api.getDataset().transactions.length,4);
});
test('cashback informativo sobrevive à gravação sem virar outra receita',()=>{
 saveBase(dataset());assert.equal(api.appendImported([tx('cash',{cashback:{amount:0.65,currency:'USD'}})]),1);api.refreshFromStore();const saved=api.getDataset().transactions;assert.equal(saved.length,1);assert.equal(saved[0].type,'despesa');assert.equal(saved[0].cashback.amount,0.65);assert.match(get('#tx-tbody').innerHTML,/Cashback:.*informativo/);
});

test('conta comum permanece no mês de vencimento, entra no relatório ao pagar e na lista pela data da baixa',()=>{
  const ds=dataset(), today=vm.runInContext('todayISO()',ctx);
  ds.transactions=[tx('oldpaid1',{date:today,amount:2}), tx('billopen',{date:'2020-02-03',amount:5,currency:'USD',billPinned:true,paymentStatus:'pending'})];
  ds.limits=[{name:'Alimentação',amount:50,currency:'BRL',categories:['Mercado']}];
  saveBase(ds);api.setFilters({month:today.slice(0,7)});api.renderAll();
  assert.equal(api.limitStats()[0].spent,2);assert.equal(api.currencyBreakdown().length,1);
  const panel=id=>get(id).innerHTML;
  assert.doesNotMatch(panel('#dash-bills'),/billopen/);assert(!panel('#tx-tbody').includes('billopen'));
  api.changeBill('billopen','pay');api.changeBill('billopen','pay');
  let saved=api.getDataset().transactions;assert.equal(saved.length,2);assert.equal(saved[1].paidOn,today);
  assert.equal(saved[1].date,'2020-02-03');assert.equal(api.limitStats()[0].spent,2);
  assert(!api.currencyBreakdown().some(g=>g.currency==='USD'));
  assert.doesNotMatch(panel('#dash-bills'),/billopen/);assert.match(panel('#tx-tbody'),/data-bill-action="reopen"/);
  api.setFilters({month:'2020-02'});api.renderAll();assert.equal(api.limitStats()[0].spent,25);assert.equal(api.tableTxs().length,0);
  assert.equal(api.currencyBreakdown().find(g=>g.currency==='USD').expense,5);
  assert.match(panel('#dash-bills'),/datetime="2020-02-03" title="Vencimento em 03\/02\/2020"/);
  assert.match(panel('#dash-bills'),new RegExp('Mercado · Pago em '+today.split('-').reverse().join('/')));
  assert.match(panel('#dash-bills'),/Contas pagas \(1\)/);
  api.changeBill('billopen','reopen');api.changeBill('billopen','reopen');
  assert.equal(api.tableTxs().length,1);assert.equal(api.limitStats()[0].spent,0);assert.match(panel('#dash-bills'),/1 conta em aberto/);
  api.setFilters({month:today.slice(0,7)});assert.equal(api.limitStats()[0].spent,2);
  api.changeBill('oldpaid1','track');assert.equal(api.limitStats()[0].spent,2);
  api.openTxModal('oldpaid1');get('#tx-payable').checked=true;
  assert.equal(api.limitStats()[0].spent,2);api.saveTxModal();assert.equal(api.limitStats()[0].spent,0);
  saved=JSON.parse(storage.get('fyg:ds:audit001')).transactions;
  assert.equal(saved[0].paymentStatus,'pending');assert.equal(saved[1].paidOn,undefined);assert.equal(saved.length,2);
});

test('Personal de novembro paga em dezembro conta uma vez na competência e sai do caixa no dia da baixa',()=>{
  const originalToday=ctx.todayISO;
  try {
    ctx.todayISO=()=> '2026-12-10';
    const ds=dataset();
    ds.transactions=[
      tx('personal01',{date:'2026-12-13',desc:'Personal - Telefonia',paymentStatus:'pending',currency:'PYG',amount:150000}),
      tx('recebido01',{date:'2026-11-18',type:'receita',amount:200}),
      tx('debito0001',{date:'2026-12-02',desc:'Recarga avulsa',amount:10}),
    ];
    ds.limits=[{name:'Mensal',amount:300,currency:'BRL',categories:['Mercado']}];
    saveBase(ds);
    const month=ym=>{api.setFilters({month:ym});api.renderAll();};
    const brl=selector=>Number(get(selector).textContent.replace(/[^\d,-]/g,'').replace(',','.'));
    month('2026-11');
    assert.equal(brl('#hero-desp'),0);assert.equal(brl('#hero-acc'),200);
    assert.equal(api.limitStats()[0].spent,0);assert(!api.tableTxs().some(t=>t.id==='personal01'));
    month('2026-12');
    assert.equal(brl('#hero-desp'),10);assert.match(get('#dash-bills').innerHTML,/13\/12\/2026/);
    api.changeBill('personal01','pay');api.changeBill('personal01','pay');
    assert.equal(api.getDataset().transactions.length,3);
    assert.equal(brl('#hero-desp'),10);assert.equal(brl('#txs-saldo'),-160);assert.equal(brl('#hero-acc'),40);
    assert.match(get('#tx-tbody').innerHTML,/10\/12\/2026/);
    assert.match(get('#dash-bills').innerHTML,/Vencimento em 13\/12\/2026/);
    assert.match(get('#dash-bills').innerHTML,/Pago em 10\/12\/2026/);
    assert(!api.currencyBreakdown().some(g=>g.currency==='PYG'));
    month('2026-11');
    assert.equal(brl('#hero-desp'),150);assert.equal(brl('#hero-saldo'),50);assert.equal(brl('#hero-acc'),200);
    assert.equal(brl('#txs-saldo'),200);assert.equal(api.limitStats()[0].spent,150);
    assert.equal(api.currencyBreakdown().find(g=>g.currency==='PYG').expense,150000);
    assert(!api.tableTxs().some(t=>t.id==='personal01'));
    api.setFilters({mode:'range',from:'2026-11-01',to:'2026-12-31'});api.renderAll();
    assert.equal(brl('#hero-desp'),160);assert.equal(brl('#txs-saldo'),40);
    api.setFilters({mode:'range',from:'2026-12-01',to:'2026-12-09'});api.renderAll();
    assert.equal(brl('#hero-acc'),190);assert(!api.tableTxs().some(t=>t.id==='personal01'));
    api.changeBill('personal01','reopen');api.changeBill('personal01','reopen');
    month('2026-11');assert.equal(brl('#hero-desp'),0);
    month('2026-12');assert.equal(brl('#hero-acc'),190);assert.equal(api.getDataset().transactions.length,3);
  } finally {ctx.todayISO=originalToday;}
});

test('conta sem período informado usa o mês do vencimento mesmo com pagamento adiantado e débito normal mantém a data',()=>{
  const ds=dataset();
  ds.transactions=[
    tx('servico01',{date:'2027-02-03',paidOn:'2027-01-28',paymentStatus:'paid',desc:'Licença anual',amount:70}),
    tx('debtjan1',{date:'2027-01-28',desc:'Personal - Telefonia',amount:10}),
    tx('servjan1',{date:'2027-01-12',paidOn:'2027-01-15',paymentStatus:'paid',desc:'Aula',amount:20}),
  ];
  saveBase(ds);
  api.setFilters({month:'2027-01'});api.renderAll();
  assert.equal(api.currencyBreakdown()[0].expense,30);
  assert.deepEqual(Array.from(api.tableTxs(),t=>t.id).sort(),['debtjan1','servico01','servjan1']);
  api.setFilters({month:'2027-02'});api.renderAll();
  assert.equal(api.currencyBreakdown()[0].expense,70);assert.equal(api.tableTxs().length,0);
  assert.match(get('#dash-bills').innerHTML,/Vencimento em 03\/02\/2027/);
  assert.match(get('#dash-bills').innerHTML,/Pago em 28\/01\/2027/);
  api.setFilters({mode:'all'});api.renderAll();
  assert.equal(api.currencyBreakdown()[0].expense,100);assert.equal(api.tableTxs().length,3);
});

test('gráficos e seleção de meses distinguem referência de dezembro, vencimento em janeiro e pagamento em fevereiro',()=>{
  const ds=dataset();
  ds.transactions=[tx('personal02',{date:'2027-01-13',paidOn:'2027-02-01',paymentStatus:'paid',desc:'Pos:personal pago de factura - personal',amount:80})];
  saveBase(ds);
  const captured=new Map(), originalChart=ctx.Chart;
  ctx.Chart=class {
    static defaults={font:{},plugins:{legend:{labels:{}},tooltip:{}},elements:{line:{},point:{}}};
    constructor(canvas,config){captured.set(canvas,config.data);}
    destroy(){}
  };
  try {
    api.setFilters({month:'2026-12'});api.renderCharts();
    const months=Array.from(api.allMonths());
    for(const m of ['2026-12','2027-01','2027-02']) assert(months.includes(m),'Mês navegável '+m);
    const series=id=>captured.get(get('#'+id));
    function point(id,month,index){
      const chart=series(id),position=Array.from(chart.labels,s=>s.toLowerCase()).indexOf(month);
      return position<0 ? 0 : chart.datasets[index].data[position];
    }
    assert.deepEqual(Array.from(series('chart-cat').datasets[0].data),[80]);
    assert.deepEqual(Array.from(series('chart-conta').datasets[0].data),[80]);
    assert.equal(point('chart-evo','dez/2026',1),80);
    assert.equal(point('chart-evo','fev/2027',1),0);
    assert.equal(point('chart-saldo','dez/2026',0),0);
    assert.equal(point('chart-saldo','fev/2027',0),-80);
    api.setFilters({month:'2027-01'});api.renderAll();
    assert.equal(api.tableTxs().length,0);assert.equal(api.currencyBreakdown().length,0);
    assert.match(get('#dash-bills').innerHTML,/Pago em 01\/02\/2027/);
    api.setFilters({month:'2027-02'});api.renderAll();
    assert.equal(api.tableTxs()[0].id,'personal02');assert.equal(api.currencyBreakdown().length,0);
  } finally {if(originalChart)ctx.Chart=originalChart;else delete ctx.Chart;}
});

test('competência escrita acompanha cada vencimento da série até o 13º mês sem depender de escolha manual',()=>{
  const originalToday=ctx.todayISO;
  try {
    ctx.todayISO=()=> '2026-12-01';
    saveBase(dataset());api.openTxModal(null,{pending:true});
    get('#tx-date').value='2026-12-13';get('#tx-desc').value='Mensalidade, competência novembro de 2026';
    get('#tx-amount').value='25';get('#tx-cat').value='Mercado';get('#tx-fixa').checked=true;get('#tx-renew').checked=true;
    api.saveTxModal();
    const references=()=>api.getDataset().transactions.map(t=>ctx.billReferenceMonth(t));
    assert.equal(references().length,12);assert.equal(references()[0],'2026-11');assert.equal(references()[1],'2026-12');
    assert.equal(references()[11],'2027-10');
    ctx.todayISO=()=> '2027-12-01';api.renderAll();api.renderAll();
    assert.equal(references().length,13);assert.equal(references()[12],'2027-11');
    assert.equal(api.getDataset().transactions[12].paymentStatus,'pending');
  } finally {ctx.todayISO=originalToday;}
});

test('referência corrigida e depois devolvida ao automático a partir da 13ª ocorrência segue em novas renovações',()=>{
  const originalToday=ctx.todayISO;
  try {
    ctx.todayISO=()=> '2026-12-10';
    saveBase(dataset());api.openTxModal(null,{pending:true});
    get('#tx-date').value='2026-12-13';get('#tx-desc').value='Personal - Telefonia';get('#tx-amount').value='50';
    get('#tx-cat').value='Mercado';get('#tx-fixa').checked=true;get('#tx-renew').checked=true;api.saveTxModal();
    const rows=()=>api.getDataset().transactions;
    const ref=i=>ctx.billReferenceMonth(rows()[i]);
    ctx.todayISO=()=> '2027-12-02';api.renderAll();
    assert.equal(rows().length,13);assert.equal(ref(12),'2027-11');
    api.openTxModal(rows()[12].id);get('#tx-reference-month').value='2027-10';get('#tx-reference-repeat').checked=true;api.saveTxModal();
    ctx.todayISO=()=> '2028-01-02';api.renderAll();
    assert.equal(rows().length,14);assert.equal(ref(12),'2027-10');assert.equal(ref(13),'2027-11');
    api.openTxModal(rows()[13].id);get('#tx-reference-auto').listeners.get('click')();get('#tx-reference-repeat').checked=true;api.saveTxModal();
    ctx.todayISO=()=> '2028-02-02';api.renderAll();api.renderAll();
    assert.equal(rows().length,15);assert.equal(ref(12),'2027-10');assert.equal(ref(13),'2027-12');assert.equal(ref(14),'2028-01');
  } finally {ctx.todayISO=originalToday;}
});

test('agenda exibe os vencimentos do mês e mostra a próxima recorrência quando o mês vira com o painel aberto',()=>{
  const originalToday=ctx.todayISO, originalTimeout=ctx.setTimeout;
  const ds=dataset(), board=()=>get('#dash-bills').innerHTML;
  let midnight;
  try {
    ctx.todayISO=()=> '2026-11-16';
    ctx.setTimeout=(callback,delay)=>{if(delay>1600) midnight=callback;return 0;};
    ds.transactions=[tx('future01',{date:'2026-11-20',paymentStatus:'pending'}),tx('paid0001',{date:'2026-11-07',paymentStatus:'paid'}),
      tx('debit001'),tx('late0001',{date:'2026-11-07',paymentStatus:'pending',desc:'Claro',fixed:true}),tx('today001',{date:'2026-11-16',paymentStatus:'pending'}),
      tx('dec00001',{date:'2026-12-07',paymentStatus:'pending',desc:'Claro',fixed:true}),
      tx('jan00001',{date:'2027-01-07',paymentStatus:'pending',desc:'Claro',fixed:true})];
    saveBase(ds);api.setFilters({month:'2026-11'});api.renderAll();
    const sections=[...board().matchAll(/<section class="bill-group" data-due="([^"]+)">([\s\S]*?)<\/section>/g)];
    assert.deepEqual(sections.map(m=>m[1]),['late','today','upcoming']);
    for(const [i,id] of ['late0001','today001','future01'].entries())assert(sections[i][2].includes(id));
    assert.doesNotMatch(board(),/debit001|dec00001|jan00001|<details[^>]*\bopen\b/);
    assert.match(board(),/Contas pagas \(1\)/);assert.match(board(),/3 contas em aberto/);
    ctx.todayISO=()=> '2026-12-01';midnight();
    assert.match(board(),/Dezembro de 2026 · 1 conta em aberto/);assert.match(board(),/dec00001/);
    assert.doesNotMatch(board(),/late0001|paid0001|jan00001/);
    api.setFilters({month:'2026-11'});api.renderAll();
    ctx.todayISO=()=> '2027-01-01';midnight();
    assert.match(board(),/Novembro de 2026/);assert.doesNotMatch(board(),/jan00001/);
    api.setFilters({mode:'all',month:null});api.renderAll();assert.match(board(),/Janeiro de 2027 · 1 conta em aberto/);
  } finally {ctx.todayISO=originalToday;ctx.setTimeout=originalTimeout;}
});

test('fatura C6 acompanha o ciclo, confirma pelo card e reabre apenas o saldo de novas compras',()=>{
  const originalToday=ctx.todayISO;
  const board=get('#dash-bills');
  const month='2026-11';
  const ds=dataset();
  ds.displayCurrency='USD';
  const cycle={account:'C6',date:'2026-11-03',billClosingDate:'2026-11-29',billDueDate:'2026-12-05',billDateObserved:true};
  ds.transactions=[
    tx('buy00001',{...cycle,amount:100}),tx('buy00002',{...cycle,amount:50}),
    tx('refund01',{...cycle,type:'receita',desc:'Estorno da compra',creditKind:'refund',amount:20}),
    tx('prevpaid',{...cycle,type:'receita',desc:'Inclusão de pagamento',creditKind:'card_payment',amount:200}),
    tx('other001',{date:'2026-11-03',account:'Itaú',amount:90}),
    tx('old00001',{...cycle,date:'2026-10-03',billClosingDate:'2026-10-29',billDueDate:'2026-11-05'}),
    tx('future01',{...cycle,date:'2027-02-01',billClosingDate:'2027-02-26',billDueDate:'2027-03-05',billDateObserved:false}),
  ];
  const row=()=>{
    const match=board.innerHTML.match(/data-invoice-month="2026-11" data-invoice-version="([^"]+)" data-folder="([^"]+)"/);
    assert(match,'Fatura de novembro visível');
    return {dataset:{invoiceMonth:month,invoiceVersion:match[1],folder:match[2]}};
  };
  function mark(action,shown=row()){
    const button={dataset:{billAction:action},closest:()=>shown};
    board.listeners.get('click')({target:{closest:()=>button}});
  }
  const timers=[], originalTimeout=ctx.setTimeout;
  try {
    ctx.todayISO=()=> '2026-11-07';
    ctx.setTimeout=(fn,delay)=>{ if(delay===1600) timers.push(fn); return 0; };
    saveBase(ds);api.setFilters({month});api.renderAll();
    assert.equal((board.innerHTML.match(/data-invoice-month=/g)||[]).length,1);
    assert.match(board.innerHTML,/Novembro de 2026 · Aberta · Vencimento 05\/12\/2026/);
    assert.match(board.innerHTML,/R\$\s*130,00/);assert.match(board.innerHTML,/1 conta em aberto/);
    assert.match(get('#tx-tbody').innerHTML,/buy00001/);
    ctx.todayISO=()=> '2026-12-06';api.renderAll();
    const expenses=get('#hero-desp').textContent;
    assert.match(board.innerHTML,/data-due="late"/);assert.match(board.innerHTML,/Novembro de 2026 · Fechada/);
    const firstRow=row();
    board.listeners.get('dblclick')({target:{closest:selector=>selector==='.bill-row.bill-open'?firstRow:null}});
    assert.match(board.innerHTML,/bill-settled/);assert.match(board.innerHTML,/aria-disabled="true"/);
    assert.equal(api.getDataset().c6InvoicePayments[month].totals.BRL,130);
    assert.equal(api.getDataset().c6InvoicePayments[month].paidOn,'2026-12-06');
    assert.equal(get('#hero-desp').textContent,expenses);
    const saved=JSON.parse(storage.get('fyg:ds:'+ds.id));
    assert.equal(saved.transactions.length,7);assert(saved.transactions.every(t=>!t.paymentStatus&&!t.paidOn));
    timers.splice(0).forEach(callback=>callback());api.refreshFromStore({force:true});
    assert.match(board.innerHTML,/Contas pagas \(1\)/);
    assert.match(board.innerHTML,/datetime="2026-12-05" title="Vencimento em 05\/12\/2026"/);
    assert.match(board.innerHTML,/Vencimento 05\/12\/2026 · Pago em 06\/12\/2026/);
    assert.match(board.innerHTML,/data-bill-action="reopen"/);

    saved.transactions.push(tx('latechg1',{...cycle,amount:12.35}));
    storage.set('fyg:ds:'+ds.id,JSON.stringify(saved));api.refreshFromStore({force:true});
    assert.match(board.innerHTML,/Saldo a pagar/);assert.match(board.innerHTML,/R\$\s*12,35/);
    const stale=row();
    saved.transactions.at(-1).amount=14;
    storage.set('fyg:ds:'+ds.id,JSON.stringify(saved));
    mark('pay',stale);
    assert.equal(api.getDataset().c6InvoicePayments[month].totals.BRL,130);
    assert.match(board.innerHTML,/R\$\s*14,00/);
    mark('pay');mark('pay');
    assert.equal(api.getDataset().c6InvoicePayments[month].totals.BRL,144);
    timers.splice(0).forEach(callback=>callback());
    mark('reopen');assert.match(board.innerHTML,/R\$\s*144,00/);
    assert.equal(api.getDataset().c6InvoicePayments?.[month],undefined);
    assert.equal(api.getDataset().transactions.length,8);
  } finally { ctx.todayISO=originalToday;ctx.setTimeout=originalTimeout; }
});

test('na virada, a fatura fechada e a nova zerada coexistem e a primeira compra atualiza o mesmo card',()=>{
  const ds=dataset(), originalToday=ctx.todayISO, panel=get('#dash-bills');
  const row=month=>panel.innerHTML.split('<div class="bill-row ').slice(1).find(s=>s.includes('data-invoice-month="'+month+'"'));
  const cycle={account:'C6',date:'2026-11-03',billClosingDate:'2026-11-29',billDueDate:'2026-12-05',billDateObserved:true};
  try {
    ds.transactions=[tx('buy00001',{...cycle,amount:80})];ctx.todayISO=()=> '2026-11-29';
    saveBase(ds);api.setFilters({month:'2026-11'});api.renderAll();
    assert(row('2026-11'));assert.equal(row('2026-12'),undefined);
    ctx.todayISO=()=> '2026-11-30';api.renderAll();
    assert.match(row('2026-11'),/Fechada/);
    assert.match(row('2026-12'),/Aberta/);assert.match(row('2026-12'),/R\$\s*0,00/);
    assert.match(row('2026-12'),/Vencimento previsto/);assert.doesNotMatch(row('2026-12'),/data-bill-action="pay"/);
    assert.match(panel.innerHTML,/1 conta em aberto/);
    ds.transactions.push(tx('decbuy01',{account:'C6',desc:'Compra no cartão',date:'2026-11-30',amount:25}));
    api.renderAll();
    assert.equal((panel.innerHTML.match(/data-invoice-month="2026-12"/g)||[]).length,1);
    assert.match(row('2026-12'),/R\$\s*25,00/);assert.match(row('2026-12'),/data-bill-action="pay"/);
    assert.match(panel.innerHTML,/2 contas em aberto/);
  } finally {ctx.todayISO=originalToday;}
});

test('confirmações visuais simultâneas só movem os cards e nunca repetem a baixa',()=>{
  const ds=dataset();ds.transactions=[tx('firstpay',{paymentStatus:'pending'}),tx('nextpay1',{paymentStatus:'pending'})];saveBase(ds);
  const original=ctx.setTimeout, timers=[];
  ctx.setTimeout=(fn,ms)=>{if(ms===1600)timers.push(fn);return 0;};
  try {
    api.changeBill('firstpay','pay','agenda');api.changeBill('nextpay1','pay','agenda');api.changeBill('firstpay','pay','agenda');
    assert.equal(timers.length,2);assert.equal(api.undoStack.length,2);
    const stored=storage.get('fyg:ds:'+ds.id), txs=JSON.parse(stored).transactions;
    assert(txs.every(t=>t.paymentStatus==='paid'&&t.paidOn));assert.equal(txs.length,2);
    const board=()=>get('#dash-bills').innerHTML;
    api.renderAll();assert.equal((board().match(/aria-disabled="true"/g)||[]).length,2);
    timers[0]();assert.match(board(),/Contas pagas \(1\)/);assert.equal((board().match(/aria-disabled="true"/g)||[]).length,1);
    timers[1]();assert.match(board(),/Contas pagas \(2\)/);assert.doesNotMatch(board(),/aria-disabled="true"/);
    assert.equal(storage.get('fyg:ds:'+ds.id),stored);assert.equal(api.undoStack.length,2);
    api.changeBill('firstpay','reopen','agenda');assert.match(board(),/1 conta em aberto/);
  } finally {ctx.setTimeout=original;}
});

test('compra C6 de novembro segue para a fatura e a conta de débito permite acompanhamento individual',()=>{
  saveBase(dataset());
  function create(account) {
    api.openTxModal(null,{pending:true});
    get('#tx-date').value='2026-11-12';get('#tx-desc').value='Papelaria';
    get('#tx-amount').value='25,00';get('#tx-currency').value='BRL';get('#tx-cat').value='Mercado';
    const sel=get('#tx-account-sel');sel.value=account;sel.listeners.get('change')({target:sel});
    const hidden=get('#tx-bill-options').classList.contains('hidden');
    api.saveTxModal();
    return hidden;
  }
  assert.equal(create('C6'),true);
  assert.equal(create('C6 · Conta/débito'),false);
  const [card,debit]=api.getDataset().transactions;
  assert.equal(card.c6Section,'card');assert.equal(card.paymentStatus,undefined);
  assert.equal(debit.paymentStatus,'pending');assert.equal(debit.account,'C6');assert.equal(debit.c6Section,'transfer');
  api.openTxModal(debit.id);assert.equal(get('#tx-account-sel').value,'C6 · Conta/débito');
});
test('nova conta em aberto e suas repetições sobrevivem à sincronização e ao backup',()=>{
  saveBase(dataset());api.openTxModal(null,{pending:true});assert.equal(get('#tx-paid').checked,false);
  get('#tx-amount').value='25,00';get('#tx-date').value='2026-01-31';get('#tx-desc').value='Internet';
  get('#tx-currency').value='BRL';get('#tx-cat').value='Mercado';assert(get('#tx-payable').checked);get('#tx-fixa').checked=true;
  api.saveTxModal();const bills=api.getDataset().transactions;assert.equal(bills.length,12);
  assert(bills.every(t=>t.paymentStatus==='pending'&&!t.billPinned));assert.equal(bills[1].date,'2026-02-28');
  api.changeBill(bills[0].id,'pay');api.refreshFromStore();
  for(const preserveIds of [true,false]){
    ctx.billSource=api.getDataset();
    const clean=vm.runInContext('sanitizeDataset(billSource,{preserveContent:true,preserveIds:'+preserveIds+'})',ctx);
    assert.equal(clean.transactions.filter(t=>t.paymentStatus==='paid'&&t.paidOn).length,1);
    assert.equal(clean.transactions.filter(t=>t.paymentStatus==='pending').length,11);
  }
});

test('editar valor não desfaz um pagamento recebido após a abertura do formulário',()=>{
  const ds=dataset();ds.transactions=[tx('existing',{paymentStatus:'pending'})];saveBase(ds);
  api.openTxModal('existing');const newer=JSON.parse(storage.get('fyg:ds:audit001'));
  Object.assign(newer.transactions[0],{paymentStatus:'paid',paidOn:'2026-11-01',billPinned:true});
  storage.set('fyg:ds:audit001',JSON.stringify(newer));get('#tx-amount').value='16,00';api.saveTxModal();
  const t=api.getDataset().transactions[0];assert.equal(t.amount,16);assert.equal(t.paymentStatus,'paid');
  assert.equal(t.paidOn,'2026-11-01');assert.equal(t.billPinned,undefined);
});

test('ativar conta a pagar numa série existente acompanha as próximas ocorrências sem repetir a baixa',()=>{
  const originalToday=ctx.todayISO;ctx.todayISO=()=>'2026-11-16';
  try {
    const ds=dataset();
    const line=(id,date,overrides={})=>tx(id,{date,groupId:'seriepersonal',fixed:true,...overrides});
    ds.transactions=[line('passada','2026-10-07'),line('novembro','2026-11-07'),line('dezembro','2026-12-03'),
      line('pagoadiantado','2027-01-07',{paymentStatus:'paid',paidOn:'2026-11-10'}),
      line('desacompanhada','2027-02-07',{paidOn:'2026-11-11'}),line('outraconta','2026-12-07',{groupId:'outraserie'})];
    saveBase(ds);api.openTxModal('novembro');get('#tx-payable').checked=true;get('#tx-paid').checked=true;
    get('#tx-payable').listeners.get('change')();assert.match(get('#tx-bill-hint').textContent,/próximos vencimentos/);
    api.saveTxModal();
    const [past,nov,dec,jan,feb,other]=api.getDataset().transactions;
    assert.equal(nov.date,'2026-11-07');assert.equal(nov.paymentStatus,'paid');assert.equal(nov.paidOn,'2026-11-16');
    assert.equal(dec.date,'2026-12-03');assert.equal(dec.paymentStatus,'pending');assert.equal(dec.paidOn,undefined);
    assert.equal(jan.paymentStatus,'paid');assert.equal(jan.paidOn,'2026-11-10');
    assert.equal(feb.paymentStatus,undefined);assert.equal(feb.paidOn,'2026-11-11');
    assert.equal(past.paymentStatus,undefined);assert.equal(other.paymentStatus,undefined);
    api.openTxModal('novembro');get('#tx-date').value='2026-11-13';api.saveTxModal();
    assert.equal(api.getDataset().transactions[2].date,'2026-12-03');
  } finally {ctx.todayISO=originalToday;}
});

test('uma edição de conta antiga já paga sem data de baixa conserva o histórico disponível',()=>{
  const ds=dataset();ds.transactions=[tx('historica',{paymentStatus:'paid'})];saveBase(ds);
  api.openTxModal('historica');get('#tx-desc').value='Conta antiga';api.saveTxModal();
  assert.equal(api.getDataset().transactions[0].paymentStatus,'paid');assert.equal(api.getDataset().transactions[0].paidOn,undefined);
});

test('transações mostram, ordenam e contabilizam a conta paga pela data da baixa',()=>{
  const ds=dataset();
  ds.transactions=[tx('personal',{date:'2026-09-28',paidOn:'2026-10-12',paymentStatus:'paid'}),
    tx('parcela',{date:'2026-09-29',paidOn:'2026-10-03',paymentStatus:'paid',installment:'2/3',purchaseDate:'2026-08-07',
      advance:{scheduledDate:'2026-11-07',paidDate:'2026-09-29'}}),
    tx('debito',{date:'2026-10-05'})];
  saveBase(ds);api.setFilters({month:'2026-10'});api.setSort({key:'date',dir:1});api.renderTable();
  const table=get('#tx-tbody').innerHTML;
  const row=id=>table.match(new RegExp('<tr data-id="'+id+'"[\\s\\S]*?</tr>'))[0];
  assert.match(row('personal'),/<td style="white-space:nowrap">12\/10\/2026<\/td>/);
  assert.equal(row('personal').match(/12\/10\/2026/g).length,1);
  assert.match(row('parcela'),/03\/10\/2026<br><span title="Data da compra">Cpr\. 07\/08\/2026/);
  assert.doesNotMatch(table,/Pago em|28\/09\/2026|07\/11\/2026/);
  assert.deepEqual(Array.from(api.sortTxs(api.tableTxs()),t=>t.id),['parcela','debito','personal']);
  api.setFilters({month:'2026-09'});assert.equal(api.tableTxs().length,0);
});

test('fixações antigas preservam o valor contabilizado e receitas não entram em contas a pagar',()=>{
  const ds=dataset();ds.transactions=[tx('wasfixed',{billPinned:true}),tx('income000',{type:'receita',billPinned:true}),tx('plain000')];saveBase(ds);
  const restored=vm.runInContext('Store.loadDataset("audit001")',ctx);api.setDataset(restored);api.renderAll();
  assert.equal(restored.transactions[0].paymentStatus,'paid');assert(!restored.transactions.some(t=>t.billPinned));
  assert.match(get('#dash-bills').innerHTML,/Contas pagas \(1\)/);assert.doesNotMatch(get('#dash-bills').innerHTML,/income000|plain000/);
  assert.doesNotMatch(get('#tx-tbody').innerHTML,/data-bill-action="track"/);
  api.changeBill('income000','track');api.changeBill('wasfixed','track');
  assert.equal(api.getDataset().transactions[1].paymentStatus,undefined);assert.equal(api.getDataset().transactions[0].paymentStatus,'paid');
});

test('formulário mostra competência automática, permite ajustar e restaura o automático sem afetar débito ou C6',()=>{
  const ds=dataset(), reference=get('#tx-reference-month'), details=get('#tx-bill-reference');
  ds.transactions=[tx('tel10001',{desc:'Personal - Telefonia',date:'2027-01-13',paymentStatus:'pending'}),
    tx('debit001',{desc:'Padaria'}),tx('credit01',{account:'C6',c6Section:'card',date:'2026-12-09'})];
  saveBase(ds);api.openTxModal('tel10001');
  assert.equal(details.open,false);assert(!details.classList.contains('hidden'));
  assert.match(get('#tx-reference-label').textContent,/Dezembro de 2026/);assert.equal(reference.value,'');
  reference.value='2027-01';reference.listeners.get('input')();assert.match(get('#tx-reference-label').textContent,/Janeiro de 2027/);
  api.saveTxModal();api.setFilters({month:'2027-01'});api.renderAll();
  assert.match(get('#dash-bills').innerHTML,/Ref\. jan\/2027/);
  api.openTxModal('tel10001');assert.equal(reference.value,'2027-01');get('#tx-reference-auto').listeners.get('click')();
  api.saveTxModal();assert.equal(api.getDataset().transactions[0].billReferenceMonth,undefined);
  assert.match(get('#dash-bills').innerHTML,/Ref\. dez\/2026/);
  api.openTxModal('tel10001');
  const fresh=JSON.parse(storage.get('fyg:ds:'+ds.id));fresh.transactions[0].billReferenceMonth='2026-10';
  storage.set('fyg:ds:'+ds.id,JSON.stringify(fresh));get('#tx-desc').value='Personal - Telefonia alterada';api.saveTxModal();
  assert.equal(api.getDataset().transactions[0].billReferenceMonth,'2026-10');
  for(const id of ['debit001','credit01']){api.openTxModal(id);assert(details.classList.contains('hidden'));}
  api.openTxModal(null,{pending:true});api.fillTxFromReceipt(receipt({data:'2027-01-13',descricao:'Internet',instituicao:'Itaú',sourceEvidence:'Competência novembro de 2026'}));
  assert.match(get('#tx-reference-label').textContent,/Novembro de 2026/);
});

test('correção opcional de uma série protege competências pagas, projeta o ajuste e mantém exceção isolada na âncora',()=>{
  const today=ctx.todayISO;
  try {
    ctx.todayISO=()=> '2026-01-13';const ds=dataset();saveBase(ds);api.openTxModal(null,{pending:true});
    get('#tx-amount').value='80';get('#tx-date').value='2026-01-13';get('#tx-desc').value='Serviço ref. dezembro de 2025';
    get('#tx-cat').value='Mercado';get('#tx-fixa').checked=true;get('#tx-renew').checked=true;api.saveTxModal();
    const rows=()=>api.getDataset().transactions;
    assert.equal(rows()[1].billReferenceMonth,'2026-01');assert.equal(rows()[11].billReferenceMonth,'2026-11');
    api.changeBill(rows()[2].id,'pay');
    api.openTxModal(rows()[1].id);get('#tx-reference-month').value='2026-02';get('#tx-reference-repeat').checked=true;api.saveTxModal();
    assert.equal(rows()[1].billReferenceMonth,'2026-02');assert.equal(rows()[2].billReferenceMonth,'2026-02');
    assert.equal(rows()[3].billReferenceMonth,'2026-04');assert.equal(rows()[11].repeatBillReferenceMonth,'2026-12');
    api.openTxModal(rows()[11].id);get('#tx-reference-month').value='2026-10';api.saveTxModal();
    assert.equal(rows()[11].billReferenceMonth,'2026-10');
    ctx.todayISO=()=> '2027-01-13';api.renderAll();api.renderAll();
    assert.equal(rows().length,13);assert.equal(rows()[12].billReferenceMonth,'2027-01');assert.equal(rows()[12].paymentStatus,'pending');
  } finally {ctx.todayISO=today;}
});

test('sair do acompanhamento de uma conta paga conserva o mês original do pagamento',()=>{
  const ds=dataset();ds.transactions=[tx('bill0001',{date:'2026-09-27',paymentStatus:'paid',paidOn:'2026-10-02'})];saveBase(ds);
  api.openTxModal('bill0001');assert(get('#tx-payable').checked);assert(get('#tx-paid').checked);
  get('#tx-payable').checked=false;api.saveTxModal();
  const t=api.getDataset().transactions[0];assert.equal(t.paymentStatus,undefined);assert.equal(t.paidOn,'2026-10-02');
  assert.equal(api.tableTxs().length,1);assert.doesNotMatch(get('#dash-bills').innerHTML,/bill0001/);
  api.setFilters({month:'2026-09'});assert.equal(api.tableTxs().length,0);
});

test('parcelas do C6 entram uma por mês e mostram a data original da compra',()=>{
  const ds=dataset(); ds.transactions=[tx('c6001',{date:'2026-08-11',purchaseDate:'2026-08-11',installment:'1/5'}),tx('c6002',{date:'2026-09-11',purchaseDate:'2026-08-11',installment:'2/5'})];
  saveBase(ds); api.setFilters({month:'2026-08'});
  assert.deepEqual(Array.from(api.tableTxs(),t=>t.id),['c6001']); api.renderSummary(); const august=get('#hero-acc').textContent;
  api.setFilters({month:'2026-09'});
  assert.deepEqual(Array.from(api.tableTxs(),t=>t.id),['c6002']); api.renderAll();
  assert.match(get('#tx-tbody').innerHTML,/Cpr\. 11\/08\/2026/);assert.notEqual(get('#hero-acc').textContent,august);
});
test('fatura C6 fecha em outubro: soma linhas impressas pelo fechamento e mantém origem e projeções',async()=>{
  const ds=dataset();
  const cycle={account:'C6',billClosingDate:'2026-10-29',billDueDate:'2026-11-05',billDateObserved:true};
  ds.transactions=[
    tx('last-five',{...cycle,date:'2026-09-30',purchaseDate:'2026-05-30',installment:'5/5',amount:340}),
    tx('last-six',{...cycle,date:'2026-09-24',purchaseDate:'2026-05-24',installment:'6/6',amount:33.30}),
    tx('september-pos',{...cycle,date:'2026-09-30',desc:'Compra de setembro',amount:50}),
    tx('payment',{...cycle,creditKind:'card_payment',type:'receita',date:'2026-10-05',amount:6145.28}),
    tx('projection',{...cycle,billClosingDate:'2026-11-29',billDueDate:'2026-12-05',billDateObserved:false,date:'2026-10-21',purchaseDate:'2026-08-21',installment:'3/4',amount:30}),
    tx('other',{date:'2026-09-30',amount:100}),
  ];
  saveBase(ds);api.setFilters({month:'2026-10'});api.renderAll();
  assert.deepEqual(Array.from(api.tableTxs(),t=>t.id),['last-five','last-six','september-pos','payment']);
  assert.match(get('#hero-desp').textContent,/423,30/);
  assert.match(get('#hero-rec').textContent,/6\.145,28/);
  assert.match(get('#tx-tbody').innerHTML,/30\/10\/2026<br><span title="Data da compra">Cpr\. 30\/05\/2026<\/span>/);
  assert.match(get('#tx-tbody').innerHTML,/>Pg recebido</);
  assert.match(get('#tx-tbody').innerHTML.match(/<tr data-id="september-pos"[\s\S]*?<\/tr>/)[0], /<td style="white-space:nowrap">30\/10\/2026<\/td>/);
  assert.match(get('#tx-tbody').innerHTML.match(/<tr data-id="payment"[\s\S]*?<\/tr>/)[0], /<td style="white-space:nowrap">05\/10\/2026<\/td>/);
  assert.doesNotMatch(get('#tx-tbody').innerHTML.match(/<tr data-id="last-five"[\s\S]*?<\/tr>/)[0],/Vence em|Venc\. previsto|05\/11\/2026/);
  api.exportCSV();const csv=await csvBlob.text();
  assert.match(csv,/"2026-05-30";"2026-10"/);
  api.setFilters({month:'2026-11'});api.renderAll();
  assert.deepEqual(Array.from(api.tableTxs(),t=>t.id),['projection']);
  assert.doesNotMatch(get('#tx-tbody').innerHTML,/Venc\. previsto|05\/12\/2026/);
  api.setFilters({month:'2026-09'});assert.deepEqual(Array.from(api.tableTxs(),t=>t.id),['other']);
});
test('fatura vencida continua acessível no mês atual até ser paga, sem duplicar o débito',()=>{
  const today=ctx.todayISO, board=get('#dash-bills');
  try {
    ctx.todayISO=()=> '2027-01-08';
    const ds=dataset();
    ds.transactions=[tx('c6antiga1',{account:'C6',date:'2026-11-04',billClosingDate:'2026-11-29',billDueDate:'2026-12-05',billDateObserved:true,amount:100})];
    saveBase(ds);api.setFilters({month:'2027-01'});api.renderAll();
    assert.match(board.innerHTML,/class="bill-history bill-overdue"\s*>/);
    assert.match(board.innerHTML,/Faturas anteriores em atraso \(1\)/);
    const match=board.innerHTML.match(/data-invoice-month="2026-11" data-invoice-version="([^"]+)" data-folder="([^"]+)"/);
    assert(match);assert.equal(board.innerHTML.match(/data-invoice-month="2026-11"/g).length,1);
    const row={dataset:{invoiceMonth:'2026-11',invoiceVersion:match[1],folder:match[2]}};
    const button={dataset:{billAction:'pay'},closest:()=>row};
    board.listeners.get('click')({target:{closest:()=>button}});
    const result=api.getDataset();
    assert.equal(result.transactions.length,1);
    assert.equal(result.c6InvoicePayments['2026-11'].totals.BRL,100);
    assert.equal(result.c6InvoicePayments['2026-11'].paidOn,'2027-01-08');
    api.setFilters({month:'2026-12'});api.renderAll();
    assert.doesNotMatch(board.innerHTML,/Faturas anteriores em atraso/);
    assert.equal(board.innerHTML.match(/data-invoice-month="2026-11"/g).length,1);
  } finally {ctx.todayISO=today;}
});

test('limites mudam por competência, incluem mês vazio e preservam um estouro mensal mesmo com sobra em outro mês',()=>{
  const ds=dataset();
  ds.transactions=[tx('outubro01',{date:'2026-10-07',amount:80}),tx('novembro1',{date:'2026-11-07',amount:80})];
  ds.limits=[{id:'limit001',name:'Compras',categories:['Mercado'],amount:100,currency:'BRL',versions:[{from:'0000-00',amount:100,categories:['Mercado']}]}];
  saveBase(ds);api.setFilters({mode:'range',from:'2026-10-01',to:'2026-11-30'});
  let stats=api.limitStats()[0];assert.equal(stats.spent,160);assert.equal(stats.amount,200);assert.equal(stats.overMonths.length,0);
  ds.limits[0].versions.push({from:'2026-11',amount:60,categories:['Saúde']});
  ds.transactions.push(tx('novsaude1',{date:'2026-11-05',category:'Saúde',amount:65}));
  api.setFilters({mode:'range',from:'2026-10-04',to:'2026-12-26'});stats=api.limitStats()[0];
  assert.equal(stats.spent,145);assert.equal(stats.amount,220);assert.deepEqual(Array.from(stats.overMonths),['2026-11']);
  api.setFilters({mode:'range',from:'2026-10-04',to:'2026-12-26',cats:new Set(['mercado'])});
  stats=api.limitStats()[0];assert.equal(stats.spent,80);assert.equal(stats.amount,100);
});

test('recorrência contínua só por opção, gera mês 13 uma vez por aparelho e recorda encerramento',()=>{
  const today=ctx.todayISO;
  try {
    ctx.todayISO=()=> '2026-01-31'; const ds=dataset();saveBase(ds);
    api.openTxModal(null,{pending:true});
    get('#tx-amount').value='80';get('#tx-date').value='2026-01-31';get('#tx-desc').value='Internet';get('#tx-cat').value='Mercado';
    get('#tx-fixa').checked=true;get('#tx-renew').checked=true;api.saveTxModal();
    const initial=JSON.parse(JSON.stringify(api.getDataset()));
    assert.equal(initial.transactions.length,12);
    const anchor=initial.transactions.find(t=>t.repeatMonthlyDay);assert.equal(anchor.repeatThrough,'2026-12');assert.equal(anchor.repeatMonthlyDay,31);
    assert.equal(initial.transactions[1].date,'2026-02-28');
    ctx.todayISO=()=> '2027-02-01';api.renderAll();api.renderAll();
    const renewed=JSON.parse(JSON.stringify(api.getDataset()));
    const adds=renewed.transactions.slice(12);assert.equal(adds.length,2);
    assert.deepEqual(adds.map(t=>t.date),['2027-01-31','2027-02-28']);assert(adds.every(t=>t.paymentStatus==='pending' && !t.paidOn));
    saveBase(initial);api.renderAll();assert.deepEqual(Array.from(api.getDataset().transactions.slice(12),t=>t.id),adds.map(t=>t.id));
    // Backup real, IDs preservados, deve reconhecer que fevereiro já foi gerado.
    ctx.auditData=renewed;const restored=vm.runInContext('sanitizeDataset(auditData,{preserveIds:true,preserveContent:true,rejectInvalidTransactions:true})',ctx);
    saveBase(restored);api.renderAll();assert.equal(api.getDataset().transactions.length,14);
    const last=api.getDataset().transactions.at(-1);api.requestDeleteTx(last.id);api.deleteSeries('following');acceptReceiptConfirmation();
    ctx.todayISO=()=> '2027-04-01';api.renderAll();assert.equal(api.getDataset().transactions.length,13);
    assert(!api.getDataset().transactions.some(t=>t.repeatMonthlyDay || t.date>='2027-02-01'));
    const finite=dataset();finite.transactions=initial.transactions.map(({repeatMonthlyDay,repeatKey,repeatThrough,repeatMonth,...t})=>t);
    saveBase(finite);api.renderAll();assert.equal(api.getDataset().transactions.length,12);
  } finally {ctx.todayISO=today;}
});

test('Ver lançamentos reúne só os registros do documento e volta ao filtro mensal',()=>{
  const ds=dataset();
  ds.transactions=[tx('receipt_first_0',{date:'2026-05-03'}),tx('receipt_first_1'),tx('receipt_second_0')];
  saveBase(ds);api.setFilters({month:'2026-11',search:'busca antiga'});
  win.scrollTo=()=>{};
  const dashboard=vm.runInContext('Dashboard',ctx);
  assert.equal(dashboard.showReceiptTransactions('first',['receipt_missing_0']),false);
  assert.equal(dashboard.showReceiptTransactions('first',['receipt_first_0','receipt_first_1']),true);
  assert.deepEqual(Array.from(api.tableTxs(),t=>t.id),['receipt_first_0','receipt_first_1']);
  get('#btn-close-receipt-filter').listeners.get('click')();
  assert.equal(api.tableTxs().length,0);
});

test('conferência histórica reúne origens fortes de todos os meses, mantém compras independentes e não grava',()=>{
  const d=dataset(),photo={hash:'a'.repeat(64),row:'b'.repeat(32),occurrence:1};
  const bank=tx('b1',{account:'C6',referenceId:'Banco-326',date:'2025-01-20',installment:'2/5',photoSource:photo});
  const week={account:'Litoral',date:'2026-01-05',currency:'USD'};
  d.transactions=[
    bank,{...bank,id:'b2',account:'C6 Bank',desc:'Texto alterado'},
    {...bank,id:'parcela',installment:'3/5',photoSource:undefined,desc:'Parcela distinta'},
    {...bank,id:'ocorrencia',referenceId:'Banco-328',photoSource:{...photo,occurrence:2},desc:'Linha distinta'},
    {...bank,id:'outrabanco',account:'Ueno',photoSource:undefined,desc:'Banco distinto'},
    {...bank,id:'outrosentido',type:'receita',photoSource:undefined,desc:'Sentido distinto'},
    {...bank,id:'outradata',date:'2026-01-22',photoSource:undefined,desc:'Data distinta'},
    {...bank,id:'outramoeda',currency:'USD',photoSource:undefined,desc:'Moeda distinta'},
    {...bank,id:'outrovalor',amount:53,photoSource:undefined,desc:'Valor distinto'},
    tx('s1',{weeklyRevenue:true,weeklySource:week,desc:'Semana original'}),
    tx('s2',{weeklyRevenue:true,weeklySource:week,date:'2026-01-08',amount:21,desc:'Semana renomeada'}),
    tx('semref',{desc:'Original avulsa'}),tx('semref2',{desc:'Compra parecida'}),
  ];
  saveBase(d);api.setFilters({month:'2026-10',search:'não existe'});
  const before=JSON.stringify([...storage]),beforeDataset=JSON.stringify(api.getDataset());
  const view=get('#tx-origin-review'),results=get('#tx-origin-results');
  view.open=true;view.listeners.get('toggle')();
  assert.match(get('#tx-origin-status').textContent,/2 grupos/);
  assert.match(results.innerHTML,/Referência bancária Banco-326.*Mesma foto, linha e ocorrência/);
  assert.match(results.innerHTML,/Texto alterado/);assert.match(results.innerHTML,/Semana renomeada/);
  assert.match(results.innerHTML,/05\/01\/2026/);assert.doesNotMatch(results.innerHTML,/distint[ao]|avulsa|parecida/);
  assert.equal((results.innerHTML.match(/<li>/g)||[]).length,4);
  assert.equal(JSON.stringify([...storage]),before);assert.equal(JSON.stringify(api.getDataset()),beforeDataset);
  view.open=false;view.listeners.get('toggle')();assert.equal(results.innerHTML,'');
});

test('conferência pagina inclusive grupos grandes e permite consultar todas as ocorrências',()=>{
  const d=dataset();d.transactions=Array.from({length:24},(_,i)=>tx('read'+i,{referenceId:'T-2026',desc:'Registro '+i}));
  saveBase(d);const view=get('#tx-origin-review'),results=get('#tx-origin-results');
  view.open=true;view.listeners.get('toggle')();
  assert.equal((results.innerHTML.match(/<li>/g)||[]).length,20);assert.match(get('#tx-origin-status').textContent,/Página 1 de 2/);
  get('#tx-origin-next').listeners.get('click')();assert.equal((results.innerHTML.match(/<li>/g)||[]).length,4);
  assert.match(results.innerHTML,/Registro 23/);assert.equal(get('#tx-origin-next').disabled,true);
  get('#tx-origin-prev').listeners.get('click')();assert.match(results.innerHTML,/Registro 0/);
  view.open=false;view.listeners.get('toggle')();
});

(async()=>{
  let failed=0;
  for(const [name,fn] of cases){try{await fn();console.log('PASS',name);}catch(error){failed++;console.error('FAIL',name,error);}}
  console.log(`${cases.length-failed}/${cases.length} dashboard regression cases passed`);
  process.exitCode=failed ? 1 : 0;
})();
