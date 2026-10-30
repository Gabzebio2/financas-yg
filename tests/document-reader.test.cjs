const test=require('node:test'),assert=require('node:assert/strict');
const {normalize,sourceLedger,prompt}=require('../server/document-reader.cjs');
const {canFinishQuick,readPage,FAST_MODEL}=require('../server/document-reader.cjs');
const {PDFDocument,StandardFonts}=require('../lib/pdf-lib.min.js');
const row=(extra={})=>({data:'2026-10-10',descricao:'Compra',valor:21.83,moeda:'USD',tipo:'despesa',categoria:'Outros',parcela:'',instituicao:'',referencia:'',evidencia:'Debitado USD 21.83',incertezas:[],linhas:[2],cashback:{valor:0.65,moeda:'USD'},...extra});
const ledger={lines:['DATA','Compra USD 21.83 + USD 0.65','Saldo USD 200.00'],moneyLines:[2,3]};
const raw=(changes={})=>({itens:[row()],excluidos:[{descricao:'Saldo',motivo:'resumo',explicacao:'Não é operação',linhas:[3]}],cartao:'',contagemOperacoes:null,avisos:[],completo:true,...changes});
test('um gasto com conversão e cashback é uma despesa, cashback permanece metadado',()=>{
 const r=normalize(raw(),ledger);assert.equal(r.itens.length,1);assert.equal(r.itens[0].valor,21.83);assert.equal(r.itens[0].moeda,'USD');assert.equal(r.itens[0].cashback.valor,0.65);assert.equal(r.verified,true);
});
test('cashback isolado nunca vira renda mesmo se o modelo classificar como receita',()=>{
 const r=normalize(raw({itens:[row({descricao:'Cashback resgatado',tipo:'receita'})]}),ledger);
 assert.equal(r.itens.length,0);assert.equal(r.excluded.filter(x=>x.motivo==='cashback').length,1);
});
test('igualdade de contagem não aprova página com linha monetária omitida',()=>{
 const data=raw({excluidos:[]}),r=normalize(data,ledger,data);assert.equal(r.firstCount,r.finalCount);assert.equal(r.verified,false);assert.deepEqual(r.ledger.missing,[3]);
});
test('linha desconhecida é preservada como item incompleto, nunca descartada',()=>{
 const r=normalize(raw({itens:[row({valor:null,moeda:'',data:''})]}),ledger);assert.equal(r.itens.length,1);assert.equal(r.itens[0].invalid,true);assert.equal(r.itens[0].valor,null);
});
test('uma linha monetária atribuída a dois gastos exige atenção',()=>{
 const r=normalize(raw({itens:[row(),row()]}),ledger);assert.equal(r.verified,false);assert.deepEqual(r.ledger.duplicates,[2]);assert.equal(r.itens.length,2);
});
test('duas compras reais iguais em linhas distintas preservam multiplicidade',()=>{
 const r=normalize(raw({itens:[row({linhas:[2]}),row({linhas:[3]})],excluidos:[]}),ledger);assert.equal(r.verified,true);assert.equal(r.itens.length,2);
});
test('segunda etapa recupera operação omitida e valores alterados a partir do original',()=>{
 const first=raw({itens:[]}),r=normalize(raw(),ledger,first);assert.equal(r.firstCount,0);assert.equal(r.finalCount,1);assert.equal(r.corrected,true);
});
test('texto PDF é extraído por coordenadas com prova monetária independente do modelo',async()=>{
 const doc=await PDFDocument.create(),page=doc.addPage(),font=await doc.embedFont(StandardFonts.Helvetica);
 page.drawText('Extrato 2026',{x:30,y:780,font});page.drawText('Debito US$ 123.45',{x:30,y:740,font});page.drawText('Cashback US$ 0.65',{x:260,y:740,font});page.drawText('Saldo US$ 500.00',{x:30,y:700,font});
 const l=await sourceLedger({media_type:'application/pdf',data:await doc.saveAsBase64()});
 assert.equal(l.lines.length,3);assert.deepEqual(l.moneyLines,[2,3]);assert.match(l.lines[1],/Debito.*Cashback/);
});
test('uma página não pode esconder páginas adicionais no PDF',async()=>{
 const doc=await PDFDocument.create();doc.addPage();doc.addPage();
 const bytes=await doc.saveAsBase64();await assert.rejects(()=>sourceLedger({media_type:'application/pdf',data:bytes}),/one_page_required/);
});

test('cabeçalho com total diário é contexto compartilhado, não compra duplicada',()=>{
 const l={lines:['10/10/2026 Gasto no cartão: US$ 30','Compra A USD 10','Compra B USD 20'],moneyLines:[1,2,3]};
 const r=normalize(raw({itens:[row({linhas:[1,2]}),row({linhas:[1,3]})],excluidos:[{motivo:'resumo',operacao:false,linhas:[1]}]}),l);
 assert.deepEqual(r.ledger.duplicates,[]);assert.equal(r.verified,true);
});
test('duas descrições do mesmo resumo não são duas operações omitidas',()=>{
 const r=normalize(raw({itens:[],excluidos:[{motivo:'resumo',operacao:false,linhas:[2,3]},{motivo:'cashback',operacao:false,linhas:[3]}]}),ledger);
 assert.deepEqual(r.ledger.duplicates,[]);assert.equal(r.verified,true);
});
test('prompt exige débito efetivo, comparação com original e cashback fora de receita',()=>{
 assert.match(prompt(['Outros'],[],{},true),/COMP[A]?RE A PÁGINA ORIGINAL/);assert.match(prompt([],[],{},false),/MOEDA EFETIVAMENTE DEBITADA/);assert.match(prompt([],[],{},true),/nunca é receita/);
});

const imageLedger={lines:[],moneyLines:[],text:'',pdf:false};
test('débito identificado vence valor local sem converter ou subtrair cashback',()=>{
 const r=normalize(raw({itens:[row({valor:43,moeda:'BRL',linhas:[],cobranca:{valor:8.78,moeda:'USD',origem:'usd_abaixo_local'},cashback:{valor:0.08,moeda:''}})],excluidos:[]}),imageLedger);
 assert.equal(r.itens[0].valor,8.78);assert.equal(r.itens[0].moeda,'USD');assert.deepEqual(r.itens[0].cashback,{valor:0.08,moeda:'USD'});assert.equal(canFinishQuick(r),true);
});
test('USDC é preservado no depósito e moeda incerta não usa o valor local',()=>{
 const r=normalize(raw({itens:[row({tipo:'receita',valor:241.16,moeda:'BRL',linhas:[],cobranca:{valor:241.16,moeda:'USDC',origem:'debito_explicito'}}),row({valor:43,moeda:'BRL',linhas:[],cobranca:{valor:null,moeda:'',origem:'incerta'}})],excluidos:[]}),imageLedger);
 assert.equal(r.itens[0].moeda,'USDC');assert.equal(r.itens[1].valor,null);assert.equal(r.itens[1].invalid,true);assert.equal(canFinishQuick(r),false);
});
test('leitura rápida exige poucos itens, datas reais, moeda legível e contagem compatível',()=>{
 const r=normalize(raw({itens:[row({linhas:[]})],excluidos:[]}),imageLedger);
 assert.equal(canFinishQuick(r),true);
 for(const edit of [{itens:Array(11).fill(r.itens[0])},{itens:[{...r.itens[0],data:'2026-02-31'}]},{expectedCount:2},{verified:false},{itens:[]},{excluded:[{motivo:'outro'}]}])assert.equal(canFinishQuick({...r,...edit}),false);
});
test('modo rápido usa low e uma chamada; segunda leitura sempre usa medium',async(t)=>{
 const requests=[];t.mock.method(global,'fetch',async(url,init)=>{requests.push(JSON.parse(init.body));return {ok:true,json:async()=>({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(raw({itens:[row({linhas:[]})],excluidos:[]}))}]}]})};});
 const args={image:{media_type:'image/png',data:'YWJj'},categories:['Outros'],cards:[],context:{pageStart:1,pageEnd:1,totalPages:1},mode:'quick'};
 const first=await readPage(args,'test-only');assert.equal(first.reviewMode,'automatic');assert.equal(requests.length,1);assert.equal(requests[0].model,FAST_MODEL);assert.equal(requests[0].reasoning.effort,'low');assert.equal(requests[0].store,false);
 const second=await readPage({...args,first},'test-only');assert.equal(second.reviewMode,'compared');assert.equal(requests[1].reasoning.effort,'medium');
});
