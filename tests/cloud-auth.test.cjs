"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../js/cloud.js"), "utf8").replace(
  "repairLegacyDates, exportRepairBackup };", "repairLegacyDates, exportRepairBackup, ensureClient, logout, init, signInOrUp, forgotPassword, saveNewPassword };"
);
const core = fs.readFileSync(path.join(__dirname, "../js/app.js"), "utf8");
const clone = (value) => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate); };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const sessionFor = (id) => ({ user: { id, email: id + "@example.invalid", email_confirmed_at: "2026-10-22T00:00:00Z" }, access_token: "synthetic-" + id });

function target() {
  const handlers = new Map();
  return { addEventListener(type, fn) { if (!handlers.has(type)) handlers.set(type, []); handlers.get(type).push(fn); },
    fire(type, event = {}) { (handlers.get(type) || []).forEach((fn) => fn(event)); }, handlers };
}

function harness({ enabled = true, supported = true, authHash = "", authSearch = "", origin = "https://financas-yg.vercel.app" } = {}) {
  let now = Date.parse("2026-10-22T12:00:00Z"), timerId = 0;
  const values = new Map([["fyg:cloud-autosync", "0"]]), timers = new Map(), nodes = new Map(), events = [], clients = [], network = [];
  const server = { enabled, settingsGate: null, verifyGate: null, jsonGate: null, otpGate: null, getSessionGate: null,
    settingsFail: false, authError: null, userId: "user-a", initialSession: null, getSessionError: null, disableSignup: false,
    otpCalls: [], passkeyCalls: [], passwordCalls: [], signupCalls: [], verifyCalls: [], recoveryCalls: [], updateCalls: [], persisted: new Map(), syncReads: 0 };
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const window = Object.assign(target(), { isSecureContext: supported, PublicKeyCredential: supported ? function PublicKeyCredential() {} : undefined });
  const document = Object.assign(target(), { visibilityState: "visible", dispatchEvent(event) { events.push(clone(event)); return true; },
    querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, Object.assign(target(), { value: "", textContent: "", innerHTML: "", checked: false,
      classList: { add() {}, remove() {}, toggle() {} }, focus() {}, scrollIntoView() {} })); return nodes.get(selector); }, querySelectorAll: () => [] });
  const fetch = async (url, options = {}) => {
    network.push({ url, headers: options.headers, signal: options.signal });
    if (url.endsWith("/settings")) {
      const settingsValue = server.enabled, gate = server.settingsGate; server.settingsGate = null;
      if (gate) await gate.promise;
      if (server.settingsFail) throw new Error("Offline");
      return { ok: true, json: async () => ({ passkeys_enabled: settingsValue, disable_signup: server.disableSignup }) };
    }
    const gate = server.verifyGate, jsonGate = server.jsonGate; server.verifyGate = null; server.jsonGate = null;
    if (gate) await gate.promise; // Intencionalmente ignora abort para testar a defesa pós-fetch.
    const body = url.includes("registration") ? { id: "passkey-id" } : { ...sessionFor(server.userId), expires_in: 3600, refresh_token: "synthetic-refresh", token_type: "bearer" };
    return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => { if (jsonGate) await jsonGate.promise; return body; } };
  };
  const createClient = (url, key, options) => {
    let listener = () => {};
    const sessionRequest = async (endpoint, payload) => {
      if (server.authError) return { data: null, error: server.authError };
      const response = await options.global.fetch(url + "/auth/v1/" + endpoint, { method: "POST", body: JSON.stringify(payload) });
      const body = await response.json(), session = { user: body.user, access_token: body.access_token };
      server.persisted.set(url, session); listener("SIGNED_IN", session);
      return { data: { session, user: session.user }, error: null };
    };
    const api = {
      url, options,
      emit(event, session) { listener(event, session); },
      auth: {
        onAuthStateChange(fn) { listener = fn; return { data: { subscription: { unsubscribe() { listener = () => {}; } } } }; },
        async getSession() { const result = server.initialSession, gate = server.getSessionGate; server.getSessionGate = null; if (gate) await gate.promise; return { data: { session: result }, error: server.getSessionError }; },
        async signOut() { server.persisted.delete(url); listener("SIGNED_OUT", null); return {}; },
        async signInWithOtp(payload) { server.otpCalls.push(clone(payload)); const gate = server.otpGate; server.otpGate = null; if (gate) await gate.promise; return { data: { user: null, session: null }, error: server.authError }; },
        async signInWithPassword(payload) { server.passwordCalls.push(clone(payload)); return sessionRequest("token?grant_type=password", payload); },
        async signUp(payload) { server.signupCalls.push(clone(payload)); return sessionRequest("signup", payload); },
        async verifyOtp(payload) { server.verifyCalls.push(clone(payload)); return sessionRequest("verify", payload); },
        async resetPasswordForEmail(email, params) {
          server.recoveryCalls.push({ email, ...clone(params) });
          if (server.authError) return { error: server.authError };
          const response = await options.global.fetch(url + "/auth/v1/recover", { method: "POST" }); await response.json(); return { error: null };
        },
        async updateUser(payload) {
          server.updateCalls.push(clone(payload));
          if (server.authError) return { error: server.authError };
          const response = await options.global.fetch(url + "/auth/v1/user", { method: "PUT", body: JSON.stringify(payload) });
          const data = await response.json(); listener("USER_UPDATED", sessionFor(server.userId)); return { data: { user: data.user }, error: null };
        },
        async signInWithPasskey(params) {
          server.passkeyCalls.push({ method: "login", signal: params.options.signal });
          if (server.authError) return { data: null, error: server.authError };
          const response = await options.global.fetch(url + "/auth/v1/passkeys/authentication/verify", { method: "POST" });
          const result = await response.json();
          const session = { user: result.user, access_token: result.access_token };
          // Como o SDK oficial: persistência acontece ANTES do callback SIGNED_IN.
          server.persisted.set(url, session); listener("SIGNED_IN", session);
          return { data: { session, user: session.user }, error: null };
        },
        async registerPasskey(params) {
          server.passkeyCalls.push({ method: "register", signal: params.options.signal });
          if (server.authError) return { data: null, error: server.authError };
          const response = await options.global.fetch(url + "/auth/v1/passkeys/registration/verify", { method: "POST" });
          return { data: await response.json(), error: null };
        },
      },
      from() { return { select() { return this; }, eq() { return this; }, abortSignal() { return this; }, then(resolve) { server.syncReads++; return Promise.resolve({ data: [] }).then(resolve); } }; },
    };
    clients.push(api); return api;
  };
  const context = vm.createContext({ Date: ClockDate, Math, AbortController, AbortSignal, fetch,
    console: { error() {}, warn() {}, log() {} }, window, document,
    navigator: { onLine: true, credentials: supported ? { get() {}, create() {} } : undefined },
    location: { origin, pathname: "/", hash: authHash, search: authSearch },
    localStorage: { get length() { return values.size; }, key: (i) => [...values.keys()][i], getItem: (k) => values.get(k) ?? null,
      setItem: (k, v) => values.set(k, String(v)), removeItem: (k) => values.delete(k) },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    setTimeout(fn, delay = 0) { timers.set(++timerId, { fn, delay }); return timerId; }, clearTimeout(id) { timers.delete(id); },
    supabase: { createClient }, Dashboard: { refreshFromStore() {} },
  });
  vm.runInContext(core + "\nthis.Store = Store; renderFolders = () => {}; toast = () => {};", context);
  vm.runInContext(source + "\nthis.cloud = Cloud;", context);
  const cloud = context.cloud;
  return { cloud, context, server, clients, values, nodes, events, network, timers,
    async ready() { cloud.ensureClient(); await settle(); },
    email(value = "existing@example.invalid") { document.querySelector("#cloud-email").value = value; },
    login(id = "user-a", event = "SIGNED_IN") { clients.at(-1).emit(event, sessionFor(id)); },
    async tick(delay) { const entry = [...timers].find(([, timer]) => timer.delay === delay); assert.ok(entry); timers.delete(entry[0]); now += delay; entry[1].fn(); await settle(); },
    config(url = "https://differentproject.supabase.co") { values.set("fyg:supabase-config", JSON.stringify({ url, anonKey: "public-test-key-long-enough-12345" })); window.fire("storage", { key: "fyg:supabase-config" }); },
    status() { return document.querySelector("#cloud-access-status").textContent; },
    createLocal() { context.Store.saveDataset({ id: "local0001", name: "Local", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", transactions: [], categories: [], limits: [], metas: [] }); },
  };
}

test("SDK recebe opt-in experimental e consulta somente settings público do projeto ativo", async () => {
  const h = harness({ enabled: false }); await h.ready();
  assert.equal(h.clients[0].options.auth.experimental.passkey, true);
  assert.equal(h.cloud.getAuthOptions().passkeysEnabled, false);
  assert.equal(h.cloud.getAuthOptions().passkeysSupported, true);
  assert.equal(h.cloud.getAuthOptions().loading, false);
  assert.equal(h.network.length, 1); assert.ok(h.network[0].url.endsWith("/auth/v1/settings"));
  assert.equal(Object.keys(h.network[0].headers).join(), "apikey");
  assert.ok(h.events.some((event) => event.type === "fyg:authoptions" && event.detail.loading));
  assert.equal(await h.cloud.signInWithPasskey(), false);
  h.login(); assert.equal(await h.cloud.registerPasskey(), false);
  assert.equal(h.server.passkeyCalls.length, 0);
});

function receiptJobsWithRealCloud(h){
  const calls=[];
  h.context.crypto=require('node:crypto').webcrypto;h.context.atob=atob;
  Object.assign(h.context.Dashboard,{getImportTargetId:()=> 'local0001',getCats:()=>['Outros']});
  const querySelector=h.context.document.querySelector;
  h.context.document.querySelector=s=>s.startsWith('#receipt-jobs')?null:querySelector(s);
  h.context.fetch=async(url,options)=>{const body=JSON.parse(options.body);calls.push({url,body,headers:options.headers});return {ok:true,status:200,json:async()=>body.action==='create'?{id:body.id}:body.action==='list'?{jobs:[]}:{uploaded:true,status:'queued'}};};
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/receipt-jobs.js'),'utf8')+'\nthis.receipts=ReceiptJobs;',h.context);
  return {receipts:h.context.receipts,calls};
}
const uploadTask=()=>[{part:{data:'YWJj',mediaType:'image/png',documentContext:{pageStart:1,pageEnd:1,totalPages:1}},label:'Extrato fictício',documentId:'doc1'}];
test('documentos usa a sessão restaurada pelo Cloud real, sem exigir novo login',async()=>{
  const h=harness();h.server.initialSession=sessionFor('user-a');await h.cloud.init();
  assert.equal(h.cloud.getSyncState().connected,true);
  assert.equal(h.cloud.getSyncState().owner,'https://mhgagjhwsjjjwwvopjgu.supabase.co|user-a');
  const {receipts,calls}=receiptJobsWithRealCloud(h);
  const job=await receipts.submit(uploadTask(),[]);
  assert.equal(job,calls[0].body.id);
  assert.deepEqual(calls.map(x=>x.body.action),['create','upload','submit','list']);
  assert(calls.every(x=>x.headers.Authorization==='Bearer synthetic-user-a'));
  assert(!calls.some(x=>x.body.action==='commit'));
  assert(h.events.filter(x=>x.type==='fyg:cloudstate').every(x=>!JSON.stringify(x.detail).includes('synthetic-user-a')));
});
test('identificação da conta acompanha troca, logout e mudança de projeto',async()=>{
  const h=harness();await h.ready();assert.equal(h.cloud.getSyncState().owner,null);
  h.login('user-a');const before=h.cloud.getSyncState().owner;assert(before.endsWith('|user-a'));
  h.login('user-b');assert(h.cloud.getSyncState().owner.endsWith('|user-b'));assert.notEqual(h.cloud.getSyncState().owner,before);
  await h.cloud.logout();assert.equal(h.cloud.getSyncState().owner,null);
  h.login('user-a');h.config();assert.equal(h.cloud.getSyncState().owner,null);
});
test('sem sessão o upload não faz requisição e não promete resultado em Documentos',async()=>{
  const h=harness();await h.ready();const {receipts,calls}=receiptJobsWithRealCloud(h);
  let error;try{await receipts.submit(uploadTask(),[]);}catch(e){error=e;}
  assert.equal(error.message,'login_required');assert.equal(calls.length,0);
  assert.match(receipts.uploadMessage(error),/não foi enviado/);assert.doesNotMatch(receipts.uploadMessage(error),/em Documentos/);
});
test('erro após criar envio encaminha só então para Documentos',async()=>{
 const h=harness();await h.ready();h.login();const {receipts}=receiptJobsWithRealCloud(h);
 h.context.fetch=async(_,opt)=>({ok:JSON.parse(opt.body).action==='create',status:JSON.parse(opt.body).action==='create'?200:503,json:async()=>({error:'service_unavailable'})});
 let error;try{await receipts.submit(uploadTask(),[]);}catch(e){error=e;}
 assert.equal(error.receiptJobCreated,true);assert.match(receipts.uploadMessage(error),/em Documentos/);
});
test('trocar de conta durante a criação impede enviar o arquivo na sessão seguinte',async()=>{
 const h=harness();await h.ready();h.login('user-a');const {receipts}=receiptJobsWithRealCloud(h),gate=deferred(),calls=[];
 h.context.fetch=async(_,opt)=>{calls.push(JSON.parse(opt.body).action);await gate.promise;return {ok:true,status:200,json:async()=>({id:'created'})};};
 const pending=receipts.submit(uploadTask(),[]);
 for(let i=0;i<30&&!calls.length;i++)await settle();assert.deepEqual(calls,['create']);
 h.login('user-b');gate.resolve();await assert.rejects(pending,/context_changed/);assert.deepEqual(calls,['create']);
});

test("settings antigo não habilita passkeys no novo projeto e falha preserva estado desconhecido", async () => {
  const h = harness(), gate = deferred(); h.server.settingsGate = gate;
  h.cloud.ensureClient(); h.config(); h.server.enabled = false;
  await h.ready(); gate.resolve(); await settle();
  assert.equal(h.cloud.getAuthOptions().passkeysEnabled, false);
  h.config("https://offlineproject.supabase.co"); h.server.settingsFail = true; await h.ready();
  assert.equal(h.cloud.getAuthOptions().passkeysEnabled, null);
  assert.match(h.cloud.getAuthOptions().error, /Não foi possível verificar/);
  assert.equal(await h.cloud.signInWithPasskey(), false);
  assert.equal(h.server.passkeyCalls.length, 0);
});

test("link usa conta existente, redirect fixo e não cria sessão nem grava senha", async () => {
  const h = harness(); await h.ready(); h.email(" existing@example.invalid ");
  assert.equal(await h.cloud.sendSignInLink(), true);
  assert.deepEqual(h.server.otpCalls, [{ email: "existing@example.invalid", options: { shouldCreateUser: false, emailRedirectTo: "https://financas-yg.vercel.app/" } }]);
  assert.equal(h.cloud.getSyncState().connected, false);
  assert.equal(h.server.persisted.size, 0);
  assert.equal([...h.values.keys()].some((key) => /password|senha/i.test(key)), false);
  assert.match(h.status(), /Se este e-mail pertence/);
});

test("clique duplo e cooldown de 60s limitam envios sem depender do e-mail informado", async () => {
  const h = harness(); await h.ready(); h.email(); const gate = deferred(); h.server.otpGate = gate;
  const pending = h.cloud.sendSignInLink(); assert.equal(h.cloud.getAuthOptions().busyAction, "link");
  assert.equal(await h.cloud.sendSignInLink(), false);
  gate.resolve(); assert.equal(await pending, true); h.email("another@example.invalid");
  assert.equal(await h.cloud.sendSignInLink(), false); assert.equal(h.server.otpCalls.length, 1);
  await h.tick(60000); assert.equal(await h.cloud.sendSignInLink(), true);
  assert.equal(h.server.otpCalls.length, 2); assert.equal(h.cloud.getAuthOptions().busy, false);
});

test("e-mail inválido e sessão conectada impedem envio; erro de limite permanece legível", async () => {
  const h = harness(); await h.ready(); h.email("invalid");
  assert.equal(await h.cloud.sendSignInLink(), false); assert.equal(h.server.otpCalls.length, 0);
  h.email(); h.server.authError = { code: "over_email_send_rate_limit" };
  assert.equal(await h.cloud.sendSignInLink(), false); assert.match(h.status(), /Aguarde um minuto/);
  await h.tick(60000); h.login(); assert.equal(await h.cloud.sendSignInLink(), false);
  assert.equal(h.server.otpCalls.length, 1);
});

test("resposta tardia de e-mail não muda a interface de outra conta ou projeto", async () => {
  for (const change of ["account", "project"]) {
    const h = harness(); await h.ready(); h.email(); const gate = deferred(); h.server.otpGate = gate;
    const pending = h.cloud.sendSignInLink();
    if (change === "account") h.login("user-b"); else h.config();
    h.context.document.querySelector("#cloud-access-status").textContent = "Novo contexto";
    gate.resolve(); assert.equal(await pending, false);
    assert.equal(h.status(), "Novo contexto"); assert.equal(h.cloud.getAuthOptions().busy, false);
  }
});

test("passkey login aceita seu próprio SIGNED_IN, persiste sessão validada e sincroniza sem e-mail", async () => {
  const h = harness(); await h.ready();
  assert.equal(await h.cloud.signInWithPasskey(), true);
  assert.equal(h.cloud.getSyncState().connected, true); assert.equal(h.cloud.getToken(), "synthetic-user-a");
  assert.equal(h.server.passkeyCalls.length, 1); assert.equal(h.server.otpCalls.length, 0);
  assert.equal(h.server.persisted.size, 1); assert.equal(h.server.syncReads, 1);
  assert.equal(h.cloud.getAuthOptions().busy, false);
  assert.match(h.status(), /Entrada confirmada/);
});

test("cancelamento na verificação impede o SDK de persistir sessão antes ou depois de ler JSON", async () => {
  for (const phase of ["fetch", "json"]) {
    for (const change of ["logout", "account", "project"]) {
      const h = harness(); await h.ready(); const gate = deferred();
      h.server[phase === "fetch" ? "verifyGate" : "jsonGate"] = gate;
      const pending = h.cloud.signInWithPasskey(); await settle();
      if (change === "logout") await h.cloud.logout();
      else if (change === "account") h.login("user-b");
      else h.config();
      gate.resolve(); assert.equal(await pending, false); await settle();
      assert.equal(h.server.persisted.size, 0, "resposta cancelada nunca alcança persistência do SDK");
      assert.equal(h.cloud.getToken(), change === "account" ? "synthetic-user-b" : null);
      assert.equal(h.cloud.getAuthOptions().busy, false);
    }
  }
});

test("cadastro exige sessão e suporte, usa SDK e não altera a conta", async () => {
  const h = harness(); await h.ready();
  assert.equal(await h.cloud.registerPasskey(), false); assert.equal(h.server.passkeyCalls.length, 0);
  h.login(); assert.equal(await h.cloud.registerPasskey(), true);
  assert.equal(h.server.passkeyCalls[0].method, "register"); assert.equal(h.cloud.getToken(), "synthetic-user-a");
  assert.match(h.status(), /Chave de acesso cadastrada/);
  const unsupported = harness({ supported: false }); await unsupported.ready(); unsupported.login();
  assert.equal(await unsupported.cloud.registerPasskey(), false);
  assert.equal(unsupported.server.passkeyCalls.length, 0);
});

test("cancelar prompt e email não confirmado não produzem sessão nem exceção", async () => {
  for (const error of [{ name: "NotAllowedError" }, { code: "email_not_confirmed" }, { code: "passkey_disabled" }]) {
    const h = harness(); await h.ready(); h.server.authError = error;
    assert.equal(await h.cloud.signInWithPasskey(), false);
    assert.equal(h.cloud.getSyncState().connected, false); assert.equal(h.cloud.getAuthOptions().busy, false);
    assert.equal(h.server.persisted.size, 0);
    if (error.code === "passkey_disabled") assert.equal(h.cloud.getAuthOptions().passkeysEnabled, false);
    else if (error.code === "email_not_confirmed") assert.match(h.status(), /e-mail ainda não foi confirmado/);
    else assert.match(h.status(), /cancelada/);
  }
});

test("retorno de magic link nunca usa INITIAL_SESSION para adotar pastas sem dono", async () => {
  for (const parameters of [{ authHash: "#access_token=synthetic" }, { authSearch: "?code=synthetic" }]) {
    const h = harness(parameters); h.createLocal(); await h.ready(); h.login("user-a", "INITIAL_SESSION");
    assert.equal(h.cloud.getSyncState().unlinkedCount, 1);
    assert.equal(h.cloud.getSyncState().pendingCount, 0);
  }
});

test("getSession inicial tardio não substitui conta autenticada por callback mais recente", async () => {
  const h = harness(), gate = deferred(); h.server.initialSession = sessionFor("old-user"); h.server.getSessionGate = gate;
  const pending = h.cloud.init(); await settle(); h.login("new-user");
  gate.resolve(); await pending;
  assert.equal(h.cloud.getToken(), "synthetic-new-user");
});

test("novos botões recebem handlers sem alterar os existentes", async () => {
  const h = harness(); h.context.document.fire("DOMContentLoaded"); await settle();
  for (const id of ["#btn-cloud-magic-link", "#btn-cloud-passkey-login", "#btn-cloud-passkey-register", "#btn-cloud-signin", "#btn-cloud-forgot", "#btn-cloud-code-send", "#btn-cloud-code-verify"]) {
    assert.equal(h.nodes.get(id).handlers.get("click").length, 1);
  }
});

test("login aceita senha legada curta, limpa o campo e valida pelo servidor", async () => {
  for (const password of ["six123", "seven12"]) {
    const h = harness(); await h.ready(); h.email();
    h.context.document.querySelector("#cloud-pass").value = password;
    assert.equal(await h.cloud.signInOrUp(false), true);
    assert.equal(h.server.passwordCalls[0].password, password);
    assert.equal(h.cloud.getToken(), "synthetic-user-a");
    assert.equal(h.nodes.get("#cloud-pass").value, "");
    assert.equal(h.cloud.getAuthOptions().busy, false);
    assert.equal(h.server.syncReads, 1);
  }
});

test("cadastro respeita política pública e exige senha nova de oito caracteres", async () => {
  const h = harness(); h.server.disableSignup = true; await h.ready(); h.email();
  h.context.document.querySelector("#cloud-pass").value = "synthetic-long-password";
  assert.equal(h.cloud.getAuthOptions().signupsAllowed, false);
  assert.equal(await h.cloud.signInOrUp(true), false);
  assert.equal(h.server.signupCalls.length, 0);
  const allowed = harness(); await allowed.ready(); allowed.email();
  allowed.context.document.querySelector("#cloud-pass").value = "short";
  assert.equal(await allowed.cloud.signInOrUp(true), false);
  assert.equal(allowed.server.signupCalls.length, 0);
  assert.equal(allowed.cloud.getAuthOptions().signupsAllowed, true);
});

test("erro de credenciais fica separado da sincronização sem refletir mensagem sensível", async () => {
  const h = harness(); await h.ready(); h.email();
  h.context.document.querySelector("#cloud-pass").value = "synthetic-password";
  h.server.authError = { code: "invalid_credentials", message: "private-server-detail" };
  assert.equal(await h.cloud.signInOrUp(false), false);
  const status = h.status(); assert.match(status, /E-mail ou senha incorretos/);
  assert.doesNotMatch(status, /private-server-detail/);
  h.cloud.onLocalChange([]); assert.equal(h.status(), status);
  assert.equal(h.server.persisted.size, 0);
});

test("e-mails de acesso, cadastro e recuperação nunca recebem localhost no redirect", async () => {
  for (const action of ["link", "signup", "recover"]) {
    const h = harness({ origin: "http://localhost:3000" }); await h.ready(); h.email();
    if (action === "link") {
      await h.cloud.sendSignInLink();
      assert.equal(h.server.otpCalls[0].options.emailRedirectTo, "https://financas-yg.vercel.app/");
    } else if (action === "signup") {
      h.context.document.querySelector("#cloud-pass").value = "synthetic-password";
      await h.cloud.signInOrUp(true);
      assert.equal(h.server.signupCalls[0].options.emailRedirectTo, "https://financas-yg.vercel.app/");
    } else {
      await h.cloud.forgotPassword();
      assert.equal(h.server.recoveryCalls[0].redirectTo, "https://financas-yg.vercel.app/");
      assert.equal(await h.cloud.sendSignInLink(), false, "cooldown é compartilhado entre e-mails");
    }
  }
});

test("senha tem exclusão mútua e prazo de vinte segundos; resposta atrasada não persiste", async () => {
  const h = harness(); await h.ready(); h.email();
  h.context.document.querySelector("#cloud-pass").value = "synthetic-password";
  const gate = deferred(); h.server.verifyGate = gate;
  const pending = h.cloud.signInOrUp(false); await settle();
  assert.equal(h.cloud.getAuthOptions().busyAction, "password-login");
  assert.equal(await h.cloud.signInOrUp(false), false);
  assert.equal(await h.cloud.forgotPassword(), false);
  assert.equal(await h.cloud.sendSignInLink(), false);
  await h.tick(20000); assert.equal(await pending, false);
  assert.equal(h.cloud.getAuthOptions().busy, false); assert.match(h.status(), /demorou demais/);
  gate.resolve(); await settle();
  assert.equal(h.server.persisted.size, 0); assert.equal(h.cloud.getToken(), null);
  assert.equal(h.server.passwordCalls.length, 1); assert.equal(h.server.recoveryCalls.length, 0);
});

test("senha e OTP cancelados não persistem sessão após logout, troca de conta ou projeto", async () => {
  for (const action of ["password", "otp"]) for (const phase of ["fetch", "json"]) for (const change of ["logout", "account", "project"]) {
    const h = harness(); await h.ready(); h.email();
    if (action === "otp") { await h.cloud.sendSignInCode(); h.context.document.querySelector("#cloud-code").value = "12345678"; }
    else h.context.document.querySelector("#cloud-pass").value = "synthetic-password";
    const gate = deferred(); h.server[phase === "fetch" ? "verifyGate" : "jsonGate"] = gate;
    const pending = action === "otp" ? h.cloud.verifySignInCode() : h.cloud.signInOrUp(false); await settle();
    if (change === "logout") await h.cloud.logout(); else if (change === "account") h.login("user-b"); else h.config();
    gate.resolve(); assert.equal(await pending, false); await settle();
    assert.equal(h.server.persisted.size, 0, `${action}/${phase}/${change} não persiste sessão cancelada`);
    assert.equal(h.cloud.getToken(), change === "account" ? "synthetic-user-b" : null);
    assert.equal(h.cloud.getAuthOptions().busy, false);
  }
});

test("recuperação é vinculada à conta do link e não autoriza trocar senha de outra conta", async () => {
  const h = harness(); await h.ready(); h.login("user-a", "PASSWORD_RECOVERY");
  assert.equal(h.cloud.getAuthOptions().recoveryActive, true);
  h.context.document.querySelector("#cloud-newpass").value = "synthetic-new-password";
  assert.equal(await h.cloud.saveNewPassword(), true);
  assert.equal(h.server.updateCalls.length, 1); assert.equal(h.nodes.get("#cloud-newpass").value, "");
  assert.equal(h.cloud.getAuthOptions().recoveryActive, false); assert.match(h.status(), /Senha atualizada/);
  const switched = harness(); await switched.ready(); switched.login("user-a", "PASSWORD_RECOVERY"); switched.login("user-b");
  switched.context.document.querySelector("#cloud-newpass").value = "synthetic-new-password";
  assert.equal(await switched.cloud.saveNewPassword(), false); assert.equal(switched.server.updateCalls.length, 0);
  assert.equal(switched.cloud.getAuthOptions().recoveryActive, false);
  switched.login("user-b", "PASSWORD_RECOVERY"); await switched.cloud.logout();
  assert.equal(switched.cloud.getAuthOptions().recoveryActive, false); assert.equal(switched.nodes.get("#cloud-newpass").value, "");
});

test("recuperação e salvamento têm prazo e não exibem sucesso tardio", async () => {
  for (const action of ["recover", "save"]) {
    const h = harness(); await h.ready(); h.email();
    if (action === "save") { h.login("user-a", "PASSWORD_RECOVERY"); h.context.document.querySelector("#cloud-newpass").value = "synthetic-new-password"; }
    const gate = deferred(); h.server.jsonGate = gate;
    const pending = action === "save" ? h.cloud.saveNewPassword() : h.cloud.forgotPassword(); await settle();
    await h.tick(20000); assert.equal(await pending, false); const status = h.status();
    assert.match(status, /demorou demais/); gate.resolve(); await settle(); assert.equal(h.status(), status);
    assert.equal(h.cloud.getAuthOptions().busy, false);
  }
});

test("URL expirada e erro de sessão permanecem visíveis após renderização de sincronização", async () => {
  const expired = harness({ authHash: "#error=access_denied&error_code=otp_expired&error_description=private-detail" });
  await expired.cloud.init(); assert.match(expired.status(), /link de acesso expirou ou já foi usado/);
  const status = expired.status(); expired.cloud.onLocalChange([]); assert.equal(expired.status(), status);
  assert.doesNotMatch(status, /private-detail/);
  const invalid = harness({ authSearch: "?error=access_denied&error_description=private-detail" }); await invalid.cloud.init();
  assert.match(invalid.status(), /Não foi possível validar/); assert.doesNotMatch(invalid.status(), /private-detail/);
  const missing = harness(); missing.server.getSessionError = { name: "AuthSessionMissingError" }; await missing.cloud.init();
  assert.match(missing.status(), /sessão de recuperação expirou/);
});

test("código exige solicitação para o mesmo e-mail e confirma sem persistir OTP", async () => {
  const h = harness(); await h.ready(); h.email(); h.context.document.querySelector("#cloud-code").value = "12345678";
  assert.equal(await h.cloud.verifySignInCode(), false); assert.equal(h.server.verifyCalls.length, 0);
  assert.equal(await h.cloud.sendSignInCode(), true); assert.equal(h.cloud.getAuthOptions().codeRequested, true);
  h.email("another@example.invalid"); assert.equal(await h.cloud.verifySignInCode(), false);
  h.email(); h.nodes.get("#cloud-code").value = "bad-token"; assert.equal(await h.cloud.verifySignInCode(), false);
  h.nodes.get("#cloud-code").value = "12345678"; assert.equal(await h.cloud.verifySignInCode(), true);
  assert.deepEqual(h.server.verifyCalls, [{ email: "existing@example.invalid", token: "12345678", type: "email" }]);
  assert.equal(h.cloud.getAuthOptions().codeRequested, false); assert.equal(h.nodes.get("#cloud-code").value, "");
  assert.equal(h.cloud.getToken(), "synthetic-user-a");
  assert.doesNotMatch(JSON.stringify([...h.values]) + JSON.stringify(h.events), /12345678/);
});

test("código expirado informa causa e mantém formulário sem autenticar", async () => {
  const h = harness(); await h.ready(); h.email(); await h.cloud.sendSignInCode();
  h.context.document.querySelector("#cloud-code").value = "123456"; h.server.authError = { code: "otp_expired" };
  assert.equal(await h.cloud.verifySignInCode(), false); assert.match(h.status(), /expirou ou já foi usado/);
  assert.equal(h.cloud.getAuthOptions().codeRequested, true); assert.equal(h.server.persisted.size, 0);
});

test("SDK Supabase local real confirma senha e OTP; cancelamento impede persistência nativa", async () => {
  const sdkContext = vm.createContext({ console: { warn() {}, error() {}, log() {} }, URL, URLSearchParams, Headers, Request, Response,
    AbortController, AbortSignal, TextEncoder, TextDecoder, atob, btoa, setTimeout, clearTimeout, setInterval, clearInterval,
    crypto: require("node:crypto").webcrypto, WebSocket: class { constructor() { throw new Error("Rede real proibida no teste."); } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../lib/supabase.min.js"), "utf8") + "\nthis.sdk = supabase;", sdkContext);
  for (const action of ["password", "otp"]) for (const cancel of [false, true]) {
    const h = harness(); await h.ready(); h.email();
    const persisted = new Map(), localClient = h.clients[0];
    const native = sdkContext.sdk.createClient(localClient.url, "synthetic-public-key", {
      auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: true, storageKey: "synthetic-session",
        storage: { getItem: (key) => persisted.get(key) || null, setItem: (key, value) => persisted.set(key, value), removeItem: (key) => persisted.delete(key) } },
      global: { fetch: localClient.options.global.fetch },
    });
    await native.auth.getSession();
    const { data: { subscription } } = native.auth.onAuthStateChange((event, session) => localClient.emit(event, session));
    await settle();
    localClient.auth.signInWithPassword = native.auth.signInWithPassword.bind(native.auth);
    localClient.auth.verifyOtp = native.auth.verifyOtp.bind(native.auth);
    if (action === "otp") { await h.cloud.sendSignInCode(); h.context.document.querySelector("#cloud-code").value = "12345678"; }
    else h.context.document.querySelector("#cloud-pass").value = "legacy";
    const gate = cancel ? deferred() : null; if (gate) h.server.jsonGate = gate;
    const pending = action === "otp" ? h.cloud.verifySignInCode() : h.cloud.signInOrUp(false);
    if (gate) { await settle(); await h.cloud.logout(); gate.resolve(); }
    assert.equal(await pending, !cancel); await settle();
    assert.equal(persisted.has("synthetic-session"), !cancel, `${action}: sessão nativa só é salva no contexto original`);
    assert.equal(h.cloud.getToken(), cancel ? null : "synthetic-user-a");
    subscription.unsubscribe(); await native.auth.stopAutoRefresh();
  }
});
