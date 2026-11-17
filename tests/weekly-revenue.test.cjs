const {test}=require('node:test'),assert=require('node:assert/strict');
const X=require('../lib/xlsx.min.js'), weekly=require('../js/weekly-revenue.js');
test('intervalo soma cada conta em centavos e distingue semana ausente de receita zero',()=>{
  const row=(date,account,amount,type='receita',currency='USD')=>({date,account,amount,type,currency,weeklyRevenue:true});
  const m=weekly.periodModel([row('2025-12-29','Estúdio',10.12),row('2026-01-12','Estúdio',0.11),
    row('2026-01-12','Estúdio',0.02,'despesa'),row('2026-01-12','Loja',3),row('2026-01-19','Loja',0),
    row('2026-01-12','Loja',100,'receita','BRL')],'USD');
  assert.deepEqual(m.dates,['2025-12-29','2026-01-05','2026-01-12','2026-01-19']);
  assert.deepEqual(weekly.selectionSummary(m,m.dates.slice(0,3)),{total:1321,reported:2,rows:[['Estúdio',1021],['Loja',300]]});
  assert.equal(weekly.selectionSummary(m,[m.dates[1]]).reported,0);
  assert.deepEqual(weekly.selectionSummary(m,[m.dates[3]]),{total:0,reported:1,rows:[['Loja',0]]});
  assert.deepEqual(weekly.selectionSummary(m,[m.dates[0],m.dates[0],m.dates[3]]),{total:1012,reported:2,rows:[['Estúdio',1012],['Loja',0]]});
  assert.deepEqual(weekly.selectionSummary(m,[]),{total:0,reported:0,rows:[]});
});
function workbook(rows){return {SheetNames:['Semanal'],Sheets:{Semanal:X.utils.aoa_to_sheet(rows)}};}
test('períodos vencem sobre acumulados, totais convertidos e abas de resumo; anos viram em dezembro',()=>{
  const p=weekly.parse(workbook([
    ['', 'Até 29/12','Até 22/12','22 a 29/12','29/12 a 05/01'],
    ['Conta A',125,100,25,0],['Conta B',150,152,-2,null],['',275,252,23,0],['Total em reais',1000,900,100,0]
  ]),2026,X);
  assert.deepEqual(p.entries.map(x=>[x.date,x.amount]),[['2025-12-29',25],['2026-01-05',0],['2025-12-29',-2]]);
  assert.equal(p.accounts.length,2);
});
test('aba só com acumulados usa variações e não interpreta lacunas como zero',()=>{
  const p=weekly.parse(workbook([['','Até 19/01','Até 12/01','Até 05/01'],['Conta A',40,30,20],['Conta B',10,null,8]]),2026,X);
  assert.deepEqual(p.entries.map(x=>x.amount),[10,10]);assert(p.snapshots);
});
test('reimportar atualiza uma célula existente e preserva ganhos corrigidos e semanas novas anotadas no app',()=>{
  let id=0;const ds={transactions:[]},mk=()=>String(++id),row={account:'Loja',date:'2026-10-26',amount:10};
  weekly.apply(ds,[row],'USD',true,mk);weekly.apply(ds,[row],'USD',true,mk);
  weekly.apply(ds,[{...row,amount:15}],'USD',true,mk);
  assert.equal(ds.transactions[0].amount,15);
  weekly.apply(ds,[{...row,amount:18},{...row,date:'2026-11-02',amount:20}],'USD',false,mk);
  assert.equal(weekly.apply(ds,[{...row,amount:17}],'USD',true,mk).conflicts,1);
  assert.deepEqual(ds.transactions.map(t=>t.amount),[18,20]);
});
test('origem empresarial sobrevive a edição de data e conta; outra semana com mesmo valor é legítima',async()=>{
  const entries=[{account:'Conta A',date:'2026-11-07',amount:100},{account:'Conta A',date:'2026-11-14',amount:100}];
  await weekly.identifyEntries(entries,'USD');
  const one={transactions:[]},two={transactions:[]},id=()=>assert.fail('Importação deve usar a identidade estável');
  weekly.apply(one,entries.slice(0,1),'USD',true,id);
  weekly.apply(two,entries.slice(0,1),'USD',true,id);
  assert.equal(one.transactions[0].id,two.transactions[0].id);
  Object.assign(one.transactions[0],{date:'2026-11-08',account:'Conta ajustada'});
  const reloaded=structuredClone(one);
  assert.equal(weekly.apply(reloaded,entries,'USD',true,id).added,1);
  assert.equal(weekly.apply(reloaded,entries,'USD',true,id).added,0);
  assert.equal(reloaded.transactions.length,2);
  assert.deepEqual(reloaded.transactions.map(t=>[t.date,t.account,t.amount]),[['2026-11-08','Conta ajustada',100],['2026-11-14','Conta A',100]]);
  assert.equal(new Set(reloaded.transactions.map(t=>t.id)).size,2);
});
test('ganho antigo alterado pede decisão e uma nova entrada legítima pode ser incluída sem sobrescrever a antiga',()=>{
  let n=0;const make=()=>'ficticio'+(++n);
  const ds={transactions:[{id:make(),account:'Conta A',date:'2026-11-08',amount:100,type:'receita',currency:'USD',weeklyRevenue:true,weeklyImportedAmount:100}]};
  const rows=[{date:'2026-11-07',account:'Conta A',amount:100}],uncertain=[];
  assert.equal(weekly.apply(ds,rows,'USD',true,make,{uncertain}).conflicts,1);
  assert.equal(ds.transactions.length,1);
  assert.equal(weekly.apply(ds,rows,'USD',true,make,{distinct:new Set([uncertain[0].identity])}).added,1);
  assert.equal(weekly.apply(ds,rows,'USD',true,make).added,0);
  assert.equal(ds.transactions[0].date,'2026-11-08');
});
