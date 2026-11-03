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
// PRIVACY. Two of the thirteen fields are private and must never reach the board
// before a claim: Guest Name and Additional Notes. They are written here and
// released only by the claim route, which does not exist yet. A privacy rule the
// page merely chooses not to display is not a rule.

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
