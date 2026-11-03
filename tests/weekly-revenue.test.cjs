const {test}=require('node:test'),assert=require('node:assert/strict');
const X=require('../lib/xlsx.min.js'), weekly=require('../js/weekly-revenue.js');
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
