/* Planejamento de parcelas. A evidência da fatura é avaliada antes e separadamente. */
"use strict";
const InstallmentSchedule = (() => {
  const text = value => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim().replace(/\s+/g, " ");
  function parts(tx) {
    const match = /^(\d{1,3})\/(\d{1,3})$/.exec(tx.installment || "");
    if (!match) return null;
    const current = Number(match[1]), total = Number(match[2]);
    return current >= 1 && current <= total && total > 1 ? {current,total} : null;
  }
  function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
    const time = Date.parse(value);
    return Number.isFinite(time) && new Date(time).toISOString().slice(0,10) === value;
  }
  function shift(date, months) {
    if (!validDate(date)) return "";
    const [year,month,day] = date.split("-").map(Number);
    const last = new Date(Date.UTC(year, month + months, 0));
    last.setUTCDate(Math.min(day,last.getUTCDate()));
    return last.toISOString().slice(0,10);
  }
  // A data nominal é usada para reconhecer uma compra quando ela reaparece.
  // Nos filtros e totais vale o mês de fechamento, inclusive para compras
  // avulsas, créditos e parcelas conciliadas com anotações antigas.
  function statementDate(tx) {
    if (!validDate(tx.billClosingDate)) return tx.date;
    const source = validDate(tx.purchaseDate) ? tx.purchaseDate : tx.date;
    if (!validDate(source)) return tx.date;
    const [year, month] = tx.billClosingDate.split("-").map(Number);
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const day = Math.min(Number(source.slice(8)), lastDay);
    return tx.billClosingDate.slice(0,8) + String(day).padStart(2,"0");
  }
  function applyBillingCycle(group) {
    const anchors = group.lines.map(line => {
      const due = validDate(line.dueDate) ? line.dueDate : "";
      const closing = validDate(line.closingDate) && (!due || line.closingDate<=due) ? line.closingDate : "";
      return {number:parts(line).current,due,closing};
    }).filter(anchor=>anchor.due || anchor.closing);
    if (!anchors.length) return;
    for (const slot of group.installments) {
      const anchor = anchors.reduce((best,a) => {
        const distance = Math.abs(slot.number-a.number), bestDistance = Math.abs(slot.number-best.number);
        return distance<bestDistance || distance===bestDistance && (a.closing || a.due)>(best.closing || best.due) ? a : best;
      });
      const offset = slot.number-anchor.number;
      if (anchor.due) slot.billDueDate = shift(anchor.due,offset);
      if (anchor.closing) slot.billClosingDate = shift(anchor.closing,offset);
      slot.billDateObserved = offset===0;
    }
  }
  function fields(tx, part) {
    let desc = text(tx.desc).slice(0,1000);
    const suffix = /\s*[-–—]\s*parcela\s+(\d+)\s*\/\s*(\d+)$/.exec(desc);
    if (suffix && Number(suffix[1]) === part.current && Number(suffix[2]) === part.total) desc = desc.slice(0,suffix.index).trim();
    let account = text(tx.account).slice(0,100);
    if (["c6 bank","banco c6"].includes(account)) account = "c6";
    return [part.total, desc, tx.currency, tx.type, account, Number(tx.amount)];
  }
  function createGroups(lines) {
    const bases = new Map(), counts = new Map();
    lines.forEach(line => {
      const part = parts(line);
      if (!part) return;
      const economic = fields(line,part);
      const baseKey = JSON.stringify([line.date,...economic]);
      const occurrence = JSON.stringify([baseKey,line.sourceDocumentId || "",line.receiptMonth || "",part.current]);
      const ordinal = (counts.get(occurrence) || 0) + 1;
      counts.set(occurrence,ordinal);
      if (!bases.has(baseKey)) bases.set(baseKey,{date:line.date, signature:JSON.stringify(economic), groups:[]});
      const base = bases.get(baseKey);
      if (!base.groups[ordinal-1]) {
        const seriesKey = "c6:v1:" + JSON.stringify([base.date,...economic,ordinal]);
        const installments = Array.from({length:part.total},(_,i) => ({
          number:i+1,date:shift(base.date,i),printed:false,matchedId:null,ambiguous:false,
        }));
        const invalid = !validDate(base.date) || !economic[1] || !economic[4] || !Number.isFinite(economic[5]) || !(economic[5]>0) || seriesKey.length>2000;
        base.groups.push({line,lines:[],seriesKey,groupId:seriesKey,printedNumbers:[],installments,
          needsReview:invalid,reason:invalid?"Confira a data da compra, a conta e o valor antes de programar as parcelas.":""});
      }
      const group = base.groups[ordinal-1];
      group.lines.push(line);
      group.installments[part.current-1].printed = true;
      if (!group.printedNumbers.includes(part.current)) group.printedNumbers.push(part.current);
    });
    return [...bases.values()];
  }
  function caution(group, reason) {
    group.needsReview = true;
    if (!group.reason) group.reason = reason;
    group.installments.forEach(slot => { slot.ambiguous = true; });
  }
  function adopt(group, rows, groupId) {
    if (groupId) group.groupId = groupId;
    for (const tx of rows) {
      const part = parts(tx), slot = part && group.installments[part.current-1];
      if (!slot || group.installments.length !== part.total || !tx.id || slot.matchedId && slot.matchedId !== tx.id) {
        caution(group,"Existe mais de um lançamento para a mesma parcela. Confira a série na pasta.");
        continue;
      }
      slot.matchedId = tx.id;
    }
  }
  // Um vencimento antecipado continua ocupando o número da parcela original.
  function correspondence(candidate, base) {
    const offsets = candidate.rows.map(tx => {
      if (!parts(tx)) return null;
      if (validDate(tx.purchaseDate)) return tx.purchaseDate === base.date ? 0 : null;
      const date = tx.advance?.scheduledDate || tx.date;
      if (!validDate(date) || !validDate(base.date)) return null;
      return (Date.parse(date) - Date.parse(shift(base.date,parts(tx).current-1))) / 86400000;
    });
    const originalDate=i=>offsets[i]!==null && (candidate.rows[i].advance?.scheduledDate || candidate.rows[i].date)===base.date;
    if (!offsets.some((d,i) => d !== null && (Math.abs(d)<=35 || originalDate(i)))) return 0;
    if (candidate.signatures.size !== 1 || offsets.some(d => d === null)) return 1;
    if (offsets.every((d,i) => d===0 || originalDate(i))) return 4;
    if (offsets.some(d=>Math.abs(d)>35)) return 1;
    if (offsets.every(d => Math.abs(d)<=7)) return 3;
    // A diferença de um ciclo se repete ao longo da série antiga; o número da
    // parcela continua identificando o mesmo débito apesar dos meses lançados.
    const positions=new Set(candidate.rows.map(tx=>parts(tx).current));
    if (positions.size>1 && Math.max(...offsets)-Math.min(...offsets)<=7) return 2;
    return 1;
  }
  function plan(lines, existing) {
    const bases = createGroups(lines);
    const exactKeys = new Map(), claims = new Map(), legacyGroups = new Map(), legacyBySignature = new Map();
    for (const tx of existing || []) {
      if (tx.seriesKey) {
        if (tx.groupId) {
          if (!claims.has(tx.groupId)) claims.set(tx.groupId,new Set());
          claims.get(tx.groupId).add(tx.seriesKey);
        }
        if (!parts(tx)) continue;
        if (!exactKeys.has(tx.seriesKey)) exactKeys.set(tx.seriesKey,[]);
        exactKeys.get(tx.seriesKey).push(tx);
      } else {
        if (!parts(tx) && !tx.groupId) continue;
        const id = JSON.stringify(tx.groupId ? ["group",tx.groupId] : ["single",tx.id]);
        if (!legacyGroups.has(id)) legacyGroups.set(id,{id,groupId:tx.groupId || null,rows:[],signatures:new Set()});
        const candidate = legacyGroups.get(id);
        candidate.rows.push(tx);
        candidate.signatures.add(parts(tx) ? JSON.stringify(fields(tx,parts(tx))) : "");
      }
    }
    for (const candidate of legacyGroups.values()) {
      for (const sig of candidate.signatures) {
        if (!legacyBySignature.has(sig)) legacyBySignature.set(sig,[]);
        legacyBySignature.get(sig).push(candidate);
      }
    }
    const used = new Set(), owners = new Map();
    for (const base of bases) {
      base.matches = [];
      for (const candidate of legacyBySignature.get(base.signature) || []) {
        const bound=claims.get(candidate.groupId);
        if (bound && !base.groups.some(g=>bound.has(g.seriesKey))) continue;
        const rank = correspondence(candidate,base);
        if (!rank) continue;
        base.matches.push({candidate,rank});
        const prior=owners.get(candidate.id);
        if (!prior || rank>prior.rank) owners.set(candidate.id,{rank,count:1});
        else if(rank===prior.rank) prior.count++;
      }
      for (const group of base.groups) {
        const saved = exactKeys.get(group.seriesKey);
        if (!saved) continue;
        const ids = [...new Set(saved.map(tx=>tx.groupId).filter(Boolean))];
        if (ids.length>1 || saved.some(tx=>JSON.stringify(fields(tx,parts(tx)))!==base.signature ||
            validDate(tx.purchaseDate) && tx.purchaseDate!==base.date)) {
          caution(group,"Os lançamentos existentes desta série têm dados diferentes. Confira antes de continuar.");
        }
        adopt(group,saved,ids.length===1?ids[0]:null);
      }
    }
    const ambiguous = "Série semelhante preservada. As posições sem correspondência segura ficam fora deste envio.";
    for (const base of bases) {
      const automatic = base.matches.filter(({candidate,rank})=>{
        const best=owners.get(candidate.id);
        return rank>=2 && rank===best.rank && best.count===1;
      }).map(m=>m.candidate);
      // After completing an older group its newer slots have seriesKey but
      // the original siblings may not. Reserve both under the proven group.
      const linked=[];
      for (const c of automatic.filter(c=>c.groupId)) {
        const alreadyKnown=base.groups.filter(g=>g.groupId===c.groupId && exactKeys.has(g.seriesKey));
        if (alreadyKnown.length===1) { adopt(alreadyKnown[0],c.rows,c.groupId);used.add(c.id); }
        else if (alreadyKnown.length>1) alreadyKnown.forEach(g=>caution(g,ambiguous));
        else linked.push(c);
      }
      linked.sort((a,b)=>a.groupId<b.groupId?-1:a.groupId>b.groupId?1:0);
      const available = base.groups.filter(g=>g.groupId===g.seriesKey);
      // Never choose arbitrarily between more matching groups than printed purchases.
      if (linked.length > available.length) {
        base.groups.forEach(g=>caution(g,ambiguous));
      } else {
        linked.forEach((c,i)=>{adopt(available[i],c.rows,c.groupId);used.add(c.id);});
      }
      const singlesByNumber = new Map();
      automatic.filter(c=>!c.groupId).forEach(c=>{
        const n=parts(c.rows[0]).current;
        if(!singlesByNumber.has(n)) singlesByNumber.set(n,[]);
        singlesByNumber.get(n).push(c);
      });
      for (const [number,singles] of singlesByNumber) {
        const free = base.groups.filter(g=>!g.installments[number-1].matchedId);
        if (singles.length>free.length) base.groups.forEach(g=>caution(g,ambiguous));
        else singles.forEach((c,i)=>{adopt(free[i],c.rows,null);used.add(c.id);});
      }
    }
    for (const base of bases) {
      if (base.matches.some(m=>!used.has(m.candidate.id))) base.groups.forEach(g=>caution(g,ambiguous));
    }
    const result=bases.flatMap(base=>base.groups);
    result.forEach(applyBillingCycle);
    return result;
  }
  function c6Account(tx) {
    const account = text(tx?.account);
    return /^(?:(?:banco|cartao(?: de credito)?) )?c6(?: (?:bank|carbon|platinum))?(?:\s*[·-]\s*credito)?$/.test(account);
  }
  function c6CardMovement(tx) {
    if (tx.c6Section === "transfer" || tx.c6Section === "card_payment" || tx.creditKind === "card_payment") return false;
    const description = text(tx.desc);
    // Recebido na fatura seguinte, o pagamento liquida a anterior. Não é
    // um desconto nos gastos do período em que ele aparece no extrato.
    if (/^(?:inclusao de (?:pagamento|pagto)|(?:pagamento|pagto|liquidacao) (?:de |da )?fatura)\b/.test(description)) return false;
    if (tx.c6Section === "card") return true;
    // Antes de o importador guardar a seção do PDF, conta e cartão usavam
    // o mesmo nome. Preserve os movimentos bancários identificáveis.
    if (/^(?:pix|ted|doc|transferencia|deposito|saque|debito automatico|pagamento de boleto)\b|\b(?:no debito|cartao de debito|via pix|(?:envio|recebimento) de pix)\b/.test(description)) return false;
    return tx.type === "despesa" || /\b(?:estorno|reembolso|devolucao|chargeback|ajuste a credito)\b/.test(description);
  }
  function monthIndex(date) {
    return Number(date.slice(0,4)) * 12 + Number(date.slice(5,7)) - 1;
  }
  function c6Calendar(rows) {
    // Referência da fatura C6 de outubro de 2026. Datas projetadas são
    // apresentadas como previstas até existir um vencimento impresso.
    const reference = {closing:"2026-10-29",due:"2026-11-05",observed:false};
    const anchors = new Map(), cache = new Map();
    for (const row of rows) {
      if (!validDate(row.billClosingDate)) continue;
      const closing = row.billClosingDate;
      const due = validDate(row.billDueDate) && row.billDueDate >= closing ? row.billDueDate : "";
      const observed = row.billDateObserved === true;
      const bestDay = observed && Number.isInteger(row.cardBestPurchaseDay) &&
        row.cardBestPurchaseDay >= 1 && row.cardBestPurchaseDay <= 31 ? row.cardBestPurchaseDay : 0;
      const anchor = {closing,due,observed,bestDay};
      const key = [closing,due,observed,bestDay].join("/");
      anchors.set(key,anchor);
    }
    function best(month, field) {
      const target = monthIndex(month);
      let result, rank = Infinity;
      for (const anchor of anchors.values()) {
        if (!anchor[field]) continue;
        const delta = target - monthIndex(anchor.closing);
        // Uma data comprovada no próprio mês prevalece. Nos outros ciclos,
        // uma data impressa próxima é mais confiável que um dia projetado.
        const score = Math.abs(delta) * 2 + (delta < 0 ? 1 : 0);
        if (result?.observed && !anchor.observed) continue;
        const newerEvidence = anchor.observed && !result?.observed;
        const equallyNear = score === rank && (anchor[field] > result[field] ||
          anchor[field] === result[field] && anchor.bestDay > result.bestDay);
        if (newerEvidence || score < rank || equallyNear) { result = anchor; rank = score; }
      }
      return result || reference;
    }
    return function calendar(month) {
      if (!cache.has(month)) {
        const close = best(month,"closing"), due = best(month,"due");
        const dueOffset = monthIndex(month) - monthIndex(due.closing);
        const closeOffset = monthIndex(month) - monthIndex(close.closing);
        const closingDateObserved = close.observed && closeOffset===0;
        let closingDate = shift(close.closing,closeOffset);
        // O dia após o fechamento abre o próximo ciclo. Se o banco informa
        // um melhor dia, use-o para os próximos ciclos ainda não impressos.
        if (close.bestDay && !closingDateObserved) {
          const [year,monthNumber] = month.split("-").map(Number);
          const last = new Date(Date.UTC(year,monthNumber,0));
          const closingDay = close.bestDay===1 ? last.getUTCDate() : Math.min(close.bestDay-1,last.getUTCDate());
          closingDate = month+"-"+String(closingDay).padStart(2,"0");
        }
        cache.set(month,{
          closingDate,closingDateObserved,
          dueDate:shift(due.due,dueOffset),
          dueDateObserved:due.observed && dueOffset===0,
        });
      }
      return cache.get(month);
    };
  }
  function c6InvoiceMonth(tx,calendar) {
    const advanced = validDate(tx.advance?.paidDate);
    if (!advanced && validDate(tx.billClosingDate)) return tx.billClosingDate.slice(0,7);
    if (!advanced && validDate(tx.billDueDate)) {
      const dueMonth = tx.billDueDate.slice(0,7);
      // O dia impresso pode mudar (feriados). Use a relação fechamento /
      // vencimento conhecida mesmo quando o dia difere da previsão.
      const offset = monthIndex(calendar(dueMonth).dueDate) - monthIndex(dueMonth);
      return shift(tx.billDueDate,-offset).slice(0,7);
    }
    const date = advanced ? tx.advance.paidDate : tx.date;
    if (!validDate(date)) return "";
    const month = date.slice(0,7);
    return date > calendar(month).closingDate ? shift(date,1).slice(0,7) : month;
  }
  const monetaryUnits = {BRL:100,USD:100,EUR:100,GBP:100,PYG:1,CLP:1,USDT:1e6,USDC:1e6};
  const c6PayableStart = "2026-11";
  function isC6InvoicePayable(tx, transactions) {
    if (!c6Account(tx) || tx.type !== "despesa" || !c6CardMovement(tx)) return false;
    const inputs = (transactions || []).filter(c6Account);
    inputs.push(tx);
    return c6InvoiceMonth(tx,c6Calendar(inputs)) >= c6PayableStart;
  }
  function c6Invoices(transactions,today) {
    const rows = (transactions || []).filter(c6Account);
    const calendar = c6Calendar(rows), invoices = new Map();
    function invoiceFor(month) {
      if (!invoices.has(month)) {
        const previousMonth = shift(month+"-01",-1).slice(0,7);
        const previousClose = Date.parse(calendar(previousMonth).closingDate);
        const startDate = new Date(previousClose + 86400000).toISOString().slice(0,10);
        invoices.set(month,{month,startDate,...calendar(month),totals:{},count:0,transactionIds:[]});
      }
      return invoices.get(month);
    }
    for (const tx of rows) {
      if (!["despesa","receita"].includes(tx.type) || !Object.hasOwn(monetaryUnits,tx.currency) ||
          !Number.isFinite(tx.amount) || tx.amount <= 0 || !c6CardMovement(tx)) continue;
      const month = c6InvoiceMonth(tx,calendar);
      if (!month) continue;
      const invoice = invoiceFor(month);
      if (!invoice.dueDateObserved && tx.billDateObserved === true && !validDate(tx.advance?.paidDate) &&
          validDate(tx.billDueDate) && tx.billDueDate >= invoice.closingDate) {
        invoice.dueDate = tx.billDueDate;
        invoice.dueDateObserved = true;
      }
      const units = Math.round(tx.amount * monetaryUnits[tx.currency]);
      invoice.totals[tx.currency] = (invoice.totals[tx.currency] || 0) + (tx.type === "receita" ? -units : units);
      invoice.count++;
      if (tx.id) invoice.transactionIds.push(tx.id);
    }
    if (invoices.size && validDate(today)) {
      const currentMonth = c6InvoiceMonth({date:today},calendar);
      if (currentMonth >= c6PayableStart && !invoices.has(currentMonth)) invoiceFor(currentMonth).totals.BRL = 0;
    }
    const result = [...invoices.values()].sort((a,b)=>a.month.localeCompare(b.month));
    for (const invoice of result) {
      for (const currency of Object.keys(invoice.totals)) invoice.totals[currency] /= monetaryUnits[currency];
    }
    return result;
  }
  // Keep a single account ID for duplicate matching across manual entries,
  // receipts and statements. The section distinguishes movements on the card.
  function c6AccountFields(account, section) {
    if (account === "C6 · Conta/débito") return {account:"C6", c6Section:"transfer"};
    if (c6Account({account}) && ["card","transfer","card_payment"].includes(section)) return {account,c6Section:section};
    return {account};
  }
  return {plan,statementDate,c6Invoices,isC6InvoicePayable,c6AccountFields};
})();
if (typeof module !== "undefined" && module.exports) module.exports = InstallmentSchedule;
else if (typeof Deno !== "undefined") globalThis.InstallmentSchedule = InstallmentSchedule;
