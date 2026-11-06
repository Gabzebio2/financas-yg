"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {plan}=require("../js/installment-schedule.js");
const line=(overrides={})=>({desc:"Farmácia",date:"2026-08-11",account:"C6",currency:"BRL",type:"despesa",amount:164.90,installment:"3/5",sourceDocumentId:"invoice",...overrides});
const tx=(n,date,more={})=>({...line(),id:"slot-"+n,installment:n+"/5",date,...more});
const missing=g=>g.installments.filter(p=>!p.matchedId&&!p.ambiguous).map(p=>p.number);

test("compra em agosto programa desde a primeira até a última parcela sem deslocar a origem para a posição impressa",()=>{
  const [g]=plan([line()],[]);
  assert.deepEqual(g.installments.map(s=>s.date),["2026-08-11","2026-09-11","2026-10-11","2026-11-11","2026-12-11"]);
  assert.deepEqual(g.printedNumbers,[3]);assert.deepEqual(missing(g),[1,2,3,4,5]);
  assert.equal(g.seriesKey,'c6:v1:["2026-08-11",5,"farmacia","BRL","despesa","c6",164.9,1]');
  const [monthEnd]=plan([line({date:"2024-01-31"})],[]);
  assert.deepEqual(monthEnd.installments.slice(0,3).map(s=>s.date),["2024-01-31","2024-02-29","2024-03-31"]);
});

test("duas compras iguais do mesmo documento permanecem duas, inclusive no documento do mês seguinte",()=>{
  const first=line(),second=line();
  const next=line({sourceDocumentId:"next",installment:"4/5"});
  const groups=plan([first,second,next,{...next}],[]);
  assert.equal(groups.length,2); assert.notEqual(groups[0].seriesKey,groups[1].seriesKey);
  for(const g of groups){assert.deepEqual(g.printedNumbers,[3,4]);assert.deepEqual(missing(g),[1,2,3,4,5]);}
  const saved=groups.map((g,i)=>tx(3,"2026-10-11",{id:"saved"+i,seriesKey:g.seriesKey,purchaseDate:"2026-08-11",groupId:"stored"+i}));
  const replay=plan([next,{...next}],saved);
  assert.deepEqual(replay.map(g=>g.installments[2].matchedId),["saved0","saved1"]);
  assert.deepEqual(replay.map(g=>g.groupId),["stored0","stored1"]);
});

test("grupo legado comprovado é completado apenas nas posições ausentes, mesmo se houve adiantamento",()=>{
  const old=[tx(1,"2026-08-11",{groupId:"legacy",account:"C6 Bank"}),
    tx(3,"2026-09-30",{groupId:"legacy",advance:{scheduledDate:"2026-10-11"}})];
  const [g]=plan([line()],old);assert(!g.needsReview);assert.equal(g.groupId,"legacy");assert.deepEqual(missing(g),[2,4,5]);
  const patched=old.concat(tx(2,"2026-09-11",{groupId:"legacy",seriesKey:g.seriesKey,purchaseDate:"2026-08-11"}));
  const [reloaded]=plan([line({installment:"4/5"})],patched);
  assert(!reloaded.needsReview);assert.equal(reloaded.groupId,"legacy");assert.deepEqual(missing(reloaded),[4,5]);
});

test("duas posições diferentes impressas na mesma fatura compõem uma série, conservando multiplicidade por posição",()=>{
  const inputs=[line({installment:"2/5"}),line(),line(),line({installment:"4/5"})];
  const groups=plan(inputs,[]);
  assert.equal(groups.length,2);assert.deepEqual(groups[0].printedNumbers,[2,3,4]);assert.deepEqual(groups[1].printedNumbers,[3]);
  assert(groups[0].installments.every(slot=>slot.printed===groups[0].printedNumbers.includes(slot.number)));
});

test("série antiga deslocada por um mês requer conferência e não cria parcelas duplicadas",()=>{
  const printed=line({date:"2026-05-24",installment:"6/6"});
  const old=Array.from({length:6},(_,i)=>tx(i+1,`2026-${String(i+4).padStart(2,"0")}-24`,{groupId:"old",installment:(i+1)+"/6"}));
  const [g]=plan([printed],old);assert(g.needsReview);assert.deepEqual(missing(g),[]);
  const otherPurchase=old.map(t=>({...t,purchaseDate:"2026-04-24"}));
  const [other]=plan([printed],otherPurchase);assert(!other.needsReview);assert.deepEqual(missing(other),[1,2,3,4,5,6]);
});

test("um slot legado só cobre uma compra observada; dois vínculos plausíveis não são escolhidos arbitrariamente",()=>{
  const old=[tx(1,"2026-08-11")];
  const two=plan([line(),line()],old);assert.deepEqual(two.map(g=>g.installments[0].matchedId),["slot-1",null]);assert(!two.some(g=>g.needsReview));
  const [ambiguous]=plan([line()],[{...old[0],id:"a",groupId:"a"},{...old[0],id:"b",groupId:"b"}]);
  assert(ambiguous.needsReview);assert.deepEqual(missing(ambiguous),[]);
});

test("nome, moeda, conta, origem e total distinguem compras independentes e não são substituídos por uma linha semelhante",()=>{
  const candidates=[line({desc:"Farmácia II"}),line({account:"Outro cartão"}),line({currency:"USD"}),line({amount:164.91}),line({installment:"3/6"})];
  const old=[tx(1,"2026-08-11",{groupId:"old"})];
  for(const candidate of candidates){const [g]=plan([candidate],old);assert(!g.needsReview);assert(!g.installments.some(s=>s.matchedId));}
});
