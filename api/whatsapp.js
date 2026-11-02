"use strict";
const wa = require("../server/whatsapp-core.cjs");
function rejectPost(res, status, code) {
  console.warn("whatsapp.request_rejected", status, code);
  return res.status(status).json({ error: code });
}
function logDelivery(payload, events) {
  let incoming = 0, statuses = 0, echoes = 0, noPhone = 0;
  for (const entry of Array.isArray(payload?.entry) ? payload.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const value = change?.value;
      if (change?.field === "messages") {
        const messages = Array.isArray(value?.messages) ? value.messages : [];
        incoming += messages.length;
        noPhone += messages.filter(message => !message?.from).length;
        for (const status of Array.isArray(value?.statuses) ? value.statuses : []) {
          statuses++;
          if (status?.status === "failed") {
            const code = status.errors?.[0]?.code;
            console.warn("whatsapp.delivery_failed", Number.isSafeInteger(code) ? code : "unknown");
          }
        }
      } else if (change?.field === "smb_message_echoes" && Array.isArray(value?.message_echoes)) {
        echoes += value.message_echoes.length;
      }
    }
  }
  console.info("whatsapp.signed_delivery", { incoming, statuses, echoes, noPhone, eligible: events.length });
}
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
    if (!wa.ready()) return rejectPost(res, 503, "integration_not_configured");
    if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || "")) return rejectPost(res, 415, "json_required");
    const raw = await wa.rawBody(req);
    if (!wa.validSignature(raw, req.headers["x-hub-signature-256"], process.env.WHATSAPP_APP_SECRET)) return rejectPost(res, 401, "invalid_signature");
    let payload;
    try { payload = JSON.parse(raw.toString("utf8")); } catch { return rejectPost(res, 400, "invalid_json"); }
    const events = wa.messageEvents(payload), deadline = Date.now() + 50000;
    logDelivery(payload, events);
    // Claims are durable before inference; Meta retries resume expired claims.
    let failed = false, cursor = 0;
    const worker = async () => {
      while (cursor < events.length) {
        if (Date.now() > deadline - 35000) { failed = true; return; }
        const event = events[cursor++];
        try { await wa.withBudget(deadline, () => wa.handleEvent(event)); }
        catch (error) {
          console.error("whatsapp.processing_failed", error instanceof wa.Failure ? error.code : "unexpected");
          failed = true;
        }
      }
    };
    await Promise.all([worker(), worker()]);
    return res.status(failed ? 503 : 200).json({ ok: !failed });
  } catch (error) {
    if (req.method === "POST") return rejectPost(res, error instanceof wa.Failure ? error.status : 503, error instanceof wa.Failure ? error.code : "temporarily_unavailable");
    return res.status(error instanceof wa.Failure ? error.status : 503).json({ error: error instanceof wa.Failure ? error.code : "temporarily_unavailable" });
  }
};
