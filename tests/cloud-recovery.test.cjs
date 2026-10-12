"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const coreSource = fs.readFileSync(path.join(__dirname, "../js/app.js"), "utf8");
const cloudSource = fs.readFileSync(path.join(__dirname, "../js/cloud.js"), "utf8").replace(
  "return { onLocalChange, onLocalDelete, getToken, getSyncState, linkLocalDatasets, prepareLocalDelete };",
  "return { onLocalChange, onLocalDelete, getToken, getSyncState, linkLocalDatasets, prepareLocalDelete, ensureClient, syncNow, logout };"
);
const copy = (value) => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate); };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

function eventTarget() {
  const handlers = new Map();
  return {
    addEventListener(type, handler) { if (!handlers.has(type)) handlers.set(type, []); handlers.get(type).push(handler); },
    fire(type, event = {}) { (handlers.get(type) || []).forEach((handler) => handler(event)); },
    handlers,
  };
}

function makeServer() {
  return { rows: new Map(), calls: [], paused: false, failWrites: 0, holdSelect: null, holdWrite: null, beforeWrite: null };
}

function harness({ values = new Map(), server = makeServer(), auto = false } = {}) {
  if (!values.has("fyg:cloud-autosync")) values.set("fyg:cloud-autosync", auto ? "1" : "0");
  let now = Date.parse("2026-10-10T12:00:00.000Z"), timerId = 0, currentUser = null, authListener;
  const timers = new Map(), nodes = new Map(), events = [];
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const storage = {
    fail: null,
    get length() { return values.size; }, key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) { if (storage.fail?.(key, value)) throw new Error("QuotaExceededError"); values.set(key, String(value)); },
    removeItem: (key) => values.delete(key),
  };
  const window = Object.assign(eventTarget(), { top: null, self: null });
  const document = Object.assign(eventTarget(), {
    visibilityState: "visible",
    dispatchEvent(event) { events.push(copy(event)); return true; },
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, Object.assign(eventTarget(), {
        value: "", textContent: "", innerHTML: "", checked: false,
        classList: { add() {}, remove() {}, toggle() {} }, focus() {},
      }));
      return nodes.get(selector);
    },
    querySelectorAll: () => [],
  });
  class Query {
    constructor(user) { this.user = user; this.operation = "select"; this.filters = []; }
    select() { return this; }
    insert(payload) { this.operation = "insert"; this.payload = copy(payload); return this; }
    update(payload) { this.operation = "update"; this.payload = copy(payload); return this; }
    delete() { this.operation = "delete"; return this; }
    eq(key, value) { this.filters.push([key, value]); return this; }
    is(key, value) { return this.eq(key, value); }
    abortSignal(signal) { this.signal = signal; return this; }
    then(resolve, reject) { return this.execute().then(resolve, reject); }
    async execute() {
      const call = { user: this.user, operation: this.operation, filters: copy(this.filters), payload: this.payload && copy(this.payload) };
      server.calls.push(call);
      if (server.paused) return { error: { message: "Project is paused", status: 503 } };
      if (this.operation === "select") {
        const data = [...server.rows.values()].filter((row) => row.user_id === this.user).map(copy);
        if (server.holdSelect) { const gate = server.holdSelect; server.holdSelect = null; await gate.promise; }
        return { data };
      }
      if (server.failWrites) { server.failWrites--; return { error: { message: "Network unavailable", status: 503 } }; }
      if (server.beforeWrite) { const fn = server.beforeWrite; server.beforeWrite = null; fn(call); }
      if (this.signal?.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });
      let affected = [];
      if (this.operation === "insert") {
        assert.equal(this.payload.user_id, this.user, "uma fila não pode enviar dados usando outro proprietário");
        const key = this.user + "|" + this.payload.id;
        if (server.rows.has(key)) return { error: { message: "Duplicate key", status: 409 } };
        server.rows.set(key, copy(this.payload));
        affected = [{ id: this.payload.id }];
      } else {
        for (const [key, row] of server.rows) {
          if (row.user_id !== this.user || !this.filters.every(([field, value]) => row[field] === value)) continue;
          affected.push({ id: row.id });
          if (this.operation === "delete") server.rows.delete(key);
          else server.rows.set(key, { ...row, ...copy(this.payload) });
        }
      }
      if (server.holdWrite) { const gate = server.holdWrite; server.holdWrite = null; await gate.promise; }
      return { data: affected };
    }
  }
  const client = {
    auth: {
      onAuthStateChange(fn) { authListener = fn; return { data: { subscription: { unsubscribe() {} } } }; },
      async getSession() { return { data: { session: currentUser ? session(currentUser) : null } }; },
      async signOut() { currentUser = null; authListener?.("SIGNED_OUT", null); return {}; },
    },
    from() { return new Query(currentUser); },
  };
  const session = (id) => ({ user: { id, email: id + "@example.invalid" }, access_token: "fake-" + id });
  const context = vm.createContext({
    Date: ClockDate, Math, console: { error() {}, warn() {}, log() {} }, localStorage: storage,
    AbortController, AbortSignal, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    navigator: { onLine: true }, window, document, location: { origin: "https://example.invalid", pathname: "/" },
    setTimeout(fn, delay = 0) { timers.set(++timerId, { fn, delay, at: now + delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    supabase: { createClient: () => client },
    Dashboard: { refreshFromStore() {} },
  });
  vm.runInContext(coreSource + "\nthis.core = { Store }; renderFolders = () => {}; toast = () => {};", context);
  vm.runInContext(cloudSource + "\nthis.subject = Cloud;", context);
  const { Store } = context.core, cloud = context.subject;
  return { values, server, storage, timers, nodes, events, context, Store, cloud,
    login(id = "user-a", event = "SIGNED_IN") { cloud.ensureClient(); currentUser = id; authListener(event, session(id)); },
    refreshAuth(id = "user-a") { authListener("TOKEN_REFRESHED", session(id)); },
    async sync() { const result = await cloud.syncNow(); await settle(); return result; },
    async tick(delay) {
      const entry = [...timers].filter(([, timer]) => delay == null || timer.delay === delay).sort((a, b) => a[1].at - b[1].at)[0];
      assert.ok(entry, "esperava uma retentativa agendada");
      timers.delete(entry[0]); now = entry[1].at; entry[1].fn(); await settle();
    },
    auto(enabled) { storage.setItem("fyg:cloud-autosync", enabled ? "1" : "0"); window.fire("storage", { key: "fyg:cloud-autosync" }); },
    local(id = "folder0001") { return Store._rawDataset(id); },
    remote(id = "folder0001", user = currentUser) { return server.rows.get(user + "|" + id); },
    add(desc, id = "folder0001") { const ds = Store._rawDataset(id); ds.transactions.push(tx(desc, ds.transactions.length + 1)); Store.saveDataset(ds); },
    create(id = "folder0001") { const ds = dataset(id); Store.saveDataset(ds); return ds; },
  };
}

function tx(desc, number) {
  return { id: "transaction" + number, groupId: null, fixed: false, date: "2026-10-10", desc, amount: number * 10, type: "despesa", currency: "BRL", category: "Outros", account: "C6", installment: null, totalValue: null };
}
function dataset(id = "folder0001") {
  return { id, name: "Pessoal", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", displayCurrency: "BRL", profile: "pf", categories: [{ name: "Outros", color: "#445566" }], transactions: [tx("Base", 1)], limits: [], metas: [] };
}
async function seeded(options) { const h = harness(options); h.login(); h.create(); assert.equal(await h.sync(), true); return h; }
function changeRemote(h, desc = "Outro aparelho") {
  const row = h.remote(); row.data.transactions.push(tx(desc, 20));
  row.updated_at = row.data.updatedAt = "2027-01-01T00:00:00.000Z";
}
function putInvalidRemote(h, id = "invalid001", user = "user-a") {
  const ds = dataset(id);
  ds.transactions[0].date = "2025-00-20";
  const row = { user_id: user, id, data: ds, updated_at: ds.updatedAt };
  h.server.rows.set(user + "|" + id, copy(row));
  return row;
}
function storedQueue(h) {
  return JSON.parse([...h.values].find(([key]) => key.startsWith("fyg:cloud-queue:v1:"))[1]);
}

test("pausa mantém lançamentos e fila duráveis; recarregar e reativar envia uma só vez", async () => {
  const h = await seeded({ auto: true });
  h.server.paused = true; h.add("Compra durante pausa");
  assert.equal(await h.sync(), false);
  assert.equal(h.cloud.getSyncState().pendingUploads, 1);
  assert.equal(h.local().transactions.length, 2);
  assert.ok([...h.timers.values()].some((timer) => timer.delay === 5000));
  const restored = harness({ values: h.values, server: h.server, auto: true });
  restored.login("user-a", "INITIAL_SESSION");
  assert.equal(restored.cloud.getSyncState().pendingUploads, 1);
  restored.server.paused = false;
  await restored.tick(0);
  assert.equal(restored.remote().data.transactions.length, 2);
  assert.equal(restored.cloud.getSyncState().pendingCount, 0);
  assert.equal(restored.cloud.getSyncState().status, "synced");
  assert.equal(restored.timers.size, 0, "não há ping periódico depois de esvaziar a fila");
});

test("backoff cresce apenas enquanto há pendências e retoma ao ficar online", async () => {
  const h = await seeded({ auto: true });
  h.server.paused = true; h.add("Pendente");
  await h.sync(); await h.tick(5000);
  assert.ok([...h.timers.values()].some((timer) => timer.delay === 15000));
  h.context.navigator.onLine = false; h.context.window.fire("offline");
  assert.equal(h.timers.size, 0);
  assert.equal(h.cloud.getSyncState().status, "offline");
  h.server.paused = false; h.context.navigator.onLine = true; h.context.window.fire("online");
  await h.tick(0);
  assert.equal(h.cloud.getSyncState().pendingCount, 0);
});

test("conflito com remoto mais novo preserva ambas as versões em pastas separadas sem repetir cópia no retry", async () => {
  const h = await seeded(); h.add("Minha compra"); changeRemote(h);
  h.server.failWrites = 1;
  assert.equal(await h.sync(), false);
  let copies = h.Store.loadIndex().filter((ds) => ds.id !== "folder0001");
  assert.equal(copies.length, 1);
  assert.deepEqual(Array.from(h.local().transactions, (t) => t.desc), ["Base", "Minha compra"]);
  assert.deepEqual(Array.from(h.local(copies[0].id).transactions, (t) => t.desc), ["Base", "Outro aparelho"]);
  assert.equal(await h.sync(), true);
  copies = h.Store.loadIndex().filter((ds) => ds.id !== "folder0001");
  assert.equal(copies.length, 1);
  assert.equal(h.server.rows.size, 2);
  assert.deepEqual(h.remote().data.transactions.map((t) => t.desc), ["Base", "Minha compra"]);
});

test("edição durante upload não perde sua revisão quando a resposta antiga chega", async () => {
  const h = await seeded(); h.add("Primeira");
  const gate = deferred(); h.server.holdWrite = gate;
  const pending = h.cloud.syncNow(); await settle();
  h.add("Segunda"); gate.resolve(); await pending;
  assert.equal(h.cloud.getSyncState().pendingUploads, 1);
  assert.equal(h.remote().data.transactions.length, 2);
  await h.sync();
  assert.equal(h.remote().data.transactions.length, 3);
  assert.equal(h.cloud.getSyncState().pendingUploads, 0);
});

test("CAS impede sobrescrever edição remota ocorrida depois do pull", async () => {
  const h = await seeded(); h.add("Minha compra");
  h.server.beforeWrite = () => changeRemote(h, "Mudou durante envio");
  assert.equal(await h.sync(), false);
  assert.equal(h.cloud.getSyncState().pendingUploads, 1);
  assert.equal(h.remote().data.transactions[1].desc, "Mudou durante envio");
  await h.sync();
  assert.equal(h.Store.loadIndex().length, 2);
  assert.equal(h.remote().data.transactions[1].desc, "Minha compra");
});

test("CAS avança updated_at mesmo com relógio congelado entre alterações", async () => {
  const h = await seeded(); const before = h.remote().updated_at;
  h.add("No mesmo milissegundo"); await h.sync();
  assert.ok(Date.parse(h.remote().updated_at) > Date.parse(before));
  const write = h.server.calls.findLast((call) => call.operation === "update");
  assert.ok(write.filters.some(([key, value]) => key === "updated_at" && value === before));
  assert.ok(write.filters.some(([key, value]) => key === "user_id" && value === "user-a"));
});

test("exclusão durante pull fica registrada atomicamente e a pasta não renasce", async () => {
  const h = await seeded(); const gate = deferred(); h.server.holdSelect = gate;
  const pending = h.cloud.syncNow(); await settle();
  h.Store.deleteDataset("folder0001");
  assert.equal(h.local(), null);
  assert.equal(h.cloud.getSyncState().pendingDeletes, 1);
  gate.resolve(); await pending;
  assert.equal(h.local(), null);
  assert.equal(h.remote(), undefined);
  assert.equal(h.cloud.getSyncState().pendingDeletes, 0);
});

test("exclusão com edição remota preserva a versão remota antes de excluir o original", async () => {
  const h = await seeded(); changeRemote(h);
  h.Store.deleteDataset("folder0001"); await h.sync();
  assert.equal(h.remote(), undefined);
  const copies = h.Store.loadIndex(); assert.equal(copies.length, 1);
  assert.equal(h.remote(copies[0].id).data.transactions[1].desc, "Outro aparelho");
  const operations = h.server.calls.slice(-3).map((call) => call.operation);
  assert.deepEqual(operations, ["select", "insert", "delete"]);
});

test("logout cancela timers e respostas tardias sem apagar pendências", async () => {
  const h = await seeded({ auto: true }); h.add("Local");
  assert.ok(h.timers.size);
  const gate = deferred(); h.server.holdSelect = gate;
  const pending = h.cloud.syncNow(); await settle();
  await h.cloud.logout();
  assert.equal(h.timers.size, 0);
  gate.resolve(); await pending;
  assert.equal(h.cloud.getToken(), null);
  assert.equal(h.local().transactions.length, 2);
  assert.equal(h.cloud.getSyncState().pendingCount, 1);
  assert.notEqual(h.events.filter((event) => event.type === "fyg:cloudstate").at(-1).detail.status, "syncing");
});

test("pendências da conta A e alterações após logout nunca são enviadas à conta B", async () => {
  const h = await seeded(); await h.cloud.logout(); h.add("Ainda pertence a A");
  h.login("user-b"); h.create("folder0002");
  assert.equal(h.cloud.linkLocalDatasets(["folder0001"]), 0);
  await h.sync();
  assert.equal(h.remote("folder0001", "user-b"), undefined);
  assert.ok(h.remote("folder0002", "user-b"));
  assert.equal(h.cloud.getSyncState().otherAccountPending, 1);
  h.login("user-a"); await h.sync();
  assert.equal(h.remote("folder0001", "user-a").data.transactions.length, 2);
});

test("login novo exige vínculo explícito, enquanto sessão legada preexistente migra com segurança", async () => {
  const h = harness(); h.create(); h.login("user-b");
  assert.equal(h.cloud.getSyncState().unlinkedCount, 1);
  await h.sync(); assert.equal(h.server.rows.size, 0);
  assert.equal(h.cloud.linkLocalDatasets(), 1); await h.sync(); assert.equal(h.server.rows.size, 1);
  const legacy = harness(); legacy.create(); legacy.login("user-a", "INITIAL_SESSION");
  assert.equal(legacy.cloud.getSyncState().unlinkedCount, 0);
  await legacy.sync(); assert.equal(legacy.server.rows.size, 1);
});

test("autosync desligado continua registrando fila e interrompe uma tentativa automática ativa", async () => {
  const h = await seeded(); h.add("Manual");
  assert.equal(h.timers.size, 0); assert.equal(h.cloud.getSyncState().pendingCount, 1);
  assert.equal(await h.cloud.syncNow({ automatic: true }), false);
  h.auto(true); const gate = deferred(); h.server.holdSelect = gate;
  const pending = h.cloud.syncNow({ automatic: true }); await settle();
  h.auto(false); gate.resolve(); await pending;
  assert.equal(h.remote().data.transactions.length, 1);
  assert.equal(h.cloud.getSyncState().pendingCount, 1);
  assert.equal(h.timers.size, 0);
  await h.sync(); assert.equal(h.remote().data.transactions.length, 2);
});

test("falha ao persistir metadata não impede save local nem permite anúncio falso de sincronizado", async () => {
  const h = await seeded(); h.storage.fail = (key) => key.startsWith("fyg:cloud-");
  h.add("Compra salva localmente");
  assert.equal(h.local().transactions.length, 2);
  assert.equal(h.cloud.getSyncState().queueDurable, false);
  const calls = h.server.calls.length; assert.equal(await h.sync(), false);
  assert.equal(h.server.calls.length, calls);
  h.storage.fail = null; await h.sync();
  assert.equal(h.cloud.getSyncState().queueDurable, true);
  assert.equal(h.remote().data.transactions.length, 2);
});

test("rescan recupera save ocorrido antes de a notificação dirty ser persistida", async () => {
  const h = await seeded(); const ds = h.local(); ds.transactions.push(tx("Save antes de crash", 2));
  h.Store.saveDataset(ds, { origin: "remote" }); // simula fechamento entre commit local e hook
  const restored = harness({ values: h.values, server: h.server }); restored.login("user-a", "INITIAL_SESSION");
  await restored.sync();
  assert.equal(restored.remote().data.transactions.length, 2);
});

test("uma aba preserva tombstone gravado por outra durante um pull pendente", async () => {
  const first = await seeded(); const second = harness({ values: first.values, server: first.server });
  second.login("user-a", "INITIAL_SESSION");
  const gate = deferred(); first.server.holdSelect = gate;
  const pending = first.cloud.syncNow(); await settle();
  second.Store.deleteDataset("folder0001");
  gate.resolve(); await pending;
  assert.equal(first.local(), null);
  assert.equal(first.remote(), undefined);
});

test("duas abas excluem pastas distintas sem perder tombstones mesmo antes do evento storage", async () => {
  const first = await seeded(); first.create("folder0002"); await first.sync();
  const second = harness({ values: first.values, server: first.server });
  second.login("user-a", "INITIAL_SESSION");
  first.Store.deleteDataset("folder0001");
  second.Store.deleteDataset("folder0002");
  const queue = JSON.parse([...first.values].find(([key]) => key.startsWith("fyg:cloud-queue:v1:"))[1]);
  assert.deepEqual(Object.keys(queue.deletes).sort(), ["folder0001", "folder0002"]);
  const restarted = harness({ values: first.values, server: first.server });
  restarted.login("user-a", "INITIAL_SESSION"); await restarted.sync();
  assert.equal(restarted.server.rows.size, 0);
  assert.equal(restarted.Store.loadIndex().length, 0);
});

test("mudança de projeto em outra aba cancela a conexão antiga e não reatribui sua sessão", async () => {
  for (const deliverStorage of [false, true]) {
    const h = await seeded({ auto: true }); h.add("Pendente no projeto original");
    const gate = deferred(); h.server.holdSelect = gate;
    const pending = h.cloud.syncNow(); await settle();
    h.values.set("fyg:supabase-config", JSON.stringify({ url: "https://otherproject.supabase.co", anonKey: "fake-publishable-key-for-another-project" }));
    if (deliverStorage) h.context.window.fire("storage", { key: "fyg:supabase-config" });
    // Simula o callback tardio do cliente antigo, antes ou depois do storage.
    // A chamada direta evita criar o novo cliente através de login().
    h.refreshAuth("user-a");
    gate.resolve(); await pending;
    assert.equal(h.cloud.getSyncState().connected, false);
    assert.equal(h.cloud.getSyncState().pendingCount, 1);
    assert.equal(h.remote().data.transactions.length, 1);
    const ledger = JSON.parse(h.values.get("fyg:cloud-owners:v1"));
    assert.ok(!ledger.owners.folder0001.startsWith("https://otherproject"));
    assert.ok(![...h.values.keys()].some((key) => key.startsWith("fyg:cloud-queue:v1:https://otherproject")));
    assert.equal(h.timers.size, 0);
  }
});

test("timeout de request mantém fila e programa retentativa sem requisições simultâneas", async () => {
  const h = await seeded({ auto: true }); h.add("Pendente");
  const gate = deferred(); h.server.holdSelect = gate;
  const pending = h.cloud.syncNow(); await settle();
  await h.tick(20000); assert.equal(await pending, false);
  assert.equal(h.cloud.getSyncState().pendingCount, 1);
  assert.ok([...h.timers.values()].some((timer) => timer.delay === 5000));
  gate.resolve(); await settle();
  assert.equal(h.remote().data.transactions.length, 1);
});

test("retorno de autenticação e visibilidade agenda apenas recuperação de pendências", async () => {
  const h = await seeded({ auto: true }); h.server.paused = true; h.add("Pendente"); await h.sync();
  h.context.document.fire("visibilitychange");
  assert.ok([...h.timers.values()].some((timer) => timer.delay === 0));
  h.server.paused = false; h.login("user-a", "TOKEN_REFRESHED"); await h.tick(0);
  const calls = h.server.calls.length;
  h.context.document.fire("visibilitychange");
  assert.equal(h.timers.size, 0); assert.equal(h.server.calls.length, calls);
  assert.ok(h.events.some((event) => event.type === "fyg:cloudstate" && event.detail.status === "synced"));
});

test("remoto inválido antes dos demais não bloqueia upload válido nem esconde a causa atrás de pasta sem vínculo", async () => {
  const h = harness({ auto: true });
  h.create("unlinked001"); h.login(); h.create();
  const invalid = putInvalidRemote(h);
  assert.equal(await h.sync(), false, "uma sincronização parcial não anuncia sucesso completo");
  assert.deepEqual(h.remote("invalid001"), invalid);
  assert.ok(h.remote(), "a pasta válida pendente foi enviada");
  assert.equal(h.local("invalid001"), null);
  const state = h.cloud.getSyncState();
  assert.equal(state.unlinkedCount, 1);
  assert.equal(state.pendingCount, 0);
  assert.equal(state.invalidRemoteCount, 1);
  assert.equal(state.blockedPendingCount, 0);
  assert.equal(state.status, "error");
  assert.equal(state.lastSyncedAt, null);
  assert.match(state.error, /dados inválidos/);
  assert.match(h.nodes.get("#cloud-status").textContent, /dados inválidos/);
  assert.doesNotMatch(h.nodes.get("#cloud-status").textContent, /Tudo sincronizado/);
  assert.deepEqual(h.server.calls.map((call) => call.operation), ["select", "insert"]);
  assert.equal(h.timers.size, 0, "sem pendências, não faz polling automático do registro inválido");
});

test("upload do mesmo ID inválido fica intacto na fila e usa backoff crescente e limitado", async () => {
  const h = await seeded({ auto: true }); h.add("Alteração local protegida");
  h.remote().data.transactions[0].date = "2025-00-20";
  const invalid = copy(h.remote()), local = h.local(), dirty = storedQueue(h).dirty.folder0001;
  h.create("folder0002");
  const beforeCalls = h.server.calls.length;
  assert.equal(await h.sync(), false);
  assert.ok(h.remote("folder0002"));
  assert.deepEqual(h.remote(), invalid);
  assert.deepEqual(h.local(), local);
  assert.deepEqual(storedQueue(h).dirty.folder0001, dirty);
  assert.equal(h.cloud.getSyncState().blockedPendingCount, 1);
  assert.equal(h.cloud.getSyncState().pendingUploads, 1);
  assert.match(h.nodes.get("#cloud-status").textContent, /aguardando envio.*dados inválidos/);
  for (const delay of [5000, 15000, 30000, 60000, 120000, 300000, 300000]) {
    assert.equal(h.timers.size, 1);
    assert.equal([...h.timers.values()][0].delay, delay);
    await h.tick(delay);
  }
  assert.deepEqual(storedQueue(h).dirty.folder0001, dirty);
  assert.deepEqual(h.remote(), invalid);
  assert.ok(h.server.calls.slice(beforeCalls).filter((call) => call.operation !== "select")
    .every((call) => call.operation === "insert" && call.payload.id === "folder0002"));
});

test("exclusão de remoto inválido mantém tombstone após reload e só prossegue depois do reparo remoto", async () => {
  const h = await seeded(); h.Store.deleteDataset("folder0001");
  h.remote().data.transactions[0].date = "2025-00-20";
  const invalid = copy(h.remote()), tombstone = storedQueue(h).deletes.folder0001;
  assert.equal(await h.sync(), false);
  assert.equal(h.local(), null);
  assert.deepEqual(h.remote(), invalid);
  assert.deepEqual(storedQueue(h).deletes.folder0001, tombstone);
  assert.equal(h.cloud.getSyncState().blockedPendingCount, 1);
  assert.equal(h.cloud.getSyncState().pendingDeletes, 1);
  const restored = harness({ values: h.values, server: h.server });
  restored.login("user-a", "INITIAL_SESSION");
  assert.equal(await restored.sync(), false);
  assert.deepEqual(storedQueue(restored).deletes.folder0001, tombstone);
  assert.ok(!h.server.calls.some((call) => call.operation === "delete"));
  restored.remote().data.transactions[0].date = "2026-10-10";
  assert.equal(await restored.sync(), true);
  assert.equal(restored.remote(), undefined);
  assert.equal(restored.cloud.getSyncState().pendingCount, 0);
  assert.equal(restored.cloud.getSyncState().invalidRemoteCount, 0);
  assert.equal(restored.cloud.getSyncState().blockedPendingCount, 0);
});

test("reparo remoto desbloqueia upload pendente e limpa diagnóstico sem criar cópia de dados inválidos", async () => {
  const h = await seeded(); h.add("Alteração local protegida");
  h.remote().data.transactions[0].date = "2025-00-20";
  assert.equal(await h.sync(), false);
  h.remote().data.transactions[0].date = "2026-10-10";
  assert.equal(await h.sync(), true);
  assert.equal(h.remote().data.transactions[1].desc, "Alteração local protegida");
  const state = h.cloud.getSyncState();
  assert.equal(state.invalidRemoteCount, 0);
  assert.equal(state.blockedPendingCount, 0);
  assert.equal(state.pendingCount, 0);
  assert.equal(state.error, null);
  assert.equal(state.status, "synced");
  assert.equal(h.Store.loadIndex().length, 1);
});

test("diagnóstico de remoto inválido não atravessa logout, troca de conta ou projeto", async () => {
  for (const mode of ["logout", "account", "project"]) {
    const h = await seeded(); h.add("Pendente em A");
    h.remote().data.transactions[0].date = "2025-00-20";
    await h.sync();
    assert.equal(h.cloud.getSyncState().invalidRemoteCount, 1);
    const gate = deferred(); h.server.holdSelect = gate;
    const pending = h.cloud.syncNow(); await settle();
    if (mode === "logout") await h.cloud.logout();
    else if (mode === "account") h.login("user-b");
    else {
      h.values.set("fyg:supabase-config", JSON.stringify({ url: "https://otherproject.supabase.co", anonKey: "fake-publishable-key-for-another-project" }));
      h.context.window.fire("storage", { key: "fyg:supabase-config" });
    }
    gate.resolve(); await pending; await settle();
    const state = h.cloud.getSyncState();
    assert.equal(state.invalidRemoteCount, 0, mode);
    assert.equal(state.blockedPendingCount, 0, mode);
    assert.equal(state.error, null, mode);
    if (mode === "account") { assert.equal(await h.sync(), true); assert.equal(h.cloud.getSyncState().invalidRemoteCount, 0); }
  }
});

test("erro real de autenticação após isolar inválidos continua interrompendo envio e fica visível", async () => {
  const h = await seeded({ auto: true }); h.add("Pendente"); putInvalidRemote(h);
  h.server.beforeWrite = () => { throw Object.assign(new Error("JWT expired"), { status: 401, code: "PGRST301" }); };
  assert.equal(await h.sync(), false);
  const state = h.cloud.getSyncState();
  assert.equal(state.status, "auth-required");
  assert.equal(state.invalidRemoteCount, 1);
  assert.equal(state.pendingCount, 1);
  assert.equal(state.error, "JWT expired");
  assert.match(h.nodes.get("#cloud-status").textContent, /Entre novamente.*JWT expired/);
  assert.equal(h.remote().data.transactions.length, 1);
  assert.equal(h.timers.size, 0);
});

test("falha ao sair mantém diagnóstico do remoto inválido junto com a sessão restaurada", async () => {
  const h = await seeded(); putInvalidRemote(h); await h.sync();
  h.context.supabase.createClient().auth.signOut = async () => ({ error: new Error("Logout indisponível") });
  await h.cloud.logout();
  const state = h.cloud.getSyncState();
  assert.equal(state.connected, true);
  assert.equal(state.invalidRemoteCount, 1);
  assert.equal(state.status, "error");
  assert.match(state.error, /dados inválidos/);
});

test("mensagem de erro pendente é apresentada como texto sem interpretar HTML", async () => {
  const h = await seeded(); h.add("Pendente");
  const message = "Falha de envio <img src=x onerror=alert(1)>";
  h.server.beforeWrite = () => { throw new Error(message); };
  assert.equal(await h.sync(), false);
  assert.equal(h.cloud.getSyncState().error, message);
  assert.ok(h.nodes.get("#cloud-status").textContent.includes(message));
  assert.equal(h.nodes.get("#cloud-status").innerHTML, "");
});
