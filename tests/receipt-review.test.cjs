"use strict";
// Independent audit contract. All documents, credentials and network replies are synthetic.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const SOURCE = fs.readFileSync(path.join(__dirname, "../api/receipt.js"), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));
const line = (extra = {}) => ({ data: "2026-10-26", descricao: "Compra sintética", valor: 12.5, moeda: "BRL", tipo: "despesa", categoria: "Outros", parcela: "", fixa: false, referencia: "REF-123", evidencia: "26/10/2026 Compra 12,50", pagina: 1, instituicao: "Conta sintética", ...extra });
const first = (itens = [line()], extra = {}) => ({ itens, cartao: "Conta sintética", coverage: { pagesRead: [1, 2], unreadablePages: [], complete: true }, partial: false, ...extra });
const second = (itens = [line()], extra = {}) => ({ itens, cartao: "Conta sintética", coverage: { pagesRead: [1, 2], unreadablePages: [], complete: true }, auditIssues: [], ...extra });
const completed = (data = second(), extra = {}) => ({ status: "completed", output: [{ type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: typeof data === "string" ? data : JSON.stringify(data) }] }], ...extra });
function harness(data = second(), options = {}) {
  const calls = [], timers = [];
  const context = vm.createContext({
    module: { exports: {} }, console: { error() {}, warn() {} },
    process: { env: { OPENAI_API_KEY: "synthetic-secret", ...options.env } },
    AbortSignal: { timeout: ms => { timers.push(ms); return {}; } },
    setTimeout: callback => { callback(); return 1; },
    fetch: async (url, init = {}) => {
      calls.push({ url, init });
      if (url.includes("/auth/v1/user")) return { ok: !options.authStatus, status: options.authStatus || 200 };
      assert.equal(url, "https://api.openai.com/v1/responses");
      if (options.error) throw options.error;
      const status = options.status || 200;
      return { ok: status < 400, status, json: async () => options.response || completed(data, options.completion) };
    },
  });
  vm.runInContext(SOURCE, context);
  return { calls, timers, async request(snapshot = first(), extra = {}, headers = { authorization: "Bearer synthetic-session" }) {
    const result = { status: 0, body: null, headers: {} };
    const res = { setHeader(k,v) { result.headers[k] = v; }, status(code) { result.status = code; return this; }, json(value) { result.body = plain(value); } };
    await context.module.exports({ method: "POST", headers, body: {
      image: { media_type: "application/pdf", data: "aGVsbG8=" }, multi: true,
      documentContext: { pageStart: 5, pageEnd: 6, totalPages: 10 },
      categories: ["Outros", "Alimentação"], cards: ["Conta sintética", "Outra conta"], reviewOf: snapshot, ...extra,
    } }, res);
    return result;
  } };
}
function verified(result, count = 1) {
  assert.equal(result.status, 200);
  assert.equal(result.body.review.status, "verified");
  assert.equal(result.body.review.checkedCount, count);
  assert.deepEqual(result.body.review.items, Array.from({ length: count }, (_, index) => ({ index, status: "verified", reasons: [] })));
  assert.deepEqual(result.body.review.additionalItems, []);
  assert.deepEqual(result.body.review.issues, []);
}
function attention(result, index = 0, reason) {
  assert.equal(result.status, 200);
  const review = result.body.review;
  assert.equal(review.status, "attention");
  assert.equal(review.items[index].index, index);
  assert.equal(review.items[index].status, "attention");
  if (reason) assert.match(review.items[index].reasons.join(" "), reason);
  return review;
}

test("auditor usa original/medium/schema estrito sem ver a primeira leitura", async () => {
  const original = first([line({ valor: 991.23, referencia: "CLIENT_ONLY_SENTINEL" })]);
  const before = JSON.stringify(original), h = harness();
  const result = await h.request(original);
  attention(result, 0, /Valor diverge/);
  assert.equal(JSON.stringify(original), before);
  assert.equal(h.calls.length, 2);
  const sent = JSON.parse(h.calls[1].init.body);
  assert.equal(sent.model, "gpt-6.1-terra"); assert.deepEqual(sent.reasoning, { effort: "medium" });
  assert.equal(sent.store, false); assert.equal(sent.tools, undefined); assert.equal(sent.previous_response_id, undefined);
  assert.match(sent.instructions, /independente/i); assert.match(sent.instructions, /auditIssues/);
  assert.equal(sent.input[0].content[0].file_data, "data:application/pdf;base64,aGVsbG8=");
  assert(!h.calls[1].init.body.includes("CLIENT_ONLY_SENTINEL")); assert(!h.calls[1].init.body.includes("991.23"));
  assert(!h.calls[1].init.body.includes("synthetic-session"));
  const schema = sent.text.format.schema;
  assert.equal(sent.text.format.strict, true); assert.equal(schema.additionalProperties, false);
  assert(schema.required.includes("auditIssues")); assert.equal(schema.properties.auditIssues.items.type, "string");
  assert.equal(sent.max_output_tokens, 16384); assert.deepEqual(h.timers, [8000, 45000]);
  assert.equal(result.headers["Cache-Control"], "no-store");
});

test("concordância em outra ordem preserva índices e normaliza somente caixa/espaços", async () => {
  const a = line(), b = line({ referencia: "REF-B", descricao: "Outra compra", pagina: 2, valor: 7 });
  const h = harness(second([b, { ...a, descricao: "  COMPRA   sintética  " }]));
  verified(await h.request(first([a,b])), 2);
});

test("auditor confere somente o trecho intencional recebido sem ocultar avisos por pós-processamento", async () => {
  const h = harness();
  verified(await h.request(first(), { documentContext: { pageStart: 1, pageEnd: 2, totalPages: 4 } }));
  const prompt = JSON.parse(h.calls[1].init.body).instructions;
  assert.match(prompt, /posições 1 a 2 de 4/);
  assert.match(prompt, /enviados em partes de propósito/);
  assert.match(prompt, /SOMENTE as páginas físicas recebidas/);
  assert.match(prompt, /ausência esperada NÃO é um problema, NÃO gera auditIssues e NÃO torna coverage\.complete falso/);
  assert.match(prompt, /DENTRO do intervalo declarado continuam sendo problemas reais/);
  const warning = "As páginas 3 e 4 do documento não foram enviadas.";
  const warned = await harness(second(undefined, { auditIssues: [warning] })).request(first(), { documentContext: { pageStart: 1, pageEnd: 2, totalPages: 4 } });
  attention(warned, 0, /páginas 3 e 4/);
  assert(warned.body.review.issues.includes(warning), "the server must not erase provider warnings with heuristic filters");
});

test("valor duplicado e valores trocados por referência exigem atenção nos índices certos", async () => {
  attention(await harness().request(first([line({ valor: 25 })])), 0, /Valor diverge/);
  const a = line(), b = line({ referencia: "REF-B", descricao: "Outra compra", valor: 7 });
  const r = await harness(second([a,b])).request(first([{ ...a, valor: 7 }, { ...b, valor: 12.5 }]));
  attention(r, 0, /Valor diverge/); attention(r, 1, /Valor diverge/);
  assert.deepEqual(r.body.review.additionalItems, []);
});

test("linha ausente é pendência e uma linha encontrada só na segunda volta completa", async () => {
  const b = line({ referencia: "REF-B", descricao: "Aula legítima", valor: 99, pagina: 2 });
  const missing = await harness(second([b])).request(first([line(), b]));
  attention(missing, 0, /não localizada/); assert.equal(missing.body.review.items[1].status, "verified");
  assert.deepEqual(missing.body.review.issues, [], "a local mismatch must not invalidate unrelated verified rows");
  const extra = await harness(second([line(),b])).request();
  assert.equal(extra.body.review.status, "attention"); assert.equal(extra.body.review.items[0].status, "verified");
  assert.deepEqual(extra.body.review.issues, [], "extra rows are reported separately, not as a global document failure");
  assert.deepEqual(extra.body.review.additionalItems, [b]);
});

test("multiplicidade de compras idênticas sobrevive; excesso e falta não se anulam", async () => {
  verified(await harness(second([line(),line()])).request(first([line(),line()])), 2);
  const fewer = await harness().request(first([line(),line()]));
  assert.equal(fewer.body.review.items.filter(item => item.status === "verified").length, 1);
  assert.equal(fewer.body.review.items.filter(item => item.status === "attention").length, 1);
  const more = await harness(second([line(),line()])).request();
  assert.equal(more.body.review.status, "attention"); assert.equal(more.body.review.additionalItems.length, 1);
});

test("dia/valor não equivalem operações distintas; correspondências exatas têm prioridade", async () => {
  const a = line({ referencia: "", descricao: "Mercado Alfa" }), b = line({ referencia: "", descricao: "Mercado Beta" });
  const result = await harness(second([b])).request(first([a,b]));
  attention(result, 0, /não localizada/); assert.equal(result.body.review.items[1].status, "verified");
  const c = line({ referencia: "", descricao: "Mercado Gama" });
  const other = await harness(second([c])).request(first([a]));
  attention(other, 0, /não localizada/);
  const { referencia, ...cleanedC } = c;
  assert.deepEqual(other.body.review.additionalItems, [cleanedC]);
});

test("ambiguidade de referência/origem não escolhe arbitrariamente uma compra", async () => {
  const result = await harness(second([line({ valor: 10 }),line({ valor: 20 })])).request(first([line({ valor: 30 })]));
  attention(result, 0, /mais de uma correspondência/);
  assert.equal(result.body.review.additionalItems.length, 2);
});

test("campos financeiros, referência, descrição e página divergentes nunca ficam verificados", async () => {
  const changes = [
    [{ data: "2026-10-25" }, /Data diverge/], [{ moeda: "USD" }, /Moeda diverge/],
    [{ tipo: "receita" }, /Tipo de operação diverge/], [{ parcela: "1\/3" }, /Parcela diverge/],
    [{ fixa: true }, /Recorrência diverge/], [{ categoria: "Alimentação" }, /Categoria diverge/],
    [{ instituicao: "Outra conta" }, /Conta\/cartão diverge/], [{ referencia: "ref-123" }, /Referência diverge/],
    [{ descricao: "Compra sintetica" }, /Descrição diverge/], [{ pagina: 2 }, /Página de origem diverge/],
  ];
  for (const [change, reason] of changes) attention(await harness(second([line(change)])).request(), 0, reason);
});

test("referência ausente não impede apontar divergência com mesma descrição e página", async () => {
  const a = line({ referencia: "" });
  attention(await harness(second([{ ...a, valor: 13 }])).request(first([a])), 0, /Valor diverge/);
  const result = await harness(second([{ ...a, pagina: 2 }])).request(first([a]));
  attention(result, 0, /não localizada/); assert.equal(result.body.review.additionalItems.length, 1);
});

test("cobertura, partial, incertezas e falta de evidência bloqueiam confirmação", async () => {
  for (const snapshot of [first(undefined, { partial: true }), first(undefined, { coverage: { pagesRead: [1], unreadablePages: [], complete: false } })]) {
    attention(await harness().request(snapshot), 0, /primeira leitura tem cobertura/);
  }
  for (const doc of [second(undefined, { coverage: { pagesRead: [1], unreadablePages: [], complete: false } }), second(undefined, { coverage: { pagesRead: [1,2], unreadablePages: [2], complete: true } })]) {
    attention(await harness(doc).request(), 0, /segunda leitura tem cobertura/);
  }
  attention(await harness(second([line({ incertezas: ["Data com baixa nitidez"] })])).request(), 0, /incertos na segunda/);
  attention(await harness().request(first([line({ revisar: ["Conferir descrição"] })])), 0, /incertos na primeira/);
  attention(await harness(second([line({ evidencia: "" })])).request(), 0, /segunda leitura não informou evidência/);
  attention(await harness().request(first([line({ evidencia: "" })])), 0, /primeira leitura não informou evidência/);
  attention(await harness().request(first([line({ pagina: undefined })])), 0, /primeira leitura tem cobertura/);
});

test("auditor sinaliza totais/legibilidade e não pode omitir sua confirmação geral", async () => {
  attention(await harness(second(undefined, { auditIssues: ["Subtotal não confere com as linhas legíveis."] })).request(), 0, /Subtotal/);
  for (const auditIssues of [undefined, null, [null], [""], ["x".repeat(201)]]) {
    attention(await harness(second(undefined, { auditIssues })).request(), 0, /não confirmou a conferência geral/);
  }
  attention(await harness(second(undefined, { cartao: "Outra conta" })).request(), 0, /cartões\/contas/);
});

test("linha inválida descartada e JSON completo porém incomplete nunca verificam", async () => {
  attention(await harness(second([line(), line({ moeda: "XYZ" })])).request(), 0, /segunda leitura tem cobertura/);
  attention(await harness(second(), { completion: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } }).request(), 0, /segunda leitura tem cobertura/);
  const truncated = '{"cartao":"Conta sintética","itens":[' + JSON.stringify(line()) + ',{"valor":';
  attention(await harness(truncated, { completion: { status: "incomplete" } }).request(), 0, /segunda leitura tem cobertura/);
});

test("entradas malformadas são recusadas antes de gastar IA, sem ajustar a primeira lista", async () => {
  const snapshots = [null, [], {}, first(undefined, { partial: "false" }), first(undefined, { surprise: true }),
    first([null]), first([line({ valor: "12.5" })]), first([line({ valor: Infinity })]), first([line({ valor: -12.5 })]),
    first([line({ valor: 12.501 })]), first([line({ moeda: "XYZ" })]), first([line({ data: "2026-02-31" })]),
    first([line({ categoria: "Inventada" })]), first([line({ fixa: 1 })]), first([line({ parcela: "3/2" })]),
    first([line({ pagina: 3 })]), first([line({ revisar: [null] })]), first([line({ incertezas: [] })]),
    first([line({ descricao: "x".repeat(121) })]), first(undefined, { cartao: "Conta não autorizada" }),
    first(undefined, { coverage: { pagesRead: [1,1], unreadablePages: [], complete: true } }),
    first(undefined, { coverage: { pagesRead: [1,2], unreadablePages: [], complete: "true" } }),
  ];
  for (const snapshot of snapshots) {
    const h = harness(), result = await h.request(snapshot);
    assert.equal(result.status, 400, JSON.stringify(snapshot)); assert.equal(result.body.error, "revisao_invalida"); assert.equal(h.calls.length, 1);
  }
  for (const extra of [{ multi: false }, { documentContext: null }]) {
    const h = harness(), result = await h.request(first(), extra);
    assert.equal(result.status, 400); assert.equal(h.calls.length, 1);
  }
});

test("limites de quantidade e bytes UTF8 são aplicados antes da IA", async () => {
  for (const snapshot of [first(Array.from({ length: 2001 }, () => line())), first(Array.from({ length: 500 }, () => line({ evidencia: "界".repeat(180) })))]) {
    const h = harness(), result = await h.request(snapshot);
    assert.equal(result.status, 413); assert.equal(result.body.error, "revisao_grande"); assert.equal(h.calls.length, 1);
  }
});

test("revisão exige sessão válida e mantém erros reais sem falso verified", async () => {
  const noAuth = harness(), missing = await noAuth.request(first(), {}, {});
  assert.equal(missing.status, 401); assert.equal(noAuth.calls.length, 0);
  const rejected = harness(second(), { authStatus: 401 });
  assert.equal((await rejected.request()).status, 401); assert.equal(rejected.calls.length, 1);
  const unavailable = harness(second(), { authStatus: 503 });
  assert.equal((await unavailable.request()).body.error, "auth_indisponivel"); assert.equal(unavailable.calls.length, 1);
  for (const [status, error, expected] of [[429,"insufficient_quota","saldo_ia"], [401,"invalid_api_key","configuracao_ia"], [429,"rate_limit_exceeded","limite_ia"]]) {
    const h = harness(second(), { status, response: { error: { code: error, message: "synthetic-secret" } } });
    const result = await h.request(); assert.equal(result.body.error, expected); assert.equal(result.body.review, undefined);
    assert(!JSON.stringify(result).includes("synthetic-secret")); assert.equal(h.calls.length, 2);
  }
  const refusal = completed(); refusal.output[0].content.push({ type: "refusal", refusal: "private refusal" });
  const denied = await harness(second(), { response: refusal }).request(); assert.deepEqual(denied.body, { error: "refusal" });
  const timeout = await harness(second(), { error: Object.assign(new Error("private"), { name: "TimeoutError" }) }).request();
  assert.deepEqual(timeout.body, { error: "tempo_ia" });
});

test("alias OpenAI funciona; outro provedor não se passa por auditor independente", async () => {
  verified(await harness(second(), { env: { OPENAI_API_KEY: "", OPENAI_KEYZAO: "synthetic-alias" } }).request());
  const h = harness(second(), { env: { OPENAI_API_KEY: "", GEMINI_API_KEY: "synthetic-gemini" } });
  const result = await h.request(); assert.equal(result.status, 503); assert.deepEqual(result.body, { error: "revisao_indisponivel" });
  assert.equal(h.calls.length, 1);
});

test("primeira lista vazia não oculta operações da segunda", async () => {
  const result = await harness().request(first([]));
  assert.equal(result.body.review.status, "attention"); assert.equal(result.body.review.checkedCount, 0);
  assert.deepEqual(result.body.review.items, []); assert.equal(result.body.review.additionalItems.length, 1);
  verified(await harness(second([])).request(first([])), 0);
});
