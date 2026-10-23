/* Conciliação conservadora de snapshots: valores financeiros nunca são somados. */
"use strict";

const CloudMerge = (() => {
  const absent = Symbol("absent");
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const record = (value) => value && typeof value === "object" && !Array.isArray(value);
  function stable(value) {
    if (value === absent) return "<absent>";
    if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
    if (record(value)) return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + stable(value[key])).join(",") + "}";
    return JSON.stringify(value);
  }
  const same = (a, b) => stable(a) === stable(b);
  function transactions(dataset) {
    if (!record(dataset) || !Array.isArray(dataset.transactions) || dataset.transactions.length > 100000) return null;
    const map = new Map();
    for (const tx of dataset.transactions) {
      if (!record(tx) || typeof tx.id !== "string" || !tx.id || map.has(tx.id)) return null;
      map.set(tx.id, tx);
    }
    return map;
  }
  function revision(dataset) {
    const value = dataset?.whatsappRevision;
    return value === undefined ? 0 : Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  function choose(base, local, remote) {
    if (same(local, remote)) return { ok: true, value: local };
    if (same(local, base)) return { ok: true, value: remote };
    if (same(remote, base)) return { ok: true, value: local };
    return { ok: false };
  }
  function merge(base, local, remote) {
    const b = transactions(base), l = transactions(local), r = transactions(remote);
    if (!b || !l || !r || !base.id || base.id !== local.id || base.id !== remote.id) return { ok: false, conflicts: ["structure"] };
    const baseRevision = revision(base), localRevision = revision(local), remoteRevision = revision(remote);
    if (baseRevision === null || localRevision !== baseRevision || remoteRevision === null || remoteRevision < baseRevision) {
      return { ok: false, conflicts: ["whatsappRevision"] };
    }
    const result = Object.create(null), conflicts = [];
    const read = (object, key) => own(object, key) ? object[key] : absent;
    for (const key of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])) {
      if (["transactions", "updatedAt", "whatsappRevision"].includes(key)) continue;
      const selected = choose(read(base, key), read(local, key), read(remote, key));
      if (!selected.ok) conflicts.push("field:" + key);
      else if (selected.value !== absent) result[key] = copy(selected.value);
    }
    const merged = new Map();
    for (const id of new Set([...b.keys(), ...l.keys(), ...r.keys()])) {
      const selected = choose(b.has(id) ? b.get(id) : absent, l.has(id) ? l.get(id) : absent, r.has(id) ? r.get(id) : absent);
      if (!selected.ok) conflicts.push("transaction:" + id);
      else if (selected.value !== absent) merged.set(id, copy(selected.value));
    }
    if (conflicts.length) return { ok: false, conflicts };
    // Mantém a ordem local; operações novas do remoto vêm ao final, uma só vez.
    result.transactions = [];
    for (const id of new Set([...l.keys(), ...r.keys()])) if (merged.has(id)) result.transactions.push(merged.get(id));
    result.updatedAt = remote.updatedAt;
    if (own(remote, "whatsappRevision")) result.whatsappRevision = remote.whatsappRevision;
    return { ok: true, dataset: result, conflicts: [] };
  }

  // Isto apenas propõe candidatos. O chamador DEVE conferir o digest persistido
  // antes de usá-los: ausência no local, sozinha, jamais prova inclusão remota.
  function legacyCandidates(local, remote) {
    const l = transactions(local), r = transactions(remote);
    if (!l || !r || local.id !== remote.id || revision(remote) === null) return [];
    const additions = [...r.keys()].filter((id) => !l.has(id) && /^wa_[a-z0-9_-]+$/i.test(id));
    if (!additions.length) return [];
    const omitted = new Set(additions), candidate = copy(remote);
    candidate.transactions = candidate.transactions.filter((tx) => !omitted.has(tx.id));
    const variants = [candidate];
    for (const value of [absent, 0, own(local, "whatsappRevision") ? local.whatsappRevision : absent]) {
      const next = copy(candidate);
      if (value === absent) delete next.whatsappRevision;
      else if (Number.isSafeInteger(value) && value >= 0 && value <= revision(remote)) next.whatsappRevision = value;
      else continue;
      if (!variants.some((entry) => same(entry, next))) variants.push(next);
    }
    return variants;
  }
  // Exclusivo do reparo solicitado pelo usuário: a versão local já corrigida
  // contém cada lançamento remoto intacto e só acrescenta novos IDs.
  function onlyLocalAdditions(local, remote) {
    const l = transactions(local), r = transactions(remote);
    if (!l || !r || local.id !== remote.id || revision(local) !== revision(remote)) return false;
    const metadata = (ds) => Object.fromEntries(Object.entries(ds).filter(([key]) => !["updatedAt", "transactions"].includes(key)));
    if (!same(metadata(local), metadata(remote))) return false;
    return [...r].every(([id, tx]) => l.has(id) && same(l.get(id), tx));
  }
  return { merge, legacyCandidates, onlyLocalAdditions };
})();

if (typeof module !== "undefined" && module.exports) module.exports = CloudMerge;
