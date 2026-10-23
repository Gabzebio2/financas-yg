/* Comparação conservadora das cópias CASINHA. Não grava nem exclui dados. */
"use strict";

const FolderCleanup = (() => {
  const MAX_FOLDERS = 1000;
  const MAX_TRANSACTIONS = 100000;
  const CURRENCIES = new Set(["BRL", "CLP", "PYG", "USD", "EUR", "GBP", "USDT", "USDC"]);
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const record = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype === null) return true;
    const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
    // Aceita objetos JSON de outro frame/VM, mas não instâncias de classes.
    return Object.getPrototypeOf(prototype) === null && typeof constructor === "function" &&
      Function.prototype.toString.call(constructor) === Function.prototype.toString.call(Object);
  };
  const idValid = (value) => typeof value === "string" && value.length > 0 && value.trim() === value;

  // Serialização exata, não um hash sujeito a colisões. Distingue ausente,
  // undefined, null e zero para detectar qualquer mudança antes da execução.
  function stable(value, ancestors = new Set(), depth = 0) {
    if (depth > 100) throw new Error("unsupported_data");
    if (value === null) return "null";
    if (typeof value === "undefined") return "undefined";
    if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("unsupported_data");
      return Object.is(value, -0) ? "-0" : JSON.stringify(value);
    }
    if (typeof value !== "object" || (!Array.isArray(value) && !record(value)) || ancestors.has(value)) throw new Error("unsupported_data");
    if (Object.getOwnPropertySymbols(value).length) throw new Error("unsupported_data");
    if (Object.getOwnPropertyNames(value).length !== Object.keys(value).length + (Array.isArray(value) ? 1 : 0)) throw new Error("unsupported_data");
    ancestors.add(value);
    let result;
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) throw new Error("unsupported_data");
      const items = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !own(descriptor, "value")) throw new Error("unsupported_data");
        items.push(stable(descriptor.value, ancestors, depth + 1));
      }
      result = "[" + items.join(",") + "]";
    } else {
      const fields = [];
      for (const key of Object.keys(value).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !own(descriptor, "value")) throw new Error("unsupported_data");
        fields.push(JSON.stringify(key) + ":" + stable(descriptor.value, ancestors, depth + 1));
      }
      result = "{" + fields.join(",") + "}";
    }
    ancestors.delete(value);
    return result;
  }

  function fingerprint(dataset) {
    try { return record(dataset) ? "exact-v1:" + stable(dataset) : null; }
    catch { return null; }
  }

  function nameKind(name) {
    if (typeof name !== "string") return null;
    const normalized = name.trim().replace(/\s+/g, " ").toLocaleLowerCase("pt-BR");
    if (normalized === "casinha unificada") return "unified";
    if (normalized === "casinha" || /^casinha\s*[-–—]\s*conflito da nuvem$/.test(normalized)) return "original";
    return null;
  }

  function validDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split("-").map(Number);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
  }

  function validInstallment(value) {
    if (value == null) return true;
    if (typeof value !== "string" || !/^\d+\/\d+$/.test(value)) return false;
    const [current, total] = value.split("/").map(Number);
    return Number.isSafeInteger(current) && Number.isSafeInteger(total) && current >= 1 && total >= 2 && current <= total && total <= MAX_TRANSACTIONS;
  }

  function withoutId(value) {
    const result = { ...value };
    delete result.id;
    return result;
  }

  function transactionBody(tx) {
    const result = withoutId(tx);
    delete result.groupId;
    if (!own(result, "fixed") || result.fixed === undefined) result.fixed = false;
    // Na prova original, as diferenças zero/null ocorrem em lançamentos SEM
    // parcelas. Não normaliza amount nem totalValue de uma compra parcelada.
    if (!tx.installment && (result.totalValue === 0 || result.totalValue === null)) result.totalValue = null;
    return result;
  }

  function multiset(values) {
    const result = new Map();
    for (const value of values) result.set(value, (result.get(value) || 0) + 1);
    return result;
  }
  const sameMultiset = (a, b) => a.size === b.size && [...a].every(([key, count]) => b.get(key) === count);

  function analyze(data) {
    if (!record(data) || !idValid(data.id) || !Array.isArray(data.transactions) || data.transactions.length > MAX_TRANSACTIONS) return { error: "invalid_dataset" };
    if (![data.categories, data.metas, data.limits].every(Array.isArray)) return { error: "invalid_collections" };
    if (![data.createdAt, data.updatedAt].every((date) => typeof date === "string" && Number.isFinite(Date.parse(date)))) return { error: "invalid_metadata" };
    if (data.displayCurrency !== "DEFAULT" && !CURRENCIES.has(data.displayCurrency) || data.profile != null && !["pf", "pj"].includes(data.profile)) return { error: "invalid_settings" };
    const rawFingerprint = fingerprint(data);
    if (!rawFingerprint) return { error: "unsupported_data" };

    const txIds = new Set(), groupMembers = new Map(), bodies = new Map();
    for (const tx of data.transactions) {
      if (!record(tx) || !idValid(tx.id) || txIds.has(tx.id) || !validDate(tx.date) || !Number.isFinite(tx.amount) ||
          !["receita", "despesa"].includes(tx.type) || !CURRENCIES.has(tx.currency) ||
          ![tx.desc, tx.category, tx.account].every((value) => typeof value === "string") || !validInstallment(tx.installment) ||
          tx.fixed != null && typeof tx.fixed !== "boolean" || tx.totalValue != null && !Number.isFinite(tx.totalValue) ||
          tx.groupId != null && !idValid(tx.groupId)) return { error: "invalid_transactions" };
      txIds.add(tx.id);
      const body = stable(transactionBody(tx));
      bodies.set(tx.id, body);
      if (tx.groupId) {
        if (!groupMembers.has(tx.groupId)) groupMembers.set(tx.groupId, []);
        groupMembers.get(tx.groupId).push(body);
      }
    }
    const groupKeys = new Map([...groupMembers].map(([id, members]) => [id, stable(members.sort())]));
    const txSignatures = data.transactions.map((tx) => stable({ body: bodies.get(tx.id), group: tx.groupId ? groupKeys.get(tx.groupId) : null }));
    const categories = new Set();
    for (const category of data.categories) {
      if (!record(category) || typeof category.name !== "string" || !category.name.trim() || categories.has(category.name)) return { error: "invalid_categories" };
      categories.add(category.name);
    }
    for (const collection of [data.metas, data.limits]) {
      const ids = new Set();
      for (const item of collection) {
        if (!record(item) || !idValid(item.id) || ids.has(item.id)) return { error: "invalid_collection_ids" };
        ids.add(item.id);
      }
    }
    for (const goal of data.metas) {
      if (typeof goal.name !== "string" || !goal.name.trim() ||
          (typeof goal.category === "string" && goal.category.trim() ? false : !Number.isFinite(goal.target) || goal.target <= 0 || goal.saved != null && !Number.isFinite(goal.saved))) return { error: "invalid_goals" };
    }
    for (const limit of data.limits) {
      if (!Number.isFinite(limit.amount) || limit.amount <= 0 || !Array.isArray(limit.categories) || !limit.categories.every((value) => typeof value === "string") ||
          limit.versions != null && (!Array.isArray(limit.versions) || limit.versions.some((version) => !record(version) || !Number.isFinite(version.amount) || !Array.isArray(version.categories)))) return { error: "invalid_limits" };
    }
    const metadata = { ...data };
    for (const key of ["id", "name", "createdAt", "updatedAt", "transactions", "categories", "metas", "limits"]) delete metadata[key];
    metadata.profile = metadata.profile === "pj" ? "pj" : "pf";
    return { fingerprint: rawFingerprint, count: data.transactions.length,
      transactions: multiset(txSignatures), groups: multiset([...groupKeys.values()]),
      categories: stable(data.categories), metas: stable(data.metas.map(withoutId)), limits: stable(data.limits.map(withoutId)), metadata: stable(metadata) };
  }

  function difference(a, b) {
    if (!sameMultiset(a.groups, b.groups)) return "groups_differ";
    if (!sameMultiset(a.transactions, b.transactions)) return "transactions_differ";
    if (a.categories !== b.categories) return "categories_differ";
    if (a.metas !== b.metas) return "metas_differ";
    if (a.limits !== b.limits) return "limits_differ";
    if (a.metadata !== b.metadata) return "metadata_differ";
    return null;
  }

  function plan(datasets, options = {}) {
    const result = { version: 1, keepId: null, keepFingerprint: null, requiresKeepSelection: false, candidates: [], reasons: [],
      counts: { examinedFolders: Array.isArray(datasets) ? datasets.length : 0, familyFolders: 0, unifiedFolders: 0, candidateFolders: 0, retainedFolders: 0, keepTransactions: 0, candidateTransactions: 0 } };
    const stop = (code) => { result.reasons.push({ id: null, code }); return result; };
    if (!Array.isArray(datasets) || datasets.length > MAX_FOLDERS) return stop("invalid_datasets");
    result.counts.retainedFolders = datasets.length;
    const ids = new Set();
    for (const data of datasets) {
      if (!record(data)) return stop("invalid_folder_id");
      const idDescriptor = Object.getOwnPropertyDescriptor(data, "id"), nameDescriptor = Object.getOwnPropertyDescriptor(data, "name");
      if (!idDescriptor || !own(idDescriptor, "value") || !idValid(idDescriptor.value)) return stop("invalid_folder_id");
      if (nameDescriptor && !own(nameDescriptor, "value")) return stop("unsupported_data");
      if (ids.has(data.id)) return stop("duplicate_folder_id");
      ids.add(data.id);
    }
    const family = datasets.filter((data) => nameKind(data.name));
    const unified = family.filter((data) => nameKind(data.name) === "unified");
    result.counts.familyFolders = family.length;
    result.counts.unifiedFolders = unified.length;
    const requested = options && options.keepId;
    if (!requested && unified.length > 1) { result.requiresKeepSelection = true; return stop("choose_unified_folder"); }
    if (!unified.length) return stop("no_unified_folder");
    const keep = requested ? unified.find((data) => data.id === requested) : unified[0];
    if (!keep) return stop("invalid_keep_id");
    result.keepId = keep.id;
    let kept;
    try { kept = analyze(keep); } catch { kept = { error: "unsupported_data" }; }
    if (kept.error) { result.reasons.push({ id: keep.id, code: "keep_" + kept.error }); return result; }
    result.keepFingerprint = kept.fingerprint;
    result.counts.keepTransactions = kept.count;
    for (const data of datasets) {
      if (data.id === keep.id) { result.reasons.push({ id: data.id, code: "kept_folder" }); continue; }
      if (!nameKind(data.name)) { result.reasons.push({ id: data.id, code: "outside_family" }); continue; }
      let candidate;
      try { candidate = analyze(data); } catch { candidate = { error: "unsupported_data" }; }
      const reason = candidate.error || difference(candidate, kept);
      if (reason) { result.reasons.push({ id: data.id, code: reason }); continue; }
      result.candidates.push({ id: data.id, name: data.name, transactionCount: candidate.count, fingerprint: candidate.fingerprint, reason: "equivalent" });
      result.counts.candidateTransactions += candidate.count;
    }
    result.counts.candidateFolders = result.candidates.length;
    result.counts.retainedFolders = datasets.length - result.candidates.length;
    return result;
  }

  return { plan, fingerprint };
})();

if (typeof module !== "undefined" && module.exports) module.exports = FolderCleanup;
