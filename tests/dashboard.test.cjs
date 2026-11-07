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
    splitInstallments, tableTxs, sortTxs, saveTxModal, openTxModal, openMetaModal, saveMetaModal,
    openLimitModal, saveLimitModal, renderTable, renderSummary, parcSiblings, fixedSiblings,
    resolveImportDate, appendImported, addBulk, exportCSV, saveCur, undo, moneyTip, refreshFromStore,
    existingTxKeys, existingSeriesKeys, existingTransactions, getImportTargetId, renderAll, limitStats, metaStats, addToMeta, fillTxFromReceipt, changeBill, currencyBreakdown,
    setDataset(value) { ds = value; }, getDataset() { return ds; },
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

test('conta de outro mês aparece no dashboard, contabiliza uma única vez no pagamento e pode ser reaberta',()=>{
  const ds=dataset(), today=vm.runInContext('todayISO()',ctx);
  ds.transactions=[tx('oldpaid1',{date:today,amount:2}), tx('billopen',{date:'2020-02-03',amount:5,currency:'USD',billPinned:true,paymentStatus:'pending'})];
  ds.limits=[{name:'Alimentação',amount:50,currency:'BRL',categories:['Mercado']}];
  saveBase(ds);api.setFilters({month:today.slice(0,7)});api.renderAll();
  assert.equal(api.limitStats()[0].spent,2);assert.equal(api.currencyBreakdown().length,1);
  const panel=id=>get(id).innerHTML;
  assert.match(panel('#dash-bills'),/billopen/);assert(!panel('#tx-tbody').includes('billopen'));
  api.changeBill('billopen','pay');api.changeBill('billopen','pay');
  let saved=api.getDataset().transactions;assert.equal(saved.length,2);assert.equal(saved[1].paidOn,today);
  assert.equal(saved[1].date,'2020-02-03');assert.equal(api.limitStats()[0].spent,27);
  assert.equal(api.currencyBreakdown().find(g=>g.currency==='USD').expense,5);
  assert.match(panel('#dash-bills'),/data-bill-action="reopen"/);assert.match(panel('#tx-tbody'),/data-bill-action="reopen"/);
  api.setFilters({month:'2020-02'});assert.equal(api.limitStats()[0].spent,0);assert.equal(api.tableTxs().length,0);
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

test('agenda separa vencimentos pelo dia local e deixa o histórico de pagamentos recolhido',()=>{
  const today=vm.runInContext('todayISO()',ctx),ds=dataset();
  ds.transactions=[tx('future01',{date:'2099-01-02',paymentStatus:'pending'}),tx('paid0001',{date:today,paymentStatus:'paid'}),
    tx('debit001',{date:today}),tx('late0001',{date:'2020-01-02',paymentStatus:'pending'}),tx('today001',{date:today,paymentStatus:'pending'})];
  saveBase(ds);api.renderAll();const board=get('#dash-bills').innerHTML;
  const sections=[...board.matchAll(/<section class="bill-group" data-due="([^"]+)">([\s\S]*?)<\/section>/g)];
  assert.deepEqual(sections.map(m=>m[1]),['late','today','upcoming']);
  for(const [i,id] of ['late0001','today001','future01'].entries())assert(sections[i][2].includes(id));
  assert.doesNotMatch(board,/debit001|<details[^>]*\bopen\b/);
  assert.match(board,/Contas pagas \(1\)/);assert.match(board,/3 contas em aberto/);
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

test('fixações antigas preservam o valor contabilizado e receitas não entram em contas a pagar',()=>{
  const ds=dataset();ds.transactions=[tx('wasfixed',{billPinned:true}),tx('income000',{type:'receita',billPinned:true}),tx('plain000')];saveBase(ds);
  const restored=vm.runInContext('Store.loadDataset("audit001")',ctx);api.setDataset(restored);api.renderAll();
  assert.equal(restored.transactions[0].paymentStatus,'paid');assert(!restored.transactions.some(t=>t.billPinned));
  assert.match(get('#dash-bills').innerHTML,/Contas pagas \(1\)/);assert.doesNotMatch(get('#dash-bills').innerHTML,/income000|plain000/);
  assert.doesNotMatch(get('#tx-tbody').innerHTML,/data-bill-action="track"/);
  api.changeBill('income000','track');api.changeBill('wasfixed','track');
  assert.equal(api.getDataset().transactions[1].paymentStatus,undefined);assert.equal(api.getDataset().transactions[0].paymentStatus,'paid');
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
  assert.match(get('#tx-tbody').innerHTML,/Movimento 30\/09\/2026/);
  assert.doesNotMatch(get('#tx-tbody').innerHTML.match(/<tr data-id="last-five"[\s\S]*?<\/tr>/)[0],/Vence em|Venc\. previsto|05\/11\/2026/);
  api.exportCSV();const csv=await csvBlob.text();
  assert.match(csv,/"2026-05-30";"2026-10"/);
  api.setFilters({month:'2026-11'});api.renderAll();
  assert.deepEqual(Array.from(api.tableTxs(),t=>t.id),['projection']);
  assert.doesNotMatch(get('#tx-tbody').innerHTML,/Venc\. previsto|05\/12\/2026/);
  api.setFilters({month:'2026-09'});assert.deepEqual(Array.from(api.tableTxs(),t=>t.id),['other']);
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

(async()=>{
  let failed=0;
  for(const [name,fn] of cases){try{await fn();console.log('PASS',name);}catch(error){failed++;console.error('FAIL',name,error);}}
  console.log(`${cases.length-failed}/${cases.length} dashboard regression cases passed`);
  process.exitCode=failed ? 1 : 0;
})();
