/* ===== Finanças YG — sincronização na nuvem (Supabase) =====
   Segurança:
   - Login com e-mail + senha (Supabase Auth). Os dados na nuvem são
     protegidos por RLS (Row Level Security): o banco só entrega as linhas
     cujo dono é o usuário logado — mesmo alguém com a chave "anon" não lê nada.
   - A URL do projeto e a chave "anon" NÃO são segredos (são públicas por
     design); mesmo assim ficam fora do código: você cola uma vez por aparelho
     e ficam salvas só no navegador.
   - Tudo que chega da nuvem passa pela mesma sanitização dos backups. */
"use strict";

const Cloud = (() => {
  const CFG_STORAGE = "fyg:supabase-config";   // {url, anonKey} por aparelho
  const AUTOSYNC_STORAGE = "fyg:cloud-autosync";
  const TABLE = "pastas";

  // Conexão padrão do projeto — embutida para não precisar colar em cada
  // aparelho. A chave "publishable" é pública por design (o Supabase diz:
  // "can be safely shared publicly"); a proteção real é o login + RLS.
  const DEFAULT_URL = "https://mhgagjhwsjjjwwvopjgu.supabase.co";
  const DEFAULT_KEY = "sb_publishable_fB3B_MW3VgJBcJpUbN1wvg_1Glbr2r5";

  const OWNERS_STORAGE = "fyg:cloud-owners:v1";
  const REPAIR_BACKUP_PREFIX = "fyg:cloud-repair-backup:v1:";
  const RETRY_MS = [5000, 15000, 30000, 60000, 120000, 300000];
  const REQUEST_MS = 20000;
  let client = null, clientCfg = null, session = null, activeOwner = "";
  let syncing = false, applyingRemote = false;
  let pushTimer = null, nextRetryAt = null, retryAttempt = 0;
  let authSubscription = null, connectionVersion = 0;
  let syncPromise = null, syncVersion = -1;
  let queueDurable = true, lastError = "", authRequired = false;
  let accountConflictCount = 0, revisionCounter = 0;
  // Diagnóstico da conexão atual, reavaliado a cada leitura completa da nuvem.
  // Os registros inválidos continuam no servidor e nunca viram uma inserção nova.
  let invalidRemoteIds = new Set();
  let repairableRemoteCount = 0, repairableDateCount = 0, repairDatePreview = [];
  let repairing = false, lastRepairCount = 0, repairRequest = null;
  let passkeysEnabled = null, authOptionsLoading = false, authOptionsError = "";
  let authOperation = null, authSettingsRequest = null, authCooldownTimer = null, linkCooldownUntil = 0;
  // O SDK pode emitir INITIAL_SESSION antes de SIGNED_IN ao abrir um link novo.
  // Esse retorno nunca autoriza vincular automaticamente pastas locais antigas.
  const openedAuthLink = /(?:^|[?#&])(?:access_token|refresh_token|code|token_hash|error_description)=/.test(String(location.hash || "") + String(location.search || ""));
  const queues = new Map();
  const queueReads = new Map();
  const requests = new Set();
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const validId = (id) => typeof id === "string" && /^[a-z0-9_-]{1,200}$/i.test(id) && !["__proto__", "prototype", "constructor"].includes(id);
  const validOwner = (owner) => typeof owner === "string" && /^https:\/\/[a-z0-9-]+\.supabase\.co\|[a-z0-9_-]+$/i.test(owner);
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const revision = () => Date.now().toString(36) + (++revisionCounter).toString(36) + Math.random().toString(36).slice(2, 9);
  const ownerFor = (s) => clientCfg && validId(s?.user?.id) ? `${clientCfg.url}|${s.user.id}` : "";
  const matchesClientCfg = () => {
    const cfg = getCfg();
    return !!clientCfg && cfg?.url === clientCfg.url && cfg?.anonKey === clientCfg.anonKey;
  };
  const ownerParts = (owner) => { const at = owner.lastIndexOf("|"); return { url: owner.slice(0, at), userId: owner.slice(at + 1) }; };
  const queueKey = (owner) => "fyg:cloud-queue:v1:" + owner;
  const isAuto = () => { try { return localStorage.getItem(AUTOSYNC_STORAGE) !== "0"; } catch { return false; } };
  const isOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;
  let ledger = { version: 1, owners: Object.create(null), projects: Object.create(null) };
  function refreshLedger() {
    try {
      const raw = JSON.parse(localStorage.getItem(OWNERS_STORAGE));
      if (raw?.version !== 1) return;
      for (const [id, owner] of Object.entries(raw.owners || {})) if (validId(id) && validOwner(owner)) ledger.owners[id] = owner;
      for (const [project, migrated] of Object.entries(raw.projects || {})) if (/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(project) && migrated === true) ledger.projects[project] = true;
    } catch { /* nenhum dado financeiro é alterado */ }
  }
  refreshLedger();

  function localDatasets() {
    if (typeof Store !== "undefined") return Store.loadIndex().map((entry) => Store._rawDataset(entry.id)).filter(Boolean);
    return typeof buildSyncPayload === "function" ? buildSyncPayload().datasets : [];
  }

  function localDataset(id) {
    return typeof Store !== "undefined" ? Store._rawDataset(id) : localDatasets().find((ds) => ds.id === id) || null;
  }

  function newQueue() { return { version: 1, dirty: Object.create(null), deletes: Object.create(null), base: Object.create(null), conflicts: [], lastSyncedAt: null }; }

  function loadQueue(owner, reload = false) {
    if (!reload && queues.has(owner)) return queues.get(owner);
    let q = newQueue();
    try {
      const raw = JSON.parse(localStorage.getItem(queueKey(owner)));
      if (raw?.version === 1) {
        for (const field of ["dirty", "deletes", "base"]) {
          if (!raw[field] || typeof raw[field] !== "object" || Array.isArray(raw[field])) continue;
          for (const [id, value] of Object.entries(raw[field])) {
            if (validId(id) && value && typeof value === "object") q[field][id] = value;
          }
        }
        q.conflicts = Array.isArray(raw.conflicts) ? raw.conflicts.filter((c) => c && validId(c.sourceId) && validId(c.copyId) && typeof c.digest === "string") : [];
        q.lastSyncedAt = typeof raw.lastSyncedAt === "string" ? raw.lastSyncedAt : null;
      }
      // Migra a fila de exclusões da versão anterior, sem apagá-la antes de confirmar.
      const { url, userId } = ownerParts(owner);
      const deleted = JSON.parse(localStorage.getItem(`fyg:cloud-deletes:${url}:${userId}`));
      if (Array.isArray(deleted)) deleted.filter(validId).forEach((id) => {
        if (!own(q.deletes, id)) q.deletes[id] = { rev: revision() };
        if (!own(ledger.owners, id)) ledger.owners[id] = owner;
      });
    } catch { /* a varredura das pastas recupera envios sem confirmação */ }
    queues.set(owner, q);
    queueReads.set(owner, clone(q));
    return q;
  }

  // Mescla só os metadados da fila entre abas. Remover uma revisão confirmada
  // jamais remove uma revisão nova gravada por outra aba durante a requisição.
  function mergeQueueFromDisk(owner, q) {
    const previous = queueReads.get(owner) || newQueue();
    let disk;
    try { disk = JSON.parse(localStorage.getItem(queueKey(owner))); } catch { return; }
    if (disk?.version !== 1) return;
    for (const field of ["dirty", "deletes", "base"]) {
      const keys = new Set([...Object.keys(disk[field] || {}), ...Object.keys(previous[field] || {})]);
      for (const id of keys) {
        if (!validId(id)) continue;
        const before = previous[field]?.[id], remote = disk[field]?.[id], local = q[field][id];
        if (canonical(remote) === canonical(before)) continue;
        if (canonical(local) === canonical(before)) {
          if (remote && typeof remote === "object") q[field][id] = clone(remote);
          else delete q[field][id];
        } else if (remote && typeof remote === "object") {
          if (!local || field !== "base" && String(remote.queuedAt || "") > String(local.queuedAt || "") || field === "base" && Date.parse(remote.version || 0) > Date.parse(local.version || 0)) q[field][id] = clone(remote);
        }
      }
    }
    for (const entry of Array.isArray(disk.conflicts) ? disk.conflicts : []) {
      if (entry && validId(entry.sourceId) && validId(entry.copyId) && typeof entry.digest === "string" && !q.conflicts.some((v) => v.sourceId === entry.sourceId && v.digest === entry.digest)) q.conflicts.push(entry);
    }
    for (const id of Object.keys(q.dirty)) if (own(q.deletes, id)) {
      if (localDataset(id)) delete q.deletes[id];
      else delete q.dirty[id];
    }
  }

  function persistMetadata() {
    try {
      refreshLedger();
      localStorage.setItem(OWNERS_STORAGE, JSON.stringify(ledger));
      for (const [owner, q] of queues) {
        mergeQueueFromDisk(owner, q);
        localStorage.setItem(queueKey(owner), JSON.stringify(q));
        queueReads.set(owner, clone(q));
        const { url, userId } = ownerParts(owner);
        localStorage.removeItem(`fyg:cloud-deletes:${url}:${userId}`);
      }
      queueDurable = true;
      return true;
    } catch {
      queueDurable = false;
      lastError = "Os dados estão salvos localmente, mas não foi possível guardar a fila de sincronização. Exporte um backup e libere espaço.";
      return false;
    }
  }

  function requireDurableQueue() {
    if (!persistMetadata()) throw Object.assign(new Error(lastError), { name: "QueueStorageError" });
  }

  function markDirty(owner, id) {
    const q = loadQueue(owner);
    q.dirty[id] = { rev: revision(), queuedAt: new Date().toISOString() };
    delete q.deletes[id];
  }

  // A assinatura usa o conteúdo persistido, sem regenerar IDs nem decidir por relógios.
  function canonical(value, root = true) {
    if (Array.isArray(value)) return "[" + value.map((v) => canonical(v, false)).join(",") + "]";
    if (value && typeof value === "object") return "{" + Object.keys(value).filter((key) => !(root && key === "updatedAt")).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key], false)).join(",") + "}";
    return JSON.stringify(value);
  }

  async function fingerprint(text) {
    if (typeof crypto !== "undefined" && crypto.subtle && typeof TextEncoder !== "undefined") {
      const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
      return "sha256:" + Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
    }
    // Contextos antigos sem Web Crypto usam comparação exata, nunca um hash fraco.
    return "json:" + text;
  }

  const repairBackupPrefix = (owner) => REPAIR_BACKUP_PREFIX + encodeURIComponent(owner) + ":";
  function readRepairBackups(owner) {
    if (!owner) return [];
    const prefix = repairBackupPrefix(owner), { url, userId } = ownerParts(owner);
    const entries = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(prefix)) continue;
      const value = localStorage.getItem(key), entry = JSON.parse(value);
      if (entry?.version !== 1 || entry.project !== url || entry.userId !== userId || !validId(entry.id) || entry.dataset?.id !== entry.id) throw new Error("Backup de reparo inválido.");
      entries.push({ key, value, entry });
    }
    return entries;
  }

  function hasRepairBackup() {
    try { return readRepairBackups(activeOwner).length > 0; } catch { return false; }
  }

  function saveRepairBackup(row, analysis, digest, owner, sourceKind = "cloud", sourceRevision = null) {
    try {
      // Backups anteriores sem sourceKind são originais da nuvem. Uma cópia
      // local nunca substitui esse original, mesmo quando os conteúdos coincidem.
      const existing = readRepairBackups(owner).find(({ entry }) => entry.id === row.id && (entry.sourceKind || "cloud") === sourceKind && (entry.sourceRevision || null) === sourceRevision && entry.sourceVersion === row.updated_at && canonical(entry.dataset, false) === canonical(row.data, false));
      if (existing) {
        if (localStorage.getItem(existing.key) !== existing.value) throw new Error("Backup alterado durante a conferência.");
        return;
      }
      const { url, userId } = ownerParts(owner);
      const entry = { version: 1, purpose: "legacy-date-repair", project: url, userId, id: row.id,
        sourceKind, sourceRevision, sourceVersion: row.updated_at, sourceDigest: digest, savedAt: new Date().toISOString(),
        dataset: clone(row.data), changes: clone(analysis?.changes || []) };
      const value = JSON.stringify(entry);
      let key;
      do { key = repairBackupPrefix(owner) + row.id + ":" + revision(); } while (localStorage.getItem(key) !== null);
      // Uma chave nova por original preserva backups de outras abas e revisões.
      localStorage.setItem(key, value);
      if (localStorage.getItem(key) !== value) throw new Error("Não foi possível conferir a gravação.");
    } catch {
      throw Object.assign(new Error("A correção foi interrompida: não foi possível salvar e conferir o backup original neste navegador. Libere espaço antes de tentar novamente; esta pasta não foi alterada."), { name: "RepairBackupError" });
    }
  }

  function exportRepairBackup() {
    if (!activeOwner || !session) { setStatus("Entre na conta de origem para baixar o backup da correção.", "err"); return false; }
    try {
      const entries = readRepairBackups(activeOwner).map(({ entry }) => entry);
      if (!entries.length) { setStatus("Não há backup de correção para esta conta neste navegador."); return false; }
      const data = { app: "financas-yg", version: 1, purpose: "legacy-date-repair", exportedAt: new Date().toISOString(),
        datasets: entries.map((entry) => entry.dataset), repairs: entries };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `financas-yg-antes-da-correcao-${todayISO()}.json`;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      return true;
    } catch { setStatus("Não foi possível baixar o backup da correção. Os originais continuam guardados neste navegador.", "err"); return false; }
  }

  function getSyncState() {
    const owners = new Set(Object.values(ledger.owners));
    if (activeOwner) owners.add(activeOwner);
    let pendingUploads = 0, pendingDeletes = 0, otherAccountPending = 0;
    for (const owner of owners) {
      const q = loadQueue(owner);
      const uploads = Object.keys(q.dirty).length, deletes = Object.keys(q.deletes).length;
      if (!activeOwner || owner === activeOwner) { pendingUploads += uploads; pendingDeletes += deletes; }
      else otherAccountPending += uploads + deletes;
    }
    const q = activeOwner ? loadQueue(activeOwner) : null;
    const pendingCount = pendingUploads + pendingDeletes;
    const invalidRemoteCount = activeOwner ? invalidRemoteIds.size : 0;
    const blockedPendingCount = q ? [...invalidRemoteIds].filter((id) => own(q.dirty, id) || own(q.deletes, id)).length : 0;
    const error = lastError || (invalidRemoteCount
      ? `${invalidRemoteCount} pasta(s) da nuvem têm dados inválidos e foram preservadas sem alterações. Confira essas pastas antes de sincronizá-las.` : null);
    const unlinkedCount = localDatasets().filter((ds) => !own(ledger.owners, ds.id)).length;
    const connected = !!session, autoSync = isAuto();
    let status = "local";
    if (syncing) status = "syncing";
    else if (!queueDurable) status = "error";
    else if (authRequired || (!connected && pendingCount)) status = "auth-required";
    else if (pendingCount && isOffline()) status = "offline";
    else if (pendingCount) status = error ? "error" : "pending";
    else if (error || accountConflictCount) status = "error";
    else if (unlinkedCount) status = "unlinked";
    else if (connected && q?.lastSyncedAt) status = "synced";
    return { status, connected, autoSync, pendingUploads, pendingDeletes, pendingCount, otherAccountPending, unlinkedCount,
      lastSyncedAt: q?.lastSyncedAt || null, nextRetryAt, error, conflictCount: q?.conflicts.length || 0,
      accountConflictCount, invalidRemoteCount, blockedPendingCount, queueDurable,
      repairableRemoteCount, repairableDateCount, repairDatePreview: repairDatePreview.map((pair) => ({ ...pair })),
      repairing, hasRepairBackup: hasRepairBackup(), lastRepairCount };
  }

  function publishState() {
    const state = getSyncState();
    let message;
    if (!state.queueDurable) message = state.error;
    else if (state.repairing) message = "Conferindo o backup e corrigindo somente as datas antigas identificadas…";
    else if (state.status === "syncing") message = "Sincronizando as alterações salvas neste aparelho…";
    else if (state.pendingCount) {
      const count = `${state.pendingCount} alteração(ões) salva(s) neste aparelho, aguardando envio.`;
      if (state.status === "auth-required") message = count + " Entre novamente na conta de origem.";
      else if (!state.autoSync) message = count + " A sincronização automática está desligada.";
      else if (state.status === "offline") message = count + " O envio será retomado quando a conexão voltar com o app aberto.";
      else message = count + (state.nextRetryAt ? " Nova tentativa automática com o app aberto." : "");
      if (state.error) message += " " + state.error;
    } else if (state.error) message = state.error;
    else if (state.unlinkedCount) message = state.connected
      ? "Há pastas locais sem vínculo. Vincule-as explicitamente à conta desejada para enviá-las."
      : "Há pastas locais sem vínculo. Entre na conta desejada para vincular e enviar essas pastas.";
    else if (state.accountConflictCount) message = "Uma pasta da nuvem coincide com dados de outra conta neste aparelho. As duas versões foram mantidas nos seus locais de origem.";
    else if (state.status === "synced") message = "Tudo sincronizado ✔" + (state.conflictCount ? " Versões divergentes foram preservadas em pastas de conflito." : "");
    else message = "Seus dados estão salvos neste aparelho.";
    if (!state.repairing && state.lastRepairCount) message += ` ${state.lastRepairCount} pasta(s) corrigida(s); o backup original está disponível para baixar.`;
    setStatus(message, state.status === "synced" ? "ok" : state.status === "error" ? "err" : state.pendingCount ? "warn" : "");
    if (typeof CustomEvent !== "undefined" && document.dispatchEvent) document.dispatchEvent(new CustomEvent("fyg:cloudstate", { detail: state }));
  }

  function cancelSchedule() { clearTimeout(pushTimer); pushTimer = null; nextRetryAt = null; }
  function cancelRequests() { for (const request of requests) request.cancel(); }

  function scheduleSync(delay = 1500) {
    if (!session || !isAuto() || isOffline()) { publishState(); return; }
    cancelSchedule();
    const version = connectionVersion;
    nextRetryAt = new Date(Date.now() + delay).toISOString();
    pushTimer = setTimeout(() => {
      pushTimer = null; nextRetryAt = null;
      if (version === connectionVersion && session && isAuto()) syncNow({ automatic: true });
    }, delay);
    publishState();
  }

  function retryPending() {
    const q = activeOwner ? loadQueue(activeOwner) : null;
    if (!q || !Object.keys(q.dirty).length && !Object.keys(q.deletes).length || authRequired) return;
    scheduleSync(RETRY_MS[Math.min(retryAttempt++, RETRY_MS.length - 1)]);
  }

  function current(c, version, owner) { return c === client && version === connectionVersion && matchesClientCfg() && !!session && owner === activeOwner; }
  function assertCurrent(c, version, owner) {
    if (c === client && !matchesClientCfg()) { resetConnection(); refreshUI(); }
    if (!current(c, version, owner)) throw Object.assign(new Error("Operação cancelada."), { name: "AbortError" });
  }

  async function request(query) {
    const controller = new AbortController();
    let timer, rejectWait;
    const interrupted = new Promise((_, reject) => { rejectWait = reject; });
    const active = { cancel() { clearTimeout(timer); controller.abort(); rejectWait(Object.assign(new Error("Operação cancelada."), { name: "AbortError" })); } };
    requests.add(active);
    timer = setTimeout(() => { controller.abort(); rejectWait(Object.assign(new Error("A nuvem não respondeu a tempo."), { name: "TimeoutError" })); }, REQUEST_MS);
    try {
      const response = await Promise.race([typeof query.abortSignal === "function" ? query.abortSignal(controller.signal) : query, interrupted]);
      if (response?.error) throw response.error;
      return response;
    } finally { clearTimeout(timer); requests.delete(active); }
  }

  function getCfg() {
    try {
      const c = JSON.parse(localStorage.getItem(CFG_STORAGE));
      if (c && /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(c.url) && typeof c.anonKey === "string" && c.anonKey.length > 20) return c;
    } catch { /* config local inválida: cai no padrão */ }
    if (DEFAULT_URL && DEFAULT_KEY.length > 20) return { url: DEFAULT_URL, anonKey: DEFAULT_KEY };
    return null;
  }

  function setStatus(msg, cls) {
    const el = $("#cloud-status");
    if (!el) return;
    el.textContent = msg || "";
    el.className = "drive-status" + (cls ? " " + cls : "");
  }

  function refreshUI() {
    const connected = !!session;
    $("#cloud-login").classList.toggle("hidden", connected);
    $("#cloud-connected").classList.toggle("hidden", !connected);
    $("#cloud-cfg-hint").classList.toggle("hidden", !!getCfg());
    if (connected) {
      $("#cloud-user").textContent = session.user?.email || "";
      $("#cloud-autosync").checked = isAuto();
    }
    publishAuthOptions();
  }

  function getAuthOptions() {
    const supported = typeof window !== "undefined" && window.isSecureContext === true &&
      typeof window.PublicKeyCredential === "function" && typeof navigator?.credentials?.get === "function" && typeof navigator?.credentials?.create === "function";
    return { passkeysEnabled, passkeysSupported: supported, busy: !!authOperation,
      busyAction: authOperation?.action || null, linkCooldownUntil, loading: authOptionsLoading,
      error: authOptionsError || null };
  }

  function publishAuthOptions() {
    if (typeof CustomEvent !== "undefined" && document.dispatchEvent) document.dispatchEvent(new CustomEvent("fyg:authoptions", { detail: getAuthOptions() }));
  }

  function setAccessStatus(message, error = false) {
    const el = $("#cloud-access-status");
    if (el) { el.textContent = message; el.classList.toggle("err", error); }
  }

  function authCurrent(ticket) {
    return authOperation === ticket && ticket.c === client && ticket.version === connectionVersion &&
      ticket.owner === activeOwner && matchesClientCfg();
  }

  function authAbort() { return Object.assign(new Error("Operação de acesso cancelada."), { name: "AbortError" }); }

  function cancelAuthOperation() {
    const ticket = authOperation;
    if (!ticket) return;
    authOperation = null;
    clearTimeout(ticket.timer); ticket.controller.abort(); ticket.reject(authAbort());
    publishAuthOptions();
  }

  function beginAuthOperation(action, c) {
    if (authOperation) return null;
    const ticket = { action, c, version: connectionVersion, owner: activeOwner, controller: new AbortController(), expectedUserId: null };
    ticket.interrupted = new Promise((_, reject) => { ticket.reject = reject; });
    // Uma cerimônia biométrica pode levar mais tempo que a requisição de e-mail.
    ticket.timer = setTimeout(() => {
      ticket.controller.abort();
      ticket.reject(Object.assign(new Error("A confirmação demorou demais. Tente novamente."), { name: "TimeoutError" }));
    }, action === "link" ? REQUEST_MS : 90000);
    authOperation = ticket;
    publishAuthOptions();
    return ticket;
  }

  function finishAuthOperation(ticket) {
    clearTimeout(ticket.timer);
    if (authOperation === ticket) { authOperation = null; publishAuthOptions(); }
  }

  // O signal do SDK cancela a janela WebAuthn, mas não seu POST de verificação.
  // Proteja também a resposta antes de o SDK persistir uma sessão já cancelada.
  async function guardedAuthFetch(input, options) {
    const url = typeof input === "string" ? input : input?.url || "";
    if (!/\/auth\/v1\/passkeys\//.test(url)) return fetch(input, options);
    const ticket = authOperation;
    if (!ticket || !ticket.action.startsWith("passkey-") || !authCurrent(ticket)) throw authAbort();
    const response = await fetch(input, { ...options, signal: ticket.controller.signal });
    if (!authCurrent(ticket) || ticket.controller.signal.aborted) throw authAbort();
    const readJson = response.json.bind(response);
    response.json = async () => {
      const body = await readJson();
      if (!authCurrent(ticket) || ticket.controller.signal.aborted) throw authAbort();
      if (ticket.action === "passkey-login" && /\/passkeys\/authentication\/verify(?:\?|$)/.test(url) && body?.access_token && validId(body?.user?.id)) ticket.expectedUserId = body.user.id;
      return body;
    };
    return response;
  }

  async function loadAuthOptions(c, cfg) {
    authSettingsRequest?.abort();
    const controller = new AbortController(); authSettingsRequest = controller;
    passkeysEnabled = null; authOptionsLoading = true; authOptionsError = ""; publishAuthOptions();
    let timer;
    try {
      if (typeof fetch !== "function") throw new Error("Consulta indisponível.");
      timer = setTimeout(() => controller.abort(), 10000);
      const response = await fetch(cfg.url + "/auth/v1/settings", { headers: { apikey: cfg.anonKey }, signal: controller.signal });
      if (!response.ok) throw new Error("Consulta indisponível.");
      const settings = await response.json();
      if (c !== client || authSettingsRequest !== controller || !matchesClientCfg()) return;
      passkeysEnabled = settings?.passkeys_enabled === true;
    } catch {
      if (c === client && authSettingsRequest === controller && matchesClientCfg()) authOptionsError = "Não foi possível verificar a disponibilidade das chaves de acesso. O login por senha e e-mail continua disponível.";
    } finally {
      clearTimeout(timer);
      if (c === client && authSettingsRequest === controller) { authSettingsRequest = null; authOptionsLoading = false; publishAuthOptions(); }
    }
  }

  function authErrorMessage(error) {
    const code = error?.code || "", name = error?.name || "";
    if (code === "passkey_disabled") { passkeysEnabled = false; return "As chaves de acesso ainda não foram habilitadas neste projeto. Use e-mail e senha ou o link de acesso."; }
    if (name === "NotAllowedError" || name === "AbortError" || code === "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY" && /cancel|notallowed/i.test(error?.message || "")) return "Confirmação cancelada. Você pode tentar novamente ou usar outra forma de entrada.";
    if (name === "TimeoutError") return "A confirmação demorou demais. Tente novamente.";
    if (code === "webauthn_credential_exists") return "Este dispositivo já tem uma chave de acesso cadastrada para a conta.";
    if (code === "webauthn_credential_not_found") return "Nenhuma chave de acesso foi reconhecida. Entre com e-mail e senha e cadastre uma chave.";
    if (code === "email_not_confirmed" || code === "phone_not_confirmed") return "Confirme seu e-mail antes de cadastrar ou usar uma chave de acesso.";
    if (code === "over_email_send_rate_limit" || code === "over_request_rate_limit" || error?.status === 429) return "Muitas tentativas. Aguarde um minuto antes de pedir outro link.";
    if (code === "otp_disabled" || code === "signup_disabled") return "Use o e-mail de uma conta já cadastrada. Este app não cria uma conta ao enviar o link.";
    return "Não foi possível concluir o acesso. Confira a conexão e tente novamente, ou entre com e-mail e senha.";
  }

  async function sendSignInLink() {
    if (authOperation) return false;
    if (session) { setAccessStatus("Você já está conectado à sua conta."); return false; }
    const email = $("#cloud-email")?.value.trim() || "";
    if (!/^\S+@\S+\.\S+$/.test(email)) { setAccessStatus("Digite o e-mail da sua conta para receber o link.", true); return false; }
    if (Date.now() < linkCooldownUntil) { setAccessStatus("Aguarde um minuto antes de pedir outro link."); return false; }
    let ticket;
    try {
      const c = ensureClient();
      if (!c) { setAccessStatus("A conexão está indisponível. Tente novamente com internet.", true); return false; }
      ticket = beginAuthOperation("link", c);
      if (!ticket) return false;
      linkCooldownUntil = Date.now() + 60000;
      clearTimeout(authCooldownTimer);
      authCooldownTimer = setTimeout(() => { authCooldownTimer = null; publishAuthOptions(); }, 60000);
      publishAuthOptions(); setAccessStatus("Enviando o link de acesso…");
      const result = await Promise.race([c.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: location.origin + location.pathname } }), ticket.interrupted]);
      if (!authCurrent(ticket)) return false;
      if (result?.error) throw result.error;
      setAccessStatus("Se este e-mail pertence a uma conta cadastrada, você receberá um link para entrar. Confira também o spam.");
      return true;
    } catch (error) {
      if (!ticket || authCurrent(ticket)) setAccessStatus(authErrorMessage(error), true);
      return false;
    } finally { if (ticket) finishAuthOperation(ticket); }
  }

  async function usePasskey(register) {
    if (authOperation) return false;
    let ticket;
    try {
      const c = ensureClient(), options = getAuthOptions();
      if (!c || options.passkeysEnabled !== true) { setAccessStatus("As chaves de acesso ainda não estão disponíveis neste projeto. Use e-mail e senha ou o link de acesso.", true); return false; }
      if (!options.passkeysSupported) { setAccessStatus("Este navegador não oferece chaves de acesso. Abra o app em um navegador atualizado com HTTPS.", true); return false; }
      if (register && !session) { setAccessStatus("Entre na sua conta antes de cadastrar uma chave de acesso.", true); return false; }
      if (!register && session) { setAccessStatus("Você já está conectado à sua conta."); return false; }
      ticket = beginAuthOperation(register ? "passkey-register" : "passkey-login", c);
      if (!ticket) return false;
      setAccessStatus(register ? "Confirme no dispositivo para cadastrar sua chave de acesso…" : "Confirme a chave de acesso no dispositivo para entrar…");
      const method = register ? "registerPasskey" : "signInWithPasskey";
      const result = await Promise.race([c.auth[method]({ options: { signal: ticket.controller.signal } }), ticket.interrupted]);
      if (!authCurrent(ticket)) return false;
      if (result?.error) throw result.error;
      if (register) {
        if (!result?.data?.id) throw new Error("Cadastro não confirmado.");
        setAccessStatus("Chave de acesso cadastrada. Na próxima entrada, confirme com a biometria ou o PIN do dispositivo.");
      } else {
        if (!result?.data?.session?.user?.id) throw new Error("Sessão não confirmada.");
        if (!session) activateSession(result.data.session, "SIGNED_IN", ticket);
        if (!authCurrent(ticket) || session?.user?.id !== result.data.session.user.id) return false;
        setAccessStatus("Entrada confirmada com sua chave de acesso.");
        await syncNow();
      }
      return true;
    } catch (error) {
      if (!ticket || authCurrent(ticket)) { setAccessStatus(authErrorMessage(error), true); publishAuthOptions(); }
      return false;
    } finally { if (ticket) finishAuthOperation(ticket); }
  }

  function signInWithPasskey() { return usePasskey(false); }
  function registerPasskey() { return usePasskey(true); }

  function ensureClient() {
    if (client && !matchesClientCfg()) resetConnection();
    if (client) return client;
    const cfg = getCfg();
    if (!cfg) return null;
    if (typeof supabase === "undefined" || typeof supabase.createClient !== "function") {
      setStatus("A conexão com a nuvem está indisponível. Seus dados locais continuam disponíveis; tente novamente com internet.", "err");
      return null;
    }
    clientCfg = { url: cfg.url, anonKey: cfg.anonKey };
    client = supabase.createClient(clientCfg.url, clientCfg.anonKey, { auth: { experimental: { passkey: true } },
      ...(typeof fetch === "function" ? { global: { fetch: guardedAuthFetch } } : {}) });
    const currentClient = client;
    const { data } = client.auth.onAuthStateChange((ev, s) => {
      if (currentClient !== client) return;
      const ticket = authOperation;
      const accepted = ev === "SIGNED_IN" && ticket?.action === "passkey-login" && authCurrent(ticket) && ticket.expectedUserId === s?.user?.id ? ticket : null;
      activateSession(s, ev, accepted);
      // Usuário abriu o link "esqueci minha senha" do e-mail: o app carrega já
      // autenticado em modo recuperação — só falta digitar a senha nova.
      if (ev === "PASSWORD_RECOVERY") showNewPassUI();
    });
    authSubscription = data?.subscription;
    void loadAuthOptions(currentClient, { ...clientCfg });
    return client;
  }

  function resetConnection() {
    cancelAuthOperation(); authSettingsRequest?.abort(); authSettingsRequest = null;
    clearTimeout(authCooldownTimer); authCooldownTimer = null; linkCooldownUntil = 0;
    passkeysEnabled = null; authOptionsLoading = false; authOptionsError = "";
    cancelSchedule();
    cancelRequests();
    connectionVersion++;
    authSubscription?.unsubscribe();
    authSubscription = null;
    client = null;
    clientCfg = null;
    session = null;
    activeOwner = "";
    invalidRemoteIds.clear();
    resetRepairState();
    lastError = "";
    authRequired = false;
    publishState();
    publishAuthOptions();
  }

  function activateSession(nextSession, event, acceptedAuth = null) {
    // Um evento de autenticação pode chegar antes do evento storage de outra aba.
    // Nunca atribua a sessão do cliente antigo ao novo projeto configurado.
    if (!matchesClientCfg()) { resetConnection(); refreshUI(); return; }
    const nextOwner = ownerFor(nextSession);
    const changed = nextOwner !== activeOwner;
    if (changed) {
      if (authOperation && authOperation !== acceptedAuth) cancelAuthOperation();
      cancelSchedule(); cancelRequests(); connectionVersion++;
      retryAttempt = 0; lastError = ""; accountConflictCount = 0;
      invalidRemoteIds.clear();
      resetRepairState();
    }
    session = nextSession;
    activeOwner = nextOwner;
    if (acceptedAuth && authOperation === acceptedAuth) { acceptedAuth.version = connectionVersion; acceptedAuth.owner = activeOwner; }
    authRequired = false;
    if (activeOwner) {
      loadQueue(activeOwner);
      const project = clientCfg.url;
      // Somente uma sessão já existente pode migrar automaticamente a instalação
      // antiga. Um login novo exige vínculo explícito para pastas sem proprietário.
      if (event === "INITIAL_SESSION" && !openedAuthLink && !own(ledger.projects, project)) linkUnowned(localDatasets().map((ds) => ds.id));
      ledger.projects[project] = true;
      persistMetadata();
    }
    refreshUI();
    publishState();
    if (session && isAuto() && (changed || event === "TOKEN_REFRESHED")) scheduleSync(0);
  }

  function linkUnowned(ids) {
    if (!activeOwner) return 0;
    let linked = 0;
    for (const id of ids) {
      if (!validId(id) || own(ledger.owners, id) || !localDataset(id)) continue;
      ledger.owners[id] = activeOwner;
      markDirty(activeOwner, id);
      linked++;
    }
    return linked;
  }

  function linkLocalDatasets(ids) {
    if (!session) { setStatus("Entre na conta de destino antes de vincular as pastas locais.", "err"); return 0; }
    const selected = typeof ids === "string" ? [ids] : Array.isArray(ids) ? ids : localDatasets().map((ds) => ds.id);
    const count = linkUnowned(selected);
    persistMetadata(); publishState();
    if (count) scheduleSync(0);
    return count;
  }

  function showNewPassUI() {
    const wrap = $("#cloud-newpass-wrap");
    if (!wrap) return;
    wrap.classList.remove("hidden");
    setStatus("Quase lá! Digite a nova senha abaixo para concluir a redefinição 🔑");
    $("#cloud-card")?.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => $("#cloud-newpass").focus(), 300);
  }

  /* ---------- Sincronização ---------- */
  function writeLocal(datasets) {
    applyingRemote = true;
    try { Store.saveDatasets(datasets, { preserveUpdatedAt: true, origin: "remote" }); }
    finally { applyingRemote = false; }
    renderFolders();
    if (typeof Dashboard !== "undefined") Dashboard.refreshFromStore?.({ force: true });
  }

  function validRemote(row) {
    const raw = row?.data;
    if (!validId(row?.id) || !raw || raw.id !== row.id || !Array.isArray(raw.transactions)) return false;
    if (typeof sanitizeDataset === "function" && !sanitizeDataset(raw, { preserveIds: true, preserveContent: true, rejectInvalidTransactions: true })) return false;
    return typeof raw.updatedAt === "string" && Number.isFinite(Date.parse(raw.updatedAt));
  }

  function resetRepairState() {
    repairableRemoteCount = 0; repairableDateCount = 0; repairDatePreview = [];
    lastRepairCount = 0; repairing = false; repairRequest = null;
  }

  function analyzeRepair(row) {
    if (validRemote(row) || !validId(row?.id) || !row?.data || typeof row.data !== "object" || typeof CloudRepair === "undefined" || typeof CloudRepair.analyzeDataset !== "function") return null;
    const analysis = CloudRepair.analyzeDataset(clone(row.data));
    if (!analysis?.repairable || !Array.isArray(analysis.changes) || !analysis.changes.length || !validRemote({ ...row, data: analysis.dataset })) return null;
    // Defesa adicional: o helper pode alterar apenas o campo date das transações.
    const unchanged = clone(analysis.dataset);
    if (unchanged.transactions.length !== row.data.transactions.length) return null;
    unchanged.transactions.forEach((tx, index) => { tx.date = row.data.transactions[index].date; });
    if (canonical(unchanged, false) !== canonical(row.data, false)) return null;
    return analysis;
  }

  function repairPlan(row, owner, hasRemote = true) {
    if (!validId(row?.id)) return null;
    refreshLedger();
    const q = loadQueue(owner);
    mergeQueueFromDisk(owner, q);
    const knownOwner = ledger.owners[row.id], local = localDataset(row.id);
    if (own(q.deletes, row.id) || knownOwner && knownOwner !== owner || !knownOwner && local) return null;
    if (own(q.dirty, row.id) && (knownOwner !== owner || !local)) return null;
    const remoteAnalysis = hasRemote ? analyzeRepair(row) : null;
    if (hasRemote && !validRemote(row) && !remoteAnalysis) return null;
    const localRow = local ? { id: row.id, data: local, updated_at: local.updatedAt } : null;
    const localAnalysis = localRow ? analyzeRepair(localRow) : null;
    // Nunca restaurar uma cópia da nuvem por cima de alterações locais cuja
    // integridade não pôde ser comprovada pelo reparo estrito.
    if (localRow && !validRemote(localRow) && !localAnalysis) return null;
    if (!remoteAnalysis && !localAnalysis) return null;
    const changes = new Map();
    for (const change of [...(remoteAnalysis?.changes || []), ...(localAnalysis?.changes || [])]) changes.set(JSON.stringify([change.transactionId, change.before, change.after]), change);
    return { remoteAnalysis, localAnalysis, localRow, localText: canonical(local, false),
      localRevision: q.dirty[row.id]?.rev || null, knownOwner, changes: [...changes.values()] };
  }

  function repairRows(rowsById, owner) {
    const rows = new Map(rowsById);
    for (const id of Object.keys(loadQueue(owner).dirty)) if (!rows.has(id)) rows.set(id, { id });
    return rows;
  }

  function sameRepairLocal(row, owner, plan) {
    refreshLedger();
    const q = loadQueue(owner);
    mergeQueueFromDisk(owner, q);
    return !own(q.deletes, row.id) && ledger.owners[row.id] === plan.knownOwner &&
      (q.dirty[row.id]?.rev || null) === plan.localRevision && canonical(localDataset(row.id), false) === plan.localText;
  }

  function classifyRemote(rowsById, owner) {
    invalidRemoteIds = new Set([...rowsById].filter(([, row]) => !validRemote(row)).map(([id]) => id));
    repairableRemoteCount = 0; repairableDateCount = 0; repairDatePreview = [];
    for (const row of repairRows(rowsById, owner).values()) {
      const plan = repairPlan(row, owner, rowsById.has(row.id));
      if (!plan) continue;
      repairableRemoteCount++; repairableDateCount += plan.changes.length;
      for (const { before, after } of plan.changes) if (repairDatePreview.length < 6 && !repairDatePreview.some((pair) => pair.before === before && pair.after === after)) repairDatePreview.push({ before, after });
    }
  }

  async function readRemoteRows(c, version, owner) {
    const response = await request(c.from(TABLE).select("id,data,updated_at").eq("user_id", ownerParts(owner).userId));
    assertCurrent(c, version, owner);
    if (!Array.isArray(response.data)) throw new Error("Resposta inválida da nuvem.");
    return new Map(response.data.map((row) => [row?.id, row]));
  }

  async function repairRemoteRows(rowsById, owner, c, version) {
    for (const row of repairRows(rowsById, owner).values()) {
      assertCurrent(c, version, owner);
      const hasRemote = rowsById.has(row.id), plan = repairPlan(row, owner, hasRemote);
      if (!plan) continue;
      const digest = hasRemote ? await fingerprint(canonical(row.data, false)) : null;
      assertCurrent(c, version, owner);
      const localDigest = plan.localRow ? await fingerprint(plan.localText) : null;
      assertCurrent(c, version, owner);
      // Também recupera saves que terminaram antes de o hook dirty ser gravado.
      await rescan(owner, c, version);
      assertCurrent(c, version, owner);
      if (!sameRepairLocal(row, owner, plan)) continue;
      // Ambos os originais são conferidos antes de qualquer mudança financeira.
      if (hasRemote) saveRepairBackup(row, plan.remoteAnalysis, digest, owner);
      if (plan.localRow) saveRepairBackup(plan.localRow, plan.localAnalysis, localDigest, owner, "local", plan.localRevision);
      assertCurrent(c, version, owner);
      if (!sameRepairLocal(row, owner, plan)) continue;
      if (plan.localAnalysis) {
        const repairedLocal = clone(plan.localAnalysis.dataset);
        repairedLocal.updatedAt = new Date(Math.max(Date.now(), Date.parse(repairedLocal.updatedAt) + 1 || 0)).toISOString();
        // Save normal: cria uma revisão pendente nova e mantém a base intacta.
        Store.saveDataset(repairedLocal, { preserveUpdatedAt: true });
        requireDurableQueue();
        plan.localText = canonical(repairedLocal, false);
        plan.localRevision = loadQueue(owner).dirty[row.id]?.rev || null;
        renderFolders();
        if (typeof Dashboard !== "undefined") Dashboard.refreshFromStore?.({ force: true });
      }
      assertCurrent(c, version, owner);
      if (!sameRepairLocal(row, owner, plan)) continue;
      if (plan.remoteAnalysis) {
        const repaired = clone(plan.remoteAnalysis.dataset);
        repaired.updatedAt = new Date(Math.max(Date.now(), Date.parse(row.data.updatedAt) + 1 || 0, Date.parse(row.updated_at) + 1 || 0)).toISOString();
        const result = await request(guardVersion(c.from(TABLE).update({ data: repaired, updated_at: repaired.updatedAt }).eq("id", row.id), row, ownerParts(owner).userId).select("id"));
        assertCurrent(c, version, owner);
        if (!Array.isArray(result.data) || result.data.length !== 1) throw new Error("A pasta mudou na nuvem durante a correção. Esta versão não foi sobrescrita; os backups e as alterações locais foram mantidos. Sincronize e revise antes de tentar novamente.");
      }
      lastRepairCount++;
      publishState();
    }
  }

  function repairLegacyDates() {
    if (!session || !client) { setStatus("Entre na conta de origem antes de corrigir as datas.", "err"); return Promise.resolve(false); }
    const c = client, version = connectionVersion, owner = activeOwner;
    if (repairRequest && repairRequest.c === c && repairRequest.version === version && repairRequest.owner === owner) return repairRequest.promise;
    const ticket = { c, version, owner, promise: null };
    repairRequest = ticket; repairing = true; lastRepairCount = 0;
    ticket.promise = Promise.resolve().then(() => syncNow({ repairLegacy: true, repairContext: ticket })).finally(() => {
      if (repairRequest === ticket) { repairRequest = null; repairing = false; publishState(); }
    });
    publishState();
    return ticket.promise;
  }

  async function rescan(owner, c, version) {
    mergeQueueFromDisk(owner, loadQueue(owner));
    for (const ds of localDatasets()) {
      if (ledger.owners[ds.id] !== owner) continue;
      const q = loadQueue(owner);
      if (own(q.deletes, ds.id) || own(q.dirty, ds.id)) continue;
      const text = canonical(ds), digest = await fingerprint(text);
      assertCurrent(c, version, owner);
      if (canonical(localDataset(ds.id)) !== text) { markDirty(owner, ds.id); continue; }
      if (q.base[ds.id]?.digest !== digest) markDirty(owner, ds.id);
    }
    requireDurableQueue();
  }

  function preserveConflict(owner, sourceId, remote, digest) {
    const q = loadQueue(owner);
    let entry = q.conflicts.find((item) => item.sourceId === sourceId && item.digest === digest);
    if (!entry) {
      entry = { sourceId, digest, copyId: uid() };
      q.conflicts.push(entry);
      ledger.owners[entry.copyId] = owner;
      markDirty(owner, entry.copyId);
      // Reserva o ID antes de salvar: se o app fechar, a próxima tentativa reutiliza-o.
      requireDurableQueue();
    }
    if (!localDataset(entry.copyId)) {
      const copy = clone(remote);
      copy.id = entry.copyId;
      const suffix = " — conflito da nuvem";
      copy.name = String(remote.name || "Pasta").slice(0, 80 - suffix.length) + suffix;
      copy.updatedAt = new Date().toISOString();
      writeLocal([copy]);
    }
    return entry.copyId;
  }

  async function reconcileRow(row, owner, c, version, attempt = 0) {
    assertCurrent(c, version, owner);
    refreshLedger();
    mergeQueueFromDisk(owner, loadQueue(owner));
    if (invalidRemoteIds.has(row?.id) || !validRemote(row)) {
      invalidRemoteIds.add(row?.id);
      return;
    }
    const id = row.id, q = loadQueue(owner);
    const knownOwner = ledger.owners[id];
    const local = localDataset(id);
    if (knownOwner && knownOwner !== owner || !knownOwner && local) { accountConflictCount++; return; }
    if (!knownOwner) { ledger.owners[id] = owner; requireDurableQueue(); }
    const localText = canonical(local), remoteText = canonical(row.data);
    const remoteDigest = await fingerprint(remoteText);
    const localDigest = local ? await fingerprint(localText) : null;
    assertCurrent(c, version, owner);
    mergeQueueFromDisk(owner, loadQueue(owner));
    // Uma edição durante o hash/pull deve ser avaliada antes de gravar qualquer retorno.
    if (canonical(localDataset(id)) !== localText) {
      if (attempt >= 3) throw new Error("Há novas alterações locais. A sincronização continuará na próxima tentativa.");
      return reconcileRow(row, owner, c, version, attempt + 1);
    }
    const latest = loadQueue(owner);
    if (own(latest.deletes, id)) {
      if (latest.base[id]?.digest !== remoteDigest) preserveConflict(owner, id, row.data, remoteDigest);
      latest.base[id] = { digest: remoteDigest, version: row.updated_at };
      requireDurableQueue();
      return;
    }
    if (local && latest.base[id]?.digest !== localDigest && !own(latest.dirty, id)) markDirty(owner, id);
    if (local && own(latest.dirty, id)) {
      if (localDigest === remoteDigest) {
        latest.base[id] = { digest: remoteDigest, version: row.updated_at };
        delete latest.dirty[id];
      } else if (latest.base[id]?.digest !== remoteDigest) {
        preserveConflict(owner, id, row.data, remoteDigest);
        latest.base[id] = { digest: remoteDigest, version: row.updated_at };
      }
      requireDurableQueue();
      return;
    }
    if (!local || localDigest !== remoteDigest) writeLocal([clone(row.data)]);
    latest.base[id] = { digest: remoteDigest, version: row.updated_at };
    requireDurableQueue();
  }

  function guardVersion(query, row, userId) {
    query = query.eq("user_id", userId);
    if (row.updated_at == null) return query.is("updated_at", null);
    return query.eq("updated_at", row.updated_at);
  }

  async function pushDirty(rowsById, owner, c, version) {
    const userId = ownerParts(owner).userId;
    let invalidLocalCount = 0;
    // Inclui as cópias de conflito criadas durante o pull, antes de qualquer exclusão.
    for (const id of Object.keys(loadQueue(owner).dirty)) {
      assertCurrent(c, version, owner);
      if (invalidRemoteIds.has(id) || ledger.owners[id] !== owner || own(loadQueue(owner).deletes, id)) continue;
      const observed = rowsById.get(id);
      if (observed) await reconcileRow(observed, owner, c, version);
      assertCurrent(c, version, owner);
      const entry = loadQueue(owner).dirty[id];
      if (!entry) continue;
      const saved = localDataset(id);
      if (!saved) throw new Error("Uma pasta pendente não está disponível localmente. A fila foi mantida para recuperação.");
      if (!validRemote({ id, data: saved })) {
        // Uma outra aba pode ter gravado durante o CAS de reparo. Atualize a
        // ação disponível para corrigir a origem local sem reenviar a data ruim.
        classifyRemote(rowsById, owner);
        invalidLocalCount++;
        continue;
      }
      const snapshot = clone(saved), text = canonical(snapshot), digest = await fingerprint(text);
      assertCurrent(c, version, owner);
      refreshLedger();
      mergeQueueFromDisk(owner, loadQueue(owner));
      if (ledger.owners[id] !== owner || own(loadQueue(owner).deletes, id)) continue;
      if (loadQueue(owner).dirty[id]?.rev !== entry.rev || canonical(localDataset(id)) !== text) continue;
      // O CAS precisa avançar até quando dois saves ocorreram no mesmo milissegundo.
      snapshot.updatedAt = new Date(Math.max(Date.now(), Date.parse(snapshot.updatedAt) + 1 || 0, Date.parse(observed?.updated_at) + 1 || 0)).toISOString();
      const row = { user_id: userId, id, data: snapshot, updated_at: snapshot.updatedAt };
      requireDurableQueue();
      const result = observed
        ? await request(guardVersion(c.from(TABLE).update({ data: snapshot, updated_at: snapshot.updatedAt }).eq("id", id), observed, userId).select("id"))
        : await request(c.from(TABLE).insert(row).select("id"));
      assertCurrent(c, version, owner);
      if (!Array.isArray(result.data) || result.data.length !== 1) throw new Error("A versão da nuvem mudou durante o envio. Suas alterações continuam na fila.");
      const latest = loadQueue(owner);
      latest.base[id] = { digest, version: snapshot.updatedAt };
      if (latest.dirty[id]?.rev === entry.rev && canonical(localDataset(id)) === text) delete latest.dirty[id];
      requireDurableQueue();
    }
    return invalidLocalCount;
  }

  async function flushDeletions(rowsById, owner, c, version) {
    for (const id of Object.keys(loadQueue(owner).deletes)) {
      assertCurrent(c, version, owner);
      if (invalidRemoteIds.has(id) || ledger.owners[id] !== owner) continue;
      const entry = loadQueue(owner).deletes[id], observed = rowsById.get(id);
      if (observed) {
        await reconcileRow(observed, owner, c, version);
        // Se surgiu uma cópia de conflito ainda não enviada, retome no próximo ciclo.
        const q = loadQueue(owner);
        if (q.conflicts.some((item) => item.sourceId === id && own(q.dirty, item.copyId))) continue;
        if (q.deletes[id]?.rev !== entry.rev) continue;
        const result = await request(guardVersion(c.from(TABLE).delete().eq("id", id), observed, ownerParts(owner).userId).select("id"));
        assertCurrent(c, version, owner);
        if (!Array.isArray(result.data) || result.data.length !== 1) throw new Error("A pasta mudou na nuvem durante a exclusão. A exclusão continua pendente.");
      }
      const latest = loadQueue(owner);
      if (latest.deletes[id]?.rev === entry.rev) { delete latest.deletes[id]; delete latest.base[id]; }
      requireDurableQueue();
    }
  }

  async function syncNow(options = {}) {
    const repairContext = options.repairContext;
    if (options.repairLegacy && (!repairContext || !current(repairContext.c, repairContext.version, repairContext.owner))) return false;
    if (!session || !client) { setStatus("Entre na sua conta para sincronizar.", "err"); return false; }
    if (options.automatic && !isAuto()) return false;
    if (isOffline()) { publishState(); return false; }
    if (syncPromise) {
      if (!options.repairLegacy && syncVersion === connectionVersion) return syncPromise;
      await syncPromise;
      return syncNow(options);
    }
    cancelSchedule();
    const c = client, version = connectionVersion, owner = activeOwner;
    syncVersion = version;
    syncing = true;
    accountConflictCount = 0;
    publishState();
    syncPromise = (async () => {
      try {
        await rescan(owner, c, version);
        let rowsById = await readRemoteRows(c, version, owner);
        // Classifique antes de aplicar qualquer retorno: uma pasta antiga inválida
        // não bloqueia as demais, mas seu ID permanece protegido contra escrita.
        classifyRemote(rowsById, owner);
        if (options.repairLegacy) {
          if (typeof CloudRepair === "undefined") throw new Error("O recurso de correção não foi carregado. Atualize o app antes de tentar novamente.");
          await repairRemoteRows(rowsById, owner, c, version);
          rowsById = await readRemoteRows(c, version, owner);
          classifyRemote(rowsById, owner);
        }
        for (const row of rowsById.values()) await reconcileRow(row, owner, c, version);
        await rescan(owner, c, version);
        const invalidLocalCount = await pushDirty(rowsById, owner, c, version);
        await flushDeletions(rowsById, owner, c, version);
        assertCurrent(c, version, owner);
        if (invalidLocalCount) throw new Error("Uma pasta local contém dados inválidos e não foi enviada. As alterações continuam salvas e pendentes. Use a correção de datas, quando disponível, ou revise a pasta antes de sincronizar.");
        if (!invalidRemoteIds.size) retryAttempt = 0;
        lastError = ""; authRequired = false;
        const q = loadQueue(owner);
        if (!invalidRemoteIds.size && !Object.keys(q.dirty).length && !Object.keys(q.deletes).length) q.lastSyncedAt = new Date().toISOString();
        requireDurableQueue();
        return invalidRemoteIds.size === 0;
      } catch (e) {
        if (current(c, version, owner)) {
          lastError = String(e?.message || "A nuvem está indisponível.").slice(0, 250);
          authRequired = e?.status === 401 || e?.code === "PGRST301" || /jwt.*expired|invalid.*jwt/i.test(lastError);
        }
        return false;
      } finally {
        syncing = false;
        syncPromise = null;
        publishState();
        if (current(c, version, owner)) {
          if (lastError || invalidRemoteIds.size) retryPending();
          else if (Object.keys(loadQueue(owner).dirty).length || Object.keys(loadQueue(owner).deletes).length) scheduleSync(1500);
        }
      }
    })();
    return syncPromise;
  }

  /* ---------- Login / conta ---------- */
  async function signInOrUp(isSignUp) {
    const c = ensureClient();
    if (!c) { showCfgSetup(); setStatus("Configure a conexão primeiro (uma vez só) 👇", "err"); return; }
    const email = $("#cloud-email").value.trim();
    const pass = $("#cloud-pass").value;
    if (!/^\S+@\S+\.\S+$/.test(email)) { toast("Digite um e-mail válido 📧"); return; }
    if (pass.length < 8) { toast("A senha precisa ter pelo menos 8 caracteres 🔑"); return; }

    setStatus(isSignUp ? "Criando conta…" : "Entrando…");
    try {
      const { data, error } = isSignUp
        ? await c.auth.signUp({ email, password: pass })
        : await c.auth.signInWithPassword({ email, password: pass });
      if (c !== client) return;
      if (error) throw error;
      activateSession(data.session, "SIGNED_IN");
      if (!session) {
        // signUp com confirmação de e-mail ligada
        setStatus("Conta criada! Confirme pelo link enviado ao seu e-mail e depois clique em Entrar.", "ok");
        return;
      }
      $("#cloud-pass").value = "";
      refreshUI();
      await syncNow();
      toast("Nuvem conectada ✔");
    } catch (e) {
      console.error(e);
      const raw = e.message || "";
      const msg = /invalid login credentials/i.test(raw)
        ? "E-mail ou senha incorretos. Confira se digitou o MESMO e-mail dos outros aparelhos; se esqueceu a senha, use “esqueci minha senha” logo abaixo."
        : /signups not allowed/i.test(raw)
          ? "Sua conta JÁ EXISTE — em aparelho novo, use o botão “Entrar” (os cadastros foram trancados de propósito na configuração)."
        : /email not confirmed/i.test(raw)
          ? "Este e-mail ainda não foi confirmado — procure o link de confirmação na caixa de entrada/spam."
        : /failed to fetch|network|load failed/i.test(raw)
          ? "Não consegui falar com a nuvem. Confira a internet; se o projeto foi pausado, reative-o no painel Supabase."
        : /rate limit|too many|security purposes/i.test(raw)
          ? "Muitas tentativas em sequência — aguarde um minuto e tente de novo."
        : raw || "erro inesperado";
      setStatus("Não deu para " + (isSignUp ? "criar a conta" : "entrar") + ": " + msg, "err");
    }
  }

  async function logout() {
    cancelAuthOperation(); setAccessStatus("");
    const previousSession = session;
    const previousInvalidRemoteIds = new Set(invalidRemoteIds);
    const previousRepairState = { repairableRemoteCount, repairableDateCount, repairDatePreview, lastRepairCount };
    const c = client;
    cancelSchedule();
    cancelRequests();
    connectionVersion++;
    session = null;
    activeOwner = "";
    invalidRemoteIds.clear();
    resetRepairState();
    try {
      const result = await c?.auth.signOut({ scope: "local" });
      if (result?.error) throw result.error;
    } catch {
      if (client === c) {
        session = previousSession; activeOwner = ownerFor(previousSession); invalidRemoteIds = previousInvalidRemoteIds;
        ({ repairableRemoteCount, repairableDateCount, repairDatePreview, lastRepairCount } = previousRepairState);
      }
      refreshUI();
      setStatus("Não foi possível sair da conta. Confira a conexão e tente novamente.", "err");
      return;
    }
    if (c !== client) return;
    refreshUI();
    publishState();
    toast("Nuvem desconectada.");
  }

  // "Esqueci minha senha": manda o e-mail de redefinição. O link abre o app
  // de volta (redirectTo) e o gancho PASSWORD_RECOVERY mostra o campo de nova senha.
  async function forgotPassword() {
    const c = ensureClient();
    if (!c) { showCfgSetup(); setStatus("Configure a conexão primeiro (uma vez só) 👇", "err"); return; }
    const email = $("#cloud-email").value.trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      toast("Digite seu e-mail no campo acima e clique de novo 📧");
      $("#cloud-email").focus();
      return;
    }
    setStatus("Enviando e-mail de redefinição…");
    try {
      const { error } = await c.auth.resetPasswordForEmail(email, {
        redirectTo: location.origin + location.pathname,
      });
      if (error) throw error;
      setStatus("Enviado ✔ Abra o link do e-mail NESTE aparelho — ele volta pro app já no passo de criar a nova senha. (Não chegou? Veja o spam.)", "ok");
    } catch (e) {
      console.error(e);
      const raw = e.message || "";
      const msg = /rate limit|too many|security purposes/i.test(raw)
        ? "Muitas tentativas em sequência — aguarde uns minutos e tente de novo."
        : raw || "erro inesperado";
      setStatus("Não deu para enviar a redefinição: " + msg, "err");
    }
  }

  async function saveNewPassword() {
    const pass = $("#cloud-newpass").value;
    if (pass.length < 8) { toast("A nova senha precisa ter pelo menos 8 caracteres 🔑"); $("#cloud-newpass").focus(); return; }
    if (!client) return;
    setStatus("Salvando nova senha…");
    try {
      const { error } = await client.auth.updateUser({ password: pass });
      if (error) throw error;
      $("#cloud-newpass").value = "";
      $("#cloud-newpass-wrap").classList.add("hidden");
      refreshUI();
      setStatus("Senha atualizada ✔ Você já está conectado neste aparelho.", "ok");
      toast("Nova senha salva ✔");
      await syncNow();
    } catch (e) {
      console.error(e);
      const raw = e.message || "";
      const msg = /should be different/i.test(raw) ? "A nova senha precisa ser diferente da anterior."
        : /session|jwt|token/i.test(raw) ? "O link de redefinição expirou — peça outro em “esqueci minha senha”."
        : raw || "erro inesperado";
      setStatus("Não deu para salvar a nova senha: " + msg, "err");
    }
  }

  /* ---------- Ganchos chamados pelo app ---------- */
  // Mudança local -> agenda um envio (debounce)
  function onLocalChange(ids) {
    if (applyingRemote) return;
    refreshLedger();
    const selected = typeof ids === "string" ? [ids] : Array.isArray(ids) ? ids : localDatasets().map((ds) => ds.id);
    for (const id of selected) {
      if (!validId(id) || !localDataset(id)) continue;
      let owner = ledger.owners[id];
      // Somente a notificação de uma gravação sob a sessão atual cria um vínculo novo.
      if (!owner && activeOwner) { owner = activeOwner; ledger.owners[id] = owner; }
      if (owner) markDirty(owner, id);
    }
    persistMetadata();
    publishState();
    if (!syncing && activeOwner && (selected.length || typeof Store === "undefined")) scheduleSync(1500);
  }

  // O Store inclui estas escritas no mesmo commit da exclusão local. Nenhuma
  // requisição ou mutação de memória ocorre antes de o commit ser concluído.
  function prepareLocalDelete(id) {
    refreshLedger();
    const owner = ledger.owners[id];
    if (!owner || !validId(id)) return [];
    const q = clone(loadQueue(owner));
    // O evento storage de outra aba pode ainda não ter sido entregue. Preserve
    // suas exclusões antes de preparar a escrita atômica junto com o Store.
    mergeQueueFromDisk(owner, q);
    q.deletes[id] = { rev: revision(), queuedAt: new Date().toISOString() };
    delete q.dirty[id];
    return [{ key: queueKey(owner), value: JSON.stringify(q) }];
  }

  function onLocalDelete(id) {
    if (applyingRemote || !validId(id)) return;
    const owner = ledger.owners[id];
    if (!owner) { publishState(); return; }
    const q = loadQueue(owner, true);
    if (!own(q.deletes, id)) q.deletes[id] = { rev: revision(), queuedAt: new Date().toISOString() };
    delete q.dirty[id];
    persistMetadata(); publishState();
    if (!syncing && owner === activeOwner) scheduleSync(1500);
  }

  /* ---------- Configuração (URL + chave anon) ---------- */
  function showCfgSetup() {
    const cfg = getCfg();
    $("#cloud-cfg-wrap").classList.remove("hidden");
    $("#cloud-url-input").value = cfg?.url || "";
    $("#cloud-key-input").value = cfg?.anonKey || "";
    setTimeout(() => $("#cloud-url-input").focus(), 50);
  }

  /* ---------- Inicialização e eventos ---------- */
  async function init() {
    const c = ensureClient();
    const initialVersion = connectionVersion;
    refreshUI();
    if (!c) return;
    try {
      const { data } = await c.auth.getSession();
      if (c !== client || initialVersion !== connectionVersion) return;
      activateSession(data.session, "INITIAL_SESSION");
      refreshUI();
      if (session && isAuto()) {
        await syncNow();
      }
    } catch (e) { console.error(e); }
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("#btn-cloud-magic-link")?.addEventListener("click", sendSignInLink);
    $("#btn-cloud-passkey-login")?.addEventListener("click", signInWithPasskey);
    $("#btn-cloud-passkey-register")?.addEventListener("click", registerPasskey);
    $("#btn-cloud-signin").addEventListener("click", () => signInOrUp(false));
    $("#btn-cloud-signup").addEventListener("click", () => signInOrUp(true));
    $("#cloud-pass").addEventListener("keydown", (ev) => { if (ev.key === "Enter") signInOrUp(false); });
    $("#btn-cloud-logout").addEventListener("click", logout);
    $("#btn-cloud-sync-now").addEventListener("click", syncNow);
    $("#btn-cloud-forgot").addEventListener("click", forgotPassword);
    $("#btn-cloud-newpass-save").addEventListener("click", saveNewPassword);
    $("#cloud-newpass").addEventListener("keydown", (ev) => { if (ev.key === "Enter") saveNewPassword(); });
    $("#cloud-autosync").addEventListener("change", (ev) => {
      try { localStorage.setItem(AUTOSYNC_STORAGE, ev.target.checked ? "1" : "0"); }
      catch { setStatus("Não foi possível salvar a preferência de sincronização.", "err"); return; }
      if (ev.target.checked) scheduleSync(0);
      else { cancelSchedule(); cancelRequests(); connectionVersion++; }
      publishState();
    });

    $("#btn-cloud-setup-link").addEventListener("click", showCfgSetup);
    $("#btn-cloud-cfg-save").addEventListener("click", () => {
      const url = $("#cloud-url-input").value.trim().replace(/\/+$/, "");
      const anonKey = $("#cloud-key-input").value.trim();
      if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url)) {
        toast("A URL deve ser como https://abcdefgh.supabase.co");
        return;
      }
      if (anonKey.length < 20) { toast("Cole a chave anon completa 🔑"); return; }
      localStorage.setItem(CFG_STORAGE, JSON.stringify({ url, anonKey }));
      resetConnection(); // invalida requisições e ouvintes da conexão anterior
      $("#cloud-cfg-wrap").classList.add("hidden");
      refreshUI();
      toast("Conexão configurada ✔ Agora crie sua conta ou entre.");
    });
    $("#btn-cloud-cfg-clear").addEventListener("click", () => {
      localStorage.removeItem(CFG_STORAGE);
      resetConnection();
      $("#cloud-cfg-wrap").classList.add("hidden");
      refreshUI();
      toast("Configuração removida deste navegador.");
    });

    init();
  });

  function resumePending() {
    if (activeOwner && isAuto() && (getSyncState().pendingCount || lastError)) scheduleSync(0);
  }
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("online", resumePending);
    window.addEventListener("offline", () => { cancelSchedule(); publishState(); });
    window.addEventListener("storage", (event) => {
      if (event.key === CFG_STORAGE) {
        resetConnection(); refreshUI();
      } else if (event.key === AUTOSYNC_STORAGE) {
        if (!isAuto()) { cancelSchedule(); cancelRequests(); connectionVersion++; }
        else resumePending();
        publishState();
      } else if (activeOwner && event.key === queueKey(activeOwner)) {
        loadQueue(activeOwner, true); publishState(); resumePending();
      } else if (event.key === OWNERS_STORAGE) {
        refreshLedger(); publishState();
      } else if (activeOwner && event.key?.startsWith(repairBackupPrefix(activeOwner))) {
        publishState();
      } else if (event.key?.startsWith("fyg:ds:") && activeOwner) {
        resumePending();
      }
    });
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "hidden") resumePending();
  });

  // Token da sessão atual (usado pela leitura de comprovante via servidor seguro)
  function getToken() {
    return session?.access_token || null;
  }

  return { onLocalChange, onLocalDelete, getToken, getSyncState, getAuthOptions, sendSignInLink, signInWithPasskey, registerPasskey, linkLocalDatasets, prepareLocalDelete, repairLegacyDates, exportRepairBackup };
})();
