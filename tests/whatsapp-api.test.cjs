"use strict";
// No network, real sessions, media or financial records. SQL locking/RLS is
// verified separately; these tests exercise the actual Node routes and core.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { PassThrough } = require("node:stream");
const { IncomingMessage } = require("node:http");
const APP = path.resolve(__dirname, "..");
const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const DRAFT = "33333333-3333-4333-8333-333333333333";
const LEASE = "44444444-4444-4444-8444-444444444444";
const PHONE = "123456789012345", SENDER = "+15550001111";
const clone = value => JSON.parse(JSON.stringify(value));
const response = (data, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => data });
const tx = (extra = {}) => ({ date: "2026-10-23", desc: "Compra sintética", amount: 12.34, currency: "BRL", type: "despesa", category: "Mercado", account: "", ...extra });
const claim = (extra = {}) => ({ accepted: true, claimed: true, draftId: DRAFT, leaseToken: LEASE, categories: [{ name: "Mercado" }, { name: "Outros" }], timeZone: "America/Sao_Paulo", ...extra });
const inbox = (extra = {}) => ({ draft_id: DRAFT, folder_id: "folder123", sender_e164: SENDER, phone_number_id: PHONE, received_at: "2026-10-23T15:00:00Z", candidate: tx(), warnings: [], can_confirm: true, revision: 2, notified_revision: 0, lease_token: null, status: "draft", ...extra });
const message = (extra = {}) => ({ from: SENDER.slice(1), id: "wamid.synthetic.1", timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "Gastei 12,34 BRL no mercado em 23/10/2026" }, ...extra });
const payload = (messages = [message()]) => ({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: PHONE }, messages } }] }] });
const envDefaults = () => ({ SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-role", WHATSAPP_APP_SECRET: "synthetic-app-secret", WHATSAPP_VERIFY_TOKEN: "synthetic-verify-token", WHATSAPP_ACCESS_TOKEN: "synthetic-wa-token", WHATSAPP_GRAPH_VERSION: "v99.0", GEMINI_API_KEY: "synthetic-ai-key" });

async function requestStream(chunks, restored) {
  if (!restored) { const stream = new PassThrough(); for (const chunk of chunks) stream.write(chunk); stream.end(); return stream; }
  // Match the public Vercel Node helper's consumed IncomingMessage + replayed
  // data/end/read interface, not an intact Readable async iterator.
  // https://github.com/vercel/vercel/blob/main/packages/node/src/serverless-functions/helpers.ts
  const request = new IncomingMessage(new PassThrough()); request.complete = true;
  const consumed = new Promise((resolve, reject) => { request.on("data", () => {}); request.on("end", resolve); request.on("error", reject); });
  for (const chunk of chunks) request.push(chunk); request.push(null); await consumed;
  const replay = new PassThrough(), originalListener = request.on.bind(request);
  request.read = (...args) => replay.read(...args);
  request.on = request.addListener = (event, listener) => ["data", "end"].includes(event) ? replay.on(event, listener) : originalListener(event, listener);
  for (const chunk of chunks) replay.write(chunk); replay.end(); return request;
}

function harness(options = {}) {
  const calls = [], modules = new Map(), receiptCalls = [], env = { ...envDefaults(), ...options.env };
  const context = vm.createContext({ Buffer, URL, AbortSignal, Intl, setTimeout: options.setTimeout || setTimeout, clearTimeout: options.clearTimeout || clearTimeout, console: { error() {} }, process: { env },
    fetch: async (url, init = {}) => {
      const call = { url: String(url), ...init, json: init.body ? JSON.parse(init.body) : undefined }; calls.push(call);
      if (options.fetch) return options.fetch(call, calls);
      throw new Error("Unexpected simulated network call: " + new URL(url).pathname);
    },
  });
  function load(relative) {
    if (modules.has(relative)) return modules.get(relative).exports;
    const mod = { exports: {} }; modules.set(relative, mod);
    const requireFake = name => {
      if (name === "node:crypto") return crypto;
      if (name === "node:async_hooks") return require("node:async_hooks");
      if (name === "../server/whatsapp-core.cjs") return load("server/whatsapp-core.cjs");
      if (name === "../api/receipt.js" && options.receiptActual) return load("api/receipt.js");
      if (name === "../api/receipt.js") return { async extractSingle(image, categories) { receiptCalls.push({ image, categories: clone(categories) }); if (options.receipt) return options.receipt(image, categories); return { item: { data: "2026-10-23", descricao: "Comprovante sintético", valor: 12.34, moeda: "BRL", direcao: "enviado", categoria: "Mercado", instituicao: "" } }; } };
      throw new Error("Unexpected require: " + name);
    };
    const execute = vm.runInContext("(function(require,module,exports){\n" + fs.readFileSync(path.join(APP, relative), "utf8") + "\n})", context, { filename: relative });
    execute(requireFake, mod, mod.exports); return mod.exports;
  }
  const core = load("server/whatsapp-core.cjs");
  async function request(route, options = {}) {
    const result = { status: 0, headers: {}, body: undefined };
    const res = { setHeader(name, value) { result.headers[name.toLowerCase()] = value; }, status(code) { result.status = code; return this; }, json(value) { result.body = clone(value); return this; }, send(value) { result.body = value; return this; } };
    const raw = options.raw === undefined ? Buffer.from(JSON.stringify(options.payload || payload())) : Buffer.from(options.raw);
    const req = Object.assign(await requestStream(options.chunks || [raw], options.vercelRestored), { method: options.method || (route === "whatsapp" ? "POST" : "GET"), url: options.url || "/api/" + route,
      headers: { ...(route === "whatsapp" ? { "content-type": "application/json", "x-hub-signature-256": "sha256=" + crypto.createHmac("sha256", env.WHATSAPP_APP_SECRET || "unconfigured").update(raw).digest("hex") } : { authorization: "Bearer synthetic-owner-session" }), ...options.headers },
    });
    if (route === "whatsapp") Object.defineProperty(req, "body", { get() { throw new Error("Webhook must use signed raw bytes, never req.body"); } });
    else req.body = options.body;
    await load("api/" + route + ".js")(req, res); return result;
  }
  return { env, calls, receiptCalls, core, request };
}
function coreFetch(options = {}) {
  return async call => {
    if (call.url.endsWith("/auth/v1/user")) return response({ id: options.owner || OWNER }, options.authStatus || 200);
    if (call.url.includes("/rpc/wa_ingest")) return response(options.claim || claim());
    if (call.url.includes("generativelanguage.googleapis.com")) return response(options.provider || { candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify("parsed" in options ? options.parsed : tx()) }] } }] }, options.providerStatus || 200);
    if (call.url.includes("/rpc/wa_finish_draft")) return response({ draftId: DRAFT, status: call.json.p_error ? "error" : "draft", revision: 2 });
    if (call.url.includes("/whatsapp_inbox?")) return response(options.rows || [inbox()]);
    if (call.url.endsWith("/messages")) return response({ messages: [{ id: "out.synthetic" }] });
    throw new Error("Unexpected simulated route: " + new URL(call.url).pathname);
  };
}
const byPath = (e, match) => e.calls.filter(c => c.url.includes(match));

test("assinatura depende dos bytes exatos; webhook nunca lê req.body", async () => {
  const e = harness({ fetch: coreFetch({ claim: { accepted: false } }) });
  const raw = Buffer.from("  " + JSON.stringify(payload()) + "\n");
  const signature = "sha256=" + crypto.createHmac("sha256", e.env.WHATSAPP_APP_SECRET).update(raw).digest("hex");
  assert.equal(e.core.validSignature(raw, signature, e.env.WHATSAPP_APP_SECRET), true);
  assert.equal(e.core.validSignature(Buffer.from(raw.toString().trim()), signature, e.env.WHATSAPP_APP_SECRET), false);
  const good = await e.request("whatsapp", { raw, chunks: [raw.subarray(0, 17), raw.subarray(17)] });
  assert.equal(good.status, 200); assert.equal(byPath(e, "/rpc/wa_ingest").length, 1);
  const bad = await e.request("whatsapp", { raw: raw.toString().trim(), headers: { "x-hub-signature-256": signature } });
  assert.equal(bad.status, 401); assert.equal(e.calls.length, 1);
});

test("assinatura inválida, JSON malformado e limites de corpo recusam antes de inferência", async () => {
  for (const [options, status] of [[{ headers: { "x-hub-signature-256": "sha256=bad" } }, 401], [{ raw: "{" }, 400], [{ raw: "" }, 400], [{ raw: "x".repeat(262145) }, 413], [{ headers: { "content-length": "262145" } }, 413], [{ headers: { "content-type": "text/plain" } }, 415]]) {
    const e = harness(); assert.equal((await e.request("whatsapp", options)).status, status); assert.equal(e.calls.length, 0);
  }
});

test("webhook lê bytes restaurados pelo runtime Vercel após IncomingMessage consumido", async () => {
  const e = harness({ fetch: coreFetch({ claim: { accepted: false } }) });
  const raw = Buffer.from(" \n" + JSON.stringify(payload()) + "\n");
  const result = await e.request("whatsapp", { raw, chunks: [raw.subarray(0, 8), raw.subarray(8)], vercelRestored: true });
  assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(e.calls.length, 1);
  const mismatched = await e.request("whatsapp", { raw, vercelRestored: true, headers: { "x-hub-signature-256": "sha256=" + "0".repeat(64) } });
  assert.equal(mismatched.status, 401); assert.equal(e.calls.length, 1);
});

test("corpo interrompido ou sem término falha sem esperar indefinidamente", async () => {
  let timerCallback, cleared = 0;
  const e = harness({ setTimeout(callback, ms) { assert.equal(ms, 5000); timerCallback = callback; return 1; }, clearTimeout() { cleared++; } });
  const request = new PassThrough(); request.headers = {};
  const promise = e.core.rawBody(request); timerCallback();
  await assert.rejects(promise, error => error.code === "body_timeout" && error.status === 408); assert.equal(cleared, 1);
  for (const event of ["aborted", "error"]) {
    const request = new PassThrough(); request.headers = {};
    const promise = e.core.rawBody(request); request.emit(event, new Error("synthetic stream failure"));
    await assert.rejects(promise, error => error.status === 400);
  }
  assert.equal(e.calls.length, 0);
});

test("verificação Meta valida token e challenge sem serviços externos", async () => {
  const e = harness();
  const result = await e.request("whatsapp", { method: "GET", url: "/api/whatsapp?hub.mode=subscribe&hub.verify_token=synthetic-verify-token&hub.challenge=123456" });
  assert.equal(result.status, 200); assert.equal(result.body, "123456"); assert.equal(result.headers["cache-control"], "no-store");
  for (const query of ["hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1", "hub.mode=subscribe&hub.verify_token=synthetic-verify-token&hub.challenge=%3Cscript%3E", "hub.mode=wrong&hub.verify_token=synthetic-verify-token&hub.challenge=1"]) assert.equal((await e.request("whatsapp", { method: "GET", url: "/api/whatsapp?" + query })).status, 403);
  assert.equal((await e.request("whatsapp", { method: "DELETE" })).status, 405); assert.equal(e.calls.length, 0);
});

test("piloto incompleto não aceita webhook como pronto", async () => {
  for (const key of Object.keys(envDefaults())) {
    const e = harness({ env: { [key]: "" } });
    assert.equal((await e.request("whatsapp")).status, 503, key); assert.equal(e.calls.length, 0);
  }
});

test("orçamento absoluto esgotado impede iniciar novas chamadas externas", async () => {
  const e = harness();
  await assert.rejects(e.core.withBudget(Date.now() - 1, () => e.core.handleEvent({ phone: PHONE, sender: SENDER, message: message(), at: new Date().toISOString() })), error => error.code === "time_budget_exhausted");
  assert.equal(e.calls.length, 0);
});

test("remetente não autorizado nunca baixa mídia, chama IA, notifica ou salva", async () => {
  for (const type of ["text", "image", "document", "audio"]) {
    const e = harness({ fetch: coreFetch({ claim: { accepted: false, reason: "sender_not_allowed" } }) });
    const result = await e.request("whatsapp", { payload: payload([message({ type, [type]: type === "text" ? { body: "Mensagem sintética" } : { id: "123456789", caption: "Comprovante sintético" } })]) });
    assert.equal(result.status, 200); assert.equal(e.calls.length, 1); assert.equal(e.receiptCalls.length, 0);
    assert.deepEqual(Object.keys(e.calls[0].json).sort(), ["p_media", "p_message_at", "p_message_id", "p_message_kind", "p_message_text", "p_phone_number_id", "p_sender_e164"].sort());
    assert.equal(e.calls[0].json.p_sender_e164, SENDER);
  }
});

test("grupos, mensagens antigas/futuras e payloads estranhos não chegam ao ingest", async () => {
  const e = harness();
  const invalid = [message({ group_id: "group.synthetic" }), message({ context: { group_id: "group.synthetic" } }), message({ from: "invalid" }), message({ id: "" }), message({ timestamp: "1" }), message({ timestamp: String(Math.floor(Date.now() / 1000) + 900) })];
  assert.equal((await e.request("whatsapp", { payload: payload(invalid) })).status, 200);
  assert.equal((await e.request("whatsapp", { payload: { object: "other", entry: [] } })).status, 200); assert.equal(e.calls.length, 0);
  assert.equal((await e.request("whatsapp", { payload: payload(Array.from({ length: 101 }, (_, i) => message({ id: "synthetic." + i }))) })).status, 413); assert.equal(e.calls.length, 0);
});

test("mensagem válida produz rascunho revisável; nunca cria transação sem decisão", async () => {
  const e = harness({ fetch: coreFetch({ parsed: tx({ currency: "USDT", amount: 1.234567, dateAssumed: true }) }) });
  assert.equal((await e.request("whatsapp")).status, 200);
  const finish = byPath(e, "/rpc/wa_finish_draft")[0];
  assert.equal(finish.json.p_draft_id, DRAFT); assert.equal(finish.json.p_lease_token, LEASE);
  assert.equal(finish.json.p_transaction.currency, "USDT"); assert.equal(finish.json.p_transaction.amount, 1.234567);
  assert(finish.json.p_warnings.some(s => s.includes("Data de envio"))); assert.equal(finish.json.p_error, null);
  assert.equal(byPath(e, "/rpc/wa_decide").length, 0); assert.equal(byPath(e, "/pastas").length, 0);
  const notice = byPath(e, "/messages")[0].json;
  assert.equal(notice.recipient_type, "individual"); assert.equal(notice.to, SENDER.slice(1));
  assert.equal(notice.interactive.action.buttons[0].reply.id, `confirm:${DRAFT}:2`);
  assert.equal(notice.interactive.action.buttons[1].reply.id, `reject:${DRAFT}:2`);
  const prompt = byPath(e, "generativelanguage")[0].json.contents[0].parts[0].text;
  assert.match(prompt, /dado não confiável/); assert.match(prompt, /Não converta valores nem moedas/); assert.match(prompt, /USDT e USDC são distintos/);
});

test("duplicata durable não repete IA nem finish; item em processamento pede retry", async () => {
  const e = harness({ fetch: coreFetch({ claim: claim({ claimed: false, reason: "duplicate" }) }) });
  await e.request("whatsapp"); await e.request("whatsapp");
  assert.equal(byPath(e, "/rpc/wa_ingest").length, 2); assert.equal(byPath(e, "generativelanguage").length, 0); assert.equal(byPath(e, "/rpc/wa_finish_draft").length, 0);
  const busy = harness({ fetch: coreFetch({ claim: claim({ claimed: false, reason: "processing" }) }) });
  assert.equal((await busy.request("whatsapp")).status, 503); assert.equal(busy.calls.length, 1);
});

test("duplicata de outra origem não reenvia conteúdo privado do rascunho", async () => {
  for (const row of [inbox({ sender_e164: "+15550009999" }), inbox({ phone_number_id: "999999999999999" }), inbox({ status: "confirmed" }), inbox({ lease_token: LEASE })]) {
    const e = harness({ fetch: coreFetch({ claim: claim({ claimed: false, reason: "duplicate" }), rows: [row] }) });
    assert.equal((await e.request("whatsapp")).status, 200); assert.equal(byPath(e, "/messages").length, 0); assert.equal(byPath(e, "generativelanguage").length, 0);
  }
});

test("reentrega após notificação confirmada não envia os botões novamente", async () => {
  let notifiedRevision = 0;
  const base = coreFetch({ claim: claim({ claimed: false, reason: "duplicate" }) });
  const e = harness({ fetch: c => {
    if (c.url.includes("/whatsapp_inbox?") && c.method === "PATCH") { notifiedRevision = c.json.notified_revision; return response(null, 204); }
    if (c.url.includes("/whatsapp_inbox?")) return response([inbox({ notified_revision: notifiedRevision })]);
    return base(c);
  } });
  assert.equal((await e.request("whatsapp")).status, 200); assert.equal((await e.request("whatsapp")).status, 200);
  assert.equal(notifiedRevision, 2); assert.equal(byPath(e, "/messages").length, 1);
  assert.equal(byPath(e, "/whatsapp_inbox?").filter(c => c.method === "PATCH").length, 1);
  assert.equal(byPath(e, "generativelanguage").length, 0);
});

test("falha transitória de IA grava erro com lease antes do retry e não notifica sucesso", async () => {
  const e = harness({ fetch: coreFetch({ providerStatus: 503, provider: { error: "synthetic-private-provider-details" } }) });
  const result = await e.request("whatsapp"); assert.equal(result.status, 503);
  const finished = byPath(e, "/rpc/wa_finish_draft")[0];
  assert.equal(finished.json.p_error, "processing_unavailable"); assert.equal(finished.json.p_lease_token, LEASE);
  assert.deepEqual(finished.json.p_transaction, {}); assert.equal(byPath(e, "/messages").length, 0);
  assert(!JSON.stringify(result).includes("synthetic-private-provider-details"));
});

test("resposta IA nula vira revisão incompleta, não ciclo de retry", async () => {
  const e = harness({ fetch: coreFetch({ parsed: null, rows: [inbox({ can_confirm: false, candidate: {}, warnings: ["Informe dados completos"] })] }) });
  assert.equal((await e.request("whatsapp")).status, 200);
  assert.equal(byPath(e, "/rpc/wa_finish_draft")[0].json.p_error, null);
  assert.equal(byPath(e, "/messages")[0].json.type, "text");
});

test("validação recusa campos críticos truncados, datas impossíveis e valores não monetários", () => {
  const e = harness();
  for (const patch of [{ date: "2026-10-23garbage" }, { date: "2026-02-30" }, { date: "2026-00-23" }, { amount: "12.34" }, { amount: 0 }, { amount: -1 }, { amount: Infinity }, { amount: 0.001 }, { amount: Number.MAX_SAFE_INTEGER }, { currency: "USD?" }, { currency: "USDTjunk" }, { type: "transferência" }, { desc: "" }]) {
    const candidate = e.core.candidate(tx(patch), ["Mercado", "Outros"]);
    assert.equal(e.core.canConfirm(candidate.transaction), false, JSON.stringify(patch));
  }
  for (const currency of ["BRL", "USD", "EUR", "GBP", "CLP", "PYG", "USDT", "USDC"]) {
    const amount = ["CLP", "PYG"].includes(currency) ? 1234 : ["USDT", "USDC"].includes(currency) ? 1.123456 : 12.34;
    const valid = e.core.candidate(tx({ currency, amount }), ["Mercado"]);
    assert.equal(e.core.canConfirm(valid.transaction), true, currency); assert.equal(valid.transaction.amount, amount); assert.equal(valid.transaction.currency, currency);
  }
});

test("categoria fora da pasta recebe aviso e não inventa categoria", () => {
  const e = harness();
  const fallback = e.core.candidate(tx({ category: "Fora da lista" }), ["Mercado", "Outros"]);
  assert.equal(fallback.transaction.category, "Outros"); assert.match(fallback.warnings.join(" "), /Confira a categoria/);
  const noFallback = e.core.candidate(tx({ category: "Fora da lista" }), ["Mercado"]);
  assert.equal(noFallback.transaction.category, ""); assert.equal(e.core.canConfirm(noFallback.transaction), false);
});

test("mídia externa, maior que limite ou tipo não aceito não é baixada nem interpretada", async () => {
  const base = coreFetch();
  for (const info of [{ url: "https://evil.example/file", mime_type: "image/jpeg", file_size: 4 }, { url: "https://lookaside.fbsbx.com/file", mime_type: "text/html", file_size: 4 }, { url: "https://lookaside.fbsbx.com/file", mime_type: "image/jpeg", file_size: 3145729 }]) {
    const e = harness({ fetch: c => c.url.includes("graph.facebook.com") && !c.url.endsWith("/messages") ? response(info) : c.url.includes("/whatsapp_inbox?") ? response([inbox({ can_confirm: false, candidate: {} })]) : base(c) });
    const result = await e.request("whatsapp", { payload: payload([message({ type: "image", image: { id: "987654321", mime_type: "image/jpeg" } })]) });
    assert.equal(result.status, 200); assert.equal(e.receiptCalls.length, 0); assert.equal(e.calls.some(c => c.url === info.url), false);
    assert.deepEqual(byPath(e, "/rpc/wa_finish_draft")[0].json.p_transaction, {});
  }
});

test("mídia autorizada verifica bytes/hash e entrega comprovante ao parser existente", async () => {
  const media = Buffer.from("synthetic-image"), base = coreFetch();
  const e = harness({ fetch: c => {
    if (c.url.includes("graph.facebook.com") && !c.url.endsWith("/messages")) return response({ url: "https://lookaside.fbsbx.com/media", mime_type: "image/jpeg", file_size: media.length, sha256: crypto.createHash("sha256").update(media).digest("hex") });
    if (c.url === "https://lookaside.fbsbx.com/media") return { ok: true, body: [media.subarray(0, 3), media.subarray(3)] };
    return base(c);
  } });
  assert.equal((await e.request("whatsapp", { payload: payload([message({ type: "image", image: { id: "987654321" } })]) })).status, 200);
  assert.equal(e.receiptCalls.length, 1); assert.equal(e.receiptCalls[0].image.data, media.toString("base64"));
  assert.equal(byPath(e, "/rpc/wa_finish_draft")[0].json.p_transaction.type, "despesa");
  assert.equal(e.calls.find(c => c.url === "https://lookaside.fbsbx.com/media").redirect, "error");
});

test("mídia com hash ou quantidade de bytes divergente não chega à IA", async () => {
  const media = Buffer.from("synthetic-image"), base = coreFetch();
  for (const overrides of [{ sha256: "0".repeat(64) }, { file_size: media.length + 1 }]) {
    const e = harness({ fetch: c => {
      if (c.url.includes("graph.facebook.com") && !c.url.endsWith("/messages")) return response({ url: "https://lookaside.fbsbx.com/media", mime_type: "image/jpeg", file_size: media.length, ...overrides });
      if (c.url === "https://lookaside.fbsbx.com/media") return { ok: true, body: [media] };
      return base(c);
    } });
    assert.equal((await e.request("whatsapp", { payload: payload([message({ type: "image", image: { id: "987654321" } })]) })).status, 503);
    assert.equal(e.receiptCalls.length, 0); assert.equal(byPath(e, "/messages").length, 0);
    assert.equal(byPath(e, "/rpc/wa_finish_draft")[0].json.p_error, "processing_unavailable");
  }
});

test("tamanho de mídia aceita inteiro numérico ou string decimal canônica, sem conversão permissiva", async () => {
  const media = Buffer.from("synthetic-image"), base = coreFetch({ rows: [] });
  for (const [size, accepted] of [[media.length, true], [String(media.length), true], ["0" + media.length, false], [media.length + ".0", false], [" 14 ", false], ["+14", false], ["1.4e1", false], ["14junk", false], ["3145729", false], ["9007199254740992", false], [null, false]]) {
    const e = harness({ fetch: c => {
      if (c.url.includes("graph.facebook.com") && !c.url.endsWith("/messages")) return response({ url: "https://lookaside.fbsbx.com/media", mime_type: "image/jpeg", file_size: size });
      if (c.url === "https://lookaside.fbsbx.com/media") return { ok: true, body: [media] };
      return base(c);
    } });
    assert.equal((await e.request("whatsapp", { payload: payload([message({ type: "image", image: { id: "987654321" } })]) })).status, 200, String(size));
    assert.equal(e.receiptCalls.length, accepted ? 1 : 0, String(size));
    assert.equal(e.calls.some(c => c.url === "https://lookaside.fbsbx.com/media"), accepted, String(size));
    if (!accepted) assert.deepEqual(byPath(e, "/rpc/wa_finish_draft")[0].json.p_transaction, {});
  }
});

test("comprovante usa parser real: mantém moeda/direção e recusa fatura, moeda ou direção incerta", async () => {
  const media = Buffer.from("synthetic-image"), baseReceipt = { documento: "comprovante", data: "2026-10-23", descricao: "Operação sintética", valor: 123, moeda: "PYG", direcao: "recebido", categoria: "Mercado", instituicao: "", revisar: [] };
  for (const patch of [{}, { documento: "fatura" }, { direcao: "" }, { moeda: "" }]) {
    const base = coreFetch({ parsed: { ...baseReceipt, ...patch }, rows: [] });
    const e = harness({ receiptActual: true, fetch: c => {
      if (c.url.includes("graph.facebook.com") && !c.url.endsWith("/messages")) return response({ url: "https://lookaside.fbsbx.com/media", mime_type: "image/jpeg", file_size: media.length });
      if (c.url === "https://lookaside.fbsbx.com/media") return { ok: true, body: [media] };
      return base(c);
    } });
    assert.equal((await e.request("whatsapp", { payload: payload([message({ type: "image", image: { id: "987654321" } })]) })).status, 200);
    const finished = byPath(e, "/rpc/wa_finish_draft")[0].json;
    assert.equal(finished.p_error, null);
    if (!Object.keys(patch).length) {
      assert.equal(finished.p_transaction.amount, 123); assert.equal(finished.p_transaction.currency, "PYG"); assert.equal(finished.p_transaction.type, "receita");
    } else assert.equal(e.core.canConfirm(finished.p_transaction), false, JSON.stringify(patch));
    assert.equal(byPath(e, "/rpc/wa_decide").length, 0);
  }
});

test("resposta interativa vincula decisão ao remetente/canal da mensagem assinada", async () => {
  for (const action of ["confirm", "reject"]) {
    const e = harness({ fetch: c => c.url.includes("/rpc/wa_decide") ? response({ draftId: DRAFT, status: action === "confirm" ? "confirmed" : "rejected" }) : response({}) });
    assert.equal((await e.request("whatsapp", { payload: payload([message({ type: "interactive", interactive: { button_reply: { id: `${action}:${DRAFT}:2` } } })]) })).status, 200);
    assert.deepEqual(byPath(e, "/rpc/wa_decide")[0].json, { p_draft_id: DRAFT, p_revision: 2, p_action: action, p_phone_number_id: PHONE, p_sender_e164: SENDER });
    assert.equal(byPath(e, "generativelanguage").length, 0);
  }
});

test("decisão interativa sem permissão não responde nem revela rascunho", async () => {
  const e = harness({ fetch: () => response({ message: "actor_not_allowed" }, 400) });
  assert.equal((await e.request("whatsapp", { payload: payload([message({ type: "interactive", interactive: { button_reply: { id: `confirm:${DRAFT}:2` } } })]) })).status, 200);
  assert.equal(e.calls.length, 1);
});

test("config exige sessão autenticada; métodos não suportados não consultam conta", async () => {
  const e = harness();
  assert.equal((await e.request("whatsapp-config", { headers: { authorization: "" } })).status, 401);
  assert.equal((await e.request("whatsapp-config", { method: "DELETE" })).status, 405); assert.equal(e.calls.length, 0);
  for (const status of [401, 403, 503]) {
    const failed = harness({ fetch: () => response({ error: "synthetic-private-auth-details" }, status) });
    const result = await failed.request("whatsapp-config"); assert.equal(result.status, status === 503 ? 503 : 401); assert.equal(failed.calls.length, 1);
    assert(!JSON.stringify(result.body).includes("synthetic-private-auth-details"));
  }
});

test("config sem canal apresenta preparação sem segredo; leituras usam JWT owner com RLS", async () => {
  const e = harness({ fetch: c => c.url.endsWith("/auth/v1/user") ? response({ id: OWNER }) : response([]) });
  const result = await e.request("whatsapp-config"); assert.equal(result.status, 200);
  assert.deepEqual(result.body, { configured: false, enabled: false, channel: null, pending: [], actionsReady: false, webhookUrl: e.core.SITE + "/api/whatsapp" });
  assert.equal(result.headers["cache-control"], "no-store");
  const read = byPath(e, "/whatsapp_channels?")[0]; assert.equal(read.headers.Authorization, "Bearer synthetic-owner-session"); assert.equal(read.headers.apikey, e.core.PUBLIC_KEY);
  assert(!JSON.stringify(result.body).includes(e.env.SUPABASE_SERVICE_ROLE_KEY));
});

test("config expõe apenas campos revisáveis/máscaras e bloqueia ações enquanto canal está parado", async () => {
  const e = harness({ fetch: c => {
    if (c.url.endsWith("/auth/v1/user")) return response({ id: OWNER });
    if (c.url.includes("/whatsapp_channels?")) return response([{ phone_number_id: PHONE, folder_id: "folder123", enabled: false, allowed_senders: [SENDER], secret: "hidden-channel-secret" }]);
    if (c.url.includes("/pastas?")) return response([{ id: "folder123", name: "Pasta sintética" }]);
    if (c.url.includes("/whatsapp_inbox?")) return response([inbox(), inbox({ draft_id: OTHER, status: "error", can_confirm: false, candidate: null, lease_token: "secret-lease", message_text: "hidden-message-raw" })]);
    throw new Error("Unexpected simulated request");
  } });
  const result = await e.request("whatsapp-config"); assert.equal(result.status, 200); assert.equal(result.body.configured, true); assert.equal(result.body.enabled, false); assert.equal(result.body.actionsReady, false);
  assert.equal(new URL(byPath(e, "/pastas?")[0].url).searchParams.get("select"), "id,name:data->>name", "nome pertence ao JSON data, não a uma coluna da tabela");
  assert.equal(result.body.pending.length, 2); assert.equal(result.body.pending[1].canConfirm, false); assert.equal(result.body.pending[1].status, "pending");
  assert.equal(result.body.pending[0].revision, "2"); assert.equal(result.body.pending[0].folderName, "Pasta sintética");
  const body = JSON.stringify(result.body); for (const forbidden of [SENDER, "hidden-channel-secret", "secret-lease", "hidden-message-raw", ...Object.values(e.env)]) assert(!body.includes(forbidden), forbidden);
  for (const read of e.calls.filter(c => c.url.includes("/rest/v1/"))) assert.equal(read.headers.Authorization, "Bearer synthetic-owner-session");
});

test("POST rejeita payload transacional, revisão inválida e origem externa antes da decisão", async () => {
  const e = harness({ fetch: c => c.url.endsWith("/auth/v1/user") ? response({ id: OWNER }) : Promise.reject(new Error("Unexpected write")) });
  const valid = { action: "confirm", draftId: DRAFT, revision: "2" };
  for (const body of [{ ...valid, transaction: tx() }, { ...valid, owner: OTHER }, { ...valid, action: "save" }, { ...valid, revision: "2.5" }, { ...valid, revision: 0 }, { ...valid, draftId: "not-an-id" }, null]) assert.equal((await e.request("whatsapp-config", { method: "POST", body })).status, 400);
  assert.equal((await e.request("whatsapp-config", { method: "POST", body: valid, headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal(byPath(e, "/rpc/wa_decide").length, 0);
});

test("POST confirmação/rejeição usa identidade autenticada e decisão idempotente do servidor", async () => {
  for (const action of ["confirm", "reject"]) {
    const expected = action === "confirm" ? "confirmed" : "rejected";
    const e = harness({ fetch: c => c.url.endsWith("/auth/v1/user") ? response({ id: OWNER }) : response({ draftId: DRAFT, status: expected, transactionId: action === "confirm" ? "wa_synthetic" : null, internal: "hidden" }) });
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await e.request("whatsapp-config", { method: "POST", body: { action, draftId: DRAFT, revision: "2" }, headers: { origin: e.core.SITE } });
      assert.equal(result.status, 200); assert.deepEqual(result.body, { ok: true, draftId: DRAFT, status: expected });
    }
    for (const call of byPath(e, "/rpc/wa_decide")) {
      assert.deepEqual(call.json, { p_draft_id: DRAFT, p_revision: 2, p_action: action, p_actor_user_id: OWNER });
      assert.equal(call.headers.Authorization, "Bearer synthetic-service-role");
    }
    assert.equal(e.calls.some(c => c.url.includes("/pastas")), false, "rota delega commit atômico/idempotente ao RPC; não faz escrita direta");
  }
});

test("resposta RPC incompleta, divergente ou malformada nunca afirma sucesso na API ou WhatsApp", async () => {
  const invalidResults = [null, {}, [], "confirmed", { draftId: OTHER, status: "confirmed" }, { draftId: DRAFT, status: "rejected" }, { draftId: DRAFT, status: "unknown" }, { draftId: DRAFT }];
  for (const malformed of [...invalidResults, "invalid-json"]) {
    const rpcResponse = () => malformed === "invalid-json" ? { ok: true, status: 200, async json() { throw new SyntaxError("synthetic-private-json"); } } : response(malformed);
    const e = harness({ fetch: c => c.url.endsWith("/auth/v1/user") ? response({ id: OWNER }) : c.url.includes("/rpc/wa_decide") ? rpcResponse() : Promise.reject(new Error("Must not notify a malformed decision")) });
    const result = await e.request("whatsapp-config", { method: "POST", body: { action: "confirm", draftId: DRAFT, revision: 2 } });
    assert.equal(result.status, 503, JSON.stringify(malformed)); assert.equal(result.body.ok, undefined); assert.equal(result.body.error, "invalid_database_response");
    const webhook = await e.request("whatsapp", { payload: payload([message({ type: "interactive", interactive: { button_reply: { id: `confirm:${DRAFT}:2` } } })]) });
    assert.equal(webhook.status, 503); assert.equal(webhook.body.ok, false); assert.equal(byPath(e, "/messages").length, 0);
  }
});

test("RPC rejeita dono incorreto/revisão vencida e não vaza erro privado de banco", async () => {
  for (const [code, expected] of [["actor_not_allowed", 403], ["draft_revision_conflict", 409], ["draft_not_ready", 409], ["synthetic-private-database-detail", 503]]) {
    const e = harness({ fetch: c => c.url.endsWith("/auth/v1/user") ? response({ id: OTHER }) : response({ message: code }, 400) });
    const result = await e.request("whatsapp-config", { method: "POST", body: { action: "confirm", draftId: DRAFT, revision: 2 } });
    assert.equal(result.status, expected); assert.equal(result.body.ok, undefined);
    assert.equal(byPath(e, "/rpc/wa_decide")[0].json.p_actor_user_id, OTHER);
    assert(!JSON.stringify(result.body).includes("synthetic-private"));
  }
});

test("URL de mídia não aceita redirect, credenciais, host parecido ou HTTP", () => {
  const e = harness();
  for (const url of ["http://lookaside.fbsbx.com/a", "https://fbsbx.com.evil.example/a", "https://user:pass@fbsbx.com/a", "https://fbsbx.com:8443/a", "file:///a", "not-url"]) assert.equal(e.core.mediaURL(url), false, url);
  for (const url of ["https://lookaside.fbsbx.com/a", "https://media.whatsapp.net/a", "https://scontent.fbcdn.net/a"]) assert.equal(e.core.mediaURL(url), true, url);
});
