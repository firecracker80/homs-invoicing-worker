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
export async function fetchAllObjectRecords(pit, locationId, objectKey, { cap = 1000, pageLimit = 100 } = {}) {
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
// Restores a field's own constraints. The whole field is sent because
// update-custom-field replaces it: `showInForms` is REQUIRED on this endpoint,
// so omitting it silently flips whether the field appears in forms, and `name`
// is echoed so a repair never renames anything -- which matters most on a
// Spanish account, where the name is the translated label.
export async function updateCustomField(pit, locationId, fieldId, body) {
  if (!locationId) throw new Error("updateCustomField needs a locationId");
  // In the BODY, and the query form is REJECTED -- the exact opposite of
  // updateObjectRecord above, which takes locationId in the QUERY and refuses
  // it in the body. Verified live on DEMO-HOMS 2026-10-08: query form 422
  // "locationId must be a string", body form 200.
  //
  // GHL is not consistent about this between endpoints -- records want it in
  // the query, custom fields in the body, record DELETE refuses it entirely,
  // and the conversations export wants it in the query. Neither convention can
  // be inferred from the other; each one has to be checked.
  const res = await ghlRequest(pit, "PUT", `/custom-fields/${encodeURIComponent(fieldId)}`,
    { ...body, locationId });
  return res.field || res;
}

export async function createCustomField(pit, locationId, body) {
  const res = await ghlRequest(pit, "POST", "/custom-fields/", { ...body, locationId });
  return res.field || res;
}

export async function deleteCustomField(pit, locationId, fieldId) {
  return ghlRequest(pit, "DELETE", `/custom-fields/${encodeURIComponent(fieldId)}?locationId=${encodeURIComponent(locationId)}`);
}

// How many records an object holds. Used before deleting a field, because
// deleting a custom field in GHL takes its stored values with it.
export async function countObjectRecords(pit, locationId, objectKey) {
  const res = await ghlRequest(pit, "POST", `/objects/${objectKey}/records/search`,
    { locationId, page: 1, pageLimit: 1 });
  return Number(res.total ?? (res.records || []).length);
}

// ---- Object schemas, for verifying a provisioned account --------------------
// Read-only. The PIT lives on the Worker as a per-tenant secret, which is why
// this belongs here and not in a local script: capturing a client account's
// schema from a laptop would mean exporting that secret.

export async function fetchObjectSchemas(pit, locationId) {
  const res = await ghlRequest(pit, "GET", `/objects/?locationId=${encodeURIComponent(locationId)}`);
  return res.objects || [];
}

export async function fetchObjectFields(pit, locationId, objectKey) {
  const res = await ghlRequest(pit, "GET",
    `/custom-fields/object-key/${encodeURIComponent(objectKey)}?locationId=${encodeURIComponent(locationId)}`);
  return { fields: res.fields || [], folders: res.folders || [] };
}

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
  // Live, the response carried no `invoice` key even though the invoice was
  // created (2026-09-15) -- return the raw body; callers find the invoice by
  // its sourceId instead of trusting this shape.
  return res;
}

// Invoices for one contact, newest first as GHL returns them. Used to find the
// invoice an estimate produced: it carries source "estimate" + sourceId.
export async function listContactInvoices(pit, locationId, contactId, { limit = 50 } = {}) {
  const qs = new URLSearchParams({ altId: locationId, altType: "location", contactId, limit: String(limit), offset: "0" });
  const res = await ghlRequest(pit, "GET", `/invoices/?${qs}`);
  return res.invoices || [];
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

// Estimates for this location, newest first as GHL returns them. Used to turn an
// estimate NUMBER (what GHL's merge tag gives) into its id.
export async function listEstimates(pit, locationId, { limit = 50 } = {}) {
  const qs = new URLSearchParams({ altId: locationId, altType: "location", limit: String(limit), offset: "0" });
  const res = await ghlRequest(pit, "GET", `/invoices/estimate/list?${qs}`);
  return res.estimates || [];
}

// Contact task, assigned to a user. Tasks can only be assigned to users, not contacts.
// ---- Receipts in the media library -----------------------------------------
//
// A receipt's file goes in the media library, and the JOIN to its expense lives
// in the filename plus one folder. Not in a field, and not in an index.
//
// Not a field, because FILE_UPLOAD custom fields cannot be SET through the
// records API -- probed on DEMO-HOMS 2026-10-07, ten value shapes, every one
// 422 "We couldn't process file updates for Receipt Photo", and a bare url
// string returns 200 and is silently dropped. A plain TEXT field would hold one
// url and be overwritten by the second receipt, where the native field takes
// five.
//
// Not a KV or D1 index, because that is a second copy of something the media
// library already knows, free to drift from it. Here the library is the only
// source of truth, and a one-folder listing is a real query: parentId filters
// on both upload and list (verified) -- unlike `query`, which is accepted and
// then ignored, returning everything.
const RECEIPTS_FOLDER = "HOMS Receipts";
const RECEIPT_SEP = "--";

// The record id leads, so the id is always the part before the FIRST separator
// even when the original filename contains one too. Slashes out, because the
// name becomes a path segment; tail-truncated, because the extension is the
// part worth keeping when a phone hands over a 200-character name.
export const receiptFileName = (recordId, filename) =>
  `${recordId}${RECEIPT_SEP}${String(filename || "receipt").replace(/[/\\]/g, "_").slice(-80)}`;

export function recordIdFromReceipt(name) {
  const at = String(name || "").indexOf(RECEIPT_SEP);
  return at > 0 ? String(name).slice(0, at) : null;
}

export async function ensureReceiptsFolder(pit, locationId) {
  const list = await ghlRequest(pit, "GET",
    `/medias/files?altType=location&altId=${encodeURIComponent(locationId)}&type=folder&limit=100`);
  const found = (list.files || []).find((f) => f.name === RECEIPTS_FOLDER);
  if (found) return found._id || found.id;

  const made = await ghlRequest(pit, "POST", "/medias/folder",
    { name: RECEIPTS_FOLDER, altType: "location", altId: locationId });
  const id = made.folder?._id || made._id || made.id;
  if (!id) throw new Error("Could not create the receipts folder in the media library");
  return id;
}

// Multipart, so not ghlRequest: that sets Content-Type: application/json, and
// a FormData body needs fetch to set it so the boundary matches.
export async function uploadReceipt(pit, locationId, { recordId, filename, bytes, contentType, parentId }) {
  const name = receiptFileName(recordId, filename);
  const fd = new FormData();
  fd.append("file", new Blob([bytes], { type: contentType }), name);
  fd.append("hosted", "false");
  fd.append("name", name);
  if (parentId) fd.append("parentId", parentId);

  const res = await fetch(
    `${BASE}/medias/upload-file?altType=location&altId=${encodeURIComponent(locationId)}`,
    { method: "POST", headers: { Authorization: `Bearer ${pit}`, Version: VERSION }, body: fd });

  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(json.message || `Receipt upload failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return { documentId: json.fileId, url: json.url, name };
}

// Every receipt on the account, grouped by the expense it belongs to. Paged:
// one page is 100 files, and a client that has been filing receipts for a year
// has more than that -- a silent truncation would quietly stop showing the
// oldest ones.
export async function listReceipts(pit, locationId, parentId, { cap = 2000, pageLimit = 100 } = {}) {
  const byRecord = {};
  for (let offset = 0; offset < cap; offset += pageLimit) {
    const out = await ghlRequest(pit, "GET",
      `/medias/files?altType=location&altId=${encodeURIComponent(locationId)}` +
      `&type=file&parentId=${encodeURIComponent(parentId)}&limit=${pageLimit}&offset=${offset}` +
      `&sortBy=createdAt&sortOrder=desc`);
    const files = out.files || [];
    for (const f of files) {
      const id = recordIdFromReceipt(f.name);
      if (!id) continue; // something a person dropped in the folder by hand
      (byRecord[id] ||= []).push({
        url: f.url,
        name: String(f.name).slice(id.length + RECEIPT_SEP.length),
        contentType: f.contentType || null,
        size: f.size ?? null,
        uploadedAt: f.createdAt || null,
      });
    }
    if (files.length < pageLimit) break;
  }
  return byRecord;
}

export async function createContactTask(pit, contactId, { title, body, dueDate, assignedTo }) {
  const res = await ghlRequest(pit, "POST", `/contacts/${contactId}/tasks`, {
    title,
    body,
    dueDate,
    completed: false,
    assignedTo,
  });
  return res.task || res;
}
