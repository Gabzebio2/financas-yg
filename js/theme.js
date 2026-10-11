/* ===== Órbita — preferência visual, independente dos dados financeiros ===== */
"use strict";

(() => {
  const STORAGE_KEY = "fyg:theme";
  const DEFAULT_THEME = "dark";
  const COLORS = { dark: "#17161e", light: "#f6f4fa" };
  let currentTheme = null;

  function normalizeTheme(value) {
    return value === "light" || value === "dark" ? value : DEFAULT_THEME;
  }

  function savedTheme() {
    try { return normalizeTheme(window.localStorage.getItem(STORAGE_KEY)); }
    catch { return DEFAULT_THEME; }
  }

  function updateControls() {
    const isDark = currentTheme === "dark";
    const actionLabel = isDark ? "Modo claro" : "Modo noturno";
    document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
      // Nome estável para o botão de alternância; pressed descreve o tema ativo.
      button.setAttribute("aria-label", "Modo noturno");
      button.setAttribute("aria-pressed", String(isDark));
      button.setAttribute("title", "Ativar " + actionLabel.toLowerCase());
      button.querySelectorAll("[data-theme-label]").forEach((label) => {
        label.textContent = actionLabel;
      });
      button.querySelectorAll("[data-theme-icon]").forEach((icon) => {
        const visible = icon.getAttribute("data-theme-icon") === (isDark ? "sun" : "moon");
        icon.toggleAttribute("hidden", !visible);
        icon.classList.toggle("hidden", !visible);
        icon.setAttribute("aria-hidden", "true");
      });
    });
  }

  function applyTheme(value, { persist = false, notify = false } = {}) {
    const next = normalizeTheme(value);
    const changed = next !== currentTheme;
    currentTheme = next;
    document.documentElement.setAttribute("data-theme", next);
    document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
      meta.setAttribute("content", COLORS[next]);
    });
    updateControls();
    if (persist) {
      try { window.localStorage.setItem(STORAGE_KEY, next); }
      catch { /* armazenamento bloqueado: o tema continua funcionando nesta aba */ }
    }
    if (notify && changed) {
      document.dispatchEvent(new CustomEvent("fyg:themechange", { detail: { theme: next } }));
    }
  }

  // Executado no <head>, antes do CSS, para evitar um flash do tema errado.
  applyTheme(savedTheme());

  function init() {
    // Inclui metadados e controles que vieram depois deste script no HTML.
    applyTheme(currentTheme);
    document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
      button.addEventListener("click", () => {
        applyTheme(currentTheme === "dark" ? "light" : "dark", { persist: true, notify: true });
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }

  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    try {
      if (event.storageArea && event.storageArea !== window.localStorage) return;
    } catch { return; }
    // Alterações vindas de outra aba não são persistidas novamente (sem loop).
    applyTheme(event.key === null ? DEFAULT_THEME : event.newValue, { notify: true });
  });
})();
