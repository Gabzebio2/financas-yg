'use strict';
const fold=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const DATE=/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}:\d{2})\s+(\d+)\s+(.*)$/;
const DATE_START=/^\d{2}\/\d{2}\/\d{4}\b/;
const MONEY='[+−–-]?\\s*(?:\\d{1,3}(?:\\.\\d{3})+|\\d+)';
const VALUES=new RegExp('^(.*?)\\s*('+MONEY+')\\s+('+MONEY+')$');
const SUMMARY=new RegExp('^Saldo (inicial|final)\\s+('+MONEY+')$','i');
function integer(s){const v=String(s).replace(/\s/g,'').replace(/[−–]/g,'-');if(!new RegExp('^'+MONEY+'$').test(v))return null;const n=Number(v.replace(/\./g,''));return Number.isSafeInteger(n)?n:null;}
function header(ledger){
 const lines=ledger?.lines||[],text=lines.join('\n');
 const bank=/\bueno\s+bank\b/i.test(text)&&/reporte de movimientos/i.test(text)?'Ueno':'';
 const currencyLine=lines.find(s=>/\bmoneda\s*:/i.test(s));
 const label=currencyLine?fold(currencyLine.split(/moneda\s*:/i)[1]):'';
 const currency=/^\s*(guaran[ií]es|guaranies|pyg)\b/.test(label)?'PYG':/^\s*(dolares|usd)\b/.test(label)?'USD':/^\s*(reales|brl)\b/.test(label)?'BRL':'';
 return {bank,currency,hasCurrency:!!currencyLine};
}
function tableLines(ledger){
 const h=ledger.lines.findIndex(s=>/^fecha\s+comprobante\s+concepto\s+importe\s+saldo$/i.test(s.trim()));
 if(h<0)return [];
 return ledger.lines.flatMap((s,i)=>(i>h&&DATE_START.test(s)||SUMMARY.test(s))?[i+1]:[]);
}
function parseTable(ledger,reference){
 const own=header(ledger),parent=header(reference);
 const info={bank:own.bank||parent.bank,currency:own.hasCurrency?own.currency:parent.currency};
 const headerIndex=ledger.lines.findIndex(s=>/^fecha\s+comprobante\s+concepto\s+importe\s+saldo$/i.test(s.trim()));
 if(info.bank!=='Ueno'||info.currency!=='PYG'||headerIndex<0)return null;
 const rows=[],summaries=[];let invalid=false;
 for(let i=headerIndex+1;i<ledger.lines.length;i++){
  const line=ledger.lines[i],summary=SUMMARY.exec(line);
  if(summary){summaries.push({kind:summary[1].toLowerCase(),balance:integer(summary[2]),line:i+1});continue;}
  const m=DATE.exec(line);if(!m){if(DATE_START.test(line))invalid=true;continue;}
  const v=VALUES.exec(m[6]);if(!v){invalid=true;continue;}
  const amount=integer(v[2]),balance=integer(v[3]),date=`${m[3]}-${m[2]}-${m[1]}`;
  if(amount===null||amount===0||balance===null||!/^([01]\d|2[0-3]):[0-5]\d$/.test(m[4])||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date){invalid=true;continue;}
  rows.push({line:i+1,date,time:m[4],description:v[1].trim(),amount,balance,lines:[i+1]});
 }
 // Final balance often appears immediately before the column headings.
 ledger.lines.slice(0,headerIndex).forEach((s,i)=>{const m=SUMMARY.exec(s);if(m)summaries.push({kind:m[1].toLowerCase(),balance:integer(m[2]),line:i+1});});
 if(!rows.length)return null;
 // Wrapped descriptions sit above/below the date baseline. Assign them using
 // original PDF coordinates, never another operation's amount or running balance.
 const positioned=ledger.positioned||[];
 for(let i=0;i<rows.length;i++){
  const r=rows[i],y=positioned[r.line-1]?.y;
  if(y===undefined){if(!r.description)invalid=true;continue;}
  const fragments=[{y,text:r.description}];
  for(let n=headerIndex+1;n<ledger.lines.length;n++){
   if(rows.some(row=>row.line===n+1)||SUMMARY.test(ledger.lines[n]))continue;
   const p=positioned[n];if(!p||Math.abs(p.y-y)>12)continue;
   const nearest=rows.reduce((best,row)=>Math.abs((positioned[row.line-1]?.y??Infinity)-p.y)<Math.abs((positioned[best.line-1]?.y??Infinity)-p.y)?row:best,rows[0]);
   if(nearest!==r||/ueno bank|este detalle|este producto|auditor|pagina/i.test(fold(ledger.lines[n])))continue;
   if(p.items?.every(t=>t.x>150&&t.x<440)){fragments.push({y:p.y,text:ledger.lines[n]});r.lines.push(n+1);}
  }
  r.description=fragments.sort((a,b)=>b.y-a.y).map(f=>f.text).filter(Boolean).join(' ').trim();
  if(!r.description)invalid=true;
 }
 let balanceChecks=0;
 for(let i=0;i<rows.length-1;i++){
  // Ueno's report is newest first. Do not silently accept a reordered layout.
  if(rows[i].date+'T'+rows[i].time<rows[i+1].date+'T'+rows[i+1].time||rows[i].balance!==rows[i+1].balance+rows[i].amount)invalid=true;
  balanceChecks++;
 }
 for(const s of summaries){const expected=s.kind==='final'?rows[0].balance:rows.at(-1).balance-rows.at(-1).amount;if(s.balance!==expected)invalid=true;balanceChecks++;}
 return {rows,summaries,currency:'PYG',bank:'Ueno',complete:!invalid&&balanceChecks>0,balanceChecks};
}
function reconcile(raw,table,categories){
 if(!table?.complete)return raw;
 const original=Array.isArray(raw?.itens)?raw.itens:[];
 const fallback=categories.find(c=>fold(c)==='outros')||'';
 return {...raw,cartao:'Ueno',completo:true,avisos:[],contagemOperacoes:null,
  itens:table.rows.map(r=>{
   const matches=original.filter(item=>Array.isArray(item.linhas)&&item.linhas.includes(r.line));
   const match=matches.length===1?matches[0]:null;
   return {data:r.date,descricao:r.description,valor:Math.abs(r.amount),moeda:'PYG',tipo:r.amount<0?'despesa':'receita',categoria:categories.includes(match?.categoria)?match.categoria:fallback,parcela:'',instituicao:'Ueno',referencia:'',evidencia:`${r.date} ${r.time} · Importe ${r.amount} PYG`,incertezas:[],linhas:r.lines,cobranca:{valor:Math.abs(r.amount),moeda:'PYG',origem:'debito_explicito'},cashback:{valor:null,moeda:''}};
  }),excluidos:table.summaries.map(s=>({descricao:'Saldo '+s.kind,motivo:'resumo',operacao:false,explicacao:'Saldo da conta: usado somente na conferência, nunca como lançamento.',linhas:[s.line]}))};
}
const STATEMENT_PROMPT=`EXTRATOS EM TABELA: a moeda declarada no cabeçalho (Moneda/Moeda/Currency) vale para os valores da tabela mesmo sem símbolo em cada linha. Guaraníes/Guaranies/Guaranis = PYG; 703.720 são 703720 guaranis, não 703,72 nem USD. Ueno não prova sozinho a moeda: use o cabeçalho original ou a referência do mesmo documento. Em Reporte de Movimientos do Ueno, use APENAS a coluna Importe como valor da operação. Sinal negativo antes de Importe é despesa; valor sem menos ou com + é receita, inclusive devolução/estorno de compra ou IVA. A descrição de um estabelecimento não transforma crédito em despesa. Saldo à direita é o saldo corrente APÓS aquela operação, NUNCA outro lançamento nem valor da compra. Saldo inicial/final são resumos. Comprobante pode repetir em compra e IVA, ou em débito e estorno: não é necessariamente ID único; nesse extrato deixe referencia vazia e preserve todas as linhas reais. Datas com hora pertencem à operação; a data de emissão do relatório não é a data do movimento. A referência de cabeçalho, quando fornecida, contém somente contexto de moeda/banco do MESMO arquivo: não extraia operações de outras páginas.`;
module.exports={header,tableLines,parseTable,reconcile,STATEMENT_PROMPT,integer};
