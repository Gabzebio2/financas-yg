/* ===== WhatsApp — status real e revisão dos rascunhos do piloto ===== */
"use strict";

const WhatsApp = (() => {
  const ENDPOINT = "/api/whatsapp-config";
  const INTERVAL = 60000;
  let accountToken = null, generation = 0, requestJob = null, actionJob = null;
  let timer = null, lastRead = 0, data = null, phase = "signed-out", feedback = "", feedbackError = false;
  const el = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const text = (value, max = 240) => typeof value === "string" ? value.slice(0, max) : "";
  const record = (value) => !!value && typeof value === "object" && !Array.isArray(value);
  const token = () => {
    try { const value = typeof Cloud !== "undefined" ? Cloud.getToken?.() : null; return typeof value === "string" && value ? value : null; }
    catch { return null; }
  };
  const online = () => typeof navigator === "undefined" || navigator.onLine !== false;
  const visible = () => document.visibilityState !== "hidden" && !el("screen-home")?.classList.contains("hidden");
  const active = (job) => job.generation === generation && job.token === accountToken && token() === job.token;
  function clearTimer() { if (timer !== null) clearTimeout(timer); timer = null; }
  function schedule() {
    clearTimer();
    if (!accountToken || !online() || !visible() || requestJob || actionJob) return;
    timer = setTimeout(() => { timer = null; refresh(); }, INTERVAL);
  }
  function session() {
    const current = token();
    if (current !== accountToken) {
      generation++; requestJob?.controller.abort(); actionJob?.controller.abort();
      accountToken = current; requestJob = null; actionJob = null;
      data = null; lastRead = 0; feedback = ""; feedbackError = false;
      phase = current ? "loading" : "signed-out"; clearTimer(); render();
    }
    return current;
  }
  function masked(value) {
    const digits = text(value, 100).replace(/\D/g, "");
    return digits ? "•••• " + digits.slice(-4) : "Remetente autorizado";
  }
  function safeWebhook(value) {
    try {
      const url = new URL(value);
      if (url.origin !== location.origin || url.pathname !== "/api/whatsapp" || url.search || url.hash || url.username || url.password) return "";
      return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)) ? url.href : "";
    } catch { return ""; }
  }
  function normalize(raw) {
    if (!record(raw) || typeof raw.configured !== "boolean" || typeof raw.enabled !== "boolean" || !Array.isArray(raw.pending)) throw new Error("invalid-response");
    const channel = record(raw.channel) ? {
      folderId: text(raw.channel.folderId, 160), folderName: text(raw.channel.folderName, 160),
      testNumber: text(raw.channel.testNumber, 40).replace(/[^\d+ ()-]/g, ""),
      senders: Array.isArray(raw.channel.senders) ? raw.channel.senders.slice(0, 10).map((sender) => masked(record(sender) ? sender.masked : sender)) : [],
    } : null;
    const seen = new Set();
    const pending = raw.pending.slice(0, 100).map((draft) => {
      if (!record(draft) || draft.status !== "pending" || typeof draft.id !== "string" || !draft.id || draft.id.length > 160 || seen.has(draft.id)) throw new Error("invalid-draft");
      seen.add(draft.id);
      const tx = record(draft.transaction) ? draft.transaction : {};
      return {
        id: draft.id, revision: text(draft.revision, 240), summary: text(draft.summary, 240),
        senderMasked: masked(draft.senderMasked), folderId: text(draft.folderId, 160), folderName: text(draft.folderName, 160),
        warnings: Array.isArray(draft.warnings) ? draft.warnings.filter((v) => typeof v === "string").slice(0, 12).map((v) => text(v, 280)) : [],
        canConfirm: draft.canConfirm === true,
        transaction: { date: text(tx.date, 40), desc: text(tx.desc, 240), amount: tx.amount, currency: text(tx.currency, 12), type: text(tx.type, 12), category: text(tx.category, 160), account: text(tx.account, 160) },
      };
    });
    return { configured: raw.configured, enabled: raw.enabled, actionsReady: raw.actionsReady === true, channel, pending, webhookUrl: safeWebhook(raw.webhookUrl) };
  }
  function validDraft(draft) {
    const tx = draft.transaction;
    return !!draft.revision && !!draft.folderId && !!draft.folderName &&
      typeof isValidISODate === "function" && isValidISODate(tx.date) &&
      typeof tx.amount === "number" && Number.isFinite(tx.amount) && tx.amount > 0 &&
      typeof CURRENCY_CODES !== "undefined" && CURRENCY_CODES.includes(tx.currency) &&
      ["receita", "despesa"].includes(tx.type) && !!tx.desc.trim() && !!tx.category.trim();
  }
  function draftMoney(tx) {
    if (typeof tx.amount !== "number" || !Number.isFinite(tx.amount) || tx.amount <= 0 || !CURRENCY_CODES.includes(tx.currency)) return "Valor a conferir";
    const formatted = fmtMoney(tx.amount, tx.currency);
    return formatted.includes(tx.currency) ? formatted : formatted + " · " + tx.currency;
  }
  function draftHTML(draft) {
    const tx = draft.transaction, valid = validDraft(draft);
    const available = phase === "ready" && online() && data?.actionsReady && !requestJob && !actionJob;
    const confirm = available && draft.canConfirm && valid;
    const date = typeof isValidISODate === "function" && isValidISODate(tx.date) ? tx.date.split("-").reverse().join("/") : "Não identificada";
    const warnings = draft.warnings.map((warning) => `<li>${esc(warning)}</li>`).join("");
    const reason = !data?.actionsReady ? "As ações ainda não estão disponíveis. Aguarde a preparação da integração."
      : !draft.canConfirm || !valid ? "Rejeite este rascunho e reenvie a mensagem com data, valor, moeda e categoria completos."
      : "";
    return `<article class="wa-draft" data-wa-draft="${esc(draft.id)}"><div class="wa-draft-heading"><div><h4>${esc(draft.summary || tx.desc || "Mensagem para revisar")}</h4><p class="wa-draft-origin">${esc(draft.senderMasked)}</p></div><div class="wa-draft-amount">${esc(draftMoney(tx))}<small>${tx.type === "receita" ? "Receita" : tx.type === "despesa" ? "Despesa" : "Tipo a conferir"}</small></div></div>
      <dl class="wa-draft-fields"><div><dt>Data</dt><dd>${esc(date)}</dd></div><div><dt>Categoria</dt><dd>${esc(tx.category || "Não identificada")}</dd></div><div><dt>Conta</dt><dd>${esc(tx.account || "Sem conta")}</dd></div><div><dt>Pasta de destino</dt><dd>${esc(draft.folderName || "Não identificada")}</dd></div><div><dt>Descrição</dt><dd>${esc(tx.desc || "Não identificada")}</dd></div><div><dt>Moeda original</dt><dd>${esc(CURRENCY_CODES.includes(tx.currency) ? tx.currency : "Não identificada")}</dd></div></dl>
      ${warnings ? `<ul class="wa-draft-warnings">${warnings}</ul>` : ""}<div class="wa-draft-actions"><button type="button" class="btn btn-primary btn-sm" data-wa-action="confirm" data-wa-id="${esc(draft.id)}" ${confirm ? "" : "disabled"}>${actionJob?.draftId === draft.id && actionJob.action === "confirm" ? "Confirmando…" : "Confirmar lançamento"}</button><button type="button" class="btn btn-ghost btn-sm" data-wa-action="reject" data-wa-id="${esc(draft.id)}" ${available && draft.revision ? "" : "disabled"}>${actionJob?.draftId === draft.id && actionJob.action === "reject" ? "Rejeitando…" : "Rejeitar"}</button></div>${reason ? `<p class="wa-draft-blocked">${esc(reason)}</p>` : ""}</article>`;
  }
  function render() {
    if (!el("whatsapp-panel")) return;
    const pending = data?.pending || [];
    const live = phase === "ready" && data?.configured && data?.enabled && data?.channel?.folderId;
    const descriptions = {
      "signed-out": ["Entre na sua conta", "Entre na conta do app para consultar o piloto.", "Conecte sua conta para consultar as mensagens pendentes."],
      loading: ["Consultando…", "Consultando o estado do piloto nesta conta.", "Aguarde a consulta das mensagens."],
      offline: ["Sem conexão", "Conecte-se à internet e atualize para conferir o piloto.", "As ações ficam indisponíveis sem conexão."],
      auth: ["Entre novamente", "Entre novamente na conta do app para consultar o piloto.", "Sua sessão precisa ser renovada."],
      unavailable: ["Piloto em preparação", "O serviço do WhatsApp ainda não está disponível neste endereço. Nenhum lançamento foi confirmado.", "A revisão será liberada quando o serviço estiver pronto."],
      error: ["Consulta indisponível", "Não foi possível consultar o piloto. Atualize para tentar novamente.", "A confirmação fica desativada até uma nova consulta."],
    };
    const status = descriptions[phase] || [pending.length ? `${pending.length} para revisar` : live ? "Recebimento ativo" : "Em preparação",
      live ? "O piloto está recebendo mensagens dos remetentes autorizados. Todo lançamento precisa de confirmação."
        : data?.configured ? "O canal está configurado, mas o recebimento está pausado. Confira as pendências já recebidas."
          : "A conexão com a Meta ainda está sendo preparada. O recebimento de mensagens não está ativo.",
      "Nenhuma mensagem pendente de revisão nesta conta."];
    el("wa-status-badge").textContent = status[0];
    el("wa-status-badge").dataset.state = pending.length ? "pending" : live ? "active" : "idle";
    el("wa-status").textContent = status[1];
    el("wa-guide-note").textContent = live ? "O recebimento está ativo. Confira cada rascunho antes de confirmar sua inclusão na pasta."
      : "O piloto começa com confirmação para cada lançamento. Aguarde o status de recebimento ativo antes de testar as mensagens.";
    el("wa-refresh").disabled = !accountToken || !!requestJob || !!actionJob;
    el("wa-pending-count").textContent = pending.length ? `${pending.length} pendente${pending.length === 1 ? "" : "s"}` : "";
    el("wa-empty").textContent = status[2]; el("wa-empty").classList.toggle("hidden", pending.length > 0);
    el("wa-drafts").innerHTML = pending.map(draftHTML).join("");
    el("wa-feedback").textContent = feedback; el("wa-feedback").dataset.error = String(feedbackError);
    el("wa-feedback").classList.toggle("hidden", !feedback);
    const channel = data?.channel;
    el("wa-channel").classList.toggle("hidden", !channel);
    el("wa-channel").innerHTML = channel ? `<dl><dt>Pasta vinculada</dt><dd>${esc(channel.folderName || "Aguardando vínculo")}</dd></dl><dl><dt>Número de teste</dt><dd>${esc(channel.testNumber || "Aguardando configuração")}</dd></dl><dl><dt>Remetentes autorizados</dt><dd>${esc(channel.senders.length ? channel.senders.join(", ") : "Aguardando autorização")}</dd></dl>` : "";
    el("wa-webhook-wrap").classList.toggle("hidden", !data?.webhookUrl);
    el("wa-webhook").value = data?.webhookUrl || "";
  }
  async function fetchJSON(job, body) {
    const timeout = setTimeout(() => job.controller.abort(), 12000);
    try {
      const response = await fetch(ENDPOINT, {
        method: body ? "POST" : "GET", headers: { Authorization: "Bearer " + job.token, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: job.controller.signal,
        credentials: "omit", cache: "no-store", redirect: "error",
      });
      if (!response.ok) { const error = new Error("request-failed"); error.status = response.status; throw error; }
      return await response.json();
    } finally { clearTimeout(timeout); }
  }
  function refresh(options = {}) {
    if (!session()) { render(); return Promise.resolve(); }
    if (typeof location !== "undefined" && location.protocol === "file:") { phase = "unavailable"; render(); return Promise.resolve(); }
    if (!online()) { phase = "offline"; clearTimer(); render(); return Promise.resolve(); }
    if (requestJob) return requestJob.promise;
    if (actionJob) return Promise.resolve();
    if (!options.force && data && Date.now() - lastRead < INTERVAL) { schedule(); return Promise.resolve(); }
    clearTimer(); phase = "loading";
    const job = { token: accountToken, generation, controller: new AbortController() };
    requestJob = job; render();
    job.promise = fetchJSON(job).then((raw) => {
      if (!active(job)) return;
      data = normalize(raw); phase = online() ? "ready" : "offline"; lastRead = Date.now();
    }).catch((error) => {
      if (!active(job)) return;
      data = null;
      phase = [401, 403].includes(error.status) ? "auth" : [404, 405, 501, 503].includes(error.status) ? "unavailable" : "error";
    }).finally(() => {
      if (requestJob === job) { requestJob = null; session(); render(); schedule(); }
    });
    return job.promise;
  }
  async function applyAction(action, draftId) {
    if (!session() || phase !== "ready" || requestJob || actionJob || !online() || !data?.actionsReady) return;
    const draft = data.pending.find((item) => item.id === draftId);
    if (!draft || !draft.revision || !["confirm", "reject"].includes(action) || (action === "confirm" && (!draft.canConfirm || !validDraft(draft)))) return;
    const job = { token: accountToken, generation, controller: new AbortController(), draftId, action };
    actionJob = job; feedback = ""; feedbackError = false; clearTimer(); render();
    let successful = false;
    try {
      const response = await fetchJSON(job, { action, draftId, revision: draft.revision });
      if (!active(job)) return;
      const expected = action === "confirm" ? "confirmed" : "rejected";
      if (!record(response) || response.ok !== true || response.draftId !== draftId || response.status !== expected) throw new Error("unconfirmed-result");
      successful = true;
      data.pending = data.pending.filter((item) => item.id !== draftId);
      feedback = action === "confirm" ? "Lançamento confirmado na nuvem. Atualizando suas pastas…" : "Rascunho rejeitado. Nenhum lançamento foi incluído.";
      render();
      if (action === "confirm") {
        try {
          if (typeof Cloud.syncNow !== "function") throw new Error("sync-unavailable");
          await Cloud.syncNow({ fresh: true });
          if (active(job)) feedback = "Lançamento confirmado na nuvem. Sincronização solicitada para atualizar suas pastas.";
        } catch { if (active(job)) feedback = "Lançamento confirmado na nuvem. Use Sincronizar agora para atualizar as pastas neste aparelho."; }
      }
    } catch (error) {
      if (!active(job)) return;
      feedbackError = true;
      if ([401, 403].includes(error.status)) { data = null; phase = "auth"; feedback = "Entre novamente na conta para continuar a revisão."; }
      else if (error.status === 409) feedback = "Esta mensagem mudou ou já foi revisada. Atualize a lista antes de continuar.";
      else feedback = "Não foi possível confirmar o resultado. Atualize a lista antes de tentar novamente; a solicitação pode ter chegado ao servidor.";
      if (phase !== "auth") phase = "error";
    } finally {
      if (actionJob === job) { actionJob = null; session(); render(); if (successful && accountToken === job.token) await refresh({ force: true }); else schedule(); }
    }
  }
  function init() {
    if (!el("whatsapp-panel")) return;
    el("wa-refresh").addEventListener("click", () => { feedback = ""; refresh({ force: true }); });
    el("whatsapp-panel").addEventListener("toggle", () => { if (el("whatsapp-panel").open) refresh(); });
    el("wa-drafts").addEventListener("click", (event) => {
      const button = event.target.closest("[data-wa-action]");
      if (!button || button.disabled || !el("wa-drafts").contains(button)) return;
      applyAction(button.dataset.waAction, button.dataset.waId);
    });
    document.addEventListener("fyg:cloudstate", () => { const before = accountToken; session(); if (before !== accountToken) refresh({ force: true }); });
    document.addEventListener("visibilitychange", () => { if (visible()) refresh(); else clearTimer(); });
    if (typeof MutationObserver === "function" && el("screen-home")) {
      new MutationObserver(() => { if (visible()) refresh(); else clearTimer(); }).observe(el("screen-home"), { attributes: true, attributeFilter: ["class"] });
    }
    window.addEventListener("online", () => refresh({ force: true }));
    window.addEventListener("offline", () => { phase = accountToken ? "offline" : "signed-out"; clearTimer(); render(); });
    refresh();
  }
  document.addEventListener("DOMContentLoaded", init);
  return { refresh };
})();
