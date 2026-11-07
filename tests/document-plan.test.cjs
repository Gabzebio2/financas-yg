const test=require('node:test'),assert=require('node:assert/strict');
const planner=()=>import('../supabase/functions/receipt-jobs/document-plan.mjs');
const item=(overrides={})=>({data:'2026-08-11',descricao:'Compra',valor:164.90,moeda:'BRL',tipo:'despesa',
  categoria:'mercado',parcela:'',instituicao:'C6',evidencia:'linha original',referencia:'',revisar:[],...overrides});
function page(id,itens,overrides={}) {
  return {document_id:id,media_type:'application/pdf',label:'Extrato · página 1 de 1',context:{pageStart:1,totalPages:1},
    result:{itens,excluded:[],avisos:[],cartao:'C6',reviewMode:'compared',partial:false,verified:true,
      coverage:{complete:true,unreadablePages:[],pagesRead:[1]},ledger:{monetaryLines:itens.length,accounted:itens.length,missing:[],duplicates:[]},...overrides}};
}
function c6(id,itens) {
  return page(id,itens,{statementCheck:{source:'c6_invoice',complete:true,rows:itens.length,subtotals:[],
    entries:itens.map((r,i)=>({line:i+1,cents:Math.round(100*r.valor)*(r.tipo==='receita'?-1:1)}))}});
}
function saved(overrides={}) {
  return {id:'existing',date:'2026-08-11',desc:'Compra',amount:164.9,type:'despesa',currency:'BRL',account:'C6',...overrides};
}
test('cada linha do cartão, inclusive pagamento recebido e parcela legada, tem um destino verificável',async()=>{
 const {planDocumentImport}=await planner();
 const txs=[item({data:'2026-05-30',descricao:'Loja A',valor:340,parcela:'5/5',sourceLines:[4]}),
   item({data:'2026-05-24',descricao:'Loja B',valor:33.30,parcela:'6/6',sourceLines:[5]}),
   item({data:'2026-10-05',descricao:'Inclusao de Pagamento',valor:6145.28,tipo:'receita',sourceLines:[6],creditKind:'card_payment'})];
 const movements=txs.map(t=>({line:t.sourceLines[0],cents:Math.round(t.valor*100),type:t.tipo,section:t.creditKind?'card_payment':'card'}));
 const p=page('doc',txs,{statementCheck:{source:'c6_invoice',version:2,complete:true,rows:3,movements,entries:movements.slice(0,2),
   payments:[movements[2]],subtotals:[],dueDate:'2026-11-05',closingDate:'2026-10-29',bestPurchaseDay:28}});
 const existing=txs.slice(0,2).flatMap((t,i)=>Array.from({length:i+5},(_,j)=>saved({desc:t.descricao,amount:t.valor,id:'legacy'+i+j,
   groupId:'group'+i,date:'2026-'+String((i?4:5)+j).padStart(2,'0')+'-'+(i?'24':'30'),installment:(j+1)+'/'+(i+5)})));
 const plan=planDocumentImport({pages:[p],existing});
 assert.equal(plan.coverageError,'');assert.equal(plan.skipped,0);assert.equal(plan.transactions.length,1);
 assert.equal(plan.transactions[0].creditKind,'card_payment');assert.equal(plan.transactions[0].cardBestPurchaseDay,28);
 assert.deepEqual(plan.sourceRefs.map(r=>r.id ?? r.index).sort(),[0,'legacy04','legacy15']);
 assert.equal(plan.matches.filter(x=>x.observed && x.billDueDate==='2026-11-05').length,2);
 assert.deepEqual(plan.statements.map(s=>[s.accountingMonth,s.expenseCount,s.expenseCents,s.creditCount,s.creditCents,s.paymentCents,s.refundCents]),
   [['2026-10',2,37330,1,614528,614528,0]]);
 p.result.itens.pop();
 assert(planDocumentImport({pages:[p],existing}).coverageError);
});
test('fechamento da capa cobre compras anteriores e estornos, e um lançamento em mês divergente impede a inclusão',async()=>{
  const {planDocumentImport}=await planner();
  const txs=[item({data:'2026-09-30',valor:45.19,sourceLines:[1]}),item({data:'2026-10-02',descricao:'Estorno',tipo:'receita',valor:8.76,sourceLines:[2]})];
  const cover=page('doc',[],{statementCheck:{source:'c6_invoice',version:2,complete:true,rows:0,movements:[],entries:[],subtotals:[],payments:[],closingDate:'2026-10-29'}});
  const p=page('doc',txs,{statementCheck:{source:'c6_invoice',version:2,complete:true,rows:2,
    movements:[{line:1,type:'despesa',section:'card',cents:4519},{line:2,type:'receita',section:'card',cents:876}],
    entries:[{line:1,cents:4519},{line:2,cents:-876}],payments:[],subtotals:[]}});
  cover.context.totalPages=2;p.context={pageStart:2,totalPages:2};
  const go=()=>planDocumentImport({pages:[cover,p],existing:[]});
  const r=go();assert.equal(r.coverageError,'');assert.deepEqual(r.transactions.map(t=>t.date),['2026-09-30','2026-10-02']);
  const {statementDate}=require('../js/installment-schedule.js');
  assert.deepEqual(r.transactions.map(statementDate),['2026-10-30','2026-10-02']);
  assert.equal(r.statements[0].refundCents,876);assert.equal(r.statements[0].expenseCents,4519);
  const {cleanTransactions}=await import('../supabase/functions/receipt-jobs/core.mjs');
  assert(cleanTransactions(r.transactions).every(t=>t.billDateObserved && t.billClosingDate==='2026-10-29'));
  p.result.itens[0].closingDate='2026-11-27';assert.match(go().coverageError,/fechamento/);
  delete p.result.itens[0].closingDate;delete cover.result.statementCheck.closingDate;assert.match(go().coverageError,/fechamento/);
});
test('programa parcelas impressas em C6 sem somar a mensalidade já estornada ou a quitação anterior',async()=>{
  const {planDocumentImport}=await planner();
  const p=c6('fatura',[item({descricao:'Loja - Parcela 3/5',parcela:'3/5',billingMonth:'2026-11'}),
    item({descricao:'Anuidade',parcela:'11/12',reversedFee:true,valor:98}),item({descricao:'Estorno Tarifa',tipo:'receita',valor:98}),
    item({descricao:'PIX recebido',tipo:'receita',valor:20})]);
  p.result.excluded=[{motivo:'transferencia_propria',operacao:true}];
  const {transactions,blockedDocuments,excluded}=planDocumentImport({pages:[p],existing:[],categories:['Mercado']});
  assert.deepEqual(blockedDocuments,[]);assert.equal(excluded,1);
  const slots=transactions.filter(t=>t.seriesKey);assert.equal(slots.length,5);
  assert.deepEqual(slots.map(x=>x.date),['2026-08-11','2026-09-11','2026-10-11','2026-11-11','2026-12-11']);
  assert.deepEqual(slots.map(x=>x.installment),['1/5','2/5','3/5','4/5','5/5']);
  assert(slots.every(x=>x.amount===164.9 && x.desc==='Loja' && x.account==='C6' && x.purchaseDate==='2026-08-11' && x.category==='Mercado'));
  assert.equal(transactions.filter(t=>t.desc==='Anuidade'&&t.installment==='11/12'&&!t.seriesKey).length,1);
  assert.equal(transactions.filter(t=>!t.installment&&t.type==='receita').length,2);
  const {cleanTransactions}=await import('../supabase/functions/receipt-jobs/core.mjs');
  assert.equal(cleanTransactions(transactions).length,8);
});
test('programação é idempotente e preserva duas compras iguais no original',async()=>{
  const {planDocumentImport}=await planner(),row=item({parcela:'3/5',billingMonth:'2026-11'}),p=c6('a',[row,{...row}]);
  const first=planDocumentImport({pages:[p],existing:[]});assert.equal(first.transactions.length,10);
  assert.equal(new Set(first.transactions.map(t=>t.seriesKey)).size,2);
  const existing=first.transactions.map((t,i)=>({...t,id:'saved'+i}));
  const repeated=planDocumentImport({pages:[p],existing});assert.equal(repeated.transactions.length,0);assert.equal(repeated.duplicates,10);
  existing.splice(3,1);
  const repaired=planDocumentImport({pages:[p],existing});assert.equal(repaired.transactions.length,1);
  assert.equal(repaired.transactions[0].installment,'4/5');assert.equal(repaired.duplicates,9);
});
test('ocorrências iguais de linhas avulsas em um documento consomem apenas uma ocorrência existente',async()=>{
  const {planDocumentImport}=await planner(),p=page('one',[item(),item(),item({tipo:'receita'})]);
  const {transactions,duplicates}=planDocumentImport({pages:[p,{...p,document_id:'same-file-again'}],existing:[saved()]});
  assert.equal(transactions.length,2);assert.deepEqual(transactions.map(t=>t.type),['despesa','receita']);assert.equal(duplicates,4);
  const separate=planDocumentImport({pages:[page('one',[item({referencia:'new-id'})])],existing:[saved({referenceId:'other-id'})]});
  assert.equal(separate.transactions.length,1);
});
test('moeda do débito, cashback informativo e data aproximada seguem a leitura do documento',async()=>{
  const {planDocumentImport}=await planner(),p=page('one',[item({valor:220,moeda:'PYG',instituicao:'Ueno',data:'2026-08-01'}),
    item({data:'',moeda:'USD',valor:8.78,revisar:['Confira a data'],instituicao:'Ether.fi',cashback:{valor:0.08,moeda:'USD'}}),
    item({data:'2026-08-03'}),item({data:'',grupoSemData:true})],{verified:false});
  const {transactions,skipped}=planDocumentImport({pages:[p],existing:[]});
  assert.equal(skipped,1);assert.equal(transactions.length,3);const t=transactions[1];
  assert.equal(t.date,'2026-08-02');assert.equal(t.dateEstimated,true);assert.equal(t.currency,'USD');assert.equal(t.account,'Ether.fi');
  assert.deepEqual(t.cashback,{amount:.08,currency:'USD'});
});
test('mesma parcela já anotada próxima é ignorada sem interferir em outro lojista ou outra parcela',async()=>{
  const {planDocumentImport}=await planner();
  const existing=[saved({installment:'3/5',date:'2026-09-11'})];
  const r=planDocumentImport({pages:[page('one',[item({parcela:'3/5'}),item({parcela:'2/5'}),item({parcela:'3/5',descricao:'Outra loja'})])],existing});
  assert.equal(r.duplicates,1);assert.equal(r.transactions.length,2);
  assert.deepEqual(r.transactions.map(t=>[t.desc,t.installment]),[['Compra','2/5'],['Outra loja','3/5']]);
});
test('doc com subtotal ou páginas faltantes não impede incluir outro PDF comprovado',async()=>{
  const {planDocumentImport}=await planner();
  const bad=c6('bad',[item()]);bad.result.statementCheck.subtotals=[{line:0,cents:9999}];
  const incomplete=page('incomplete',[item()]);incomplete.context.totalPages=2;
  const scanned=page('scan',[item({descricao:'Pago por PIX'})]);
  Object.assign(scanned.result.ledger,{monetaryLines:0,accounted:0});
  const {transactions,blockedDocuments}=planDocumentImport({pages:[bad,incomplete,scanned],existing:[]});
  assert.equal(transactions.length,1);assert.equal(blockedDocuments.length,2);
  assert.match(blockedDocuments[0].reason,/subtotal/);assert.match(blockedDocuments[1].reason,/páginas/);
});
test('dados incertos de um item não descartam outras linhas confirmadas da página',async()=>{
  const {planDocumentImport}=await planner(),p=page('one',[item({valor:null,invalid:true,revisar:['Valor ilegível']}),item({descricao:'Estojo'})],{verified:false});
  const r=planDocumentImport({pages:[p],existing:[]});assert.equal(r.skipped,1);assert.equal(r.transactions[0].desc,'Estojo');
  const count=page('two',[item()],{expectedCount:3});
  assert.match(planDocumentImport({pages:[count],existing:[]}).blockedDocuments[0].reason,/contagem/);
  const uncategorized=page('other',[item({revisar:['Categoria incerta']})],{verified:false});
  const accepted=planDocumentImport({pages:[uncategorized],existing:[],categories:['Mercado']});
  assert.equal(accepted.skipped,0);assert.equal(accepted.transactions[0].category,'Outros');
});
test('aplica automaticamente apenas PDFs realmente comparados e sem dados extras de planilha',async()=>{
  const {planDocumentImport}=await planner(),p=page('a',[item()]);
  for (const args of [{pages:[{...p,media_type:'image/jpeg'}]}, {pages:[p],extraRows:[{}]},
    {pages:[page('a',[item()],{reviewMode:'pending'})]}, {pages:[page('a',[item()],{partial:true})]}]) {
    const report=planDocumentImport({existing:[],...args});assert.equal(report.transactions.length,0);assert.equal(report.blockedDocuments.length,1);
  }
});
