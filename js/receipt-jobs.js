/* Private receipt drafts survive closing the browser. Only confirmation saves transactions. */
'use strict';
const ReceiptJobs=(()=>{
 const URL='https://mhgagjhwsjjjwwvopjgu.supabase.co/functions/v1/receipt-jobs';
 let timer=null,version=0,lastOwner=null,lastFolder=null,busy=false,uploading=false;
 let rendered=null;
 const owner=()=>typeof Cloud!=='undefined'?Cloud.getSyncState().owner:null;
 const folder=()=>typeof Dashboard!=='undefined'?Dashboard.getImportTargetId():null;
 const messages={login_required:'Entre na sua conta para enviar e recuperar documentos.',folder_not_linked:'Sincronize esta pasta com sua conta antes de enviar documentos.',active_job_limit:'Há muitos documentos guardados. Conclua ou descarte os envios anteriores.',job_not_found:'Este documento expirou ou pertence a outra conta.',job_not_ready:'A leitura ainda não terminou. Aguarde o resultado.',retry_unavailable:'Não foi possível retomar. Envie o documento novamente.',upload_incomplete:'O envio não terminou. Mantenha o app aberto durante o envio.',job_too_large:'O lote ultrapassa 100 MB após a preparação. Divida os arquivos.',invalid_transaction:'Confira os campos destacados antes de incluir.',saldo_ia:'A leitura aguarda créditos no serviço de IA.'};
 function message(e){return messages[e?.message]||'Não foi possível conectar agora. Seus documentos já enviados continuam guardados; tente novamente.';}
 function uploadMessage(e){return message(e)+(e?.receiptJobCreated?' Confira o andamento no sino de notificações antes de reenviar.':' O arquivo não foi enviado para leitura.');}
 async function request(body,context={owner:owner(),folder:folder()}){
  if(!context.owner||owner()!==context.owner)throw Error('login_required');
  let token=await Cloud.getToken();if(!token)throw Error('login_required');
  const send=()=>fetch(URL,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(body),signal:AbortSignal.timeout(body.action==='upload'?65000:30000)});
  let res=await send();
  if(res.status===401){await Cloud.syncNow();if(owner()!==context.owner)throw Error('login_required');const next=await Cloud.getToken();if(next&&next!==token){token=next;res=await send();}}
  const data=await res.json().catch(()=>({}));if(!res.ok)throw Error(data.error||'service_unavailable');
  if(owner()!==context.owner||folder()!==context.folder)throw Error('context_changed');return data;
 }
 async function submit(tasks,extraRows,onProgress){
  if(uploading)throw Error('upload_in_progress');uploading=true;
  const context={owner:owner(),folder:folder()},id=crypto.randomUUID();
  let created=false;
  try{
   if(!context.owner||!context.folder)throw Error('login_required');
   const pages=[];
   for(const t of tasks){
    const bytes=Uint8Array.from(atob(t.part.data),c=>c.charCodeAt(0));
    const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
    pages.push({mediaType:t.part.mediaType,bytes:bytes.length,sha256:hash,label:t.label,documentId:t.documentId,context:t.part.documentContext});
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
  const panel=document.querySelector('#receipt-jobs');if(!panel)return;
  const pending=jobs.filter(j=>j.status!=='committed').length;
  const bell=document.querySelector('#hero-notifications'),badge=document.querySelector('#receipt-notification-count');
  if(badge){badge.textContent=pending>99?'99+':String(pending);badge.classList.toggle('hidden',!pending);}
  const label=pending?`Notificações: ${pending} documento(s) em leitura ou aguardando você`:'Notificações';
  bell?.setAttribute('aria-label',label);
  const announcement=document.querySelector('#receipt-notification-announcement');
  const ready=jobs.filter(j=>j.status==='ready').length;
  const notice=ready?`${ready} documento(s) pronto(s) para conferir e incluir nas notificações.`:'';
  if(announcement&&announcement.textContent!==notice)announcement.textContent=notice;
  const list=panel.querySelector('[data-jobs-list]');
  panel.querySelector('[data-jobs-error]').textContent='';
  const fingerprint=JSON.stringify([owner(),folder(),jobs]);if(fingerprint===rendered)return;rendered=fingerprint;
  list.innerHTML=jobs.map(j=>{
   const status=j.status==='ready'?'Pronto para conferir e incluir':j.status==='committed'?'Incluído na pasta':j.status==='uploading'?`Envio incompleto · ${j.uploaded}/${j.total_pages} páginas`:j.status==='error'?'Leitura interrompida — o progresso foi preservado':`Leitura ${j.first}/${j.total_pages} · conferência ${j.second}/${j.total_pages}`;
   const buttons=j.status==='ready'?`<button class="btn btn-primary btn-sm" data-job="${j.id}" data-action="open">Conferir e incluir</button>`:j.status==='error'&&j.retry_count<3?`<button class="btn btn-ghost btn-sm" data-job="${j.id}" data-action="retry">Retomar leitura</button>`:'';
   const discard=['uploading','error','committed'].includes(j.status)?`<button class="btn btn-ghost btn-sm" data-job="${j.id}" data-action="discard">${j.status==='committed'?'Remover documento':'Descartar envio'}</button>`:'';
   return `<article class="receipt-job"><div><strong>${escapeHtml(j.label||'Documento')}</strong><p class="${j.status==='ready'?'receipt-ready':''}">${escapeHtml(status)}</p><small>${j.status==='error'&&j.error==='saldo_ia'?'Recarregue os créditos da API e retome a leitura. ':''}Documento disponível até ${escapeHtml(new Date(j.expires_at).toLocaleDateString('pt-BR'))}.</small></div><div class="receipt-job-actions">${buttons}${discard}</div></article>`;
  }).join('')||`<div class="receipt-notifications-empty"><strong>${!owner()?'Entre na sua conta':!folder()?'Abra uma pasta':'Tudo em dia'}</strong>${!owner()?'Conecte sua conta para acompanhar seus documentos privados.':!folder()?'As notificações dos documentos aparecem na pasta em que você os enviou.':'Quando você enviar um comprovante, o andamento e o resultado aparecerão aqui.'}</div>`;
 }
 function closeNotifications(){const panel=document.querySelector('#receipt-jobs');if(panel?.open)panel.close();}
 function openNotifications(){const panel=document.querySelector('#receipt-jobs');if(!panel)return;refresh();if(!panel.open)panel.showModal();}
 async function refresh(){
  clearTimeout(timer);const o=owner(),f=folder();
  if(o!==lastOwner||f!==lastFolder){version++;lastOwner=o;lastFolder=f;closeNotifications();render([]);}
  const current=version;
  if(!o||!f||document.visibilityState==='hidden')return;
  if(busy){timer=setTimeout(refresh,1500);return;}busy=true;
  try{const data=await request({action:'list',folder:f},{owner:o,folder:f});if(current===version)render(data.jobs);}
  catch(e){if(current===version&&e.message!=='context_changed'){const el=document.querySelector('#receipt-jobs [data-jobs-error]');if(el)el.textContent=message(e);}}
  finally{busy=false;if(current===version&&document.visibilityState!=='hidden')timer=setTimeout(refresh,7000);}
 }
 async function commit(id,transactions){return request({action:'commit',id,transactions});}
 document.addEventListener('DOMContentLoaded',()=>{
  document.querySelector('#hero-notifications')?.addEventListener('click',openNotifications);
  document.querySelector('#receipt-notifications-close')?.addEventListener('click',closeNotifications);
  document.querySelector('#receipt-jobs')?.addEventListener('click',e=>{if(e.target===e.currentTarget){const r=e.currentTarget.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeNotifications();}});
  document.querySelector('#receipt-jobs')?.addEventListener('click',async e=>{
   const button=e.target.closest('button[data-job]');if(!button)return;button.disabled=true;
   const action=button.dataset.action,id=button.dataset.job;
   try{
    if(action==='open'){const before={owner:owner(),folder:folder()};await Cloud.syncNow({fresh:true});const data=await request({action:'get',id},before);if(data.job.status!=='ready'){await refresh();return;}closeNotifications();Batch.open({title:'Conferir documentos e lançamentos',hideSources:true,backgroundJob:data});}
    else {await request({action,id});await refresh();}
   }catch(err){toast(message(err));}finally{button.disabled=false;}
  });
  refresh();
 });
 document.addEventListener('visibilitychange',refresh);
 document.addEventListener('fyg:cloudstate',refresh);
 window.addEventListener('focus',refresh);window.addEventListener('online',refresh);
 return {submit,refresh,commit,message,uploadMessage};
})();
