// Client support panel - read-only.
//
// REWRITTEN 2026-10-31. The first version mirrored every ticket into a
// `Support Request` object in the client's own account, with a two-endpoint
// Worker bridge, a dedupe key and a replay test. Yari asked the obvious
// question - the client reads their tickets in the dashboard, and the dashboard
// Worker already holds HOMS's PIT, so why copy anything? - and she was right.
// The mirror, the object, the bridge and the whole class of sync bugs are gone.
//
// Shape now:
//   intake  - an AI Studio page -> HOMS contact fields -> workflow
//   record  - the Opportunity itself, in HOMS pipeline `Support Request`
//             (sCd5ajpPg4VFDNpHhlGz), ticket data on opportunity custom fields
//   Yari    - drags stages on that pipeline. One queue, every client.
//   client  - this endpoint, rendered as a dashboard tab and translated by the
//             dashboard's own language toggle
//
// Nothing is written here. Status can never drift, because there is only one
// copy of it: the stage Yari last dragged.
//
// ISOLATION. Reading from one central pipeline means a client must only ever
// see their own tickets. That is already enforced for free: this route sits
// BELOW the default-deny `requireAdmin` gate, and that gate compares the
// requested locationId against the signed session's own and returns 403 on a
// mismatch. A client session reaches exactly one account, so this endpoint
// cannot serve another client's tickets even though they share a pipeline.
//
// Worth stating because the first draft of this file said the opposite: it was
// written against a month-stale copy of the dashboard in which ADMIN_KEY was a
// single shared secret and locationId came off the query string unchecked. In
// the real tree that was fixed with signed per-client sessions. The filter below
// is still exact-match and still belt-and-braces, but it is not the only thing
// standing between one client and another's data.

import { getTenant } from "./tenants.js";

const HOMS_LOCATION_ID = "dytwzgmOP5v0Jh7gop4y";
const SUPPORT_PIPELINE_ID = "sCd5ajpPg4VFDNpHhlGz";

// Opportunity custom fields created in HOMS 2026-10-31. Keyed by field id
// because that is what an opportunity's customFields array carries; the
// fieldKey is not always present on a record read.
const FIELD = {
  account: "iAhHfN3rgoVzayhDlcPB",       // opportunity.support_account
  type: "m0pxFtRxWWEoY0pFkAiX",          // opportunity.support_type
  description: "nLdsJzmcZcO6F18vzT7J",   // opportunity.support_description
  raisedBy: "ZhTmMCAa6LuKrso5IRbC",      // opportunity.support_raised_by
  firstReply: "12MLCkuo3u70lxs3anXF",    // opportunity.support_first_reply
  resolution: "IZLaafJe15Edqd1GIQGY",    // opportunity.support_resolution
  screenshots: "rzGhALueRJPlrai28axh",   // opportunity.support_screenshots
};

// Stage id -> the English label the dashboard's i18n dictionary is keyed on.
// Read from the live pipeline, not typed from memory. Ids rather than names so
// renaming a stage in the UI cannot silently break the mapping - which is what
// would have happened with the name-matching the mirror version used.
const STAGE = {
  "728bd9c9-b304-4991-b90f-287fa4dce1f8": "New",
  "d899783c-c2b8-4c6a-9988-1639c3bfdc11": "In progress",
  "dd7240e0-c3a8-48b0-aa6b-b72e9145a8c8": "Waiting on you",
  "c2bda765-b876-482a-9783-ca0a65e45485": "Resolved",
};

async function homsRequest(pit, path) {
  const res = await fetch(`https://services.leadconnectorhq.com${path}`, {
    headers: {
      Authorization: `Bearer ${pit}`,
      Version: "2021-07-28",
      Accept: "application/json",
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // A non-JSON 200 is a real failure mode here, not a parse quirk - a
    // same-zone Worker refusal once arrived as a 200 of plain text that read
    // like a JSON bug. Surface the status and the body rather than guessing.
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

function cf(opp, id) {
  const list = opp.customFields || opp.customField || [];
  const hit = list.find((f) => f.id === id);
  if (!hit) return null;
  // GHL returns the value under whichever of these fits the field type.
  return hit.fieldValue ?? hit.value ?? hit.fieldValueString ?? hit.fieldValueArray ?? null;
}

// Pages the pipeline and filters in code. The custom-field filter is done here
// rather than in the query because opportunity search does not reliably filter
// on custom fields, and silently returning the unfiltered set would be the
// worst possible bug in this file. Volume is one agency's support tickets.
async function fetchPipelineOpportunities(pit) {
  const out = [];
  let page = 1;
  for (;;) {
    const qs = new URLSearchParams({
      location_id: HOMS_LOCATION_ID,
      pipeline_id: SUPPORT_PIPELINE_ID,
      limit: "100",
      page: String(page),
    });
    const body = await homsRequest(pit, `/opportunities/search?${qs}`);
    const batch = body?.opportunities || [];
    out.push(...batch);
    if (batch.length < 100 || page >= 20) break;
    page += 1;
  }
  return out;
}

// GET /api/support?locationId=...
// Returns that one client's tickets, newest first, shaped for the dashboard tab.
export async function handleSupportList(request, env) {
  const url = new URL(request.url);
  const locationId = url.searchParams.get("locationId");
  if (!locationId) {
    return Response.json({ error: "locationId is required" }, { status: 422 });
  }

  // The tenant lookup is not decoration: it means an arbitrary string cannot be
  // used to probe the pipeline, only a locationId this dashboard already serves.
  const tenant = await getTenant(env, locationId);
  if (!tenant) {
    return Response.json({ error: `${locationId} is not in DASHBOARD_TENANTS` }, { status: 404 });
  }

  const pit = env.GHL_PIT_HOMS;
  if (!pit) {
    return Response.json(
      { error: "Server misconfigured: GHL_PIT_HOMS is not set" },
      { status: 500 }
    );
  }

  try {
    const all = await fetchPipelineOpportunities(pit);
    const mine = all.filter((o) => {
      const acct = cf(o, FIELD.account);
      return typeof acct === "string" && acct.trim() === locationId;
    });

    const tickets = mine
      .map((o) => ({
        id: o.id,
        subject: o.name || "(no subject)",
        // An unmapped stage reads as the raw id rather than as a cheerful
        // default: a new stage should look wrong on screen, not look like "New".
        status: STAGE[o.pipelineStageId] || `Unmapped stage ${o.pipelineStageId}`,
        type: cf(o, FIELD.type),
        description: cf(o, FIELD.description),
        raisedBy: cf(o, FIELD.raisedBy),
        firstReply: cf(o, FIELD.firstReply),
        resolution: cf(o, FIELD.resolution),
        screenshots: cf(o, FIELD.screenshots),
        submittedOn: o.createdAt || o.dateAdded || null,
        updatedAt: o.updatedAt || null,
        closed: o.status && o.status !== "open",
      }))
      .sort((a, b) => String(b.submittedOn || "").localeCompare(String(a.submittedOn || "")));

    return Response.json({
      locationId,
      tenant: tenant.label || locationId,
      tickets,
      // Both counts, deliberately: `scanned` is how many tickets exist across
      // every client, `count` how many belong to this one. If those are ever
      // equal with more than one client live, the filter is not filtering.
      count: tickets.length,
      scanned: all.length,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    return Response.json(
      { error: err.message || "Could not read support requests", status: err.status || 500 },
      { status: err.status && err.status >= 400 && err.status < 600 ? err.status : 502 }
    );
  }
}
