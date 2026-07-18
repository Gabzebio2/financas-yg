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

  let client = null;
  let session = null;
  let syncing = false;   // trava anti-loop enquanto puxa da nuvem
  let pushTimer = null;

  const isAuto = () => localStorage.getItem(AUTOSYNC_STORAGE) !== "0"; // padrão ligado

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
  }

  function ensureClient() {
    if (client) return client;
    const cfg = getCfg();
    if (!cfg) return null;
    client = supabase.createClient(cfg.url, cfg.anonKey);
    client.auth.onAuthStateChange((ev, s) => {
      session = s;
      refreshUI();
      // Usuário abriu o link "esqueci minha senha" do e-mail: o app carrega já
      // autenticado em modo recuperação — só falta digitar a senha nova.
      if (ev === "PASSWORD_RECOVERY") showNewPassUI();
    });
    return client;
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
  async function pull() {
    syncing = true;
    try {
      const { data, error } = await client.from(TABLE).select("id,data,updated_at");
      if (error) throw error;
      const raws = (data || []).map((r) => r.data);
      const { added, updated } = mergeCloudDatasets(raws); // sanitiza tudo
      renderFolders();
      return added + updated;
    } finally { syncing = false; }
  }

  async function push() {
    const payload = buildSyncPayload();
    const rows = payload.datasets.map((ds) => ({ id: ds.id, data: ds, updated_at: ds.updatedAt }));
    if (!rows.length) return;
    const { error } = await client.from(TABLE).upsert(rows);
    if (error) throw error;
  }

  async function syncNow() {
    setStatus("Sincronizando…");
    try {
      const n = await pull();
      await push();
      setStatus(n ? `Sincronizado — ${n} pasta(s) atualizada(s) ✔` : "Tudo sincronizado ✔", "ok");
    } catch (e) {
      console.error(e);
      setStatus("Falha ao sincronizar: " + (e.message || e), "err");
    }
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
      if (error) throw error;
      session = data.session;
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
          ? "Não consegui falar com a nuvem. Confira a internet; se o projeto Supabase ficou semanas sem uso, ele hiberna — entre em supabase.com e clique em “Restore project”."
        : /rate limit|too many|security purposes/i.test(raw)
          ? "Muitas tentativas em sequência — aguarde um minuto e tente de novo."
        : raw || "erro inesperado";
      setStatus("Não deu para " + (isSignUp ? "criar a conta" : "entrar") + ": " + msg, "err");
    }
  }

  async function logout() {
    try { await client?.auth.signOut(); } catch { /* offline: segue */ }
    session = null;
    refreshUI();
    setStatus("Desconectado. Seus dados locais continuam intactos.");
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
  function onLocalChange() {
    if (!session || syncing || !isAuto()) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(async () => {
      try { await push(); setStatus("Salvo na nuvem ✔", "ok"); }
      catch (e) { setStatus("Falha ao salvar na nuvem: " + (e.message || e), "err"); }
    }, 1500);
  }

  // Pasta excluída localmente -> remove a linha correspondente na nuvem
  function onLocalDelete(id) {
    if (!session || syncing || !isAuto()) return;
    client.from(TABLE).delete().eq("id", id)
      .then(({ error }) => {
        if (error) setStatus("Falha ao excluir na nuvem: " + error.message, "err");
      })
      .catch((e) => setStatus("Falha ao excluir na nuvem: " + (e.message || e), "err"));
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
    refreshUI();
    if (!c) return;
    try {
      const { data } = await c.auth.getSession();
      session = data.session;
      refreshUI();
      if (session && isAuto()) {
        const n = await pull();
        if (n) setStatus(`${n} pasta(s) atualizada(s) da nuvem ✔`, "ok");
      }
    } catch (e) { console.error(e); }
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("#btn-cloud-signin").addEventListener("click", () => signInOrUp(false));
    $("#btn-cloud-signup").addEventListener("click", () => signInOrUp(true));
    $("#cloud-pass").addEventListener("keydown", (ev) => { if (ev.key === "Enter") signInOrUp(false); });
    $("#btn-cloud-logout").addEventListener("click", logout);
    $("#btn-cloud-sync-now").addEventListener("click", syncNow);
    $("#btn-cloud-forgot").addEventListener("click", forgotPassword);
    $("#btn-cloud-newpass-save").addEventListener("click", saveNewPassword);
    $("#cloud-newpass").addEventListener("keydown", (ev) => { if (ev.key === "Enter") saveNewPassword(); });
    $("#cloud-autosync").addEventListener("change", (ev) => {
      localStorage.setItem(AUTOSYNC_STORAGE, ev.target.checked ? "1" : "0");
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
      client = null; // recria com a nova config
      $("#cloud-cfg-wrap").classList.add("hidden");
      refreshUI();
      toast("Conexão configurada ✔ Agora crie sua conta ou entre.");
    });
    $("#btn-cloud-cfg-clear").addEventListener("click", () => {
      localStorage.removeItem(CFG_STORAGE);
      client = null; session = null;
      $("#cloud-cfg-wrap").classList.add("hidden");
      refreshUI();
      toast("Configuração removida deste navegador.");
    });

    init();
  });

  // Token da sessão atual (usado pela leitura de comprovante via servidor seguro)
  function getToken() {
    return session?.access_token || null;
  }

  return { onLocalChange, onLocalDelete, getToken };
})();
