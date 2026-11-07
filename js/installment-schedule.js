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
    return bases.flatMap(base=>base.groups);
  }
  return {plan};
})();
if (typeof module !== "undefined" && module.exports) module.exports = InstallmentSchedule;
else if (typeof Deno !== "undefined") globalThis.InstallmentSchedule = InstallmentSchedule;
