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
// Schema checked 2026-08-08 against describe_operation's public parameter
// listing for invoices.list-invoices / get-invoice / update-invoice /
// send-invoice, then corrected again 2026-08-09 against a real 401 in
// production:
//   - update-invoice (PUT) requires the FULL body: name, currency, issueDate,
//     dueDate are all required alongside invoiceItems -- NOT invoiceItems alone.
//     So enrichment always does get-invoice first and echoes those fields back.
//   - invoiceItems IS the correct body key (confirmed on both get and update).
//   - send-invoice's real required body is { altId, altType, userId, action, liveMode }
//     where action is one of sms_and_email | send_manually | email | sms.
//     There is no sendTo/deliver field in the real schema.
//   - altId + altType are BOTH required on every call, including list-invoices
//     and get-invoice -- describe_operation's parameter listing doesn't
//     include altId for those two, but omitting it 401s for real. Don't
//     trust the schema tool over a live 401 on this API; this project's own
//     registry already learned that lesson once for payments/invoices.
//   - list-invoices' status query param does NOT reliably match a rental-
//     calendar-created draft -- "draft" was never verified against a real
//     response and returned zero results live for a confirmed-existing
//     draft. Don't filter by status server-side; fetch the contact's
//     invoices and exclude "paid" client-side instead (a status confirmed
//     from real data) -- see resolveDraftInvoiceId.
//   - update-invoice 422s on THREE more things confirmed live, all from
//     blindly echoing get-invoice's response shape into the PUT body:
//     (1) issueDate/dueDate must be YYYY-MM-DD, but get-invoice returns
//     full ISO datetimes -- truncate with dateOnly(). (2) discount 422s
//     as "should not be empty" despite the schema marking it optional --
//     always send one. (3) contactDetails.phoneNo must be E.164; a raw
//     {{contact.phone}} merge tag isn't guaranteed to already be in that
//     form -- normalize with toE164().
//
// Auth is PER-TENANT (this is a multi-tenant worker, one GHL Private
// Integration Token per client sub-account) -- mirrors the
// paypalSecretName/airtableToken pattern already used in
// paypal.js/stripe.js/airtable.js. Tenant KV needs either ghlPit (inline,
// fine for pilot) or ghlPitSecretName (Worker secret, recommended once past
// a couple of clients). Field name matches the "PIT" term GHL itself uses
// for these tokens (see ghl-account-registry.json's pit_connector), and the
// name already in use on existing tenant entries.
//
// bookingId is NOT something HOMS invents -- it IS the real rental-calendar
// booking id, captured at the contact level in GHL and fed to
// /booking-created via the {{contact.booking_id}} merge tag.
//
// GHL's own invoice number is left exactly as GHL assigned it (2026-09-21).
// Appending the booking id ("000005-rpbWV3iis3rDG1gBB7Ky") overflowed the
// Invoice No column on GHL's hosted invoice page into Issue Date, and that
// page's CSS isn't ours to change. Retries are guarded in index.js instead:
// the booking snapshot records the invoice as "sending" before it's touched,
// and GHL's own invoice status (draft / sent / viewed / paid / void) says
// whether a run that died part-way still needs finishing.
//
// userId (required by send-invoice) is likewise per-REQUEST, not
// per-tenant config: it comes from {{user.id}} on the booking webhook, same
// as contactId/locationId already do. Keeps onboarding a new client to
// zero static per-tenant GHL-user config -- it scales across every user in
// every account without a KV entry per person.
import { yesNo, isPetFeeName, depositConfigFor } from "./policy.js";
import { calcSecurityDeposit } from "./deposit-engine.js";

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";

function resolveSecret(tenant, env, nameKey, inlineKey) {
  if (tenant[nameKey] && env[tenant[nameKey]]) return env[tenant[nameKey]];
  return tenant[inlineKey];
}

// --- thin GHL REST helper -------------------------------------------------
async function ghlFetch(tenant, env, path, { method = "GET", body } = {}, fetchImpl = fetch) {
  const token = resolveSecret(tenant, env, "ghlPitSecretName", "ghlPit");
  if (!token) throw new Error("No GHL PIT configured for this tenant (ghlPit / ghlPitSecretName)");
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
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    // The status alone is useless for a 422 -- GHL's validation message
    // names the exact field. Put the body IN the message (not just .payload)
    // so it actually shows up in console.error / the log stream, matching
    // how every other GHL-write debugging round in this project has worked.
    const err = new Error(`GHL ${method} ${path} -> ${res.status} ${JSON.stringify(json).slice(0, 500)}`);
    err.status = res.status;
    err.payload = json;
    throw err;
  }
  return json;
}

export async function fetchInvoice({ tenant, env, locationId, invoiceId }, fetchImpl = fetch) {
  return ghlFetch(tenant, env, `/invoices/${invoiceId}?altId=${encodeURIComponent(locationId)}&altType=location`, {}, fetchImpl);
}

export async function listContactInvoices({ tenant, env, locationId, contactId }, fetchImpl = fetch) {
  const q = new URLSearchParams({ altId: locationId, altType: "location", contactId, limit: "50", offset: "0" });
  const list = await ghlFetch(tenant, env, `/invoices/?${q}`, {}, fetchImpl);
  return list.invoices || [];
}

// The rental booking an invoice belongs to (GHL's calendar stamps it).
export function bookingIdOf(invoice) {
  return invoice?.sourceId || invoice?.meta?.serviceBookingId || null;
}

// --- the lines we append to the rent line GHL already created ------------
// Booking-composer output shape (real field names, confirmed against
// booking-composer.js): snapshot.charges.{cleaningFee,processingFee},
// snapshot.securityDeposit.total. Currency lives on the TENANT, not the
// snapshot -- pass it separately.
// Cleaning is GHL-native now and never appended; the deposit is only here for
// a "tiered_legacy" tenant (the composer leaves it at 0 for everyone else).
const DEPOSIT_LINE = "Depósito de seguridad / Security deposit";
const FEE_LINE = "Cargo por procesamiento / Processing fee";
const OUR_LINES = new Set([DEPOSIT_LINE, FEE_LINE]);

export function buildAppendItems(snapshot, tenant) {
  const cur = tenant.currency || "USD";
  const items = [];
  if (snapshot.securityDeposit.total > 0)
    items.push({ name: DEPOSIT_LINE, currency: cur, amount: round2(snapshot.securityDeposit.total), qty: 1 });
  if (snapshot.charges.processingFee > 0)
    items.push({ name: FEE_LINE, currency: cur, amount: round2(snapshot.charges.processingFee), qty: 1 });
  return items;
}

const lineTotal = i => round2(Number(i?.amount || 0) * Number(i?.qty || 1));

// Amounts come from GHL's own draft, not the booking webhook (2026-09-21).
// The webhook's stayTotal sent $500 for a stay GHL billed at $135, and the
// 6% fee and the owner/manager split followed the wrong number. GHL's
// invoice is what the guest actually pays, so:
//   rent            = GHL's stay line (the first line the rental calendar writes)
//   processing fee  = feePct x everything on the invoice (stay, GHL's cleaning,
//                     pet and other fees, plus a legacy Worker deposit) --
//                     the same "whole charge" basis the fee always had
// Everything else about the booking (dates, guest, split %) is unchanged.
export function repriceFromInvoice(snapshot, tenant, nativeItems) {
  if (!nativeItems.length) return;
  const rent = lineTotal(nativeItems[0]);
  if (!(rent > 0)) return;
  const nights = snapshot.stay.nights || 1;
  const nativeSubtotal = round2(nativeItems.reduce((s, i) => s + lineTotal(i), 0));
  const nightlyRate = round2(rent / nights);
  const deposit = calcSecurityDeposit(nights, nightlyRate, depositConfigFor(tenant), 0);
  const feePct = snapshot.charges.feePct ?? tenant.processingFeePct ?? 0.06;
  const processingFee = round2(feePct * (nativeSubtotal + deposit.totalDeposit));

  snapshot.stay.nightlyRate = nightlyRate;
  snapshot.charges.rentTotal = rent;
  snapshot.charges.processingFee = processingFee;
  snapshot.charges.grandTotal = round2(nativeSubtotal + processingFee + deposit.totalDeposit);
  snapshot.charges.amountsSource = "ghl_invoice";
  snapshot.securityDeposit.total = deposit.totalDeposit;
  snapshot.securityDeposit.blocks = deposit.blocks;
  if (snapshot.payout) {
    snapshot.payout.basis = rent;
    snapshot.payout.owner = round2(rent * snapshot.payout.ownerPct);
    snapshot.payout.manager = round2(rent - snapshot.payout.owner);
  }
}

// --- resolve the draft's _id ---------------------------------------------
// Prefer the id handed to you on the booking webhook. Otherwise the booking's
// own invoice: GHL's rental calendar stamps it with source "calendar" and
// sourceId = the booking id (verified live 2026-09-21, invoice 000005 for
// booking Apl1ioBR66hSkugOYM9c). GHL creates that invoice already in status
// "sent", so status can't tell a fresh booking invoice apart -- only paid,
// partly paid and void ones are ruled out.
// altId IS required here despite not appearing in the operation's public
// parameter schema -- confirmed live: omitting it 401s ("A 401 from the
// invoices service almost always means a missing altId, not a missing
// scope" per this project's own registry notes -- schema introspection
// doesn't fully reflect runtime requirements on this API).
export async function resolveDraftInvoiceId(
  { tenant, env, locationId, contactId, bookingId, hintedInvoiceId },
  fetchImpl = fetch
) {
  if (hintedInvoiceId) return hintedInvoiceId;

  // Deliberately NOT filtering by status server-side: "draft" was an
  // assumption from the task description, not a verified value, and a
  // wrong guess here silently returns zero results (confirmed live -- a
  // real draft invoice existed and this returned nothing with status=draft
  // in the query). Fetch everything for the contact and filter client-side
  // instead, where we can see exactly what statuses actually came back.
  const q = new URLSearchParams({
    altId: locationId,
    altType: "location",
    contactId,
    limit: "20",
    offset: "0"
  });
  const list = await ghlFetch(tenant, env, `/invoices/?${q}`, {}, fetchImpl);
  const invoices = list.invoices || [];

  const own = invoices.find(i => i.sourceId === bookingId || i.meta?.serviceBookingId === bookingId);
  if (own && !isSettled(own.status)) return own._id;
  if (own) throw new Error(`Invoice ${own.invoiceNumber || own._id} for booking ${bookingId} is already ${own.status}`);

  const candidates = invoices.filter(i => !isSettled(i.status));
  const newest = candidates.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  if (!newest) {
    const statuses = invoices.map(i => i.status).join(", ") || "none";
    throw new Error(`No unpaid invoice found for contact ${contactId} / booking ${bookingId}. Fetched ${invoices.length} invoice(s), statuses: [${statuses}]`);
  }
  return newest._id;
}

// GHL invoice statuses (its workflow filters list Sent, Viewed, Paid,
// Partially Paid, Void). The API spells them lowercase with underscores.
// Sent and Viewed don't mean we've handled it: the calendar's booking invoice
// starts out "sent". Money received or a void does rule it out.
const SETTLED = new Set(["paid", "partially_paid", "void", "payment_processing"]);
export function normStatus(s) {
  return String(s ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}
export function isSettled(status) {
  return SETTLED.has(normStatus(status));
}

// Has the Worker already written to this invoice? Our processing-fee (and a
// legacy deposit) line is the only reliable mark: status can't say, because
// GHL creates the booking invoice as "sent".
export async function invoiceHasWorkerLines({ tenant, env, locationId, invoiceId }, fetchImpl = fetch) {
  const inv = await ghlFetch(
    tenant, env, `/invoices/${invoiceId}?altId=${encodeURIComponent(locationId)}&altType=location`, {}, fetchImpl
  );
  return (inv.invoiceItems || []).some(i => OUR_LINES.has(i?.name)) || isSettled(inv.status);
}

// --- enrich + send ---------------------------------------------------------
// userId comes from the booking webhook's {{user.id}} (see index.js), not
// tenant config -- required by send-invoice, but it identifies WHO is
// sending, which is a per-request fact, not a per-client one.
// GHL's native Additional Fees can't be conditional, so a Pet Fee lands on
// every booking. The booking form asks (required) whether the guest brings a
// pet; on "No" that line is dropped before the invoice is sent. Payment at
// booking is off, so nothing has been paid on it yet. Matched by name, in
// English or Spanish (policy.js isPetFeeName).
const isCleaningFee = item => /clean|limpieza/i.test(String(item?.name || ""));

export async function enrichAndSendInvoice(
  { tenant, env, locationId, invoiceId, snapshot, contact, userId, hasPets },
  fetchImpl = fetch
) {
  if (!userId) throw new Error("No userId on this request ({{user.id}} merge tag) -- required by send-invoice");

  // update-invoice requires the full body (name/currency/issueDate/dueDate
  // are required alongside invoiceItems) -- fetch the draft first so we can
  // echo its existing fields back untouched and only grow invoiceItems.
  const existing = await ghlFetch(
    tenant, env, `/invoices/${invoiceId}?altId=${encodeURIComponent(locationId)}&altType=location`, {}, fetchImpl
  );

  const noPets = yesNo(hasPets) === false;
  // A run that died after its PUT left our lines on the draft already; drop
  // them so finishing it doesn't add them twice.
  const ghlItems = (existing.invoiceItems || []).filter(i => !OUR_LINES.has(i?.name));
  const nativeItems = ghlItems.filter(i => !(noPets && isPetFeeName(i?.name, tenant)));
  const removedItems = ghlItems.length - nativeItems.length;
  repriceFromInvoice(snapshot, tenant, nativeItems);
  const appendItems = buildAppendItems(snapshot, tenant);
  const invoiceItems = [...nativeItems, ...appendItems];

  // Record (not charge) GHL's own cleaning line so the owner/manager split
  // still sees it.
  const nativeCleaning = round2(nativeItems.filter(isCleaningFee)
    .reduce((s, i) => s + Number(i.amount || 0) * Number(i.qty || 1), 0));
  if (nativeCleaning > 0) {
    snapshot.charges.cleaningFee = nativeCleaning;
    snapshot.charges.cleaningFeeSource = "ghl_native";
  }

  // GHL's own sequential number, untouched (guest-facing on the invoice page,
  // PDF and email). Only a draft with no number at all gets the booking id.
  const invoiceNumber = existing.invoiceNumber || snapshot.bookingId;

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
        invoiceNumber,
        contactDetails: { ...contact, phoneNo: toE164(contact.phoneNo) },
        invoiceItems,
        // get-invoice returns full ISO datetimes ("2026-08-26T04:00:00.000Z");
        // update-invoice's validator wants date-only ("YYYY-MM-DD") and 422s
        // on the datetime form -- confirmed live, not documented anywhere.
        issueDate: dateOnly(existing.issueDate) || dateOnly(new Date().toISOString()),
        dueDate: dateOnly(existing.dueDate) || dateOnly(new Date().toISOString()),
        // Not actually optional despite the schema marking it required:false --
        // omitting it 422s with "discount should not be empty". Echo the
        // existing draft's discount if it has one, else GHL's own example
        // shape (zero, no discount applied).
        discount: existing.discount || { value: 0, type: "percentage" },
        businessDetails: existing.businessDetails
      }
    },
    fetchImpl
  );

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

  return { invoiceId, items: invoiceItems, appendedItems: appendItems, removedItems, sent };
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// GHL's ISO datetime ("2026-08-26T04:00:00.000Z") -> plain "2026-08-26".
// update-invoice's validator rejects the full datetime form -- confirmed
// live -- even though get-invoice is what hands you that exact string.
function dateOnly(s) {
  if (!s) return s;
  const m = String(s).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : s;
}

// Best-effort E.164 normalization. DR/US numbers are both NANP (+1), which
// covers this tenant's guests; a number that's already E.164 passes through
// unchanged. Never invents a country code for a number that isn't 10 digits.
function toE164(phone) {
  if (!phone) return phone;
  const digits = String(phone).replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}
