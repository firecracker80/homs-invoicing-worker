// ghl.js -- direct GHL writes, replacing airtable.js as the per-tenant reporting
// layer. Each tenant needs `ghlPitSecretName` (a Worker secret name, same pattern
// as stripeSecretName) pointing at a Private Integration Token scoped for
// objects/record.write, objects/record.readonly, associations.readonly, and
// associations/relation.write on that tenant's own GHL sub-account.
//
// Snapshot carries the resolved record ids back (snapshot.ghl.transactionRecordId)
// so cancellation/reschedule can update the same Transaction record directly
// instead of re-searching for it every time.

const BASE = "https://services.leadconnectorhq.com";
const VERSION = "2021-07-28";

// One contact by id, for a name. Returns null rather than throwing on a contact
// that has been deleted or that this token cannot see: a missing name must
// never cost a statement its rows.
export async function fetchContactName(pit, contactId) {
  try {
    const res = await ghlRequest(pit, "GET", `/contacts/${encodeURIComponent(contactId)}`);
    const c = res?.contact || res || {};
    const full = [c.firstName, c.lastName].filter(Boolean).join(" ").trim();
    return c.name || full || c.companyName || c.email || null;
  } catch {
    return null;
  }
}

async function ghlRequest(pit, method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${pit}`,
      Version: VERSION,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(json.message || `GHL ${method} ${path} failed (${res.status})`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

// An object a client's account does not have is not an error -- it has no
// records, which is exactly what an empty list says.
//
// Yari is dropping ota_channels from the provisioning snapshot (2026-09-29),
// now that the dashboard no longer displays it. Without this, every account
// provisioned from that snapshot breaks in two places, both quietly:
//
//   the dashboard   /api/data throws on the first missing object, so the WHOLE
//                   dashboard goes down -- properties, transactions, everything
//                   -- not merely the part that was dropped
//
//   the Worker      syncRowsToGHL catches its own throw, so settlement still
//                   succeeds and the D1 ledger is still written, but NO
//                   Transaction record is ever created. The money is real and
//                   nothing in GHL shows it, which is the failure this whole
//                   codebase keeps having to find.
//
// Only 404 is swallowed, and only for this search. GHL answers a missing
// object with 404 and "Custom Object (key) not found" -- verified live against
// DEMO-HOMS on 2026-09-29. An expired PIT is 401 and an outage is 5xx, and
// both must still surface: an empty dashboard that reads "you have no
// properties" is worse than one that says it could not reach GHL.
export async function fetchAllObjectRecords(pit, locationId, objectKey, { cap = 500, pageLimit = 100 } = {}) {
  const all = [];
  let page = 1;
  while (all.length < cap) {
    let res;
    try {
      res = await ghlRequest(pit, "POST", `/objects/${objectKey}/records/search`, { locationId, page, pageLimit });
    } catch (err) {
      // `all` and not `[]`: on the first page they are the same thing, and on
      // any later one the pages already read are real records in hand.
      if (err?.status === 404) return all;
      throw err;
    }
    const records = res.records || [];
    all.push(...records);
    if (records.length < pageLimit) break;
    page += 1;
  }
  return all;
}

export async function createObjectRecord(pit, locationId, objectKey, properties) {
  const res = await ghlRequest(pit, "POST", `/objects/${objectKey}/records`, { locationId, properties });
  return res.record;
}

// locationId is required, despite not appearing in GHL's published parameter
// list for this endpoint. Without it the schema lookup has nothing to scope to
// and GHL answers "Custom Object (custom_objects.transactions) not found" --
// an object that demonstrably exists, since createObjectRecord had just written
// four records into it with this same PIT. Seen live on DEMO-HOMS booking
// 5LJInecEx6XApoXe19Qn, 2026-09-26: the cancellation computed correctly, the
// guest notification went out, and the Transaction kept saying paid.
//
// This was the only object call in the file that did not pass locationId.
export async function updateObjectRecord(pit, locationId, objectKey, recordId, properties) {
  const qs = locationId ? `?locationId=${encodeURIComponent(locationId)}` : "";
  const res = await ghlRequest(pit, "PUT", `/objects/${objectKey}/records/${recordId}${qs}`, { properties });
  return res.record;
}

export async function fetchAssociations(pit, locationId) {
  const res = await ghlRequest(pit, "GET", `/associations/?limit=100&skip=0&locationId=${encodeURIComponent(locationId)}`);
  return res.associations || [];
}

// An association between two object types, by their keys.
//
// `key` narrows it, and has to once a pair has more than one association. As of
// 2026-10-07 contact <-> properties has two -- property_owner and
// property_manager -- so asking by object keys alone is asking which of two
// different relationships you meant.
//
// Ambiguity returns null rather than the first match. A wrong link is silent and
// has to be found by noticing a statement addressed to the wrong person; a
// missing link shows up immediately as a record that did not link.
export function findAssociationId(associations, objectKeyA, objectKeyB, key = null) {
  const matches = associations.filter(
    (a) => (a.firstObjectKey === objectKeyA && a.secondObjectKey === objectKeyB) ||
           (a.firstObjectKey === objectKeyB && a.secondObjectKey === objectKeyA)
  );
  if (key) return matches.find((a) => a.key === key) || null;
  if (matches.length > 1) {
    console.error(
      `Ambiguous association for ${objectKeyA} <-> ${objectKeyB}: ${matches.map((a) => a.key).join(", ")}. ` +
      `Pass a key to say which one.`
    );
    return null;
  }
  return matches[0] || null;
}

// The owner and manager contacts a property is linked to.
//
// Both are contacts, so they are told apart by WHICH association each relation
// belongs to, not by the object type. The ids are per sub-account, which is why
// they are looked up by key rather than hardcoded.
export function propertyContactsFor(property, associations) {
  const idOf = (key) => associations.find((a) => a.key === key)?.id || null;
  // The objectKey check is defensive rather than load-bearing: an association id
  // belongs to one pair of object types, so a relation carrying the owner
  // association can only be pointing at a contact. No test distinguishes it and
  // none pretends to -- it is here so the intent survives somebody later reusing
  // an association id for something else.
  const pick = (assocId) =>
    (assocId && (property?.relations || []).find(
      (r) => r.associationId === assocId && r.objectKey === "contact")?.recordId) || null;
  return {
    ownerContactId: pick(idOf("property_owner")),
    managerContactId: pick(idOf("property_manager")),
  };
}

// locationId is required in the body (GHL added this requirement 2026-09-11 --
// omitting it now fails with "LocationId is not specified", not an auth error).
export async function createRelation(pit, locationId, associationId, firstRecordId, secondRecordId) {
  return ghlRequest(pit, "POST", "/associations/relations", { locationId, associationId, firstRecordId, secondRecordId });
}

// Links two records via whichever association connects the two object keys --
// resolved live, never hardcoded, so this works for any tenant's own association
// ids. Never throws: a missing association or a link failure is reported back,
// not raised, since this must never block real money movement.
export async function linkIfPossible(pit, locationId, associations, objectKeyA, recordIdA, objectKeyB, recordIdB) {
  const assoc = findAssociationId(associations, objectKeyA, objectKeyB);
  if (!assoc) return { linked: false, reason: `No association between ${objectKeyA} and ${objectKeyB}` };
  const firstRecordId = assoc.firstObjectKey === objectKeyA ? recordIdA : recordIdB;
  const secondRecordId = assoc.firstObjectKey === objectKeyA ? recordIdB : recordIdA;
  try {
    await createRelation(pit, locationId, assoc.id, firstRecordId, secondRecordId);
    return { linked: true };
  } catch (err) {
    return { linked: false, reason: err.message };
  }
}

// Best-effort name match against a tenant's own Properties/OTA Channels --
// these vary per client sub-account and the invoicing worker only carries a
// plain-text propertyCode/bookingSource, not a record id. A miss just skips
// that one association; it never blocks the Transaction/Payment write.
export function findRecordByName(records, nameField, name) {
  if (!name) return null;
  const target = String(name).trim().toLowerCase();
  return records.find((r) => String(r.properties?.[nameField] || "").trim().toLowerCase() === target) || null;
}
