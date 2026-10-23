"use strict";
const wa = require("../server/whatsapp-core.cjs");
module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "GET") {
      const query = new URL(req.url, wa.SITE).searchParams;
      if (!process.env.WHATSAPP_VERIFY_TOKEN) return res.status(503).json({ error: "integration_not_configured" });
      if (query.get("hub.mode") !== "subscribe" || !wa.same(query.get("hub.verify_token"), process.env.WHATSAPP_VERIFY_TOKEN) || !/^\d{1,200}$/.test(query.get("hub.challenge") || "")) return res.status(403).json({ error: "verification_failed" });
      res.setHeader("Content-Type", "text/plain");
      return res.status(200).send(query.get("hub.challenge"));
    }
    if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
    if (!wa.ready()) return res.status(503).json({ error: "integration_not_configured" });
    if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || "")) return res.status(415).json({ error: "json_required" });
    const raw = await wa.rawBody(req);
    if (!wa.validSignature(raw, req.headers["x-hub-signature-256"], process.env.WHATSAPP_APP_SECRET)) return res.status(401).json({ error: "invalid_signature" });
    let payload;
    try { payload = JSON.parse(raw.toString("utf8")); } catch { return res.status(400).json({ error: "invalid_json" }); }
    const events = wa.messageEvents(payload), deadline = Date.now() + 50000;
    // Claims are durable before inference; Meta retries resume expired claims.
    let failed = false, cursor = 0;
    const worker = async () => {
      while (cursor < events.length) {
        if (Date.now() > deadline - 35000) { failed = true; return; }
        const event = events[cursor++];
        try { await wa.withBudget(deadline, () => wa.handleEvent(event)); } catch { failed = true; }
      }
    };
    await Promise.all([worker(), worker()]);
    return res.status(failed ? 503 : 200).json({ ok: !failed });
  } catch (error) {
    return res.status(error instanceof wa.Failure ? error.status : 503).json({ error: error instanceof wa.Failure ? error.code : "temporarily_unavailable" });
  }
};
