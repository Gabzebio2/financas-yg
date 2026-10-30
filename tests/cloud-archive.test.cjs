"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const CloudArchive = require("../js/cloud-archive.js");
const clone = (value) => JSON.parse(JSON.stringify(value));
const USER = "11111111-1111-4111-8111-111111111111";
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

function folder(id = "copy001", name = "CASINHA") {
  return { id, name, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-10-23T12:00:00Z", profile: "pf", displayCurrency: "BRL",
    transactions: [1, 2].map((part) => ({ id: id + "tx" + part, groupId: id + "group", date: `2026-0${part}-15`,
      desc: "Compra", amount: 12.35, currency: "BRL", type: "despesa", category: "Outros", account: "Conta",
      installment: `${part}/2`, totalValue: 24.70, fixed: false, unknown: { preserve: [0, false, null] } })),
    categories: [{ name: "Outros", color: "#123456" }],
    metas: [{ id: id + "goal", name: "Reserva", target: 100, saved: 20 }],
    limits: [{ id: id + "limit", amount: 200, categories: ["Outros"], versions: [] }],
    unknown: { preserve: ["", null, false, 0] } };
}
function fixture() {
  const original = folder(), keeper = folder("keeper001", "CASINHA unificada");
  const local = new Map([[original.id, clone(original)]]), owners = new Set([original.id]);
  const remoteRows = new Map([[keeper.id, { id: keeper.id, user_id: USER, data: keeper }]]);
  const archived = [{ id: original.id, keeper_id: keeper.id, data: original }];
  const state = { archived, local, owners, remoteRows, calls: [], removed: [], gate: null, failure: null, invalidResponse: null,
    guardCount: 0, current: true, onGuard: null, failRemoval: false };
  const client = { from(table) {
    const query = { table,
      select(columns) { this.columns = columns; return this; },
      eq(field, value) { this.filter = [field, value]; return this; },
      order(field, options) { this.orderBy = [field, options]; return this; },
      range(start, end) { this.start = start; this.end = end; return this; },
      async execute() {
        state.calls.push({ table: this.table, columns: this.columns, filter: this.filter, start: this.start, end: this.end, orderBy: this.orderBy });
        if (state.gate) { const gate = state.gate; state.gate = null; await gate.promise; }
        if (state.failure) return { data: null, error: state.failure };
        if (state.invalidResponse) return state.invalidResponse;
        return { data: clone(state.archived.slice(this.start, this.end + 1)), error: null };
      },
      then(resolve, reject) { return this.execute().then(resolve, reject); },
    };
    return query;
  } };
  const args = { client, userId: USER, remoteRows,
    assertCurrent() {
      state.guardCount++; state.onGuard?.(state.guardCount);
      if (!state.current) throw Object.assign(new Error("Contexto cancelado"), { name: "AbortError" });
    },
    ownsLocal: (id) => owners.has(id),
    getLocal: (id) => local.get(id) || null,
    removeLocal(id) {
      if (state.failRemoval) throw Object.assign(new Error("QuotaExceededError"), { name: "StorageError" });
      state.removed.push(id); local.delete(id);
    },
  };
  return { ...state, state, args, original, keeper, run: () => CloudArchive.reconcile(args) };
}

test("remove somente cópia equivalente a ambos os originais e consulta arquivo com filtro do dono", async () => {
  const h = fixture(), source = clone(h.original), kept = clone(h.keeper);
  h.local.get("copy001").updatedAt = "2026-10-23T13:00:00Z";
  const result = await h.run();
  assert.deepEqual(result, { removedCount: 1, blockedIds: [], archivedIds: ["copy001"] });
  assert.deepEqual(h.removed, ["copy001"]);
  assert.deepEqual(h.original, source); assert.deepEqual(h.keeper, kept);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0], { table: "pastas_arquivadas", columns: "id,keeper_id,data", filter: ["user_id", USER], start: 0, end: 99, orderBy: ["id", { ascending: true }] });
});

test("IDs já ausentes continuam protegidos para o chamador sem gerar aviso falso de divergência", async () => {
  const h = fixture(); h.local.clear();
  assert.deepEqual(await h.run(), { removedCount: 0, blockedIds: [], archivedIds: ["copy001"] });
  assert.deepEqual(h.removed, []);
});

test("preserva qualquer dado financeiro ou campo extra novo local, inclusive multiplicidade e grupos", async () => {
  const changes = [
    (ds) => { ds.transactions[0].amount += 0.01; },
    (ds) => { ds.transactions.push({ ...clone(ds.transactions[0]), id: "newtx" }); },
    (ds) => { ds.transactions[0].groupId = null; },
    (ds) => { ds.transactions[0].unknown.preserve.push("novo"); },
    (ds) => { ds.unknown.preserve.push("novo"); },
    (ds) => { ds.categories[0].color = "#abcdef"; },
    (ds) => { ds.metas[0].saved = 21; },
    (ds) => { ds.limits[0].amount = 300; },
    (ds) => { ds.name = "Minha pasta renomeada"; },
  ];
  for (const edit of changes) {
    const h = fixture(); edit(h.local.get("copy001")); const before = clone(h.local.get("copy001"));
    assert.deepEqual(await h.run(), { removedCount: 0, blockedIds: ["copy001"], archivedIds: ["copy001"] });
    assert.deepEqual(h.local.get("copy001"), before); assert.deepEqual(h.removed, []);
  }
});

test("local igual ao keeper não basta se o snapshot arquivado contém informação diferente", async () => {
  const h = fixture(); h.archived[0].data.transactions[0].amount = 99;
  const result = await h.run();
  assert.deepEqual(result.blockedIds, ["copy001"]); assert.equal(result.removedCount, 0);
  assert.ok(h.local.has("copy001"));
});

test("keeper ausente, divergente, de outro owner ou com colisão local bloqueia a remoção", async () => {
  for (const cause of ["absent", "divergent", "wrong-owner", "unowned-local", "invalid"]) {
    const h = fixture();
    if (cause === "absent") h.remoteRows.clear();
    if (cause === "divergent") h.keeper.transactions[0].desc = "Outro conteúdo";
    if (cause === "wrong-owner") h.remoteRows.get("keeper001").user_id = "another-owner";
    if (cause === "unowned-local") h.local.set("keeper001", clone(h.keeper));
    if (cause === "invalid") h.keeper.transactions[0].date = "2025-00-20";
    const result = await h.run();
    assert.deepEqual(result.blockedIds, ["copy001"], cause); assert.deepEqual(h.removed, []);
  }
});

test("cópia local sem dono ou pertencente a outra conta fica intacta", async () => {
  const h = fixture(); h.owners.clear();
  assert.deepEqual((await h.run()).blockedIds, ["copy001"]);
  assert.ok(h.local.has("copy001")); assert.equal(h.removed.length, 0);
});

test("troca de contexto durante SELECT interrompe antes de qualquer remoção", async () => {
  const h = fixture(), gate = deferred(); h.state.gate = gate;
  const pending = h.run(); await new Promise(setImmediate); h.state.current = false; gate.resolve();
  await assert.rejects(pending, { name: "AbortError" });
  assert.deepEqual(h.removed, []); assert.ok(h.local.has("copy001"));
});

test("reconfere contexto, owner e snapshot local imediatamente antes do commit", async () => {
  for (const cause of ["context", "owner", "local", "keeper"]) {
    const h = fixture();
    h.state.onGuard = (count) => {
      if (count !== 4) return;
      if (cause === "context") h.state.current = false;
      if (cause === "owner") h.owners.clear();
      if (cause === "local") h.local.get("copy001").transactions[0].amount = 999;
      if (cause === "keeper") h.keeper.transactions.pop();
    };
    if (cause === "context") await assert.rejects(h.run(), { name: "AbortError" });
    else assert.deepEqual((await h.run()).blockedIds, ["copy001"]);
    assert.deepEqual(h.removed, [], cause); assert.ok(h.local.has("copy001"));
  }
});

test("erro de tabela ausente, autenticação ou storage nunca vira sucesso silencioso", async () => {
  for (const code of ["42P01", "PGRST301", "42501"]) {
    const h = fixture(); const failure = { code, message: "Falha sintética" }; h.state.failure = failure;
    await assert.rejects(h.run(), (error) => error === failure);
    assert.deepEqual(h.removed, []); assert.ok(h.local.has("copy001"));
  }
  const h = fixture(); h.state.failRemoval = true;
  await assert.rejects(h.run(), { name: "StorageError" });
  assert.ok(h.local.has("copy001"));
});

test("valida todos os registros antes de remover primeiro; duplicata ou outro owner falha fechado", async () => {
  for (const bad of [null, { id: "copy002", keeper_id: "keeper001", data: { id: "wrong" } },
    { id: "copy002", keeper_id: "copy002", data: { id: "copy002" } },
    { id: "copy002", keeper_id: "keeper001", user_id: "other", data: { id: "copy002" } }]) {
    const h = fixture(); h.archived.push(bad);
    await assert.rejects(h.run(), { name: "ArchiveReconciliationError" }); assert.deepEqual(h.removed, []);
  }
  const h = fixture(); h.archived.push(clone(h.archived[0]));
  await assert.rejects(h.run(), { name: "ArchiveReconciliationError" }); assert.deepEqual(h.removed, []);
});

test("pagina a consulta completa e permite o wrapper de timeout existente", async () => {
  const h = fixture();
  h.archived.length = 0; h.local.clear();
  for (let i = 0; i < 101; i++) h.archived.push({ id: "copy" + i, keeper_id: "keeper001", data: { id: "copy" + i } });
  let wrapped = 0; h.args.request = async (query) => { wrapped++; return await query; };
  const result = await h.run();
  assert.equal(result.archivedIds.length, 101); assert.equal(wrapped, 2);
  assert.deepEqual(h.calls.map((call) => [call.start, call.end]), [[0, 99], [100, 199]]);
  assert.deepEqual(result.blockedIds, []); assert.equal(result.removedCount, 0);
});

test("falha na segunda página ainda não remove nenhuma pasta local", async () => {
  const h = fixture();
  for (let i = 1; i < 100; i++) h.archived.push({ id: "copy" + i, keeper_id: "keeper001", data: { id: "copy" + i } });
  h.state.onGuard = (count) => { if (count === 2) h.state.failure = { message: "Falhou página 2" }; };
  await assert.rejects(h.run(), (error) => error.message === "Falhou página 2");
  assert.deepEqual(h.removed, []); assert.ok(h.local.has("copy001"));
});

test("callback precisa efetivamente remover a pasta e não pode ser async", async () => {
  const h = fixture(); h.args.removeLocal = () => {};
  await assert.rejects(h.run(), /Não foi possível remover/); assert.ok(h.local.has("copy001"));
  const asyncFixture = fixture(); asyncFixture.args.removeLocal = async () => {};
  await assert.rejects(asyncFixture.run(), /precisa ser síncrona/); assert.equal(asyncFixture.calls.length, 0);
});

test("módulo funciona como scripts do navegador sem require e preserva campos desconhecidos", async () => {
  const h = fixture(); const input = JSON.stringify({ archive: h.archived[0], keeper: h.remoteRows.get("keeper001"), local: h.local.get("copy001") });
  const context = vm.createContext({ input, userId: USER });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js/folder-cleanup.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js/cloud-archive.js"), "utf8"), context);
  vm.runInContext(`const value=JSON.parse(input); let local=value.local;
    const query={select(){return this},eq(){return this},order(){return this},range(){return this},then(resolve){return Promise.resolve({data:[value.archive]}).then(resolve)}};
    this.result=CloudArchive.reconcile({client:{from:()=>query},userId,remoteRows:new Map([[value.keeper.id,value.keeper]]),assertCurrent(){},ownsLocal:()=>true,getLocal:id=>id===local?.id?local:null,removeLocal(){local=null}});`, context);
  assert.deepEqual(clone(await context.result), { removedCount: 1, blockedIds: [], archivedIds: ["copy001"] });
});
