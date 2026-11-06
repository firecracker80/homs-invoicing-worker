// Host board — posting a lodging request.
//
// Posting used to go board page -> GHL external form tracking -> contact ->
// workflow -> opportunity, with this Worker nowhere in the chain. That worked,
// but it made the paid side of the tier gate unenforceable: `canPost` lives on
// the tenant record and nothing in that path can read it. Yari, 2026-11-03:
// move posting behind the Worker.
//
// Two things come free from the move. The Worker sets the opportunity's custom
// fields directly, so the Create Opportunity action no longer needs 13 fields
// mapped by hand. And a double-tap stops creating two requests (see the dedupe
// below) -- on a board, a duplicate request is not a cosmetic problem, it is two
// hosts each claiming "the same" booking and one of them wasting a reply.
//
// PRIVACY. Guest Name and Additional Notes are written here and go back ONLY to
// the account that posted them. Yari, 2026-11-03: a claim discloses the HOST's
// details, not the client's -- it is a mutual introduction between two HOMS
// clients, and the poster's guest is not the claimer's business at any point.
//
// An earlier version of this comment said these fields were "released by the
// claim route". That was wrong. There is no stage at which they open up, which
// makes the rule unconditional and so impossible to get wrong in a branch. A
// privacy rule the page merely chooses not to display is not a rule.

import { requireHost } from "./host-auth.js";

const HOMS_LOCATION_ID = "dytwzgmOP5v0Jh7gop4y";
const PIPELINE_ID = "KHlTziZnmegpXs4UgGgn";          // "Lodging Requests"
const STAGE_ACTIVE = "abdb4331-247b-44d4-bb91-685708a115de";

// Opportunity custom fields in HOMS, read from the account 2026-11-03.
// Ids, not fieldKeys: a record's customFields array carries the id, and several
// of these keys are Spanish with the accents stripped (`hay_nios`), which is a
// thing to read once and never type again.
const FIELD = {
  zone: "UknAGFCBDSWHIN7l4jwe",        // Zone or Area          TEXT
  guests: "63cNJkDpxI9zRnjEKmfg",      // Number of Guests      NUMERICAL
  rooms: "ihBM5PeAQJ5uFQFMBhf9",       // Rooms Needed          NUMERICAL
  beds: "0tg22zrLK8Vs3ws9vGHV",        // Beds Needed           NUMERICAL
  checkIn: "eTz6T3bMIPh5AB9CqnWI",     // Check-In Date         DATE
  checkOut: "P0L2hjrdGdTL2WvTY93I",    // Check-Out Date        DATE
  pets: "9Y8WZrA4mmf0LXS7dq43",        // Traveling With Pets   RADIO Yes/No
  kids: "tDEoEUSpPMYtVHbTMfvq",        // Kids Included         RADIO Yes/No
  elderly: "KVh6Yf4rp0HSiAvN693A",     // Elderly Guests        RADIO Yes/No
  budget: "gdguW5yvhsHEs5Hcjeyu",      // Approximate Budget    MONETORY
  guestName: "VIQKkMzPnlnNrJLTvJtT",   // Guest Name            TEXT      PRIVATE
  notes: "nwZ7mf7ULt4JfRBtsosY",       // Additional Notes      LARGE_TEXT PRIVATE
};

const json = (body, status = 200) => Response.json(body, { status });
const yesNo = (v) => (v === true || v === "Yes" || v === "yes" ? "Yes" : "No");

// A date-only string, kept as a date-only string.
//
// Not `new Date(s)`: a bare "2026-11-16" parses as UTC midnight, which in the
// Dominican Republic is the evening of the 15th. That has already shown every
// dashboard date a day early once.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// DD-MM-YYYY, for the webhook only.
//
// Yari's ruling 2026-11-06 (via Cadence): the board emails show dates
// DD-MM-YYYY. They print the payload raw -- an inbound-webhook workflow has no
// contact and no locale to format from -- so the formatting has to happen here
// or not at all. Matches what the board page and the dashboard already show.
//
// String surgery, never Date. A bare "2026-12-03" parses as UTC midnight, which
// is the evening of the 2nd in the DR, and that has already shifted every
// dashboard date by a day once.
//
// THE ROUTES' OWN CONTRACT DOES NOT MOVE. Requests and responses stay
// YYYY-MM-DD, because that is what sorts, compares and round-trips. Only the
// outbound webhook values are reformatted, and only for display.
const ddmmyyyy = (iso) => {
  const m = ISO_DATE.exec(String(iso || "").slice(0, 10));
  return m ? `${m[0].slice(8, 10)}-${m[0].slice(5, 7)}-${m[0].slice(0, 4)}` : "";
};

async function ghl(pit, path, init = {}) {
  const res = await fetch(`https://services.leadconnectorhq.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${pit}`,
      Version: "2021-07-28",
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    const err = new Error(`GHL returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(body?.message || `GHL ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

function validate(b) {
  const errors = [];
  const zone = String(b.zone || "").trim();
  const checkIn = String(b.checkIn || "").trim();
  const checkOut = String(b.checkOut || "").trim();
  const guests = Number(b.guests);

  if (!zone) errors.push("zone is required");
  if (!ISO_DATE.test(checkIn)) errors.push("checkIn must be YYYY-MM-DD");
  if (!ISO_DATE.test(checkOut)) errors.push("checkOut must be YYYY-MM-DD");
  // String comparison, which is correct for ISO dates and avoids parsing them
  // into instants at all.
  if (ISO_DATE.test(checkIn) && ISO_DATE.test(checkOut) && checkOut <= checkIn) {
    errors.push("checkOut must be after checkIn");
  }
  if (!Number.isFinite(guests) || guests < 1) errors.push("guests must be at least 1");

  // A request for dates that have passed is noise on the board, and nobody can
  // fill it. Compared as strings against today in the DR, for the reason above.
  const todayDR = new Date(Date.now() - 4 * 3600 * 1000).toISOString().slice(0, 10);
  if (ISO_DATE.test(checkOut) && checkOut < todayDR) errors.push("checkOut is in the past");

  return { errors, zone, checkIn, checkOut, guests };
}

// POST /api/host/requests
export async function handleHostPostRequest(request, env) {
  const host = await requireHost(request, env);
  if (host.denied) return host.denied;

  const board = host.tenant.hostBoard || {};
  if (!board.canPost) {
    // Deliberately explicit rather than a bare 403: this is the upgrade prompt,
    // and a host who cannot post should be told that is why, not left guessing
    // whether the board is broken.
    return json({
      error: "This plan can claim requests but not post them.",
      code: "post_not_in_plan",
    }, 403);
  }

  const contactId = board.contactId;
  if (!contactId) {
    // Not auto-created. This contact is how a claimer later reaches the poster,
    // so it has to be the account's real contact record, chosen on purpose.
    console.error(`hostBoard.contactId missing for ${host.locationId}`);
    return json({ error: "This account is not finished being set up for the board." }, 409);
  }

  const pit = env.GHL_PIT_HOMS;
  if (!pit) return json({ error: "Server misconfigured: GHL_PIT_HOMS is not set" }, 500);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Expected a JSON body" }, 400);
  }

  const { errors, zone, checkIn, checkOut, guests } = validate(body);
  if (errors.length) return json({ error: "Some details are missing or wrong", details: errors }, 422);

  try {
    // Dedupe BEFORE creating. A double tap, a retried request or an impatient
    // second submit must not put the same booking on the board twice -- two
    // hosts would each claim "it" and one would be wasting their time.
    const existing = await ghl(pit,
      `/opportunities/search?${new URLSearchParams({
        location_id: HOMS_LOCATION_ID, pipeline_id: PIPELINE_ID, limit: "100",
      })}`);
    const cf = (o, id) => (o.customFields || []).find((f) => f.id === id)?.fieldValue ?? null;
    const duplicate = (existing?.opportunities || []).find((o) =>
      o.pipelineStageId === STAGE_ACTIVE &&
      (o.contact?.id || o.contactId) === contactId &&
      String(cf(o, FIELD.checkIn) || "").slice(0, 10) === checkIn &&
      String(cf(o, FIELD.checkOut) || "").slice(0, 10) === checkOut &&
      String(cf(o, FIELD.zone) || "").trim().toLowerCase() === zone.toLowerCase()
    );
    if (duplicate) {
      return json({ ok: true, created: false, reason: "already_posted", requestCode: duplicate.id });
    }

    const customFields = [
      { id: FIELD.zone, field_value: zone },
      { id: FIELD.guests, field_value: guests },
      { id: FIELD.checkIn, field_value: checkIn },
      { id: FIELD.checkOut, field_value: checkOut },
      { id: FIELD.pets, field_value: yesNo(body.pets) },
      { id: FIELD.kids, field_value: yesNo(body.kids) },
      { id: FIELD.elderly, field_value: yesNo(body.elderly) },
    ];
    if (Number.isFinite(Number(body.rooms))) customFields.push({ id: FIELD.rooms, field_value: Number(body.rooms) });
    if (Number.isFinite(Number(body.beds))) customFields.push({ id: FIELD.beds, field_value: Number(body.beds) });
    if (Number.isFinite(Number(body.budget))) customFields.push({ id: FIELD.budget, field_value: Number(body.budget) });
    // The private pair. Written, never returned by the board read.
    if (body.guestName) customFields.push({ id: FIELD.guestName, field_value: String(body.guestName).trim() });
    if (body.notes) customFields.push({ id: FIELD.notes, field_value: String(body.notes).trim() });

    const created = await ghl(pit, "/opportunities/", {
      method: "POST",
      body: JSON.stringify({
        pipelineId: PIPELINE_ID,
        locationId: HOMS_LOCATION_ID,
        pipelineStageId: STAGE_ACTIVE,
        contactId,
        status: "open",
        // What a host scanning the board sees first. Zone and dates, never the
        // guest's name.
        name: `${zone} · ${checkIn} to ${checkOut} · ${guests} guest${guests === 1 ? "" : "s"}`,
        customFields,
      }),
    });

    const id = created?.opportunity?.id || created?.id || null;
    return json({ ok: true, created: true, requestCode: id, postedBy: host.tenant.label || host.locationId });
  } catch (err) {
    return json(
      { error: err.message || "Could not post the request", status: err.status || 500 },
      err.status && err.status >= 400 && err.status < 600 ? err.status : 502
    );
  }
}

// ---------------------------------------------------------------------------
// Reading the board, and the three stage moves.
// ---------------------------------------------------------------------------

const STAGE = {
  active: "abdb4331-247b-44d4-bb91-685708a115de",
  claimed: "527b975a-5950-493d-b452-a8b4bc595e8c",
  fulfilled: "4b8b485f-500c-46a3-923e-bb8328014bee",
  closed: "a044c203-aea8-4559-85d4-504ce12c24a1",
};
const STAGE_NAME = Object.fromEntries(Object.entries(STAGE).map(([k, v]) => [v, k]));

// Claim bookkeeping. `Claimed By` already existed on the account; the other
// three were created 2026-11-03.
//
// Two fields for the claimer, not one, and the reason is authorization. The
// label is what Yari reads in the GHL pipeline, and a label is mutable -- a
// client renames their business and it changes. The account id is the key the
// release route checks. Authorizing on a display name would mean two clients
// with similar names could release each other's claims.
const CLAIM = {
  byLabel: "rOxzl0YANlfR6JxFFuOa",     // Claimed By             TEXT
  byAccount: "QkBwEwF4JsuqmeOOeHSx",   // Claimed By Account ID  TEXT
  at: "3VJpRmnjIP4430hNV9KL",          // Claimed At             DATE
  releases: "UezOWofvvW14dQe0Sjq0",    // Release Count          NUMERICAL
};

// Today in the Dominican Republic, as a date-only string. Never `new Date()`
// sliced off a UTC instant: that reads as the previous day all evening here,
// which has already put every dashboard date a day early once.
const todayDR = () => new Date(Date.now() - 4 * 3600 * 1000).toISOString().slice(0, 10);

const cfOf = (record, id) =>
  (record?.customFields || []).find((f) => f.id === id)?.fieldValue ?? null;

// Every account that is on the board, keyed for the two lookups needed below:
// which account posted a given request, and what an account is called.
//
// A scan, deliberately, for the same reason findHostAccount scans: at six
// tenants it is six reads and no second index to drift out of true.
async function boardAccounts(env) {
  const listed = await env.DASHBOARD_TENANTS.list();
  const byContact = new Map();
  const byLocation = new Map();
  for (const { name } of listed.keys || []) {
    if (name.includes(":")) continue; // onboarding: and hostlogin: keys are not tenants
    const tenant = await env.DASHBOARD_TENANTS.get(name, { type: "json" });
    if (!tenant?.hostBoard?.enabled) continue;
    const entry = { locationId: name, label: tenant.label || name, tenant };
    byLocation.set(name, entry);
    if (tenant.hostBoard.contactId) byContact.set(tenant.hostBoard.contactId, entry);
  }
  return { byContact, byLocation };
}

// One webhook for all four events, not one per event.
//
// Yari, 2026-11-03. Four URLs would be four more WGHL_*_URL-shaped values to
// configure per environment, and that family has already been got backwards
// once -- these have to be GHL's OWN inbound-webhook trigger URL, not an
// endpoint on this Worker. One URL with a typed `event` is one thing to
// configure and one place to look when a message does not arrive.
//
// The guest's name is NOT in this payload and must never be. It would put the
// poster's client into an email sent to another host.
// The payload GHL maps.
//
// Three rules, all of them about the mapping step rather than about us. GHL's
// Inbound Webhook trigger learns the field list from a sample request, and
// whatever is not in that sample cannot be referenced in the workflow
// afterwards. So:
//
//   FLAT. A nested `poster: {label}` is fragile to reference and awkward to
//   read in the builder. Top-level keys only.
//
//   EVERY KEY ON EVERY EVENT. `releaseCount` and `reason` only mean something
//   on a release, but if they are absent from a `claimed` sample they are
//   unmappable, and one workflow has to handle all four events.
//
//   NEVER NULL. An empty or null value can be dropped when the sample is
//   captured, which silently costs a merge tag. Empty string, or 0.
//
// Changing this shape after Yari has mapped it means rebuilding the workflow,
// so it is worth being fussy here and nowhere else.
function boardEventPayload({
  event, opp, posterAccount, claimerAccount, releaseCount = 0, reason = "",
}) {
  const text = (v) => (v == null ? "" : String(v));
  return {
    event,
    requestCode: text(opp.id),
    zone: text(cfOf(opp, FIELD.zone)),
    // DD-MM-YYYY: the emails print these raw. Field NAMES and TYPES are
    // unchanged (still text), so the mapped trigger does not need redoing.
    checkIn: ddmmyyyy(cfOf(opp, FIELD.checkIn)),
    checkOut: ddmmyyyy(cfOf(opp, FIELD.checkOut)),
    guests: Number(cfOf(opp, FIELD.guests) || 0),
    posterAccountId: text(posterAccount?.locationId),
    posterLabel: text(posterAccount?.label),
    claimerAccountId: text(claimerAccount?.locationId),
    claimerLabel: text(claimerAccount?.label),
    releaseCount: Number(releaseCount || 0),
    reason: text(reason),
  };
}

async function notifyBoardEvent(env, payload) {
  const url = env.HOST_BOARD_EVENT_URL;
  if (!url) {
    console.error(`HOST_BOARD_EVENT_URL not set; ${payload.event} for ${payload.requestCode} not announced`);
    return false;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`Board event ${payload.event} rejected: ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    // Reported, never fatal. The stage has already moved; failing the request
    // would tell the host their claim did not happen when it did.
    console.error(`Board event ${payload.event} failed: ${err.message}`);
    return false;
  }
}

// What a request looks like to a given host.
//
// ONE redaction rule, not a stage-dependent one. Yari, 2026-11-03: a claim
// discloses the HOST's details, not the client's. The guest's name and the
// poster's private notes are the posting account's own record-keeping and go
// back only to that account -- there is no stage at which they open up to
// anybody else. A rule that changes with stage is a branch that eventually gets
// a condition wrong and leaks; this one cannot.
//
// The introduction between the two hosts happens by GHL workflow off
// notifyBoardEvent, so no contact details need to travel through this read at
// all.
function publicView(opp, { accounts, viewerLocationId, viewerContactId }) {
  const posterContactId = opp.contact?.id || opp.contactId || null;
  const poster = accounts.byContact.get(posterContactId) || null;
  const claimedByAccount = cfOf(opp, CLAIM.byAccount);
  const mine = Boolean(posterContactId) && posterContactId === viewerContactId;

  const view = {
    requestCode: opp.id,
    stage: STAGE_NAME[opp.pipelineStageId] || "unknown",
    zone: cfOf(opp, FIELD.zone),
    checkIn: String(cfOf(opp, FIELD.checkIn) || "").slice(0, 10) || null,
    checkOut: String(cfOf(opp, FIELD.checkOut) || "").slice(0, 10) || null,
    guests: cfOf(opp, FIELD.guests),
    rooms: cfOf(opp, FIELD.rooms),
    beds: cfOf(opp, FIELD.beds),
    pets: cfOf(opp, FIELD.pets),
    kids: cfOf(opp, FIELD.kids),
    elderly: cfOf(opp, FIELD.elderly),
    budget: cfOf(opp, FIELD.budget),
    postedByLabel: poster?.label || "A HOMS host",
    postedByMe: mine,
    claimedByLabel: cfOf(opp, CLAIM.byLabel),
    claimedByMe: Boolean(claimedByAccount) && claimedByAccount === viewerLocationId,
    claimedAt: String(cfOf(opp, CLAIM.at) || "").slice(0, 10) || null,
    // Claimed, but by nobody this Worker can name -- almost certainly moved by
    // hand in GHL. Surfaced rather than hidden: the page should offer it as
    // claimable, not show it as taken.
    claimUnattributed: STAGE_NAME[opp.pipelineStageId] === "claimed" && !claimedByAccount,
    releaseCount: Number(cfOf(opp, CLAIM.releases) || 0),
    createdAt: opp.createdAt || null,
  };

  // The poster's own private fields, back to the poster only.
  if (mine) {
    view.guestName = cfOf(opp, FIELD.guestName);
    view.notes = cfOf(opp, FIELD.notes);
  }
  return view;
}

async function fetchBoard(pit) {
  const res = await ghl(pit,
    `/opportunities/search?${new URLSearchParams({
      location_id: HOMS_LOCATION_ID, pipeline_id: PIPELINE_ID, limit: "100",
    })}`);
  // The search endpoint ignores pipeline_id through some callers, so the
  // pipeline is filtered again here rather than trusted. A board showing the
  // Lead Tracking pipeline would be a leak of Yari's sales records.
  return (res?.opportunities || []).filter((o) => o.pipelineId === PIPELINE_ID);
}

// GET /api/host/requests
export async function handleHostListRequests(request, env) {
  const host = await requireHost(request, env);
  if (host.denied) return host.denied;

  const pit = env.GHL_PIT_HOMS;
  if (!pit) return json({ error: "Server misconfigured: GHL_PIT_HOMS is not set" }, 500);

  try {
    const [board, accounts] = await Promise.all([fetchBoard(pit), boardAccounts(env)]);
    const ctx = {
      accounts,
      viewerLocationId: host.locationId,
      viewerContactId: host.tenant.hostBoard?.contactId || null,
    };
    const requests = board
      .filter((o) => STAGE_NAME[o.pipelineStageId] !== "closed")
      .map((o) => publicView(o, ctx))
      .sort((a, b) => String(a.checkIn || "").localeCompare(String(b.checkIn || "")));
    return json({ ok: true, requests, count: requests.length });
  } catch (err) {
    return json({ error: err.message || "Could not read the board" }, err.status || 502);
  }
}

// Load one request and confirm it is ours before touching it.
async function loadRequest(pit, id) {
  const res = await ghl(pit, `/opportunities/${encodeURIComponent(id)}`);
  const opp = res?.opportunity || res;
  if (!opp?.id) return { error: json({ error: "No such request" }, 404) };
  if (opp.pipelineId !== PIPELINE_ID) {
    // An id from another pipeline. Answering 404 rather than 403 keeps this
    // from being a way to probe which opportunity ids exist in the account.
    return { error: json({ error: "No such request" }, 404) };
  }
  return { opp };
}

// Writing a stage move.
//
// The whole customFields set goes back, not just the fields being changed.
// Whether GHL merges or replaces on this endpoint is not something to find out
// from a guest's record, and sending everything is correct under either.
async function writeStage(pit, opp, stageId, changes) {
  const merged = new Map(
    (opp.customFields || []).map((f) => [f.id, f.fieldValue])
  );
  for (const [id, value] of Object.entries(changes)) merged.set(id, value);
  return ghl(pit, `/opportunities/${encodeURIComponent(opp.id)}`, {
    method: "PUT",
    body: JSON.stringify({
      pipelineId: PIPELINE_ID,
      pipelineStageId: stageId,
      name: opp.name,
      status: "open",
      customFields: [...merged].map(([id, field_value]) => ({ id, field_value })),
    }),
  });
}

// POST /api/host/requests/:id/claim
export async function handleHostClaimRequest(request, env, id) {
  const host = await requireHost(request, env);
  if (host.denied) return host.denied;

  const pit = env.GHL_PIT_HOMS;
  if (!pit) return json({ error: "Server misconfigured: GHL_PIT_HOMS is not set" }, 500);

  const myContactId = host.tenant.hostBoard?.contactId || null;

  try {
    const { opp, error } = await loadRequest(pit, id);
    if (error) return error;

    // A card can reach Claimed without a claimer.
    //
    // Yari, 2026-11-03: nothing on the GHL side can populate Claimed By. A
    // workflow writes contact fields and there is no contact field for this;
    // worse, a workflow fired by a stage change has no idea which host did the
    // dragging, and the contact on the record is the POSTER. So a card dragged
    // to Claimed in the GHL UI sits in Claimed with no claimer recorded.
    //
    // That is not a claim, and treating it as one strands the request in
    // exactly the way this route exists to prevent: nobody could claim it
    // ("already claimed" -- by nobody) and only the poster could free it, while
    // the board told every other host it was taken. An unattributed hold is
    // therefore claimable.
    const stage = STAGE_NAME[opp.pipelineStageId];
    const heldBy = cfOf(opp, CLAIM.byAccount);
    const unattributed = stage === "claimed" && !heldBy;
    if (stage !== "active" && !unattributed) {
      return json({
        error: stage === "claimed"
          ? "Another host has already claimed this request."
          : "This request is no longer open.",
        code: "not_active", stage,
      }, 409);
    }
    if (unattributed) {
      console.warn(`Request ${opp.id} was in Claimed with no claimer recorded ` +
        `(moved by hand in GHL?); claiming it for ${host.locationId}`);
    }

    const posterContactId = opp.contact?.id || opp.contactId || null;
    if (posterContactId && posterContactId === myContactId) {
      // Harmless in itself, but it makes every count on the board meaningless
      // and there is no reason anybody would want it.
      return json({ error: "This is your own request.", code: "own_request" }, 403);
    }

    const accounts = await boardAccounts(env);
    const me = accounts.byLocation.get(host.locationId);
    const poster = accounts.byContact.get(posterContactId) || null;

    await writeStage(pit, opp, STAGE.claimed, {
      [CLAIM.byLabel]: me?.label || host.locationId,
      [CLAIM.byAccount]: host.locationId,
      [CLAIM.at]: todayDR(),
    });

    // READ BACK. GHL has no compare-and-swap on an opportunity stage: no
    // conditional write, no ETag, no version. Two hosts tapping Claim in the
    // same second both get a 200 from the write, and last-writer-wins means the
    // loser would be told they had it.
    //
    // So the 200 is not the evidence -- the record is. Whoever's account id is
    // in the field owns the claim. This narrows the window to the gap between
    // write and read-back; it does not close it, and nothing available here
    // can.
    const { opp: after } = await loadRequest(pit, id);
    const winner = cfOf(after, CLAIM.byAccount);
    if (winner !== host.locationId) {
      return json({
        error: "Another host claimed this a moment ago.",
        code: "claimed_by_another",
        claimedByLabel: cfOf(after, CLAIM.byLabel),
      }, 409);
    }

    const notified = await notifyBoardEvent(env, boardEventPayload({
      event: "claimed", opp,
      posterAccount: poster,
      claimerAccount: me || { locationId: host.locationId },
      releaseCount: Number(cfOf(opp, CLAIM.releases) || 0),
    }));

    return json({ ok: true, claimed: true, requestCode: opp.id, notified });
  } catch (err) {
    return json({ error: err.message || "Could not claim the request" }, err.status || 502);
  }
}

// POST /api/host/requests/:id/release
//
// Two callers, and that is the point of the route. A claimer who cannot fulfil
// needs a way out, and a poster whose claimer has gone quiet needs a way to
// take the request back. Without the second one, a poster is blocked by
// somebody else's inaction and the request sits in Claimed until the guest
// turns up with nowhere to sleep -- which is the worst thing this board can do.
export async function handleHostReleaseRequest(request, env, id) {
  const host = await requireHost(request, env);
  if (host.denied) return host.denied;

  const pit = env.GHL_PIT_HOMS;
  if (!pit) return json({ error: "Server misconfigured: GHL_PIT_HOMS is not set" }, 500);

  let body = {};
  try { body = (await request.json()) || {}; } catch { body = {}; }
  const reason = String(body.reason || "").trim().slice(0, 500);
  const myContactId = host.tenant.hostBoard?.contactId || null;

  try {
    const { opp, error } = await loadRequest(pit, id);
    if (error) return error;

    if (STAGE_NAME[opp.pipelineStageId] !== "claimed") {
      return json({ error: "This request is not currently claimed.", code: "not_claimed" }, 409);
    }

    const claimedByAccount = cfOf(opp, CLAIM.byAccount);
    const posterContactId = opp.contact?.id || opp.contactId || null;
    const isClaimer = Boolean(claimedByAccount) && claimedByAccount === host.locationId;
    const isPoster = Boolean(posterContactId) && posterContactId === myContactId;
    if (!isClaimer && !isPoster) {
      // Otherwise any host could release someone else's claim and take it.
      return json({ error: "Only the host who claimed this, or the host who posted it, can release it.", code: "not_yours" }, 403);
    }

    const accounts = await boardAccounts(env);
    const releaseCount = Number(cfOf(opp, CLAIM.releases) || 0) + 1;

    await writeStage(pit, opp, STAGE.active, {
      [CLAIM.byLabel]: "",
      [CLAIM.byAccount]: "",
      [CLAIM.at]: "",
      [CLAIM.releases]: releaseCount,
    });

    const notified = await notifyBoardEvent(env, boardEventPayload({
      event: isClaimer ? "released_by_claimer" : "released_by_poster", opp,
      posterAccount: accounts.byContact.get(posterContactId),
      claimerAccount: {
        locationId: claimedByAccount,
        label: cfOf(opp, CLAIM.byLabel),
      },
      releaseCount, reason,
    }));

    return json({
      ok: true, released: true, requestCode: opp.id,
      releasedBy: isClaimer ? "claimer" : "poster",
      releaseCount, notified,
    });
  } catch (err) {
    return json({ error: err.message || "Could not release the request" }, err.status || 502);
  }
}

// POST /api/host/requests/:id/fulfilled
//
// The POSTER marks this, never the claimer. Only the poster knows the guest
// actually booked. If the claimer could mark it, the honest reading of the
// button is "I would like this to look finished", and the board's Fulfilled
// count stops meaning anything.
export async function handleHostFulfilledRequest(request, env, id) {
  const host = await requireHost(request, env);
  if (host.denied) return host.denied;

  const pit = env.GHL_PIT_HOMS;
  if (!pit) return json({ error: "Server misconfigured: GHL_PIT_HOMS is not set" }, 500);

  const myContactId = host.tenant.hostBoard?.contactId || null;

  try {
    const { opp, error } = await loadRequest(pit, id);
    if (error) return error;

    if (STAGE_NAME[opp.pipelineStageId] !== "claimed") {
      return json({ error: "Only a claimed request can be marked filled.", code: "not_claimed" }, 409);
    }

    const posterContactId = opp.contact?.id || opp.contactId || null;
    if (!posterContactId || posterContactId !== myContactId) {
      return json({ error: "Only the host who posted this can mark it filled.", code: "not_poster" }, 403);
    }

    const accounts = await boardAccounts(env);
    await writeStage(pit, opp, STAGE.fulfilled, {});

    const notified = await notifyBoardEvent(env, boardEventPayload({
      event: "fulfilled", opp,
      posterAccount: accounts.byLocation.get(host.locationId)
        || { locationId: host.locationId },
      claimerAccount: {
        locationId: cfOf(opp, CLAIM.byAccount),
        label: cfOf(opp, CLAIM.byLabel),
      },
      releaseCount: Number(cfOf(opp, CLAIM.releases) || 0),
    }));

    return json({ ok: true, fulfilled: true, requestCode: opp.id, notified });
  } catch (err) {
    return json({ error: err.message || "Could not mark the request filled" }, err.status || 502);
  }
}
