/* ===== Finanças YG — leitura por IA (função serverless da Vercel) =====
   A chave da IA vive SÓ aqui, no servidor, em variável de ambiente
   (painel da Vercel — NUNCA no código/repo). O navegador nunca vê a chave:
   ele fala com esta função, e esta função fala com a IA.

   Dois modos:
   - único (padrão): 1 comprovante -> 1 objeto.
   - lote (multi:true): 1 foto de fatura/planilha -> lista de transações.

   Provedores: usa o Gemini (GEMINI_API_KEY) por padrão — mais barato e com
   cota gratuita. Se só houver ANTHROPIC_API_KEY, usa a Anthropic.

   Acesso liberado apenas para quem está logado no Supabase (o dono do app). */

const SUPABASE_URL = "https://mhgagjhwsjjjwwvopjgu.supabase.co";
const SUPABASE_ANON = "sb_publishable_fB3B_MW3VgJBcJpUbN1wvg_1Glbr2r5"; // pública por design
// Tenta em ordem. Cada modelo do Gemini tem COTA GRÁTIS INDEPENDENTE, então se
// um estiver no limite (429), aposentado (404) ou sobrecarregado (503), o
// próximo assume — inclusive o "-lite", que tem a maior folga na cota gratuita.
// Os aliases "-latest" acompanham o modelo mais novo automaticamente (evita
// quebrar quando o Google aposenta uma versão numerada).
const MODELS_GEMINI = ["gemini-flash-latest", "gemini-flash-lite-latest"];
const MODEL_ANTHROPIC = "claude-haiku-4-5";

const PROMPT_SINGLE = `Analise o documento (imagem ou PDF): é um comprovante financeiro (Pix, transferência bancária ou compra), do Brasil, Chile, Paraguai ou em dólar.
Extraia os dados da operação e responda SOMENTE com JSON. Regras:
- "valor": o valor principal da operação, como número (ex: 150.75), na moeda mostrada.
- "moeda": a moeda do valor — "BRL" (Real, R$), "CLP" (peso chileno, $/CLP), "PYG" (guarani, ₲/Gs) ou "USD" (dólar, US$/USD). Se o símbolo "$" for ambíguo entre peso chileno e dólar, decida pelo país do banco/comprovante.
- "data": a data em que a operação foi feita, no formato AAAA-MM-DD. Use "" se não estiver visível.
- "descricao": curta e útil, ex: "Pix para João Silva", "Compra em Mercado X".
- "instituicao": o banco/app de ONDE SAIU o dinheiro (pagador). Use "" se não der para identificar.
- "categoria": escolha a mais adequada da lista permitida.
- "direcao": "recebido" apenas se o comprovante mostrar dinheiro RECEBIDO; caso contrário "enviado".`;

const PROMPT_BATCH = `O documento (imagem ou PDF) é uma FATURA/EXTRATO de banco ou cartão, ou uma PLANILHA de gastos — pode ter MUITAS linhas (facilmente 10, 20, 30 ou mais).
Sua tarefa é extrair TODAS as transações, SEM PULAR NENHUMA. Percorra o documento inteiro — TODAS as páginas, se houver mais de uma — de cima até embaixo, linha por linha, e vá até o fim — NÃO pare depois das primeiras. Responda SOMENTE com JSON: um objeto por transação.
Regras por item:
- "data": a data REAL daquela linha, no formato AAAA-MM-DD. Cada linha tem a SUA própria data — leia a data específica de cada transação e NÃO repita a mesma data em todas. Se só aparecer dia/mês (ex: 29/06), use o ano ${new Date().getFullYear()}. Se a linha realmente não mostrar data, deixe "".
- "descricao": o nome do estabelecimento/lançamento como aparece (ex: "CAPITAO BAR", "Transferencia a João", "Pago recibido PROVEEDOR").
- "valor": o valor da linha, número positivo, na moeda principal do documento. Se a linha mostrar dois valores em moedas diferentes, use o da moeda principal.
- "moeda": "BRL" (R$), "CLP" (peso chileno $), "PYG" (guarani ₲/Gs) ou "USD" (US$). Geralmente a mesma no documento inteiro.
- "tipo": "receita" para entradas/pagamentos recebidos/estornos/créditos/valores com sinal de +; "despesa" para saídas/transferências enviadas/débitos.
- "categoria": escolha, da lista permitida, a que melhor descreve CADA compra (ex: restaurante -> alimentação/essencial; farmácia -> saúde; uber -> transporte).
- "parcela": se a linha indicar compra parcelada (ex: "PARC 03/12", "3/12", "Parcela 3 de 12", "Cuota 03/12"), devolva no formato "3/12" (parcela atual/total). Senão, "".
- "fixa": true SOMENTE se a linha for claramente uma assinatura/mensalidade recorrente (streaming, música, academia, plano, internet, aluguel, mensalidade). Na dúvida, false.
- Em "descricao", NÃO inclua o marcador de parcela: escreva "LOJA X", não "LOJA X 3/12".
Ignore APENAS linhas de total, subtotal, saldo e cabeçalho/rodapé — todo o resto é transação. Não resuma, não agrupe linhas parecidas e não pule duplicatas (duas linhas iguais são duas transações). Não invente itens que não estão no documento.
No campo "cartao" (fora da lista de itens), identifique de QUAL cartão/conta é este documento, escolhendo EXATAMENTE um nome da lista de cartões fornecida — use o banco emissor e o NOME DO TITULAR impresso no documento para distinguir cartões de pessoas diferentes. Se não tiver certeza, use "".`;

/* ---------- Gemini ---------- */
function geminiSchema(multi, categories) {
  if (multi) {
    return {
      type: "OBJECT",
      properties: {
        cartao: { type: "STRING", description: "Cartão/conta do documento (um da lista fornecida) ou \"\"" },
        itens: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              data: { type: "STRING", description: "Data AAAA-MM-DD" },
              descricao: { type: "STRING", description: "Estabelecimento/local, SEM marcador de parcela" },
              valor: { type: "NUMBER", description: "Valor (positivo) na moeda do documento" },
              moeda: { type: "STRING", enum: ["BRL", "CLP", "PYG", "USD"], description: "Moeda do valor" },
              tipo: { type: "STRING", enum: ["despesa", "receita"] },
              categoria: { type: "STRING", enum: categories, description: "Categoria que melhor descreve a compra" },
              parcela: { type: "STRING", description: "\"atual/total\" (ex: 3/12) se parcelado; senão \"\"" },
              fixa: { type: "BOOLEAN", description: "true só para assinatura/mensalidade recorrente óbvia" },
            },
            required: ["data", "descricao", "valor", "moeda", "tipo", "categoria", "parcela", "fixa"],
          },
        },
      },
      required: ["cartao", "itens"],
    };
  }
  return {
    type: "OBJECT",
    properties: {
      valor: { type: "NUMBER" },
      moeda: { type: "STRING", enum: ["BRL", "CLP", "PYG", "USD"] },
      data: { type: "STRING" },
      descricao: { type: "STRING" },
      instituicao: { type: "STRING" },
      categoria: { type: "STRING", enum: categories },
      direcao: { type: "STRING", enum: ["enviado", "recebido"] },
    },
    required: ["valor", "moeda", "data", "descricao", "instituicao", "categoria", "direcao"],
  };
}

async function geminiFetch(key, model, image, categories, cards, multi, withSchema) {
  const generationConfig = { temperature: 0, responseMimeType: "application/json" };
  if (multi) generationConfig.maxOutputTokens = 32768; // fatura longa cabe sem truncar
  if (withSchema) generationConfig.responseSchema = geminiSchema(multi, categories);
  const promptText = multi
    ? PROMPT_BATCH +
      `\nLista permitida de "categoria": ${categories.join(", ")}.` +
      (cards.length ? `\nLista de cartões para "cartao": ${cards.join(", ")}.` : `\nNão há lista de cartões: use "" em "cartao".`)
    : PROMPT_SINGLE + `\nLista permitida de "categoria": ${categories.join(", ")}.`;
  return fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inlineData: { mimeType: image.media_type, data: image.data } },
            { text: promptText },
          ],
        }],
        generationConfig,
      }),
      // Um modelo lento não pode consumir o tempo todo da função (teto 60s na
      // Vercel): corta em 25s e deixa o próximo modelo (mais rápido) assumir.
      signal: AbortSignal.timeout(25000),
    }
  );
}

function parseGeminiResponse(data) {
  if (data.promptFeedback?.blockReason) return { refusal: true };
  const cand = data.candidates?.[0];
  if (!cand || (cand.finishReason && cand.finishReason !== "STOP" && cand.finishReason !== "MAX_TOKENS")) {
    return { refusal: true };
  }
  let text = (cand.content?.parts || []).map((p) => p.text || "").join("").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) text = fenced[1].trim();
  return { text };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sobrecarga temporária do provedor (não é erro de chave/cota nem de entrada).
// status 0 = nosso corte de 25s por modelo — também vale trocar de modelo.
function isOverloaded(status, detail) {
  const d = (detail || "").toLowerCase();
  if (status === 503 || status === 0) return true;
  return /high demand|overloaded|model is overloaded|try again later|temporarily unavailable|unavailable/.test(d);
}

async function tryGeminiOnce(key, model, image, categories, cards, multi) {
  let r;
  try {
    r = await geminiFetch(key, model, image, categories, cards, multi, true);
    if (r.status === 400) {
      // Alguns projetos rejeitam o responseSchema — tenta em modo JSON simples
      const r2 = await geminiFetch(key, model, image, categories, cards, multi, false);
      if (r2.ok || r2.status !== 400) r = r2;
    }
  } catch {
    // AbortSignal (25s) ou falha de rede com o provedor: passa ao próximo modelo
    return { ok: false, status: 0, detail: `sem resposta em 25s (${model})` };
  }
  if (r.ok) return { ok: true, data: await r.json() };
  let detail = "";
  try { detail = (await r.json())?.error?.message || ""; } catch { /* corpo não-JSON */ }
  return { ok: false, status: r.status, detail: String(detail).slice(0, 300) };
}

async function callGemini(key, image, categories, cards, multi) {
  const t0 = Date.now();
  let fail = null, sawOverload = false;

  for (const model of MODELS_GEMINI) {
    if (Date.now() - t0 > 40000) break; // não arrisca o teto de 60s da função
    const res = await tryGeminiOnce(key, model, image, categories, cards, multi);
    if (res.ok) return parseGeminiResponse(res.data);

    console.error("gemini_falhou", model, res.status, res.detail);
    fail = { httpStatus: res.status, detail: res.detail };
    if (isOverloaded(res.status, res.detail)) sawOverload = true;

    // Modelo aposentado (404), sobrecarregado (503) OU no limite de cota (429)
    // -> tenta o PRÓXIMO modelo, que tem cota grátis independente. Só um erro
    // de chave/entrada (ex: 400/401/403) interrompe — trocar não resolveria.
    const retirado = res.status === 404 ||
      /no longer available|not found|not supported|deprecated|does not exist/i.test(res.detail);
    if (!retirado && !isOverloaded(res.status, res.detail) && res.status !== 429) break;
  }

  // Todos os modelos sobrecarregados: uma última tentativa após pausa curta
  // (picos de demanda costumam durar poucos segundos) — se ainda der tempo.
  if (sawOverload && Date.now() - t0 < 32000) {
    await sleep(1500);
    const res = await tryGeminiOnce(key, MODELS_GEMINI[0], image, categories, cards, multi);
    if (res.ok) return parseGeminiResponse(res.data);
    fail = { httpStatus: res.status, detail: res.detail, overloaded: true };
  }
  return fail;
}

/* ---------- Anthropic (reserva) ---------- */
async function callAnthropic(key, image, categories, cards, multi) {
  const itemSchema = {
    type: "object", additionalProperties: false,
    required: ["data", "descricao", "valor", "moeda", "tipo", "categoria", "parcela", "fixa"],
    properties: {
      data: { type: "string" }, descricao: { type: "string" },
      valor: { type: "number" }, moeda: { type: "string", enum: ["BRL", "CLP", "PYG", "USD"] },
      tipo: { type: "string", enum: ["despesa", "receita"] },
      categoria: { type: "string", enum: categories },
      parcela: { type: "string" },
      fixa: { type: "boolean" },
    },
  };
  const singleSchema = {
    type: "object", additionalProperties: false,
    required: ["valor", "moeda", "data", "descricao", "instituicao", "categoria", "direcao"],
    properties: {
      valor: { type: "number" }, moeda: { type: "string", enum: ["BRL", "CLP", "PYG", "USD"] },
      data: { type: "string" }, descricao: { type: "string" },
      instituicao: { type: "string" }, categoria: { type: "string", enum: categories },
      direcao: { type: "string", enum: ["enviado", "recebido"] },
    },
  };
  const schema = multi
    ? { type: "object", additionalProperties: false, required: ["cartao", "itens"], properties: { cartao: { type: "string" }, itens: { type: "array", items: itemSchema } } }
    : singleSchema;
  const promptMulti = PROMPT_BATCH +
    `\nLista permitida de "categoria": ${categories.join(", ")}.` +
    (cards.length ? `\nLista de cartões para "cartao": ${cards.join(", ")}.` : `\nNão há lista de cartões: use "" em "cartao".`);
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODEL_ANTHROPIC,
      max_tokens: multi ? 8192 : 1024,
      output_config: { format: { type: "json_schema", schema } },
      messages: [{
        role: "user",
        content: [
          // PDF entra como "document"; imagem como "image" — a IA lê os dois
          image.media_type === "application/pdf"
            ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: image.data } }
            : { type: "image", source: { type: "base64", media_type: image.media_type, data: image.data } },
          { type: "text", text: multi ? promptMulti : PROMPT_SINGLE },
        ],
      }],
    }),
  });
  if (!r.ok) return { httpStatus: r.status };
  const data = await r.json();
  if (data.stop_reason === "refusal") return { refusal: true };
  const text = (data.content || []).find((b) => b.type === "text")?.text;
  return { text };
}

// Recupera os itens completos de uma lista JSON possivelmente TRUNCADA (fatura
// longa que estourou o limite de tokens): pega cada objeto {...} fechado e
// ignora o pedaço cortado no fim. Assim a leitura não falha por inteiro.
function salvageItems(text) {
  const items = [];
  const re = /\{[^{}]*\}/g;
  let m;
  while ((m = re.exec(text || ""))) {
    try {
      const o = JSON.parse(m[0]);
      if (o && (o.valor != null || o.data || o.descricao)) items.push(o);
    } catch { /* objeto incompleto: ignora */ }
  }
  return items;
}

/* ---------- Handler ---------- */
module.exports = async (req, res) => {
  const gKey = process.env.GEMINI_API_KEY;
  const aKey = process.env.ANTHROPIC_API_KEY;

  if (req.method === "GET") {
    res.status(200).json({ ok: true, configured: !!(gKey || aKey), provider: gKey ? "gemini" : (aKey ? "anthropic" : null) });
    return;
  }
  if (req.method !== "POST") { res.status(405).json({ error: "metodo" }); return; }
  if (!gKey && !aKey) { res.status(501).json({ error: "sem_chave_no_servidor" }); return; }

  // 1) Autorização: exige um usuário Supabase válido
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) { res.status(401).json({ error: "sem_login" }); return; }
  try {
    const u = await fetch(SUPABASE_URL + "/auth/v1/user", {
      headers: { Authorization: "Bearer " + token, apikey: SUPABASE_ANON },
    });
    if (!u.ok) { res.status(401).json({ error: "login_invalido" }); return; }
  } catch {
    res.status(502).json({ error: "auth_indisponivel" }); return;
  }

  // 2) Valida o corpo
  const body = req.body || {};
  const image = body.image;
  const multi = body.multi === true;
  // Aceita imagem OU PDF — os dois provedores leem PDF nativamente
  if (!image || typeof image.data !== "string" || !/^(image\/(jpeg|png|webp|gif)|application\/pdf)$/.test(image.media_type || "")) {
    res.status(400).json({ error: "imagem" }); return;
  }
  if (image.data.length > 8 * 1024 * 1024) { res.status(413).json({ error: "imagem_grande" }); return; }
  const categories = Array.isArray(body.categories) && body.categories.length
    ? body.categories.map((c) => String(c).slice(0, 40)).slice(0, 40)
    : ["Outros"];
  // Cartões/contas do usuário: a IA escolhe de qual cartão é a fatura (lote)
  const cards = Array.isArray(body.cards)
    ? body.cards.map((c) => String(c).slice(0, 40)).filter(Boolean).slice(0, 20)
    : [];

  // 3) Chama a IA com a chave secreta (só o resultado volta ao app)
  try {
    const out = gKey
      ? await callGemini(gKey, image, categories, cards, multi)
      : await callAnthropic(aKey, image, categories, cards, multi);

    if (out.overloaded) { res.status(503).json({ error: "sobrecarga_ia" }); return; }
    if (out.httpStatus === 429) { res.status(429).json({ error: "limite_ia" }); return; }
    if (out.httpStatus) { res.status(502).json({ error: "ia_falhou", status: out.httpStatus, detail: out.detail || "" }); return; }
    if (out.refusal) { res.status(200).json({ error: "refusal" }); return; }

    if (multi) {
      // Aceita array puro ou { cartao, itens: [...] }; se o JSON vier truncado
      // (fatura longa), recupera os itens completos em vez de falhar por inteiro.
      let itens = [];
      let cartao = "";
      try {
        const parsed = JSON.parse(out.text);
        if (Array.isArray(parsed)) itens = parsed;
        else {
          itens = Array.isArray(parsed.itens) ? parsed.itens : [];
          cartao = typeof parsed.cartao === "string" ? parsed.cartao.slice(0, 40) : "";
        }
      } catch {
        itens = salvageItems(out.text);
      }
      res.status(200).json({ cartao, itens });
    } else {
      let parsed;
      try { parsed = JSON.parse(out.text); }
      catch { res.status(502).json({ error: "resposta_invalida" }); return; }
      res.status(200).json(parsed);
    }
  } catch {
    res.status(502).json({ error: "conexao" });
  }
};
