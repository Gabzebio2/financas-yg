const test=require('node:test'),assert=require('node:assert/strict');
const {headingDate,visualReading,checkFirstRows,imageContext}=require('../server/image-groups.cjs');
const {readPage}=require('../server/document-reader.cjs');
const {photoPlan}=require('../server/receipt-photo.cjs');
const context={pageStart:1,pageEnd:1,totalPages:1};
const printed='Hoy, 3 de noviembre del 2026';
const h=(texto,y)=>({texto,y});
const row=(desc,valor,y,extra={})=>({data:'',descricao:desc,valor,moeda:'PYG',tipo:'despesa',origemData:'grupo',posicaoValor:y,
  categoria:'Outros',instituicao:'Itaú',referencia:'',evidencia:'',linhas:[],parcela:'',cashback:{valor:null,moeda:''},incertezas:['Data não visível.'],...extra});
const raw=(itens,heads,meta={})=>({cartao:'Itaú',itens,excluidos:[],contagemOperacoes:null,avisos:[],completo:true,
  leituraVisual:{layout:'lista',cabecalhos:heads,movimentosVisiveis:itens.length,ultimaDescricao:itens.at(-1)?.descricao||'',...meta}});
test('a data impressa vale até o próximo grupo; a última saída SPI é incluída como data observada',async t=>{
  const amounts=[85000,490000,150000,75000,1750000],rows=amounts.map((v,i)=>row(i===4?'Transferencia enviada SPI':'Compra '+i,v,420+i*120));
  const calls=[];
  t.mock.method(global,'fetch',async(_,init)=>{
    calls.push(JSON.parse(init.body));const data=raw(calls.length===1?rows.slice(0,4):rows,[h(printed,320)],{movimentosVisiveis:5,ultimaDescricao:rows[4].descricao});
    return {ok:true,json:async()=>({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(data)}]}]})};
  });
  const args={image:{media_type:'image/jpeg',data:'synthetic'},context,categories:['Outros'],cards:['Itaú'],mode:'quick'};
  const first=await readPage(args,'test');assert.equal(first.reviewMode,'pending');assert(first.partial);
  const second=await readPage({...args,first},'test');assert.equal(second.reviewMode,'compared');assert(second.verified);
  const entries=photoPlan(second,context,['Outros']).entries;
  assert.deepEqual(entries.map(e=>e.tx.amount),amounts);assert(entries.every(e=>e.tx.date==='2026-11-03'&&!e.tx.dateEstimated&&e.tx.type==='despesa'&&e.tx.currency==='PYG'));
  assert.deepEqual(calls.map(c=>c.model),['gpt-6-luna','gpt-6.1-terra']);
});
test('troca silenciosa de uma linha intermediária por outra não passa mesmo se a contagem for igual',()=>{
  const first={itens:['A','B','SPI'].map(s=>row(s,3,300))};
  const second={itens:['A','C','SPI'].map(s=>row(s,3,300)),excluded:[]};
  assert(checkFirstRows(first,second,[]));
  assert.equal(checkFirstRows(first,second,[{descricaoAnterior:'B',destino:'corrigida',descricaoFinal:'C',evidencia:'Linha original: C'}]),'');
  assert(checkFirstRows({itens:[row('A',1,10),row('A',1,300)]},{itens:[row('A',1,10)],excluded:[]},[]));
});
test('grupos diferentes, data própria e cabeçalho sem ano não herdam uma data vizinha incorreta',()=>{
  assert.equal(headingDate('Ayer, 30 de octubre del 2026'),'2026-10-30');assert.equal(headingDate('3 de novembro de 2026'),'2026-11-03');
  assert.equal(headingDate('Hoy'),'');assert.equal(headingDate('31/02/2026'),'');
  const x=visualReading(raw([row('A',1,100),row('B',2,330),row('C',3,450,{origemData:'linha',data:'2026-10-27',incertezas:[]}),row('D',4,980)],
    [h('03/11/2026',20),h('02/11/2026',300),h('Ayer',500)]),context,null);
  assert.deepEqual(x.raw.itens.map(r=>r.data),['2026-11-03','2026-11-02','2026-10-27','']);
  assert(x.raw.itens[3].grupoSemData);
  const p=photoPlan({...x.raw,coverage:{complete:true}},context,['Outros']);assert(!p.entries[3].tx);
});
test('faixas sobrepostas têm um único dono; dois valores iguais em linhas distintas continuam distintos',()=>{
  const first={pageStart:1,pageEnd:1,totalPages:2,imageSlice:{height:2000,before:0,after:60}};
  const second={pageStart:2,pageEnd:2,totalPages:2,imageSlice:{height:2000,before:60,after:0}};
  const a=visualReading(raw([row('Iguais',20,955),row('Iguais',20,985)],[h(printed,40)]),first,null);
  const b=visualReading(raw([row('Iguais',20,15),row('Iguais',20,45),row('SPI',50,950)],[]),second,a.visualContext.lastHeading);
  assert.equal(a.raw.itens.length,1);assert.equal(b.raw.itens.length,2);
  assert.deepEqual([...a.raw.itens,...b.raw.itens].map(x=>[x.descricao,x.data]),[['Iguais','2026-11-03'],['Iguais','2026-11-03'],['SPI','2026-11-03']]);
  assert.equal(visualReading(raw([row('A',1,250,{posicaoValor:null})],[]),second,null).audit.issues.length,1);
});
test('recorte JPEG de cliente antigo recupera a altura real da faixa e nunca inventa dimensão para arquivo inválido',()=>{
  const c={pageStart:2,pageEnd:2,totalPages:2};
  const data=Buffer.from([255,216,255,224,0,4,0,0,255,192,0,9,8,1,4,4,56,1,0,255,217]).toString('base64');
  assert.deepEqual(imageContext({media_type:'image/jpeg',data},c).imageSlice,{height:260,before:60,after:0});
  assert.equal(imageContext({media_type:'image/jpeg',data:'YmFk'},c),c);
});
