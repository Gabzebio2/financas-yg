const test = require('node:test'), assert = require('node:assert/strict');
const { accountName, sourceAccount, PLATFORMS } = require('../server/receipt-platforms.cjs');
const { readPage, FAST_MODEL } = require('../server/document-reader.cjs');
test('aliases de plataformas usam somente nomes de contas permitidas, sem buscar destinatários por substring', () => {
  for (const [name, expected] of [['etherfi','Ether.fi'], ['ether.fi','Ether.fi'], ['UENO BANK','Ueno'], ['Banco Itau Paraguay','Itaú'], ['uglycash','Ugly Cash']]) assert.equal(accountName(name), expected);
  assert.equal(accountName('ether.fi Gabriel'), '');
  assert.equal(accountName('Ueno', ['C6']), '');
  assert.equal(accountName('Outro banco'), '');
  assert.equal(sourceAccount('', 'Nubank Gab', ['Nubank Gab']), 'Nubank Gab');
});
test('conta identificada no documento prevalece sobre contraparte; consolidado preserva as origens individuais', () => {
  assert.equal(sourceAccount('Ugly Cash', 'Ether.fi'), 'Ugly Cash');
  assert.equal(sourceAccount('Ugly Cash', 'ether.fi Gabriel'), 'Ugly Cash');
  assert.equal(sourceAccount('', 'Ueno Bank'), 'Ueno');
  assert.equal(sourceAccount('', 'Itaú'), 'Itaú');
  assert.equal(sourceAccount('', ''), '');
});
test('leitura rápida e segunda etapa usam referências visuais e normalizam cada linha sem alterar finanças', async t => {
  const calls = [];
  let bank = 'uglycash';
  const row = {data:'2026-10-30',descricao:'Retiro a USDC',valor:125,moeda:'USDC',tipo:'despesa',categoria:'Outros',parcela:'',instituicao:'Ether.fi',referencia:'',evidencia:'Retiro a USDC',incertezas:[],linhas:[],cashback:{valor:null,moeda:''}};
  t.mock.method(global, 'fetch', async (_, init) => {
    calls.push(JSON.parse(init.body));
    return {ok:true,json:async()=>({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({cartao:bank,itens:[row,{...row}],excluidos:[],contagemOperacoes:null,avisos:[],completo:true})}]}]})};
  });
  const args = {image:{media_type:'image/png',data:'fake'},categories:['Outros'],cards:PLATFORMS,context:{pageStart:1,pageEnd:1,totalPages:1},mode:'quick'};
  const first = await readPage(args,'synthetic-key');
  assert.equal(calls.length,1); assert.equal(calls[0].model,FAST_MODEL);
  assert.equal(first.cartao,'Ugly Cash'); assert.equal(first.reviewMode,'automatic');
  assert.deepEqual(first.itens.map(r=>[r.instituicao,r.valor,r.moeda]),[['Ugly Cash',125,'USDC'],['Ugly Cash',125,'USDC']]);
  bank = 'Banco Itau';
  const second = await readPage({...args,first},'synthetic-key');
  assert.equal(second.itens.length,2); assert(second.itens.every(r=>r.instituicao==='Itaú'));
  for(const call of calls) for(const text of ['Ether.fi','Ueno','Itaú','Ugly Cash','CONTRAPARTE','MOVIMIENTOS','Actividad']) assert(call.instructions.includes(text));
  assert.equal(second.reviewMode,'compared');
});
