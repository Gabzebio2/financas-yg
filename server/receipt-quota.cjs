"use strict";
const { createHmac } = require("node:crypto");

// Returns true only after the authenticated user's reservation is committed.
// The quota service receives the session, never the document or its contents.
async function reserveDirectRead(fetcher, projectUrl, publicKey, authorization, userId, backendKey, res) {
  try {
    if (!backendKey || typeof userId !== "string" || !userId) throw Error("quota_unavailable");
    const stamp = Math.floor(Date.now() / 1000);
    const proof = createHmac("sha256", backendKey)
      .update("receipt-direct-read:v1." + userId + "." + stamp)
      .digest("hex");
    const response = await fetcher(projectUrl + "/rest/v1/rpc/receipt_reserve_direct_read", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
      headers: { apikey: publicKey, Authorization: authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ p_stamp: stamp, p_proof: proof }),
    });
    const unconfirmed = response.status === 403 &&
      (await response.json().catch(() => null))?.message === "login_required";
    if (response.status === 401 || unconfirmed) {
      res.status(401).json({ error: "login_invalido" });
      return false;
    }
    if (response.ok) {
      const retryAfter = await response.json();
      if (retryAfter === 0) return true;
      if (Number.isSafeInteger(retryAfter) && retryAfter > 0 && retryAfter <= 86400) {
        res.setHeader("Retry-After", String(retryAfter));
        res.status(429).json({ error: "receipt_daily_limit", retryAfter });
        return false;
      }
    }
  } catch {
    // Temporary network or quota-service failure. No reading has been authorized.
  }
  res.status(503).json({ error: "leitura_indisponivel" });
  return false;
}

module.exports = { reserveDirectRead };
