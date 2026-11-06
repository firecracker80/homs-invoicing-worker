// Claiming, releasing and filling a lodging request.
// Run: node test-host-board-claim.mjs
//
// A claim route without a release route is a trap, which is why they ship
// together: a claimer who cannot fulfil leaves the request in Claimed, the
// poster assumes it is handled, and the guest finds out on arrival. Case 5 is
// the one that closes that, and case 6 is the one that stops a release being a
// way to steal somebody else's claim.
//
// The other half of this file is the disclosure rule. Yari, 2026-11-03: a claim
// hands over the HOST's details, not the client's. So the guest's name has no
// stage at which it opens up -- not after a claim, not to the claimer, not in
// the webhook that GHL mails from. Cases 1, 2 and 9 are that rule from three
// directions, because one unconditional rule is only worth having if it is
// actually unconditional.
import assert from "node:assert";

import {
  handleHostListRequests, handleHostClaimRequest,
  handleHostReleaseRequest, handleHostFulfilledRequest,
} from "./src/host-board.js";
import { mintSession } from "./src/auth.js";

const POSTER = "QAnga9enHqGEVddbVtpd";       // Cruce Caribeña
const CLAIMER = "sXxVbeW8VYARa1sGFMT5";      // La Casita de Adri
const THIRD = "wLGDbGcQ4QSG3nlT3Sis";        // Luminara -- on the board, involved in nothing
const C_POSTER = "contact-poster";
const C_CLAIMER = "contact-claimer";
const C_THIRD = "contact-third";

const PIPELINE = "KHlTziZnmegpXs4UgGgn";
const S_ACTIVE = "abdb4331-247b-44d4-bb91-685708a115de";
const S_CLAIMED = "527b975a-5950-493d-b452-a8b4bc595e8c";
const S_FULFILLED = "4b8b485f-500c-46a3-923e-bb8328014bee";

const F = {
  zone: "UknAGFCBDSWHIN7l4jwe", guests: "63cNJkDpxI9zRnjEKmfg",
  checkIn: "eTz6T3bMIPh5AB9CqnWI", checkOut: "P0L2hjrdGdTL2WvTY93I",
  guestName: "VIQKkMzPnlnNrJLTvJtT", notes: "nwZ7mf7ULt4JfRBtsosY",
};
const CLAIM = {
  byLabel: "rOxzl0YANlfR6JxFFuOa", byAccount: "QkBwEwF4JsuqmeOOeHSx",
  at: "3VJpRmnjIP4430hNV9KL", releases: "UezOWofvvW14dQe0Sjq0",
};

const GUEST = "María Reyes";
const NOTE = "Guest is María, prefers ground floor";

// ---- fakes ----------------------------------------------------------
const makeKV = () => {
  const m = new Map([
    [POSTER, JSON.stringify({ label: "Cruce Caribeña", hostBoard: { enabled: true, canPost: true, contactId: C_POSTER } })],
    [CLAIMER, JSON.stringify({ label: "La Casita de Adri", hostBoard: { enabled: true, canPost: false, contactId: C_CLAIMER } })],
    [THIRD, JSON.stringify({ label: "Luminara", hostBoard: { enabled: true, canPost: true, contactId: C_THIRD } })],
    ["ZghxU8I60bEm39JUbtCm", JSON.stringify({ label: "Casa Bonita" })],   // not on the board
    ["onboarding:abc", JSON.stringify({ not: "a tenant" })],
  ]);
  return {
    async list() { return { keys: [...m.keys()].map((name) => ({ name })) }; },
    async get(k, o) { const v = m.get(k); return v == null ? null : (o?.type === "json" ? JSON.parse(v) : v); },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
  };
};

const soon = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

let store, puts, hooks, hookStatus;
const cf = (o) => Object.entries(o).map(([id, fieldValue]) => ({ id, fieldValue }));

const seed = (overrides = {}) => {
  store = new Map();
  store.set("opp-1", {
    id: "opp-1", name: "Bávaro · stay", pipelineId: PIPELINE,
    pipelineStageId: S_ACTIVE, contactId: C_POSTER, contact: { id: C_POSTER },
    createdAt: "2026-11-01T00:00:00.000Z",
    customFields: cf({
      [F.zone]: "Bávaro", [F.guests]: 4,
      [F.checkIn]: soon(30), [F.checkOut]: soon(34),
      [F.guestName]: GUEST, [F.notes]: NOTE,
    }),
    ...overrides,
  });
  // A second request, in another pipeline, that must never appear on the board.
  store.set("opp-sales", {
    id: "opp-sales", name: "Yajahira Velazquez", pipelineId: "H0rQskHsD8cFErqtnEdk",
    pipelineStageId: "64a48bc8-c476-44e8-91f0-18f14935aecc",
    contactId: "c-lead", contact: { id: "c-lead" }, customFields: [],
  });
  puts = []; hooks = []; hookStatus = 200;
};

global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const ok = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o) });

  if (!u.includes("leadconnectorhq")) {        // the event webhook
    hooks.push(JSON.parse(opts.body));
    return { ok: hookStatus < 400, status: hookStatus };
  }
  if (u.includes("/opportunities/search")) {
    // Deliberately returns EVERY pipeline, because the live search endpoint
    // has been observed ignoring pipeline_id. If the route trusts the filter it
    // will put Yari's sales pipeline on a public board.
    return ok({ opportunities: [...store.values()] });
  }
  const m = u.match(/\/opportunities\/([^/?]+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (opts.method === "PUT") {
      const body = JSON.parse(opts.body);
      puts.push({ id, ...body });
      const rec = store.get(id);
      store.set(id, {
        ...rec,
        pipelineStageId: body.pipelineStageId,
        customFields: (body.customFields || []).map((f) => ({ id: f.id, fieldValue: f.field_value })),
      });
      return ok({ opportunity: store.get(id) });
    }
    const rec = store.get(id);
    if (!rec) return { ok: false, status: 404, text: async () => JSON.stringify({ message: "Not found" }) };
    return ok({ opportunity: rec });
  }
  return ok({});
};

const envFor = async (locationId) => {
  const env = {
    DASHBOARD_TENANTS: makeKV(), ADMIN_KEY: "k", GHL_PIT_HOMS: "pit",
    HOST_BOARD_EVENT_URL: "https://ghl/board-hook",
  };
  env._token = await mintSession(env, { scope: "host", locationId });
  return env;
};
const req = (env, body = {}, { signedIn = true } = {}) => ({
  method: "POST",
  json: async () => body,
  headers: { get: (n) => (n === "Cookie" && signedIn ? `homs_host=${encodeURIComponent(env._token)}` : null) },
});
const stageOf = (id) => store.get(id).pipelineStageId;
const fieldOf = (id, fid) => store.get(id).customFields.find((f) => f.id === fid)?.fieldValue ?? null;
const listFor = async (env) => (await (await handleHostListRequests(req(env), env)).json()).requests;

// ---- 1. the board read redacts, and redacts unconditionally -------------
{
  seed();
  const poster = await envFor(POSTER);
  const claimer = await envFor(CLAIMER);

  const asClaimer = await listFor(claimer);
  assert.strictEqual(asClaimer.length, 1, "the sales pipeline is on the host board");
  const r = asClaimer[0];
  assert.strictEqual(r.zone, "Bávaro");
  assert.strictEqual(r.guests, 4);
  assert.strictEqual(r.postedByLabel, "Cruce Caribeña", "the poster is named by business, which is the point of the board");
  assert.strictEqual(r.guestName, undefined, "the guest's name reached another host");
  assert.strictEqual(r.notes, undefined, "the poster's private note reached another host");
  assert.strictEqual(r.postedByMe, false);

  const asPoster = (await listFor(poster))[0];
  assert.strictEqual(asPoster.postedByMe, true);
  assert.strictEqual(asPoster.guestName, GUEST, "the poster cannot see their own guest's name");
  assert.strictEqual(asPoster.notes, NOTE);
  console.log("1) The board names the posting business, and the guest only to the poster");
}

// ---- 2. a claim does not open the private fields up ---------------------
// The rule has no stage in it. If redaction were written as "hidden until
// claimed" this is the case that would catch it.
{
  seed();
  const claimer = await envFor(CLAIMER);
  const res = await handleHostClaimRequest(req(claimer), claimer, "opp-1");
  assert.strictEqual(res.status, 200, JSON.stringify(await res.json()));
  assert.strictEqual(stageOf("opp-1"), S_CLAIMED);

  const r = (await listFor(claimer))[0];
  assert.strictEqual(r.claimedByMe, true);
  assert.strictEqual(r.guestName, undefined,
    "claiming revealed the guest's name -- the disclosure rule has a stage in it");
  assert.strictEqual(r.notes, undefined, "claiming revealed the poster's private note");
  console.log("2) Claiming reveals nothing about the guest, which is the whole rule");
}

// ---- 3. a claim records who, by id as well as by name -------------------
{
  seed();
  const claimer = await envFor(CLAIMER);
  await handleHostClaimRequest(req(claimer), claimer, "opp-1");
  assert.strictEqual(fieldOf("opp-1", CLAIM.byAccount), CLAIMER,
    "without the account id there is nothing for release to authorize against");
  assert.strictEqual(fieldOf("opp-1", CLAIM.byLabel), "La Casita de Adri",
    "and a name, because an id in the GHL pipeline tells Yari nothing");
  assert.match(String(fieldOf("opp-1", CLAIM.at)), /^\d{4}-\d{2}-\d{2}$/,
    "Claimed At must be a date-only string, not a UTC instant");

  // The unrelated fields on the record have to survive the write, whether GHL
  // merges or replaces on this endpoint.
  assert.strictEqual(fieldOf("opp-1", F.zone), "Bávaro", "the stage write wiped the request's own details");
  assert.strictEqual(fieldOf("opp-1", F.guestName), GUEST, "the stage write wiped the guest's name");
  console.log("3) A claim records account id, label and date, and loses nothing else");
}

// ---- 4. you cannot claim what is not open, or your own ------------------
{
  seed();
  const claimer = await envFor(CLAIMER);
  const poster = await envFor(POSTER);
  const third = await envFor(THIRD);

  const own = await handleHostClaimRequest(req(poster), poster, "opp-1");
  assert.strictEqual(own.status, 403, "a host claimed their own request");
  assert.strictEqual((await own.json()).code, "own_request");
  assert.strictEqual(stageOf("opp-1"), S_ACTIVE, "and nothing moved");

  await handleHostClaimRequest(req(claimer), claimer, "opp-1");
  const second = await handleHostClaimRequest(req(third), third, "opp-1");
  assert.strictEqual(second.status, 409, "a claimed request was claimed again");
  assert.strictEqual(fieldOf("opp-1", CLAIM.byAccount), CLAIMER, "and the first claimer still holds it");

  const missing = await handleHostClaimRequest(req(claimer), claimer, "opp-nope");
  assert.strictEqual(missing.status, 404);
  // An id from another pipeline must answer the same as one that does not
  // exist, or this is a way to probe the account's opportunity ids.
  const other = await handleHostClaimRequest(req(claimer), claimer, "opp-sales");
  assert.strictEqual(other.status, 404,
    "an opportunity from another pipeline answered differently from a missing one");
  assert.strictEqual(stageOf("opp-sales"), "64a48bc8-c476-44e8-91f0-18f14935aecc", "and was not touched");
  console.log("4) Own, already-claimed, missing and out-of-pipeline claims all refused");
}

// ---- 5. THE STRANDED CASE: a claimer who cannot fulfil gets out ---------
{
  seed();
  const claimer = await envFor(CLAIMER);
  await handleHostClaimRequest(req(claimer), claimer, "opp-1");

  const res = await handleHostReleaseRequest(req(claimer, { reason: "my unit flooded" }), claimer, "opp-1");
  const body = await res.json();
  assert.strictEqual(res.status, 200, JSON.stringify(body));
  assert.strictEqual(body.releasedBy, "claimer");
  assert.strictEqual(stageOf("opp-1"), S_ACTIVE, "the request is not back on the board");
  assert.strictEqual(fieldOf("opp-1", CLAIM.byAccount), "", "the stale claimer id is still on the record");
  assert.strictEqual(Number(fieldOf("opp-1", CLAIM.releases)), 1, "the release was not counted");

  // And it can be claimed again by somebody else, or the release achieved
  // nothing.
  const third = await envFor(THIRD);
  const again = await handleHostClaimRequest(req(third), third, "opp-1");
  assert.strictEqual(again.status, 200, "a released request could not be re-claimed");
  assert.strictEqual(Number(fieldOf("opp-1", CLAIM.releases)), 1, "the count survived the next claim");
  console.log("5) A claimer can drop a request, it returns to Active, and the drop is counted");
}

// ---- 6. the poster can take it back; a bystander cannot ----------------
{
  seed();
  const claimer = await envFor(CLAIMER);
  const poster = await envFor(POSTER);
  const third = await envFor(THIRD);
  await handleHostClaimRequest(req(claimer), claimer, "opp-1");

  // This is what stops release being a way to steal a claim.
  const stolen = await handleHostReleaseRequest(req(third), third, "opp-1");
  assert.strictEqual(stolen.status, 403, "an uninvolved host released someone else's claim");
  assert.strictEqual(stageOf("opp-1"), S_CLAIMED, "and the claim survived");

  const taken = await handleHostReleaseRequest(req(poster, { reason: "no reply in 3 days" }), poster, "opp-1");
  const takenBody = await taken.json();
  assert.strictEqual(taken.status, 200, JSON.stringify(takenBody));
  assert.strictEqual(takenBody.releasedBy, "poster");
  assert.strictEqual(stageOf("opp-1"), S_ACTIVE);
  console.log("6) The poster can take a request back; an uninvolved host cannot");
}

// ---- 7. only the poster marks it filled -------------------------------
{
  seed();
  const claimer = await envFor(CLAIMER);
  const poster = await envFor(POSTER);

  const early = await handleHostFulfilledRequest(req(poster), poster, "opp-1");
  assert.strictEqual(early.status, 409, "an unclaimed request was marked filled");

  await handleHostClaimRequest(req(claimer), claimer, "opp-1");

  // Only the poster knows the guest actually booked. A claimer marking this is
  // marking their own homework.
  const byClaimer = await handleHostFulfilledRequest(req(claimer), claimer, "opp-1");
  assert.strictEqual(byClaimer.status, 403, "the claimer marked the request filled");
  assert.strictEqual((await byClaimer.json()).code, "not_poster");
  assert.strictEqual(stageOf("opp-1"), S_CLAIMED);

  const byPoster = await handleHostFulfilledRequest(req(poster), poster, "opp-1");
  assert.strictEqual(byPoster.status, 200, JSON.stringify(await byPoster.clone().json()));
  assert.strictEqual(stageOf("opp-1"), S_FULFILLED);

  // And a filled request cannot be released back out.
  const after = await handleHostReleaseRequest(req(claimer), claimer, "opp-1");
  assert.strictEqual(after.status, 409, "a filled request was released back to Active");
  console.log("7) Only the poster can mark filled, only from Claimed, and it is final");
}

// ---- 8. signed out, and off the board ---------------------------------
{
  seed();
  const claimer = await envFor(CLAIMER);
  const out = await handleHostClaimRequest(req(claimer, {}, { signedIn: false }), claimer, "opp-1");
  assert.strictEqual(out.status, 401);
  assert.strictEqual(stageOf("opp-1"), S_ACTIVE);

  // A tenant whose module is switched off mid-session, re-read per request.
  const env = await envFor(CLAIMER);
  const t = await env.DASHBOARD_TENANTS.get(CLAIMER, { type: "json" });
  t.hostBoard.enabled = false;
  await env.DASHBOARD_TENANTS.put(CLAIMER, JSON.stringify(t));
  const gated = await handleHostClaimRequest(req(env), env, "opp-1");
  assert.strictEqual(gated.status, 403, "a live cookie outlived the tier gate on a claim");
  assert.strictEqual(stageOf("opp-1"), S_ACTIVE);
  console.log("8) A signed-out or de-provisioned host cannot claim");
}

// ---- 9. the webhook: one URL, typed events, no guest in it -------------
{
  seed();
  const claimer = await envFor(CLAIMER);
  const poster = await envFor(POSTER);

  await handleHostClaimRequest(req(claimer), claimer, "opp-1");
  await handleHostReleaseRequest(req(claimer, { reason: "flooded" }), claimer, "opp-1");
  await handleHostClaimRequest(req(claimer), claimer, "opp-1");
  await handleHostReleaseRequest(req(poster), poster, "opp-1");
  await handleHostClaimRequest(req(claimer), claimer, "opp-1");
  await handleHostFulfilledRequest(req(poster), poster, "opp-1");

  assert.deepStrictEqual(hooks.map((h) => h.event),
    ["claimed", "released_by_claimer", "claimed", "released_by_poster", "claimed", "fulfilled"],
    "the four events are not distinguishable, so one workflow cannot branch on them");

  // GHL's Inbound Webhook trigger learns its field list from ONE sample
  // request, and a field absent from that sample cannot be referenced in the
  // workflow afterwards. One workflow handles all four events, so every event
  // has to carry the identical key set -- otherwise mapping from a `claimed`
  // sample leaves a release with no `reason` to put in the message.
  const KEYS = [
    "event", "requestCode", "zone", "checkIn", "checkOut", "guests",
    "posterAccountId", "posterLabel", "claimerAccountId", "claimerLabel",
    "releaseCount", "reason",
  ].sort();
  for (const h of hooks) {
    assert.deepStrictEqual(Object.keys(h).sort(), KEYS,
      `the ${h.event} payload has a different key set from the others, so one ` +
      `mapping cannot serve all four events`);
  }

  // FLAT. A nested poster.label is fragile to reference in the builder.
  for (const h of hooks) {
    for (const [k, v] of Object.entries(h)) {
      assert.notStrictEqual(typeof v, "object",
        `${h.event}.${k} is nested; the payload must be flat for GHL to map it`);
    }
  }

  // NEVER NULL. An empty value can be dropped when the sample is captured,
  // which silently costs a merge tag.
  for (const h of hooks) {
    for (const [k, v] of Object.entries(h)) {
      assert.ok(v !== null && v !== undefined,
        `${h.event}.${k} is null, so it may not survive the mapping step`);
    }
  }

  assert.ok(hooks.every((h) => h.posterLabel && h.claimerLabel),
    "both sides must be named or the workflow cannot introduce them");

  // TWO date formats on purpose, and this pins both so they cannot drift.
  //
  // The webhook sends DD-MM-YYYY because the emails print it raw and an
  // inbound-webhook workflow has no contact or locale to format from (Yari,
  // 2026-11-06). The routes' own request and response contract stays
  // YYYY-MM-DD, because that is what sorts, compares and round-trips.
  //
  // Getting either one wrong is silent: a DD-MM date in the API would still
  // look like a date and would sort wrongly, and an ISO date in an email would
  // just read oddly to a DR host.
  for (const h of hooks) {
    assert.match(h.checkIn, /^\d{2}-\d{2}-\d{4}$/,
      `webhook checkIn "${h.checkIn}" must be DD-MM-YYYY for the emails`);
    assert.match(h.checkOut, /^\d{2}-\d{2}-\d{4}$/,
      `webhook checkOut "${h.checkOut}" must be DD-MM-YYYY for the emails`);
    // And it is the SAME day, not a day shifted by parsing through UTC.
    const [dd, mm, yyyy] = h.checkIn.split("-");
    assert.strictEqual(`${yyyy}-${mm}-${dd}`, soon(30),
      "the reformatted date is not the same calendar day -- it went through a Date");
  }
  const board = await listFor(poster);
  assert.match(board[0].checkIn, /^\d{4}-\d{2}-\d{2}$/,
    `the board READ must stay YYYY-MM-DD, got "${board[0].checkIn}" -- the page and ` +
    `anything that sorts depend on it`);
  assert.strictEqual(board[0].checkIn, soon(30));
  const released = hooks.find((h) => h.event === "released_by_claimer");
  assert.strictEqual(released.reason, "flooded", "the release reason has to reach the workflow");
  assert.strictEqual(released.releaseCount, 1);
  assert.strictEqual(typeof hooks[0].guests, "number", "guests is sent as a number, not a string");

  // This payload is what GHL mails from. The guest's name in here would put the
  // poster's client into a message sent to another host.
  const dump = JSON.stringify(hooks);
  assert.ok(!dump.includes(GUEST), "the guest's name is in the webhook payload");
  assert.ok(!dump.includes("ground floor"), "the poster's private note is in the webhook payload");
  console.log("9) Six typed events down one URL, naming both hosts and neither guest");
}

// ---- 10. a failed notification does not undo the move -----------------
{
  seed();
  const claimer = await envFor(CLAIMER);
  hookStatus = 500;
  const res = await handleHostClaimRequest(req(claimer), claimer, "opp-1");
  assert.strictEqual(res.status, 200, "a dead webhook failed the claim");
  // The stage HAS moved, so telling the host it did not would be a lie. But
  // they are owed the fact that nobody was told.
  assert.strictEqual(stageOf("opp-1"), S_CLAIMED);
  assert.strictEqual((await res.json()).notified, false,
    "the response claimed the poster was notified when the webhook returned 500");
  console.log("10) A dead webhook is reported, not swallowed, and does not undo the claim");
}

// ---- 11. a card dragged to Claimed in GHL by hand ---------------------
// Yari, 2026-11-03: nothing on the GHL side can populate Claimed By -- a
// workflow writes contact fields, there is no contact field for this, and a
// stage-change workflow does not know who dragged the card. So this state is
// reachable in normal use, not a freak case.
//
// Before it was handled the request was STUCK: every other host was told
// "another host has already claimed this" when none had, and only the poster
// could free it. That is the stranding this whole route exists to prevent.
{
  seed();
  // Stage moved, no claim fields written -- exactly what a drag leaves behind.
  const rec = store.get("opp-1");
  store.set("opp-1", { ...rec, pipelineStageId: S_CLAIMED });

  const third = await envFor(THIRD);
  const r = (await listFor(third))[0];
  assert.strictEqual(r.claimUnattributed, true,
    "a hold with no claimer looks identical to a real one, so the page shows it as taken");
  assert.strictEqual(r.claimedByLabel, null);

  const res = await handleHostClaimRequest(req(third), third, "opp-1");
  const body = await res.json();
  assert.strictEqual(res.status, 200,
    `a hand-dragged card could not be claimed by anyone: ${JSON.stringify(body)}`);
  assert.strictEqual(fieldOf("opp-1", CLAIM.byAccount), THIRD, "and now it has a real claimer");
  assert.strictEqual((await listFor(third))[0].claimUnattributed, false);

  // The rule must not swallow a REAL claim: once attributed, the next host is
  // refused as before. Otherwise this fix would be a way to steal a claim.
  const claimer = await envFor(CLAIMER);
  const steal = await handleHostClaimRequest(req(claimer), claimer, "opp-1");
  assert.strictEqual(steal.status, 409, "an attributed claim was overwritten by the next caller");
  assert.strictEqual(fieldOf("opp-1", CLAIM.byAccount), THIRD, "and the real claimer still holds it");
  console.log("11) An unattributed hold is claimable; a real claim still is not");
}

console.log("\nPASS — claim and release ship together, release has two callers, only the poster " +
  "marks filled, and the guest's name appears in no read and no webhook at any stage.");
