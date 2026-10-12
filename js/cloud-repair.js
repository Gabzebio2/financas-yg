/* ===== Reparo conservador do mês 00 em séries antigas de parcelas ===== */
"use strict";

const CloudRepair = (() => {
  const MAX_TRANSACTIONS = 100000;

  // Dados de backup/nuvem são objetos JSON. A cópia explícita também conserva
  // campos undefined e propriedades próprias como __proto__, sem sanitização.
  function cloneData(value) {
    if (!value || typeof value !== "object") return value;
    const copies = new Map();
    const pending = [];
    function copy(object) {
      if (!object || typeof object !== "object") return object;
      if (copies.has(object)) return copies.get(object);
      const result = Array.isArray(object) ? new Array(object.length) : {};
      copies.set(object, result);
      pending.push([object, result]);
      return result;
    }
    const root = copy(value);
    for (let i = 0; i < pending.length; i++) {
      const [source, target] = pending[i];
      for (const key of Object.keys(source)) {
        Object.defineProperty(target, key, { value: copy(source[key]), writable: true, enumerable: true, configurable: true });
      }
    }
    return root;
  }

  function dateParts(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const [year, month, day] = value.split("-").map(Number);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
      ? { year, month, day, monthIndex: year * 12 + month - 1 } : null;
  }

  function installmentParts(value) {
    if (typeof value !== "string" || !/^\d+\/\d+$/.test(value)) return null;
    const [current, total] = value.split("/").map(Number);
    return Number.isSafeInteger(current) && Number.isSafeInteger(total) && current >= 1 && total >= 2 && current <= total && total <= MAX_TRANSACTIONS
      ? { current, total } : null;
  }

  function analyzeDataset(raw) {
    const dataset = cloneData(raw);
    const reject = (reason) => ({ dataset, changes: [], repairable: false, reason });
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray(raw.transactions)) return reject("invalid_transactions");
    if (raw.transactions.length > MAX_TRANSACTIONS) return reject("too_many_transactions");

    const groups = new Map();
    const idCounts = new Map();
    const invalid = [];
    for (let index = 0; index < raw.transactions.length; index++) {
      const tx = raw.transactions[index];
      if (!tx || typeof tx !== "object" || Array.isArray(tx)) return reject("invalid_transaction");
      if (!dateParts(tx.date)) invalid.push({ tx, index });
      idCounts.set(tx.id, (idCounts.get(tx.id) || 0) + 1);
      if (typeof tx.groupId === "string" && tx.groupId.trim()) {
        if (!groups.has(tx.groupId)) groups.set(tx.groupId, []);
        groups.get(tx.groupId).push(tx);
      }
    }
    if (!invalid.length) return { dataset, changes: [], repairable: true };

    const proposed = [];
    for (const { tx, index } of invalid) {
      const match = typeof tx.date === "string" && /^(\d{4})-00-(\d{2})$/.exec(tx.date);
      if (!match || Number(match[1]) < 1 || Number(match[2]) < 1 || Number(match[2]) > 31) return reject("unsupported_invalid_date");
      if (typeof tx.id !== "string" || !tx.id.trim() || idCounts.get(tx.id) !== 1) return reject("ambiguous_transaction_id");
      const targetPart = installmentParts(tx.installment);
      const peers = groups.get(tx.groupId);
      if (!targetPart || !peers || peers.length !== targetPart.total) return reject("incomplete_installment_group");

      // Campos de contexto devem existir e coincidir exatamente. Não se compara
      // amount: dividir uma compra pode produzir parcelas diferentes em centavos.
      if (!["receita", "despesa"].includes(tx.type) || !["BRL", "CLP", "PYG", "USD"].includes(tx.currency) ||
          typeof tx.account !== "string" || typeof tx.desc !== "string" || !tx.desc.trim()) return reject("invalid_group_context");
      const seenParts = new Set();
      let candidateMonth = null, badDates = 0;
      for (const peer of peers) {
        if (["type", "currency", "account", "desc"].some((field) => peer[field] !== tx[field])) return reject("inconsistent_group_context");
        const part = installmentParts(peer.installment);
        if (!part || part.total !== targetPart.total || seenParts.has(part.current)) return reject("ambiguous_installment_sequence");
        seenParts.add(part.current);
        const date = dateParts(peer.date);
        if (!date) { badDates++; continue; }
        if (date.day !== Number(match[2])) return reject("inconsistent_installment_day");
        const month = date.monthIndex - (part.current - targetPart.current);
        if (candidateMonth !== null && candidateMonth !== month) return reject("inconsistent_installment_months");
        candidateMonth = month;
      }
      if (badDates !== 1 || candidateMonth === null) return reject("multiple_invalid_dates");
      // n entradas únicas em [1,n] comprovam que não há lacunas na sequência.
      if (seenParts.size !== targetPart.total) return reject("incomplete_installment_group");
      const year = Math.floor(candidateMonth / 12);
      const month = candidateMonth - year * 12 + 1;
      if (year !== Number(match[1]) || month !== 12) return reject("not_known_month_zero_bug");
      const after = `${match[1]}-12-${match[2]}`;
      if (!dateParts(after)) return reject("unsupported_invalid_date");
      proposed.push({ index, transactionId: tx.id, before: tx.date, after });
    }

    // Só aplica à cópia depois de comprovar TODAS as datas inválidas da pasta.
    const changes = proposed.map(({ index, transactionId, before, after }) => {
      dataset.transactions[index].date = after;
      return { transactionId, before, after };
    });
    return { dataset, changes, repairable: true };
  }

  return { analyzeDataset };
})();

if (typeof module !== "undefined" && module.exports) module.exports = CloudRepair;
