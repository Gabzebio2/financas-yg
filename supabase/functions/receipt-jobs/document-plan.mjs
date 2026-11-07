// Net new entries for one confirmed folder snapshot. No network, model calls or writes.
import * as scheduleModule from '../../../js/installment-schedule.js';
import * as datesModule from '../../../js/import-dates.js';
import {checkC6Subtotals} from './c6-subtotals.mjs';

const schedule = scheduleModule.default || globalThis.InstallmentSchedule;
const dates = datesModule.default || globalThis.ImportDates;
const currencies = new Set(['BRL','PYG','CLP','USD','EUR','GBP','USDT','USDC']);
const maxTransactions = 10000;
const text = value => typeof value === 'string' ? value.trim() : '';
const fold = value => text(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').toLowerCase();
const accountKey = value => ['c6 bank','banco c6'].includes(fold(value)) ? 'c6' : fold(value);
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && value.slice(0,4)!=='0000' &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10)===value;
const operational = result => result.excluded.filter(e=>e.operacao!==false && e.motivo!=='resumo').length;
const categoryIssue = reason => /categor/i.test(reason) && !/valor|moeda|data|conta|tipo|parcela|duplic|opera[çc][aã]o/i.test(reason);

function issueForDocument(pages) {
  const total = pages[0]?.context?.totalPages;
  if (!total || pages.length!==total || pages.some((page,i)=>page.context?.totalPages!==total || page.context.pageStart!==i+1)) {
    return 'Faltam páginas do arquivo original.';
  }
  const c6 = checkC6Subtotals(pages);
  if (c6) return c6;
  let count = 0;
  const printedCounts = new Set();
  for (const page of pages) {
    const r = page.result;
    if (!r || !Array.isArray(r.itens) || r.itens.some(t=>!t || typeof t!=='object') ||
        !Array.isArray(r.excluded) || r.excluded.some(t=>!t || typeof t!=='object') || !Array.isArray(r.avisos) ||
        r.reviewMode!=='compared' || r.partial!==false || r.coverage?.complete!==true ||
        !Array.isArray(r.coverage.unreadablePages) || r.coverage.unreadablePages.length ||
        !Array.isArray(r.ledger?.missing) || r.ledger.missing.length ||
        !Array.isArray(r.ledger?.duplicates) || r.ledger.duplicates.length ||
        !Number.isSafeInteger(r.ledger.monetaryLines) || r.ledger.monetaryLines!==r.ledger.accounted ||
        r.avisos.length || (r.verified!==true && !r.itens.some(item=>item.invalid || item.revisar?.length))) {
      return 'A conferência da página '+page.context.pageStart+' com o original ficou incompleta.';
    }
    count += r.itens.length + operational(r);
    if (r.expectedCount!=null) printedCounts.add(r.expectedCount);
  }
  if (printedCounts.size && (printedCounts.size!==1 || !printedCounts.has(count))) {
    return 'A contagem impressa diverge das operações identificadas.';
  }
  return null;
}

function observedRow(item, page, index, categories, defaultCategory, statement) {
  const pageNo = page.context.pageStart;
  const account = text(item.instituicao) || text(page.result.cartao);
  const issues = Array.isArray(item.revisar) ? item.revisar : [];
  const category = categories.find(c=>fold(c)===fold(defaultCategory)) ||
    (!issues.some(categoryIssue) && categories.find(c=>fold(c)===fold(item.categoria))) || 'Outros';
  let desc = text(item.descricao).slice(0,1000);
  const suffix = /(?:^|[\s(–—-]+)(?:parcela|cuota|parc\.?)\s*(\d{1,2})\s*(?:\/|de|of)\s*(\d{1,2})\s*\)?$/i.exec(desc);
  const declared = text(item.parcela);
  const marker = declared ? /^(?:(?:parcela|cuota|parc\.?)\s*)?(\d{1,2})\s*(?:\/|de|of)\s*(\d{1,2})$/i.exec(declared) : suffix;
  const a = Number(marker?.[1]), b = Number(marker?.[2]);
  const hasPart = a>=1 && a<=b && b>=2;
  const badPart = declared && !hasPart || marker && suffix && (a!==+suffix[1] || b!==+suffix[2]);
  if (hasPart && suffix && !badPart) desc=desc.slice(0,suffix.index).trim() || desc;
  const c6 = page.result.statementCheck?.source==='c6_invoice';
  const sourceEvidence = text(item.evidencia).slice(0,300);
  const verifiedLine = !!sourceEvidence || item.sourceLines?.some(n=>Number.isSafeInteger(n) && n>0);
  return {
    date: text(item.data), desc, amount:item.valor, currency:item.moeda, type:item.tipo, account, category,
    installment:hasPart ? a+'/'+b : null, fixed:false, totalValue:null,
    referenceId:text(item.referencia).slice(0,160), sourcePage:pageNo, sourceEvidence,
    ...(item.cashback?.valor>0 && Number.isFinite(item.cashback.valor) && currencies.has(item.cashback.moeda)
      ? {cashback:{amount:item.cashback.valor,currency:item.cashback.moeda}} : {}),
    sourceDocumentId:page.document_id, receiptMonth:item.billingMonth || '', order:pageNo*1000+index, grupoSemData:item.grupoSemData===true,
    c6, physicalLine:(item.sourceLines || item.linhas || [])[0],
    dueDate:item.dueDate || page.result.statementCheck?.dueDate || statement?.dueDate,
    closingDate:item.closingDate || page.result.statementCheck?.closingDate || statement?.closingDate,
    bestPurchaseDay:item.bestPurchaseDay || page.result.statementCheck?.bestPurchaseDay || statement?.bestPurchaseDay,
    creditKind:item.creditKind==='card_payment'?'card_payment':null,
    c6Purchase:c6 && hasPart && item.reversedFee!==true,
    invalid:!!(item.invalid || badPart || !verifiedLine || c6 && !account), issues,
  };
}

function usable(row) {
  if (row.invalid || !row.desc || !validDate(row.date) || !Number.isFinite(row.amount) ||
      !(row.amount>0 && row.amount<=Number.MAX_SAFE_INTEGER) || !currencies.has(row.currency) ||
      !['receita','despesa'].includes(row.type) || row.c6Purchase && row.dateEstimated) return false;
  return row.issues.every(reason=>categoryIssue(reason) || row.dateEstimated && /data/i.test(reason) && !/moeda|valor|tipo/i.test(reason));
}

function transaction(row) {
  const tx = {date:row.date, desc:row.desc, amount:row.amount, currency:row.currency, type:row.type, account:row.account,
    category:row.category, installment:row.installment, fixed:false, totalValue:null, groupId:null, sourcePage:row.sourcePage};
  if (row.referenceId) tx.referenceId=row.referenceId;
  if (row.sourceEvidence) tx.sourceEvidence=row.sourceEvidence;
  if (row.cashback) tx.cashback=row.cashback;
  if (row.dateEstimated) Object.assign(tx,{dateEstimated:true,dateEstimate:row.dateEstimate});
  if (row.creditKind) tx.creditKind=row.creditKind;
  if (row.c6 && validDate(row.dueDate)) Object.assign(tx,{billDueDate:row.dueDate,billDateObserved:true});
  if (row.c6 && validDate(row.closingDate)) Object.assign(tx,{billClosingDate:row.closingDate,billDateObserved:true});
  if (row.c6 && Number.isInteger(row.bestPurchaseDay) && row.bestPurchaseDay>=1 && row.bestPurchaseDay<=31) tx.cardBestPurchaseDay=row.bestPurchaseDay;
  return tx;
}

// A saved entry can consume only one occurrence on the same document. Rows added by
// this document become candidates only for later documents, keeping equal printed rows.
function movementKey(tx) {
  return JSON.stringify([fold(tx.desc),tx.type,tx.currency,Number(tx.amount),tx.installment || '']);
}
function indexRows(index, rows) {
  for (const row of rows) {
    const key = movementKey(row);
    if (!index.has(key)) index.set(key,[]);
    index.get(key).push(row);
  }
}
function findMatch(tx, options, used) {
  const account = accountKey(tx.account), reference = fold(tx.referenceId);
  let best = null, bestScore = -1;
  for (const candidate of options || []) {
    if (used.has(candidate)) continue;
    const otherAccount = accountKey(candidate.account), ref = fold(candidate.referenceId);
    if (account && otherAccount && account!==otherAccount || reference && ref && reference!==ref) continue;
    if (tx.billDateObserved && candidate.billDateObserved && candidate.billClosingDate && tx.billClosingDate &&
        candidate.billClosingDate.slice(0,7)!==tx.billClosingDate.slice(0,7)) continue;
    const sameDate = tx.date===candidate.date;
    const delta = Math.abs(Date.parse(tx.date)-Date.parse(candidate.advance?.scheduledDate || candidate.date));
    if (!sameDate && !(tx.installment && account && account===otherAccount && delta<=35*86400000)) continue;
    const score = Number(sameDate)*4 + Number(!!account && account===otherAccount)*2 + Number(!!reference && reference===ref);
    if (score>bestScore) {best=candidate;bestScore=score;}
  }
  return best;
}

// Count exactly the lines printed, including payments and reversals, in cents.
// Scheduled positions for other months never contribute to an invoice total.
function summarizeStatement(checks,document,label) {
  const get=field=>checks.find(check=>check[field]!=null)?.[field]??null;
  const closingDate=get('closingDate');
  const result={document,label,closingDate,dueDate:get('dueDate'),bestPurchaseDay:get('bestPurchaseDay'),
    rows:checks.reduce((n,c)=>n+(c.rows || 0),0),version:checks.every(c=>c.version===2)?2:1};
  if (result.version!==2 || !validDate(closingDate) || checks.some(c=>c.closingDate && c.closingDate!==closingDate)) return result;
  const totals={accountingMonth:closingDate.slice(0,7),expenseCount:0,expenseCents:0,creditCount:0,creditCents:0,refundCents:0,paymentCents:0};
  for (const check of checks) {
    if (!Array.isArray(check.movements)) return result;
    for (const m of check.movements) {
      if (!m || !Number.isSafeInteger(m.cents) || m.cents<=0) return result;
      if (m.type==='despesa') {totals.expenseCents+=m.cents;totals.expenseCount++;}
      else if (m.type==='receita') {
        totals.creditCents+=m.cents;totals.creditCount++;
        if (m.section==='card_payment') totals.paymentCents+=m.cents;
        else if (m.section==='card') totals.refundCents+=m.cents;
      } else return result;
    }
  }
  if (Number.isSafeInteger(totals.expenseCents) && Number.isSafeInteger(totals.creditCents)) Object.assign(result,totals);
  return result;
}

export function planDocumentImport({pages,existing,categories=[],defaultCategory='',extraRows=[]}) {
  const report = {transactions:[],duplicates:0,excluded:0,skipped:0,blockedDocuments:[],statements:[],matches:[],sourceRefs:[],coverageError:''};
  if (!Array.isArray(pages) || !pages.length || !Array.isArray(existing) || extraRows?.length ||
      pages.some(p=>!p?.document_id || p.media_type!=='application/pdf')) {
    report.blockedDocuments.push({label:'Envio',reason:'A inclusão automática exige um lote de PDFs completos.'});
    return report;
  }
  const docs = new Map(), index = new Map(), series = [];
  indexRows(index,existing);
  for (const page of pages) {
    if (!docs.has(page.document_id)) docs.set(page.document_id,[]);
    docs.get(page.document_id).push(page);
  }
  const planned = new Map();
  function link(row,target) {
    if (row.c6) report.sourceRefs.push({document:row.sourceDocumentId,page:row.sourcePage,line:row.physicalLine,...target});
  }
  const matchById = new Map();
  function matchTx(id,tx,observed) {
    const m={id,date:tx.date,desc:tx.desc,type:tx.type,currency:tx.currency,amount:tx.amount,account:tx.account,installment:tx.installment,
      purchaseDate:tx.purchaseDate,seriesKey:tx.seriesKey,billDueDate:tx.billDueDate,billClosingDate:tx.billClosingDate,cardBestPurchaseDay:tx.cardBestPurchaseDay,creditKind:tx.creditKind,observed};
    if (!matchById.has(id) || observed) matchById.set(id,m);
  }
  let upperBound = 0;
  for (const parts of docs.values()) {
    parts.sort((a,b)=>(a.context?.pageStart || 0)-(b.context?.pageStart || 0));
    const label=text(parts[0].label).split(' · página')[0].slice(0,160) || 'Documento';
    const checks=parts.map(p=>p.result?.statementCheck).filter(c=>c?.source==='c6_invoice');
    const statement=checks.length ? summarizeStatement(checks,parts[0].document_id,label) : null;
    if (statement) report.statements.push(statement);
    const issue = issueForDocument(parts);
    if (issue) {report.blockedDocuments.push({label,reason:issue});continue;}
    const rows = dates.estimate(parts.flatMap(p=>p.result.itens.map((item,i)=>observedRow(item,p,i,categories,defaultCategory,statement))));
    const positions = rows.reduce((n,r)=>n+(r.c6Purchase ? Number(r.installment.split('/')[1]) : 1),0);
    if (positions>maxTransactions-upperBound) {
      report.blockedDocuments.push({label,reason:'O lote ultrapassa o limite de lançamentos por inclusão.'});continue;
    }
    upperBound += positions;
    report.excluded += parts.reduce((n,p)=>n+operational(p.result),0);
    const used = new Set(), added = [];
    for (const row of rows) {
      if (!usable(row)) {report.skipped++;continue;}
      if (row.c6Purchase) {series.push(row);continue;}
      const tx = transaction(row);
      const match = findMatch(tx,index.get(movementKey(tx)),used);
      if (match) {
        report.duplicates++;used.add(match);
        if(match.id) {if(row.c6)matchTx(match.id,tx,true);link(row,{id:match.id});}
        else link(row,{index:planned.get(match)});
      } else {
        const index=report.transactions.length+added.length;
        planned.set(tx,index);link(row,{index});added.push(tx);
      }
    }
    report.transactions.push(...added);
    indexRows(index,added);
  }
  for (const group of schedule.plan(series,existing)) {
    for (const slot of group.installments) {
      const printed=group.lines.filter(r=>Number(r.installment.split('/')[0])===slot.number);
      const row=printed[0] || group.line, tx=transaction(row);
      Object.assign(tx,{date:slot.date,purchaseDate:row.date,installment:slot.number+'/'+group.installments.length,
        groupId:group.groupId,seriesKey:group.seriesKey});
      delete tx.billClosingDate;delete tx.billDueDate;delete tx.billDateObserved;
      if (validDate(slot.billDueDate)) Object.assign(tx,{billDueDate:slot.billDueDate,billDateObserved:slot.billDateObserved===true});
      if (validDate(slot.billClosingDate)) Object.assign(tx,{billClosingDate:slot.billClosingDate,billDateObserved:slot.billDateObserved===true});
      if(slot.matchedId){
        report.duplicates++;matchTx(slot.matchedId,tx,!!printed.length);
        printed.forEach(r=>link(r,{id:slot.matchedId}));continue;
      }
      if (group.needsReview || slot.ambiguous) {report.skipped++;continue;}
      if (!printed.length) {delete tx.referenceId;delete tx.cashback;}
      printed.forEach(r=>link(r,{index:report.transactions.length}));
      report.transactions.push(tx);
    }
  }
  report.matches=[...matchById.values()];
  for(const statement of report.statements) {
    const refs=report.sourceRefs.filter(r=>r.document===statement.document);
    if (statement.version!==2 || refs.length!==statement.rows ||
        refs.some(r=>!Number.isInteger(r.line) || r.line<1 || (!r.id && !Number.isInteger(r.index))) ||
        new Set(refs.map(r=>r.page+'|'+r.line)).size!==refs.length ||
        report.blockedDocuments.some(d=>d.label===statement.label)) {
      report.coverageError='A leitura ainda não vinculou cada movimento da fatura a um lançamento. A fatura precisa ser relida.';
      break;
    }
    if (!statement.accountingMonth || refs.some(ref=>{
      const target=ref.id ? matchById.get(ref.id) : report.transactions[ref.index];
      return !target || (!target.observed && !target.billDateObserved) || target.billClosingDate!==statement.closingDate ||
        schedule.statementDate(target).slice(0,7)!==statement.accountingMonth;
    })) {
      report.coverageError='O mês de fechamento não confere em todos os movimentos impressos da fatura.';
      break;
    }
  }
  return report;
}
