/* ===== Finanças YG — leitura de comprovante (função serverless da Vercel) =====
   A chave da IA vive SÓ aqui, no servidor, em variável de ambiente
   (painel da Vercel — NUNCA no código/repo). O navegador nunca vê a chave:
   ele fala com esta função, e esta função fala com a IA.

   Provedores: usa o Gemini (GEMINI_API_KEY) por padrão — mais barato e com
   cota gratuita. Se só houver ANTHROPIC_API_KEY, usa a Anthropic.

   Acesso liberado apenas para quem está logado no Supabase (o dono do app),
   evitando que estranhos gastem os créditos. */

const SUPABASE_URL = "https://mhgagjhwsjjjwwvopjgu.supabase.co";
const SUPABASE_ANON = "sb_publishable_fB3B_MW3VgJBcJpUbN1wvg_1Glbr2r5"; // pública por design
// Tenta em ordem; se o Google aposentar um modelo, o próximo assume sozinho
// ("gemini-flash-latest" é o apelido oficial que aponta sempre pro Flash atual)
const MODELS_GEMINI = ["gemini-3.5-flash", "gemini-flash-latest"];
const MODEL_ANTHROPIC = "claude-haiku-4-5";

const PROMPT = `Analise a imagem: é um comprovante financeiro brasileiro (Pix, transferência bancária ou compra).
Extraia os dados da operação e responda SOMENTE com JSON. Regras:
- "valor": o valor principal da operação, em reais, como número (ex: 150.75).
- "data": a data em que a operação foi feita, no formato AAAA-MM-DD. Use "" se não estiver visível.
- "descricao": curta e útil, ex: "Pix para João Silva", "Transferência para Maria", "Compra em Mercado X".
- "instituicao": o banco ou app de ONDE SAIU o dinheiro (lado do pagador), ex: Nubank, C6, PicPay, Inter, Wise. Use "" se não der para identificar.
- "categoria": escolha a mais adequada da lista permitida.
- "direcao": "recebido" apenas se o comprovante mostrar dinheiro RECEBIDO pelo dono do app; caso contrário "enviado".`;

/* ---------- Gemini ---------- */
async function geminiFetch(key, model, image, categories, withSchema) {
  const generationConfig = { temperature: 0, responseMimeType: "application/json" };
  if (withSchema) {
    generationConfig.responseSchema = {
      type: "OBJECT",
      properties: {
        valor: { type: "NUMBER", description: "Valor da operação em reais" },
        data: { type: "STRING", description: "Data em AAAA-MM-DD, ou vazio" },
        descricao: { type: "STRING", description: "Descrição curta" },
        instituicao: { type: "STRING", description: "Banco/app do pagador, ou vazio" },
        categoria: { type: "STRING", enum: categories },
        direcao: { type: "STRING", enum: ["enviado", "recebido"] },
      },
      required: ["valor", "data", "descricao", "instituicao", "categoria", "direcao"],
    };
  }
  return fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inlineData: { mimeType: image.media_type, data: image.data } },
            {
              text: PROMPT +
                `\nLista permitida de "categoria": ${categories.join(", ")}.` +
                `\nResponda apenas o objeto JSON com as chaves: valor, data, descricao, instituicao, categoria, direcao.`,
            },
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
  // Tolerante a cercas de markdown quando vier sem schema
  let text = (cand.content?.parts || []).map((p) => p.text || "").join("").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) text = fenced[1].trim();
  return { text };
}

async function callGemini(key, image, categories) {
  let fail = null;
  for (const model of MODELS_GEMINI) {
    let r = await geminiFetch(key, model, image, categories, true);
    if (r.status === 400) {
      // Alguns projetos/versões rejeitam o responseSchema — tenta em modo JSON simples
      const r2 = await geminiFetch(key, model, image, categories, false);
      if (r2.ok || r2.status !== 400) r = r2;
    }
    if (r.ok) return parseGeminiResponse(await r.json());

    let detail = "";
    try { detail = (await r.json())?.error?.message || ""; } catch { /* corpo não-JSON */ }
    console.error("gemini_falhou", model, r.status, detail);
    fail = { httpStatus: r.status, detail: String(detail).slice(0, 300) };

    // Só vale trocar de modelo quando o problema é o próprio modelo
    // (aposentado/inexistente); erros de chave/cota param aqui.
    const modeloIndisponivel = r.status === 404 ||
      /no longer available|not found|not supported|deprecated|does not exist/i.test(detail);
    if (!modeloIndisponivel) break;
  }
  return fail;
}

/* ---------- Anthropic (reserva) ---------- */
async function callAnthropic(key, image, categories) {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["valor", "data", "descricao", "instituicao", "categoria", "direcao"],
    properties: {
      valor: { type: "number" },
      data: { type: "string" },
      descricao: { type: "string" },
      instituicao: { type: "string" },
      categoria: { type: "string", enum: categories },
      direcao: { type: "string", enum: ["enviado", "recebido"] },
    },
  };
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL_ANTHROPIC,
      max_tokens: 1024,
      output_config: { format: { type: "json_schema", schema } },
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: image.media_type, data: image.data } },
          { type: "text", text: PROMPT },
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

  // Ping de disponibilidade (o app usa para saber se a IA está ativa)
  if (req.method === "GET") {
    res.status(200).json({
      ok: true,
      configured: !!(gKey || aKey),
      provider: gKey ? "gemini" : (aKey ? "anthropic" : null),
    });
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
      ? await callGemini(gKey, image, categories)
      : await callAnthropic(aKey, image, categories);

    if (out.httpStatus === 429) { res.status(429).json({ error: "limite_ia" }); return; }
    if (out.httpStatus) {
      res.status(502).json({ error: "ia_falhou", status: out.httpStatus, detail: out.detail || "" });
      return;
    }
    if (out.refusal) { res.status(200).json({ error: "refusal" }); return; }

    let parsed;
    try { parsed = JSON.parse(out.text); }
    catch { res.status(502).json({ error: "resposta_invalida" }); return; }
    res.status(200).json(parsed);
  } catch {
    res.status(502).json({ error: "conexao" });
  }
};
