/* ===== Finanças YG — leitura de comprovante (função serverless da Vercel) =====
   A chave da Anthropic vive SÓ aqui, no servidor, na variável de ambiente
   ANTHROPIC_API_KEY (configurada no painel da Vercel — NUNCA no código/repo).
   O navegador nunca vê essa chave: ele fala com esta função, e esta função
   fala com a Anthropic.

   Acesso liberado apenas para quem está logado no Supabase (o dono do app),
   evitando que estranhos gastem os créditos. */

const SUPABASE_URL = "https://mhgagjhwsjjjwwvopjgu.supabase.co";
const SUPABASE_ANON = "sb_publishable_fB3B_MW3VgJBcJpUbN1wvg_1Glbr2r5"; // pública por design
const MODEL = "claude-haiku-4-5"; // barato e ótimo para ler comprovantes

module.exports = async (req, res) => {
  // Ping de disponibilidade (o app usa para saber se a IA está ativa)
  if (req.method === "GET") {
    res.status(200).json({ ok: true, configured: !!process.env.ANTHROPIC_API_KEY });
    return;
  }
  if (req.method !== "POST") { res.status(405).json({ error: "metodo" }); return; }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { res.status(501).json({ error: "sem_chave_no_servidor" }); return; }

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

  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["valor", "data", "descricao", "instituicao", "categoria", "direcao"],
    properties: {
      valor: { type: "number", description: "Valor da operação em reais" },
      data: { type: "string", description: "Data da operação em AAAA-MM-DD, ou string vazia se não visível" },
      descricao: { type: "string", description: "Descrição curta, ex: 'Pix para João Silva'" },
      instituicao: { type: "string", description: "Banco/app de ONDE SAIU o dinheiro (pagador), ou string vazia" },
      categoria: { type: "string", enum: categories },
      direcao: { type: "string", enum: ["enviado", "recebido"] },
    },
  };
  const prompt = `Analise a imagem: é um comprovante financeiro brasileiro (Pix, transferência bancária ou compra).
Extraia os dados da operação. Regras:
- "valor": o valor principal da operação, em reais, como número (ex: 150.75).
- "data": a data em que a operação foi feita, no formato AAAA-MM-DD. Use "" se não estiver visível.
- "descricao": curta e útil, ex: "Pix para João Silva", "Transferência para Maria", "Compra em Mercado X".
- "instituicao": o banco ou app de ONDE SAIU o dinheiro (lado do pagador), ex: Nubank, C6, PicPay, Inter, Wise. Use "" se não der para identificar.
- "categoria": escolha a mais adequada da lista permitida.
- "direcao": "recebido" apenas se o comprovante mostrar dinheiro RECEBIDO pelo dono do app; caso contrário "enviado".`;

  // 3) Chama a Anthropic com a chave secreta (só o resultado volta ao app)
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        output_config: { format: { type: "json_schema", schema } },
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: image.media_type, data: image.data } },
            { type: "text", text: prompt },
          ],
        }],
      }),
    });
    if (!r.ok) { res.status(502).json({ error: "ia_falhou", status: r.status }); return; }
    const data = await r.json();
    if (data.stop_reason === "refusal") { res.status(200).json({ error: "refusal" }); return; }
    const text = (data.content || []).find((b) => b.type === "text")?.text;
    let parsed;
    try { parsed = JSON.parse(text); } catch { res.status(502).json({ error: "resposta_invalida" }); return; }
    res.status(200).json(parsed);
  } catch {
    res.status(502).json({ error: "conexao" });
  }
};
