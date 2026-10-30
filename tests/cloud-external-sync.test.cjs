"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const fixture = fs.readFileSync(path.join(__dirname, "cloud-recovery.test.cjs"), "utf8").split(/\r?\ntest\(/)[0];
const { harness, seeded, copy, tx, deferred, settle, storedQueue } = new Function("require", "__dirname", fixture + "\nreturn { harness, seeded, copy, tx, deferred, settle, storedQueue };")(require, __dirname);

function appendExternal(h, number = 1) {
  const row = h.remote();
  row.data.transactions.push({ ...tx("Inclusão externa " + number, number + 100), id: "wa_" + String(number).padStart(32, "0") });
  row.data.whatsappRevision = (row.data.whatsappRevision || 0) + 1;
  row.updated_at = row.data.updatedAt = new Date(Date.parse(row.updated_at) + 1000).toISOString();
}
function rewriteQueue(h, transform) {
  const [key, value] = [...h.values].find(([key]) => key.startsWith("fyg:cloud-queue:v1:"));
  const q = JSON.parse(value); transform(q); h.values.set(key, JSON.stringify(q));
}

test("inclusão local e WhatsApp concorrentes convergem sem cópia e mantêm snapshot durável confirmado", async () => {
  const h = await seeded(); const before = copy(storedQueue(h).base.folder0001.snapshot);
  h.add("Local"); appendExternal(h);
  assert.equal(await h.sync(), true);
  assert.equal(h.Store.loadIndex().length, 1); assert.equal(h.server.rows.size, 1);
  assert.deepEqual(h.remote().data.transactions.map((t) => t.desc), ["Base", "Local", "Inclusão externa 1"]);
  assert.equal(h.local().whatsappRevision, 1); assert.equal(h.cloud.getSyncState().pendingCount, 0);
  const base = storedQueue(h).base.folder0001;
  assert.deepEqual(base.snapshot, h.remote().data); assert.equal(base.version, h.remote().updated_at);
  assert.equal(before.transactions.length, 1);
  const reload = harness({ values: h.values, server: h.server }); reload.login("user-a", "INITIAL_SESSION");
  reload.add("Local após recarregar"); appendExternal(reload, 2);
  assert.equal(await reload.sync(), true); assert.equal(reload.remote().data.transactions.length, 5);
  assert.equal(reload.Store.loadIndex().length, 1); assert.equal(reload.local().whatsappRevision, 2);
});

test("remoção local, edição local e inclusão externa são preservadas em IDs distintos", async () => {
  const h = await seeded(); h.add("A remover"); await h.sync();
  const local = h.local(); local.transactions.pop(); local.transactions[0].amount = 0.123456; local.transactions[0].currency = "USDC";
  local.initialBalance = 1234.56; h.Store.saveDataset(local); appendExternal(h);
  assert.equal(await h.sync(), true);
  assert.equal(h.remote().data.transactions.length, 2); assert.equal(h.remote().data.transactions[0].amount, 0.123456);
  assert.equal(h.remote().data.initialBalance, 1234.56); assert.equal(h.remote().data.transactions.some((t) => t.desc === "A remover"), false);
});

test("remoção remota confirmada não é ressuscitada por inclusão local", async () => {
  const h = await seeded(); h.add("Base removível"); await h.sync(); h.add("Nova local");
  h.remote().data.transactions = h.remote().data.transactions.filter((t) => t.desc !== "Base removível"); appendExternal(h);
  assert.equal(await h.sync(), true);
  assert.deepEqual(h.remote().data.transactions.map((t) => t.desc), ["Base", "Nova local", "Inclusão externa 1"]);
  assert.equal(h.Store.loadIndex().length, 1);
});

test("conflito real mantém base comum e revisão antiga, não sobrescreve remoto e não bloqueia outras pastas", async () => {
  const h = await seeded(); const oldBase = storedQueue(h).base.folder0001;
  const local = h.local(); local.transactions[0].amount = 15; h.Store.saveDataset(local);
  h.remote().data.transactions[0].amount = 22; appendExternal(h); const remote = copy(h.remote()); h.create("other001");
  assert.equal(await h.sync(), false); assert.deepEqual(h.remote(), remote); assert.equal(h.local().transactions[0].amount, 15);
  assert.equal(h.local().whatsappRevision, undefined); assert.deepEqual(storedQueue(h).base.folder0001, oldBase);
  assert.ok(h.remote("other001")); assert.equal(h.cloud.getSyncState().mergeConflictCount, 1);
  assert.equal(h.cloud.getSyncState().pendingUploads, 1); const count = h.Store.loadIndex().length;
  const reload = harness({ values: h.values, server: h.server }); reload.login("user-a", "INITIAL_SESSION");
  assert.equal(await reload.sync(), false); assert.equal(reload.Store.loadIndex().length, count); assert.deepEqual(reload.remote(), remote);
  assert.ok(!h.server.calls.some((call) => call.operation === "update" && call.filters.some(([field, value]) => field === "id" && value === "folder0001")));
});

test("base antiga sem snapshot só aceita inclusões WA quando a reconstrução confere exatamente com digest", async () => {
  for (const changed of [false, true]) {
    const h = await seeded(); rewriteQueue(h, (q) => { delete q.base.folder0001.snapshot; });
    const reload = harness({ values: h.values, server: h.server }); reload.login("user-a", "INITIAL_SESSION");
    reload.add("Nova local"); appendExternal(reload);
    if (changed) reload.remote().data.transactions[0].amount = 99;
    const remoteBefore = copy(reload.remote());
    assert.equal(await reload.sync(), !changed);
    if (changed) { assert.deepEqual(reload.remote(), remoteBefore); assert.equal(reload.cloud.getSyncState().pendingUploads, 1); }
    else { assert.equal(reload.Store.loadIndex().length, 1); assert.equal(reload.remote().data.transactions.length, 3); }
  }
});

test("snapshot persistido adulterado nunca é usado como base para apagar uma transação remota", async () => {
  const h = await seeded(); rewriteQueue(h, (q) => { q.base.folder0001.snapshot.transactions[0].amount = 999; });
  const reload = harness({ values: h.values, server: h.server }); reload.login("user-a", "INITIAL_SESSION"); reload.add("Nova local");
  reload.remote().data.transactions[0].amount = 25; appendExternal(reload); const remoteBefore = copy(reload.remote());
  assert.equal(await reload.sync(), false); assert.deepEqual(reload.remote(), remoteBefore);
  assert.equal(reload.cloud.getSyncState().mergeConflictCount, 1);
});

test("CAS concorrente conserva a inclusão que chegou após o SELECT e a une no próximo ciclo", async () => {
  const h = await seeded(); h.add("Local"); appendExternal(h);
  h.server.beforeWrite = () => appendExternal(h, 2);
  assert.equal(await h.sync(), false); assert.equal(h.cloud.getSyncState().pendingUploads, 1);
  assert.equal(await h.sync(), true); assert.equal(h.remote().data.transactions.length, 4);
  assert.equal(h.remote().data.whatsappRevision, 2); assert.equal(h.Store.loadIndex().length, 1);
});

test("troca de conta durante hash do merge não salva conteúdo da conta anterior", async () => {
  const h = harness(); let gate = null;
  h.context.TextEncoder = TextEncoder;
  h.context.crypto = { subtle: { async digest(algorithm, bytes) {
    if (gate) { const held = gate; gate = null; await held.promise; }
    return Uint8Array.from(require("node:crypto").createHash("sha256").update(Buffer.from(bytes)).digest()).buffer;
  } } };
  h.login(); h.create(); await h.sync(); h.add("Local"); appendExternal(h);
  const held = deferred(); gate = held;
  const pending = h.cloud.syncNow(); await settle(); h.login("user-b"); held.resolve();
  assert.equal(await pending, false); assert.equal(h.local().transactions.length, 2);
  assert.equal(h.remote("folder0001", "user-a").data.transactions.length, 2);
  assert.equal(h.server.calls.some((call) => call.user === "user-b" && call.operation !== "select"), false);
});

test("save de outra aba durante conferência do snapshot é reavaliado antes da fusão", async () => {
  const h = harness(); let gate = null;
  h.context.TextEncoder = TextEncoder;
  h.context.crypto = { subtle: { async digest(algorithm, bytes) {
    if (gate) { const held = gate; gate = null; await held.promise; }
    return Uint8Array.from(require("node:crypto").createHash("sha256").update(Buffer.from(bytes)).digest()).buffer;
  } } };
  h.login(); h.create(); await h.sync(); h.add("Primeira local"); appendExternal(h);
  const other = harness({ values: h.values, server: h.server }); other.login("user-a", "INITIAL_SESSION");
  const held = deferred(); gate = held; const pending = h.cloud.syncNow(); await settle();
  other.add("Outra aba"); held.resolve(); assert.equal(await pending, true);
  assert.equal(h.remote().data.transactions.length, 4); assert.equal(h.Store.loadIndex().length, 1);
});

test("fila limpa recebe atualização externa em 30 s e recomeça ao foco sem rede quando oculto/offline/desligado", async () => {
  const h = await seeded({ auto: true }); appendExternal(h);
  await h.tick(30000); assert.equal(h.local().transactions.length, 2); assert.equal(h.cloud.getSyncState().pendingCount, 0);
  assert.deepEqual([...h.timers.values()].map((timer) => timer.delay), [30000]);
  const calls = h.server.calls.length;
  h.context.document.visibilityState = "hidden"; h.context.document.fire("visibilitychange");
  assert.equal(h.timers.size, 0); h.context.window.fire("focus"); assert.equal(h.timers.size, 0);
  appendExternal(h, 2); h.context.document.visibilityState = "visible"; h.context.document.fire("visibilitychange");
  await h.tick(0); assert.equal(h.local().transactions.length, 3); assert.equal(h.server.calls.length, calls + 1);
  h.context.navigator.onLine = false; h.context.window.fire("offline"); assert.equal(h.timers.size, 0);
  h.context.window.fire("focus"); assert.equal(h.timers.size, 0);
  h.context.navigator.onLine = true; h.context.window.fire("online"); await h.tick(0);
  h.auto(false); assert.equal(h.timers.size, 0); h.context.window.fire("focus"); assert.equal(h.timers.size, 0);
  h.auto(true); await h.tick(0); await h.cloud.logout(); assert.equal(h.timers.size, 0);
});

test("falha de persistência do snapshot não produz envio nem status sincronizado falso", async () => {
  const h = await seeded(); h.add("Local"); appendExternal(h); const remote = copy(h.remote());
  h.storage.fail = (key) => key.startsWith("fyg:cloud-queue:");
  assert.equal(await h.sync(), false); assert.deepEqual(h.remote(), remote); assert.equal(h.local().transactions.length, 2);
  assert.equal(h.cloud.getSyncState().queueDurable, false); assert.equal(h.cloud.getSyncState().status, "error");
  h.storage.fail = null; assert.equal(await h.sync(), true); assert.equal(h.local().transactions.length, 3);
});

test("fresh aguarda SELECT antigo e lê a confirmação externa seguinte sem esperar o poll", async () => {
  const h = await seeded(); const gate = deferred(); h.server.holdSelect = gate;
  const oldSync = h.cloud.syncNow(); await settle();
  appendExternal(h); const fresh = h.cloud.syncNow({ fresh: true });
  gate.resolve(); assert.equal(await oldSync, true); assert.equal(await fresh, true);
  assert.equal(h.local().transactions.length, 2); assert.equal(h.local().whatsappRevision, 1);
  assert.equal(h.cloud.getSyncState().pendingCount, 0);
});

test("fresh enfileirado não lê nem escreve sob outra conta após logout ou troca de sessão", async () => {
  for (const switchAccount of [false, true]) {
    const h = await seeded(); const gate = deferred(); h.server.holdSelect = gate;
    const oldSync = h.cloud.syncNow(); await settle();
    appendExternal(h); const fresh = h.cloud.syncNow({ fresh: true });
    if (switchAccount) h.login("user-b"); else await h.cloud.logout();
    gate.resolve(); await oldSync; assert.equal(await fresh, false);
    assert.equal(h.local().transactions.length, 1);
    assert.equal(h.server.calls.some((call) => call.user === "user-b"), false);
  }
});
