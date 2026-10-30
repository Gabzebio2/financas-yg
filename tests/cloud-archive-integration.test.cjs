"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Reutiliza a simulação de rede/Store da recuperação, sem registrar seus testes.
// Somente o backend falso ganha a tabela administrativa e sua paginação.
let fixture = fs.readFileSync(path.join(__dirname, "cloud-recovery.test.cjs"), "utf8").split(/\r?\ntest\(/)[0];
function replaceFixture(before, after) {
  assert.ok(fixture.includes(before), "fixture de recuperação mudou: " + before);
  fixture = fixture.replace(before, after);
}
replaceFixture("constructor(user) { this.user = user;", "constructor(user, table) { this.table = table; this.user = user;");
replaceFixture("select() { return this; }", "select() { return this; }\n    order() { return this; }\n    range(start, end) { this.start = start; this.end = end; return this; }");
replaceFixture("const call = { user: this.user,", "const call = { table: this.table, user: this.user,");
replaceFixture("if (this.operation === \"select\") {", `if (this.operation === "select" && this.table === "pastas_arquivadas") {
        assert.ok(this.filters.some(([key, value]) => key === "user_id" && value === this.user));
        const data = [...(server.archives || new Map()).values()].filter((row) => row.user_id === this.user && this.filters.every(([field, value]) => row[field] === value)).sort((a, b) => a.id.localeCompare(b.id)).slice(this.start, this.end + 1).map(copy);
        if (server.holdArchive) { const gate = server.holdArchive; server.holdArchive = null; await gate.promise; }
        if (server.archiveError) return { error: server.archiveError };
        return { data };
      }
      assert.equal(this.table, "pastas", "arquivo permanente nunca recebe gravação do aplicativo");
      if (this.operation === "select") {`);
replaceFixture("from() { return new Query(currentUser); }", "from(table) { return new Query(currentUser, table); }");
replaceFixture("vm.runInContext(repairSource, context);", `vm.runInContext(repairSource, context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js/folder-cleanup.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js/cloud-archive.js"), "utf8"), context);`);
const { harness, dataset, copy, deferred, settle, storedQueue } = new Function("require", "__dirname", fixture + "\nreturn { harness, dataset, copy, deferred, settle, storedQueue };")(require, __dirname);

async function archivedFixture({ auto = false } = {}) {
  const h = harness({ auto }); h.server.archives = new Map(); h.login();
  const ids = ["oldcopy01", "oldcopy02", "oldcopy03", "oldcopy04"];
  for (const id of [...ids, "keeper001"]) {
    const ds = dataset(id); ds.name = id === "keeper001" ? "CASINHA unificada" : "CASINHA";
    h.Store.saveDataset(ds);
  }
  assert.equal(await h.sync(), true);
  for (const id of ids) {
    const row = h.remote(id);
    h.server.archives.set("user-a|" + id, { user_id: "user-a", id, keeper_id: "keeper001", data: copy(row.data) });
    h.server.rows.delete("user-a|" + id);
  }
  h.server.calls.length = 0;
  return { h, ids };
}

test("Store real remove quatro cópias arquivadas e esvazia dirty/tombstones sem recriar remoto", async () => {
  const { h, ids } = await archivedFixture();
  // Simula metadados locais pendentes, embora o conteúdo já esteja preservado.
  for (const id of ids) h.Store.saveDataset(h.local(id));
  assert.equal(h.cloud.getSyncState().pendingUploads, 4);
  assert.equal(await h.sync(), true);
  assert.equal(h.Store.loadIndex().length, 1);
  for (const id of ids) { assert.equal(h.local(id), null); assert.equal(h.remote(id), undefined); }
  assert.equal(h.local("keeper001").name, "CASINHA unificada");
  assert.equal(h.cloud.getSyncState().pendingCount, 0);
  assert.equal(h.cloud.getSyncState().status, "synced");
  assert.deepEqual(storedQueue(h).dirty, {}); assert.deepEqual(storedQueue(h).deletes, {});
  assert.equal(h.server.calls.some((call) => call.operation !== "select"), false);
  assert.equal(h.server.archives.size, 4);
  const restored = harness({ values: h.values, server: h.server }); restored.login("user-a", "INITIAL_SESSION");
  assert.equal(await restored.sync(), true); assert.equal(restored.Store.loadIndex().length, 1);
  assert.equal(restored.cloud.getSyncState().pendingCount, 0);
});

test("alteração local em ID arquivado é preservada e bloqueada, mas pasta nova continua enviando", async () => {
  const { h, ids } = await archivedFixture({ auto: true });
  h.add("Alteração inédita", ids[0]); h.create("fresh0001");
  const changed = copy(h.local(ids[0]));
  assert.equal(await h.sync(), false);
  assert.deepEqual(copy(h.local(ids[0])), changed);
  for (const id of ids.slice(1)) assert.equal(h.local(id), null);
  assert.equal(h.remote(ids[0]), undefined, "cópia arquivada não é reenviada");
  assert.ok(h.remote("fresh0001"), "pasta independente continua enviando");
  assert.equal(h.cloud.getSyncState().pendingUploads, 1);
  assert.equal(h.cloud.getSyncState().status, "error");
  assert.match(h.cloud.getSyncState().error, /cópias antigas com alterações/);
  assert.equal(h.server.calls.filter((call) => call.operation === "insert").length, 1);
  assert.ok([...h.timers.values()].some((timer) => timer.delay === 5000));
  await h.tick(5000);
  assert.ok([...h.timers.values()].some((timer) => timer.delay === 15000));
  assert.equal(h.remote(ids[0]), undefined);
});

test("edição durante leitura do arquivo continua local, sem exclusão nem upload do ID arquivado", async () => {
  const { h, ids } = await archivedFixture();
  const gate = deferred(); h.server.holdArchive = gate;
  const pending = h.sync(); await settle(); h.add("Compra durante conferência", ids[0]);
  const changed = copy(h.local(ids[0])); gate.resolve();
  assert.equal(await pending, false); assert.deepEqual(copy(h.local(ids[0])), changed);
  assert.equal(h.remote(ids[0]), undefined); assert.equal(h.cloud.getSyncState().pendingCount, 1);
  for (const id of ids.slice(1)) assert.equal(h.local(id), null);
});

test("troca de conta durante leitura administrativa cancela remoções da conta anterior", async () => {
  const { h, ids } = await archivedFixture();
  const gate = deferred(); h.server.holdArchive = gate;
  const pending = h.sync(); await settle(); h.login("user-b"); gate.resolve();
  assert.equal(await pending, false);
  for (const id of ids) assert.ok(h.local(id));
  assert.equal(h.cloud.getToken(), "fake-user-b");
  assert.equal(h.server.calls.some((call) => call.operation !== "select"), false);
});

test("falha na consulta de arquivos preserva conteúdo e fila sem publicar cópia antiga", async () => {
  const { h, ids } = await archivedFixture();
  h.Store.saveDataset(h.local(ids[0]));
  h.server.archiveError = { message: "Archive unavailable", status: 503 };
  assert.equal(await h.sync(), false);
  for (const id of ids) assert.ok(h.local(id));
  assert.equal(h.cloud.getSyncState().pendingCount, 1);
  assert.equal(h.server.calls.some((call) => call.operation !== "select"), false);
});
