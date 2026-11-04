// Send GHL one sample host-login event so the Inbound Webhook trigger can map it.
// Run from homs-admin-dashboard: node send-login-mapping-sample.mjs
//
// Same discipline as send-mapping-sample.mjs: the payload is CAPTURED FROM THE
// REAL ROUTE through mocked storage, never hand-written, because a sample that
// drifts from the code maps cleanly and then comes up empty in production.
//
// All six fields are populated, which matters -- an empty value can be dropped
// when GHL captures the sample, and that is how the board's `reason` tag was
// nearly lost.
import fs from "node:fs";

import { handleHostLoginStart } from "./src/host-auth.js";

const LOC = "dytwzgmOP5v0Jh7gop4y";
const OWNER = "zz-test-mapping@example.com";   // example.com: any mail bounces harmlessly

const url = (fs.readFileSync(".dev.vars", "utf8").split(/\r?\n/)
  .find((l) => l.startsWith("HOST_LOGIN_WEBHOOK_URL=")) || "")
  .slice("HOST_LOGIN_WEBHOOK_URL=".length);
if (!url) { console.error("HOST_LOGIN_WEBHOOK_URL not in .dev.vars"); process.exit(1); }

let sent = null, status = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o = {}) => {
  if (String(u) === url) {
    sent = JSON.parse(o.body);
    const res = await realFetch(u, o);
    status = res.status;
    return res;
  }
  return { ok: true, status: 200, text: async () => "{}" };
};

// A tenant that is on the board with this address as an owner. Mocked, because
// no production tenant has a hostBoard block yet.
const kv = new Map([[LOC, JSON.stringify({
  label: "ZZ Test Host Business",
  hostBoard: { enabled: true, canPost: true, owners: [OWNER] },
})]]);
const env = {
  DASHBOARD_TENANTS: {
    async list() { return { keys: [...kv.keys()].map((name) => ({ name })) }; },
    async get(k, o) { const v = kv.get(k); return v == null ? null : (o?.type === "json" ? JSON.parse(v) : v); },
    async put(k, v) { kv.set(k, v); },
    async delete(k) { kv.delete(k); },
  },
  HOST_LOGIN_WEBHOOK_URL: url,
};

const res = await handleHostLoginStart({
  method: "POST",
  json: async () => ({ email: OWNER }),
  headers: { get: () => null },
}, env);

if (!sent) {
  console.error("No webhook call was made. Route status:", res.status);
  process.exit(1);
}

console.log("GHL responded:", status, status >= 200 && status < 300 ? "(sample accepted)" : "(NOT accepted)");
console.log("route status:", res.status, "(204 is correct -- it answers the same for unknown addresses)");
console.log("\nExact payload GHL received -- these are the fields to map:\n");
// The code is a live one-time value, so it is shown masked here. The real
// request carried six real digits; GHL has them.
console.log(JSON.stringify({ ...sent, code: "######" }, null, 2));
console.log("\nfield count:", Object.keys(sent).length);
console.log("code is 6 digits:", /^\d{6}$/.test(sent.code));
console.log("every field populated:",
  Object.values(sent).every((v) => v !== null && v !== undefined && String(v) !== ""));
