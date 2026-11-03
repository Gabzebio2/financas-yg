/* The weekly view uses normal folder transactions, so edits, backups and sync share one ledger. */
'use strict';
const BusinessPanel = (() => {
  const el=id=>document.getElementById(id);
  const esc=value=>escapeHtml(String(value));
  const isoLabel=date=>date.split('-').reverse().join('/');
  const localeAmount=v=>new Intl.NumberFormat('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2}).format(v);
  const signed=t=>t.type==='despesa'?-t.amount:t.amount;
  const money=(v,c)=>localeAmount(v)+' '+c;
  const owner=()=>typeof Cloud!=='undefined'?Cloud.getSyncState().owner:null;
  let currentId=null, selected='', context=null, preview=null, generation=0, initial=new Map();
  function folder(){
    const ds=context && Dashboard.getImportTargetId()===context.id && owner()===context.owner && Store.loadDataset(context.id);
    if(!ds || ds.profile!=='pj')throw Error('Abra a pasta empresarial novamente.');
    return ds;
  }
  function start(){
    context={id:Dashboard.getImportTargetId(),owner:owner()};generation++;
    return folder();
  }
  function weeks(ds){
    return [...new Set(ds.transactions.filter(t=>t.weeklyRevenue).map(t=>t.date))].sort();
  }
  function accountNames(ds){
    const names=new Map();
    for(const a of [...(ds.weekly?.accounts||[]),...ds.transactions.filter(t=>t.weeklyRevenue).map(t=>t.account)]){
      if(a)names.set(WeeklyRevenue.normalized(a),a);
    }
    return [...names.values()];
  }
  let multiple=false, model=null, viewKey='', visible=[], filterFrom='', filterTo='';
  const marked=new Set();
  const formatDay=new Intl.DateTimeFormat('pt-BR',{day:'2-digit',month:'short',timeZone:'UTC'});
  const eraseIcon='<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="m4 14 9-10 7 6-9 10H9l-5-4zM9 9l7 6M11 20h10"/></svg>';
  function mount(){
    const host=el('weekly-content');
    host.innerHTML=`<div class="weekly-tools"><div class="weekly-switches">
      <div class="weekly-mode" role="group" aria-label="Modo de seleção"><button type="button" id="weekly-single">Uma semana</button><button type="button" id="weekly-multiple">Somar semanas</button></div>
      <button type="button" id="weekly-clear" class="weekly-icon" title="Limpar seleção" aria-label="Limpar seleção de semanas">${eraseIcon}</button></div>
      <details id="weekly-filter" class="weekly-filter"><summary>Filtrar por data</summary>
      <form id="weekly-filter-form"><label>Encerramento a partir de<input type="date" id="weekly-from"></label><label>Até<input type="date" id="weekly-to"></label>
      <div><button type="submit" class="btn btn-primary btn-sm">Aplicar filtro</button><button type="button" class="btn-link" id="weekly-reset-filter">Remover filtro</button></div></form></details></div>
      <div id="weekly-filter-note" class="weekly-filter-note"></div>
      <div class="weekly-browser"><div class="weekly-picker"><div class="weekly-picker-head"><h3>Semanas</h3><div class="weekly-arrows">
      <button type="button" id="weekly-prev" aria-label="Mostrar semanas mais recentes">‹</button><button type="button" id="weekly-next" aria-label="Mostrar semanas anteriores">›</button></div></div>
      <p id="weekly-instruction"></p><div id="weekly-rail" class="weekly-cards" role="group" aria-label="Selecionar semanas"></div>
      <div class="weekly-shortcuts" id="weekly-shortcuts"><span>Marcar</span>${[2,4,8].map(n=>`<button type="button" data-week-size="${n}">Últimas ${n}</button>`).join('')}
      <button type="button" id="weekly-mark-filter">Todas do filtro</button></div></div>
      <div class="weekly-result" id="weekly-result" aria-label="Resultado da seleção"></div></div>
      <span id="weekly-announcement" class="sr-only" aria-live="polite" aria-atomic="true"></span>`;
    el('weekly-rail').addEventListener('scroll',updateArrows,{passive:true});
    bindMouseDrag(el('weekly-rail'));
    el('weekly-filter-form').addEventListener('submit',e=>{
      e.preventDefault();
      const from=el('weekly-from'), to=el('weekly-to');
      if(from.value && to.value && from.value>to.value){
        to.setCustomValidity('A data final precisa ser igual ou posterior à inicial.');to.reportValidity();return;
      }
      applyFilter(from.value,to.value);
    });
    el('weekly-filter-form').addEventListener('input',()=>el('weekly-to').setCustomValidity(''));
    el('weekly-from').value=filterFrom;el('weekly-to').value=filterTo;
  }
  function updateArrows(){
    const rail=el('weekly-rail');if(!rail)return;
    el('weekly-prev').disabled=rail.scrollLeft<2;
    el('weekly-next').disabled=rail.scrollLeft+rail.clientWidth>=rail.scrollWidth-2;
  }
  function bindMouseDrag(rail){
    let gesture=null, suppressClick=false;
    function finish(){
      if(!gesture)return;
      const id=gesture.id;gesture=null;rail.classList.remove('is-dragging');
      if(rail.hasPointerCapture(id))rail.releasePointerCapture(id);
      window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',end);
      window.removeEventListener('pointercancel',end);window.removeEventListener('blur',finish);
    }
    function move(e){
      if(!gesture||e.pointerId!==gesture.id)return;
      if(!(e.buttons&1)){finish();return;}
      const dx=e.clientX-gesture.x;
      if(!suppressClick && Math.abs(dx)<6)return;
      if(!suppressClick){suppressClick=true;rail.setPointerCapture(e.pointerId);rail.classList.add('is-dragging');}
      e.preventDefault();rail.scrollLeft=gesture.left-dx;
    }
    function end(e){if(e.pointerId===gesture?.id)finish();}
    rail.addEventListener('pointerdown',e=>{
      suppressClick=false;
      if(e.pointerType!=='mouse'||e.button!==0)return;
      finish();gesture={id:e.pointerId,x:e.clientX,left:rail.scrollLeft};
      window.addEventListener('pointermove',move);window.addEventListener('pointerup',end);
      window.addEventListener('pointercancel',end);window.addEventListener('blur',finish);
    });
    rail.addEventListener('lostpointercapture',end);
    rail.addEventListener('click',e=>{
      if(suppressClick && e.detail!==0){suppressClick=false;e.preventDefault();e.stopPropagation();}
    },true);
  }
  function reveal(date){
    const rail=el('weekly-rail'), card=rail?.querySelector('[data-week-date="'+date+'"]');if(!card)return;
    const box=card.getBoundingClientRect(),track=rail.getBoundingClientRect();
    if(box.left<track.left+6)rail.scrollLeft+=box.left-track.left-8;
    else if(box.right>track.right-6)rail.scrollLeft+=box.right-track.right+8;
  }
  function drawCards(){
    visible=model.dates.filter(d=>(!filterFrom||d>=filterFrom)&&(!filterTo||d<=filterTo)).reverse();
    if(!visible.includes(selected))selected=visible[0]||'';
    const rail=el('weekly-rail');
    const focused=rail.contains(document.activeElement)?document.activeElement.dataset.weekDate:null;
    const offset=rail.scrollLeft;
    const largest=visible.reduce((n,d)=>Math.max(n,Math.abs(model.groups.get(d)?.total||0)),1);
    rail.innerHTML=visible.map(d=>{
      const week=model.groups.get(d),label=week?money(week.total/100,model.unit):'Sem registro';
      return `<button type="button" class="weekly-card" data-week-date="${d}" aria-label="Semana até ${isoLabel(d)}, ${esc(label)}">
        <span class="weekly-card-top"><small>${d.slice(0,4)}</small><span class="weekly-check" aria-hidden="true">✓</span></span>
        <strong>${formatDay.format(new Date(d+'T00:00:00Z')).replace(' de ',' ')}</strong><span class="weekly-card-value">${esc(label)}</span>
        <span class="weekly-meter" aria-hidden="true"><i style="width:${Math.abs(week?.total||0)/largest*100}%;" class="${week?.total<0?'negative':''}"></i></span></button>`;
    }).join('')||'<p class="weekly-empty">Nenhuma semana neste intervalo.</p>';
    if(focused)rail.querySelector('[data-week-date="'+focused+'"]')?.focus({preventScroll:true});
    rail.scrollLeft=offset;updateSelection();updateArrows();
  }
  function updateSelection(){
    const dates=multiple?visible.filter(d=>marked.has(d)):selected?[selected]:[];
    const {reported,total,rows}=WeeklyRevenue.selectionSummary(model,dates);
    const counted=new Set(dates),missing=dates.length-reported;
    el('weekly-single').setAttribute('aria-pressed',String(!multiple));el('weekly-multiple').setAttribute('aria-pressed',String(multiple));
    el('weekly-clear').hidden=!multiple;el('weekly-clear').disabled=!marked.size;
    el('weekly-shortcuts').hidden=!multiple;
    for(const b of el('weekly-shortcuts').querySelectorAll('[data-week-size]'))b.disabled=visible.length<Number(b.dataset.weekSize);
    el('weekly-mark-filter').disabled=!visible.length||(!filterFrom&&!filterTo);
    el('weekly-instruction').textContent=multiple?'Marque ou desmarque semanas para somar. Arraste para ver mais.':'Arraste para navegar. Selecione uma semana para ver os ganhos por conta.';
    for(const b of el('weekly-rail').querySelectorAll('[data-week-date]'))b.setAttribute('aria-pressed',String(counted.has(b.dataset.weekDate)));
    const title=multiple?(dates.length===1?'1 semana selecionada':dates.length+' semanas selecionadas'):selected?'Semana até '+isoLabel(selected):'Nenhuma semana';
    const value=!dates.length?'—':reported?money(total/100,model.unit):'Sem registro';
    const description=!dates.length?(multiple?'Selecione os cartões que deseja somar.':'Escolha outro intervalo de datas.'):'';
    el('weekly-result').innerHTML=`<p class="weekly-result-label">${esc(title)}</p><strong class="weekly-result-value">${esc(value)}</strong>
      ${description?`<p class="weekly-empty">${description}</p>`:''}
      ${missing&&reported?`<small>${missing} sem registro</small>`:''}
      ${rows.length?`<h3>Ganhos por conta</h3><ul class="weekly-accounts">${rows.map(([a,v])=>`<li><span>${esc(a)}</span><strong>${esc(money(v/100,model.unit))}</strong></li>`).join('')}</ul>`:''}
      ${!multiple&&selected?`<button type="button" class="btn-link" data-week-edit>${reported?'Editar':'Anotar'} esta semana</button>`:''}`;
    el('weekly-announcement').textContent=title+' · '+value;
    const outside=multiple?marked.size-dates.length:0;
    el('weekly-filter-note').textContent=(filterFrom||filterTo)?'Encerramentos'+(filterFrom?' a partir de '+isoLabel(filterFrom):'')+(filterTo?' até '+isoLabel(filterTo):'')+' · '+visible.length+(visible.length===1?' semana':' semanas')+(outside?' · '+outside+' marcada(s) fora do total':''):'';
  }
  function applyFilter(from,to){
    filterFrom=from;filterTo=to;
    el('weekly-from').value=from;el('weekly-to').value=to;el('weekly-to').setCustomValidity('');
    el('weekly-filter').open=false;drawCards();el('weekly-rail').scrollLeft=0;
    el('weekly-filter').querySelector('summary').focus({preventScroll:true});
    if(!multiple && selected)reveal(selected);
  }
  function choose(date){
    if(!visible.includes(date))return;
    selected=date;
    if(multiple){if(marked.has(date))marked.delete(date);else marked.add(date);}
    updateSelection();reveal(date);
  }
  function render(ds){
    const panel=el('weekly-panel');if(!panel)return;
    panel.classList.toggle('hidden',ds.profile!=='pj');
    if(currentId!==ds.id){
      currentId=ds.id;selected='';multiple=false;model=null;viewKey='';marked.clear();filterFrom='';filterTo='';
      el('weekly-content').replaceChildren();
    }
    if(ds.profile!=='pj')return;
    const unit=ds.weekly?.currency||'USD', txs=ds.transactions.filter(t=>t.weeklyRevenue&&t.currency===unit);
    const nextKey=JSON.stringify([ds.id,unit,txs.map(t=>[t.date,t.account,t.type,t.amount])]);
    if(nextKey===viewKey)return;
    viewKey=nextKey;model=WeeklyRevenue.periodModel(txs,unit);
    const known=new Set(model.dates);for(const d of marked)if(!known.has(d))marked.delete(d);
    if(!model.dates.length){
      marked.clear();selected='';visible=[];
      el('weekly-content').innerHTML='<p class="weekly-empty">Importe a aba Semanal da sua planilha ou anote a primeira semana. Aqui você vai acompanhar o ganho de cada conta.</p>';return;
    }
    if(!el('weekly-rail'))mount();
    drawCards();
  }
  function sheetId(url){
    if(!url.trim())return '';
    let link;try{link=new URL(url);}catch{}
    const id=link?.hostname==='docs.google.com'&&link.protocol==='https:'&&link.pathname.match(/^\/spreadsheets\/d\/([\w-]{15,120})(?:\/|$)/)?.[1];
    if(!id)throw Error('Cole o link de uma planilha do Google ou selecione um arquivo Excel.');
    return id;
  }
  async function readSheet(file,id){
    const limit=15*1024*1024;
    if(file){if(file.size>limit)throw Error('O limite é 15 MB por planilha.');return file.arrayBuffer();}
    if(!id)throw Error('Selecione o arquivo ou cole o link da planilha.');
    let r;
    try{r=await fetch('https://docs.google.com/spreadsheets/d/'+id+'/export?format=xlsx',{credentials:'omit',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(30000)});}catch{}
    if(!r?.ok||/text\/html/i.test(r.headers.get('content-type')||''))throw Error('Não consegui ler o link. No Google Planilhas, use Arquivo → Fazer download → Microsoft Excel e selecione o arquivo aqui.');
    if(Number(r.headers.get('content-length'))>limit)throw Error('O limite é 15 MB por planilha.');
    const data=await r.arrayBuffer();if(data.byteLength>limit)throw Error('O limite é 15 MB por planilha.');
    return data;
  }
  function save(ds){
    ensureCat(ds,'Receita semanal');Store.saveDataset(ds);Dashboard.refreshFromStore({force:true});
  }
  function resetPreview(){
    generation++;preview=null;
    el('weekly-import-form').querySelector('[type=submit]').textContent='Ler planilha';
    el('weekly-import-state').textContent='';
  }
  function openImport(){
    const ds=start();resetPreview();el('weekly-file').value='';
    el('weekly-url').value=ds.weekly?.sheetId?'https://docs.google.com/spreadsheets/d/'+ds.weekly.sheetId+'/edit':'';
    el('weekly-year').value=ds.weekly?.year||new Date().getFullYear();
    el('weekly-currency').value=ds.weekly?.currency||'USD';el('weekly-import-dialog').showModal();
  }
  async function importSheet(ev){
    ev.preventDefault();const form=el('weekly-import-form'),button=form.querySelector('[type=submit]'),state=el('weekly-import-state');
    const version=generation;button.disabled=true;
    try{
      const ds=folder(),currency=el('weekly-currency').value,year=Number(el('weekly-year').value);
      if(ds.weekly?.currency && ds.weekly.currency!==currency && weeks(ds).length)throw Error('Use a moeda já adotada nesta pasta: '+ds.weekly.currency+'.');
      if(!preview){
        const file=el('weekly-file').files[0],id=file?'':sheetId(el('weekly-url').value);
        state.textContent='Lendo a aba Semanal…';
        const bytes=await readSheet(file,id);
        if(version!==generation || !el('weekly-import-dialog').open)return;
        folder();const data=WeeklyRevenue.parse(XLSX.read(bytes,{type:'array',sheets:['Semanal','semanal','SEMANAL']}),year,XLSX);
        const dates=[...new Set(data.entries.map(e=>e.date))].sort();
        const counts=WeeklyRevenue.apply(structuredClone(ds),data.entries,currency,true,uid);
        preview={data,id,year,currency};
        state.textContent=`${data.accounts.length} contas · ${dates.length} semanas, de ${isoLabel(dates[0])} a ${isoLabel(dates.at(-1))} · ${currency}. ${counts.added} novos, ${counts.updated} atualizações.`+(counts.conflicts?' Edições feitas no app serão preservadas.':'')+(data.skipped?' Células sem valor numérico: '+data.skipped+'.':'');
        button.textContent='Aplicar à pasta';return;
      }
      const {data,id}=preview;
      const counts=WeeklyRevenue.apply(ds,data.entries,currency,true,uid);
      ds.weekly={accounts:[...new Set([...accountNames(ds),...data.accounts])],currency,year,sheetId:id||ds.weekly?.sheetId||''};
      save(ds);el('weekly-import-dialog').close();
      toast(`Planilha atualizada: ${counts.added} novos, ${counts.updated} atualizados.`+(counts.conflicts?' '+counts.conflicts+' edição(ões) do app preservada(s).':''));
    }catch(e){if(version===generation)state.textContent=e.message||'Não foi possível ler a planilha.';}finally{button.disabled=false;}
  }
  function addInput(account,value){
    const label=document.createElement('label');label.className='weekly-input-row';label.append(document.createTextNode(account));
    const input=document.createElement('input');input.type='text';input.inputMode='decimal';input.placeholder='—';input.dataset.account=account;
    if(value!=null)input.value=String(value).replace('.',',');
    label.append(input);el('weekly-account-inputs').append(label);initial.set(normalizedKey(account),value??null);
  }
  const normalizedKey=a=>WeeklyRevenue.normalized(a);
  function fillWeek(){
    const ds=folder(),date=el('weekly-edit-date').value,currency=el('weekly-edit-currency').value;
    const current=ds.transactions.filter(t=>t.weeklyRevenue&&t.date===date&&t.currency===currency);
    initial=new Map();el('weekly-account-inputs').replaceChildren();
    for(const a of accountNames(ds)){const t=current.find(t=>normalizedKey(t.account)===normalizedKey(a));addInput(a,t?signed(t):null);}
    el('weekly-edit-state').textContent='';
  }
  function openEdit(existing){
    const ds=start(),last=weeks(ds).at(-1);
    el('weekly-edit-date').value=existing&&selected?selected:last?WeeklyRevenue.nextWeek(last):todayISO();
    el('weekly-edit-currency').value=ds.weekly?.currency||'USD';
    el('weekly-edit-currency').disabled=!!ds.weekly?.currency;
    el('weekly-new-name').value='';fillWeek();el('weekly-edit-dialog').showModal();
  }
  function saveWeek(ev){
    ev.preventDefault();const state=el('weekly-edit-state');
    try{
      const ds=folder(),date=el('weekly-edit-date').value,currency=el('weekly-edit-currency').value;
      if(!isValidISODate(date))throw Error('Escolha a data de encerramento.');
      const entries=[];
      for(const input of el('weekly-account-inputs').querySelectorAll('input')){
        const str=input.value.trim();if(!str)continue;
        if(!/^-?\d+(?:[.,]\d{1,2})?$/.test(str))throw Error('Use um valor como 125,50 para '+input.dataset.account+'.');
        const value=Number(str.replace(',','.')),account=input.dataset.account,old=initial.get(normalizedKey(account));
        if(!Number.isFinite(value)||Math.abs(value)>Number.MAX_SAFE_INTEGER)throw Error('Valor inválido para '+account+'.');
        if(value===old)continue;
        const latest=ds.transactions.find(t=>t.weeklyRevenue&&t.currency===currency&&t.date===date&&normalizedKey(t.account)===normalizedKey(account));
        if((latest?signed(latest):null)!==old)throw Error('Essa semana mudou em outro aparelho. Feche e abra de novo para conferir.');
        entries.push({account,date,amount:value});
      }
      if(!entries.length)throw Error('Informe ou altere o ganho de pelo menos uma conta.');
      WeeklyRevenue.apply(ds,entries,currency,false,uid);
      ds.weekly={...ds.weekly,currency,accounts:accountNames(ds)};selected=date;multiple=false;
      if((filterFrom&&date<filterFrom)||(filterTo&&date>filterTo)){
        filterFrom='';filterTo='';el('weekly-from').value='';el('weekly-to').value='';
      }
      save(ds);reveal(date);el('weekly-edit-dialog').close();toast('Ganhos da semana salvos.');
    }catch(e){state.textContent=e.message;}
  }
  document.addEventListener('DOMContentLoaded',()=>{
    el('card-business').addEventListener('click',()=>askName('Nome da pasta empresarial','Minha empresa',name=>Dashboard.createEmpresaDataset(name)));
    const opts=CURRENCY_CODES.map(c=>`<option>${esc(c)}</option>`).join('');
    for(const id of ['weekly-currency','weekly-edit-currency'])el(id).innerHTML=opts;
    el('weekly-import').addEventListener('click',openImport);el('weekly-edit').addEventListener('click',()=>openEdit(false));
    el('weekly-import-form').addEventListener('submit',importSheet);
    el('weekly-import-form').addEventListener('input',resetPreview);
    el('weekly-import-dialog').addEventListener('close',resetPreview);
    document.querySelectorAll('[data-week-close]').forEach(b=>b.addEventListener('click',()=>b.closest('dialog').close()));
    el('weekly-edit-date').addEventListener('change',fillWeek);el('weekly-edit-currency').addEventListener('change',fillWeek);
    el('weekly-edit-form').addEventListener('submit',saveWeek);
    el('weekly-add-account').addEventListener('click',()=>{
      const a=el('weekly-new-name').value.trim();if(!a)return;
      if(initial.has(normalizedKey(a))){el('weekly-edit-state').textContent='Essa conta já está na lista.';return;}
      addInput(a,null);el('weekly-new-name').value='';el('weekly-account-inputs').lastElementChild.querySelector('input').focus();
    });
    const host=el('weekly-content');
    window.addEventListener('resize',updateArrows);
    host.addEventListener('click',e=>{
      const b=e.target.closest('button');if(!b||!model||b.disabled)return;
      if(b.dataset.weekDate){choose(b.dataset.weekDate);return;}
      if(b.id==='weekly-prev'||b.id==='weekly-next'){
        const rail=el('weekly-rail');
        rail.scrollBy({left:(b.id==='weekly-prev'?-1:1)*Math.max(136,rail.clientWidth*.75),
          behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});return;
      }
      if(b.id==='weekly-reset-filter'){applyFilter('','');return;}
      if(b.hasAttribute('data-week-edit')){openEdit(true);return;}
      if(b.id==='weekly-clear')marked.clear();
      else if(b.id==='weekly-single')multiple=false;
      else if(b.id==='weekly-multiple')multiple=true;
      else if(b.dataset.weekSize||b.id==='weekly-mark-filter'){
        const picks=b.dataset.weekSize?visible.slice(0,Number(b.dataset.weekSize)):visible;
        if(b.dataset.weekSize)marked.clear();
        picks.forEach(d=>marked.add(d));
        if(picks.length){selected=picks[0];reveal(selected);}
      }else return;
      updateSelection();
    });
    host.addEventListener('keydown',e=>{
      const date=e.target.dataset.weekDate, index=visible.indexOf(date);
      if(index<0)return;
      const keys={ArrowLeft:index-1,ArrowRight:index+1,Home:0,End:visible.length-1};
      if(!Object.hasOwn(keys,e.key))return;
      e.preventDefault();
      const next=visible[Math.min(visible.length-1,Math.max(0,keys[e.key]))];
      el('weekly-rail').querySelector('[data-week-date="'+next+'"]')?.focus({preventScroll:true});reveal(next);
    });
  });
  return {render};
})();
