'use strict';

// Vision supplies printed headings in reading order and the vertical centre of
// each amount, in thousandths of the crop height. No device/upload date is used.
const monthNames = [
  ['janeiro','enero','january','jan','ene'],['fevereiro','febrero','february','fev','feb'],
  ['marco','marzo','march','mar'],['abril','april','abr','apr'],['maio','mayo','may'],
  ['junho','junio','june','jun'],['julho','julio','july','jul'],['agosto','august','ago','aug'],
  ['setembro','septiembre','setiembre','september','set','sep','sept'],['outubro','octubre','october','out','oct'],
  ['novembro','noviembre','november','nov'],['dezembro','diciembre','december','dez','dic','dec']
];
const fold=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
const point=y=>Number.isInteger(y)&&y>=0&&y<=1000;
function iso(year,month,day){
  const value=[year,month,day].map((v,i)=>String(v).padStart(i?2:4,'0')).join('-');
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number(year)>0 && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0,10)===value ? value : '';
}
function headingDate(text){
  const s=fold(text);
  let m=s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if(m)return iso(m[1],m[2],m[3]);
  m=s.match(/\b(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})\b/);
  if(m)return iso(m[3],m[2],m[1]);
  m=s.match(/\b(\d{1,2})\s+(?:de\s+)?([a-z]+)\.?[,]?\s+(?:(?:de|del)\s+)?(\d{4})\b/);
  if(m)return iso(m[3],monthNames.findIndex(month=>month.includes(m[2]))+1,m[1]);
  m=s.match(/\b([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})\b/);
  return m?iso(m[3],monthNames.findIndex(month=>month.includes(m[1]))+1,m[2]):'';
}
function sliceBounds(context){
  const s=context?.imageSlice;
  if(!s||!Number.isInteger(s.height)||s.height<1||s.height>3200||
    ![s.before,s.after].every(n=>Number.isInteger(n)&&n>=0&&n<=120)||s.before+s.after>=s.height)return null;
  return {start:1000*s.before/s.height,end:1000*(1-s.after/s.height),
    nextTop:1000*(1-2*s.after/s.height)};
}
function imageContext(image,c){
  if(c.totalPages<2 || sliceBounds(c) || image.media_type!=='image/jpeg')return c;
  // Older clients also sent 120px overlaps without their dimensions. Read the
  // JPEG frame height so an upload already in the queue has the same ownership.
  const buf=Buffer.from(image.data,'base64');if(buf[0]!==255||buf[1]!==216)return c;
  for(let i=2;i+8<buf.length && buf[i]===255;){
    while(buf[i]===255)i++;
    const code=buf[i++];if(code===0xda||code===0xd9||i+7>=buf.length)break;
    const size=buf.readUInt16BE(i);if(size<2||i+size>buf.length)break;
    if([0xc0,0xc1,0xc2].includes(code)){
      const ctx={...c,imageSlice:{height:buf.readUInt16BE(i+3),before:c.pageStart>1?60:0,after:c.pageEnd<c.totalPages?60:0}};
      return sliceBounds(ctx)?ctx:c;
    }
    i+=size;
  }
  return c;
}
const dateOnlyIssue=s=>/\b(data|fecha|date)\b/.test(fold(s)) &&
  !/valor|moeda|moneda|importe|amount|currency|tipo|dire[cç]|receita|despesa|conta|cuenta|descri|sinal|signo|ilegivel.*linha/.test(fold(s));
function visualReading(raw,context,previousHeading){
  const meta=raw.leituraVisual, bound=sliceBounds(context);
  const heads=(meta?.cabecalhos||[]).filter(h=>point(h.y)).sort((a,b)=>a.y-b.y);
  const rows=[...raw.itens,...raw.excluidos.filter(r=>r.operacao!==false&&r.motivo!=='resumo')];
  const split=context?.totalPages>1;
  const list=split||meta?.layout==='lista'||heads.length>0||rows.length>1;
  const issues=[];
  if(list){
    if(!Number.isInteger(meta?.movimentosVisiveis)||meta.movimentosVisiveis!==rows.length)
      issues.push('A contagem visual não fecha com as operações lidas.');
    const bottom=Math.max(-1,...rows.map(r=>point(r.posicaoValor)?r.posicaoValor:-1));
    if(rows.length && (!meta?.ultimaDescricao || !rows.some(r=>(bottom===-1||r.posicaoValor===bottom)&&fold(r.descricao)===fold(meta.ultimaDescricao))))
      issues.push('O último movimento visível não está identificado na leitura.');
  }
  if(meta?.cabecalhos?.length!==heads.length && list)issues.push('A posição de um cabeçalho de data ficou indefinida.');
  if(((split && bound)||heads.length) && rows.some(r=>!point(r.posicaoValor)))issues.push('Faltou localizar um valor na imagem.');
  function owned(row){
    // A row without coordinates is kept for review, never silently discarded.
    if(!bound||!point(row.posicaoValor))return true;
    return row.posicaoValor>=bound.start && (context.pageEnd===context.totalPages||row.posicaoValor<bound.end);
  }
  function resolve(row){
    if(row.origemData==='linha' && row.data)return row;
    if(!point(row.posicaoValor))return (heads.length||split)&&!row.data?{...row,grupoSemData:true}:row;
    const heading=heads.filter(h=>h.y<=row.posicaoValor).at(-1)?.texto ?? previousHeading;
    if(heading==null)return row.origemData==='grupo'||(!row.data&&(heads.length||split))?
      {...row,data:'',grupoSemData:true,incertezas:[...(row.incertezas||[]),'Cabeçalho de data não identificado.']}:row;
    const data=headingDate(heading);
    if(!data)return {...row,data:'',grupoSemData:true,incertezas:[...(row.incertezas||[]),'Cabeçalho sem data completa.']};
    return {...row,data,incertezas:(row.incertezas||[]).filter(s=>!dateOnlyIssue(s)),dataDoCabecalho:true};
  }
  const carryHeads=bound?heads.filter(h=>h.y<bound.nextTop):heads;
  const last=carryHeads.at(-1);
  // A relative-only heading is still a boundary: pass its literal text, not the preceding date.
  const visualContext={complete:raw.completo===true && !issues.length && heads.length===(meta?.cabecalhos?.length??-1),
    lastHeading:last?String(last.texto).slice(0,100):null};
  return {raw:{...raw,itens:raw.itens.filter(owned).map(resolve),excluidos:raw.excluidos.filter(owned)},visualContext,
    audit:{list,issues,simple:!list&&meta?.layout==='individual'&&meta.movimentosVisiveis===1&&rows.length===1&&fold(rows[0].descricao)===fold(meta.ultimaDescricao),
      visibleCount:meta?.movimentosVisiveis??null,last:meta?.ultimaDescricao||''}};
}
// Match individual occurrences, not just counts. The stronger reader can
// explicitly correct or exclude a draft row if it points to the original.
function checkFirstRows(first,final,corrections){
  const available=[...final.itens,...final.excluded.filter(x=>x.operacao!==false&&x.motivo!=='resumo')];
  const explained=Array.isArray(corrections)?corrections.slice():[];
  const unmatched=[];
  for(const item of first.itens){
    const i=available.findIndex(x=>(fold(x.descricao)===fold(item.descricao) || (item.referencia && x.referencia===item.referencia)) &&
      (x.motivo ? !!x.explicacao : ['valor','moeda','tipo','data'].every(k=>item[k]==null||item[k]===''||x[k]===item[k])));
    if(i>=0)available.splice(i,1);else unmatched.push(item);
  }
  for(const item of unmatched){
    const i=explained.findIndex(x=>fold(x.descricaoAnterior)===fold(item.descricao) && x.evidencia?.trim() &&
      (x.destino==='nao_operacao'||available.some(r=>fold(r.descricao)===fold(x.descricaoFinal))));
    if(i<0)return 'Uma operação da primeira leitura não foi explicada na conferência.';
    const [change]=explained.splice(i,1);
    if(change.destino!=='nao_operacao'){
      const replaced=available.findIndex(x=>fold(x.descricao)===fold(change.descricaoFinal));
      available.splice(replaced,1);
    }
  }
  return '';
}
module.exports={headingDate,sliceBounds,imageContext,visualReading,checkFirstRows};
