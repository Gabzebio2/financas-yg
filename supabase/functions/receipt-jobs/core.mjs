import {checkC6Subtotals} from './c6-subtotals.mjs';
import {planDocumentImport} from './document-plan.mjs';
export const BUCKET='receipt-documents';
export const CURRENCIES=['BRL','PYG','CLP','USD','EUR','GBP','USDT','USDC'];
export const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v);
export const names=v=>Array.isArray(v)?v.filter(x=>typeof x==='string'&&x.trim()).slice(0,40).map(x=>x.slice(0,80)):[];
export async function digest(bytes){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');}
export async function sameSecret(a,b){if(!a||!b)return false;return await digest(new TextEncoder().encode(a))===await digest(new TextEncoder().encode(b));}
export async function verifyWake(value,secret,scope='receipt-wake',now=Date.now()){
 if(!secret||typeof value!=='string')return false;
 const [stamp,nonce,signature,...extra]=value.split('.');
 if(extra.length||!/^\d{10}$/.test(stamp)||!uuid(nonce)||!/^[a-f0-9]{64}$/.test(signature)||Math.abs(now/1000-Number(stamp))>60)return false;
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
 return crypto.subtle.verify('HMAC',key,Uint8Array.from(signature.match(/../g),s=>parseInt(s,16)),new TextEncoder().encode(scope+'.'+stamp+'.'+nonce));
}
export function bytesToBase64(bytes){let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s);}
export function cleanTransactions(txs){
 if(!Array.isArray(txs)||!txs.length||txs.length>10000)throw Error('invalid_transactions');
 return txs.map(t=>{
  if(!t||typeof t.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(t.date)||Number.isNaN(Date.parse(t.date))||new Date(t.date).toISOString().slice(0,10)!==t.date||!Number.isFinite(t.amount)||t.amount<=0||t.amount>Number.MAX_SAFE_INTEGER||!CURRENCIES.includes(t.currency)||!['receita','despesa'].includes(t.type)||typeof t.desc!=='string'||!t.desc.trim())throw Error('invalid_transaction');
  const out={date:t.date,desc:t.desc.trim().slice(0,1000),amount:t.amount,currency:t.currency,type:t.type,category:String(t.category||'Outros').slice(0,80),account:String(t.account||'').slice(0,100),groupId:t.groupId?String(t.groupId).slice(0,160):null,fixed:t.fixed===true,installment:typeof t.installment==='string'&&/^\d{1,3}\/\d{1,3}$/.test(t.installment)?t.installment:null,totalValue:Number.isFinite(t.totalValue)&&t.totalValue>0?t.totalValue:null};
  if(t.cashback&&Number.isFinite(t.cashback.amount)&&t.cashback.amount>0&&CURRENCIES.includes(t.cashback.currency))out.cashback={amount:t.cashback.amount,currency:t.cashback.currency};
  for(const k of ['referenceId','sourceEvidence'])if(typeof t[k]==='string')out[k]=t[k].slice(0,2000);
  if(Number.isInteger(t.sourcePage)&&t.sourcePage>0&&t.sourcePage<=120)out.sourcePage=t.sourcePage;
  for(const key of ['billDueDate','billClosingDate']) {
   const date=t[key];
   if(typeof date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(date)&&Number.isFinite(Date.parse(date))&&new Date(date).toISOString().slice(0,10)===date)out[key]=date;
  }
  if(out.billDueDate)out.billDateObserved=t.billDateObserved===true;
  if(out.billDateObserved && Number.isInteger(t.cardBestPurchaseDay) && t.cardBestPurchaseDay>=1 && t.cardBestPurchaseDay<=31)out.cardBestPurchaseDay=t.cardBestPurchaseDay;
  if(t.creditKind==='card_payment' && t.type==='receita')out.creditKind=t.creditKind;
  if (t.seriesKey != null || t.purchaseDate != null) {
   const key=t.seriesKey, date=t.purchaseDate, parts=(out.installment || '').split('/').map(Number);
   if (typeof key!=='string' || !key.startsWith('c6:v1:') || key.length>2000 || !parts[0] || parts[0]>parts[1] ||
       typeof date!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10)!==date) throw Error('invalid_transaction');
   out.seriesKey=key;
   out.purchaseDate=date;
   if (t.groupId===key) out.groupId=null;
  }
  if(t.dateEstimated===true&&t.dateEstimate&&typeof t.dateEstimate==='object'){out.dateEstimated=true;out.dateEstimate=JSON.parse(JSON.stringify(t.dateEstimate).slice(0,2000));}
  return out;
 });
}
export function createBackend({url,serviceKey,publicKey,fetcher=fetch}){
 const adminHeaders={apikey:serviceKey,Authorization:'Bearer '+serviceKey};
 async function admin(path,options={}){
  const r=await fetcher(url+path,{...options,headers:{...adminHeaders,...options.headers},redirect:'error',signal:options.signal||AbortSignal.timeout(20000)});
  if(!r.ok){const e=await r.json().catch(()=>({}));const allowed=['folder_not_linked','active_job_limit','job_not_found','job_not_ready','invalid_transaction','retry_unavailable','upload_incomplete','job_too_large','c6_series_changed','c6_coverage_mismatch'];throw Error(allowed.includes(e.message)?e.message:'storage_unavailable');}
  if(r.status===204)return null;return r.json();
 }
 const rpc=(name,args={})=>admin('/rest/v1/rpc/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args)});
 const patch=(table,filter,body)=>admin('/rest/v1/'+table+'?'+filter,{method:'PATCH',headers:{'Content-Type':'application/json',Prefer:'return=representation'},body:JSON.stringify(body)});
 async function authenticate(req){
  const token=req.headers.get('authorization');if(!token?.startsWith('Bearer '))throw Error('login_required');
  const r=await fetcher(url+'/auth/v1/user',{headers:{apikey:publicKey,Authorization:token},signal:AbortSignal.timeout(10000),redirect:'error'});
  if(!r.ok)throw Error(r.status===401||r.status===403?'login_required':'auth_unavailable');const u=await r.json();if(!uuid(u.id))throw Error('login_required');return u.id;
 }
 async function jobFor(user,id){
  if(!uuid(id))throw Error('job_not_found');
  const rows=await admin('/rest/v1/receipt_jobs?id=eq.'+id+'&user_id=eq.'+user+'&expires_at=gt.'+encodeURIComponent(new Date().toISOString())+'&select=*');
  if(!rows.length)throw Error('job_not_found');return rows[0];
 }
 const pages=id=>admin('/rest/v1/receipt_job_pages?job_id=eq.'+id+'&order=page_index&select=*');
 async function workerToken(){const rows=await admin('/rest/v1/receipt_worker_config?id=eq.true&select=token');return rows[0]?.token;}
 async function wake(){
  const token=await workerToken();if(!token)return;
  await fetcher(url+'/functions/v1/receipt-jobs',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{"action":"work"}',signal:AbortSignal.timeout(10000),redirect:'error'});
 }
 async function removeExpiredJob(id,now){
   const paths=await admin('/rest/v1/receipt_job_pages?job_id=eq.'+id+'&select=object_path');
   // Storage API deletes the physical objects; deleting storage.objects via SQL would leak blobs.
   if(paths.length)await admin('/storage/v1/object/'+BUCKET,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({prefixes:paths.map(p=>p.object_path)})});
   await admin('/rest/v1/receipt_jobs?id=eq.'+id+'&expires_at=lte.'+now,{method:'DELETE'});
 }
 async function cleanup(){
  const now=encodeURIComponent(new Date().toISOString());
  const expired=await admin('/rest/v1/receipt_jobs?expires_at=lte.'+now+'&select=id&limit=20');
  for(const j of expired)await removeExpiredJob(j.id,now);
 }
 async function previousImageHeading(page){
   if(!page.media_type?.startsWith('image/')||!page.document_id||!(page.context?.pageStart>1))return null;
   // Fetch just the heading evidence from earlier pieces of this file in this job.
   const path='/rest/v1/receipt_job_pages?job_id=eq.'+page.job_id+'&document_id=eq.'+encodeURIComponent(page.document_id)+
     '&media_type=eq.'+encodeURIComponent(page.media_type)+'&page_index=lt.'+page.page_index+'&order=page_index.desc&select=context,checked:result->visualContext,draft:first_result->visualContext';
   const parts=await admin(path);
   let expected=page.context.pageStart-1;
   for(const part of parts){
     const evidence=part.checked??part.draft;
     if(part.context?.pageStart!==expected-- || part.context?.totalPages!==page.context.totalPages || !evidence?.complete)return null;
     if(typeof evidence.lastHeading==='string')return evidence.lastHeading.slice(0,100);
   }
   return null;
 }
 async function includeReadyDocument() {
   const job=await rpc('receipt_claim_auto_document');
   if(!job?.id)return false;
   const path='/rest/v1/pastas?user_id=eq.'+encodeURIComponent(job.user_id)+'&id=eq.'+encodeURIComponent(job.folder_id)+'&select=updated_at,data';
   const [ps,folders]=await Promise.all([pages(job.id),admin(path)]);
   if(folders.length!==1)throw Error('folder_not_linked');
   const folder=folders[0];
   if(!Array.isArray(folder.data?.transactions))throw Error('invalid_folder');
   const plan=planDocumentImport({pages:ps,existing:folder.data.transactions,categories:job.categories,
     defaultCategory:ps[0]?.context?.documentCategory});
   const eligible=[];
   let skipped=plan.skipped;
   for(const t of plan.transactions){
     try{eligible.push(cleanTransactions([t])[0]);}catch(e){if(e.message!=='invalid_transaction')throw e;skipped++;}
   }
   if(eligible.length>10000){
     skipped+=eligible.length;eligible.length=0;
     plan.blockedDocuments.push({label:'Documento',reason:'O lote excede 10.000 lançamentos. Divida o arquivo para incluir.'});
   }
   const full=plan.statements.length>0;
   const notice={duplicates:plan.duplicates,excluded:plan.excluded,skipped,blockedDocuments:plan.blockedDocuments,
     ...(full?{statements:plan.statements,sourceRefs:plan.sourceRefs,matches:plan.matches,requireFullCoverage:true}:{})};
   const reread=()=>rpc('receipt_retry_document_coverage',{p_user:job.user_id,p_job:job.id,p_version:folder.updated_at});
   if(plan.coverageError || skipped || plan.blockedDocuments.length || eligible.length!==plan.transactions.length) {
     await reread();
     return true;
   }
   try {
     await rpc('receipt_finish_auto_document',{p_user:job.user_id,p_job:job.id,p_version:folder.updated_at,
       p_txs:eligible,p_notice:notice});
   } catch(e) {
     if(!full || !['c6_coverage_mismatch','c6_series_changed'].includes(e.message))throw e;
     await reread();
   }
   return true;
 }
 async function work(){
  // A cleanup outage must not stop reading; the next cron run retries deletion.
  await cleanup().catch(()=>console.warn('receipt_cleanup_retry'));
  const applied=await includeReadyDocument().catch(()=>{console.warn('receipt_document_retry');return false;});
  const task=await rpc('receipt_claim');if(!task){if(applied)await wake();return;}
  const p=task.page;
  try{
   const r=await fetcher(url+'/storage/v1/object/'+BUCKET+'/'+p.object_path,{headers:adminHeaders,signal:AbortSignal.timeout(15000),redirect:'error'});
   if(!r.ok)throw Error('arquivo_indisponivel');
   const bytes=new Uint8Array(await r.arrayBuffer());if(bytes.length!==p.byte_size||await digest(bytes)!==p.sha256)throw Error('arquivo_invalido');
   const token=await workerToken();
   let sourceHeader;
   if(p.media_type==='application/pdf'&&p.context?.pageStart>1&&typeof p.document_id==='string'){
    // Only the first page of this exact file in this exact private job can
    // supply header context. It is parsed on the server, never imported again.
    const refs=await admin('/rest/v1/receipt_job_pages?job_id=eq.'+p.job_id+'&document_id=eq.'+encodeURIComponent(p.document_id)+'&order=page_index.asc&limit=1&select=object_path,byte_size,sha256,media_type,context');
    const ref=refs[0];
    if(ref?.context?.pageStart===1&&ref.media_type==='application/pdf'&&ref.byte_size<=196608&&ref.byte_size+p.byte_size<=3150000){
     const headerFile=await fetcher(url+'/storage/v1/object/'+BUCKET+'/'+ref.object_path,{headers:adminHeaders,signal:AbortSignal.timeout(15000),redirect:'error'});
     if(!headerFile.ok)throw Error('arquivo_indisponivel');
     const headerBytes=new Uint8Array(await headerFile.arrayBuffer());
     if(headerBytes.length!==ref.byte_size||await digest(headerBytes)!==ref.sha256)throw Error('arquivo_invalido');
     sourceHeader=bytesToBase64(headerBytes);
    }
   }
   const previousHeading=await previousImageHeading(p);
   const body=JSON.stringify({image:{media_type:p.media_type,data:bytesToBase64(bytes)},documentContext:p.context,...(sourceHeader?{sourceHeader}:{}),...(previousHeading?{previousHeading}:{}),first:p.first_result,categories:task.categories,cards:task.cards,mode:p.quick?'quick':'full'});
   if(body.length>4400000)throw Error('page_too_dense');
   const read=await fetcher('https://financas-yg.vercel.app/api/receipt-worker',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body,signal:AbortSignal.timeout(115000),redirect:'error'});
   const result=await read.json();if(!read.ok)throw Error(result.error||'leitura_indisponivel');
   await rpc('receipt_finish',{p_job:p.job_id,p_index:p.page_index,p_lease:p.lease_token,p_result:result});
  }catch(e){
   const allowed=['saldo_ia','configuracao_ia','resposta_incompleta','tempo_ia','page_too_dense','arquivo_indisponivel','arquivo_invalido'];
   await rpc('receipt_finish',{p_job:p.job_id,p_index:p.page_index,p_lease:p.lease_token,p_error:allowed.includes(e.message)?e.message:'leitura_indisponivel'});
  }
  // Stop the chain when no eligible task remains. Cron also recovers abandoned leases.
  await wake();
 }
 async function userAction(user,body){
  if(body.action==='create'){
   if(!uuid(body.id)||typeof body.folder!=='string'||body.folder.length>160||!Array.isArray(body.pages)||body.pages.length>120||!body.pages.length)throw Error('invalid_job');
   const manifest=body.pages.map(p=>{
    if(!p||!['application/pdf','image/jpeg','image/png','image/webp'].includes(p.mediaType)||!Number.isInteger(p.bytes)||p.bytes<1||p.bytes>3150000||!/^[a-f0-9]{64}$/.test(p.sha256)||typeof p.label!=='string'||typeof p.documentId!=='string'||!p.context||!Number.isInteger(p.context.pageStart)||p.context.pageStart!==p.context.pageEnd||!Number.isInteger(p.context.totalPages)||p.context.pageStart<1||p.context.pageStart>p.context.totalPages||p.context.totalPages>120)throw Error('invalid_page');
    return {...p,quick:body.pages.length<=3&&body.pages.every(x=>x.mediaType!=='application/pdf')};
   });
   const id=await rpc('receipt_create',{p_user:user,p_id:body.id,p_folder:body.folder,p_pages:manifest,p_categories:names(body.categories),p_cards:names(body.cards),p_extra:Array.isArray(body.extraRows)?body.extraRows:[]});return {id};
  }
  if(body.action==='list'){
   if(typeof body.folder!=='string'||body.folder.length>160)throw Error('invalid_job');
   return {jobs:await rpc('receipt_list',{p_user:user,p_folder:body.folder})};
  }
  const j=await jobFor(user,body.id);
  if(body.action==='discard'&&['uploading','ready','error','committed'].includes(j.status)){
   const now=new Date().toISOString();
   // Expire atomically before removing files: stale previews cannot commit.
   // If a concurrent confirmation changed the status, ask for a fresh view.
   const changed=await patch('receipt_jobs','id=eq.'+j.id+'&user_id=eq.'+user+'&status=eq.'+j.status+'&expires_at=gt.'+encodeURIComponent(now),{expires_at:now});
   if(!changed?.length)throw Error('job_not_ready');
   // Once hidden and inaccessible, storage failures are retried by cleanup.
   await removeExpiredJob(j.id,encodeURIComponent(now)).catch(()=>console.warn('receipt_cleanup_retry'));
   return {discarded:true};
  }
  if(body.action==='get'){
   const ps=await pages(j.id);
   return {job:j,pages:ps,statementError:j.status==='ready'?checkC6Subtotals(ps):null};
  }
  if(body.action==='upload'){
   if(j.status!=='uploading')throw Error('upload_closed');
   const ps=await admin('/rest/v1/receipt_job_pages?job_id=eq.'+j.id+'&page_index=eq.'+Number(body.index)+'&select=*'),p=ps[0];
   if(!p||typeof body.data!=='string'||body.data.length>4200000||!/^[A-Za-z0-9+/]+={0,2}$/.test(body.data))throw Error('invalid_page');
   const bytes=Uint8Array.from(atob(body.data),c=>c.charCodeAt(0));if(bytes.length!==p.byte_size||await digest(bytes)!==p.sha256)throw Error('invalid_page');
   if(!p.uploaded){
    const r=await fetcher(url+'/storage/v1/object/'+BUCKET+'/'+p.object_path,{method:'POST',headers:{...adminHeaders,'Content-Type':p.media_type,'x-upsert':'false'},body:bytes,signal:AbortSignal.timeout(45000),redirect:'error'});
    if(!r.ok){
     // A retry after a lost response can find the immutable object already uploaded.
     const old=await fetcher(url+'/storage/v1/object/'+BUCKET+'/'+p.object_path,{headers:adminHeaders,signal:AbortSignal.timeout(15000)});
     if(!old.ok||await digest(new Uint8Array(await old.arrayBuffer()))!==p.sha256)throw Error('upload_failed');
    }
    try{await jobFor(user,j.id);}catch(e){await admin('/storage/v1/object/'+BUCKET,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({prefixes:[p.object_path]})});throw e;}
    await patch('receipt_job_pages','job_id=eq.'+j.id+'&page_index=eq.'+p.page_index,{uploaded:true});
   }
   return {uploaded:true};
  }
  if(body.action==='submit')return {status:await rpc('receipt_submit',{p_user:user,p_id:j.id})};
  if(body.action==='retry')return {status:await rpc('receipt_retry',{p_user:user,p_id:j.id})};
  if(body.action==='commit'){
   if(j.document_auto && j.status==='ready')throw Error('automatic_in_progress');
   if(j.status==='ready'){
    const proof=await admin('/rest/v1/receipt_job_pages?job_id=eq.'+j.id+'&order=page_index&select=document_id,context,statement:result->statementCheck,partial:result->partial,items:result->itens,excluded:result->excluded');
    const ps=proof.map(p=>({...p,result:{statementCheck:p.statement,partial:p.partial,itens:p.items||[],excluded:p.excluded}}));
    if(checkC6Subtotals(ps))throw Error('c6_statement_incomplete');
   }
   return rpc('receipt_commit',{p_user:user,p_id:j.id,p_txs:cleanTransactions(body.transactions)});
  }
  throw Error('invalid_action');
 }
 return {authenticate,userAction,workerToken,work,wake,cleanup};
}
