// Posting a lodging request, now that posting goes through the Worker.
// Run: node test-host-board.mjs
//
// The reason posting moved here at all is the tier gate: `canPost` lives on the
// tenant record, and the old path (page -> GHL form tracking -> workflow)
// could not read it. So case 2 is the point of the whole change.
import assert from "node:assert";

import { handleHostPostRequest } from "./src/host-board.js";
import { mintSession } from "./src/auth.js";

const LOC = "QAnga9enHqGEVddbVtpd";
const CONTACT = "contact-cruce-1";
const PIPELINE = "KHlTziZnmegpXs4UgGgn";
const STAGE_ACTIVE = "abdb4331-247b-44d4-bb91-685708a115de";
const F_ZONE = "UknAGFCBDSWHIN7l4jwe";
const F_IN = "eTz6T3bMIPh5AB9CqnWI";
const F_OUT = "P0L2hjrdGdTL2WvTY93I";
const F_GUESTNAME = "VIQKkMzPnlnNrJLTvJtT";
const F_NOTES = "nwZ7mf7ULt4JfRBtsosY";

const makeKV = (tenant) => {
  const m = new Map([[LOC, JSON.stringify(tenant)]]);
  return {
    async list() { return { keys: [...m.keys()].map((name) => ({ name })) }; },
    async get(k, o) { const v = m.get(k); return v == null ? null : (o?.type === "json" ? JSON.parse(v) : v); },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
  };
};

// Dates comfortably in the future, so this suite does not start failing in
// November of whatever year someone runs it.
const soon = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
const CHECKIN = soon(30);
const CHECKOUT = soon(34);

let creates = [];
let board = [];
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const ok = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o) });
  if (u.includes("/opportunities/search")) return ok({ opportunities: board });
  if (u.includes("/opportunities/") && opts.method === "POST") {
    const body = JSON.parse(opts.body);
    creates.push(body);
    const id = `opp-${creates.length}`;
    // What was created is now on the board, so the dedupe has something to find.
    board.push({
      id, pipelineStageId: body.pipelineStageId, contactId: body.contactId,
      customFields: (body.customFields || []).map((f) => ({ id: f.id, fieldValue: f.field_value })),
    });
    return ok({ opportunity: { id } });
  }
  return ok({});
};

const envFor = async (hostBoard) => {
  const env = { DASHBOARD_TENANTS: makeKV({ label: "Cruce Caribeña", hostBoard }), ADMIN_KEY: "k", GHL_PIT_HOMS: "pit" };
  env._token = await mintSession(env, { scope: "host", locationId: LOC });
  return env;
};
const req = (env, body, { signedIn = true } = {}) => ({
  method: "POST",
  json: async () => body,
  headers: { get: (n) => (n === "Cookie" && signedIn ? `homs_host=${encodeURIComponent(env._token)}` : null) },
});
const GOOD = { zone: "Bávaro", checkIn: CHECKIN, checkOut: CHECKOUT, guests: 4, rooms: 2, beds: 3, pets: true, notes: "Guest is María, +1809...", guestName: "María Reyes" };

// ---- 1. signed out ---------------------------------------------------
{
  const env = await envFor({ enabled: true, canPost: true, contactId: CONTACT });
  creates = []; board = [];
  const res = await handleHostPostRequest(req(env, GOOD, { signedIn: false }), env);
  assert.strictEqual(res.status, 401);
  assert.deepStrictEqual(creates, [], "nothing was posted");
  console.log("1) A signed-out caller cannot post");
}

// ---- 2. THE TIER GATE ------------------------------------------------
{
  const env = await envFor({ enabled: true, canPost: false, contactId: CONTACT });
  creates = []; board = [];
  const res = await handleHostPostRequest(req(env, GOOD), env);
  assert.strictEqual(res.status, 403, "a plan without canPost must not be able to post");
  const body = await res.json();
  assert.strictEqual(body.code, "post_not_in_plan",
    "the refusal has to be legible as a plan limit, not a malfunction");
  assert.deepStrictEqual(creates, [], "and nothing reached GHL");
  console.log("2) A claim-only plan is refused posting, and told why");
}

// ---- 3. setup that is not finished ------------------------------------
{
  const env = await envFor({ enabled: true, canPost: true });   // no contactId
  creates = []; board = [];
  const res = await handleHostPostRequest(req(env, GOOD), env);
  assert.strictEqual(res.status, 409, "no poster contact means no way to reach them after a claim");
  assert.deepStrictEqual(creates, []);
  console.log("3) An account with no poster contact cannot post");
}

// ---- 4. the dates have to make sense ---------------------------------
{
  const env = await envFor({ enabled: true, canPost: true, contactId: CONTACT });
  const bad = async (patch, expect) => {
    creates = []; board = [];
    const res = await handleHostPostRequest(req(env, { ...GOOD, ...patch }), env);
    assert.strictEqual(res.status, 422, `expected 422 for ${expect}`);
    assert.deepStrictEqual(creates, [], `nothing posted for ${expect}`);
  };
  await bad({ checkOut: CHECKIN }, "checkout same as checkin");
  await bad({ checkIn: CHECKOUT, checkOut: CHECKIN }, "checkout before checkin");
  await bad({ checkIn: "2020-01-01", checkOut: "2020-01-05" }, "dates in the past");
  await bad({ guests: 0 }, "no guests");
  await bad({ zone: "   " }, "no zone");
  console.log("5 impossible requests refused before they reach the board");
}

// ---- 5. the happy path writes the right record -----------------------
{
  const env = await envFor({ enabled: true, canPost: true, contactId: CONTACT });
  creates = []; board = [];
  const res = await handleHostPostRequest(req(env, GOOD), env);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.created, true);
  assert.strictEqual(creates.length, 1);

  const sent = creates[0];
  assert.strictEqual(sent.pipelineId, PIPELINE);
  assert.strictEqual(sent.pipelineStageId, STAGE_ACTIVE, "a new request starts Active");
  assert.strictEqual(sent.contactId, CONTACT);

  const val = (id) => sent.customFields.find((f) => f.id === id)?.field_value;
  assert.strictEqual(val(F_ZONE), "Bávaro");
  assert.strictEqual(val(F_IN), CHECKIN, "the date is stored as the string given, not re-parsed");
  assert.strictEqual(val(F_OUT), CHECKOUT);

  // The title is what every host on the board reads. The guest's name must not
  // be in it; that is the whole pre-claim privacy rule, and a title is the
  // easiest place to leak it by accident.
  assert.ok(!sent.name.includes("María Reyes"), "the guest's name is in the public title");
  assert.ok(sent.name.includes("Bávaro") && sent.name.includes(CHECKIN));

  // The private pair IS written -- the claimer needs it later. Being stored and
  // being published are different questions.
  assert.strictEqual(val(F_GUESTNAME), "María Reyes");
  assert.ok(String(val(F_NOTES)).includes("María"));
  console.log("5) A valid request is created Active, with the guest's name stored but not in the title");
}

// ---- 6. posting twice posts once -------------------------------------
{
  const env = await envFor({ enabled: true, canPost: true, contactId: CONTACT });
  creates = []; board = [];
  const first = await handleHostPostRequest(req(env, GOOD), env);
  const second = await handleHostPostRequest(req(env, GOOD), env);
  assert.strictEqual(first.status, 200);
  assert.strictEqual(second.status, 200);

  // Count the writes, not the words. Both responses read like success; only the
  // number of opportunities says whether the board now has one request or two,
  // and two means two hosts each claim "it" and one wastes their reply.
  assert.strictEqual(creates.length, 1,
    `a repeated submit created ${creates.length} requests -- the board now shows the same booking twice`);
  const body = await second.json();
  assert.strictEqual(body.created, false);
  assert.strictEqual(body.reason, "already_posted");
  assert.strictEqual(body.requestCode, "opp-1", "and it points at the one that exists");
  console.log("6) A repeated submit returns the existing request instead of a second one");
}

console.log("\nPASS — posting is gated by plan, validated before it reaches the board, " +
  "idempotent on a double submit, and keeps the guest's name out of what every host can see.");
