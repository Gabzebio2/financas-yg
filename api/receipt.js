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

const PROMPT_SINGLE = `Analise a imagem: é um comprovante financeiro (Pix, transferência bancária ou compra), do Brasil, Chile, Paraguai ou em dólar.
Extraia os dados da operação e responda SOMENTE com JSON. Regras:
- "valor": o valor principal da operação, como número (ex: 150.75), na moeda mostrada.
- "moeda": a moeda do valor — "BRL" (Real, R$), "CLP" (peso chileno, $/CLP), "PYG" (guarani, ₲/Gs) ou "USD" (dólar, US$/USD). Se o símbolo "$" for ambíguo entre peso chileno e dólar, decida pelo país do banco/comprovante.
- "data": a data em que a operação foi feita, no formato AAAA-MM-DD. Use "" se não estiver visível.
- "descricao": curta e útil, ex: "Pix para João Silva", "Compra em Mercado X".
- "instituicao": o banco/app de ONDE SAIU o dinheiro (pagador). Use "" se não der para identificar.
- "categoria": escolha a mais adequada da lista permitida.
- "direcao": "recebido" apenas se o comprovante mostrar dinheiro RECEBIDO; caso contrário "enviado".`;

const PROMPT_BATCH = `A imagem é uma FATURA/EXTRATO de banco ou cartão, ou uma PLANILHA de gastos — pode ter MUITAS linhas (facilmente 10, 20, 30 ou mais).
Sua tarefa é extrair TODAS as transações, SEM PULAR NENHUMA. Percorra a imagem de cima até embaixo, linha por linha, e vá até o fim — NÃO pare depois das primeiras. Responda SOMENTE com JSON: um objeto por transação.
Regras por item:
- "data": a data REAL daquela linha, no formato AAAA-MM-DD. Cada linha tem a SUA própria data — leia a data específica de cada transação e NÃO repita a mesma data em todas. Se só aparecer dia/mês (ex: 29/06), use o ano ${new Date().getFullYear()}. Se a linha realmente não mostrar data, deixe "".
- "descricao": o nome do estabelecimento/lançamento como aparece (ex: "CAPITAO BAR", "Transferencia a João", "Pago recibido PROVEEDOR").
- "valor": o valor da linha, número positivo, na moeda principal do documento. Se a linha mostrar dois valores em moedas diferentes, use o da moeda principal.
- "moeda": "BRL" (R$), "CLP" (peso chileno $), "PYG" (guarani ₲/Gs) ou "USD" (US$). Geralmente a mesma no documento inteiro.
- "tipo": "receita" para entradas/pagamentos recebidos/estornos/créditos/valores com sinal de +; "despesa" para saídas/transferências enviadas/débitos.
Ignore APENAS linhas de total, subtotal, saldo e cabeçalho/rodapé — todo o resto é transação. Não resuma, não agrupe linhas parecidas e não pule duplicatas (duas linhas iguais são duas transações). Não invente itens que não estão na imagem.`;

/* ---------- Gemini ---------- */
function geminiSchema(multi, categories) {
  if (multi) {
    return {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          data: { type: "STRING", description: "Data AAAA-MM-DD" },
          descricao: { type: "STRING", description: "Estabelecimento/local" },
          valor: { type: "NUMBER", description: "Valor (positivo) na moeda do documento" },
          moeda: { type: "STRING", enum: ["BRL", "CLP", "PYG", "USD"], description: "Moeda do valor" },
          tipo: { type: "STRING", enum: ["despesa", "receita"] },
        },
        required: ["data", "descricao", "valor", "moeda", "tipo"],
      },
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

async function geminiFetch(key, model, image, categories, multi, withSchema) {
  const generationConfig = { temperature: 0, responseMimeType: "application/json" };
  if (multi) generationConfig.maxOutputTokens = 32768; // fatura longa cabe sem truncar
  if (withSchema) generationConfig.responseSchema = geminiSchema(multi, categories);
  const promptText = multi
    ? PROMPT_BATCH
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

// Sobrecarga temporária do provedor (não é erro de chave/cota nem de entrada)
function isOverloaded(status, detail) {
  const d = (detail || "").toLowerCase();
  if (status === 503) return true;
  return /high demand|overloaded|model is overloaded|try again later|temporarily unavailable|unavailable/.test(d);
}

async function tryGeminiOnce(key, model, image, categories, multi) {
  let r = await geminiFetch(key, model, image, categories, multi, true);
  if (r.status === 400) {
    // Alguns projetos rejeitam o responseSchema — tenta em modo JSON simples
    const r2 = await geminiFetch(key, model, image, categories, multi, false);
    if (r2.ok || r2.status !== 400) r = r2;
  }
  if (r.ok) return { ok: true, data: await r.json() };
  let detail = "";
  try { detail = (await r.json())?.error?.message || ""; } catch { /* corpo não-JSON */ }
  return { ok: false, status: r.status, detail: String(detail).slice(0, 300) };
}

async function callGemini(key, image, categories, multi) {
  let fail = null, sawOverload = false;

  for (const model of MODELS_GEMINI) {
    const res = await tryGeminiOnce(key, model, image, categories, multi);
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
  // (picos de demanda costumam durar poucos segundos).
  if (sawOverload) {
    await sleep(1500);
    const res = await tryGeminiOnce(key, MODELS_GEMINI[0], image, categories, multi);
    if (res.ok) return parseGeminiResponse(res.data);
    fail = { httpStatus: res.status, detail: res.detail, overloaded: true };
  }
  return fail;
}

/* ---------- Anthropic (reserva) ---------- */
async function callAnthropic(key, image, categories, multi) {
  const itemSchema = {
    type: "object", additionalProperties: false,
    required: ["data", "descricao", "valor", "moeda", "tipo"],
    properties: {
      data: { type: "string" }, descricao: { type: "string" },
      valor: { type: "number" }, moeda: { type: "string", enum: ["BRL", "CLP", "PYG", "USD"] },
      tipo: { type: "string", enum: ["despesa", "receita"] },
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
    ? { type: "object", additionalProperties: false, required: ["itens"], properties: { itens: { type: "array", items: itemSchema } } }
    : singleSchema;
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
          { type: "image", source: { type: "base64", media_type: image.media_type, data: image.data } },
          { type: "text", text: multi ? PROMPT_BATCH : PROMPT_SINGLE },
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
  if (!image || typeof image.data !== "string" || !/^image\/(jpeg|png|webp|gif)$/.test(image.media_type || "")) {
    res.status(400).json({ error: "imagem" }); return;
  }
  if (image.data.length > 8 * 1024 * 1024) { res.status(413).json({ error: "imagem_grande" }); return; }
  const categories = Array.isArray(body.categories) && body.categories.length
    ? body.categories.map((c) => String(c).slice(0, 40)).slice(0, 40)
    : ["Outros"];

  // 3) Chama a IA com a chave secreta (só o resultado volta ao app)
  try {
    const out = gKey
      ? await callGemini(gKey, image, categories, multi)
      : await callAnthropic(aKey, image, categories, multi);

    if (out.overloaded) { res.status(503).json({ error: "sobrecarga_ia" }); return; }
    if (out.httpStatus === 429) { res.status(429).json({ error: "limite_ia" }); return; }
    if (out.httpStatus) { res.status(502).json({ error: "ia_falhou", status: out.httpStatus, detail: out.detail || "" }); return; }
    if (out.refusal) { res.status(200).json({ error: "refusal" }); return; }

    if (multi) {
      // Aceita array puro ou { itens: [...] }; se o JSON vier truncado (fatura
      // longa), recupera os itens completos em vez de falhar por inteiro.
      let itens = [];
      try {
        const parsed = JSON.parse(out.text);
        itens = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.itens) ? parsed.itens : []);
      } catch {
        itens = salvageItems(out.text);
      }
      res.status(200).json({ itens });
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
