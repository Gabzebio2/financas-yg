"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const Merge = require("../js/cloud-merge.js");
const clone = (value) => JSON.parse(JSON.stringify(value));
const base = () => ({ id: "folder001", name: "Casa", initialBalance: 234.56, categories: [{ name: "Outros" }], custom: { preserved: true }, updatedAt: "2026-10-01T00:00:00Z", transactions: [{ id: "base1", amount: 25, currency: "BRL", desc: "Base" }], whatsappRevision: 0 });

test("três versões mesclam inclusões distintas sem somar saldos ou alterar campos desconhecidos", () => {
  const b = base(), l = clone(b), r = clone(b);
  l.transactions.push({ id: "local1", amount: 1.123456, currency: "USDT" });
  r.transactions.push({ id: "wa_0123", amount: 18, currency: "EUR" }); r.whatsappRevision = 1;
  const before = [b, l, r].map(clone), result = Merge.merge(b, l, r);
  assert.equal(result.ok, true);
  assert.deepEqual(result.dataset.transactions.map((t) => t.id), ["base1", "local1", "wa_0123"]);
  assert.equal(result.dataset.initialBalance, 234.56); assert.equal(result.dataset.transactions[1].amount, 1.123456);
  assert.deepEqual(result.dataset.custom, b.custom); assert.equal(result.dataset.whatsappRevision, 1);
  assert.deepEqual([b, l, r], before, "entradas não são modificadas");
});

test("edições e exclusões independentes permanecem, sem ressuscitar transação removida", () => {
  const b = base(); b.transactions.push({ id: "base2", amount: 12 }, { id: "base3", amount: 15 });
  const l = clone(b), r = clone(b);
  l.transactions = l.transactions.filter((t) => t.id !== "base2");
  l.transactions[0].amount = 7;
  r.transactions = r.transactions.filter((t) => t.id !== "base3");
  r.name = "Casa nova"; r.transactions.push({ id: "wa_abc", amount: 2 }); r.whatsappRevision = 1;
  const result = Merge.merge(b, l, r);
  assert.equal(result.ok, true); assert.equal(result.dataset.name, "Casa nova");
  assert.deepEqual(result.dataset.transactions, [{ id: "base1", amount: 7, currency: "BRL", desc: "Base" }, { id: "wa_abc", amount: 2 }]);
});

test("conflito de edição, exclusão/edição e mesmo ID novo não é decidido silenciosamente", () => {
  for (const kind of ["edit", "delete", "added"]) {
    const b = base(), l = clone(b), r = clone(b);
    if (kind === "edit") { l.transactions[0].amount = 3; r.transactions[0].amount = 9; }
    if (kind === "delete") { l.transactions = []; r.transactions[0].amount = 9; }
    if (kind === "added") { l.transactions.push({ id: "same", amount: 3 }); r.transactions.push({ id: "same", amount: 9 }); }
    assert.equal(Merge.merge(b, l, r).ok, false, kind);
  }
});

test("metadados concorrentes divergem e valores iguais convergem sem conflito", () => {
  const b = base(), l = clone(b), r = clone(b);
  l.initialBalance = 9; r.initialBalance = 10;
  assert.deepEqual(Merge.merge(b, l, r).conflicts, ["field:initialBalance"]);
  r.initialBalance = 9; assert.equal(Merge.merge(b, l, r).dataset.initialBalance, 9);
});

test("revisão local inventada ou remota retrocedida bloqueia a fusão", () => {
  const b = base(), l = clone(b), r = clone(b);
  l.whatsappRevision = 8; r.whatsappRevision = 8;
  assert.equal(Merge.merge(b, l, r).ok, false);
  b.whatsappRevision = l.whatsappRevision = 5; r.whatsappRevision = 4;
  assert.equal(Merge.merge(b, l, r).ok, false);
});

test("IDs duplicados e pastas diferentes não são fundidos", () => {
  const b = base(), l = clone(b), r = clone(b);
  l.transactions.push(clone(l.transactions[0])); assert.equal(Merge.merge(b, l, r).ok, false);
  l.transactions.pop(); r.id = "other"; assert.equal(Merge.merge(b, l, r).ok, false);
});

test("candidatos legados removem somente novas inclusões WA, nunca transações comuns", () => {
  const l = base(), r = clone(l);
  r.transactions.push({ id: "wa_123", amount: 8 }, { id: "ordinary", amount: 10 }); r.whatsappRevision = 1;
  const candidates = Merge.legacyCandidates(l, r);
  assert.ok(candidates.length); assert.ok(candidates.every((ds) => ds.transactions.some((t) => t.id === "ordinary")));
  assert.ok(candidates.every((ds) => !ds.transactions.some((t) => t.id === "wa_123")));
  assert.deepEqual(r.transactions.map((t) => t.id), ["base1", "wa_123", "ordinary"]);
});
