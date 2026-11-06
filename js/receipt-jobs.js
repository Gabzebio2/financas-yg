/* Private receipt jobs survive closing the browser. New photos carry the automatic inclusion intent. */
'use strict';
const ReceiptJobs=(()=>{
 const URL='https://mhgagjhwsjjjwwvopjgu.supabase.co/functions/v1/receipt-jobs';
 let timer=null,version=0,lastOwner=null,lastFolder=null,busy=false,uploading=false;
 let rendered=null,lastJobs=[];
 let seenPhotos=new Set(),syncedJobs=new Set(),retrySyncAfter=0;
 const photoKey=()=> 'fyg:photo-notices:'+owner()+':'+folder();
 function loadSeen(){
  try{seenPhotos=new Set(JSON.parse(localStorage.getItem(photoKey())||'[]'));}catch{seenPhotos=new Set();}
  syncedJobs=new Set();retrySyncAfter=0;
 }
 function photoDetails(j){
  const notice=j.photo_notice;
  if(!notice)return '';
  const items=notice.items||[], pending=notice.pending||[];
  const list=items.map(t=>`<li>${escapeHtml(t.desc)} · ${t.type==='receita'?'Entrada':'Saída'} ${escapeHtml(fmtMoney(t.amount,t.currency))} ${escapeHtml(t.currency)}</li>`).join('');
  const exceptions=j.status==='ready'?pending.map(x=>`<li>${escapeHtml(x.name||'Foto')} · ${escapeHtml(x.reason)}</li>`).join(''):'';
  const notes=[notice.problem,notice.duplicates&&`${notice.duplicates} já registrado(s)`,notice.excluded&&`${notice.excluded} fora de receitas e despesas`,j.photo_corrected_count&&`${j.photo_corrected_count} incluído(s) após ajuste`].filter(Boolean);
  return (list?`<ul class="receipt-item-list">${list}</ul>`:'')+(exceptions?`<details><summary>${pending.length} para conferir</summary><ul class="receipt-item-list">${exceptions}</ul></details>`:'')+(notes.length?`<small>${escapeHtml(notes.join(' · '))}.</small>`:'');
 }
 const deleting=new Set();
 const discardText='Excluir os arquivos deste envio e o resultado da leitura? Você poderá enviar o mesmo documento novamente. Lançamentos já incluídos na pasta serão mantidos.';
 const owner=()=>typeof Cloud!=='undefined'?Cloud.getSyncState().owner:null;
 const folder=()=>typeof Dashboard!=='undefined'?Dashboard.getImportTargetId():null;
 const messages={login_required:'Entre na sua conta para enviar e recuperar documentos.',folder_not_linked:'Sincronize esta pasta com sua conta antes de enviar documentos.',active_job_limit:'Há muitos documentos guardados. Conclua ou descarte os envios anteriores.',job_not_found:'Este documento expirou ou pertence a outra conta.',job_not_ready:'A leitura ainda não terminou. Aguarde o resultado.',retry_unavailable:'Não foi possível retomar. Envie o documento novamente.',upload_incomplete:'O envio não terminou. Mantenha o app aberto durante o envio.',job_too_large:'O lote ultrapassa 100 MB após a preparação. Divida os arquivos.',invalid_transaction:'Confira os campos destacados antes de incluir.',saldo_ia:'A leitura aguarda créditos no serviço de IA.'};
 function message(e){return messages[e?.message]||'Não foi possível conectar agora. Seus documentos já enviados continuam guardados; tente novamente.';}
 function uploadMessage(e){return message(e)+(e?.receiptJobCreated?' Confira o andamento no sino de notificações antes de reenviar.':' O arquivo não foi enviado para leitura.');}
 async function request(body,context={owner:owner(),folder:folder()}){
  if(!context.owner||owner()!==context.owner)throw Error('login_required');
  if(folder()!==context.folder)throw Error('context_changed');
  let token=await Cloud.getToken();if(!token)throw Error('login_required');
  if(owner()!==context.owner||folder()!==context.folder)throw Error('context_changed');
  const send=()=>{if(owner()!==context.owner||folder()!==context.folder)throw Error('context_changed');return fetch(URL,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(body),signal:AbortSignal.timeout(body.action==='upload'?65000:30000)});};
  let res=await send();
  if(res.status===401){await Cloud.syncNow();if(owner()!==context.owner)throw Error('login_required');const next=await Cloud.getToken();if(next&&next!==token){token=next;res=await send();}}
  const data=await res.json().catch(()=>({}));if(!res.ok)throw Error(data.error||'service_unavailable');
  if(owner()!==context.owner||folder()!==context.folder)throw Error('context_changed');return data;
 }
 async function submit(tasks,extraRows,onProgress,options={}){
  if(uploading)throw Error('upload_in_progress');uploading=true;
  const context={owner:owner(),folder:folder()},id=crypto.randomUUID();
  let created=false;
  try{
   if(!context.owner||!context.folder)throw Error('login_required');
   const pages=[];
   for(const t of tasks){
    const bytes=Uint8Array.from(atob(t.part.data),c=>c.charCodeAt(0));
    const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
    pages.push({mediaType:t.part.mediaType,bytes:bytes.length,sha256:hash,label:t.label,documentId:t.documentId,context:{...t.part.documentContext,...(options.photoAuto?{photoAuto:true,photoCategory:options.category || null}:{})}});
   }
   await request({action:'create',id,folder:context.folder,pages,categories:Dashboard.getCats(),cards:CARDS,extraRows},context);
   created=true;
   for(let i=0;i<tasks.length;i++){
    onProgress?.(`Enviando com privacidade · ${i+1}/${tasks.length} páginas. Mantenha o app aberto até terminar o envio.`);
    // Uploads are immutable and idempotent, so a lost response can be retried safely.
    let error;
    for(let attempt=0;attempt<3;attempt++){
     try{await request({action:'upload',id,index:i,data:tasks[i].part.data},context);error=null;break;}catch(e){error=e;if(['login_required','context_changed'].includes(e.message))break;}
    }
    if(error)throw error;
   }
   await request({action:'submit',id},context);await refresh();return id;
  }catch(e){e.receiptJobCreated=created;throw e;}finally{uploading=false;}
 }
 function render(jobs){
  lastJobs=jobs;
  const panel=document.querySelector('#receipt-jobs');if(!panel)return;
  if(panel.open){
   jobs.filter(j=>j.photo_notice).forEach(j=>seenPhotos.add(j.id));
   try{localStorage.setItem(photoKey(),JSON.stringify([...seenPhotos].slice(-60)));}catch{}
  }
  const pending=jobs.filter(j=>j.status!=='committed'||(j.photo_notice&&!seenPhotos.has(j.id))).length;
  const bell=document.querySelector('#hero-notifications'),badge=document.querySelector('#receipt-notification-count');
  if(badge){badge.textContent=pending>99?'99+':String(pending);badge.classList.toggle('hidden',!pending);}
  const label=pending?`Notificações: ${pending} atualização(ões) de documentos`:'Notificações';
  bell?.setAttribute('aria-label',label);
  const announcement=document.querySelector('#receipt-notification-announcement');
  const ready=jobs.filter(j=>j.status==='ready').length;
  const newlySaved=jobs.filter(j=>j.photo_notice?.items?.length && !seenPhotos.has(j.id)).length;
  const notice=newlySaved?'Fotos processadas. Veja os lançamentos no sino.':ready?`${ready} documento(s) disponível(is) para conferência.`:'';
  if(announcement&&announcement.textContent!==notice)announcement.textContent=notice;
  const list=panel.querySelector('[data-jobs-list]');
  panel.querySelector('[data-jobs-error]').textContent='';
  const currentJobIds=Dashboard.receiptJobIds?.();
  const removed=new Set(jobs.filter(j=>currentJobIds && j.status==='committed' && !j.photo_notice && syncedJobs.has(j.id+':committed') && !currentJobIds.has(j.id)).map(j=>j.id));
  const fingerprint=JSON.stringify([owner(),folder(),jobs,[...removed]]);if(fingerprint===rendered)return;rendered=fingerprint;
  list.innerHTML=jobs.map(j=>{
   const status=removed.has(j.id)?'Lançamentos removidos da pasta':j.photo_notice ? (j.photo_notice.items?.length ? (j.photo_notice.items.length===1?'1 lançamento incluído automaticamente':j.photo_notice.items.length+' lançamentos incluídos automaticamente') : j.status==='ready'?'Foto precisa de ajuste':j.photo_corrected_count?'Ajustes incluídos na pasta':'Nenhum lançamento novo') : j.status==='ready'?'Pronto para conferir e incluir':j.status==='committed'?'Incluído na pasta':j.status==='uploading'?`Envio incompleto · ${j.uploaded}/${j.total_pages} páginas`:j.status==='error'?'Leitura interrompida — o progresso foi preservado':`Leitura ${j.first}/${j.total_pages} · conferência ${j.second}/${j.total_pages}`;
   const buttons=j.status==='ready'?`<button class="btn btn-primary btn-sm" data-job="${j.id}" data-action="open">${j.photo_notice?'Ver pendência':'Conferir e incluir'}</button>`:j.status==='error'&&j.retry_count<3?`<button class="btn btn-ghost btn-sm" data-job="${j.id}" data-action="retry">Retomar leitura</button>`:'';
   const view=!removed.has(j.id) && (j.photo_notice ? j.photo_notice.items?.length || j.photo_corrected_count : j.status==='committed') ? `<button class="btn btn-primary btn-sm" data-job="${j.id}" data-action="view">Ver lançamentos</button>`:'';
   const discard=['uploading','ready','error','committed'].includes(j.status)?`<button class="btn btn-ghost btn-sm" data-job="${j.id}" data-action="discard">Excluir documento</button>`:'';
   return `<article class="receipt-job"><div><strong>${escapeHtml(j.label||'Documento')}</strong><p class="${j.status==='ready'?'receipt-ready':''}">${escapeHtml(status)}</p>${photoDetails(j)}<small>${j.status==='error'&&j.error==='saldo_ia'?'Recarregue os créditos da API e retome a leitura. ':''}Documento disponível até ${escapeHtml(new Date(j.expires_at).toLocaleDateString('pt-BR'))}.</small></div><div class="receipt-job-actions">${buttons}${view}${discard}</div></article>`;
  }).join('')||`<div class="receipt-notifications-empty"><strong>${!owner()?'Entre na sua conta':!folder()?'Abra uma pasta':'Tudo em dia'}</strong>${!owner()?'Conecte sua conta para acompanhar seus documentos privados.':!folder()?'As notificações dos documentos aparecem na pasta em que você os enviou.':'Quando você enviar um comprovante, o andamento e o resultado aparecerão aqui.'}</div>`;
 }
 function closeNotifications(){const panel=document.querySelector('#receipt-jobs');if(panel?.open)panel.close();}
 function openNotifications(){const panel=document.querySelector('#receipt-jobs');if(!panel)return;if(!panel.open)panel.showModal();render(lastJobs);refresh();}
 async function refresh(){
  clearTimeout(timer);const o=owner(),f=folder();
  if(o!==lastOwner||f!==lastFolder){version++;lastOwner=o;lastFolder=f;loadSeen();closeNotifications();render([]);}
  const current=version;
  if(!o||!f||document.visibilityState==='hidden')return;
  if(busy){timer=setTimeout(refresh,1500);return;}busy=true;
  try{const data=await request({action:'list',folder:f},{owner:o,folder:f});if(current===version){
    render(data.jobs);
    const saved=data.jobs.filter(j=>j.status==='committed'||j.photo_notice?.items?.length).map(j=>j.id+':'+j.status).filter(key=>!syncedJobs.has(key));
    if(saved.length && Date.now()>=retrySyncAfter && Cloud.getSyncState().autoSync!==false){
     retrySyncAfter=Date.now()+30000;
     const synced=await Cloud.syncNow({fresh:true});
     if(synced!==false && current===version && o===owner() && f===folder()){
      retrySyncAfter=0;saved.forEach(key=>syncedJobs.add(key));Dashboard.refreshFromStore?.({force:true});render(data.jobs);
     }
    }
   }}
  catch(e){if(current===version&&e.message!=='context_changed'){const el=document.querySelector('#receipt-jobs [data-jobs-error]');if(el)el.textContent=message(e);}}
  finally{busy=false;if(current===version&&document.visibilityState!=='hidden')timer=setTimeout(refresh,7000);}
 }
 async function commit(id,transactions){return request({action:'commit',id,transactions});}
 async function discard(id,context={owner:owner(),folder:folder()}){
  const key=context.owner+':'+id;if(deleting.has(key))throw Error('delete_in_progress');
  deleting.add(key);
  try{
   const result=await request({action:'discard',id},context);if(result.discarded!==true)throw Error('service_unavailable');
   // Invalidate any list response started before deletion so it cannot restore
   // the removed notification while a subsequent refresh is in flight.
   version++;render(lastJobs.filter(j=>j.id!==id));refresh();return result;
  }finally{deleting.delete(key);}
 }
 document.addEventListener('DOMContentLoaded',()=>{
  document.querySelector('#hero-notifications')?.addEventListener('click',openNotifications);
  document.querySelector('#receipt-notifications-close')?.addEventListener('click',closeNotifications);
  document.querySelector('#receipt-jobs')?.addEventListener('click',e=>{if(e.target===e.currentTarget){const r=e.currentTarget.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeNotifications();}});
  document.querySelector('#receipt-jobs')?.addEventListener('click',async e=>{
   const button=e.target.closest('button[data-job]');if(!button)return;button.disabled=true;
   const action=button.dataset.action,id=button.dataset.job;
   try{
    if(action==='open'){const before={owner:owner(),folder:folder()};await Cloud.syncNow({fresh:true});const data=await request({action:'get',id},before);if(data.job.status!=='ready'){await refresh();return;}closeNotifications();Batch.open({title:'Conferir documentos e lançamentos',hideSources:true,backgroundJob:data});}
    else if(action==='view'){
     const before={owner:owner(),folder:folder()};
     const synced=await Cloud.syncNow({fresh:true});
     if(before.owner!==owner()||before.folder!==folder())return;
     if(!synced && !Dashboard.existingTransactions().some(t=>String(t.id).startsWith('receipt_'+id+'_'))){toast('A pasta ainda não terminou de sincronizar. Tente Ver lançamentos novamente quando a conexão voltar.');return;}
     closeNotifications();Dashboard.showReceiptTransactions(id);
     if(!synced)toast('Exibindo os lançamentos deste documento já disponíveis neste aparelho.');
    }
    else if(action==='discard'){
     const context={owner:owner(),folder:folder()};closeNotifications();
     askConfirm('Excluir documento?',discardText,async()=>{
      try{await discard(id,context);toast('Documento excluído. Você já pode enviá-lo novamente.');}
      catch(err){toast(message(err));}
     });
    }
    else if(action==='retry'){await request({action,id});await refresh();}
   }catch(err){toast(message(err));}finally{button.disabled=false;}
  });
  refresh();
 });
 document.addEventListener('visibilitychange',refresh);
 document.addEventListener('fyg:cloudstate',()=>{if(owner()!==lastOwner||folder()!==lastFolder)refresh();});
 window.addEventListener('focus',refresh);window.addEventListener('online',refresh);
 return {submit,refresh,commit,discard,discardText,message,uploadMessage};
})();
