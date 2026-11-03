'use strict';
const ImportDates = require('../js/import-dates.js');
const currencies = new Set(['BRL','PYG','CLP','USD','EUR','GBP','USDT','USDC']);

// The provider's result has already reconciled local/debited currencies and
// removed balances, declined operations, own transfers and isolated cashback.
function photoPlan(result, context, categories) {
  const rows = ImportDates.estimate(result.itens.map((item, index) => ({
    date: item.data, sourceDocumentId: 'photo', order: index
  })));
  const excluded = result.excluded || [];
  const counted = rows.length + excluded.filter(x => x.operacao !== false && x.motivo !== 'resumo').length;
  const incomplete = result.partial || result.coverage?.complete !== true ||
    (result.expectedCount != null && result.expectedCount !== counted);
  const entries = result.itens.map((item, index) => {
    const date = rows[index];
    const desc = (item.descricao || '').trim();
    const issues = (item.revisar || []).filter(msg => !(date.dateEstimated && /data/i.test(msg) && !/moeda|valor|tipo/i.test(msg)));
    const installment = (item.parcela || '').trim();
    const valid = /^\d{4}-\d{2}-\d{2}$/.test(date.date || '') && date.date.slice(0,4) !== '0000' &&
      Number.isFinite(Date.parse(date.date)) && new Date(date.date).toISOString().slice(0,10) === date.date &&
      desc && Number.isFinite(item.valor) && item.valor > 0 && item.valor <= Number.MAX_SAFE_INTEGER &&
      currencies.has(item.moeda) && ['despesa','receita'].includes(item.tipo) && (!installment || /^\d{1,2}\/\d{1,2}$/.test(installment));
    if (incomplete || !valid || issues.length) return {name: desc, reason: incomplete ? 'Leitura incompleta' : issues[0] || 'Dados incompletos'};
    const account = item.instituicao || result.cartao || '';
    const category = [context.photoCategory, item.categoria].find(c => categories.includes(c)) || 'Outros';
    const tx = {desc, date:date.date, amount:item.valor, currency:item.moeda, type:item.tipo, account, category,
      referenceId:item.referencia || '', sourceEvidence:item.evidencia || '', sourcePage:context.pageStart,
      installment:installment || null, groupId:null, fixed:false, totalValue:null};
    if (date.dateEstimated) Object.assign(tx, {dateEstimated:true, dateEstimate:date.dateEstimate});
    if (item.cashback?.valor > 0 && currencies.has(item.cashback.moeda))
      tx.cashback = {amount:item.cashback.valor, currency:item.cashback.moeda};
    return {tx};
  });
  if (incomplete && !entries.length) entries.push({reason:'Leitura incompleta'});
  return {entries, excluded:excluded.filter(x=>x.operacao !== false && x.motivo !== 'resumo').length};
}
module.exports = {photoPlan};
