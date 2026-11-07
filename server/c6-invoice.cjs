'use strict';

const fold = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const months = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
const dated = /^(\d{1,2})\s+(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)\.?\s+(.+)$/i;
const money = /(?:^|\s)([+−–-]?\s*(?:\d{1,3}(?:\.\d{3})+|\d+),\d{2})\s*$/;
const cardTitle = /^transacoes (?:do|dos) cart(?:ao|oes)(?: (?:principal|adicional|virtual|fisico|adicionais))?$/;
const transferTitle = /^transferencias(?: (?:realizadas|enviadas|recebidas|pix))?$/;
const infoTitle = /^(?:resumo da fatura|pagamento (?:de|da) fatura|formas de pagamento|opcoes de pagamento|obrigacoes futuras)$/;
const postedPayment = /^(?:inclusao de pagamento|pagamento (?:de|da) fatura|liquidacao (?:de|da) fatura)$/;
const cents = s => Number(s.replace(/[.\s]/g,'').replace(',','').replace(/[−–]/,'-'));

function isoDate(year,month,day) {
  const iso = [year,String(month).padStart(2,'0'),String(day).padStart(2,'0')].join('-');
  return Number.isFinite(Date.parse(iso)) && new Date(iso).toISOString().slice(0,10)===iso ? iso : '';
}
function dateMatch(m) {
  return m ? isoDate(m[3].length===2 ? 2000+Number(m[3]) : Number(m[3]),Number(m[2]),Number(m[1])) : '';
}
function periods(lines,reference) {
  const header = [...lines,...(reference?.lines || []).map(fold)].join('\n');
  const closing = dateMatch(header.match(/(?:transacoes feitas ate|fechamento desta fatura em)\s+(\d{2})\/(\d{2})\/(\d{2,4})\b/));
  let due = dateMatch(header.match(/(?:^|\n)(?:data do )?vencimento:\s*(\d{2})\/(\d{2})\/(\d{4})\b/));
  if(!due && closing) {
    const m = header.match(/(?:^|\n)(?:data do )?vencimento:\s*(\d{1,2}) de ([a-z]+)/);
    const month = m && months.indexOf(m[2].slice(0,3))+1;
    if(month) {
      const year = Number(closing.slice(0,4)) + (month<Number(closing.slice(5,7)) ? 1 : 0);
      const candidate = isoDate(year,month,Number(m[1]));
      const days = (Date.parse(candidate)-Date.parse(closing))/86400000;
      if(days>=0 && days<=62) due=candidate;
    }
  }
  const day=Number(header.match(/\bmelhor dia (?:de compra|para comprar):\s*(\d{1,2})\b/)?.[1]);
  return {closingDate:closing,dueDate:due,closingMonth:closing.slice(0,7),billingMonth:due.slice(0,7),
    ...(day>=1 && day<=31 ? {bestPurchaseDay:day} : {})};
}
function purchaseDate(day,month,period,part) {
  const closing=period.closingDate;
  if(!closing) return '';
  if(part>=12){
    // The source prints only day and month. The confirmed position of the
    // installment distinguishes the original purchase year for long series.
    if(!period.dueDate)return '';
    const [year,monthDue]=period.dueDate.split('-').map(Number);
    const firstDueMonth=year*12+monthDue-1-(part-1);
    for(let lag=0;lag<=2;lag++){
      const candidateMonth=firstDueMonth-lag;
      if(candidateMonth%12!==month-1) continue;
      const date=isoDate(Math.floor(candidateMonth/12),month,day);
      if(date && date<=closing) return date;
    }
    return '';
  }
  const year=Number(closing.slice(0,4));
  const date=isoDate(year,month,day);
  if(!date) return '';
  return date>closing ? isoDate(year-1,month,day) : date;
}
function direction(description,amount,section) {
  const s = fold(description);
  if(/\b(estorno|reembolso|credito recebido|transferencia recebida|pix recebido|recebimento (?:via |de )?pix|ajuste a credito|credito em conta)\b/.test(s)) return 'receita';
  if(/\b(transferencia enviada|pix enviado)\b/.test(s)) return 'despesa';
  if(section==='transfer' && /^[+]/.test(amount.trim())) return 'receita';
  if(section==='transfer' && /^[-−–]/.test(amount.trim())) return 'despesa';
  if(section==='transfer') return '';
  return cents(amount)<0 ? 'receita' : 'despesa';
}
function markReversedFees(rows) {
  const matches=new Map();
  for(const row of rows) {
    if(row.section!=='card') continue;
    const label=fold(row.description).trim().replace(/\s+/g,' ');
    const fee=row.type==='despesa' && row.installment && /^(?:anuidade(?: diferenciada| do cartao)?|tarifa(?: de anuidade| do cartao| de manutencao do cartao)?)$/.test(label);
    const reversal=row.type==='receita' && /^estorno (?:da |de )?(?:tarifa|anuidade)(?: do cartao)?(?:\s*[-–—]\s*estorno)?$/.test(label);
    if(!fee && !reversal) continue;
    const key=JSON.stringify([row.cardBlock,row.date,row.value]);
    if(!matches.has(key)) matches.set(key,{fees:[], reversals:0});
    const pair=matches.get(key);
    if(fee) pair.fees.push(row);
    else pair.reversals++;
  }
  for(const pair of matches.values()){
    if(pair.fees.length===1 && pair.reversals===1) pair.fees[0].reversedFee=true;
  }
}
function inspect(ledger,reference) {
  if(!ledger.pdf || !ledger.lines.length) return null;
  const lines=ledger.lines.map(fold),text=lines.join('\n');
  const cover=/sua fatura com\s+vencimento em/.test(text) && /opcoes de pagamento/.test(text)
    && /pague com pix e libere seu limite/.test(text);
  const branded=/\bcartao c6\b|\bc6 (?:bank|carbon)\b|\bbanco c6\b/.test(text)
    && /valor da fatura|\bfatura\b/.test(text);
  if(!branded && !cover) return null;
  const hasTable=lines.some(s=>cardTitle.test(s)||transferTitle.test(s));
  // Only ignore unambiguous informational pages. An unknown layout still
  // goes through the ordinary visual reader, even if it mentions C6.
  if(!hasTable && !cover && !lines.some(s=>infoTitle.test(s))) return null;
  if(!hasTable && lines.some(s=>dated.test(s))) return null;
  const period=periods(lines,reference);
  const table={rows:[], excluded:[], unresolved:[], subtotals:[], ...period, info:!hasTable};
  if(table.info)return table;
  let section='',brl=false,cardBlock=0;
  for(let i=0;i<lines.length;i++){
    const s=lines[i],line=i+1;
    if(cardTitle.test(s) || transferTitle.test(s)) {section=cardTitle.test(s)?'card':'transfer'; brl=false;cardBlock++;continue;}
    if(infoTitle.test(s)){section='';continue;}
    if(!section) continue;
    if(/^(?:pagina\s+)?\d{1,3}\s*(?:\/|de)\s*\d{1,3}$/.test(s))continue;
    if(/valores? em reais|valor \(r\$\)/.test(s)) {brl=true;continue;}
    if(/subtotal deste cartao/.test(s)){
      cardBlock++;
      const m=money.exec(s);
      if(m)table.subtotals.push({line,cents:cents(m[1])});
      else table.unresolved.push(line);
      continue;
    }
    if(section==='card' && /^c6 \S.*\bfinal\s+\d{4}\b/.test(s)) cardBlock++;
    const m=dated.exec(ledger.lines[i]);
    if(!m) {
      if(money.test(s) || /^\d{1,2}[\s/]+(?:[a-z]{3}|\d{2})\b/.test(s)) table.unresolved.push(line);
      continue;
    }
    const amount=money.exec(m[3]);
    if(!amount || !brl) {table.unresolved.push(line);continue;}
    const value=cents(amount[1]), operation=m[3].slice(0,amount.index).trim();
    if(!Number.isSafeInteger(value) || !value || !operation || /\d,\d{2}(?:\s|$)/.test(operation)){
      table.unresolved.push(line);continue;
    }
    if(/^transferencia entre (?:minhas )?contas proprias\b/.test(fold(operation))) {
      table.excluded.push({descricao:operation,motivo:'transferencia_propria',operacao:true,explicacao:'Transferência explicitamente identificada entre contas próprias.',linhas:[line]});
      continue;
    }
    const part=operation.match(/\s+[-–—]\s*parcela\s+(\d{1,2})\s*\/\s*(\d{1,2})$/i);
    if((/\bparcela\b/i.test(operation) && !part) || (part && (+part[1]<1 || +part[1]>+part[2]))){table.unresolved.push(line);continue;}
    const description=(part?operation.slice(0,part.index):operation).trim();
    const date=purchaseDate(+m[1],months.indexOf(fold(m[2]))+1,period,part? +part[1]:1);
    const cardPayment=section==='card' && postedPayment.test(fold(operation));
    const type=cardPayment?'receita':direction(description,amount[1],section);
    if(!date || !description || !type){table.unresolved.push(line);continue;}
    table.rows.push({line,date,description,value:Math.abs(value),type,section,cardBlock,cardPayment,installment:part?`${+part[1]}/${+part[2]}`:'',evidence:ledger.lines[i]});
  }
  // A recognizable table with no attributable operations cannot be silently
  // considered an informational page (e.g. dates rendered as outlines).
  table.emptyTable=!table.rows.length && !table.excluded.length;
  markReversedFees(table.rows);
  return table;
}

function reconcile(raw,table,categories) {
  const items=Array.isArray(raw.itens)?raw.itens:[];
  const other=categories.find(c=>fold(c)==='outros')||'Outros';
  const fromLine=n=>items.filter(r=>Array.isArray(r.linhas)&&r.linhas.includes(n));
  const resolved=table.rows.map(r=>{
    const matches=fromLine(r.line), suggested=matches.length===1?matches[0].categoria:null;
    return {data:r.date,descricao:r.description,valor:r.value/100,moeda:'BRL',tipo:r.type,
      parcela:r.installment,categoria:categories.includes(suggested)?suggested:other,instituicao:'C6',
      ...(r.reversedFee?{reversedFee:true}:{}),
      ...(r.cardPayment?{creditKind:'card_payment'}:{}),
      referencia:'',evidencia:r.evidence,linhas:[r.line],incertezas:[],
      cobranca:{valor:r.value/100,moeda:'BRL',origem:'debito_explicito'},cashback:{valor:null,moeda:''}};
  });
  const unresolved=new Set(table.unresolved);
  const uncertain=items.filter(r=>Array.isArray(r.linhas) && r.linhas.some(n=>unresolved.has(n)));
  const avisos=table.emptyTable || unresolved.size ? ['A tabela C6 contém movimentos que não puderam ser conferidos pelas colunas do original.'] : [];
  return {cartao:'C6',itens:[...resolved,...uncertain].map(row=>({...row,
    ...(table.billingMonth?{billingMonth:table.billingMonth}:{}),...(table.closingMonth?{closingMonth:table.closingMonth}:{}),...cycleEvidence(table)})),
    excluidos:table.excluded,completo:!avisos.length,contagemOperacoes:null,avisos};
}
function cycleEvidence(table) {
  return {...(table.dueDate?{dueDate:table.dueDate}:{}),...(table.closingDate?{closingDate:table.closingDate}:{}),
    ...(table.bestPurchaseDay?{bestPurchaseDay:table.bestPurchaseDay}:{})};
}
function evidence(table) {
  return {source:'c6_invoice',version:2,rows:table.rows.length,complete:!table.unresolved.length&&!table.emptyTable,
    billingMonth:table.billingMonth,closingMonth:table.closingMonth,...cycleEvidence(table),subtotals:table.subtotals,
    movements:table.rows.map(r=>({line:r.line,cents:r.value,type:r.type,section:r.cardPayment?'card_payment':r.section})),
    // A posted payment credits the account but is outside the printed purchase subtotal.
    payments:table.rows.filter(r=>r.cardPayment).map(r=>({line:r.line,cents:r.value})),
    entries:table.rows.filter(r=>r.section==='card'&&!r.cardPayment).map(r=>({line:r.line,cents:r.type==='despesa'?r.value:-r.value}))};
}
const instructions='FATURA C6: leia exclusivamente as tabelas Transações do cartão e Transferências. Nelas, “11 ago LOJA - Parcela 3/5 164,90” é uma despesa da fatura, no valor de 164,90 BRL, compra em 11 de agosto, parcela 3/5. Inclua TODA parcela listada, ainda que a data da compra seja de meses anteriores. Preserve a data impressa, a parcela atual, o cartão e uma única cobrança. Não projete outras parcelas nesta etapa de leitura. “Inclusão de Pagamento” em uma linha datada da tabela do cartão é uma entrada de pagamento da fatura. Registre-a uma vez na data da linha, separada do subtotal de compras. Ignore instruções de pagamento, resumos, simulações, anuidade repetida no resumo, boleto, limites ou obrigações futuras. Estorno de tarifa cobrada na tabela é crédito. Toda linha da tabela com valor deve ter um destino verificável. Se o formato de data ou valor estiver ilegível, identifique a linha que precisa de conferência.';
module.exports={inspect,reconcile,evidence,instructions};
