"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../js/app.js"), "utf8");

function harness(extraCloud = {}) {
  const values = new Map();
  const nodes = new Map();
  let notifyCount = 0;
  const localStorage = {
    failOnce: null,
    get length() { return values.size; },
    key: (n) => [...values.keys()][n] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) {
      if (this.failOnce?.(key, value)) {
        this.failOnce = null;
        throw new Error("QuotaExceededError");
      }
      values.set(key, String(value));
    },
    removeItem: (key) => values.delete(key),
  };
  const context = vm.createContext({
    Date, Math, console, localStorage,
    window: { top: null, self: null },
    document: {
      addEventListener() {},
      querySelector(selector) {
        if (!nodes.has(selector)) nodes.set(selector, { textContent: "", innerHTML: "", classList: { add() {}, remove() {} } });
        return nodes.get(selector);
      },
    },
    setTimeout: () => 1, clearTimeout() {},
    Cloud: { onLocalChange() { notifyCount++; }, ...extraCloud },
    FileReader: class {
      readAsText(file) { this.result = file.content; this.onload(); }
    },
  });
  vm.runInContext(source + "\nglobalThis.core = { Store, CURRENCY_CODES, normCur, normDisplayCur, curFrac, fmtMoney, fmtMoneyInput, maskMoneyEl, dupTxKey, parseMoney, parseDateCell, isValidISODate, sanitizeDataset, mergeCloudDatasets, buildSyncPayload, importBackup, setMoneyMaskCurrency, moneyInputValue, renderFolders };", context);
  return { ...context.core, localStorage, values, nodes, notifications: () => notifyCount };
}

function dataset(h, id = "folder0001") {
  const ds = h.Store.createDataset("Conta pessoal");
  ds.id = id;
  ds.updatedAt = "2026-01-01T10:00:00.000Z";
  ds.transactions.push({ id: "transac001", date: "2026-01-02", desc: "Mercado", type: "despesa", amount: 1234.56, currency: "BRL", category: "Essencial" });
  return ds;
}

test("data aproximada preserva âncoras no armazenamento, backup e restauração", () => {
  const h = harness(), ds = dataset(h);
  const metadata = { dateEstimated: true, dateEstimate: { method: "between", previousDate: "2025-12-31", nextDate: "2026-01-04" } };
  Object.assign(ds.transactions[0], metadata);
  h.Store.saveDataset(ds);
  const loaded = h.Store.loadDataset(ds.id);
  assert.equal(loaded.transactions[0].dateEstimated, true);
  assert.deepEqual(JSON.parse(JSON.stringify(loaded.transactions[0].dateEstimate)), metadata.dateEstimate);
  const backup = h.buildSyncPayload();
  const backed = backup.datasets.find(item => item.id === ds.id);
  assert.deepEqual(JSON.parse(JSON.stringify(backed.transactions[0].dateEstimate)), metadata.dateEstimate);
  const restored = h.sanitizeDataset(backed, { preserveIds: true, preserveContent: true, rejectInvalidTransactions: true });
  assert.equal(restored.transactions[0].date, "2026-01-02");
  assert.equal(restored.transactions[0].dateEstimated, true);
  assert.equal(restored.transactions[0].amount, ds.transactions[0].amount);
  assert.deepEqual(JSON.parse(JSON.stringify(restored.transactions[0].dateEstimate)), metadata.dateEstimate);
  for (const dateEstimate of [
    { method: "between", previousDate: "2026-01-04", nextDate: "2025-12-31" },
    { method: "nearest", previousDate: "2026-01-02" },
    { method: "nearest", nextDate: "2026-01-02" },
  ]) {
    ds.transactions[0].dateEstimate = dateEstimate;
    assert.equal(h.sanitizeDataset(ds, { preserveContent: true }).transactions[0].dateEstimated, true);
  }
});

test("metadados incoerentes não viram rótulos de data aproximada nem alteram transação", () => {
  const h = harness(), ds = dataset(h), original = { ...ds.transactions[0] };
  const invalid = [
    { dateEstimated: true },
    { dateEstimated: "true", dateEstimate: { method: "nearest", previousDate: original.date } },
    { dateEstimated: true, dateEstimate: { method: "today", previousDate: original.date } },
    { dateEstimated: true, dateEstimate: { method: "between", previousDate: "2025-12-31" } },
    { dateEstimated: true, dateEstimate: { method: "between", previousDate: "2026-01-03", nextDate: "2026-01-05" } },
    { dateEstimated: true, dateEstimate: { method: "nearest", previousDate: "2026-01-03" } },
    { dateEstimated: true, dateEstimate: { method: "nearest", previousDate: original.date, nextDate: original.date } },
    { dateEstimated: true, dateEstimate: { method: "nearest", previousDate: "2026-02-31" } },
    { dateEstimated: true, dateEstimate: { method: "nearest", previousDate: original.date, verified: true } },
    { dateEstimate: { method: "nearest", previousDate: original.date } },
  ];
  for (const extra of invalid) {
    ds.transactions = [{ ...original, ...extra }];
    const clean = h.sanitizeDataset(ds, { preserveIds: true, preserveContent: true }).transactions[0];
    assert.equal(clean.dateEstimated, undefined); assert.equal(clean.dateEstimate, undefined);
    assert.equal(clean.date, original.date); assert.equal(clean.amount, original.amount);
    h.Store.saveDataset(ds);
    const loaded = h.Store.loadDataset(ds.id).transactions[0];
    assert.equal(loaded.dateEstimated, undefined); assert.equal(loaded.dateEstimate, undefined);
    assert.equal(loaded.id, original.id); assert.equal(loaded.amount, original.amount);
  }
});

test("revisão WhatsApp sobrevive a sanitização, armazenamento e payload sem aceitar marcadores inválidos", () => {
  const h = harness(), ds = dataset(h);
  ds.whatsappRevision = 7;
  const clean = h.sanitizeDataset(ds, { preserveIds: true, preserveContent: true, rejectInvalidTransactions: true });
  assert.equal(clean.whatsappRevision, 7);
  h.Store.saveDataset(clean, { origin: "remote", preserveUpdatedAt: true });
  assert.equal(h.Store.loadDataset(clean.id).whatsappRevision, 7);
  assert.equal(h.buildSyncPayload().datasets.find(item => item.id === clean.id).whatsappRevision, 7);
  for (const invalid of [-1, 1.2, "7", Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(h.sanitizeDataset({ ...ds, whatsappRevision: invalid }, { preserveIds: true }), null);
  }
  assert.equal(h.sanitizeDataset({ ...ds, whatsappRevision: 0 }, { preserveIds: true }).whatsappRevision, 0);
});

test("alterações locais notificam apenas as pastas salvas e pull não cria pendência", () => {
  const ids = [];
  const h = harness({ onLocalChange: (saved) => ids.push(...saved) });
  const first = dataset(h), second = dataset(h, "folder0002");
  h.Store.saveDatasets([first, second]);
  assert.deepEqual(ids, [first.id, second.id]);
  h.Store.saveDataset(first, { preserveUpdatedAt: true, origin: "remote" });
  assert.deepEqual(ids, [first.id, second.id]);
});

test("exclusão preserva intenção na nuvem junto com a remoção local e reverte em falha", () => {
  let notified = 0;
  const queueKey = "fyg:test-delete-queue";
  const h = harness({
    prepareLocalDelete: (id) => [{ key: queueKey, value: JSON.stringify([id]) }],
    onLocalDelete: () => notified++,
  });
  const ds = dataset(h);
  h.Store.saveDataset(ds);
  const before = new Map(h.values);
  h.localStorage.failOnce = (key) => key === "fyg:index";
  assert.throws(() => h.Store.deleteDataset(ds.id), { name: "StorageError" });
  assert.deepEqual(h.values, before);
  assert.equal(notified, 0);
  h.Store.deleteDataset(ds.id);
  assert.equal(h.Store.loadDataset(ds.id), null);
  assert.deepEqual(JSON.parse(h.localStorage.getItem(queueKey)), [ds.id]);
  assert.equal(notified, 1);
});

test("datas são reais, ano bissexto correto e textos extras são rejeitados", () => {
  const h = harness();
  for (const value of ["31/02/2026", "29/02/2025", "2026-13-01", "2026-04-31", "2026-01-01 lixo", "00/01/2026", Infinity, NaN]) assert.equal(h.parseDateCell(value), null, String(value));
  assert.equal(h.parseDateCell("29/02/2024"), "2024-02-29");
  assert.equal(h.parseDateCell("1/3/26"), "2026-03-01");
  assert.equal(h.parseDateCell("2026-03-01T23:00:00-03:00"), "2026-03-01");
  assert.equal(h.isValidISODate("1900-02-29"), false);
  assert.equal(h.isValidISODate("2000-02-29"), true);
});

test("horário fracionário do Excel não avança para o dia seguinte", () => {
  const h = harness();
  assert.equal(h.parseDateCell(46000.9), h.parseDateCell(46000));
  assert.equal(h.parseDateCell(new Date(2026, 9, 9, 22)), "2026-10-09");
});

test("dinheiro aceita formatos brasileiro/americano e rejeita valores parciais", () => {
  const h = harness();
  for (const [input, expected] of [["R$ 1.234,56", 1234.56], ["US$ 1,234.56", 1234.56], ["1.234", 1234], ["1.234.567", 1234567], ["1,234,567", 1234567], ["1,23", 1.23], ["0.123", 0.123], ["(R$ 80,25)", -80.25], ["-42,50", -42.5], ["25.50", 25.5]]) assert.equal(h.parseMoney(input), expected, input);
  for (const input of ["12..34", "12,34,56", "80-25", "1.234,56,7", "10 reais e 20 centavos", {}, true, NaN, Infinity]) assert.equal(h.parseMoney(input), null, String(input));
});

test("troca de moeda mantém valor nominal sem multiplicar por cem", () => {
  const h = harness();
  const el = { value: "R$ 123,00", dataset: { cur: "BRL" } };
  h.setMoneyMaskCurrency(el, "CLP");
  assert.equal(h.moneyInputValue(el), 123);
  h.setMoneyMaskCurrency(el, "BRL");
  assert.equal(h.moneyInputValue(el), 123);
});

test("preferência DEFAULT pertence à exibição; legado mantém BRL e moedas explícitas", () => {
  const h = harness();
  assert.equal(h.Store.createDataset("Nova").displayCurrency, "DEFAULT");
  for (const display of [...h.CURRENCY_CODES, "DEFAULT", undefined]) {
    const ds = dataset(h); ds.displayCurrency = display;
    ds.transactions[0].currency = "DEFAULT";
    const clean = h.sanitizeDataset(ds, { preserveIds: true });
    assert.equal(clean.displayCurrency, display ?? "BRL");
    assert.equal(clean.transactions[0].currency, "BRL");
    h.Store.saveDataset(ds);
    assert.equal(h.Store.loadDataset(ds.id).displayCurrency, display ?? "BRL");
  }
  assert.equal(h.normDisplayCur("USDT"), "USDT");
  assert.equal(h.normDisplayCur("DEFAULT"), "DEFAULT");
  assert.equal(h.normCur("DEFAULT"), "BRL");
});

test("stablecoins têm símbolo próprio e seis casas em formato, máscara e parser", () => {
  const h = harness();
  for (const cur of ["USDT", "USDC"]) {
    assert.equal(h.curFrac(cur), 6);
    assert.equal(h.fmtMoney(1.234567, cur), `${cur} 1.234567`);
    assert.equal(h.parseMoney(`${cur} 1.234`), 1.234);
    assert.equal(h.parseMoney("1.234", cur), 1.234);
    assert.equal(h.parseMoney(`${cur} 0.000001`), 0.000001);
    const input = { value: "1234567", dataset: { cur } }; h.maskMoneyEl(input);
    assert.equal(input.value, `${cur} 1.234567`); assert.equal(h.moneyInputValue(input), 1.234567);
    input.value = h.fmtMoneyInput(0.000001, cur); assert.equal(h.moneyInputValue(input), 0.000001);
  }
  assert.equal(h.parseMoney("€ 1.234,56"), 1234.56);
  assert.equal(h.parseMoney("£1,234.56"), 1234.56);
  assert.notEqual(h.dupTxKey("2026-01-01", "Compra", 1.000001, "despesa"), h.dupTxKey("2026-01-01", "Compra", 1.000002, "despesa"));
});

test("moedas novas e seis casas sobrevivem a armazenamento, backup e merge da nuvem", () => {
  const h = harness(), ds = dataset(h); ds.displayCurrency = "DEFAULT";
  ds.transactions = ["EUR", "GBP", "USDT", "USDC"].map((currency, index) => ({ ...ds.transactions[0], id: "transac" + (index + 10), currency, amount: currency.startsWith("USD") ? 12.123456 : 12.34, totalValue: currency.startsWith("USD") ? 24.246912 : 24.68 }));
  ds.metas = [{ id: "goaltoken1", name: "Meta", target: 1.123456, saved: 0.000001, currency: "USDC" }];
  h.Store.saveDataset(ds, { preserveUpdatedAt: true });
  const expected = ds.transactions.map((tx) => [tx.currency, tx.amount, tx.totalValue]);
  const restored = harness(); restored.importBackup({ size: 1000, content: JSON.stringify(h.buildSyncPayload()) });
  const recovered = restored.Store.loadDataset(restored.Store.loadIndex()[0].id);
  assert.deepEqual(Array.from(recovered.transactions, (tx) => [tx.currency, tx.amount, tx.totalValue]), expected);
  assert.equal(recovered.displayCurrency, "DEFAULT"); assert.equal(recovered.metas[0].saved, 0.000001);
  const remote = { ...ds, updatedAt: "2027-01-01T00:00:00.000Z" };
  assert.equal(h.mergeCloudDatasets([remote]).updated, 1);
  assert.deepEqual(Array.from(h.Store.loadDataset(ds.id).transactions, (tx) => [tx.currency, tx.amount, tx.totalValue]), expected);
});

test("índice inválido, ausente ou com referências órfãs é recuperado pelas pastas", () => {
  const h = harness();
  const ds = dataset(h);
  h.Store.saveDataset(ds);
  for (const invalid of ["{", "{}", "null", '[{"id":"missing000"}]']) {
    h.localStorage.setItem("fyg:index", invalid);
    const idx = h.Store.loadIndex();
    assert.equal(idx.length, 1);
    assert.equal(idx[0].id, ds.id);
    assert.equal(idx[0].txCount, 1);
  }
});

test("falha no índice reverte pasta e timestamp sem notificar nuvem", () => {
  const h = harness();
  const ds = dataset(h);
  h.Store.saveDataset(ds, { preserveUpdatedAt: true });
  const before = new Map(h.values);
  ds.name = "Nome novo";
  h.localStorage.failOnce = (key) => key === "fyg:index";
  assert.throws(() => h.Store.saveDataset(ds), { name: "StorageError" });
  assert.deepEqual(h.values, before);
  assert.equal(ds.updatedAt, "2026-01-01T10:00:00.000Z");
  assert.equal(h.notifications(), 1);
});

test("falha no meio do lote remove pastas novas e preserva anteriores", () => {
  const h = harness();
  const existing = dataset(h);
  h.Store.saveDataset(existing);
  const before = new Map(h.values);
  const one = dataset(h, "folder0002");
  const two = dataset(h, "folder0003");
  h.localStorage.failOnce = (key) => key === "fyg:ds:folder0003";
  assert.throws(() => h.Store.saveDatasets([one, two]), { name: "StorageError" });
  assert.deepEqual(h.values, before);
  assert.equal(h.notifications(), 1);
});

test("exclusão só remove a pasta quando o índice puder ser salvo", () => {
  const h = harness();
  const ds = dataset(h);
  h.Store.saveDataset(ds);
  const before = new Map(h.values);
  h.localStorage.failOnce = (key) => key === "fyg:index";
  assert.throws(() => h.Store.deleteDataset(ds.id), { name: "StorageError" });
  assert.deepEqual(h.values, before);
});

test("sanitização rejeita datas impossíveis no modo estrito e evita IDs duplicados", () => {
  const h = harness();
  const ds = dataset(h);
  ds.transactions.push({ ...ds.transactions[0] });
  const clean = h.sanitizeDataset(ds, { preserveIds: true });
  assert.notEqual(clean.transactions[0].id, clean.transactions[1].id);
  assert.equal(clean.transactions[0].totalValue, null);
  ds.transactions[0].date = "2026-02-31";
  assert.equal(h.sanitizeDataset(ds, { rejectInvalidTransactions: true }), null);
});

test("backup preserva coleções longas em vez de truncar silenciosamente", () => {
  const h = harness();
  const ds = dataset(h);
  ds.categories = Array.from({ length: 120 }, (_, i) => ({ name: "Categoria " + i, color: "#ffffff" }));
  ds.metas = Array.from({ length: 120 }, (_, i) => ({ id: "meta" + String(i).padStart(5, "0"), name: "Meta " + i, target: 1000, saved: 1 }));
  const clean = h.sanitizeDataset(ds);
  assert.equal(clean.metas.length, 120);
  assert.equal(clean.categories.length, 121);
});

test("nuvem mantém updatedAt original e compara instantes com fusos distintos", () => {
  const h = harness();
  const ds = dataset(h);
  ds.updatedAt = "2026-01-01T12:00:00Z";
  h.Store.saveDataset(ds, { preserveUpdatedAt: true });
  const remote = { ...ds, name: "Versão da nuvem", updatedAt: "2026-01-01T10:00:00-03:00" };
  assert.equal(h.mergeCloudDatasets([remote]).updated, 1);
  const saved = h.Store.loadDataset(ds.id);
  assert.equal(saved.name, "Versão da nuvem");
  assert.equal(saved.updatedAt, "2026-01-01T13:00:00.000Z");
  assert.equal(h.mergeCloudDatasets([remote]).updated, 0);
});

test("dados remotos inválidos não substituem pasta íntegra", () => {
  const h = harness();
  const ds = dataset(h);
  h.Store.saveDataset(ds, { preserveUpdatedAt: true });
  const remote = { ...ds, updatedAt: "2027-01-01T10:00:00Z", transactions: [{ ...ds.transactions[0], date: "2026-02-31" }] };
  assert.equal(h.mergeCloudDatasets([remote]).updated, 0);
  assert.equal(h.Store.loadDataset(ds.id).transactions.length, 1);
});

test("backup misto inválido é rejeitado inteiro antes da primeira gravação", () => {
  const h = harness();
  const valid = dataset(h);
  const invalid = dataset(h, "folder0002");
  invalid.transactions[0].date = "2026-02-31";
  h.importBackup({ size: 100, content: JSON.stringify({ app: "financas-yg", version: 1, datasets: [valid, invalid] }) });
  assert.equal(h.values.size, 0);
  assert.match(h.nodes.get("#toast").textContent, /Nenhuma pasta/);
});

test("backup válido cria cópias com novos IDs e preserva o conteúdo", () => {
  const h = harness();
  const original = dataset(h);
  h.importBackup({ size: 100, content: JSON.stringify({ app: "financas-yg", version: 1, datasets: [original] }) });
  const idx = h.Store.loadIndex();
  assert.equal(idx.length, 1);
  assert.notEqual(idx[0].id, original.id);
  const imported = h.Store.loadDataset(idx[0].id);
  assert.notEqual(imported.transactions[0].id, original.transactions[0].id);
  assert.equal(imported.transactions[0].amount, 1234.56);
});

test("backup com versão desconhecida não escreve dados", () => {
  const h = harness();
  h.importBackup({ size: 100, content: JSON.stringify({ app: "financas-yg", version: 99, datasets: [dataset(h)] }) });
  assert.equal(h.values.size, 0);
});

test("texto existente e categorias longas sobrevivem a leitura e restauração", () => {
  const h = harness();
  const ds = dataset(h);
  ds.transactions[0].desc = "Descrição extensa ".repeat(20).trim();
  ds.transactions[0].category = "Categoria especial de despesas com mais de quarenta letras";
  h.Store.saveDataset(ds);
  assert.equal(h.Store.loadDataset(ds.id).transactions[0].desc, ds.transactions[0].desc);
  const backup = h.buildSyncPayload();
  const restored = harness();
  restored.importBackup({ size: 1000, content: JSON.stringify(backup) });
  const copy = restored.Store.loadDataset(restored.Store.loadIndex()[0].id);
  assert.equal(copy.transactions[0].desc, ds.transactions[0].desc);
  assert.equal(copy.transactions[0].category, ds.transactions[0].category);
});

test("leitura local preserva IDs, grupos, valores legados e campos adicionais", () => {
  const h = harness();
  const ds = dataset(h);
  ds.transactions[0].groupId = "grupo-legado-com-hifens";
  ds.transactions[0].amount = -0.01;
  ds.transactions[0].observation = "Dado de uma versão anterior";
  ds.transactions.push({ ...ds.transactions[0], id: "transac002", amount: 0 });
  h.Store.saveDataset(ds);
  const loaded = h.Store.loadDataset(ds.id);
  assert.equal(loaded.transactions.length, 2);
  assert.equal(loaded.transactions[0].id, "transac001");
  assert.equal(loaded.transactions[0].groupId, "grupo-legado-com-hifens");
  assert.equal(loaded.transactions[0].amount, -0.01);
  assert.equal(loaded.transactions[0].observation, "Dado de uma versão anterior");
  assert.equal(loaded.transactions[1].amount, 0);
  const imported = h.sanitizeDataset(ds, { rejectInvalidTransactions: true });
  assert.equal(imported.transactions[0].amount, -0.01);
  assert.equal(imported.transactions[1].amount, 0);
});

test("pasta inconsistente fica visível e original continua disponível para backup", () => {
  const h = harness();
  const ds = dataset(h);
  ds.transactions[0].date = "2026-02-31";
  h.localStorage.setItem("fyg:ds:" + ds.id, JSON.stringify(ds));
  assert.equal(h.Store.loadDataset(ds.id), null);
  assert.equal(h.Store.loadIndex()[0].id, ds.id);
  assert.equal(h.Store._rawDataset(ds.id).transactions[0].date, "2026-02-31");
});

test("backup não descarta metas ou histórico de limites inválidos silenciosamente", () => {
  const h = harness();
  const ds = dataset(h);
  ds.metas = [{ id: "meta000001", name: "Reserva", target: "inválido" }];
  assert.equal(h.sanitizeDataset(ds, { rejectInvalidTransactions: true }), null);
  ds.metas = { antiga: 100 };
  assert.equal(h.sanitizeDataset(ds, { rejectInvalidTransactions: true }), null);
  ds.metas = [];
  ds.limits = [{ id: "limit00001", name: "Orçamento", amount: 100, categories: ["Essencial"], versions: [{ from: "2026-13", amount: 100, categories: ["Essencial"] }] }];
  assert.equal(h.sanitizeDataset(ds, { rejectInvalidTransactions: true }), null);
});

test("data de atualização da pasta usa o calendário local do navegador", () => {
  const h = harness();
  const ds = dataset(h);
  const at = new Date(2026, 9, 9, 23, 30);
  ds.updatedAt = at.toISOString();
  h.Store.saveDataset(ds, { preserveUpdatedAt: true });
  h.renderFolders();
  assert.match(h.nodes.get("#folders-grid").innerHTML, /atualizada em 09\/10\/2026/);
});

test("nuvem antiga não apaga pasta local inconsistente mais recente", () => {
  const h = harness();
  const remote = dataset(h);
  const local = structuredClone(remote);
  local.updatedAt = "2027-01-01T10:00:00.000Z";
  local.transactions[0].date = "2026-02-31";
  h.localStorage.setItem("fyg:ds:" + local.id, JSON.stringify(local));
  assert.equal(h.mergeCloudDatasets([remote]).updated, 0);
  assert.equal(h.Store._rawDataset(local.id).transactions[0].date, "2026-02-31");
});
