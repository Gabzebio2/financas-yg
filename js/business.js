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
  // Each page ends on a recorded closing date. The same window size is used
  // for swiping, arrows and shortcuts so all navigation produces the same sum.
  let periodSize=1, multiple=false, model=null, viewKey='', resizeObserver=null;
  const spanLabel=(start,end)=>start===end?isoLabel(end):isoLabel(start)+' a '+isoLabel(end);
  function slideHTML(end){
    const {dates,groups,unit}=model,from=end-periodSize+1;
    const {total,reported,rows}=WeeklyRevenue.periodSummary(model,from,end);
    const recent=dates.slice(multiple?Math.max(from,end-7):Math.max(0,end-7),end+1);
    const max=Math.max(1,...recent.map(d=>Math.abs(groups.get(d)?.total||0)));
    const bars=recent.map(d=>{
      const value=groups.get(d)?.total,label='Ver semana de '+isoLabel(d)+' · '+(value==null?'Sem registro':money(value/100,unit));
      return `<button type="button" data-week-date="${esc(d)}" title="${esc(label)}" aria-label="${esc(label)}"><i class="${value<0?'negative':''}" style="height:${value==null?0:Math.max(3,Math.abs(value)/max*100)}%"></i><small>${isoLabel(d).slice(0,5)}</small></button>`;
    }).join('');
    const title=multiple?(periodSize>8?'Últimas 8 semanas do período':'Semanas do período'):'Últimas semanas';
    const missing=periodSize-reported;
    const coverage=missing?' · '+missing+(missing===1?' sem registro':' sem registros'):'';
    return `<div class="weekly-overview"><div><small>${multiple?'Ganho no período':'Ganho da semana'}</small><strong>${reported?esc(money(total/100,unit)):'Sem registro'}</strong></div>
      <span class="weekly-period-label">${multiple?periodSize+' '+(periodSize===1?'semana':'semanas')+coverage:'Encerramento'}<b>${spanLabel(dates[from],dates[end])}</b></span></div>
      <div class="weekly-grid"><section><h3>${title}</h3><div class="weekly-trend">${bars}</div></section>
      <section><h3>Ganhos por conta</h3>${rows.length?`<ul class="weekly-accounts">${rows.map(([a,v])=>`<li><span>${esc(a)}</span><strong>${esc(money(v/100,unit))}</strong></li>`).join('')}</ul>`:'<p class="weekly-empty">Nenhuma conta tem ganhos anotados neste período.</p>'}</section></div>
      ${multiple?'':`<button type="button" class="btn-link" data-week-edit>${reported?'Editar':'Anotar'} esta semana</button>`}`;
  }
  function selectedIndex(){return model.dates.indexOf(selected);}
  function syncControls(){
    const {dates}=model,end=selectedIndex(),start=end-periodSize+1;
    el('weekly-prev').disabled=start<=0;el('weekly-next').disabled=end>=dates.length-1;
    el('weekly-view-date').value=selected;
    if(multiple){
      el('weekly-from').value=dates[start];
      for(const option of el('weekly-from').options)option.disabled=option.value>selected;
      for(const option of el('weekly-view-date').options)option.disabled=option.value<dates[start];
      for(const b of el('weekly-content').querySelectorAll('[data-week-size]'))b.setAttribute('aria-pressed',Number(b.dataset.weekSize)===periodSize?'true':'false');
    }
    const rail=el('weekly-rail');
    for(const [i,slide] of Array.from(rail.children).entries()){
      const ix=i+periodSize-1,active=ix===end;
      slide.inert=!active;
      if(Math.abs(ix-end)<=1 && !slide.hasChildNodes())slide.innerHTML=slideHTML(ix);
      if(Math.abs(ix-end)>1 && slide.hasChildNodes())slide.replaceChildren();
    }
    el('weekly-announcement').textContent=(multiple?'Período de ':'Semana até ')+spanLabel(dates[start],selected);
  }
  function positionRail(){
    const rail=el('weekly-rail');if(!rail)return;
    const width=rail.getBoundingClientRect().width;
    if(width)rail.scrollLeft=(selectedIndex()-periodSize+1)*width;
  }
  function goToEnd(index){
    const last=model.dates.length-1;
    const ix=Math.max(periodSize-1,Math.min(last,index));
    selected=model.dates[ix];syncControls();positionRail();
  }
  function mount(){
    const host=el('weekly-content'),{dates}=model;
    const active=document.activeElement,focusId=host.contains(active)?active.id:'';
    const options=dates.slice().reverse().map(d=>`<option value="${d}">${isoLabel(d)}</option>`).join('');
    resizeObserver?.disconnect();
    host.innerHTML=`<div class="weekly-period-controls">
      <div class="weekly-mode" role="group" aria-label="Período das receitas"><button type="button" id="weekly-single" aria-pressed="${!multiple}">Uma semana</button><button type="button" id="weekly-multiple" aria-pressed="${multiple}" ${dates.length<2?'disabled':''}>Somar semanas</button></div>
      <div class="weekly-period-inputs">${multiple?`<label>Primeira semana até<select id="weekly-from">${options}</select></label>`:''}
      <label>${multiple?'Última semana até':'Semana até'}<select id="weekly-view-date">${options}</select></label></div>
      ${multiple?`<div class="weekly-presets" role="group" aria-label="Quantidade de semanas">${[2,4,8].map(n=>`<button type="button" data-week-size="${n}" ${dates.length<n?'disabled':''}>${n} semanas</button>`).join('')}</div>`:''}</div>
      <div class="weekly-turn"><span>Deslize para ver ${multiple?'outro período':'outra semana'}</span><div>
        <button type="button" id="weekly-prev" aria-label="Voltar uma semana">‹</button><button type="button" id="weekly-next" aria-label="Avançar uma semana">›</button></div></div>
      <div id="weekly-rail" class="weekly-rail" role="region" aria-label="Receitas semanais, use as setas para navegar" tabindex="0">
      ${dates.slice(periodSize-1).map(d=>`<div class="weekly-slide" role="group" aria-label="Até ${isoLabel(d)}"></div>`).join('')}</div><span id="weekly-announcement" class="sr-only" aria-live="polite"></span>`;
    syncControls();positionRail();
    const rail=el('weekly-rail');
    rail.addEventListener('scroll',()=>{
      if(rail!==el('weekly-rail'))return;
      const width=rail.getBoundingClientRect().width;
      if(!width)return;
      const ix=Math.min(dates.length-1,periodSize-1+Math.max(0,Math.round(rail.scrollLeft/width)));
      if(selected!==dates[ix]){selected=dates[ix];syncControls();}
    });
    if(typeof ResizeObserver!=='undefined'){
      let previousWidth=rail.clientWidth;
      resizeObserver=new ResizeObserver(()=>{if(rail.clientWidth!==previousWidth){previousWidth=rail.clientWidth;positionRail();}});
      resizeObserver.observe(rail);
    }
    if(focusId)el(focusId)?.focus({preventScroll:true});
  }
  function setWindow(size,end,range){
    const {dates}=model;
    periodSize=Math.min(dates.length,Math.max(1,size));
    selected=dates[Math.max(periodSize-1,Math.min(end,dates.length-1))];
    multiple=range;mount();
  }
  function render(ds){
    const panel=el('weekly-panel');if(!panel)return;
    panel.classList.toggle('hidden',ds.profile!=='pj');
    if(currentId!==ds.id){
      resizeObserver?.disconnect();currentId=ds.id;selected='';periodSize=1;multiple=false;model=null;viewKey='';
    }
    if(ds.profile!=='pj')return;
    const unit=ds.weekly?.currency||'USD', txs=ds.transactions.filter(t=>t.weeklyRevenue&&t.currency===unit);
    const nextKey=JSON.stringify([ds.id,unit,txs.map(t=>[t.date,t.account,t.type,t.amount])]);
    // Preserve native scrolling and keyboard focus through rate/summary refreshes.
    if(nextKey===viewKey && model?.dates.includes(selected) && el('weekly-view-date')?.value===selected)return;
    viewKey=nextKey;model=WeeklyRevenue.periodModel(txs,unit);
    if(!model.dates.length){
      resizeObserver?.disconnect();multiple=false;periodSize=1;selected='';
      el('weekly-content').innerHTML='<p class="weekly-empty">Importe a aba Semanal da sua planilha ou anote a primeira semana. Aqui você vai acompanhar o ganho de cada conta.</p>';return;
    }
    const ix=model.dates.indexOf(selected);
    setWindow(multiple?periodSize:1,ix<0?model.dates.length-1:ix,multiple&&model.dates.length>1);
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
      selected='';save(ds);el('weekly-import-dialog').close();
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
      ds.weekly={...ds.weekly,currency,accounts:accountNames(ds)};selected=date;save(ds);el('weekly-edit-dialog').close();toast('Ganhos da semana salvos.');
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
    host.addEventListener('change',e=>{
      if(!model)return;
      const end=selectedIndex(), ix=model.dates.indexOf(e.target.value);
      if(ix<0)return;
      if(e.target.id==='weekly-from')setWindow(end-ix+1,end,true);
      else if(e.target.id==='weekly-view-date'){
        if(multiple)setWindow(ix-(end-periodSize+1)+1,ix,true);else goToEnd(ix);
      }
    });
    host.addEventListener('click',e=>{
      const b=e.target.closest('button');if(!b||!model||b.disabled)return;
      const end=selectedIndex();
      if(b.id==='weekly-prev')goToEnd(end-1);
      else if(b.id==='weekly-next')goToEnd(end+1);
      else if(b.id==='weekly-single' && multiple)setWindow(1,end,false);
      else if(b.id==='weekly-multiple' && !multiple)setWindow(Math.min(4,model.dates.length),end,true);
      else if(b.dataset.weekSize){setWindow(Number(b.dataset.weekSize),end,true);host.querySelector('[data-week-size="'+b.dataset.weekSize+'"]')?.focus({preventScroll:true});}
      else if(b.dataset.weekDate)setWindow(1,model.dates.indexOf(b.dataset.weekDate),false);
      else if(b.hasAttribute('data-week-edit'))openEdit(true);
    });
    host.addEventListener('keydown',e=>{
      if(e.target.id!=='weekly-rail')return;
      const end=selectedIndex(), keys={ArrowLeft:end-1,ArrowRight:end+1,Home:periodSize-1,End:model.dates.length-1};
      if(Object.hasOwn(keys,e.key)){e.preventDefault();goToEnd(keys[e.key]);}
    });
  });
  return {render};
})();
