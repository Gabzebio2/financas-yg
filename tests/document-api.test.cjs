const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function setup(){
 const calls=[];const context={module:{exports:{}},require:()=>({readPage:async(value,key)=>{calls.push({value,key});return {itens:[]};}}),process:{env:{OPENAI_API_KEY:'server-test-secret'}},AbortSignal,fetch:async(url,init)=>{calls.push({url,init});return {ok:true};}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../api/receipt-document.js'),'utf8'),context);
 const invoke=async(body,headers={authorization:'Bearer test-session'},method='POST')=>{let code,data;const res={setHeader(){},status(n){code=n;return this;},json(v){data=v;return this;}};await context.module.exports({body,headers,method},res);return {code,data};};
 return {context,calls,invoke};
}
const input=()=>({image:{media_type:'image/png',data:'YWJj'},documentContext:{pageStart:1,pageEnd:1,totalPages:1},categories:['Outros'],cards:['Ueno']});
test('endpoint recusa pedido anônimo sem chamar IA ou autenticação',async()=>{const e=setup();assert.equal((await e.invoke(input(),{})).code,401);assert.equal(e.calls.length,0);});
test('sessão inválida nunca chega ao leitor',async()=>{const e=setup();e.context.fetch=async()=>({ok:false,status:401});assert.equal((await e.invoke(input())).code,401);assert.equal(e.calls.length,0);});
test('página fracionária, ausente, excessiva ou com intervalo não consome IA',async()=>{for(const c of [{pageStart:1,pageEnd:1},{pageStart:1,pageEnd:1,totalPages:'1'},{pageStart:1,pageEnd:2,totalPages:2},{pageStart:1,pageEnd:1,totalPages:121}]){const e=setup();assert.equal((await e.invoke({...input(),documentContext:c})).code,400);assert.equal(e.calls.length,1);}});
test('sessão vai só para Supabase; leitor recebe chave do servidor e contexto limitado',async()=>{const e=setup(),body=input();body.documentContext.instruction='untrusted';assert.equal((await e.invoke(body)).code,200);assert.match(e.calls[0].url,/supabase.co\/auth\/v1\/user$/);assert.equal(e.calls[1].key,'server-test-secret');assert.equal(e.calls[1].value.context.instruction,undefined);assert.equal(e.calls[1].value.token,undefined);});
test('erro interno não expõe detalhes do provedor',async()=>{const e=setup();e.context.fetch=async()=>{throw Error('secret-value');};const r=await e.invoke(input());assert.equal(r.code,502);assert(!JSON.stringify(r).includes('secret-value'));});
