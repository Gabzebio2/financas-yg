import {createBackend,sameSecret,verifyWake} from './core.mjs';
const service=JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')||'{}').default||Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const pub=JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS')||'{}').default||Deno.env.get('SUPABASE_ANON_KEY');
const backend=createBackend({url:Deno.env.get('SUPABASE_URL'),serviceKey:service,publicKey:pub});
Deno.serve(async req=>{
 const origin=req.headers.get('origin');
 const allowed=['https://financas-yg.vercel.app','http://127.0.0.1:8766','http://localhost:8766'];
 const headers={'Content-Type':'application/json','Cache-Control':'no-store','Vary':'Origin',...(allowed.includes(origin||'')?{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'authorization, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS'}:{})};
 const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers});
 if(origin&&!allowed.includes(origin))return reply({error:'origin'},403);
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers});
 if(req.method!=='POST')return reply({error:'method'},405);
 try{
  if(Number(req.headers.get('content-length'))>8500000)return reply({error:'payload_too_large'},413);
  const raw=await req.text();if(raw.length>8500000)return reply({error:'payload_too_large'},413);
  const body=JSON.parse(raw);
  if(body.action==='work'){
   const workerToken=await backend.workerToken();
   if(!workerToken||!(await sameSecret(req.headers.get('authorization')||'','Bearer '+workerToken)||await verifyWake(req.headers.get('x-receipt-wake'),workerToken)))return reply({error:'unauthorized'},401);
   EdgeRuntime.waitUntil(backend.work().catch(()=>console.warn('receipt_worker_retry')));
   return reply({accepted:true},202);
  }
  const user=await backend.authenticate(req);
  const result=await backend.userAction(user,body);
  if(['submit','retry'].includes(body.action))EdgeRuntime.waitUntil(backend.wake().catch(()=>console.warn('receipt_wake_retry')));
  return reply(result);
 }catch(e){
  const exposed=['login_required','folder_not_linked','active_job_limit','job_not_found','job_not_ready','retry_unavailable','upload_incomplete','job_too_large','invalid_transaction','invalid_transactions','upload_failed','upload_closed','invalid_page','invalid_job','invalid_action'];
  const error=exposed.includes(e.message)?e.message:'service_unavailable';
  return reply({error},error==='login_required'?401:error==='job_not_found'?404:error==='service_unavailable'?503:400);
 }
});
