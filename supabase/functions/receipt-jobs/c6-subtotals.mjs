// Reconcile printed card subtotals against the original, unfiltered rows.
// Transfer sections, payments of a previous bill and summaries have no card entries.
function checkMovements(proof,items) {
  if(!Array.isArray(proof.movements) || !Array.isArray(proof.payments) || !Array.isArray(items) ||
     proof.rows!==proof.movements.length || proof.rows!==items.length) return false;
  const byLine = new Map(), entries = new Map(), payments = new Map();
  for(const movement of proof.movements) {
    if(!movement || !Number.isSafeInteger(movement.line) || movement.line<1 || byLine.has(movement.line) ||
       !Number.isSafeInteger(movement.cents) || movement.cents<=0 || !['receita','despesa'].includes(movement.type)) return false;
    byLine.set(movement.line,movement);
    if(movement.section==='card') entries.set(movement.line,movement.type==='despesa'?movement.cents:-movement.cents);
    else if(movement.section==='card_payment' && movement.type==='receita') payments.set(movement.line,movement.cents);
    else if(movement.section!=='transfer') return false;
  }
  for(const item of items) {
    const lines = item?.sourceLines ?? item?.linhas;
    if(!Array.isArray(lines) || lines.length!==1) return false;
    const movement=byLine.get(lines[0]);
    if(!movement || item.moeda!=='BRL' || item.tipo!==movement.type || item.valor!==movement.cents/100 ||
       (item.creditKind==='card_payment') !== (movement.section==='card_payment')) return false;
    byLine.delete(lines[0]);
  }
  function matches(source,stamped) {
    if(source.length!==stamped.size) return false;
    for(const row of source){
      if(!row || !stamped.has(row.line) || stamped.get(row.line)!==row.cents) return false;
      stamped.delete(row.line);
    }
    return true;
  }
  return byLine.size===0 && matches(proof.entries,entries) && matches(proof.payments,payments);
}
function checkCardPages(pages) {
  const sorted = [...pages].sort((a,b) => a.context.pageStart - b.context.pageStart);
  const pageCount = sorted[0].context.totalPages;
  if (sorted.length !== pageCount || sorted.some((p,i) => !p.result || p.context.totalPages !== pageCount || p.context.pageStart !== i + 1)) {
    return 'Faltam páginas para conferir os subtotais dos cartões C6.';
  }
  let card = null;
  const mismatch = () => card && card.total !== card.printed ?
    'A soma das compras e estornos diverge do subtotal do cartão C6 iniciado na página ' + card.page + '.' : null;
  for (const page of sorted) {
    const check = page.result.statementCheck;
    const pageNumber = page.context.pageStart;
    if (check?.source !== 'c6_invoice') {
      // Unknown informational layouts are harmless only when the final reader
      // found no operations. An unexplained transaction cannot join a C6 batch.
      const {itens,excluded,partial} = page.result;
      if (!Array.isArray(itens) || itens.length || partial !== false ||
          excluded?.some(e => e.operacao !== false && e.motivo !== 'resumo')) {
        return 'Não foi possível conferir as operações da página ' + pageNumber + ' nas seções de cartão ou transferências da fatura C6.';
      }
      continue;
    }
    const error = 'A leitura da página ' + pageNumber + ' da fatura C6 está incompleta.';
    if (!check.complete || page.result.partial || !Array.isArray(check.entries) || !Array.isArray(check.subtotals)) return error;
    // Old private drafts did not retain per-operation evidence. A newer
    // draft must include each source movement, even when its value is not
    // part of a printed purchase subtotal (e.g. a posted card payment).
    if ((check.version!=null || check.movements!=null || check.payments!=null) &&
        (check.version!==2 || !checkMovements(check,page.result.itens))) return error;
    const events = [
      ...check.subtotals.map(s => ({...s, subtotal:true})),
      ...check.entries.map(e => ({...e, subtotal:false})),
    ].sort((a,b) => a.line - b.line);
    const usedLines = new Set();
    for (const event of events) {
      if (!Number.isSafeInteger(event.line) || event.line < 0 || usedLines.has(event.line) || !Number.isSafeInteger(event.cents)) return error;
      usedLines.add(event.line);
      if (event.subtotal) {
        const issue = mismatch();
        if (issue) return issue;
        card = {printed:event.cents, total:0, page:pageNumber};
      } else if (card) {
        card.total += event.cents;
        if (!Number.isSafeInteger(card.total)) return error;
      }
    }
  }
  return mismatch();
}

export function checkC6Subtotals(pages) {
  const docs = new Map();
  for (const p of pages) {
    if (!docs.has(p.document_id)) docs.set(p.document_id, []);
    docs.get(p.document_id).push(p);
  }
  for (const [documentId, parts] of docs) {
    if (!parts.some(p => p.result?.statementCheck?.source === 'c6_invoice')) continue;
    if (!documentId || parts.some(p => !p.context)) return 'Não foi possível identificar todas as páginas da fatura C6.';
    const error = checkCardPages(parts);
    if (error) return error;
  }
  return null;
}

if (typeof window !== 'undefined') window.C6Subtotals = {check:checkC6Subtotals};
