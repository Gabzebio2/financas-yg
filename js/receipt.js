/* ===== Finanças YG — leitura de comprovante com IA (API Anthropic) ===== */
"use strict";

const Receipt = (() => {
  const KEY_STORAGE = "fyg:anthropic-key";
  const MODEL = "claude-haiku-4-5"; // barato e ótimo para ler comprovantes
  const MAX_EDGE = 1568; // redimensiona para economizar tokens sem perder legibilidade
  const PROXY_PATH = "/api/receipt"; // servidor seguro (Vercel) — a chave fica lá, não aqui
  let pendingFile = null; // arquivo aguardando a chave ser salva

  // Onde há servidor próprio (Vercel/domínio), usamos o proxy seguro e o app
  // nunca pede chave. Em uso local (file://) ou GitHub Pages, não há servidor,
  // então cai no modo "colar chave" como alternativa.
  function proxyAvailable() {
    if (location.protocol === "file:") return false;
    const h = location.hostname;
    if (h === "localhost" || h === "127.0.0.1" || h.endsWith("github.io")) return false;
    return true;
  }

  function getKey() {
    return localStorage.getItem(KEY_STORAGE) || "";
  }

  // Mostra/esconde o link de remover a chave conforme haja chave salva
  function refreshKeyUI() {
    $("#btn-apikey-remove").classList.toggle("hidden", !getKey());
  }

  function setStatus(msg, cls) {
    const el = $("#receipt-status");
    el.textContent = msg || "";
    el.className = "receipt-status" + (cls ? " " + cls : "") + (msg ? "" : " hidden");
  }

  // Lê e redimensiona a imagem -> { data (base64 sem prefixo), mediaType }
  function prepareImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("leitura"));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error("imagem"));
        img.onload = () => {
          let { width: w, height: h } = img;
          const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
          w = Math.round(w * scale); h = Math.round(h * scale);
          const canvas = document.createElement("canvas");
          canvas.width = w; canvas.height = h;
          canvas.getContext("2d").drawImage(img, 0, 0, w, h);
          const dataUrl = canvas.toDataURL("image/jpeg", 0.88);
          resolve({ data: dataUrl.split(",")[1], mediaType: "image/jpeg" });
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function buildSchema(categories) {
    return {
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
  }

  function buildPrompt() {
    return `Analise a imagem: é um comprovante financeiro brasileiro (Pix, transferência bancária ou compra).
Extraia os dados da operação. Regras:
- "valor": o valor principal da operação, em reais, como número (ex: 150.75).
- "data": a data em que a operação foi feita, no formato AAAA-MM-DD. Use "" se não estiver visível.
- "descricao": curta e útil, ex: "Pix para João Silva", "Transferência para Maria", "Compra em Mercado X".
- "instituicao": o banco ou app de ONDE SAIU o dinheiro (lado do pagador), ex: Nubank, C6, PicPay, Inter, Wise. Use "" se não der para identificar.
- "categoria": escolha a mais adequada da lista permitida.
- "direcao": "recebido" apenas se o comprovante mostrar dinheiro RECEBIDO pelo dono do app; caso contrário "enviado".`;
  }

  async function analyze(file) {
    if (!file) return;
    const key = getKey();
    // Preferência: se NÃO há chave manual salva e existe servidor próprio,
    // usa o proxy seguro (não pede chave). Uma chave manual salva tem prioridade
    // (modo avançado / uso local).
    if (!key && proxyAvailable()) { analyzeViaProxy(file); return; }
    if (!key) {
      pendingFile = file;
      $("#apikey-wrap").classList.remove("hidden");
      setStatus("Cole sua chave de IA abaixo para continuar 🔑", "err");
      setTimeout(() => $("#apikey-input").focus(), 50);
      return;
    }

    setStatus("Analisando comprovante… 🔎");
    let image;
    try {
      image = await prepareImage(file);
    } catch {
      setStatus("Não consegui abrir essa imagem 😕", "err");
      return;
    }

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 1024,
          output_config: { format: { type: "json_schema", schema: buildSchema(Dashboard.getCats()) } },
          messages: [{
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } },
              { type: "text", text: buildPrompt() },
            ],
          }],
        }),
      });

      if (!res.ok) {
        let msg = `erro ${res.status}`;
        try { msg = (await res.json())?.error?.message || msg; } catch { /* corpo não-JSON */ }
        if (res.status === 401) {
          $("#apikey-wrap").classList.remove("hidden");
          setStatus("Chave inválida — confira e salve novamente 🔑", "err");
        } else {
          setStatus(`A análise falhou: ${msg}`, "err");
        }
        return;
      }

      const data = await res.json();
      if (data.stop_reason === "refusal") {
        setStatus("A IA não conseguiu analisar esta imagem. Preencha manualmente.", "err");
        return;
      }
      const text = (data.content || []).find((b) => b.type === "text")?.text;
      const parsed = JSON.parse(text);
      Dashboard.fillTxFromReceipt(parsed);
      setStatus("Preenchido! Confira os campos antes de salvar ✔", "ok");
    } catch (e) {
      console.error(e);
      setStatus("Sem conexão ou resposta inesperada — tente de novo.", "err");
    }
  }

  // Leitura via servidor seguro (Vercel): o app envia só a imagem + o token
  // de login; a chave da Anthropic nunca passa pelo navegador.
  async function analyzeViaProxy(file) {
    const token = (typeof Cloud !== "undefined" && Cloud.getToken) ? Cloud.getToken() : null;
    if (!token) {
      setStatus("Para ler comprovantes, entre na sua conta na seção “☁️ Sincronizar na nuvem” (é rápido).", "err");
      return;
    }
    setStatus("Analisando comprovante… 🔎");
    let image;
    try { image = await prepareImage(file); }
    catch { setStatus("Não consegui abrir essa imagem 😕", "err"); return; }

    try {
      const res = await fetch(PROXY_PATH, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + token },
        body: JSON.stringify({
          image: { media_type: image.mediaType, data: image.data },
          categories: Dashboard.getCats(),
        }),
      });
      if (res.status === 401) { setStatus("Sua sessão expirou. Entre novamente na seção nuvem.", "err"); return; }
      if (res.status === 501) { setStatus("A leitura por IA ainda não foi ativada no servidor (falta configurar a chave na Vercel).", "err"); return; }
      if (!res.ok) { setStatus(`A análise falhou (erro ${res.status}). Tente de novo.`, "err"); return; }
      const data = await res.json();
      if (data.error === "refusal") { setStatus("A IA não conseguiu ler esta imagem. Preencha manualmente.", "err"); return; }
      if (data.error) { setStatus("Não deu para analisar agora. Tente de novo.", "err"); return; }
      Dashboard.fillTxFromReceipt(data);
      setStatus("Preenchido! Confira os campos antes de salvar ✔", "ok");
    } catch (e) {
      console.error(e);
      setStatus("Sem conexão — tente de novo.", "err");
    }
  }

  /* ---------- Eventos ---------- */
  document.addEventListener("DOMContentLoaded", () => {
    $("#btn-receipt-camera").addEventListener("click", () => $("#receipt-input-camera").click());
    $("#btn-receipt-file").addEventListener("click", () => $("#receipt-input-file").click());
    ["receipt-input-camera", "receipt-input-file"].forEach((id) => {
      $("#" + id).addEventListener("change", (ev) => {
        const file = ev.target.files[0];
        if (file) analyze(file);
        ev.target.value = "";
      });
    });
    $("#btn-apikey-save").addEventListener("click", () => {
      const key = $("#apikey-input").value.trim();
      if (!key.startsWith("sk-ant-")) { toast("A chave deve começar com sk-ant- 🔑"); return; }
      localStorage.setItem(KEY_STORAGE, key);
      $("#apikey-input").value = "";
      $("#apikey-wrap").classList.add("hidden");
      refreshKeyUI();
      toast("Chave salva neste navegador ✔");
      if (pendingFile) { const f = pendingFile; pendingFile = null; analyze(f); }
      else setStatus("");
    });
    $("#btn-apikey-remove").addEventListener("click", () => {
      askConfirm("Remover chave de IA?",
        "A chave salva neste navegador será apagada. Você pode colar outra quando quiser.", () => {
          localStorage.removeItem(KEY_STORAGE);
          pendingFile = null;
          refreshKeyUI();
          setStatus("");
          toast("Chave removida deste navegador ✔");
        });
    });
    refreshKeyUI();
  });

  return { analyze };
})();
