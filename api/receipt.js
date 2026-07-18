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
// Tenta em ordem; se o Google aposentar um modelo, o próximo assume sozinho
// Vários modelos: se um estiver aposentado ou sobrecarregado, o próximo assume.
// O "-lite" costuma ter mais folga na cota gratuita em picos de demanda.
const MODELS_GEMINI = ["gemini-3.5-flash", "gemini-flash-latest", "gemini-flash-lite-latest"];
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

const PROMPT_BATCH = `A imagem é uma FATURA de cartão de crédito ou uma PLANILHA de gastos (pode ter muitas linhas).
Extraia TODAS as linhas de transação, uma por item, e responda SOMENTE com JSON.
Regras por item:
- "data": data da compra no formato AAAA-MM-DD. Se só aparecer dia/mês (ex: 29/06), use o ano ${new Date().getFullYear()}.
- "descricao": o nome do estabelecimento/local exatamente como aparece (ex: "CAPITAO BAR", "Supermercado").
- "valor": o valor da linha, como número positivo. Se a linha mostrar dois valores em moedas diferentes, use o valor na MOEDA PRINCIPAL do documento (a mesma da maioria das linhas) e informe essa moeda.
- "moeda": a moeda desse valor — "BRL" (R$), "CLP" (peso chileno $), "PYG" (guarani ₲/Gs) ou "USD" (US$). Em geral é a mesma para o documento inteiro.
- "tipo": "receita" se a linha for um pagamento/estorno/valor negativo (ex: linha "Pagamento" ou valor com sinal de menos); senão "despesa".
Ignore linhas de total, subtotal, saldo, cabeçalho e rodapé. Não invente itens que não estão na imagem.`;

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
  if (multi) generationConfig.maxOutputTokens = 8192;
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

    // Modelo aposentado OU sobrecarga -> tenta o próximo modelo já em seguida.
    // Erro de chave/cota/entrada -> não adianta trocar de modelo, para aqui.
    const retirado = res.status === 404 ||
      /no longer available|not found|not supported|deprecated|does not exist/i.test(res.detail);
    if (!retirado && !isOverloaded(res.status, res.detail)) break;
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
      max_tokens: multi ? 4096 : 1024,
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

    let parsed;
    try { parsed = JSON.parse(out.text); }
    catch { res.status(502).json({ error: "resposta_invalida" }); return; }

    if (multi) {
      // Aceita tanto array puro quanto { itens: [...] }
      const itens = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.itens) ? parsed.itens : []);
      res.status(200).json({ itens });
    } else {
      res.status(200).json(parsed);
    }
  } catch {
    res.status(502).json({ error: "conexao" });
  }
};
