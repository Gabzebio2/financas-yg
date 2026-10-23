/* Navegação, atalhos e acessibilidade. Não altera os dados financeiros. */
"use strict";
document.addEventListener("DOMContentLoaded", () => {
  const wire = (id, fn) => document.querySelector(id)?.addEventListener("click", fn);
  const isVisible = (el) => !!el && !el.closest(".hidden") && el.getClientRects().length > 0;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let section = "#dash-hero";
  const currentScreen = () => document.querySelector(".screen:not(.hidden)")?.id;
  function hasDataset() {
    if (Dashboard.currentDatasetName()) return true;
    goHome(); toast("Abra ou crie uma pasta para continuar."); return false;
  }
  function refreshNavigation() {
    const screen = currentScreen();
    const labels = { "screen-home": "Minhas pastas", "screen-import": "Importar planilha", "screen-dash": "Painel financeiro", "screen-txs": "Transações" };
    document.querySelector("#workspace-location").textContent = `Visão geral / ${labels[screen] || "Finanças YG"}`;
    document.title = `${labels[screen] || "Seu dinheiro"} · Finanças YG`;
    document.querySelectorAll(".sb-item, .bn-item").forEach((btn) => {
      const active = screen === "screen-home" ? /^(sb|bn)-home$/.test(btn.id)
        : screen === "screen-txs" ? /^(sb|bn)-txs$/.test(btn.id)
        : screen === "screen-dash" && btn.dataset.scroll === section;
      if (active) btn.setAttribute("aria-current", "page");
      else btn.removeAttribute("aria-current");
    });
  }
  function scrollToSection(sel) {
    if (!hasDataset()) return;
    if (currentScreen() !== "screen-dash") showScreen("screen-dash");
    section = sel; refreshNavigation();
    requestAnimationFrame(() => document.querySelector(sel)?.scrollIntoView({ behavior: reducedMotion.matches ? "instant" : "smooth", block: "start" }));
  }
  document.querySelectorAll("[data-scroll]").forEach(btn => btn.addEventListener("click", () => scrollToSection(btn.dataset.scroll)));
  wire("#sb-home", goHome); wire("#bn-home", goHome);
  wire("#sb-txs", () => { if (hasDataset()) showScreen("screen-txs"); });
  wire("#dash-view-txs", () => { if (hasDataset()) showScreen("screen-txs"); });
  wire("#bn-txs", () => { if (hasDataset()) showScreen("screen-txs"); });
  wire("#btn-txs-back", () => { section = "#dash-hero"; showScreen("screen-dash"); });
  ["#sb-fab", "#bn-fab", "#btn-txs-add"].forEach(id => wire(id, () => document.querySelector("#btn-add-tx").click()));
  const screenObserver = new MutationObserver(refreshNavigation);
  document.querySelectorAll(".screen").forEach(el => screenObserver.observe(el, { attributes: true, attributeFilter: ["class"] }));
  refreshNavigation();
  function refreshConnection() {
    const el = document.querySelector("#connection-status");
    const offline = !navigator.onLine;
    const state = typeof Cloud !== "undefined" && Cloud.getSyncState ? Cloud.getSyncState() : null;
    const connected = state ? state.connected : !document.querySelector("#cloud-connected").classList.contains("hidden");
    const pending = state?.pendingCount || 0;
    const invalidRemote = state?.invalidRemoteCount || 0;
    const repeatedInvalidNotice = invalidRemote && state?.error === `${invalidRemote} pasta(s) da nuvem têm dados inválidos e foram preservadas sem alterações. Confira essas pastas antes de sincronizá-las.`;
    const errorDetail = repeatedInvalidNotice ? "" : state?.error;
    let label = connected ? "Conta conectada" : "Modo local";
    let detail = "Dados salvos neste navegador. Exporte um backup para guardar uma cópia.";
    if (state) {
      const labels = {
        local: "Modo local", offline: "Sem conexão · salvo aqui", pending: "Envio pendente",
        syncing: "Sincronizando…", synced: "Nuvem em dia", error: "Nuvem indisponível",
        "auth-required": "Entre para sincronizar", unlinked: "Pastas locais",
      };
      label = labels[state.status] || label;
      if (pending) label = state.status === "syncing" ? "Sincronizando…" : `${pending} pasta${pending === 1 ? "" : "s"} pendente${pending === 1 ? "" : "s"}`;
      else if (invalidRemote) label = "Conferir pastas antigas";
      else if (state.otherAccountPending) label = "Pendências de outra conta";
      else if (state.accountConflictCount) label = "Conferir pastas da nuvem";
      if (state.repairing) label = "Corrigindo datas…";
      if (pending) detail = "Alterações salvas neste navegador e aguardando envio à nuvem.";
      else if (invalidRemote) detail = "Há pastas com dados inválidos na nuvem. Elas foram preservadas; as demais pastas podem sincronizar.";
      else if (state.status === "synced") detail = "Todas as alterações vinculadas a esta conta foram confirmadas pela nuvem.";
      if (errorDetail && state.status !== "syncing") detail += ` Motivo: ${errorDetail}`;
      if (!state.autoSync && connected) detail += " A sincronização automática está desativada; use Sincronizar agora.";
      if (state.status === "auth-required") detail += " Entre novamente na mesma conta para enviar as pendências.";
      if (!state.queueDurable) detail += " Não foi possível guardar a fila de envio. Exporte um backup e libere espaço no navegador.";
    }
    if (offline) { label = pending ? `${pending} pendente${pending === 1 ? "" : "s"} · offline` : "Sem conexão · modo local"; detail = "Você pode continuar usando seus dados neste navegador. O envio aguarda a conexão voltar."; }
    el.classList.toggle("offline", offline || !!pending || ["error", "auth-required"].includes(state?.status));
    const dot = document.createElement("i"); dot.setAttribute("aria-hidden", "true");
    el.replaceChildren(dot, document.createTextNode(label));
    el.title = detail;
    const queue = document.querySelector("#cloud-queue-status");
    if (queue) {
      let message = pending ? `${state.pendingUploads} pasta(s) com alterações e ${state.pendingDeletes} exclusão(ões) aguardando confirmação da nuvem. ` : "";
      if (invalidRemote) message += `${invalidRemote} pasta(s) da nuvem têm dados inválidos e foram preservadas sem alterações. As demais pastas podem sincronizar. `;
      if (state?.blockedPendingCount) message += `${state.blockedPendingCount} pendência(s) dependem da correção dessas pastas. `;
      if (errorDetail && state.status !== "syncing") message += `Motivo: ${errorDetail} `;
      if (state?.nextRetryAt && state.autoSync) message += "O app tentará novamente automaticamente. ";
      if (state?.otherAccountPending) message += "Há pendências de outra conta. Entre na conta correspondente para enviá-las. ";
      if (state?.accountConflictCount) message += "Uma pasta da nuvem tem o mesmo identificador de uma pasta de outra conta neste aparelho; ambas foram preservadas nos seus locais de origem. ";
      if (state?.conflictCount) message += "Foram preservadas cópias de conflito. Confira as pastas com “conflito da nuvem” no nome. ";
      if (state?.queueDurable === false) message += "A fila não pôde ser salva. Exporte um backup antes de fechar. ";
      queue.textContent = message.trim(); queue.classList.toggle("hidden", !message);
    }
    const link = document.querySelector("#btn-cloud-link-local"), hint = document.querySelector("#cloud-link-hint");
    if (link && hint) {
      const show = connected && state?.unlinkedCount > 0;
      link.classList.toggle("hidden", !show); hint.classList.toggle("hidden", !show);
      hint.textContent = show ? `${state.unlinkedCount} pasta(s) estão salvas só neste navegador. Para enviá-las à conta conectada, clique em “Vincular pastas locais a esta conta”.` : "";
    }
    const repairArea = document.querySelector("#cloud-repair-actions"), repair = document.querySelector("#btn-cloud-repair");
    const backup = document.querySelector("#btn-cloud-repair-backup"), repairHint = document.querySelector("#cloud-repair-hint");
    if (repairArea && repair && backup && repairHint) {
      const available = connected && state?.repairableRemoteCount > 0;
      const saved = connected && state?.hasRepairBackup;
      const busy = state?.repairing || state?.status === "syncing";
      const needsReview = connected && invalidRemote > 0;
      const show = available || saved || needsReview || (connected && state?.repairing);
      repairArea.classList.toggle("hidden", !show);
      repair.classList.toggle("hidden", !available && !state?.repairing);
      repair.disabled = !available || offline || !!busy;
      repair.textContent = state?.repairing ? "Corrigindo datas…" : "Corrigir datas antigas";
      backup.classList.toggle("hidden", !saved);
      backup.disabled = !saved || !!state?.repairing;
      const formatDate = value => typeof value === "string" ? value.split("-").reverse().join("/") : "";
      const preview = (state?.repairDatePreview || []).slice(0, 6).map(change => `${formatDate(change.before)} → ${formatDate(change.after)}`).join("; ");
      repairHint.textContent = !show ? "" : state?.repairing
        ? "Guardando a cópia anterior e conferindo as datas antes de corrigir a nuvem. Aguarde a confirmação."
        : available
          ? `${state.repairableDateCount} data(s) antiga(s) em ${state.repairableRemoteCount} pasta(s) podem ser corrigidas pela sequência das parcelas.${preview ? ` Datas: ${preview}.` : ""} O app guarda uma cópia dos registros originais antes de alterar as datas e preserva as alterações locais pendentes. Se você já importou uma cópia dessa pasta, as duas serão preservadas.`
          : needsReview
            ? "Os dados antigos foram preservados, mas a correção automática ainda não está disponível para esta pasta. Pode haver uma exclusão pendente, dados de outra conta ou inconsistências que exigem revisão. Nenhuma pasta foi descartada."
            : "A cópia anterior à correção está guardada neste navegador. Baixe o arquivo para manter esse histórico fora do app.";
    }
  }
  wire("#btn-cloud-link-local", () => { if (typeof Cloud !== "undefined") Cloud.linkLocalDatasets?.(); });
  wire("#btn-cloud-repair", () => { if (typeof Cloud !== "undefined") Cloud.repairLegacyDates?.(); });
  wire("#btn-cloud-repair-backup", () => { if (typeof Cloud !== "undefined") Cloud.exportRepairBackup?.(); });
  window.addEventListener("online", refreshConnection); window.addEventListener("offline", refreshConnection);
  document.addEventListener("fyg:cloudstate", refreshConnection);
  new MutationObserver(refreshConnection).observe(document.querySelector("#cloud-connected"), { attributes: true, attributeFilter: ["class"] });
  refreshConnection();
  function refreshAuthOptions() {
    const options = typeof Cloud !== "undefined" ? Cloud.getAuthOptions?.() : null;
    if (!options) return;
    const login = document.querySelector("#btn-cloud-passkey-login");
    const register = document.querySelector("#btn-cloud-passkey-register");
    const link = document.querySelector("#btn-cloud-magic-link");
    const hint = document.querySelector("#cloud-passkey-hint");
    const enabled = options.passkeysEnabled === true && options.passkeysSupported;
    if (login) { login.disabled = !enabled || options.busy; login.textContent = options.busyAction === "passkey-login" ? "Aguardando seu aparelho…" : "Entrar com chave de acesso"; }
    if (register) { register.disabled = !enabled || options.busy; register.textContent = options.busyAction === "passkey-register" ? "Confirme no seu aparelho…" : "Cadastrar chave de acesso"; }
    if (link) {
      const cooldown = Number(options.linkCooldownUntil) > Date.now();
      link.disabled = options.busy || cooldown;
      link.textContent = options.busyAction === "link" ? "Enviando link…" : cooldown ? "Link solicitado · aguarde para reenviar" : "Receber link para entrar";
    }
    ["#btn-cloud-signin", "#btn-cloud-signup"].forEach(id => { const button = document.querySelector(id); if (button) button.disabled = options.busy; });
    if (hint) hint.textContent = options.loading
      ? "Conferindo a disponibilidade de chaves de acesso…"
      : options.passkeysEnabled === false
        ? "Chaves de acesso ainda não foram ativadas neste projeto Supabase. Por enquanto, entre pelo link de e-mail ou pela senha."
        : !options.passkeysSupported
          ? "Este navegador não oferece chaves de acesso neste contexto. Use o link de e-mail ou a senha."
          : options.passkeysEnabled !== true
            ? "Não foi possível conferir as chaves de acesso. Use o link de e-mail ou a senha e confira sua conexão."
            : "A chave de acesso usa a biometria, o PIN ou uma chave de segurança do seu aparelho. Cadastre-a depois de entrar na sua conta. Recurso experimental do Supabase.";
  }
  document.addEventListener("fyg:authoptions", refreshAuthOptions);
  document.addEventListener("fyg:cloudstate", refreshAuthOptions);
  refreshAuthOptions();
  const hideKey = "fyg:hide-money";
  function refreshPrivacy() {
    const on = document.body.classList.contains("hide-money");
    const btn = document.querySelector("#hero-eye");
    btn.setAttribute("aria-pressed", String(on)); btn.setAttribute("aria-label", on ? "Mostrar valores" : "Ocultar valores");
    btn.title = on ? "Mostrar valores" : "Ocultar valores";
  }
  try { document.body.classList.toggle("hide-money", localStorage.getItem(hideKey) === "1"); } catch { /* Preferência opcional. */ }
  refreshPrivacy();
  wire("#hero-eye", () => {
    const on = document.body.classList.toggle("hide-money");
    try { localStorage.setItem(hideKey, on ? "1" : "0"); } catch { /* Preferência opcional. */ }
    refreshPrivacy();
  });
  function describeControls(root) {
    root.querySelectorAll("button[title]").forEach(btn => {
      if (!btn.hasAttribute("aria-label") && !btn.textContent.trim().match(/[a-zÀ-ú]{3}/i)) btn.setAttribute("aria-label", btn.title);
    });
    root.querySelectorAll(".folder-card").forEach(card => {
      card.tabIndex = 0; card.setAttribute("role", "group");
      card.setAttribute("aria-label", `Abrir pasta ${card.querySelector(".folder-name")?.textContent || ""}`);
    });
    root.querySelectorAll('input[type="checkbox"][title]').forEach(el => el.setAttribute("aria-label", el.title));
  }
  describeControls(document);
  new MutationObserver(() => describeControls(document.querySelector("#folders-grid"))).observe(document.querySelector("#folders-grid"), { childList: true, subtree: true });
  new MutationObserver(() => describeControls(document.querySelector("#tx-tbody"))).observe(document.querySelector("#tx-tbody"), { childList: true });
  document.querySelector("#folders-grid").addEventListener("keydown", ev => {
    if ((ev.key === "Enter" || ev.key === " ") && ev.target.classList.contains("folder-card")) { ev.preventDefault(); ev.target.click(); }
  });
  // Diálogos sobrepostos mantêm foco e navegação no diálogo mais recente.
  const modals = Array.from(document.querySelectorAll(".modal-backdrop"));
  let stack = [];
  const returnFocus = new Map();
  const cancelButtons = { "modal-tx": "btn-tx-cancel", "modal-name": "btn-name-cancel", "modal-confirm": "btn-confirm-cancel", "modal-del-parc": "btn-delparc-cancel", "modal-batch": "btn-batch-cancel", "modal-bulk-edit": "btn-bulk-edit-cancel", "modal-meta": "btn-meta-cancel", "modal-limit": "btn-limit-cancel" };
  modals.forEach((bd) => {
    const dialog = bd.querySelector(".modal"), title = dialog.querySelector("h3");
    if (!title.id) title.id = `${bd.id}-heading`;
    dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", title.id); dialog.tabIndex = -1;
  });
  const focusable = (root) => Array.from(root.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')).filter(isVisible);
  function refreshModals() {
    const previous = stack[stack.length - 1];
    const visible = modals.filter(bd => !bd.classList.contains("hidden"));
    const added = visible.filter(bd => !stack.includes(bd));
    added.forEach(bd => returnFocus.set(bd, document.activeElement));
    stack = stack.filter(bd => visible.includes(bd)).concat(added);
    const active = stack[stack.length - 1];
    document.body.classList.toggle("modal-open", !!active);
    document.querySelectorAll("main, .sidebar, .topbar, .bottomnav").forEach(el => { el.inert = !!active; });
    modals.forEach(bd => { bd.inert = !!active && bd !== active; bd.style.zIndex = String(100 + Math.max(0, stack.indexOf(bd))); });
    if (active && active !== previous) {
      requestAnimationFrame(() => {
        const origin = returnFocus.get(previous);
        if (origin?.isConnected && active.contains(origin) && isVisible(origin)) origin.focus();
        else if (!active.contains(document.activeElement)) (focusable(active)[0] || active.querySelector(".modal")).focus();
      });
    } else if (!active && previous) {
      const target = returnFocus.get(previous);
      if (target?.isConnected && isVisible(target)) target.focus();
    }
  }
  const modalObserver = new MutationObserver(refreshModals);
  modals.forEach(bd => modalObserver.observe(bd, { attributes: true, attributeFilter: ["class"] }));
  document.addEventListener("keydown", ev => {
    const active = stack[stack.length - 1];
    if (active) {
      if (ev.key === "Escape") {
        ev.preventDefault(); ev.stopImmediatePropagation();
        const cancel = document.getElementById(cancelButtons[active.id]);
        if (cancel) cancel.click(); else active.classList.add("hidden");
      } else if (ev.key === "Tab") {
        const items = focusable(active), first = items[0], last = items[items.length - 1];
        if (!first) { ev.preventDefault(); active.querySelector(".modal").focus(); }
        else if (ev.shiftKey && (document.activeElement === first || !active.contains(document.activeElement))) { ev.preventDefault(); last.focus(); }
        else if (!ev.shiftKey && (document.activeElement === last || !active.contains(document.activeElement))) { ev.preventDefault(); first.focus(); }
      }
      return;
    }
    if (ev.key === "Escape") document.querySelectorAll(".pop-menu, .cat-dropdown").forEach(el => el.classList.add("hidden"));
    if (ev.target.closest('input, select, textarea, [contenteditable="true"]') || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const inDataset = ["screen-dash", "screen-txs"].includes(currentScreen());
    if (inDataset && ev.key.toLowerCase() === "n") { ev.preventDefault(); document.querySelector("#btn-add-tx").click(); }
    if (inDataset && ev.key === "/") { ev.preventDefault(); showScreen("screen-txs"); document.querySelector("#tx-search").focus(); }
  }, true);
});
