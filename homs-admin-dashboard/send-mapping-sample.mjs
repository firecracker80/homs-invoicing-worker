// Send GHL one sample board event so the Inbound Webhook trigger can map it.
// Run from homs-admin-dashboard: node send-mapping-sample.mjs
//
// The payload is CAPTURED FROM THE REAL ROUTE, not hand-written. GHL learns its
// field list from this one request and a field missing here is unreferenceable
// afterwards, so a hand-written sample that drifted from the code would be the
// worst possible bug: the workflow would map cleanly and then come up empty in
// production.
//
// Values are deliberately obvious test values. If a workflow is already
// published on this trigger it will fire, and anything it sends should read as
// a test at a glance.
import io from "node:fs";

import { handleHostClaimRequest, handleHostReleaseRequest } from "./src/host-board.js";
import { mintSession } from "./src/auth.js";

const POSTER = "QAnga9enHqGEVddbVtpd";
const CLAIMER = "sXxVbeW8VYARa1sGFMT5";
const PIPELINE = "KHlTziZnmegpXs4UgGgn";
const S_ACTIVE = "abdb4331-247b-44d4-bb91-685708a115de";
const F = {
  zone: "UknAGFCBDSWHIN7l4jwe", guests: "63cNJkDpxI9zRnjEKmfg",
  checkIn: "eTz6T3bMIPh5AB9CqnWI", checkOut: "P0L2hjrdGdTL2WvTY93I",
  guestName: "VIQKkMzPnlnNrJLTvJtT", notes: "nwZ7mf7ULt4JfRBtsosY",
};

const url = (io.readFileSync(".dev.vars", "utf8").split(/\r?\n/)
  .find((l) => l.startsWith("HOST_BOARD_EVENT_URL=")) || "").slice("HOST_BOARD_EVENT_URL=".length);
if (!url) { console.error("HOST_BOARD_EVENT_URL not in .dev.vars"); process.exit(1); }

const soon = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
const opp = {
  id: "ZZTEST-MAPPING", name: "mapping sample", pipelineId: PIPELINE,
  pipelineStageId: S_ACTIVE, contactId: "cp", contact: { id: "cp" },
  customFields: [
    { id: F.zone, fieldValue: "ZZ Test Zone" },
    { id: F.guests, fieldValue: 4 },
    { id: F.checkIn, fieldValue: soon(30) },
    { id: F.checkOut, fieldValue: soon(34) },
    // Present on the record on purpose: proves the payload leaves them out.
    { id: F.guestName, fieldValue: "ZZ DO NOT SEND THIS" },
    { id: F.notes, fieldValue: "ZZ private note, must not travel" },
  ],
};

let sent = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o = {}) => {
  const s = String(u);
  const ok = (x) => ({ ok: true, status: 200, text: async () => JSON.stringify(x) });
  if (s === url) {                       // the one call we actually let out
    sent = JSON.parse(o.body);
    const res = await realFetch(u, o);
    sent.__status = res.status;
    return res;
  }
  if (s.includes("/opportunities/search")) return ok({ opportunities: [opp] });
  if (o.method === "PUT") return ok({ opportunity: opp });
  if (s.includes("/opportunities/")) {
    // The read-back after the claim has to show our account id, or the route
    // reports a lost race instead of notifying.
    return ok({ opportunity: { ...opp, customFields: [...opp.customFields,
      { id: "QkBwEwF4JsuqmeOOeHSx", fieldValue: CLAIMER },
      { id: "rOxzl0YANlfR6JxFFuOa", fieldValue: "ZZ Test Claiming Host" }] } });
  }
  return ok({});
};

const kv = new Map([
  [POSTER, JSON.stringify({ label: "ZZ Test Posting Host", hostBoard: { enabled: true, contactId: "cp" } })],
  [CLAIMER, JSON.stringify({ label: "ZZ Test Claiming Host", hostBoard: { enabled: true, contactId: "cc" } })],
]);
const env = {
  DASHBOARD_TENANTS: {
    async list() { return { keys: [...kv.keys()].map((name) => ({ name })) }; },
    async get(k, o) { const v = kv.get(k); return v == null ? null : (o?.type === "json" ? JSON.parse(v) : v); },
    async put(k, v) { kv.set(k, v); },
  },
  ADMIN_KEY: "k", GHL_PIT_HOMS: "pit", HOST_BOARD_EVENT_URL: url,
};
const token = await mintSession(env, { scope: "host", locationId: CLAIMER });
const req = {
  method: "POST", json: async () => ({}),
  headers: { get: (n) => (n === "Cookie" ? `homs_host=${encodeURIComponent(token)}` : null) },
};

// A RELEASE, not a claim.
//
// First attempt sent `claimed`, which carries reason:"" and releaseCount:0 --
// and an empty value is exactly what can get dropped when GHL captures the
// sample, costing those two merge tags. A release is the only event that
// populates all twelve fields at once, so it is the right thing to map from.
opp.pipelineStageId = "527b975a-5950-493d-b452-a8b4bc595e8c";          // Claimed
opp.customFields.push(
  { id: "QkBwEwF4JsuqmeOOeHSx", fieldValue: CLAIMER },                // Claimed By Account ID
  { id: "rOxzl0YANlfR6JxFFuOa", fieldValue: "ZZ Test Claiming Host" },
  { id: "UezOWofvvW14dQe0Sjq0", fieldValue: 2 },                      // Release Count
);
const reqRelease = {
  ...req,
  json: async () => ({ reason: "ZZ test reason - unit no longer available" }),
};
const res = await handleHostReleaseRequest(reqRelease, env, "ZZTEST-MAPPING");
const body = await res.json();

if (!sent) {
  console.error("No webhook call was made. Route said:", res.status, JSON.stringify(body));
  process.exit(1);
}
const status = sent.__status; delete sent.__status;

console.log("GHL responded:", status, status >= 200 && status < 300 ? "(sample accepted)" : "(NOT accepted)");
console.log("route reported notified:", body.notified);
console.log("\nExact payload GHL received -- these are the fields to map:\n");
console.log(JSON.stringify(sent, null, 2));

const dump = JSON.stringify(sent);
console.log("\nguest name absent:", !dump.includes("DO NOT SEND"));
console.log("private note absent:", !dump.includes("private note"));
console.log("field count:", Object.keys(sent).length);
