/* Reconcilia arquivos administrativos; nunca arquiva nem altera dados remotos. */
"use strict";

const CloudArchive = (() => {
  const TABLE = "pastas_arquivadas";
  const PAGE_SIZE = 100;
  const MAX_ARCHIVES = 10000;
  const validId = (id) => typeof id === "string" && /^[a-z0-9_-]{1,200}$/i.test(id) && !["__proto__", "prototype", "constructor"].includes(id);
  const error = (message) => Object.assign(new Error(message), { name: "ArchiveReconciliationError" });

  function comparison() {
    if (typeof FolderCleanup !== "undefined") return FolderCleanup;
    if (typeof module !== "undefined" && module.exports && typeof require === "function") return require("./folder-cleanup.js");
    throw error("A conferência das pastas arquivadas não foi carregada. Atualize o app.");
  }

  // Os callbacks locais são síncronos. O chamador mantém a operação na mesma
  // fila da sincronização e assertCurrent lança ao trocar conta/projeto.
  async function reconcile({ client, userId, remoteRows, assertCurrent, ownsLocal, getLocal, removeLocal, request }) {
    if (!client || typeof client.from !== "function" || !validId(userId) ||
        ![assertCurrent, ownsLocal, getLocal, removeLocal].every((fn) => typeof fn === "function") ||
        request != null && typeof request !== "function") throw new TypeError("Contexto de arquivamento inválido.");
    if (removeLocal.constructor?.name === "AsyncFunction") throw new TypeError("A remoção local precisa ser síncrona.");
    const guard = () => { if (assertCurrent() === false) throw Object.assign(new Error("Operação cancelada."), { name: "AbortError" }); };
    const cleanup = comparison();
    if (typeof cleanup.plan !== "function" || typeof cleanup.fingerprint !== "function") throw error("Comparador de pastas indisponível.");
    const remote = remoteRows instanceof Map ? remoteRows : Array.isArray(remoteRows) ? new Map(remoteRows.map((row) => [row?.id, row])) : null;
    if (!remote) throw new TypeError("Lista de pastas remotas inválida.");

    guard();
    const archives = [], seen = new Set();
    // A API limita o tamanho das respostas. Ler páginas evita deixar IDs antigos
    // fora da proteção; qualquer falha acontece antes da primeira remoção local.
    for (let start = 0; ; start += PAGE_SIZE) {
      const query = client.from(TABLE).select("id,keeper_id,data").eq("user_id", userId)
        .order("id", { ascending: true }).range(start, start + PAGE_SIZE - 1);
      const response = await (request ? request(query) : query);
      guard();
      if (response?.error) throw response.error;
      if (!Array.isArray(response?.data)) throw error("Resposta inválida ao conferir as pastas arquivadas.");
      for (const row of response.data) {
        if (!row || !validId(row.id) || !validId(row.keeper_id) || row.id === row.keeper_id ||
            !row.data || row.data.id !== row.id || seen.has(row.id) ||
            row.user_id != null && row.user_id !== userId) throw error("Registro de arquivamento inconsistente. Nenhuma cópia local foi removida.");
        seen.add(row.id); archives.push(row);
      }
      if (archives.length > MAX_ARCHIVES) throw error("Há muitos arquivos para conferir nesta operação. Nenhuma cópia local foi removida.");
      if (response.data.length < PAGE_SIZE) break;
    }

    const blockedIds = [], archivedIds = archives.map((row) => row.id);
    let removedCount = 0;
    for (const archive of archives) {
      guard();
      const local = getLocal(archive.id);
      if (!local) continue;
      const block = () => blockedIds.push(archive.id);
      if (ownsLocal(archive.id) !== true) { block(); continue; }
      const keeperRow = remote.get(archive.keeper_id), keeper = keeperRow?.data;
      if (!keeper || keeperRow.id !== archive.keeper_id || keeper.id !== archive.keeper_id ||
          keeperRow.user_id != null && keeperRow.user_id !== userId ||
          getLocal(archive.keeper_id) && ownsLocal(archive.keeper_id) !== true) { block(); continue; }
      const localFingerprint = cleanup.fingerprint(local), keeperFingerprint = cleanup.fingerprint(keeper);
      if (!localFingerprint || !keeperFingerprint || local.id !== archive.id) { block(); continue; }
      // Duas provas completas: o original arquivado e a versão deste navegador
      // precisam ser equivalentes à pasta preservada. Campos extras participam.
      const archivedPlan = cleanup.plan([archive.data, keeper], { keepId: archive.keeper_id });
      const localPlan = cleanup.plan([local, keeper], { keepId: archive.keeper_id });
      if (!archivedPlan.candidates.some((entry) => entry.id === archive.id) ||
          !localPlan.candidates.some((entry) => entry.id === archive.id)) { block(); continue; }
      guard();
      if (ownsLocal(archive.id) !== true || cleanup.fingerprint(getLocal(archive.id)) !== localFingerprint ||
          cleanup.fingerprint(remote.get(archive.keeper_id)?.data) !== keeperFingerprint ||
          getLocal(archive.keeper_id) && ownsLocal(archive.keeper_id) !== true) { block(); continue; }
      // Sem await entre a última conferência e o commit reversível do Store.
      const result = removeLocal(archive.id);
      if (result && typeof result.then === "function") throw error("A remoção local precisa ser síncrona.");
      guard();
      if (getLocal(archive.id)) throw error("Não foi possível remover a cópia local confirmada. O original arquivado foi preservado.");
      removedCount++;
    }
    return { removedCount, blockedIds, archivedIds };
  }

  return { reconcile };
})();

if (typeof module !== "undefined" && module.exports) module.exports = CloudArchive;
