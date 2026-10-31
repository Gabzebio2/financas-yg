"use strict";
// Synthetic provider responses only: no network, credentials or personal files.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const SOURCE = fs.readFileSync(path.join(__dirname, "../api/receipt.js"), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));
const line = (extra = {}) => ({ data: "2026-10-26", descricao: "Café sintético", valor: 12.5, moeda: "BRL", tipo: "despesa", categoria: "Alimentação", parcela: "", fixa: false, referencia: "", evidencia: "26/10/2026 Café sintético 12,50", pagina: 1, instituicao: "Conta sintética", incertezas: [], ...extra });
const coverage = (extra = {}) => ({ pagesRead: [1, 2], unreadablePages: [], complete: true, ...extra });
const document = (extra = {}) => ({ cartao: "Conta sintética", itens: [line()], coverage: coverage(), ...extra });
const context = (extra = {}) => ({ pageStart: 5, pageEnd: 6, totalPages: 10, ...extra });
const single = (extra = {}) => ({ ...line(), documento: "comprovante", direcao: "enviado", ...extra });

function harness(payload, options = {}) {
  const calls = [], provider = options.provider || "gemini";
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  const response = (body, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
  const environment = vm.createContext({ module: { exports: {} }, console: { error() {} }, AbortSignal,
    require: require('node:module').createRequire(path.join(__dirname, '../api/receipt.js')),
    setTimeout: callback => { callback(); return 1; },
    process: { env: provider === "gemini" ? { GEMINI_API_KEY: "synthetic-gemini-secret" } : { ANTHROPIC_API_KEY: "synthetic-anthropic-secret" } },
    fetch: async (url, init = {}) => {
      calls.push({ url, init });
      if (url.includes("/auth/v1/user")) return response({ id: "synthetic-user" });
      if (options.providerStatus) return response({ error: { message: "synthetic-private-provider-detail" } }, options.providerStatus);
      if (provider === "gemini") return response({ candidates: [{ finishReason: options.truncated ? "MAX_TOKENS" : "STOP", content: { parts: [{ text }] } }] });
      return response({ stop_reason: options.truncated ? "max_tokens" : "end_turn", content: [{ type: "text", text }] });
    },
  });
  vm.runInContext(SOURCE, environment);
  return {
    calls,
    extractSingle: (...args) => environment.module.exports.extractSingle(...args),
    async request(overrides = {}, method = "POST") {
      const result = { status: 0, body: null, headers: {} };
      const res = { setHeader(k,v) { result.headers[k] = v; }, status(code) { result.status = code; return this; }, json(body) { result.body = plain(body); } };
      await environment.module.exports({ method, headers: { authorization: "Bearer synthetic-session" }, body: {
        image: { media_type: "application/pdf", data: "aGVsbG8=" }, multi: true,
        categories: ["Alimentação", "Outros"], cards: ["Conta sintética"], documentContext: context(), ...overrides,
      } }, res);
      return result;
    },
  };
}

test("Gemini fixo e Anthropic exigem evidência e cobertura no schema; páginas são locais", async () => {
  for (const provider of ["gemini", "anthropic"]) {
    const env = harness(document(), { provider });
    assert.equal((await env.request()).status, 200);
    const sent = JSON.parse(env.calls[1].init.body);
    const schema = provider === "gemini" ? sent.generationConfig.responseSchema : sent.output_config.format.schema;
    assert(schema.required.includes("coverage"));
    for (const key of ["referencia", "evidencia", "pagina", "instituicao", "incertezas"]) assert(schema.properties.itens.items.required.includes(key), key);
    assert.deepEqual(schema.properties.coverage.required, ["pagesRead", "unreadablePages", "complete"]);
    const prompt = provider === "gemini" ? sent.contents[0].parts[1].text : sent.messages[0].content[1].text;
    assert.match(prompt, /posições 5 a 6 de 10/);
    assert.match(prompt, /posição LOCAL 1\.\.2/);
    if (provider === "gemini") {
      assert.match(env.calls[1].url, /\/gemini-3\.8-flash:generateContent$/);
      assert.equal(sent.generationConfig.mediaResolution, "MEDIA_RESOLUTION_MEDIUM");
      assert.equal(sent.generationConfig.temperature, undefined);
      assert.equal(env.calls[1].init.redirect, "error");
    } else {
      assert.equal(sent.messages[0].content[0].type, "document");
      assert.equal(schema.additionalProperties, false);
      assert.equal(schema.properties.itens.items.additionalProperties, false);
      assert.equal(schema.properties.coverage.additionalProperties, false);
      assert.equal(schema.properties.coverage.properties.complete.type, "boolean");
    }
  }
});

test("fotos usam resolução alta sem modificar o conteúdo do arquivo", async () => {
  const env = harness(document());
  await env.request({ image: { media_type: "image/jpeg", data: "aGVsbG8=" } });
  const sent = JSON.parse(env.calls[1].init.body);
  assert.equal(sent.generationConfig.mediaResolution, "MEDIA_RESOLUTION_HIGH");
  assert.deepEqual(sent.contents[0].parts[0].inlineData, { mimeType: "image/jpeg", data: "aGVsbG8=" });
});

test("duas páginas integralmente lidas confirmam somente o trecho enviado", async () => {
  const { status, body } = await harness(document({ itens: [line(), line({ pagina: 2, valor: 15 })] })).request();
  assert.equal(status, 200);
  assert.equal(body.partial, false);
  assert.deepEqual(body.coverage, coverage());
  assert.deepEqual(body.itens.map(i => i.pagina), [1, 2]);
});

test("STOP com uma página omitida preserva itens e informa leitura parcial", async () => {
  const { status, body } = await harness(document({ coverage: coverage({ pagesRead: [1] }) })).request();
  assert.equal(status, 200);
  assert.equal(body.itens.length, 1);
  assert.equal(body.partial, true);
  assert.equal(body.coverage.complete, false);
  assert.match(body.avisos.join(" "), /Cobertura incompleta/);
});

test("páginas negativas, fracionárias, externas ou impressas nunca comprovam cobertura", async () => {
  for (const wrong of [0, -1, 1.5, 3, 5, "2"]) {
    const { status, body } = await harness(document({ coverage: coverage({ pagesRead: [1, 2, wrong] }) })).request();
    assert.equal(status, 200, String(wrong));
    assert.equal(body.partial, true, String(wrong));
    assert.equal(body.coverage.complete, false);
    assert.deepEqual(body.coverage.pagesRead, [1, 2]);
  }
});

test("origem fora do trecho é removida e marcada para revisão sem perder a operação", async () => {
  const { status, body } = await harness(document({ itens: [line({ pagina: 5 })] })).request();
  assert.equal(status, 200);
  assert.equal(body.itens.length, 1);
  assert.equal(body.itens[0].pagina, undefined);
  assert.match(body.itens[0].revisar.join(" "), /Página de origem inválida/);
  assert.equal(body.partial, true);
});

test("itens em página não declarada como lida invalidam a cobertura", async () => {
  const { body } = await harness(document({ itens: [line({ pagina: 2 })], coverage: coverage({ pagesRead: [1] }) })).request();
  assert.equal(body.partial, true);
  assert.equal(body.coverage.complete, false);
});

test("página ilegível contradiz complete:true, inclusive quando não tem operações", async () => {
  const { status, body } = await harness(document({ coverage: coverage({ unreadablePages: [2] }) })).request();
  assert.equal(status, 200);
  assert.equal(body.partial, true);
  assert.deepEqual(body.coverage.unreadablePages, [2]);
  assert.equal(body.coverage.complete, false);
});

test("JSON completo não encobre MAX_TOKENS em nenhum provedor", async () => {
  for (const provider of ["gemini", "anthropic"]) {
    const { status, body } = await harness(document(), { provider, truncated: true }).request();
    assert.equal(status, 200);
    assert.equal(body.itens.length, 1);
    assert.equal(body.partial, true);
    assert.equal(body.coverage.complete, false);
  }
});

test("JSON cortado recupera apenas a linha fechada e não fabrica cobertura", async () => {
  const text = '{"itens":[' + JSON.stringify(line({ descricao: 'Café {sintético} "A"' })) + ',{"valor":';
  const { status, body } = await harness(text, { truncated: true }).request();
  assert.equal(status, 200);
  assert.equal(body.itens.length, 1);
  assert.equal(body.itens[0].descricao, 'Café {sintético} "A"');
  assert.equal(body.partial, true);
  assert.deepEqual(body.coverage, { pagesRead: [], unreadablePages: [], complete: false });
});

test("contexto inválido falha antes da IA; somente uma ou duas páginas até o limite120", async () => {
  const invalid = [false, [], "1", {}, context({ pageStart: 0 }), context({ pageStart: "5" }), context({ pageStart: 5.5 }),
    context({ pageStart: 7 }), context({ pageEnd: 7 }), context({ pageEnd: 11 }), context({ totalPages: 121 }), context({ totalPages: Number.MAX_SAFE_INTEGER + 1 })];
  for (const documentContext of invalid) {
    const env = harness(document());
    const result = await env.request({ documentContext });
    assert.equal(result.status, 400, JSON.stringify(documentContext));
    assert.equal(result.body.error, "paginas_invalidas");
    assert.equal(env.calls.length, 1);
  }
  const result = await harness(document({ coverage: coverage({ pagesRead: [1] }) })).request({ documentContext: context({ pageStart: 120, pageEnd: 120, totalPages: 120 }) });
  assert.equal(result.status, 200);
  assert.equal(result.body.partial, false);
});

test("cliente legado sem contexto mantém compatibilidade sem inventar cobertura", async () => {
  const payload = { cartao: "", itens: [line({ pagina: undefined })] };
  const { status, body } = await harness(payload).request({ documentContext: undefined });
  assert.equal(status, 200);
  assert.equal(body.itens.length, 1);
  assert.equal(body.partial, false);
  assert.equal(body.coverage.complete, false);
});

test("linha null não derruba outras linhas válidas nem é anunciada como completa", async () => {
  const { status, body } = await harness(document({ itens: [null, line()] })).request();
  assert.equal(status, 200);
  assert.equal(body.itens.length, 1);
  assert.equal(body.partial, true);
  assert.equal(body.coverage.complete, false);
  assert.match(body.avisos.join(" "), /1 linha\(s\) não incluída/);
});

test("item sem página no contrato paginado não pode confirmar cobertura completa", async () => {
  const { status, body } = await harness(document({ itens: [line({ pagina: undefined })] })).request();
  assert.equal(status, 200);
  assert.equal(body.itens.length, 1);
  assert.equal(body.partial, true);
  assert.equal(body.coverage.complete, false);
});

test("ambiguidades preservam campos vazios e evidência literal limitada sem inventar instituição", async () => {
  const long = "x".repeat(300);
  const { status, body } = await harness(document({ itens: [line({ data: "2026-02-31", categoria: "Inventada", instituicao: "", referencia: long,
    evidencia: '<img src=x onerror="alert(1)">' + long, incertezas: ["Ano ilegível", false, long, ...Array(8).fill("Conferir")] })] })).request();
  assert.equal(status, 200);
  const item = body.itens[0];
  assert.equal(item.data, "");
  assert.equal(item.categoria, "Outros");
  assert.equal(item.instituicao, undefined);
  assert.equal(item.referencia.length, 120);
  assert.equal(item.evidencia.length, 180);
  assert.match(item.evidencia, /^<img/);
  assert(item.revisar.includes("Ano ilegível"));
  assert(item.revisar.every(v => typeof v === "string" && v.length <= 160));
});

test("duas compras reais idênticas continuam duas linhas distintas com suas evidências", async () => {
  const a = line({ referencia: "NSU-sintetico-A", evidencia: "Compra A 12,50" });
  const b = line({ referencia: "NSU-sintetico-B", evidencia: "Compra B 12,50", pagina: 2 });
  const { status, body } = await harness(document({ itens: [a, b] })).request();
  assert.equal(status, 200);
  assert.equal(body.partial, false);
  assert.equal(body.itens.length, 2);
  assert.deepEqual(body.itens.map(i => i.referencia), [a.referencia, b.referencia]);
  assert.deepEqual(body.itens.map(i => i.valor), [12.5, 12.5]);
});

test("linha financeira inválida não deixa coverage completa após a exclusão", async () => {
  const { status, body } = await harness(document({ itens: [line(), line({ moeda: "", pagina: 2 })] })).request();
  assert.equal(status, 200);
  assert.equal(body.itens.length, 1);
  assert.equal(body.partial, true);
  assert.equal(body.coverage.complete, false);
});

test("páginas vazias integralmente lidas diferem de páginas que não foram lidas", async () => {
  const complete = await harness(document({ itens: [] })).request();
  assert.equal(complete.status, 200);
  assert.deepEqual(complete.body.itens, []);
  assert.equal(complete.body.partial, false);
  const missing = await harness(document({ itens: [], coverage: coverage({ pagesRead: [1] }) })).request();
  assert.equal(missing.status, 502);
  assert.equal(missing.body.error, "resposta_invalida");
  assert.equal(missing.body.coverage.complete, false);
});

test("erro400 do Gemini não repete sem schema nem expõe detalhes privados", async () => {
  const env = harness(document(), { providerStatus: 400 });
  const result = await env.request();
  assert.equal(result.status, 502);
  assert.equal(env.calls.length, 2);
  assert.equal(result.body.error, "ia_falhou");
  assert.equal(result.body.detail, undefined);
  assert.doesNotMatch(JSON.stringify(result.body), /synthetic-private|secret/);
});

test("metadata pública descreve modelo e paginação, sem chave nem chamada externa", async () => {
  const env = harness(document());
  const result = await env.request({}, "GET");
  assert.equal(result.status, 200);
  assert.equal(result.body.model, "gemini-3.8-flash");
  assert.equal(result.body.paginated, true);
  assert.equal(result.headers["Cache-Control"], "no-store");
  assert.equal(env.calls.length, 0);
  assert.doesNotMatch(JSON.stringify(result.body), /synthetic-|secret/);
});

test("extractSingle do WhatsApp preserva contrato e avisos sem contexto paginado", async () => {
  for (const provider of ["gemini", "anthropic"]) {
    const env = harness(single({ incertezas: ["Confira a instituição"] }), { provider });
    const result = plain(await env.extractSingle({ media_type: "image/jpeg", data: "aGVsbG8=" }, ["Alimentação", "Outros"], 18000));
    assert.equal(result.item.valor, 12.5);
    assert.equal(result.item.direcao, "enviado");
    assert.equal(result.item.instituicao, "Conta sintética");
    assert.deepEqual(result.item.revisar, ["Confira a instituição"]);
    assert.equal(env.calls.length, 1);
    assert(!env.calls[0].url.includes("/auth/"));
    const sent = JSON.parse(env.calls[0].init.body);
    const schema = provider === "gemini" ? sent.generationConfig.responseSchema : sent.output_config.format.schema;
    assert.equal(schema.properties.coverage, undefined);
  }
});

test("WhatsApp recusa fatura e resposta truncada mesmo com JSON íntegro", async () => {
  const invoice = harness(single({ documento: "fatura" }));
  assert.equal((await invoice.extractSingle({ media_type: "image/jpeg", data: "aGVsbG8=" }, ["Alimentação"])).item, null);
  const truncated = harness(single(), { truncated: true });
  await assert.rejects(truncated.extractSingle({ media_type: "image/jpeg", data: "aGVsbG8=" }, ["Alimentação"]), /receipt_unavailable/);
});
