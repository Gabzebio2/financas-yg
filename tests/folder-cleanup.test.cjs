"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const FolderCleanup = require("../js/folder-cleanup.js");
const clone = (value) => JSON.parse(JSON.stringify(value));

function folder(id = "original01", name = "CASINHA") {
  return {
    id, name, createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2026-10-23T03:00:00.000Z", profile: "pf", displayCurrency: "BRL",
    categories: [{ name: "Alimentação", color: "#123456", custom: { kept: true } }],
    metas: [{ id: id + "goal", name: "Reserva", target: 100, saved: 25, currency: "BRL", extra: { preserved: true } }],
    limits: [{ id: id + "limit", name: "Mensal", amount: 200, categories: ["Alimentação"], currency: "BRL", versions: [{ from: "2026-01", amount: 200, categories: ["Alimentação"] }] }],
    settings: { custom: { keep: [false, 0, null, ""] } },
    transactions: Array.from({ length: 3 }, (_, index) => ({ id: "tx" + index, groupId: "installments", fixed: false,
      date: `2026-0${index + 1}-12`, desc: "Compra", account: "Conta", category: "Alimentação", type: "despesa", amount: 10,
      currency: "BRL", installment: `${index + 1}/3`, totalValue: 30, custom: { stable: [1, 2] } })),
  };
}
function unified(original = folder(), id = "unified001") {
  const copy = clone(original);
  copy.id = id; copy.name = "CASINHA unificada";
  copy.createdAt = "2026-10-23T04:00:00.000Z"; copy.updatedAt = "2026-10-23T04:01:00.000Z";
  copy.transactions.forEach((tx, index) => { tx.id = id + "tx" + index; tx.groupId = tx.groupId ? id + tx.groupId : null; });
  copy.metas.forEach((goal, index) => { goal.id = id + "goal" + index; });
  copy.limits.forEach((limit, index) => { limit.id = id + "limit" + index; });
  return copy;
}
function ungrouped(tx, id) {
  return { ...clone(tx), id, groupId: null, fixed: false, installment: null, totalValue: null };
}
function freeze(value) { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function assertRetained(original, keep, code) {
  const result = FolderCleanup.plan([original, keep]);
  assert.equal(result.candidates.length, 0);
  assert.ok(result.reasons.some((reason) => reason.id === original.id && (!code || reason.code === code)));
  return result;
}

test("detecta equivalência completa com IDs regenerados e mantém pastas fora de CASINHA", () => {
  const original = folder(), keep = unified(original), unrelated = folder("testfolder", "Test");
  const result = FolderCleanup.plan([original, keep, unrelated]);
  assert.equal(result.keepId, keep.id);
  assert.deepEqual(result.candidates.map((candidate) => candidate.id), [original.id]);
  assert.equal(result.candidates[0].fingerprint, FolderCleanup.fingerprint(original));
  assert.equal(result.keepFingerprint, FolderCleanup.fingerprint(keep));
  assert.deepEqual(result.counts, { examinedFolders: 3, familyFolders: 2, unifiedFolders: 1, candidateFolders: 1, retainedFolders: 2, keepTransactions: 3, candidateTransactions: 3 });
  assert.ok(result.reasons.some((reason) => reason.id === unrelated.id && reason.code === "outside_family"));
});

test("DEFAULT e moedas novas são válidos sem ignorar diferenças na sexta casa", () => {
  for (const currency of ["EUR", "GBP", "USDT", "USDC"]) {
    const original = folder(); original.displayCurrency = "DEFAULT";
    original.transactions.forEach((tx) => { tx.currency = currency; tx.amount = 1.123456; });
    const kept = unified(original);
    assert.equal(FolderCleanup.plan([original, kept]).candidates.length, 1);
    original.transactions[0].amount = 1.123457; assertRetained(original, kept, "groups_differ");
    original.transactions[0].currency = "DEFAULT"; assertRetained(original, kept);
  }
});

test("sem unificada não indica exclusões; múltiplas unificadas exigem keepId explícito", () => {
  const original = folder(), first = unified(original), second = unified(original, "unified002");
  assert.equal(FolderCleanup.plan([original]).reasons[0].code, "no_unified_folder");
  const ambiguous = FolderCleanup.plan([original, first, second]);
  assert.equal(ambiguous.requiresKeepSelection, true);
  assert.equal(ambiguous.keepId, null);
  assert.deepEqual(ambiguous.candidates, []);
  const selected = FolderCleanup.plan([original, first, second], { keepId: second.id });
  assert.equal(selected.keepId, second.id);
  assert.deepEqual(selected.candidates.map((candidate) => candidate.id), [original.id, first.id]);
  for (const keepId of [original.id, "missing"]) assert.equal(FolderCleanup.plan([original, first], { keepId }).reasons[0].code, "invalid_keep_id");
});

test("somente nomes CASINHA conhecidos são candidatos, incluindo conflito da nuvem", () => {
  const keep = unified(), names = ["CASINHA — conflito da nuvem", "CASINHA - conflito da nuvem", "casinha", "CASINHA férias", "Outra CASINHA", "Test"];
  const originals = names.map((name, index) => folder("folder" + index, name));
  const result = FolderCleanup.plan([...originals, keep]);
  assert.deepEqual(result.candidates.map((candidate) => candidate.id), ["folder0", "folder1", "folder2"]);
});

test("repetições legítimas preservam multiplicidade; subconjuntos são retidos nesta versão", () => {
  const original = folder();
  original.transactions = [ungrouped(original.transactions[0], "first"), ungrouped(original.transactions[0], "second")];
  const keep = unified(original);
  assert.equal(FolderCleanup.plan([original, keep]).candidates.length, 1);
  const one = clone(original); one.transactions.pop();
  assertRetained(one, keep, "transactions_differ");
  const extra = clone(original); extra.transactions.push(ungrouped(original.transactions[0], "third"));
  assertRetained(extra, keep, "transactions_differ");
});

test("mesmo ID com valor, moeda, data, conta ou descrição divergente permanece intacto", () => {
  for (const [field, value] of [["amount", 11], ["currency", "USD"], ["date", "2026-01-13"], ["account", "Outra"], ["desc", "Outra compra"]]) {
    const original = folder(), keep = unified(original);
    keep.transactions[0].id = original.transactions[0].id;
    original.transactions[0][field] = value;
    assertRetained(original, keep);
  }
});

test("novos lançamentos em uma candidata mudam o fingerprint e impedem sua remoção", () => {
  const original = folder(), keep = unified(original);
  const old = FolderCleanup.plan([original, keep]);
  original.transactions.push(ungrouped(original.transactions[0], "newtransaction"));
  assert.notEqual(FolderCleanup.fingerprint(original), old.candidates[0].fingerprint);
  assertRetained(original, keep, "transactions_differ");
  const oldKeepFingerprint = old.keepFingerprint;
  keep.updatedAt = "2026-10-24T00:00:00.000Z";
  assert.notEqual(FolderCleanup.fingerprint(keep), oldKeepFingerprint);
});

test("topologia de grupos é preservada, mesmo com valores e textos iguais", () => {
  const original = folder(), keep = unified(original);
  original.transactions[1].groupId = "different-group";
  assertRetained(original, keep, "groups_differ");
  const ungroup = folder(); ungroup.transactions.forEach((tx) => { tx.groupId = null; });
  assertRetained(ungroup, keep, "groups_differ");
});

test("grupos distintos de conteúdo igual não são fundidos nem reduzidos", () => {
  const original = folder();
  original.transactions.push(...original.transactions.map((tx) => ({ ...clone(tx), id: tx.id + "copy", groupId: "second-group" })));
  const keep = unified(original);
  assert.equal(FolderCleanup.plan([original, keep]).candidates.length, 1);
  original.transactions.forEach((tx) => { tx.groupId = "single-group"; });
  assertRetained(original, keep, "groups_differ");
});

test("normaliza apenas defaults conhecidos; totalValue de parcelas continua significativo", () => {
  const original = folder(); original.transactions = [ungrouped(original.transactions[0], "single")];
  delete original.profile; delete original.transactions[0].fixed; delete original.transactions[0].groupId;
  const keep = unified(original); keep.profile = "pf"; keep.transactions[0].fixed = false; keep.transactions[0].groupId = null; keep.transactions[0].totalValue = 0;
  assert.equal(FolderCleanup.plan([original, keep]).candidates.length, 1);
  const parcelled = folder(), other = unified(parcelled); other.transactions[0].totalValue = null;
  assertRetained(parcelled, other);
  const differentAmount = unified(original); differentAmount.transactions[0].amount = 0;
  assertRetained(original, differentAmount, "transactions_differ");
});

test("categorias, metas e limites divergentes nunca são descartados", () => {
  const changed = [
    ["categories_differ", (data) => { data.categories[0].color = "#abcdef"; }],
    ["metas_differ", (data) => { data.metas[0].saved++; }],
    ["metas_differ", (data) => { data.metas[0].extra.preserved = false; }],
    ["limits_differ", (data) => { data.limits[0].versions[0].amount++; }],
  ];
  for (const [code, edit] of changed) { const original = folder(), keep = unified(original); edit(original); assertRetained(original, keep, code); }
});

test("configurações e campos desconhecidos exigem igualdade exata", () => {
  for (const edit of [
    (data) => { data.settings.custom.keep.push("extra"); },
    (data) => { data.customUnknown = { future: true }; },
    (data) => { data.displayCurrency = "USD"; },
    (data) => { data.profile = "pj"; },
  ]) { const original = folder(), keep = unified(original); edit(original); assertRetained(original, keep, "metadata_differ"); }
  const original = folder(), keep = unified(original); original.transactions[0].custom.stable.push(3); assertRetained(original, keep);
  const a = folder(), b = unified(a); a.metas[0].extra.unknownId = "one"; b.metas[0].extra.unknownId = "two"; assertRetained(a, b, "metas_differ");
});

test("IDs duplicados ou dados inválidos bloqueiam exclusões sem normalização destrutiva", () => {
  const original = folder(), keep = unified(original);
  assert.equal(FolderCleanup.plan([original, { ...keep, id: original.id }]).reasons[0].code, "duplicate_folder_id");
  for (const edit of [
    (data) => { data.transactions[1].id = data.transactions[0].id; },
    (data) => { data.transactions[0].date = "2026-02-30"; },
    (data) => { data.transactions[0].amount = Infinity; },
    (data) => { data.transactions[0].installment = "4/3"; },
    (data) => { data.transactions[0].currency = "EUR"; },
    (data) => { data.metas[0].target = -1; },
    (data) => { data.updatedAt = "invalid"; },
  ]) { const bad = clone(original); edit(bad); assertRetained(bad, keep); }
  const brokenKeep = unified(original); brokenKeep.transactions[0].date = "2026-00-12";
  const result = FolderCleanup.plan([original, brokenKeep]);
  assert.equal(result.candidates.length, 0); assert.equal(result.keepFingerprint, null);
  assert.ok(result.reasons[0].code.startsWith("keep_"));
});

test("objetos não serializáveis, accessors e campos ocultos não entram na prova", () => {
  const keep = unified();
  for (const edit of [
    (data) => { data.loop = data; },
    (data) => { data.fn = () => {}; },
    (data) => { data.when = new Date(); },
    (data) => { data[Symbol("hidden")] = true; },
    (data) => { Object.defineProperty(data, "hidden", { value: 1 }); },
    (data) => { Object.defineProperty(data, "read", { enumerable: true, get() { throw new Error("must_not_read"); } }); },
  ]) { const original = folder(); edit(original); assert.equal(FolderCleanup.fingerprint(original), null); assertRetained(original, keep, "unsupported_data"); }
});

test("plano e fingerprints não modificam fontes congeladas e detectam diferenças exatas", () => {
  const original = freeze(folder()), keep = freeze(unified(original));
  const before = JSON.stringify([original, keep]);
  const result = FolderCleanup.plan([original, keep]);
  assert.equal(result.candidates.length, 1);
  assert.equal(JSON.stringify([original, keep]), before);
  const reordered = Object.fromEntries(Object.entries(original).reverse());
  assert.equal(FolderCleanup.fingerprint(original), FolderCleanup.fingerprint(reordered));
  assert.notEqual(FolderCleanup.fingerprint({ a: 0 }), FolderCleanup.fingerprint({ a: null }));
  assert.notEqual(FolderCleanup.fingerprint({ a: undefined }), FolderCleanup.fingerprint({}));
});

test("guardas de volume retêm entrada e helper pode executar como script de navegador", () => {
  const original = folder(), keep = unified(original);
  original.transactions = new Array(100001).fill(original.transactions[0]);
  assertRetained(original, keep, "invalid_dataset");
  assert.equal(FolderCleanup.plan(new Array(1001).fill(keep)).reasons[0].code, "invalid_datasets");
  const context = vm.createContext({ input: JSON.stringify([folder(), keep]) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js/folder-cleanup.js"), "utf8") + "\nthis.result = FolderCleanup.plan(JSON.parse(input));", context);
  assert.equal(context.result.candidates.length, 1);
});

test("objetos JSON entre VMs são aceitos sem aceitar instâncias ou ler getters de identidade", () => {
  const context = vm.createContext({ input: JSON.stringify([folder(), unified()]) });
  const foreign = vm.runInContext("JSON.parse(input)", context);
  assert.equal(FolderCleanup.plan(foreign).candidates.length, 1);
  class ForeignClass { constructor() { Object.assign(this, folder()); } }
  assert.equal(FolderCleanup.plan([new ForeignClass(), unified()]).candidates.length, 0);
  for (const key of ["id", "name"]) {
    const value = folder(); let reads = 0;
    Object.defineProperty(value, key, { enumerable: true, get() { reads++; return "never"; } });
    assert.equal(FolderCleanup.plan([value, unified()]).candidates.length, 0);
    assert.equal(reads, 0);
  }
});
