const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = path.resolve(__dirname, '..');
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const plain = (value) => JSON.parse(JSON.stringify(value));
const line = (overrides = {}) => ({ data: '2026-01-12', descricao: 'Mercado Central', valor: 25.75, moeda: 'BRL', tipo: 'despesa', categoria: 'Alimentação', parcela: '', fixa: false, ...overrides });
const single = (overrides = {}) => ({ documento: 'comprovante', data: '2026-01-12', descricao: 'Compra no mercado', valor: 25.75, moeda: 'BRL', direcao: 'enviado', categoria: 'Alimentação', instituicao: '', ...overrides });

function apiEnvironment(payload, options = {}) {
  const calls = [];
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const provider = options.provider || 'gemini';
  const context = vm.createContext({
    require: require('node:module').createRequire(path.join(app, 'api/receipt.js')),
    module: { exports: {} }, process: { env: provider === 'gemini' ? { GEMINI_API_KEY: 'synthetic-test-key' } : { ANTHROPIC_API_KEY: 'synthetic-test-key' } },
    console: { error() {} }, AbortSignal, setTimeout: (callback) => { callback(); return 1; },
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (url.includes('/auth/v1/user')) {
        if (options.authError) throw options.authError;
        return response({}, options.authStatus || 200);
      }
      if (options.providerError) throw options.providerError;
      if (options.providerStatus) return response({ error: { message: 'synthetic provider failure' } }, options.providerStatus);
      if ('providerData' in options) return response(options.providerData);
      return response(provider === 'gemini'
        ? { candidates: [{ finishReason: options.partial ? 'MAX_TOKENS' : 'STOP', content: { parts: [...(options.thought ? [{ thought: true, text: 'internal text must not be parsed' }] : []), { text }] } }] }
        : { stop_reason: options.partial ? 'max_tokens' : 'end_turn', content: [{ type: 'text', text }] });
    },
  });
  vm.runInContext(fs.readFileSync(path.join(app, 'api/receipt.js'), 'utf8'), context);
  return {
    calls,
    async request(overrides = {}) {
      const req = { method: 'POST', headers: { authorization: 'Bearer synthetic-test-session' }, body: { image: { media_type: 'image/jpeg', data: 'aGVsbG8=' }, multi: true, categories: ['Alimentação', 'Lazer', 'Outros'], cards: ['C6'], ...overrides } };
      const result = { status: 0, body: null };
      const res = { setHeader() {}, status(status) { result.status = status; return this; }, json(body) { result.body = plain(body); } };
      await context.module.exports(req, res);
      return result;
    },
  };
}

function browserEnvironment(payload, options = {}) {
  const nodes = new Map(), callbacks = [], filled = [], calls = [], storage = new Map();
  let observer;
  if (!options.proxy) storage.set('fyg:anthropic-key', 'sk-ant-synthetic-test-key');
  const $ = (id) => {
    if (!nodes.has(id)) {
      const classes = new Set();
      nodes.set(id, {
        value: '', textContent: '', className: '', listeners: new Map(),
        classList: { contains: (name) => classes.has(name), add: (name) => classes.add(name), remove: (name) => classes.delete(name), toggle: (name, on) => on ? classes.add(name) : classes.delete(name) },
        addEventListener(name, fn) { this.listeners.set(name, fn); }, focus() {}, click() {},
      });
    }
    return nodes.get(id);
  };
  const context = vm.createContext({
    console: { error() {} }, AbortSignal, setTimeout: (fn) => { fn(); return 1; }, $, toast() {},
    CURRENCY_CODES: ['BRL', 'CLP', 'PYG', 'USD', 'EUR', 'GBP', 'USDT', 'USDC'],
    curFrac: (c) => ['USDT', 'USDC'].includes(c) ? 6 : ['CLP', 'PYG'].includes(c) ? 0 : 2,
    askConfirm: (_, __, fn) => fn(),
    document: { addEventListener: (_, fn) => callbacks.push(fn) },
    location: { protocol: 'https:', hostname: 'synthetic.invalid' },
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => { if (options.storageFails) throw new Error('quota'); storage.set(key, value); }, removeItem: (key) => storage.delete(key) },
    MutationObserver: class { constructor(fn) { observer = fn; } observe() {} },
    FileReader: class { readAsDataURL() { this.result = options.fileData ?? 'data:application/pdf;base64,aGVsbG8='; this.onload(); } },
    Dashboard: { getCats: () => options.categories || ['Alimentação', 'Lazer', 'Outros'], fillTxFromReceipt: (item) => filled.push(plain(item)) },
    Cloud: { getToken: () => 'synthetic-session' },
    Store: { saveDataset() { throw new Error('Recognition must never save a transaction'); } },
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (options.fetch) return options.fetch(url, init);
      if (options.error) throw options.error;
      return response(options.proxy ? payload : { stop_reason: options.partial ? 'max_tokens' : 'end_turn', content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }] }, options.status || 200);
    },
  });
  vm.runInContext(fs.readFileSync(path.join(app, 'js/receipt.js'), 'utf8') + '\nthis.receipt = Receipt;', context);
  callbacks.forEach((callback) => callback());
  return { context, $, calls, filled, storage, receipt: context.receipt, close() { $('#modal-tx').classList.add('hidden'); observer(); }, analyze: () => context.receipt.analyze({ type: 'application/pdf', name: 'synthetic.pdf', size: 8 }) };
}

test('API preserva moedas, estorno e categorias canônicas sem inferir direção pelo sinal', async () => {
  const env = apiEnvironment({ cartao: 'C6', itens: [line({ categoria: 'alimentacao' }), line({ valor: -12.5, moeda: 'USD', tipo: 'receita', descricao: 'Estorno' }), line({ valor: 3000, moeda: 'CLP' }), line({ valor: 12000, moeda: 'PYG' })] });
  const { status, body } = await env.request();
  assert.equal(status, 200);
  assert.equal(body.partial, false);
  assert.equal(body.itens[0].categoria, 'Alimentação');
  assert.deepEqual(body.itens.map((item) => [item.moeda, item.valor, item.tipo]), [['BRL', 25.75, 'despesa'], ['USD', 12.5, 'receita'], ['CLP', 3000, 'despesa'], ['PYG', 12000, 'despesa']]);
});

test('API e navegador preservam EUR/GBP e micropagamentos USDT/USDC sem conversão', async () => {
  for (const provider of ['gemini', 'anthropic']) {
    const currencies = [['EUR', 12.34], ['GBP', 45.67], ['USDT', 1.234567], ['USDC', 0.000001], ['USDT', 532042.273029]];
    const env = apiEnvironment({ itens: currencies.map(([moeda, valor]) => line({ moeda, valor })) }, { provider });
    const { status, body } = await env.request();
    assert.equal(status, 200); assert.equal(body.partial, false);
    assert.deepEqual(body.itens.map((item) => [item.moeda, item.valor]), currencies);
    assert.match(env.calls[1].init.body, /USDT/); assert.match(env.calls[1].init.body, /USDC/);
    for (const proxy of [false, true]) for (const [moeda, valor] of currencies) {
      const client = browserEnvironment(single({ moeda, valor }), { proxy }); await client.analyze();
      assert.equal(client.filled.length, 1); assert.equal(client.filled[0].moeda, moeda); assert.equal(client.filled[0].valor, valor);
    }
  }
});

test('IA rejeita precisão além de seis casas e DEFAULT como moeda de transação', async () => {
  const bad = [{ moeda: 'USDT', valor: 1.1234567 }, { moeda: 'USDC', valor: 0.0000001 }, { moeda: 'DEFAULT', valor: 10 }];
  const { body } = await apiEnvironment({ itens: [line(), ...bad.map((item) => line(item))] }).request();
  assert.equal(body.itens.length, 1); assert.equal(body.partial, true);
  for (const fields of bad) {
    const env = browserEnvironment(single(fields), { proxy: true }); await env.analyze(); assert.equal(env.filled.length, 0);
  }
});

test('API exclui moeda, tipo e valores inválidos com aviso de leitura parcial', async () => {
  const itens = [line(), line({ moeda: 'CHF' }), line({ tipo: '' }), line({ valor: '25,75' }), line({ valor: 0 }), line({ valor: 1e100 }), line({ valor: 0.001 }), line({ moeda: 'CLP', valor: 1.5 })];
  const { status, body } = await apiEnvironment({ itens }).request();
  assert.equal(status, 200);
  assert.equal(body.itens.length, 1);
  assert.equal(body.partial, true);
  assert.match(body.avisos.join(' '), /7 linha.*não incluída/);
});

test('API mantém datas impossíveis vazias e categoria incerta em Outros ou vazia', async () => {
  const env = apiEnvironment({ cartao: 'Inventado', itens: [line({ data: '2026-02-31', categoria: 'Supermercado' }), line({ data: '2024-02-29' }), line({ data: '12/01' })] });
  const { body } = await env.request();
  assert.deepEqual(body.itens.map((item) => item.data), ['', '2024-02-29', '']);
  assert.equal(body.itens[0].categoria, 'Outros');
  assert.match(body.itens[0].revisar.join(' '), /Data.*Categoria/);
  assert.equal(body.cartao, '');
  const noFallback = await env.request({ categories: ['Lazer'] });
  assert.equal(noFallback.body.itens[0].categoria, '');
});

test('API valida parcelas e nunca confunde parcelas inválidas com despesa recorrente', async () => {
  const { body } = await apiEnvironment({ itens: ['03/12', '0/12', '15/12', '3/99', '3/1', ''].map((parcela) => line({ parcela, fixa: true })) }).request();
  assert.deepEqual(body.itens.map((item) => [item.parcela, item.fixa]), [['3/12', false], ['', false], ['', false], ['', false], ['', false], ['', true]]);
  assert.match(body.itens[1].revisar.join(' '), /Parcela inválida/);
  assert.equal(body.itens.length, 6);
});

test('API elimina resumos de fatura sem eliminar estabelecimentos com nome parecido', async () => {
  const { body } = await apiEnvironment({ itens: ['Total da fatura', 'Subtotal', 'Saldo anterior', 'Limite disponível', 'Pagamento mínimo', 'Total Express'].map((descricao) => line({ descricao })) }).request();
  assert.equal(body.itens.length, 1);
  assert.equal(body.itens[0].descricao, 'Total Express');
  assert.equal(body.partial, true);
});

test('API recupera apenas objetos completos de JSON truncado, inclusive descrições com chaves', async () => {
  const text = '{"cartao":"C6","itens":[' + JSON.stringify(line({ descricao: 'Loja {Centro} "A"' })) + ',{"data":"2026-01-12","descricao":"cortado';
  const { status, body } = await apiEnvironment(text, { partial: true }).request();
  assert.equal(status, 200);
  assert.equal(body.itens.length, 1);
  assert.equal(body.itens[0].descricao, 'Loja {Centro} "A"');
  assert.equal(body.partial, true);
  assert.match(body.avisos.join(' '), /Leitura parcial/);
});

test('API diferencia lista vazia válida de resposta malformada sem itens recuperáveis', async () => {
  for (const malformed of ['não é JSON', '{"valor":123}', '{"itens":[{"valor":']) {
    const result = await apiEnvironment(malformed).request();
    assert.equal(result.status, 502);
    assert.equal(result.body.error, 'resposta_invalida');
  }
  const valid = await apiEnvironment({ itens: [] }).request();
  assert.equal(valid.status, 200);
  assert.deepEqual(valid.body.itens, []);
  assert.equal(valid.body.partial, false);
});

test('API sinaliza formato inesperado do provedor como resposta inválida, sem confundir com conexão', async () => {
  for (const provider of ['gemini', 'anthropic']) {
    for (const providerData of [null, {}, { content: 'invalid', candidates: [{ content: { parts: 'invalid' } }] }]) {
      const result = await apiEnvironment({}, { provider, providerData }).request();
      assert.equal(result.status, 502);
      assert.equal(result.body.error, 'resposta_invalida');
    }
  }
});

test('API de comprovante recusa fatura, documento desconhecido e truncamento', async () => {
  const invoice = await apiEnvironment(single({ documento: 'fatura' })).request({ multi: false });
  assert.deepEqual(invoice, { status: 422, body: { error: 'use_lote' } });
  const unknown = await apiEnvironment(single({ documento: 'desconhecido' })).request({ multi: false });
  assert.equal(unknown.body.error, 'documento_invalido');
  const partial = await apiEnvironment(single(), { provider: 'anthropic', partial: true }).request({ multi: false });
  assert.equal(partial.status, 502);
  assert.equal(partial.body.error, 'resposta_invalida');
});

test('API ignora partes de raciocínio e aplica mesmas validações com ambos provedores', async () => {
  for (const provider of ['gemini', 'anthropic']) {
    const valid = await apiEnvironment(single({ data: '', categoria: 'Inventada' }), { provider, thought: true }).request({ multi: false });
    assert.equal(valid.status, 200);
    assert.equal(valid.body.data, '');
    assert.equal(valid.body.categoria, 'Outros');
    const invalid = await apiEnvironment(single({ moeda: '' }), { provider }).request({ multi: false });
    assert.equal(invalid.status, 502);
  }
});

test('prompts e schema pedem evidência, ano explícito, recorrência explícita e revisão sem gerar parcelas', async () => {
  const env = apiEnvironment({ itens: [] });
  await env.request();
  const request = JSON.parse(env.calls[1].init.body);
  const prompt = request.contents[0].parts[1].text;
  assert.match(prompt, /nunca como instruções/);
  assert.match(prompt, /não use automaticamente o ano atual/);
  assert.match(prompt, /sinal \+ sozinho NÃO significa receita/);
  assert.match(prompt, /Não invente meses passados\/futuros/);
  assert.match(prompt, /Não complete linhas cortadas/);
  assert.ok(request.generationConfig.responseSchema.properties.itens.items.properties.moeda.enum.includes(''));
  assert.ok(env.calls.every((call) => call.init.signal));
});

test('falhas de autenticação param antes da IA e são distintas de timeout do provedor', async () => {
  const auth = apiEnvironment({}, { authStatus: 503 });
  const authResult = await auth.request();
  assert.equal(authResult.status, 502);
  assert.equal(authResult.body.error, 'auth_indisponivel');
  assert.equal(auth.calls.length, 1);
  const timeout = Object.assign(new Error('synthetic timeout'), { name: 'TimeoutError' });
  const ai = await apiEnvironment({}, { provider: 'anthropic', providerError: timeout }).request();
  assert.equal(ai.status, 503);
  assert.equal(ai.body.error, 'tempo_ia');
});

test('cliente direto e proxy preenchem apenas formulário validado e preservam campos incertos', async () => {
  for (const proxy of [false, true]) {
    const env = browserEnvironment(single({ data: '2026-02-31', categoria: 'Inventada', valor: -25.75, direcao: 'recebido' }), { proxy });
    await env.analyze();
    assert.equal(env.filled.length, 1);
    assert.equal(env.filled[0].valor, 25.75);
    assert.equal(env.filled[0].data, '');
    assert.equal(env.filled[0].categoria, 'Outros');
    assert.equal(env.filled[0].direcao, 'recebido');
    assert.match(env.$('#receipt-status').textContent, /Preenchimento parcial/);
    assert.match(env.$('#receipt-status').textContent, /antes de salvar/);
  }
});

test('cliente bloqueia valores, moedas, direções e documentos inválidos antes de preencher', async () => {
  for (const proxy of [false, true]) {
    for (const override of [{ valor: 0 }, { valor: 0.001 }, { valor: '10' }, { moeda: 'CHF' }, { direcao: '' }, { documento: 'desconhecido' }]) {
      const env = browserEnvironment(single(override), { proxy });
      await env.analyze();
      assert.equal(env.filled.length, 0, JSON.stringify({ proxy, override }));
      assert.match(env.$('#receipt-status').className, /err/);
    }
  }
});

test('câmera orienta usar lote para faturas sem transformar o total em transação', async () => {
  for (const data of [single({ documento: 'fatura' }), single({ descricao: 'Total da fatura' })]) {
    const env = browserEnvironment(data);
    await env.analyze();
    assert.equal(env.filled.length, 0);
    assert.match(env.$('#receipt-status').textContent, /Anexar comprovante/);
  }
  const proxy = browserEnvironment({ error: 'use_lote' }, { proxy: true, status: 422 });
  await proxy.analyze();
  assert.equal(proxy.filled.length, 0);
  assert.match(proxy.$('#receipt-status').textContent, /Anexar comprovante/);
});

test('cliente rejeita JSON malformado e resposta truncada mesmo se JSON parece completo', async () => {
  for (const env of [browserEnvironment('{"valor":'), browserEnvironment(single(), { partial: true }), browserEnvironment(null, { proxy: true })]) {
    await env.analyze();
    assert.equal(env.filled.length, 0);
    assert.match(env.$('#receipt-status').textContent, /incompleta ou inválida/);
  }
});

test('cliente mostra erro específico de login indisponível e timeout', async () => {
  const auth = browserEnvironment({ error: 'auth_indisponivel' }, { proxy: true, status: 502 });
  await auth.analyze();
  assert.match(auth.$('#receipt-status').textContent, /serviço de login/);
  assert.doesNotMatch(auth.$('#receipt-status').textContent, /sobrecarregada/);
  const timeout = browserEnvironment(null, { error: Object.assign(new Error('timeout'), { name: 'TimeoutError' }) });
  await timeout.analyze();
  assert.match(timeout.$('#receipt-status').textContent, /demorou além do limite/);
});

test('fechar formulário enquanto IA lê impede que resposta antiga preencha outro lançamento', async () => {
  let finish;
  const env = browserEnvironment(null, { proxy: true, fetch: () => new Promise((resolve) => { finish = resolve; }) });
  const reading = env.analyze();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(typeof finish, 'function');
  env.close();
  finish(response(single()));
  await reading;
  assert.equal(env.filled.length, 0);
});

test('arquivo ausente ou PDF vazio falha antes de enviar; chave não informa sucesso quando storage falha', async () => {
  const env = browserEnvironment(single(), { storageFails: true });
  await assert.rejects(env.receipt.prepareFile(null), /imagem/);
  await assert.rejects(env.receipt.prepareFile({ type: 'application/pdf', size: 0 }), /leitura/);
  const invalid = browserEnvironment(single(), { fileData: 'data:application/pdf;base64,' });
  await assert.rejects(invalid.receipt.prepareFile({ type: 'application/pdf', size: 5 }), /leitura/);
  assert.equal(invalid.calls.length, 0);
  env.$('#apikey-input').value = 'sk-ant-new-synthetic';
  env.$('#btn-apikey-save').listeners.get('click')();
  assert.match(env.$('#receipt-status').textContent, /Não foi possível salvar/);
  assert.equal(env.storage.get('fyg:anthropic-key'), 'sk-ant-synthetic-test-key');
});

test('resposta do comprovante de outra conta ou pasta não preenche formulário atual', async () => {
  let finish, owner = 'ownerA', target = 'folderA';
  const env = browserEnvironment(null, { proxy: true, fetch: () => new Promise((resolve) => { finish = resolve; }) });
  env.context.Cloud.getSyncState = () => ({ owner }); env.context.Dashboard.getImportTargetId = () => target;
  const reading = env.analyze(); await Promise.resolve(); await Promise.resolve();
  owner = 'ownerB'; target = 'folderB'; finish(response(single())); await reading;
  assert.equal(env.filled.length, 0);
});

test('comprovante preserva referência e evidência e mostra erros de créditos/configuração com clareza', async () => {
  const env = browserEnvironment(single({ referencia: 'REF-1', evidencia: 'operação confirmada', pagina: 1 }), { proxy: true });
  await env.analyze(); assert.equal(env.filled[0].referenceId, 'REF-1'); assert.equal(env.filled[0].sourceEvidence, 'operação confirmada');
  for (const [error, pattern] of [['saldo_ia', /créditos/], ['configuracao_ia', /configuração do servidor/]]) {
    const failed = browserEnvironment({ error }, { proxy: true, status: 503 }); await failed.analyze();
    assert.match(failed.$('#receipt-status').textContent, pattern); assert.equal(failed.filled.length, 0);
  }
});
