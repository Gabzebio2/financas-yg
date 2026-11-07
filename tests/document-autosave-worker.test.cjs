const test=require('node:test'),assert=require('node:assert/strict');
test('worker finishes an opted-in PDF without a browser, against the folder version it actually read',async()=>{
 const {createBackend}=await import('../supabase/functions/receipt-jobs/core.mjs');
 const job={id:'bbbbbbbb-0000-4000-a000-000000000002',user_id:'aaaaaaaa-0000-4000-a000-000000000001',folder_id:'folder',categories:['Mercado']};
 const version='2026-11-06T12:01:02Z',calls=[];
 const item=(desc,amount)=>({data:'2026-08-03',descricao:desc,valor:amount,moeda:'BRL',tipo:'despesa',instituicao:'C6',categoria:'Mercado',evidencia:desc+' '+amount,revisar:[]});
 const ps=[{document_id:'d',label:'Extrato',media_type:'application/pdf',context:{pageStart:1,totalPages:1},
   result:{itens:[item('Já lançado',10),item('Novo',15)],excluded:[],avisos:[],cartao:'C6',reviewMode:'compared',partial:false,verified:true,
     coverage:{complete:true,pagesRead:[1],unreadablePages:[]},ledger:{monetaryLines:2,accounted:2,duplicates:[],missing:[]}}}];
 const prior={id:'original',date:'2026-08-03',desc:'Já lançado',account:'C6',amount:10,currency:'BRL',type:'despesa'};
 const backend=createBackend({url:'https://db.invalid',serviceKey:'test',publicKey:'test',fetcher:async(raw,opt={})=>{
   const u=new URL(raw);calls.push({path:u.pathname,body:opt.body});
   if(u.pathname.endsWith('/receipt_claim_auto_document'))return Response.json(job);
   if(u.pathname.endsWith('/receipt_claim'))return Response.json(null);
   if(u.pathname.endsWith('/receipt_jobs'))return Response.json([]);
   if(u.pathname.endsWith('/receipt_job_pages')){assert.equal(u.searchParams.get('job_id'),'eq.'+job.id);return Response.json(ps);}
   if(u.pathname.endsWith('/pastas')){assert.equal(u.searchParams.get('user_id'),'eq.'+job.user_id);assert.equal(u.searchParams.get('id'),'eq.'+job.folder_id);return Response.json([{updated_at:version,data:{transactions:[prior]}}]);}
   if(u.pathname.endsWith('/receipt_finish_auto_document'))return Response.json('committed');
   return Response.json([]);
 }});
 await backend.work();
 const result=JSON.parse(calls.find(c=>c.path.endsWith('/receipt_finish_auto_document')).body);
 assert.equal(result.p_version,version);assert.equal(result.p_job,job.id);assert.equal(result.p_user,job.user_id);
 assert.deepEqual(result.p_txs.map(t=>t.desc),['Novo']);assert.equal(result.p_notice.duplicates,1);
 assert.equal(calls.some(c=>c.path.endsWith('/receipt_commit')),false);
});
