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
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(json.message || `GHL ${method} ${path} failed (${res.status})`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

// Fetch every record for a custom/standard object, paginated, capped for safety.
export async function fetchAllObjectRecords(pit, locationId, objectKey, { cap = 1000, pageLimit = 100 } = {}) {
  const all = [];
  let page = 1;
  while (all.length < cap) {
    const res = await ghlRequest(pit, "POST", `/objects/${objectKey}/records/search`, {
      locationId,
      page,
      pageLimit,
    });
    const records = res.records || [];
    all.push(...records);
    if (records.length < pageLimit) break;
    page += 1;
  }
  return all;
}

// Single page of contacts (cap covers demo/small-account scale; extend with searchAfter paging if a real account outgrows it).
export async function fetchContacts(pit, locationId, { pageLimit = 100 } = {}) {
  const res = await ghlRequest(pit, "POST", "/contacts/search", {
    locationId,
    pageLimit,
    sort: [{ field: "dateAdded", direction: "desc" }],
  });
  return res.contacts || [];
}

// Resolved dynamically (not hardcoded) so this works for any tenant's own
// association IDs, not just DEMO-HOMS's -- verified shape against the real
// GET /associations/ response.
export async function fetchAssociations(pit, locationId) {
  const res = await ghlRequest(
    pit,
    "GET",
    `/associations/?limit=100&skip=0&locationId=${encodeURIComponent(locationId)}`
  );
  return res.associations || [];
}

export function findAssociationId(associations, objectKeyA, objectKeyB) {
  const match = associations.find(
    (a) =>
      (a.firstObjectKey === objectKeyA && a.secondObjectKey === objectKeyB) ||
      (a.firstObjectKey === objectKeyB && a.secondObjectKey === objectKeyA)
  );
  return match || null;
}

export async function createObjectRecord(pit, locationId, objectKey, properties) {
  const res = await ghlRequest(pit, "POST", `/objects/${objectKey}/records`, {
    locationId,
    properties,
  });
  return res.record;
}

// associationId/firstRecordId/secondRecordId per the association's stored direction --
// verified live against the Expense<->Property and Expense<->Owner associations.
// locationId is required in the body (GHL added this requirement 2026-09-11 --
// omitting it now fails with "LocationId is not specified", not an auth error).
export async function createRelation(pit, locationId, associationId, firstRecordId, secondRecordId) {
  return ghlRequest(pit, "POST", "/associations/relations", {
    locationId,
    associationId,
    firstRecordId,
    secondRecordId,
  });
}

// --- Custom values -----------------------------------------------------------
// Used by the provisioning reconciler (src/provision.js). GHL has no upsert for
// custom values: you GET the list, match, then POST or PUT. That branch is the
// whole reason provisioning lives in code rather than a linear automation tool.

export async function fetchCustomValues(pit, locationId) {
  const res = await ghlRequest(pit, "GET", `/locations/${encodeURIComponent(locationId)}/customValues`);
  return res.customValues || [];
}

export async function createCustomValue(pit, locationId, name, value, parentId = null) {
  const body = { name, value };
  if (parentId) body.parentId = parentId;
  const res = await ghlRequest(pit, "POST", `/locations/${encodeURIComponent(locationId)}/customValues`, body);
  return res.customValue || res;
}

// GHL requires name alongside value on update; sending value alone drops the name.
export async function updateCustomValue(pit, locationId, id, name, value) {
  const res = await ghlRequest(
    pit,
    "PUT",
    `/locations/${encodeURIComponent(locationId)}/customValues/${encodeURIComponent(id)}`,
    { name, value }
  );
  return res.customValue || res;
}

// --- Payments (vendor/P&L side) ---------------------------------------------
// altId + altType are REQUIRED on every payments/* call. The MCP does not backfill
// them and omitting altId fails differently per service -- the invoices service
// returns 401, which reads as an auth problem and is not. See ghl-registry-README.

export async function fetchSubscriptions(pit, locationId, { limit = 100 } = {}) {
  const qs = new URLSearchParams({ altId: locationId, altType: "location", limit: String(limit) });
  const res = await ghlRequest(pit, "GET", `/payments/subscriptions?${qs}`);
  return res.data || [];
}

export async function fetchTransactions(pit, locationId, { limit = 100 } = {}) {
  const qs = new URLSearchParams({ altId: locationId, altType: "location", limit: String(limit) });
  const res = await ghlRequest(pit, "GET", `/payments/transactions?${qs}`);
  return res.data || [];
}

// --- Services flow (src/services.js) -----------------------------------------
// Record/contact/estimate/invoice calls against a service vendor's own account
// (RL Santana first). Shapes checked against describe_operation 2026-09-14.

export async function getObjectRecord(pit, locationId, objectKey, recordId) {
  const res = await ghlRequest(
    pit,
    "GET",
    `/objects/${objectKey}/records/${recordId}?locationId=${encodeURIComponent(locationId)}`
  );
  return res.record || null;
}

// Update bodies reject locationId (422 "property locationId should not exist"),
// so it travels in the query string instead.
export async function updateObjectRecord(pit, locationId, objectKey, recordId, properties) {
  const res = await ghlRequest(
    pit,
    "PUT",
    `/objects/${objectKey}/records/${recordId}?locationId=${encodeURIComponent(locationId)}`,
    { properties }
  );
  return res.record || null;
}

export async function fetchRecordRelations(pit, locationId, recordId) {
  const qs = new URLSearchParams({ locationId, limit: "100", skip: "0" });
  const res = await ghlRequest(pit, "GET", `/associations/relations/${recordId}?${qs}`);
  return res.relations || [];
}

export async function getContact(pit, contactId) {
  const res = await ghlRequest(pit, "GET", `/contacts/${contactId}`);
  return res.contact || null;
}

export async function getLocation(pit, locationId) {
  const res = await ghlRequest(pit, "GET", `/locations/${locationId}`);
  return res.location || null;
}

export async function createEstimate(pit, body) {
  return ghlRequest(pit, "POST", "/invoices/estimate", body);
}

export async function sendEstimate(pit, locationId, estimateId, { userId, action, liveMode }) {
  return ghlRequest(pit, "POST", `/invoices/estimate/${estimateId}/send`, {
    altId: locationId,
    altType: "location",
    userId,
    action,
    liveMode,
  });
}

export async function createInvoiceFromEstimate(pit, locationId, estimateId) {
  const res = await ghlRequest(pit, "POST", `/invoices/estimate/${estimateId}/invoice`, {
    altId: locationId,
    altType: "location",
    markAsInvoiced: true,
  });
  return res.invoice || null;
}

// altId is required at runtime on every invoices/* call even where the schema
// omits it -- a missing altId comes back as a misleading 401.
export async function getInvoice(pit, locationId, invoiceId) {
  const qs = new URLSearchParams({ altId: locationId, altType: "location" });
  return ghlRequest(pit, "GET", `/invoices/${invoiceId}?${qs}`);
}

export async function updateInvoice(pit, invoiceId, body) {
  return ghlRequest(pit, "PUT", `/invoices/${invoiceId}`, body);
}

export async function sendInvoice(pit, locationId, invoiceId, { userId, action, liveMode }) {
  return ghlRequest(pit, "POST", `/invoices/${invoiceId}/send`, {
    altId: locationId,
    altType: "location",
    userId,
    action,
    liveMode,
  });
}
