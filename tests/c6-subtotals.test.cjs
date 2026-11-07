const test = require('node:test');
const assert = require('node:assert/strict');
const verifier = () => import('../supabase/functions/receipt-jobs/c6-subtotals.mjs');
const user = '10000000-0000-4000-a000-000000000000';
const job = '10000000-0000-4000-a000-000000000001';
function part(doc, pageStart, totalPages, subtotals=[], entries=[], complete=true) {
  const result = {
    statementCheck:{source:'c6_invoice', complete, entries:entries.map(([line,cents])=>({line,cents})), subtotals:subtotals.map(([line,cents])=>({line,cents}))}
  };
  return {document_id:doc, context:{pageStart,totalPages}, result};
}
const multipleCards=()=>[
  part('one',1,3,[[5,11000]],[[7,3000]]),
  part('one',2,3,[[15,2000]],[[4,8000],[17,1400]]),
  part('one',3,3,[],[[1,800],[2,-200]]),
  part('two',1,1,[[8,975]],[[9,975]]),
];

test('reconciliação atravessa páginas e separa cada cartão e cada PDF pela ordem impressa', async()=>{
  const {checkC6Subtotals}=await verifier();
  const good=multipleCards().reverse();
  assert.equal(checkC6Subtotals(good),null);
  const missing=multipleCards();
  missing[1].result.statementCheck.entries.shift();
  assert.match(checkC6Subtotals(missing),/subtotal.+página 1/);
  const offsettingErrors=multipleCards();
  offsettingErrors[0].result.statementCheck.entries[0].cents+=100;
  offsettingErrors[2].result.statementCheck.entries[0].cents-=100;
  assert.match(checkC6Subtotals(offsettingErrors),/subtotal.+página 1/);
});

test('prova de linhas exige a entrada de pagamento e a transferência mesmo quando o subtotal de compras confere',async()=>{
  const {checkC6Subtotals}=await verifier();
  const make=()=>{
    const page=part('fatura',1,1,[[1,800]],[[2,1000],[3,-200]]);
    const values=[[10,'despesa','card'],[2,'receita','card'],[6145.28,'receita','card_payment'],[40,'receita','transfer']];
    Object.assign(page.result.statementCheck,{version:2,rows:4,payments:[{line:4,cents:614528}],
      movements:values.map(([n,type,section],index)=>({line:index+2,cents:Math.round(n*100),type,section}))});
    page.result.itens=values.map(([valor,tipo,section],index)=>({sourceLines:[index+2],moeda:'BRL',valor,tipo,...(section==='card_payment'?{creditKind:'card_payment'}:{})}));
    return [page];
  };
  assert.equal(checkC6Subtotals(make()),null);
  for(const change of [
    r=>r.itens.splice(2,1), r=>r.itens.splice(3,1), r=>{r.itens[2].tipo='despesa';},
    r=>{r.itens[2].valor=614.52;}, r=>{r.itens[2].sourceLines=[2];},r=>{delete r.itens[2].creditKind;},
    r=>{r.statementCheck.payments=[];},r=>{delete r.statementCheck.version;},r=>{r.statementCheck.entries.push({line:4,cents:-614528});},
  ]) {
    const bad=make();change(bad[0].result);assert.match(checkC6Subtotals(bad),/incompleta/);
  }
});

test('subtotal ausente e transferências sem lançamentos de cartão não geram falhas espúrias',async()=>{
  const {checkC6Subtotals}=await verifier();
  assert.equal(checkC6Subtotals([part('transfer',1,1),part('without',1,1,[],[[2,100]])]),null);
  assert.equal(checkC6Subtotals([{result:{partial:true},context:{pageStart:1,totalPages:3}}]),null);
  const incomplete=multipleCards();incomplete[1].result.partial=true;
  assert.match(checkC6Subtotals(incomplete),/incompleta/);
  assert.match(checkC6Subtotals(multipleCards().slice(1)),/Faltam páginas/);
  const repeated=multipleCards();repeated[1].context.pageStart=1;
  assert.match(checkC6Subtotals(repeated),/Faltam páginas/);
  assert.equal(checkC6Subtotals([part('equal',1,1,[[1,1000]],[[2,500],[3,500]])]),null);
});

test('Edge usa prova da leitura privada no commit e aceita seleção parcial após conferir o documento inteiro',async()=>{
  const {createBackend}=await import('../supabase/functions/receipt-jobs/core.mjs');
  const pages=multipleCards().slice(0,3);
  const tx={date:'2026-09-01',amount:30,desc:'Seleção parcial',currency:'BRL',type:'despesa'};
  let status='ready',calls=[];
  const backend=createBackend({url:'https://example.invalid',serviceKey:'synthetic',publicKey:'test',fetcher:async(url,init)=>{
    calls.push(url);
    if(url.includes('/receipt_jobs?')){
      assert(url.includes('user_id=eq.'+user));return Response.json([{id:job,status}]);
    }
    if(url.includes('/receipt_job_pages?')){
      assert(url.includes('job_id=eq.'+job));
      return Response.json(url.includes('statement:result->statementCheck') ? pages.map(p=>({document_id:p.document_id,context:p.context,partial:false,statement:p.result.statementCheck})) : pages);
    }
    assert(url.endsWith('/rpc/receipt_commit'));assert.equal(JSON.parse(init.body).p_txs.length,1);
    return Response.json({transactions:[tx]});
  }});
  const commit=()=>backend.userAction(user,{action:'commit',id:job,transactions:[tx]});
  assert.equal((await backend.userAction(user,{action:'get',id:job})).statementError,null);
  await commit();
  pages[1].result.statementCheck.entries.shift();calls=[];
  assert.match((await backend.userAction(user,{action:'get',id:job})).statementError,/subtotal/);
  await assert.rejects(commit(),/c6_statement_incomplete/);assert(!calls.some(s=>s.includes('/rpc/receipt_commit')));
  status='committed';calls=[];await commit();
  assert(!calls.some(s=>s.includes('receipt_job_pages')));
});

test('leitor genérico só pode completar o mesmo PDF C6 com página integralmente informativa',async()=>{
  const {checkC6Subtotals}=await verifier();
  const card=part('invoice',1,2,[[1,2900]],[[2,2900]]);
  const generic={document_id:'invoice',context:{pageStart:2,totalPages:2},result:{itens:[{valor:15}],partial:false}};
  assert.match(checkC6Subtotals([card,generic]),/operações da página 2/);
  generic.result.itens=[];generic.result.excluded=[{operacao:true,motivo:'outro'}];
  assert.match(checkC6Subtotals([card,generic]),/operações da página 2/);
  generic.result.excluded=[{operacao:false,motivo:'resumo'}];
  assert.equal(checkC6Subtotals([card,generic]),null);
  generic.result.partial=true;assert.match(checkC6Subtotals([card,generic]),/operações da página 2/);
});
