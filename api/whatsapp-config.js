"use strict";
const wa = require("../server/whatsapp-core.cjs");
module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (!["GET", "POST"].includes(req.method)) return res.status(405).json({ error: "method_not_allowed" });
    const auth = await wa.authenticate(req);
    if (req.method === "POST") {
      if (!wa.ready()) return res.status(503).json({ error: "integration_not_configured" });
      if (req.headers.origin && req.headers.origin !== wa.SITE) return res.status(403).json({ error: "origin_not_allowed" });
      const body = req.body;
      if (!body || !["confirm", "reject"].includes(body.action) || !wa.UUID.test(body.draftId || "") || !/^[1-9][0-9]{0,8}$/.test(String(body.revision || "")) || Object.keys(body).some(k => !["action", "draftId", "revision"].includes(k))) return res.status(400).json({ error: "invalid_action" });
      const result = await wa.rpc("wa_decide", { p_draft_id: body.draftId, p_revision: Number(body.revision), p_action: body.action, p_actor_user_id: auth.userId });
      if (result?.draftId !== body.draftId || result.status !== (body.action === "confirm" ? "confirmed" : "rejected")) throw new wa.Failure("invalid_database_response");
      return res.status(200).json({ ok: true, draftId: result.draftId, status: result.status });
    }
    const prepared = { configured: false, enabled: false, channel: null, pending: [], actionsReady: false, webhookUrl: wa.SITE + "/api/whatsapp" };
    const channels = await wa.rest("/rest/v1/whatsapp_channels?select=phone_number_id,folder_id,enabled,allowed_senders&limit=1", { token: auth.token });
    const channel = channels?.[0];
    if (!channel) return res.status(200).json(prepared);
    const [folders, drafts] = await Promise.all([
      wa.rest("/rest/v1/pastas?id=eq." + encodeURIComponent(channel.folder_id) + "&select=id,name:data->>name", { token: auth.token }),
      wa.rest("/rest/v1/whatsapp_inbox?status=in.(draft,error)&select=draft_id,folder_id,sender_e164,received_at,candidate,warnings,can_confirm,revision,lease_token,status&order=received_at.desc&limit=100", { token: auth.token }),
    ]);
    const name = folders?.[0]?.name || "Pasta indisponível", configured = wa.ready(), enabled = channel.enabled === true;
    return res.status(200).json({
      configured, enabled, actionsReady: configured && enabled && !!folders?.length, webhookUrl: prepared.webhookUrl,
      channel: { phoneNumberId: channel.phone_number_id, folderId: channel.folder_id, folderName: name, senders: (channel.allowed_senders || []).map(wa.mask).map(masked => ({ masked })) },
      pending: (drafts || []).map(d => ({ id: d.draft_id, status: "pending", summary: d.status === "error" ? "Leitura ainda não concluída" : d.lease_token ? "Preparando leitura…" : "Confira antes de registrar", createdAt: d.received_at, senderMasked: wa.mask(d.sender_e164), folderId: d.folder_id, folderName: name, transaction: d.candidate || {}, warnings: d.warnings || [], canConfirm: !d.lease_token && d.can_confirm && wa.canConfirm(d.candidate), revision: String(d.revision) })),
    });
  } catch (error) {
    return res.status(error instanceof wa.Failure ? error.status : 503).json({ error: error instanceof wa.Failure ? error.code : "temporarily_unavailable" });
  }
};
