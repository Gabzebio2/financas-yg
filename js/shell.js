/* ===== Finanças YG — casca de navegação (sidebar desktop + barra inferior mobile) =====
   Só liga os botões da moldura às ações que já existem no app:
   FAB → "Nova transação", casinha → voltar ao início, demais → rolar até a seção. */
"use strict";

document.addEventListener("DOMContentLoaded", () => {
  const scrollToSection = (sel) => {
    // Os alvos de rolagem vivem no painel; se a tela de transações estiver aberta, volta antes
    if (!$("#screen-txs").classList.contains("hidden")) showScreen("screen-dash");
    requestAnimationFrame(() => {
      const el = document.querySelector(sel);
      if (el && !el.classList.contains("hidden")) el.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  $$("[data-scroll]").forEach((btn) => {
    btn.addEventListener("click", () => scrollToSection(btn.dataset.scroll));
  });

  const wire = (id, fn) => { const el = $(id); if (el) el.addEventListener("click", fn); };
  wire("#sb-home", () => goHome());
  wire("#bn-home", () => goHome());
  // Aba Transações: abre a tela própria de transações do mês
  wire("#sb-txs", () => showScreen("screen-txs"));
  wire("#bn-txs", () => showScreen("screen-txs"));
  wire("#btn-txs-back", () => showScreen("screen-dash"));
  // O FAB reaproveita o botão real do painel (mantém validações e estado)
  wire("#sb-fab", () => $("#btn-add-tx").click());
  wire("#bn-fab", () => $("#btn-add-tx").click());

  // Olhinho do saldo: esconde/mostra os valores do cabeçalho (fica lembrado)
  const HIDE_KEY = "fyg:hide-money";
  try { if (localStorage.getItem(HIDE_KEY) === "1") document.body.classList.add("hide-money"); } catch { /* sem storage */ }
  wire("#hero-eye", () => {
    const on = document.body.classList.toggle("hide-money");
    try { localStorage.setItem(HIDE_KEY, on ? "1" : "0"); } catch { /* sem storage */ }
  });
});
