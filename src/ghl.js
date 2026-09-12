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

export async function fetchAllObjectRecords(pit, locationId, objectKey, { cap = 500, pageLimit = 100 } = {}) {
  const all = [];
  let page = 1;
  while (all.length < cap) {
    const res = await ghlRequest(pit, "POST", `/objects/${objectKey}/records/search`, { locationId, page, pageLimit });
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

export async function updateObjectRecord(pit, objectKey, recordId, properties) {
  const res = await ghlRequest(pit, "PUT", `/objects/${objectKey}/records/${recordId}`, { properties });
  return res.record;
}

export async function fetchAssociations(pit, locationId) {
  const res = await ghlRequest(pit, "GET", `/associations/?limit=100&skip=0&locationId=${encodeURIComponent(locationId)}`);
  return res.associations || [];
}

export function findAssociationId(associations, objectKeyA, objectKeyB) {
  return associations.find(
    (a) => (a.firstObjectKey === objectKeyA && a.secondObjectKey === objectKeyB) ||
           (a.firstObjectKey === objectKeyB && a.secondObjectKey === objectKeyA)
  ) || null;
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
