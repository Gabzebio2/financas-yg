const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const core=()=>import('../supabase/functions/receipt-jobs/core.mjs');
const user='10000000-0000-4000-8000-000000000001',id='20000000-0000-4000-8000-000000000001';
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
test('cron wake signatures are scoped, expire and never expose the reusable worker secret',async()=>{
 const {verifyWake}=await core(),secret='private-secret',stamp=String(Math.floor(Date.now()/1000)),nonce=crypto.randomUUID();
 const signature=crypto.createHmac('sha256',secret).update('receipt-wake.'+stamp+'.'+nonce).digest('hex'),value=stamp+'.'+nonce+'.'+signature;
 assert(await verifyWake(value,secret));assert(!value.includes(secret));
 assert(!await verifyWake(value,'wrong'));assert(!await verifyWake(value,secret,'other-scope'));assert(!await verifyWake(value,secret,'receipt-wake',Date.now()+120000));assert(!await verifyWake(value+'.extra',secret));assert(!await verifyWake(value,''));
});
test('background transactions preserve the debit and cashback without counting rewards as income',async()=>{
 const {cleanTransactions}=await core();const got=cleanTransactions([{date:'2026-10-24',desc:'Compra',amount:8.78,type:'despesa',currency:'USD',cashback:{amount:.08,currency:'USD'},id:'forged',user_id:'other',unexpected:'remove'}]);
 assert.equal(got.length,1);assert.equal(got[0].amount,8.78);assert.equal(got[0].currency,'USD');assert.deepEqual(got[0].cashback,{amount:.08,currency:'USD'});assert.equal(got[0].id,undefined);assert.equal(got[0].user_id,undefined);
 for(const change of [{amount:0},{amount:NaN},{date:'2026-02-30'},{currency:'FAKE'},{type:'cashback'}])assert.throws(()=>cleanTransactions([{...got[0],...change}]));
});
test('owner filter is required before get, commit, upload and retry; expired drafts unavailable',async()=>{
 const {createBackend}=await core();
 for(const action of ['get','commit','upload','retry','discard']){
  const calls=[];const b=createBackend({url:'https://db.test',serviceKey:'private',publicKey:'public',fetcher:async(url)=>{calls.push(url);return json([]);}});
  await assert.rejects(b.userAction(user,{action,id}),/job_not_found/);assert.equal(calls.length,1);assert(calls[0].includes('user_id=eq.'+user));assert(calls[0].includes('expires_at=gt.'));
 }
});

test('excluir resultado pronto revoga acesso antes de apagar somente os arquivos daquele envio',async()=>{
 const {createBackend}=await core();
 for(const status of ['ready','committed']){
  const calls=[];const b=createBackend({url:'https://db.test',serviceKey:'private',publicKey:'public',fetcher:async(url,opt={})=>{
   calls.push({url,opt});if(opt.method==='PATCH'){assert(url.includes('user_id=eq.'+user));assert(url.includes('status=eq.'+status));assert(url.includes('expires_at=gt.'));assert(Date.parse(JSON.parse(opt.body).expires_at)<=Date.now());return json([{id}]);}
   if(url.includes('receipt_job_pages'))return json([{object_path:user+'/'+id+'/0'}]);
   if(opt.method==='DELETE')return json([]);return json([{id,status}]);
  }});
  assert.deepEqual(await b.userAction(user,{action:'discard',id}),{discarded:true});
  const mutations=calls.filter(c=>c.opt.method);assert.deepEqual(mutations.map(c=>c.opt.method),['PATCH','DELETE','DELETE']);
  assert(mutations[1].url.includes('/storage/v1/'));assert.deepEqual(JSON.parse(mutations[1].opt.body).prefixes,[user+'/'+id+'/0']);assert(mutations[2].url.includes('expires_at=lte.'));
  assert(!calls.some(c=>/pastas|receipt_commit/.test(c.url)));
 }
});

test('mudança concorrente de status impede exclusão; falha do Storage fica para limpeza posterior',async()=>{
 const {createBackend}=await core();
 for(const conflict of [true,false]){
  const calls=[];const b=createBackend({url:'https://db.test',serviceKey:'private',publicKey:'public',fetcher:async(url,opt={})=>{
   calls.push({url,opt});if(opt.method==='PATCH')return json(conflict?[]:[{id}]);if(url.includes('receipt_job_pages'))return json([{object_path:'owner/job/file'}]);if(url.includes('/storage/'))return json({},503);return json([{id,status:'ready'}]);
  }});
  if(conflict){await assert.rejects(b.userAction(user,{action:'discard',id}),/job_not_ready/);assert(!calls.some(c=>c.opt.method==='DELETE'));}
  else {assert.deepEqual(await b.userAction(user,{action:'discard',id}),{discarded:true});assert(!calls.some(c=>c.opt.method==='DELETE'&&c.url.includes('/rest/')));}
 }
});
test('worker only stores drafts; it never calls the financial commit or writes pastas',async()=>{
 const {createBackend,digest}=await core(),bytes=new TextEncoder().encode('image');
 const p={job_id:id,page_index:0,object_path:user+'/'+id+'/0',byte_size:bytes.length,sha256:await digest(bytes),media_type:'image/png',context:{pageStart:1,pageEnd:1,totalPages:1},first_result:null,quick:true,lease_token:id};
 const calls=[];const result={itens:[],ledger:{missing:[]}};
 const b=createBackend({url:'https://db.test',serviceKey:'private',publicKey:'public',fetcher:async(url,opt={})=>{
  calls.push({url,opt});if(url.includes('expires_at=lte.'))return json([]);if(url.endsWith('/receipt_claim'))return json({page:p,categories:[],cards:[]});if(url.includes('/storage/v1/object/'))return new Response(bytes);if(url.includes('receipt_worker_config'))return json([{token:'scoped'}]);if(url.endsWith('/api/receipt-worker'))return json(result);return json(true);
 }});
 await b.work();assert(!calls.some(c=>/pastas|receipt_commit/.test(c.url)));
 const ai=calls.find(c=>c.url.endsWith('/api/receipt-worker'));assert.equal(ai.opt.headers.Authorization,'Bearer scoped');assert(!JSON.stringify(ai).includes('private'));
 const finish=calls.find(c=>c.url.endsWith('/receipt_finish'));assert.deepEqual(JSON.parse(finish.opt.body).p_result,result);assert.equal(JSON.parse(finish.opt.body).p_lease,id);
});
test('worker failure records retryable error and never reports success',async()=>{
 const {createBackend,digest}=await core(),bytes=new TextEncoder().encode('image'),calls=[];
 const b=createBackend({url:'https://db.test',serviceKey:'private',publicKey:'public',fetcher:async(url,opt={})=>{
  calls.push({url,opt});if(url.includes('expires_at=lte.'))return json([]);if(url.endsWith('/receipt_claim'))return json({page:{job_id:id,page_index:0,object_path:'file',byte_size:bytes.length,sha256:await digest(bytes),media_type:'image/png',lease_token:id},categories:[],cards:[]});if(url.includes('/storage/'))return new Response(bytes);if(url.includes('receipt_worker_config'))return json([{token:'scoped'}]);if(url.endsWith('/receipt-worker'))return json({error:'saldo_ia'},502);return json(true);
 }});
 await b.work();const finish=JSON.parse(calls.find(c=>c.url.endsWith('/receipt_finish')).opt.body);assert.equal(finish.p_error,'saldo_ia');assert.equal(finish.p_result,undefined);
});
test('cleanup removes actual Storage blobs before removing draft rows, and retries failures',async()=>{
 const {createBackend}=await core();
 for(const fail of [false,true]){
  const calls=[];const b=createBackend({url:'https://db.test',serviceKey:'private',publicKey:'public',fetcher:async(url,opt={})=>{
   calls.push({url,opt});if(url.includes('receipt_job_pages'))return json([{object_path:'owner/job/0'}]);if(opt.method==='DELETE')return fail&&url.includes('/storage/')?json({},503):json([]);return json([{id}]);
  }});
  if(fail)await assert.rejects(b.cleanup());else await b.cleanup();
  const deletes=calls.filter(c=>c.opt.method==='DELETE');assert.equal(deletes.length,fail?1:2);assert(deletes[0].url.includes('/storage/v1/object/'));assert.deepEqual(JSON.parse(deletes[0].opt.body),{prefixes:['owner/job/0']});
 }
});
test('worker endpoint refuses user tokens and missing configuration before any AI work',async()=>{
 const calls=[],env={RECEIPT_WORKER_SECRET:'scoped-test-secret',OPENAI_API_KEY:'openai-test-secret'};
 const ctx={module:{exports:{}},process:{env},Buffer,require:name=>name==='node:crypto'?crypto:{readPage:async(v)=>{calls.push(v);return {itens:[]};}}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../api/receipt-worker.js'),'utf8'),ctx);
 async function invoke(auth,body={}){let status;await ctx.module.exports({method:'POST',headers:{authorization:auth},body},{setHeader(){},status(n){status=n;return this;},json(){}});return status;}
 for(const token of [undefined,'Bearer user-jwt','Bearer undefined'])assert.equal(await invoke(token),401);
 assert.equal(calls.length,0);
 assert.equal(await invoke('Bearer scoped-test-secret',{image:{media_type:'image/png',data:'YWJj'},documentContext:{pageStart:1,pageEnd:1,totalPages:1},mode:'quick'}),200);assert.equal(calls[0].timeoutMs,105000);
 delete env.RECEIPT_WORKER_SECRET;assert.equal(await invoke('Bearer undefined'),401);
});

test('cabeçalho da continuação fica restrito ao mesmo arquivo/tarefa e é verificado pelo hash',async()=>{
 const {createBackend,digest}=await core(),bytes=new TextEncoder().encode('second-page'),head=new TextEncoder().encode('first-page');
 for(const badHash of [false,true]){
  const calls=[],p={job_id:id,document_id:'bank-file',page_index:4,object_path:'second',byte_size:bytes.length,sha256:await digest(bytes),media_type:'application/pdf',context:{pageStart:2,pageEnd:2,totalPages:2},lease_token:id};
  const b=createBackend({url:'https://db.test',serviceKey:'private',publicKey:'public',fetcher:async(url,opt={})=>{
   calls.push({url,opt});if(url.includes('expires_at=lte.'))return json([]);if(url.endsWith('/receipt_claim'))return json({page:p,categories:[],cards:[]});if(url.endsWith('/second'))return new Response(bytes);if(url.endsWith('/first'))return new Response(head);if(url.includes('receipt_worker_config'))return json([{token:'scoped'}]);
   if(url.includes('receipt_job_pages?')){assert(url.includes('job_id=eq.'+id));assert(url.includes('document_id=eq.bank-file'));assert(url.includes('order=page_index.asc&limit=1'));return json([{object_path:'first',byte_size:head.length,sha256:badHash?'wrong':await digest(head),media_type:'application/pdf',context:{pageStart:1}}]);}
   return json({itens:[]});
  }});
  await b.work();const ai=calls.find(c=>c.url.endsWith('/api/receipt-worker')),finish=JSON.parse(calls.find(c=>c.url.endsWith('/receipt_finish')).opt.body);
  if(badHash){assert.equal(ai,undefined);assert.equal(finish.p_error,'arquivo_invalido');}else assert.equal(JSON.parse(ai.opt.body).sourceHeader,Buffer.from(head).toString('base64'));
  assert(!calls.some(c=>/pastas|receipt_commit/.test(c.url)));
 }
});
