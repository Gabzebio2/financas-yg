"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const { createRequire } = require("node:module");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");

for (const route of ["receipt", "receipt-document"]) {
  const entry = require.resolve("../api/" + route + ".js");
  for (const [quotaStatus, quotaBody, expectedStatus] of [
    [200, 310, 429], [200, null, 503], [503, {}, 503], [401, {}, 401],
    [403, { message: "login_required" }, 401], [403, { message: "invalid_read_reservation" }, 503],
  ]) {
    test(route + " preserva os dados quando a reserva responde " + quotaStatus + "/" + JSON.stringify(quotaBody), async () => {
      const calls = [];
      const key = "fake-server-only-key";
      const authorization = "Bearer fake-session";
      const userId = "00000000-0000-4000-8000-000000000001";
      const context = {
        module: { exports: {} }, require: createRequire(entry), AbortSignal,
        process: { env: { OPENAI_API_KEY: "fake-model-key", RECEIPT_WORKER_SECRET: key } },
        fetch: async (url, options) => {
          calls.push({ url, options });
          if (url.endsWith("/auth/v1/user")) return { ok: true, json: async () => ({id: userId}) };
          if (!url.endsWith("/rpc/receipt_reserve_direct_read")) throw Error("unexpected call");
          return { ok: quotaStatus === 200, status: quotaStatus, json: async () => quotaBody };
        },
      };
      vm.runInNewContext(readFileSync(entry, "utf8"), context);
      const result = { headers: {}, setHeader(k, v) { this.headers[k] = v; },
        status(s) { this.code = s; return this; }, json(v) { this.data = v; return this; } };
      await context.module.exports({ method: "POST", headers: { authorization }, body: {
        image: { media_type: "image/jpeg", data: "YWJj" }, documentContext: { pageStart: 1, pageEnd: 1, totalPages: 1 },
      } }, result);
      assert.equal(result.code, expectedStatus);
      assert.equal(calls.length, 2);
      const reservation = calls[1].options;
      assert.equal(reservation.redirect, "error");
      assert.equal(reservation.headers.Authorization, authorization);
      const body = JSON.parse(reservation.body);
      assert.deepEqual(Object.keys(body).sort(), ["p_proof","p_stamp"]);
      assert.equal(body.p_proof, createHmac("sha256", key).update("receipt-direct-read:v1." + userId + "." + body.p_stamp).digest("hex"));
      if (expectedStatus === 429) {
        assert.equal(result.headers["Retry-After"], "310");
        assert.equal(result.data.error, "receipt_daily_limit");
        assert.equal(result.data.retryAfter, 310);
      }
    });
  }
}
