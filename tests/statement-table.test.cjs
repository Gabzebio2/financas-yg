const test=require('node:test'),assert=require('node:assert/strict');
const {header,tableLines,parseTable,reconcile,integer}=require('../server/statement-table.cjs');
const {sourceLedger,normalize,readPage}=require('../server/document-reader.cjs');
const {fixture}=require('./fixtures/ueno-statement.cjs');
const base=()=>({lines:['ueno bank S.A. Reporte de Movimientos','Moneda: Guaraníes','Saldo final 210.000','Fecha Comprobante Concepto Importe Saldo','30/09/2026 12:00 123 Devolucion Adobe + 10.000 210.000','29/09/2026 11:00 123 Compra Adobe - 20.000 200.000','29/09/2026 10:00 123 Compra Adobe -20.000 220.000','Saldo inicial 240.000']});
const raw=()=>({itens:[],excluidos:[],cartao:'',avisos:[],completo:false});
test('Importe é a operação e Saldo somente a prova: sinais, estorno e comprovantes repetidos',()=>{
 const l=base(),t=parseTable(l);assert(t.complete);assert.deepEqual(t.rows.map(r=>r.amount),[10000,-20000,-20000]);
 l.moneyLines=tableLines(l);const r=normalize(reconcile(raw(),t,['Outros']),l,null,['Ueno']);
 assert(r.verified);assert.equal(r.cartao,'Ueno');assert.deepEqual(r.itens.map(r=>[r.valor,r.moeda,r.tipo,r.referencia]),[[10000,'PYG','receita',''],[20000,'PYG','despesa',''],[20000,'PYG','despesa','']]);assert.equal(r.excluded.length,2);
});
test('moeda explícita da página vence contexto e banco sozinho nunca força guarani',()=>{
 assert.equal(header(base()).currency,'PYG');const first=base();
 const continuation=base();continuation.lines=continuation.lines.filter(s=>!s.startsWith('Moneda:'));assert.equal(parseTable(continuation),null);assert(parseTable(continuation,first).complete);
 for(const c of ['USD','Euros','desconhecida']){const l=base();l.lines[1]='Moneda: '+c;assert.equal(parseTable(l,first),null);}
 const other=base();other.lines[0]='Outro banco';assert.equal(parseTable(other),null);
});
test('saldos inconsistentes, linhas quebradas e data inválida impedem aprovação automática',()=>{
 for(const update of [l=>l.lines[4]=l.lines[4].replace('210.000','211.000'),l=>l.lines[5]=l.lines[5].replace('- 20.000','- ???'),l=>l.lines[5]=l.lines[5].replace('11:00 123','11:00'),l=>l.lines[5]=l.lines[5].replace('29/09/2026','31/09/2026'),l=>l.lines[5]=l.lines[5].replace('11:00','29:00')]){const l=base();update(l);const t=parseTable(l);assert.equal(t.complete,false);const r=raw();assert.equal(reconcile(r,t,['Outros']),r);}
});
test('guarani preserva milhares, negativos unicode e rejeita casas decimais ambíguas',()=>{
 for(const [v,w] of [['703.720',703720],['− 3.132.000',-3132000],['+20.000',20000],['7,52',null],['7.52',null]])assert.equal(integer(v),w);
});
test('59 operações em duas páginas são recuperadas mesmo com omissões da IA, sem importar cabeçalho duas vezes',async(t)=>{
 const f=await fixture(),ledgers=await Promise.all(f.pages.map(data=>sourceLedger({media_type:'application/pdf',data})));
 const requests=[];t.mock.method(global,'fetch',async(url,init)=>{requests.push(JSON.parse(init.body));return {ok:true,json:async()=>({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(raw())}]}]})};});
 const results=[];for(let p=0;p<2;p++){
  const r=await readPage({image:{media_type:'application/pdf',data:f.pages[p]},sourceHeader:p?f.pages[0]:undefined,categories:['Outros'],cards:['Ueno'],context:{pageStart:p+1,pageEnd:p+1,totalPages:2}},'test');
  assert(r.verified);assert.equal(r.statementCheck.rows,p?27:32);results.push(r);
 }
 assert.deepEqual(results.flatMap(r=>r.itens.map(i=>i.valor*(i.tipo==='despesa'?-1:1))),f.rows.map(r=>r.amount));
 assert(results.every(r=>r.itens.every(i=>i.moeda==='PYG'&&i.instituicao==='Ueno')));
 assert.deepEqual(ledgers.map(l=>l.moneyLines.length),[33,28]);
 // Reference PDF never leaves our server; OpenAI sees only its bank/currency.
 assert.equal(requests[1].input[0].content.filter(c=>c.type==='input_file').length,1);
 assert.match(requests[1].input[0].content[1].text,/"currency":"PYG"/);
 assert(!requests[1].input[0].content[1].text.includes('Compra ficticia 2\n'));
});
