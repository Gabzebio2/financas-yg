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
    Date, Math, console, localStorage, InstallmentSchedule: require("../js/installment-schedule.js"),
    window: { top: null, self: null },
    document: {
      addEventListener() {},
      querySelector(selector) {
        if (!nodes.has(selector)) nodes.set(selector, { textContent: "", innerHTML: "", classList: { add() {}, remove() {} } });
        return nodes.get(selector);
      },
    },
    setTimeout: () => 1, clearTimeout() {},
    Cloud: { getFolderOwner:()=>"test-owner", ownsFolder:()=>true, onLocalChange() { notifyCount++; }, ...extraCloud },
    FileReader: class {
      readAsText(file) { this.result = file.content; this.onload(); }
    },
  });
  vm.runInContext(source + "\nglobalThis.core = { Store, CURRENCY_CODES, normCur, normDisplayCur, curFrac, fmtMoney, fmtMoneyInput, maskMoneyEl, dupTxKey, parseMoney, parseDateCell, isValidISODate, sanitizeDataset, mergeCloudDatasets, buildSyncPayload, planBackupRestore, importBackup, setMoneyMaskCurrency, moneyInputValue, renderFolders, billReferenceMonth, expenseReportDate, accountingDate, nextBillReferenceField, legacyBillReferenceOrigins };", context);
  return { ...context.core, localStorage, values, nodes, notifications: () => notifyCount };
}

function dataset(h, id = "folder0001") {
  const ds = h.Store.createDataset("Conta pessoal");
  ds.id = id;
  ds.updatedAt = "2026-01-01T10:00:00.000Z";
  ds.transactions.push({ id: "transac001", date: "2026-01-02", desc: "Mercado", type: "despesa", amount: 1234.56, currency: "BRL", category: "Essencial" });
  return ds;
}

test("competência prioriza ajuste e mês da conta, distingue pós-pago e mantém mês e dia do pagamento no extrato", () => {
  const h = harness();
  const bill = {type:"despesa", desc:"Personal - Telefonia", date:"2027-01-13", paymentStatus:"paid", paidOn:"2027-01-10"};
  for (const desc of ["Personal", "Pago de Servicio Personal - Internet", "Pos:personal pago de factura - personal"]) {
    assert.equal(h.billReferenceMonth({...bill,desc}), "2026-12");
  }
  for (const desc of ["Recarga Personal", "Préstamo personal - factura", "Personal Trainer", "Claro", "Farmácia"]) {
    assert.equal(h.billReferenceMonth({...bill,desc}), "2027-01");
  }
  const withText = {...bill,sourceEvidence:"Vencimento 13/01/2027. Competencia: noviembre de 2026."};
  assert.equal(h.billReferenceMonth(withText), "2026-11");
  assert.equal(h.billReferenceMonth({...withText,billReferenceMonth:"2026-10"}), "2026-10");
  for (const sourceEvidence of ["referência: 11/2026", "Ref: 2026/11", "referente ao mês de nov/2026", "Período de facturación: 2026-11",
      "Factura de noviembre", "PERÍODO DE CONSUMO de novembro de 2026", "Período de consumo: 01/11/2026 a 30/11/2026",
      "Referência: novembro de 2026 - vencimento em janeiro"]) {
    assert.equal(h.billReferenceMonth({...bill,sourceEvidence}), "2026-11", sourceEvidence);
  }
  for (const sourceEvidence of ["Pago em 05/10/2026", "Vencimento 05/11/2026", "Referencia bancaria 123123", "referência 2026-11-30", "referência: 05/11/2026",
      "Período de consumo: 28/10/2026 a 27/11/2026", "Período: outubro de 2026 a novembro de 2026"]) {
    assert.equal(h.billReferenceMonth({...bill,sourceEvidence}), "2026-12", sourceEvidence);
  }
  assert.equal(h.accountingDate(bill), "2027-01-10");
  assert.equal(h.expenseReportDate(bill), "2026-12-13");
  assert.equal(h.expenseReportDate({...bill,date:"2028-03-31"}), "2028-02-29");
  assert.equal(h.expenseReportDate({...bill,paidOn:"2026-12-30"}), "2026-12-30");
  assert.equal(h.expenseReportDate({...bill,advance:{scheduledDate:"2027-03-13",paidDate:"2027-01-10"}}), "2027-02-13");
  for (const other of [{paymentStatus:undefined},{type:"receita"},{account:"C6",c6Section:"card"},{invoice:{}}]) {
    assert.equal(h.billReferenceMonth({...bill,...other}), "");
  }
});

test("competência corrigida sobrevive ao backup e a próximas ocorrências sem congelar o ano", () => {
  const h = harness(), ds = dataset(h), t = ds.transactions[0];
  Object.assign(t,{paymentStatus:"pending",date:"2026-12-11",desc:"Água • Ref. outubro/2026",billReferenceMonth:"2026-11",
    fixed:true,groupId:"fixedgroup1",repeatMonth:"2026-12",repeatMonthlyDay:11,repeatThrough:"2027-12",repeatKey:"fixedkey1",
    repeatBillReferenceMonth:"2026-10"});
  h.Store.saveDataset(ds);
  const restored = h.sanitizeDataset(h.buildSyncPayload().datasets[0], {preserveIds:true});
  for (const copy of [restored.transactions[0], h.Store.loadDataset(ds.id).transactions[0]]) {
    assert.equal(copy.billReferenceMonth, "2026-11");
    assert.equal(copy.repeatBillReferenceMonth, "2026-10");
    assert.equal(h.nextBillReferenceField(copy,"2027-02-11").billReferenceMonth, "2027-01");
    const projected = h.nextBillReferenceField({...copy,billReferenceMonth:undefined},"2027-02-11");
    assert.equal(projected.billReferenceMonth, undefined);
    assert.equal(h.billReferenceMonth({...copy,billReferenceMonth:undefined,date:"2027-02-11",...projected}), "2026-12");
  }
  t.billReferenceMonth = ["2026-11"]; t.repeatBillReferenceMonth = "2026-13";
  h.Store.saveDataset(ds);
  for (const copy of [h.sanitizeDataset(ds).transactions[0],h.Store.loadDataset(ds.id).transactions[0]]) {
    assert.equal(copy.billReferenceMonth, undefined);
    assert.equal(copy.repeatBillReferenceMonth, undefined);
    assert.equal(h.billReferenceMonth(copy),"2026-10");
  }
});

test("referência impressa segue a série inclusive no 13º mês e reaparece ao remover só a exceção manual", () => {
  const h = harness(), ds = dataset(h), base = ds.transactions[0];
  Object.assign(base,{date:"2026-12-13",paymentStatus:"pending",desc:"Personal - Ref: novembro",billReferenceMonth:"2026-10"});
  const next = {...base,...h.nextBillReferenceField(base,"2027-12-13"),date:"2027-12-13"};
  assert.equal(h.billReferenceMonth(next),"2027-10");
  delete next.billReferenceMonth;
  assert.equal(h.billReferenceMonth(next),"2027-11");
  assert.equal(h.billReferenceMonth({...next,sourceEvidence:"Factura de diciembre 2027"}),"2027-12");
  assert.equal(h.billReferenceMonth({...next,desc:"Regra alterada - Ref: outubro de 2027"}),"2027-10");
  ds.transactions[0] = next;
  h.Store.saveDataset(ds);
  for (const copy of [h.Store.loadDataset(ds.id), h.sanitizeDataset(h.buildSyncPayload().datasets[0])]) {
    assert.equal(h.billReferenceMonth(copy.transactions[0]),"2027-11");
    assert.equal(copy.transactions[0].billReferenceMonth,undefined);
  }
  const evidenceOnly = {...base,desc:"Energia",sourceEvidence:"Referência 11/2026",billReferenceMonth:undefined};
  const second = {...evidenceOnly, ...h.nextBillReferenceField(evidenceOnly,"2027-01-13"),date:"2027-01-13",sourceEvidence:""};
  assert.equal(h.billReferenceMonth(second),"2026-12");
});

test("histórico legado projeta só séries homogêneas consecutivas, sem editar os registros", () => {
  const h = harness(), original = {type:"despesa",fixed:true,groupId:"ficticio",paymentStatus:"paid",desc:"Água ref. novembro/2026",account:"Banco",currency:"PYG"};
  const rows = ["2027-02-13","2026-12-13","2027-01-13"].map((date,i) => ({...original,id:"linha"+i,date,paidOn:date}));
  const old = JSON.stringify(rows), origins = h.legacyBillReferenceOrigins(rows);
  assert.equal(JSON.stringify(rows),old);
  assert.equal(h.billReferenceMonth(rows[0],origins.get("linha0")),"2027-01");
  assert.equal(h.expenseReportDate(rows[0],origins.get("linha0")),"2027-01-13");
  assert.equal(h.billReferenceMonth({...rows[0],billReferenceMonth:"2027-02"},origins.get("linha0")),"2027-02");
  for (const change of [{date:"2027-06-13"},{date:rows[1].date},{account:"Outro"},{desc:"Outra fatura"},{sourceEvidence:"Competência 05/2026"}]) {
    assert.equal(h.legacyBillReferenceOrigins([{...rows[0],...change},...rows.slice(1)]).size,0);
  }
});

test("baixa mensal do C6 passa por armazenamento, backup e nuvem sem criar lançamento", () => {
  const h = harness(), ds = dataset(h);
  assert.equal(h.sanitizeDataset(ds).c6InvoicePayments, undefined);
  ds.c6InvoicePayments = {"2026-11":{paidOn:"2026-12-05", totals:{BRL:164.90, USD:12, USDC:-0.000004}}};
  h.Store.saveDataset(ds);
  const snapshot = h.buildSyncPayload().datasets.find(folder => folder.id === ds.id);
  for (const result of [h.Store.loadDataset(ds.id), h.sanitizeDataset(snapshot, {preserveIds:true}), h.sanitizeDataset(snapshot)]) {
    assert.deepEqual(JSON.parse(JSON.stringify(result.c6InvoicePayments)), ds.c6InvoicePayments);
    assert.equal(result.transactions.length, 1);
  }
  for (const invalid of [null, [], {"2026-13":ds.c6InvoicePayments["2026-11"]},
      {"2026-11":{paidOn:"2026-12-32", totals:{BRL:24}}}, {"2026-11":{paidOn:"2026-12-05",totals:{BRL:"20"}}}]) {
    assert.equal(h.sanitizeDataset({...snapshot, c6InvoicePayments:invalid}), null);
  }
});

test("identificação da série C6 e data da compra sobrevivem à sincronização e restauração", () => {
  const h = harness(), ds = dataset(h);
  Object.assign(ds.transactions[0], {installment:"2/5",purchaseDate:"2025-12-02",seriesKey:"c6:v1:exemplo"});
  h.Store.saveDataset(ds);
  const tx = h.sanitizeDataset(h.Store.loadDataset(ds.id), {preserveIds:true,preserveContent:true}).transactions[0];
  assert.equal(tx.date, "2026-01-02");
  assert.equal(tx.purchaseDate, "2025-12-02");
  assert.equal(tx.seriesKey, "c6:v1:exemplo");
  ds.transactions[0].purchaseDate = "2025-13-02";
  assert.equal(h.sanitizeDataset(ds).transactions[0].purchaseDate, undefined);
});

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
  const names = new Set(clean.categories.map(c => c.name));
  assert.ok(ds.categories.every(c => names.has(c.name)));
  for (const name of ["Essencial", "Mercado", "Receita"]) assert.ok(names.has(name));
  assert.equal(names.size, 123);
});

test("Salário passa a Receita em pastas pessoais com as cores, metas e versões dos limites", () => {
  const h = harness(), ds = dataset(h);
  ds.categories = [{name:"Salário",color:"#146238"},{name:"Mercado da Vila",color:"#123456"}];
  Object.assign(ds.transactions[0], {category:"Salário", categoryEdited:true, type:"receita"});
  ds.limits = [{id:"limit001",name:"Limite mensal",categories:["Salário"],amount:100,versions:[
    {from:"2026-01",categories:["Salário","Receita"],amount:100}]}];
  ds.metas = [{id:"goal0001",name:"Pagamento",category:"Salário"}];
  h.Store.saveDataset(ds);
  for (const migrated of [h.Store.loadDataset(ds.id), h.sanitizeDataset(ds, {preserveIds:true})]) {
    assert.equal(migrated.transactions[0].category,"Receita");
    assert.equal(migrated.transactions[0].categoryEdited,true);
    assert.equal(migrated.categories.find(c => c.name === "Receita").color,"#146238");
    assert.equal(migrated.metas[0].category,"Receita");
    assert.equal(migrated.limits[0].categories.join(","),"Receita");
    assert.equal(migrated.limits[0].versions[0].categories.join(","),"Receita");
    assert.ok(migrated.categories.some(c => c.name === "Mercado"));
    assert.ok(migrated.categories.some(c => c.name === "Mercado da Vila"));
  }
  ds.categories.push({name:"Receita",color:"#112233"});
  const result = h.sanitizeDataset(ds, {preserveIds:true});
  assert.equal(result.categories.filter(c => c.name === "Receita").length,1);
  assert.equal(result.categories.find(c => c.name === "Receita").color,"#112233");
  ds.profile = "pj";
  assert.equal(h.sanitizeDataset(ds, {preserveIds:true}).transactions[0].category,"Salário");
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

test("criar cópias explicitamente atribui novos IDs e preserva o conteúdo", () => {
  const h = harness();
  const original = dataset(h);
  h.importBackup({ size: 100, content: JSON.stringify({ app: "financas-yg", version: 1, datasets: [original] }) }, true);
  const idx = h.Store.loadIndex();
  assert.equal(idx.length, 1);
  assert.notEqual(idx[0].id, original.id);
  const imported = h.Store.loadDataset(idx[0].id);
  assert.notEqual(imported.transactions[0].id, original.transactions[0].id);
  assert.equal(imported.transactions[0].amount, 1234.56);
});

test("restaurar repetidamente só acrescenta IDs ausentes e conserva edições, baixas e compras legítimas iguais", () => {
  const h=harness(), ds=dataset(h);
  ds.transactions.push({...ds.transactions[0],id:"wa_01234567890123456789012345678901"});
  const file={size:1000,content:JSON.stringify({app:"financas-yg",version:1,datasets:[ds]})};
  h.importBackup(file);h.importBackup(file);
  assert.equal(h.Store.loadIndex().length,1);assert.equal(h.Store.loadDataset(ds.id).transactions.length,2);
  const after=h.Store.loadDataset(ds.id);
  Object.assign(after.transactions[0],{desc:"Já pago",paymentStatus:"paid",paidOn:"2026-01-14"});
  h.Store.saveDataset(after);
  ds.transactions.push({...ds.transactions[0],id:"absence003"});
  file.content=JSON.stringify({app:"financas-yg",version:1,datasets:[ds]});
  h.importBackup(file);h.importBackup(file);
  const current=h.Store.loadDataset(ds.id);
  assert.equal(current.transactions.length,3);
  assert.equal(current.transactions[0].paidOn,"2026-01-14");assert.equal(current.transactions[0].desc,"Já pago");
  assert.equal(current.transactions[1].id,ds.transactions[1].id);
});

test("tipo e moeda incompatíveis indicam o item, sem conversão silenciosa nem gravação parcial", () => {
  for(const extra of [{type:"transfer"},{currency:"CAD"}]){
    const h=harness(), original=dataset(h), invalid=dataset(h,"folder0002");
    Object.assign(invalid.transactions[0],extra);
    h.importBackup({size:1000,content:JSON.stringify({app:"financas-yg",version:1,datasets:[original,invalid]})});
    assert.equal(h.Store.loadIndex().length,0);
    assert.match(h.nodes.get("#toast").textContent,/lançamento 1 com (tipo|moeda) incompatível/);
    h.Store.saveDataset(invalid);
    assert.equal(h.Store.loadDataset(invalid.id),null);
    assert.equal(h.Store._rawDataset(invalid.id).transactions[0][Object.keys(extra)[0]],Object.values(extra)[0]);
  }
});

test("um ID reservado por outra conta não permite restaurar sobre dados ocultos", () => {
  const h = harness({ownsFolder:()=>false, isReservedFolderId:()=>true});
  const ds = dataset(h), source = {...ds, name:"Outra pasta"};
  h.Store.saveDataset(ds);
  const initial = JSON.stringify(h.Store._rawDataset(ds.id));
  h.importBackup({size:100,content:JSON.stringify({app:"financas-yg",version:1,datasets:[source]})});
  assert.equal(JSON.stringify(h.Store._rawDataset(ds.id)),initial);
  assert.equal(h.Store.loadIndex().length,1);
  assert.match(h.nodes.get("#toast").textContent,/vínculo anterior/);
});

test("restauração de baixas C6 é opcional mesmo quando é a única diferença; mês pago mantém sua edição", () => {
  const h = harness(), saved = dataset(h);
  const backup = {...saved, c6InvoicePayments:{
    "2026-10":{paidOn:"2026-11-04",totals:{BRL:123}},
    "2026-09":{paidOn:"2026-10-05",totals:{BRL:100}}
  }};
  saved.c6InvoicePayments = {"2026-09":{paidOn:"2026-10-06",totals:{BRL:101}}};
  const sanitized = h.sanitizeDataset(saved,{preserveIds:true,preserveContent:true,rejectInvalidTransactions:true});
  h.Store.saveDataset(sanitized);
  const keep = h.planBackupRestore([backup],false);
  assert.equal(keep.changes.length,0);
  assert.equal(keep.availablePayments.length,1);
  const recover = h.planBackupRestore([backup],false,true);
  h.Store.saveDatasets(recover.changes);
  const current = h.Store.loadDataset(saved.id);
  assert.equal(current.transactions.length,1);
  assert.equal(current.c6InvoicePayments["2026-10"].paidOn,"2026-11-04");
  assert.equal(current.c6InvoicePayments["2026-09"].paidOn,"2026-10-06");
  assert.equal(h.planBackupRestore([backup],false,true).changes.length,0);
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
