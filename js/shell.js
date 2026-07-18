/* ===== Finanças YG — casca de navegação (sidebar desktop + barra inferior mobile) =====
   Só liga os botões da moldura às ações que já existem no app:
   FAB → "Nova transação", casinha → voltar ao início, demais → rolar até a seção. */
"use strict";

document.addEventListener("DOMContentLoaded", () => {
  const scrollToSection = (sel) => {
    const el = document.querySelector(sel);
    if (el && !el.classList.contains("hidden")) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  $$("[data-scroll]").forEach((btn) => {
    btn.addEventListener("click", () => scrollToSection(btn.dataset.scroll));
  });

  const wire = (id, fn) => { const el = $(id); if (el) el.addEventListener("click", fn); };
  wire("#sb-home", () => goHome());
  wire("#bn-home", () => goHome());
  // O FAB reaproveita o botão real do painel (mantém validações e estado)
  wire("#sb-fab", () => $("#btn-add-tx").click());
  wire("#bn-fab", () => $("#btn-add-tx").click());
});
