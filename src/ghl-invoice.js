// ghl-invoice.js
// Additive GHL invoice-enrichment path for HOMS.
// Targets the DRAFT invoice the rental calendar already auto-creates at
// booking (rent line only, no payment recorded) and APPENDS the computed
// cleaning / deposit / processing-fee lines to it, then sends it.
//
// This module is PURE ADD. It does not import or modify the existing
// PayPal-URL flow in index.js. Wire it behind INVOICE_STRATEGY with a
// try/catch fallback (see index.js) so a failure here degrades to exactly
// today's behavior.
//
// Schema verified 2026-08-08 against the live GHL public API (describe_operation
// on invoices.list-invoices / get-invoice / update-invoice / send-invoice) —
// corrected from an earlier draft that assumed a different shape:
//   - list-invoices has NO altId query param, only altType (+ contactId/status/etc).
//   - update-invoice (PUT) requires the FULL body: name, currency, issueDate,
//     dueDate are all required alongside invoiceItems -- NOT invoiceItems alone.
//     So enrichment always does get-invoice first and echoes those fields back.
//   - invoiceItems IS the correct body key (confirmed on both get and update).
//   - send-invoice's real required body is { altId, altType, userId, action, liveMode }
//     where action is one of sms_and_email | send_manually | email | sms.
//     There is no sendTo/deliver field in the real schema.
//
// Auth is PER-TENANT (this is a multi-tenant worker, one GHL token per
// client sub-account) -- mirrors the paypalSecretName/airtableToken pattern
// already used in paypal.js/stripe.js/airtable.js. Tenant KV needs either
// ghlToken (inline, fine for pilot) or ghlTokenSecretName (Worker secret,
// recommended once past a couple of clients), plus ghlUserId.

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";

function resolveSecret(tenant, env, nameKey, inlineKey) {
  if (tenant[nameKey] && env[tenant[nameKey]]) return env[tenant[nameKey]];
  return tenant[inlineKey];
}

// --- thin GHL REST helper -------------------------------------------------
async function ghlFetch(tenant, env, path, { method = "GET", body } = {}, fetchImpl = fetch) {
  const token = resolveSecret(tenant, env, "ghlTokenSecretName", "ghlToken");
  if (!token) throw new Error("No GHL token configured for this tenant (ghlToken / ghlTokenSecretName)");
  const res = await fetchImpl(`${GHL_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Version: GHL_VERSION,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = new Error(`GHL ${method} ${path} -> ${res.status}`);
    err.status = res.status;
    err.payload = json;
    throw err;
  }
  return json;
}

// --- the lines we append to the rent line GHL already created ------------
// Booking-composer output shape (real field names, confirmed against
// booking-composer.js): snapshot.charges.{cleaningFee,processingFee},
// snapshot.securityDeposit.total. Currency lives on the TENANT, not the
// snapshot -- pass it separately.
export function buildAppendItems(snapshot, tenant) {
  const cur = tenant.currency || "USD";
  const items = [];
  if (snapshot.charges.cleaningFee > 0)
    items.push({ name: "Limpieza / Cleaning fee", currency: cur, amount: round2(snapshot.charges.cleaningFee), qty: 1 });
  if (snapshot.securityDeposit.total > 0)
    items.push({ name: "Depósito de seguridad / Security deposit", currency: cur, amount: round2(snapshot.securityDeposit.total), qty: 1 });
  if (snapshot.charges.processingFee > 0)
    items.push({ name: "Cargo por procesamiento / Processing fee", currency: cur, amount: round2(snapshot.charges.processingFee), qty: 1 });
  return items;
}

// --- resolve the draft's _id ---------------------------------------------
// Prefer the id handed to you on the booking webhook. Fall back to a scoped
// list-invoices lookup keyed by contact + our correlation number.
// NOTE: list-invoices has no altId param in the real API -- the token's
// bound location scopes the result implicitly.
export async function resolveDraftInvoiceId(
  { tenant, env, contactId, bookingId, hintedInvoiceId },
  fetchImpl = fetch
) {
  if (hintedInvoiceId) return hintedInvoiceId;

  const q = new URLSearchParams({
    altType: "location",
    contactId,
    status: "draft",
    limit: "20",
    offset: "0"
  });
  const list = await ghlFetch(tenant, env, `/invoices/?${q}`, {}, fetchImpl);
  const invoices = list.invoices || [];
  const wanted = `CC-${bookingId}`;

  const byNumber = invoices.find(i => i.invoiceNumber === wanted);
  if (byNumber) return byNumber._id;

  // no correlation number yet -> newest draft for this contact
  const newest = invoices.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  if (!newest) throw new Error(`No draft invoice found for contact ${contactId} / booking ${bookingId}`);
  return newest._id;
}

// --- enrich + send ---------------------------------------------------------
export async function enrichAndSendInvoice(
  { tenant, env, locationId, invoiceId, snapshot, contact },
  fetchImpl = fetch
) {
  // update-invoice requires the full body (name/currency/issueDate/dueDate
  // are required alongside invoiceItems) -- fetch the draft first so we can
  // echo its existing fields back untouched and only grow invoiceItems.
  const existing = await ghlFetch(
    tenant, env, `/invoices/${invoiceId}?altType=location`, {}, fetchImpl
  );

  const appendItems = buildAppendItems(snapshot, tenant);
  const invoiceItems = [...(existing.invoiceItems || []), ...appendItems];

  await ghlFetch(
    tenant, env, `/invoices/${invoiceId}`,
    {
      method: "PUT",
      body: {
        altId: locationId,
        altType: "location",
        name: existing.name || `Reserva ${snapshot.bookingId}`,
        title: existing.title,
        currency: existing.currency || tenant.currency || "USD",
        invoiceNumber: `CC-${snapshot.bookingId}`,
        contactDetails: contact,
        invoiceItems,
        issueDate: existing.issueDate,
        dueDate: existing.dueDate,
        businessDetails: existing.businessDetails
      }
    },
    fetchImpl
  );

  const userId = resolveSecret(tenant, env, "ghlUserIdSecretName", "ghlUserId");
  if (!userId) throw new Error("No GHL userId configured for this tenant (ghlUserId / ghlUserIdSecretName) -- required by send-invoice");

  const sent = await ghlFetch(
    tenant, env, `/invoices/${invoiceId}/send`,
    {
      method: "POST",
      body: {
        altId: locationId,
        altType: "location",
        userId,
        action: tenant.ghlInvoiceSendAction || "sms_and_email",
        liveMode: tenant.ghlInvoiceLiveMode ?? true
      }
    },
    fetchImpl
  );

  return { invoiceId, items: invoiceItems, appendedItems: appendItems, sent };
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}
