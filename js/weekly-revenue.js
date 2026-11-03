/* Receitas por semana: cada célula representa o ganho de uma conta no período. */
'use strict';
const WeeklyRevenue = (() => {
  const months = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
  const normalized = v => String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase();
  const key = (account,date,currency) => JSON.stringify([normalized(account),date,currency]);
  function endpoint(text) {
    const m=normalized(text).match(/(\d{1,2})\s*(?:\/\s*(\d{1,2})|\s*([a-z]{3,9}))(?:\/(\d{4}))?\s*$/);
    if(!m)return null;
    const month=m[2]?Number(m[2]):months.indexOf(m[3].slice(0,3))+1;
    if(month<1||month>12||Number(m[1])<1||Number(m[1])>31)return null;
    return {day:Number(m[1]),month,year:m[4]?Number(m[4]):0};
  }
  function dateColumns(headers,year,snapshots){
    const items=[];
    headers.forEach((v,col)=>{
      const label=normalized(v);
      if(!(snapshots?/^(?:acumulado\s+)?ate\s+/:/\s+a\s+/).test(label))return;
      const md=endpoint(label);if(!md)throw Error('A data da coluna “'+v+'” não foi reconhecida.');
      items.push({col,...md});
    });
    const chronological=snapshots?items.slice().reverse():items;
    let nextMonth=0;
    for(const x of chronological.slice().reverse()){
      if(x.year)year=x.year;else if(nextMonth && x.month>nextMonth)year--;
      const dt=new Date(Date.UTC(year,x.month-1,x.day));
      if(dt.getUTCMonth()!==x.month-1)throw Error('A planilha contém uma data inválida.');
      x.date=dt.toISOString().slice(0,10);nextMonth=x.month;
    }
    if(new Set(items.map(x=>x.date)).size!==items.length)throw Error('Há duas colunas para a mesma semana.');
    return chronological;
  }
  function amount(v){
    if(v==null || v==='')return null;
    if(typeof v==='number' && Number.isFinite(v))return v;
    const str=String(v).trim();
    if(!/^-?\d+(?:[.,]\d+)?$/.test(str))return NaN;
    return Number(str.replace(',','.'));
  }
  const cents=v=>Math.round((v+Number.EPSILON)*100)/100;
  function parse(workbook,year,X){
    if(!Number.isInteger(year)||year<2000||year>2100)throw Error('Informe o ano da última semana.');
    const name=workbook.SheetNames.find(n=>normalized(n)==='semanal');
    if(!name)throw Error('A planilha precisa ter uma aba “Semanal”, com as contas na primeira coluna.');
    const sheet=workbook.Sheets[name],range=X.utils.decode_range(sheet['!ref']||'A1');
    if(range.e.r>20000||range.e.c>1200)throw Error('A aba Semanal é muito grande para importar.');
    const data=X.utils.sheet_to_json(sheet,{header:1,raw:true,blankrows:true,range:0});
    const h=data.findIndex(row=>row.some(cell=>typeof cell==='string'&&(/\s+a\s+/.test(normalized(cell))||/^(?:acumulado\s+)?ate\s+/.test(normalized(cell)))&&endpoint(cell)));
    if(h<0)throw Error('Não encontrei colunas com intervalos ou datas de fechamento na aba Semanal.');
    let columns=dateColumns(data[h],year,false), snapshots=false;
    if(!columns.length){columns=dateColumns(data[h],year,true);snapshots=true;}
    const entries=[],accounts=[],names=new Set();let skipped=0;
    for(let r=h+1;r<data.length;r++){
      const row=data[r],account=String(row[0]??'').trim();
      if(!account || /^(total|soma|resumo)\b/i.test(account))continue;
      if(names.has(normalized(account)))throw Error('Conta repetida na aba Semanal: '+account);
      if(account.length>120 || accounts.length>=300)throw Error('Confira os nomes das contas na primeira coluna.');
      names.add(normalized(account));accounts.push(account);
      let prev=null;
      for(const c of columns){
        const cell=sheet[X.utils.encode_cell({r,c:c.col})];
        const v=cell?.t==='e'?NaN:amount(row[c.col]);
        if(Number.isNaN(v))skipped++;
        const delta=snapshots?(Number.isFinite(prev)&&Number.isFinite(v)?cents(v-prev):null):v;
        if(Number.isFinite(delta))entries.push({account,date:c.date,amount:cents(delta)});
        prev=v;
      }
    }
    if(!entries.length)throw Error('Não encontrei ganhos numéricos nas contas da aba Semanal.');
    return {accounts,entries,skipped,snapshots};
  }
  function apply(ds, entries, currency, imported, makeId){
    const idx=new Map(ds.transactions.filter(t=>t.weeklyRevenue).map(t=>[key(t.account,t.date,t.currency),t]));
    let added=0,updated=0,conflicts=0;
    for(const row of entries){
      const k=key(row.account,row.date,currency),old=idx.get(k),value=cents(row.amount);
      const signed=old && (old.type==='despesa'?-1:1)*old.amount;
      if(old && imported && signed!==value && old.weeklyImportedAmount!==signed){conflicts++;continue;}
      if(old && signed===value && (!imported || old.weeklyImportedAmount===value))continue;
      const t=old || {id:makeId(),date:row.date,account:row.account,desc:'Ganho semanal · '+row.account,
        category:'Receita semanal',weeklyRevenue:true,groupId:null,installment:null,totalValue:null,fixed:false,currency};
      t.amount=Math.abs(value);t.type=value<0?'despesa':'receita';
      if(imported)t.weeklyImportedAmount=value;
      if(!old){ds.transactions.push(t);idx.set(k,t);added++;}else updated++;
    }
    return {added,updated,conflicts};
  }
  const nextWeek=date=>new Date(Date.parse(date+'T12:00:00Z')+604800000).toISOString().slice(0,10);
  function periodModel(txs,unit){
    const groups=new Map();
    for(const t of txs){
      if(!t.weeklyRevenue || t.currency!==unit)continue;
      if(!groups.has(t.date))groups.set(t.date,{accounts:new Map(),total:0});
      const group=groups.get(t.date),cents=Math.round(t.amount*100)*(t.type==='despesa'?-1:1);
      group.total+=cents;group.accounts.set(t.account,(group.accounts.get(t.account)||0)+cents);
    }
    const dates=[];
    for(const date of [...groups.keys()].sort()){
      // Some sheets move a closing day by a day or two between months.
      // Insert a missing week only when the gap is closer to two weeks than one.
      while(dates.length && (Date.parse(date)-Date.parse(dates.at(-1)))/86400000>10){
        dates.push(nextWeek(dates.at(-1)));
      }
      dates.push(date);
    }
    return {dates,groups,unit};
  }
  function periodSummary(model, start, end){
    const {dates,groups}=model, accounts=new Map();
    let total=0, reported=0;
    for(const date of dates.slice(start,end+1)){
      const week=groups.get(date);if(!week)continue;
      reported++;total+=week.total;
      for(const [a,v] of week.accounts)accounts.set(a,(accounts.get(a)||0)+v);
    }
    const rows=[...accounts].sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0]));
    return {total,reported,rows};
  }
  return {parse,apply,normalized,key,nextWeek,periodModel,periodSummary};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=WeeklyRevenue;
