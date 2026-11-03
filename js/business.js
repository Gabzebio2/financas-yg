/* The weekly view uses normal folder transactions, so edits, backups and sync share one ledger. */
'use strict';
const BusinessPanel = (() => {
  const el=id=>document.getElementById(id);
  const esc=value=>escapeHtml(String(value));
  const isoLabel=date=>date.split('-').reverse().join('/');
  const localeAmount=v=>new Intl.NumberFormat('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2}).format(v);
  const signed=t=>t.type==='despesa'?-t.amount:t.amount;
  const money=(v,c)=>localeAmount(v)+' '+c;
  const nextWeek=date=>new Date(Date.parse(date+'T12:00:00Z')+604800000).toISOString().slice(0,10);
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
  function render(ds){
    const panel=el('weekly-panel');if(!panel)return;
    panel.classList.toggle('hidden',ds.profile!=='pj');
    if(currentId!==ds.id){currentId=ds.id;selected='';}
    if(ds.profile!=='pj')return;
    const dates=weeks(ds), unit=ds.weekly?.currency||'USD';
    if(!dates.includes(selected))selected=dates.at(-1)||'';
    if(!selected){el('weekly-content').innerHTML='<p class="weekly-empty">Importe a aba Semanal da sua planilha ou anote a primeira semana. Aqui você vai acompanhar o ganho de cada conta.</p>';return;}
    const all=ds.transactions.filter(t=>t.weeklyRevenue&&t.currency===unit);
    const sums=new Map();for(const t of all)sums.set(t.date,(sums.get(t.date)||0)+signed(t));
    const recent=dates.filter(d=>d<=selected).slice(-8), max=Math.max(1,...recent.map(d=>Math.abs(sums.get(d)||0)));
    const current=all.filter(t=>t.date===selected);
    const accounts=new Map();for(const t of current)accounts.set(t.account,(accounts.get(t.account)||0)+signed(t));
    const rows=[...accounts].sort((a,b)=>b[1]-a[1]);
    el('weekly-content').innerHTML=`<div class="weekly-overview"><div><small>Ganho da semana</small><strong>${esc(money(sums.get(selected)||0,unit))}</strong></div><label>Semana até <select id="weekly-view-date">${dates.slice().reverse().map(d=>`<option value="${esc(d)}" ${d===selected?'selected':''}>${isoLabel(d)}</option>`).join('')}</select></label></div>
      <div class="weekly-grid"><section><h3>Últimas semanas</h3><div class="weekly-trend">${recent.map(d=>`<button type="button" data-week-date="${esc(d)}" aria-pressed="${d===selected}" title="${isoLabel(d)} · ${esc(money(sums.get(d)||0,unit))}" aria-label="${isoLabel(d)} · ${esc(money(sums.get(d)||0,unit))}"><i style="height:${Math.max(3,Math.abs(sums.get(d)||0)/max*100)}%" class="${sums.get(d)<0?'negative':''}"></i><small>${isoLabel(d).slice(0,5)}</small></button>`).join('')}</div></section>
      <section><h3>Ganhos por conta</h3><ul class="weekly-accounts">${rows.map(([a,v])=>`<li><span>${esc(a)}</span><strong>${esc(money(v,unit))}</strong></li>`).join('')}</ul></section></div>
      <button type="button" id="weekly-correct" class="btn-link">Editar esta semana</button>`;
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
    el('weekly-edit-date').value=existing&&selected?selected:last?nextWeek(last):todayISO();
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
    function select(date){const ds=Store.loadDataset(currentId);if(ds){selected=date;render(ds);}}
    el('weekly-content').addEventListener('change',e=>{if(e.target.id==='weekly-view-date')select(e.target.value);});
    el('weekly-content').addEventListener('click',e=>{const b=e.target.closest('button');if(b?.dataset.weekDate)select(b.dataset.weekDate);else if(b?.id==='weekly-correct')openEdit(true);});
  });
  return {render};
})();
