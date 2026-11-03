const test = require('node:test');
const assert = require('node:assert/strict');
const {photoPlan} = require('../server/receipt-photo.cjs');
const row = {data:'2026-10-24',descricao:'Café',valor:8.78,moeda:'USD',tipo:'despesa',categoria:'Alimentação',
  instituicao:'Ether.fi',referencia:'',evidencia:'USD debitado',revisar:[],cashback:{valor:0.08,moeda:'USD'}};
const plan = (items,changes={}) => photoPlan({itens:items,expectedCount:items.length,excluded:[],coverage:{complete:true},...changes},{pageStart:1},['Alimentação']);
test('foto projeta o débito original e mantém cashback separado em duas compras iguais',()=>{
  const got=plan([row,row]); assert.equal(got.entries.length,2);
  for(const {tx} of got.entries){assert.equal(tx.amount,8.78);assert.equal(tx.currency,'USD');assert.equal(tx.account,'Ether.fi');assert.equal(tx.category,'Alimentação');assert.deepEqual(tx.cashback,{amount:0.08,currency:'USD'});}
});
test('somente a linha sem moeda fica pendente; data ausente usa vizinhas da própria foto',()=>{
  const got=plan([row,{...row,data:'',moeda:''},{...row,data:''},{...row,data:'2026-10-27'}]);
  assert(!got.entries[1].tx);assert.equal(got.entries[2].tx.date,'2026-10-26');assert.equal(got.entries[2].tx.dateEstimated,true);
  assert(!plan([{...row,data:''}]).entries[0].tx);
});
test('foto cuja contagem não fecha ou que contém só exclusões nunca cria um gasto fictício',()=>{
  assert(!plan([row],{expectedCount:2}).entries[0].tx);
  assert.deepEqual(plan([],{expectedCount:1,excluded:[{motivo:'cashback',operacao:true}]}),{entries:[],excluded:1});
});
