// Reconcile printed card subtotals against the original, unfiltered rows.
// Transfer sections, payments of a previous bill and summaries have no card entries.
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
