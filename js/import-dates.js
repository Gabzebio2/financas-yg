/* Datas aproximadas na prévia: somente vizinhos observados no mesmo arquivo. */
"use strict";

const ImportDates = (() => {
  const DAY = 86400000;
  function valid(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.slice(0, 4) === "0000") return false;
    const time = Date.parse(value + "T00:00:00Z");
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
  }
  const day = value => Date.parse(value + "T00:00:00Z") / DAY;
  const iso = value => new Date(value * DAY).toISOString().slice(0, 10);
  const numeric = value => typeof value === "number" && Number.isFinite(value);

  // Pure: shallow-copy each row and replace only inferred date metadata. Nested
  // caller data (review/evidence/etc.) is never modified. Output order is stable.
  function estimate(rows) {
    if (!Array.isArray(rows)) return [];
    const out = rows.map(row => row && typeof row === "object" ? { ...row } : row);
    const groups = new Map();
    rows.forEach((row, index) => {
      if (!row || typeof row !== "object" || row.gen || typeof row.sourceDocumentId !== "string" || !row.sourceDocumentId.trim()) return;
      if (!groups.has(row.sourceDocumentId)) groups.set(row.sourceDocumentId, []);
      groups.get(row.sourceDocumentId).push({ row, index });
    });
    for (const group of groups.values()) {
      // Never compare order numbers from unrelated files. Use an explicit
      // document-wide order when available; otherwise physical page/line order,
      // or the caller's stable document sequence if coordinates are incomplete.
      if (group.every(({ row }) => numeric(row.order))) {
        group.sort((a,b) => a.row.order - b.row.order || a.index - b.index);
      } else if (group.every(({ row }) => Number.isSafeInteger(row.sourcePage) && row.sourcePage > 0 && numeric(row.sourceIndex))) {
        group.sort((a,b) => a.row.sourcePage - b.row.sourcePage || a.row.sourceIndex - b.row.sourceIndex || a.index - b.index);
      }
      const anchors = [];
      group.forEach(({ row }, position) => {
        if (valid(row.date) && row.dateEstimated !== true) anchors.push(position);
      });
      let previous = null, nextIndex = 0;
      group.forEach(({ row, index }, position) => {
        if (valid(row.date) && row.dateEstimated !== true) {
          previous = position;
          while (nextIndex < anchors.length && anchors[nextIndex] <= position) nextIndex++;
          return;
        }
        const next = anchors[nextIndex] ?? null;
        // Recompute existing estimates from observed dates, never from another
        // estimate. A later chunk can replace a nearest guess with interpolation.
        delete out[index].dateEstimated;
        delete out[index].dateEstimate;
        if (previous === null && next === null) {
          if (row.dateEstimated === true) out[index].date = "";
          return;
        }
        if (previous !== null && next !== null) {
          const previousDate = group[previous].row.date, nextDate = group[next].row.date;
          const offset = (day(nextDate) - day(previousDate)) * (position - previous) / (next - previous);
          out[index].date = iso(day(previousDate) + Math.round(offset));
          out[index].dateEstimate = { method: "between", previousDate, nextDate };
        } else {
          const previousDate = previous !== null ? group[previous].row.date : null;
          const nextDate = next !== null ? group[next].row.date : null;
          out[index].date = previousDate || nextDate;
          out[index].dateEstimate = { method: "nearest", ...(previousDate ? { previousDate } : { nextDate }) };
        }
        out[index].dateEstimated = true;
      });
    }
    return out;
  }
  return { estimate };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ImportDates;
