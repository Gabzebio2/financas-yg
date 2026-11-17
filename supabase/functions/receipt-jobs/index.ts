import {createBackend,readJobRequest,sameSecret,verifyWake} from './core.mjs';
const service=JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')||'{}').default||Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const pub=JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS')||'{}').default||Deno.env.get('SUPABASE_ANON_KEY');
const backend=createBackend({url:Deno.env.get('SUPABASE_URL'),serviceKey:service,publicKey:pub});
Deno.serve(async req=>{
 const origin=req.headers.get('origin');
 const allowed=['https://financas-yg.vercel.app','http://127.0.0.1:8766','http://localhost:8766'];
 const headers={'Content-Type':'application/json','Cache-Control':'no-store','Vary':'Origin',...(allowed.includes(origin||'')?{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'authorization, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS'}:{})};
 const reply=(data,status=200,extra={})=>new Response(JSON.stringify(data),{status,headers:{...headers,...extra}});
 if(origin&&!allowed.includes(origin))return reply({error:'origin'},403);
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers});
 if(req.method!=='POST')return reply({error:'method'},405);
 if(!req.headers.get('authorization')?.startsWith('Bearer ')&&!req.headers.has('x-receipt-wake'))return reply({error:'login_required'},401);
 try{
  const body=await readJobRequest(req);
  if(body.action==='work'){
   const workerToken=await backend.workerToken();
   if(!workerToken||!(await sameSecret(req.headers.get('authorization')||'','Bearer '+workerToken)||await verifyWake(req.headers.get('x-receipt-wake'),workerToken)))return reply({error:'unauthorized'},401);
   EdgeRuntime.waitUntil(backend.work().catch(()=>console.warn('receipt_worker_retry')));
   return reply({accepted:true},202);
  }
  const user=await backend.authenticate(req);
  const result=await backend.userAction(user,body);
  if(body.action==='retry'||(result.status==='queued' && ['upload','submit'].includes(body.action)))EdgeRuntime.waitUntil(backend.wake().catch(()=>console.warn('receipt_wake_retry')));
  return reply(result);
 }catch(e){
  if(e.message==='receipt_daily_limit'){
   const dayMs=86400000;
   const retryAfter=Math.ceil((dayMs-Date.now()%dayMs)/1000);
   return reply({error:'receipt_daily_limit',retryAfter},429,{'Retry-After':String(retryAfter)});
  }
  if(e.message==='payload_too_large')return reply({error:'payload_too_large'},413);
  if(e.message==='invalid_request')return reply({error:'invalid_request'},400);
  const exposed=['login_required','folder_not_linked','active_job_limit','job_not_found','job_not_ready','retry_unavailable','upload_incomplete','job_too_large','invalid_transaction','invalid_transactions','upload_failed','upload_closed','invalid_page','invalid_job','invalid_action','c6_statement_incomplete','c6_series_changed','automatic_in_progress'];
  const error=exposed.includes(e.message)?e.message:'service_unavailable';
  return reply({error},error==='login_required'?401:error==='job_not_found'?404:error==='service_unavailable'?503:400);
 }
});
