"use strict";
// Contract tests against synthetic Responses payloads. No real credentials/network.
// https://developers.openai.com/api/docs/guides/structured-outputs
// https://developers.openai.com/api/docs/guides/file-inputs
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const SOURCE = fs.readFileSync(path.join(__dirname, "../api/receipt.js"), "utf8");
const SECRET = "synthetic-openai-secret-never-return";
const SESSION = "synthetic-user-session-never-forward";
const plain = value => JSON.parse(JSON.stringify(value));
const line = (extra = {}) => ({ data: "2026-10-26", descricao: "Compra sintética", valor: 12.5, moeda: "BRL", tipo: "despesa", categoria: "Outros", parcela: "", fixa: false, referencia: "REF-123", evidencia: "26/10/2026 Compra 12,50", pagina: 1, instituicao: "Conta sintética", incertezas: [], ...extra });
const document = (extra = {}) => ({ cartao: "Conta sintética", itens: [line()], coverage: { pagesRead: [1, 2], unreadablePages: [], complete: true }, ...extra });
const single = (extra = {}) => ({ ...line(), documento: "comprovante", direcao: "enviado", ...extra });
function completed(payload = document(), extra = {}) {
  return { status: "completed", output: [
    { type: "reasoning", summary: [{ type: "summary_text", text: "not a financial output" }] },
    { type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: typeof payload === "string" ? payload : JSON.stringify(payload) }] },
  ], ...extra };
}

function harness(providerBody = completed(), options = {}) {
  const calls = [], timers = [], logs = [];
  const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const context = vm.createContext({
    require: require('node:module').createRequire(path.join(__dirname, '../api/receipt.js')),
    module: { exports: {} },
    process: { env: { OPENAI_API_KEY: SECRET, GEMINI_API_KEY: "synthetic-gemini", ANTHROPIC_API_KEY: "synthetic-anthropic", ...options.env } },
    AbortSignal: { timeout: ms => { timers.push(ms); return { timeout: ms }; } },
    console: { error: (...args) => logs.push(args), warn: (...args) => logs.push(args) },
    setTimeout: callback => { callback(); return 1; },
    fetch: async (url, init = {}) => {
      calls.push({ url, init });
      if (url.includes("/auth/v1/user")) {
        if (options.authError) throw options.authError;
        return reply({ id: "synthetic-user" }, options.authStatus || 200);
      }
      assert.equal(url, "https://api.openai.com/v1/responses", "never fall back to a second provider");
      if (options.error) throw options.error;
      if (options.invalidJSON) return { ok: true, status: 200, json: async () => { throw new SyntaxError("synthetic private body"); } };
      return reply(providerBody, options.status || 200);
    },
  });
  vm.runInContext(SOURCE, context);
  return {
    calls, timers, logs,
    extractSingle: (...args) => context.module.exports.extractSingle(...args),
    async request(body = {}, request = {}) {
      const result = { status: 0, body: null, headers: {} };
      const res = { setHeader(k, v) { result.headers[k] = v; }, status(code) { result.status = code; return this; }, json(value) { result.body = plain(value); } };
      await context.module.exports({ method: "POST", headers: { authorization: "Bearer " + SESSION }, body: {
        image: { media_type: "application/pdf", data: "aGVsbG8=" }, multi: true,
        documentContext: { pageStart: 5, pageEnd: 6, totalPages: 10 },
        categories: ["Outros", "Alimentação"], cards: ["Conta sintética"], ...body,
      }, ...request }, res);
      return result;
    },
  };
}

function strictObjects(schema) {
  assert.equal(schema.type, schema.type.toLowerCase());
  if (schema.type === "object") {
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort(), "every property is required by strict schema");
    Object.values(schema.properties).forEach(strictObjects);
  }
  if (schema.items) strictObjects(schema.items);
}

test('rota de comprovantes reconhece alias e não troca Ugly Cash pelo destinatário Ether.fi', async () => {
  const env=harness(completed(document({cartao:'uglycash',itens:[line({instituicao:'Ether.fi'})]})));
  const result=await env.request({cards:['Ugly Cash','Ether.fi']});
  assert.equal(result.status,200); assert.equal(result.body.cartao,'Ugly Cash'); assert.equal(result.body.itens[0].instituicao,'Ugly Cash');
  const singleEnv=harness(completed(single({instituicao:'Ueno Bank'})));
  const singleResult=await singleEnv.request({multi:false});
  assert.equal(singleResult.status,200); assert.equal(singleResult.body.instituicao,'Ueno');
  assert.match(JSON.stringify(env.calls),/Actividad/);
});

test("OpenAI tem prioridade, PDF usa Responses e schema estrito com cobertura/evidência", async () => {
  const h = harness();
  const result = await h.request();
  assert.equal(result.status, 200); assert.equal(result.body.partial, false);
  assert.equal(result.body.provider, "openai"); assert.equal(result.body.model, "gpt-6.1-terra");
  assert.equal(h.calls.length, 2);
  const auth = h.calls[0], call = h.calls[1], sent = JSON.parse(call.init.body);
  assert.equal(auth.init.headers.Authorization, "Bearer " + SESSION);
  assert.equal(call.init.headers.Authorization, "Bearer " + SECRET);
  assert.equal(call.init.redirect, "error");
  assert.equal(sent.model, "gpt-6.1-terra"); assert.equal(sent.store, false);
  assert.deepEqual(sent.reasoning, { effort: "low" });
  assert.equal(sent.max_output_tokens, 16384);
  assert.deepEqual(sent.input[0].content[0], { type: "input_file", filename: "documento.pdf", file_data: "data:application/pdf;base64,aGVsbG8=" });
  assert.equal(sent.input[0].content[1].type, "input_text");
  assert.equal(sent.text.format.type, "json_schema"); assert.equal(sent.text.format.strict, true);
  strictObjects(sent.text.format.schema);
  assert(sent.text.format.schema.required.includes("coverage"));
  for (const field of ["referencia", "evidencia", "pagina", "instituicao", "incertezas"]) assert(sent.text.format.schema.properties.itens.items.required.includes(field));
  assert.match(sent.instructions, /posições 5 a 6 de 10/);
  assert.match(sent.instructions, /posição LOCAL 1\.\.2/);
  assert.equal(sent.tools, undefined); assert.equal(sent.previous_response_id, undefined);
  assert.equal(sent.temperature, undefined);
  assert(!call.init.body.includes(SECRET)); assert(!call.init.body.includes(SESSION));
  assert.deepEqual(h.timers, [8000, 45000]);
});

test("segredo existente no projeto é aceito, com prioridade do nome padrão", async () => {
  const h = harness(completed(), { env: { OPENAI_API_KEY: "", OPENAI_KEYZAO: SECRET } });
  const result = await h.request();
  assert.equal(result.status, 200);
  assert.equal(result.body.provider, "openai");
  assert.equal(h.calls[1].init.headers.Authorization, "Bearer " + SECRET);
  assert(!JSON.stringify(result).includes(SECRET));
  const canonical = harness(completed(), { env: { OPENAI_KEYZAO: "unused-alias" } });
  assert.equal((await canonical.request()).status, 200);
  assert.equal(canonical.calls[1].init.headers.Authorization, "Bearer " + SECRET);
});

test("imagem usa input_image high, comprovante mantém schema simples e limite menor", async () => {
  const h = harness(completed(single()));
  const result = await h.request({ multi: false, documentContext: null, image: { media_type: "image/jpeg", data: "aGVsbG8=" } });
  assert.equal(result.status, 200); assert.equal(result.body.valor, 12.5);
  const sent = JSON.parse(h.calls[1].init.body);
  assert.deepEqual(sent.input[0].content[0], { type: "input_image", image_url: "data:image/jpeg;base64,aGVsbG8=", detail: "high" });
  assert.equal(sent.max_output_tokens, 4096);
  assert.equal(sent.text.format.schema.properties.coverage, undefined);
  strictObjects(sent.text.format.schema);
});

test("reasoning e tool output não viram transações e duas linhas legítimas iguais sobrevivem", async () => {
  const data = completed(document({ itens: [line(), line({ referencia: "REF-456" })] }));
  data.output.unshift({ type: "function_call", arguments: JSON.stringify(line({ valor: 999 })) });
  const { body } = await harness(data).request();
  assert.deepEqual(body.itens.map(item => [item.valor, item.referencia]), [[12.5, "REF-123"], [12.5, "REF-456"]]);
  assert.equal(body.partial, false);
});

test("incomplete com JSON fechado nunca afirma cobertura integral nem aceita comprovante único", async () => {
  for (const messageOnly of [false, true]) {
    const data = completed();
    if (messageOnly) data.output[1].status = "incomplete";
    else { data.status = "incomplete"; data.incomplete_details = { reason: "max_output_tokens" }; }
    const result = await harness(data).request();
    assert.equal(result.status, 200); assert.equal(result.body.itens.length, 1);
    assert.equal(result.body.partial, true); assert.equal(result.body.coverage.complete, false);
    assert.match(result.body.avisos.join(" "), /Leitura parcial/);
  }
  const result = await harness(completed(single(), { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } })).request({ multi: false, documentContext: null });
  assert.equal(result.status, 502); assert.equal(result.body.error, "resposta_invalida");
});

test("JSON truncado recupera apenas objetos fechados e exige revisão parcial", async () => {
  const text = '{"cartao":"Conta sintética","itens":[' + JSON.stringify(line()) + ',{"descricao":"cortado","valor":';
  const result = await harness(completed(text, { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } })).request();
  assert.equal(result.status, 200); assert.equal(result.body.itens.length, 1);
  assert.equal(result.body.partial, true); assert.equal(result.body.coverage.complete, false);
});

test("refusal e content_filter impedem aproveitar até texto aparentemente válido", async () => {
  const refusal = completed();
  refusal.output[1].content.push({ type: "refusal", refusal: "synthetic private refusal" });
  for (const payload of [refusal, completed(document(), { status: "incomplete", incomplete_details: { reason: "content_filter" } })]) {
    const result = await harness(payload).request();
    assert.equal(result.status, 200); assert.deepEqual(result.body, { error: "refusal" });
  }
});

test("resposta failed, pendente, sem output ou sem texto é rejeitada sem fallback", async () => {
  const invalid = [null, {}, { status: "completed", output: [] }, { status: "completed", output_text: JSON.stringify(document()) },
    ...["failed", "queued", "in_progress", "cancelled", undefined].map(status => completed(document(), { status }))];
  for (const payload of invalid) {
    const h = harness(payload), result = await h.request();
    assert.equal(result.status, 502); assert.equal(result.body.error, "resposta_invalida");
    assert.equal(h.calls.length, 2);
  }
  const result = await harness(null, { invalidJSON: true }).request();
  assert.equal(result.status, 502); assert.equal(result.body.error, "resposta_invalida");
});

test("schema externo não dispensa validar páginas, precisão monetária e campos ausentes", async () => {
  const h = harness(completed(document({ itens: [line(), null, line({ moeda: "USDT", valor: 0.0000001 }), line({ pagina: 4, data: "2026-02-31", categoria: "Inventada" })] })));
  const result = await h.request();
  assert.equal(result.status, 200); assert.equal(result.body.itens.length, 2);
  assert.equal(result.body.partial, true); assert.equal(result.body.coverage.complete, false);
  assert.equal(result.body.itens[1].data, ""); assert.equal(result.body.itens[1].categoria, "Outros");
  assert.equal(result.body.itens[1].pagina, undefined); assert(result.body.itens[1].revisar.length >= 3);
});

test("saldo esgotado, chave inválida, rate limit e sobrecarga têm diagnósticos separados", async () => {
  for (const [status, code, expectedStatus, expectedError] of [
    [429, "insufficient_quota", 503, "saldo_ia"], [401, "invalid_api_key", 503, "configuracao_ia"],
    [403, "permission_denied", 503, "configuracao_ia"], [429, "rate_limit_exceeded", 429, "limite_ia"],
    [500, "server_error", 503, "sobrecarga_ia"], [503, "server_error", 503, "sobrecarga_ia"],
    [400, "invalid_json_schema", 502, "ia_falhou"],
  ]) {
    const h = harness({ error: { code, message: SECRET + " private provider details" } }, { status });
    const result = await h.request();
    assert.equal(result.status, expectedStatus); assert.equal(result.body.error, expectedError);
    assert(!JSON.stringify(result).includes(SECRET)); assert(!JSON.stringify(h.logs).includes(SECRET));
    assert.equal(h.calls.length, 2, "no schema downgrade, retry or provider fallback");
  }
});

test("timeout e falha de conexão não expõem corpo, chave ou sessão", async () => {
  for (const [name, code, status] of [["TimeoutError", "tempo_ia", 503], ["AbortError", "tempo_ia", 503], ["TypeError", "conexao", 502]]) {
    const error = Object.assign(new Error(SECRET + SESSION), { name });
    const h = harness(null, { error }), result = await h.request();
    assert.equal(result.status, status); assert.equal(result.body.error, code);
    assert(!JSON.stringify(result).includes(SECRET)); assert(!JSON.stringify(result).includes(SESSION));
    assert.equal(h.calls.length, 2);
  }
});

test("autorização da sessão precede IA e sua credencial não segue para OpenAI", async () => {
  const missing = harness();
  assert.equal((await missing.request({}, { headers: {} })).body.error, "sem_login");
  assert.equal(missing.calls.length, 0);
  for (const options of [{ authStatus: 401 }, { authStatus: 500 }, { authError: new Error("synthetic auth failure") }]) {
    const h = harness(completed(), options), result = await h.request();
    assert.equal(result.body.error, options.authStatus === 401 ? "login_invalido" : "auth_indisponivel");
    assert.equal(h.calls.length, 1); assert(!JSON.stringify(result).includes(SECRET));
  }
});

test("GET revela somente configuração pública e nunca chama provedor", async () => {
  const h = harness();
  const result = await h.request({}, { method: "GET" });
  assert.deepEqual(result.body, { ok: true, configured: true, provider: "openai", model: "gpt-6.1-terra", paginated: true });
  assert.equal(result.headers["Cache-Control"], "no-store"); assert.equal(h.calls.length, 0);
  assert(!JSON.stringify(result).includes(SECRET));
  const empty = await harness(null, { env: { OPENAI_API_KEY: "", GEMINI_API_KEY: "", ANTHROPIC_API_KEY: "" } }).request({}, { method: "GET" });
  assert.equal(empty.body.configured, false); assert.equal(empty.body.provider, null);
});

test("entrada inválida não consome chamada OpenAI", async () => {
  for (const body of [
    { image: { media_type: "image/jpeg", data: "invalid*" } },
    { image: { media_type: "text/plain", data: "aGVsbG8=" } },
    { documentContext: { pageStart: 1, pageEnd: 3, totalPages: 3 } },
    { documentContext: { pageStart: 1, pageEnd: 1, totalPages: 121 } },
  ]) {
    const h = harness(), result = await h.request(body);
    assert.equal(result.status, 400); assert.equal(h.calls.length, 1);
  }
});

test("WhatsApp reutiliza OpenAI com prazo recebido e mantém comprovante para confirmação", async () => {
  const h = harness(completed(single({ data: "", incertezas: ["Data não legível"] })));
  const result = await h.extractSingle({ media_type: "image/png", data: "aGVsbG8=" }, ["Outros"], 17000);
  assert.equal(result.item.valor, 12.5); assert.equal(result.item.data, ""); assert(result.item.revisar.length);
  assert.equal(h.calls.length, 1); assert.deepEqual(h.timers, [17000]);
  const sent = JSON.parse(h.calls[0].init.body);
  assert.equal(sent.store, false); assert.equal(sent.max_output_tokens, 4096);
});

test("WhatsApp não aceita extração incompleta, recusada ou fatura como gasto individual", async () => {
  const image = { media_type: "image/jpeg", data: "aGVsbG8=" };
  for (const data of [completed(single(), { status: "incomplete" }), { status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] }]) {
    await assert.rejects(harness(data).extractSingle(image, ["Outros"]), /receipt_unavailable/);
  }
  const result = await harness(completed(single({ documento: "fatura" }))).extractSingle(image, ["Outros"]);
  assert.equal(result.item, null); assert.match(result.warning, /comprovante individual/);
});
