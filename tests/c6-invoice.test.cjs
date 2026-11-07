const test=require('node:test');
const assert=require('node:assert/strict');
const {inspect,reconcile,evidence}=require('../server/c6-invoice.cjs');
const {readPage}=require('../server/document-reader.cjs');
const {PDFDocument,StandardFonts}=require('../lib/pdf-lib.min.js');
const start=['Valor da fatura: R$ 1.000,00 Cartão C6 Carbon','Vencimento: 5 de Novembro','Transações do cartão principal','Lembrando: nesta fatura serão lançadas apenas transações feitas até 29/10/26.','C6 Carbon Subtotal deste cartão R$ 33,00','Valores em reais'];
const rows=['11 ago LOJA DA RUA - Parcela 3/5 15,00','11 ago LOJA DA RUA - Parcela 3/5 15,00','02 out Loja 3,00','04 out Estorno Tarifa - Estorno 2,00','05 out Anuidade Diferenciada - Parcela 3/12 2,00','08 out Inclusao de Pagamento 300,00'];
const blank={completo:true,itens:[],excluidos:[],avisos:[]};
const table=(lines=[...start,...rows])=>inspect({pdf:true,lines});
test('only a uniquely paired same-card annual fee and explicit fee reversal are identified without changing source rows',()=>{
  const fee='24 out Anuidade Diferenciada - Parcela 11/12 98,00';
  const credit='24 out Estorno Tarifa - Estorno 98,00';
  const read=other=>reconcile(blank,table([...start,fee,...other]),[]).itens;
  const [charge,refund]=read([credit]);
  assert.equal(charge.reversedFee,true);assert.equal(charge.parcela,'11/12');assert.equal(charge.valor,98);assert.equal(refund.valor,98);assert.equal(refund.tipo,'receita');
  for(const other of [[credit.replace('24 out','25 out')],[credit.replace('98,00','9,80')],['24 out Estorno LOJA 98,00'],[credit,credit],
      ['C6 Carbon Subtotal deste cartão R$ 98,00',credit]]) assert.equal(read(other)[0].reversedFee,undefined);
  const purchase=reconcile(blank,table([...start,'24 out LOJAANUIDADE - Parcela 11/12 98,00',credit]),[]).itens[0];
  assert.equal(purchase.reversedFee,undefined);
});

test('independent C6 table preserves old printed dates, installments and genuinely identical rows',()=>{
  const parsed=table([...start,...rows,'12 / 18']), data=reconcile(blank,parsed,['Outros']);
  assert.equal(data.completo,true);assert.equal(data.itens.length,6);
  assert.deepEqual(data.itens.slice(0,2).map(r=>[r.data,r.descricao,r.valor,r.parcela,r.moeda,r.billingMonth,r.closingMonth]),
    Array(2).fill(['2026-08-11','LOJA DA RUA',15,'3/5','BRL','2026-11','2026-10']));
  assert.equal(data.itens[3].tipo,'receita');assert.equal(data.itens[4].tipo,'despesa');
  assert.equal(data.excluidos.length,0);
  assert.deepEqual([data.itens[5].tipo,data.itens[5].valor,data.itens[5].data,data.itens[5].creditKind],['receita',300,'2026-10-08','card_payment']);
  const proof=evidence(parsed);
  assert.equal(proof.rows,6);assert.deepEqual(proof.subtotals,[{line:5,cents:3300}]);
  assert.deepEqual(proof.payments,[{line:12,cents:30000}]);
  assert.deepEqual(proof.entries.map(e=>e.cents),[1500,1500,300,-200,200]);
});

test('printed table fields take precedence over model omissions, exclusions, fabricated items and incorrect fields',()=>{
  const parsed=table(),correct=reconcile({itens:[
    {linhas:[7],data:'2026-11-05',descricao:'Errado',tipo:'receita',valor:555,parcela:'1/5',categoria:'Saúde'},
    {linhas:[3],descricao:'Resumo inventado'},
    {linhas:[12],descricao:'fatura paga',tipo:'receita'}],excluidos:[{linhas:[8],motivo:'resumo'}]},parsed,['Saúde','Outros']);
  assert.equal(correct.itens.length,6);
  assert.equal(correct.itens[0].data,'2026-08-11');assert.equal(correct.itens[0].valor,15);
  assert.equal(correct.itens[0].tipo,'despesa');assert.equal(correct.itens[0].categoria,'Saúde');
  assert.equal(correct.itens[1].categoria,'Outros');
  assert(!correct.itens.some(r=>r.descricao.includes('inventado')));
});

test('card payments and incoming transfers are recorded once; only purchases and refunds enter the card subtotal',()=>{
  const parsed=table([...start,...rows,'Transferências','Valores em reais','08 out PIX enviado Loja 80,51','12 out PIX recebido Cliente 120,00','15 out Transferência entre contas próprias 20,00']);
  const {itens,excluidos}=reconcile(blank,parsed,['Outros']);
  assert.equal(itens.length,8);assert.equal(excluidos.length,1);
  assert.deepEqual(itens.slice(-2).map(r=>[r.tipo,r.valor]),[['despesa',80.51],['receita',120]]);
  assert.equal(evidence(parsed).entries.length,5);
});

test('exact cycle dates and printed best day are preserved separately for every operation, including December turnover',()=>{
  const header=['Cartão C6 Carbon','Valor da fatura','Vencimento: 05 de Janeiro','Melhor dia de compra: 28',
    'Transações do cartão principal','Valores em reais','Transações feitas até 29/12/26.'];
  for(const reference of [null,{lines:['Data do vencimento: 05/01/2027']}]) {
    const parsed=inspect({pdf:true,lines:[...header,'30 ago LOJA - Parcela 4/7 340,00','05 dez Inclusão de Pagamento 340,00']},reference);
    for(const entry of [...reconcile(blank,parsed,[]).itens, evidence(parsed)]){
      assert.equal(entry.closingDate,'2026-12-29');assert.equal(entry.dueDate,'2027-01-05');assert.equal(entry.bestPurchaseDay,28);
    }
  }
  const partial=table(start.filter(s=>!s.includes('Vencimento:')&&!s.includes('feitas até')).concat(['10 ago Loja 5,00']));
  assert.equal(evidence(partial).dueDate,undefined);assert.equal(evidence(partial).bestPurchaseDay,undefined);
});

test('a sufficiently evidenced long installment resolves its purchase year across the invoice cycle',()=>{
  const data=reconcile(blank,table([...start,'31 ago LOJA - Parcela 14/18 20,00']),[]).itens;
  assert.equal(data.length,1);assert.equal(data[0].data,'2025-08-31');
});

test('a broken date, unknown transfer direction or unreadable amount is never reported as complete',()=>{
  for(const lines of [
    [...start,'22 ago LOJA - Parcela 3/5','15,00'],
    [...start,'Transferências','Valores em reais','12 out transferência bancária 45,00'],
    [...start,'32 fev Loja 100,00'],
    [...start,'11 ago Loja - Parcela 19/60 1.000,00'],
    start]) {
    const t=table(lines);assert.equal(evidence(t).complete,false);assert.equal(reconcile(blank,t,[]).completo,false);
  }
});

test('recognition is scoped to the C6 invoice; summary and boleto are informational only',()=>{
  for(const title of ['Resumo da fatura','Formas de pagamento','Pagamento de fatura']){
    const t=table([start[0],title,'Saldo das obrigações futuras R$ 2.222,33']);assert(t.info);assert.equal(reconcile(blank,t,[]).itens.length,0);
  }
  assert.equal(table(['Outro banco','Transações do cartão principal','11 ago LOJA 5,00']),null);
  assert.equal(table([start[0],'Modelo de página desconhecido','11 ago LOJA 5,00']),null);
});

async function pdfPage(lines){
  const doc=await PDFDocument.create(),p=doc.addPage(),font=await doc.embedFont(StandardFonts.Helvetica);
  lines.forEach((line,i)=>p.drawText(line,{x:18,y:770-i*16,size:10,font}));return doc.saveAsBase64();
}
test('both reads enumerate purchases from the original file, even when simulated AI omitted all purchases',async t=>{
  let calls=0;t.mock.method(global,'fetch',async()=>{calls++;return {ok:true,json:async()=>({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(blank)}]}]})};});
  const page=await pdfPage([...start,...rows]),sourceHeader=await pdfPage(['Vencimento:','05/11/2026']);
  const args={image:{media_type:'application/pdf',data:page},context:{pageStart:3,pageEnd:3,totalPages:5},cards:['C6'],categories:['Outros'],sourceHeader};
  const first=await readPage(args,'test-only');assert.equal(first.itens.length,6);
  const second=await readPage({...args,first:{...first,itens:first.itens.slice(0,2)}},'test-only');
  assert.equal(second.itens.length,6);assert.deepEqual(second.itens,first.itens);
  assert.equal(second.itens.filter(r=>r.creditKind==='card_payment').length,1);
  assert.equal(second.ledger.monetaryLines,6);assert.equal(second.ledger.accounted,6);
  assert.equal(second.verified,true);assert.equal(second.firstCount,2);assert.equal(second.corrected,true);
  assert.equal(second.ledger.missing.length,0);assert.equal(second.provider,'pdf');assert.equal(calls,1);
});
