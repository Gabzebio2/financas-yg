"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { analyzeDataset } = require("../js/cloud-repair.js");

function series(groupId = "synthetic-group", total = 12, overrides = {}) {
  return Array.from({ length: total }, (_, index) => {
    const absoluteMonth = 2025 * 12 + 11 + index;
    const year = Math.floor(absoluteMonth / 12);
    const month = absoluteMonth % 12 + 1;
    return { id: `${groupId}-${index + 1}`, groupId, date: index ? `${year}-${String(month).padStart(2, "0")}-15` : "2025-00-15",
      installment: `${index + 1}/${total}`, type: "despesa", currency: "BRL", account: "Conta sintética", desc: "Compra sintética",
      amount: index === total - 1 ? 9.99 : 10, category: "Teste", extra: { keep: ["unchanged", null] }, ...overrides };
  });
}

const dataset = (transactions = series()) => ({ id: "synthetic-dataset", name: "Teste", createdAt: "2025-01-01", updatedAt: "2025-12-01", transactions,
  categories: ["Teste"], budgets: { Teste: 123 }, goals: [{ id: "goal", date: "not-a-transaction-date", extra: true }], custom: { untouched: [1, 2, 3] } });

function expectRefused(raw) {
  const before = JSON.stringify(raw);
  const result = analyzeDataset(raw);
  assert.equal(result.repairable, false);
  assert.equal(typeof result.reason, "string");
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.dataset, raw);
  assert.notEqual(result.dataset, raw);
  assert.equal(JSON.stringify(raw), before);
  return result;
}

test("repara três grupos completos independentes 1/10 e 1/12 sem alterar outros campos", () => {
  const raw = dataset([...series("a", 10), ...series("b", 12), ...series("c", 12)]);
  const before = JSON.stringify(raw);
  const result = analyzeDataset(raw);
  assert.equal(result.repairable, true);
  assert.deepEqual(result.changes, ["a", "b", "c"].map((group) => ({ transactionId: `${group}-1`, before: "2025-00-15", after: "2025-12-15" })));
  assert.equal(JSON.stringify(raw), before);
  const expected = JSON.parse(before);
  expected.transactions.filter((tx) => tx.installment.startsWith("1/")).forEach((tx) => { tx.date = "2025-12-15"; });
  assert.equal(JSON.stringify(result.dataset), JSON.stringify(expected));
});

test("reparo de data aceita moedas novas sem mudar moeda, preferência ou precisão", () => {
  for (const currency of ["EUR", "GBP", "USDT", "USDC"]) {
    const raw = { ...dataset(series("new-currency", 3, { currency, amount: 1.123456 })), displayCurrency: "DEFAULT" };
    const expected = JSON.parse(JSON.stringify(raw)); expected.transactions[0].date = "2025-12-15";
    const result = analyzeDataset(raw);
    assert.equal(result.repairable, true); assert.deepEqual(result.dataset, expected);
  }
});

test("ordem das transações não interfere na inferência e parcelas podem diferir em centavos", () => {
  const raw = dataset(series().reverse());
  const result = analyzeDataset(raw);
  assert.equal(result.repairable, true);
  assert.equal(result.dataset.transactions.at(-1).date, "2025-12-15");
  assert.equal(result.dataset.transactions[0].amount, 9.99);
});

test("não assume que a parcela danificada é a primeira; dezembro deve ser provado pelos pares", () => {
  const items = series("middle", 4);
  items.forEach((tx, index) => { tx.date = ["2025-10-15", "2025-11-15", "2025-00-15", "2026-01-15"][index]; });
  const result = analyzeDataset(dataset(items));
  assert.equal(result.repairable, true);
  assert.deepEqual(result.changes, [{ transactionId: "middle-3", before: "2025-00-15", after: "2025-12-15" }]);
});

test("uma data inválida fora do padrão impede reparo de toda a pasta, mesmo com grupo reparável", () => {
  for (const date of ["2026-02-30", "2025-13-15", "2025-00-32", "2025-00-00", "0000-00-15", "2025-0-15", "", null]) {
    expectRefused(dataset([...series(), { id: "unrelated", date }]));
  }
});

test("recusa grupo incompleto, lacunas, total inconsistente e parcelas duplicadas", () => {
  const missing = series(); missing.splice(3, 1); expectRefused(dataset(missing));
  const duplicated = series(); duplicated[4].installment = "4/12"; expectRefused(dataset(duplicated));
  const differentTotal = series(); differentTotal[2].installment = "3/13"; expectRefused(dataset(differentTotal));
  const nonInstallment = series(); nonInstallment[1].installment = null; expectRefused(dataset(nonInstallment));
  for (const installment of ["0/12", "13/12", "1/0", "1.5/12", "1/1", "1/9007199254740992"]) {
    const rows = series(); rows[0].installment = installment; expectRefused(dataset(rows));
  }
});

test("recusa mês não consecutivo, dia diferente e ajuste de fim de mês sem evidência exata", () => {
  const wrongMonth = series(); wrongMonth[6].date = "2026-07-15"; expectRefused(dataset(wrongMonth));
  const wrongDay = series(); wrongDay[3].date = "2026-03-16"; expectRefused(dataset(wrongDay));
  const clampedDay = series("clamped", 3);
  clampedDay.forEach((tx, index) => { tx.date = ["2025-00-31", "2026-01-31", "2026-02-28"][index]; });
  expectRefused(dataset(clampedDay));
});

test("recusa mais de uma data inválida no mesmo grupo sem aplicar correção parcial", () => {
  const rows = series(); rows[1].date = "2026-00-15";
  expectRefused(dataset([...series("good", 10), ...rows]));
});

test("recusa contexto divergente de tipo, moeda, conta ou descrição", () => {
  for (const [field, value] of [["type", "receita"], ["currency", "USD"], ["account", "Outra conta"], ["desc", "Outra compra"]]) {
    const rows = series(); rows[5][field] = value; expectRefused(dataset(rows));
  }
  for (const overrides of [{ type: undefined }, { currency: "CHF" }, { account: undefined }, { desc: "" }]) {
    expectRefused(dataset(series("invalid-context", 12, overrides)));
  }
});

test("recusa grupo ausente, identificador ambíguo e linhas extras no mesmo grupo", () => {
  expectRefused(dataset(series("")));
  expectRefused(dataset(series(" ")));
  const duplicateId = series(); duplicateId[2].id = duplicateId[0].id; expectRefused(dataset(duplicateId));
  const emptyId = series(); emptyId[0].id = ""; expectRefused(dataset(emptyId));
  const extra = series(); extra.push({ ...extra[1], id: "extra", installment: null }); expectRefused(dataset(extra));
});

test("mês inferido precisa ser dezembro do ano já escrito; não corrige ano por suposição", () => {
  const wrongYear = series(); wrongYear[0].date = "2026-00-15"; expectRefused(dataset(wrongYear));
  const november = series("nov", 3);
  november.forEach((tx, index) => { tx.date = ["2025-00-15", "2025-12-15", "2026-01-15"][index]; });
  expectRefused(dataset(november));
});

test("dados válidos e pasta vazia voltam sem mudanças, com cópia independente", () => {
  for (const rows of [[], [{ id: "valid", date: "2024-02-29", anyField: { nested: [1, 2] } }]]) {
    const raw = dataset(rows);
    const result = analyzeDataset(raw);
    assert.equal(result.repairable, true);
    assert.deepEqual(result.changes, []);
    assert.deepEqual(result.dataset, raw);
    assert.notEqual(result.dataset, raw);
    assert.notEqual(result.dataset.transactions, raw.transactions);
    result.dataset.custom.untouched.push(9);
    assert.deepEqual(raw.custom.untouched, [1, 2, 3]);
  }
});

test("não muta fonte congelada e conserva campos não padronizados e __proto__ próprios", () => {
  const raw = dataset(series("frozen", 2));
  raw.unset = undefined;
  Object.defineProperty(raw, "__proto__", { value: { safe: true }, enumerable: true });
  raw.transactions.forEach(Object.freeze);
  Object.freeze(raw.transactions); Object.freeze(raw);
  const result = analyzeDataset(raw);
  assert.equal(result.repairable, true);
  assert.equal(raw.transactions[0].date, "2025-00-15");
  assert.ok(Object.hasOwn(result.dataset, "unset"));
  assert.ok(Object.hasOwn(result.dataset, "__proto__"));
  assert.deepEqual(result.dataset.__proto__, { safe: true });
  result.dataset.transactions[1].extra.keep.push("new");
  assert.deepEqual(raw.transactions[1].extra.keep, ["unchanged", null]);
});

test("rejeita estrutura inválida e mais de 100 mil transações sem descartar nenhuma", () => {
  for (const raw of [{}, { transactions: {} }, { transactions: [null] }, { transactions: ["bad"] }]) expectRefused(raw);
  const raw = dataset(Array.from({ length: 100001 }, (_, index) => ({ id: String(index), date: "2026-01-01" })));
  const result = expectRefused(raw);
  assert.equal(result.reason, "too_many_transactions");
  assert.equal(result.dataset.transactions.length, 100001);
});

test("helper funciona como script de navegador sem CommonJS nem globais de aplicação", () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js/cloud-repair.js"), "utf8") + "\nthis.analyze = CloudRepair.analyzeDataset;", context);
  const result = context.analyze(dataset());
  assert.equal(result.repairable, true);
  assert.equal(result.dataset.transactions[0].date, "2025-12-15");
});
