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

// GHL's own payment (native Payments -> Transactions) for an invoice, so our
// Revenue rows can point at it. Best effort: null when none is found.
export async function findInvoiceTransactionId({ tenant, env, locationId, invoiceId }, fetchImpl = fetch) {
  const q = new URLSearchParams({ altId: locationId, altType: "location", entityId: invoiceId, limit: "10" });
  const res = await ghlFetch(tenant, env, `/payments/transactions?${q}`, {}, fetchImpl);
  const txs = (res.data || []).filter(t => t.entityId === invoiceId || !t.entityId);
  const ok = txs.find(t => normStatus(t.status) === "succeeded") || txs[0];
  return ok?._id || null;
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

  // Everything the guest was charged for that is not the stay itself, not its
  // cleaning, and not a pass-through: a pet fee, a late check-out, an early
  // check-in, an extra guest, whatever the account sells next. All of it is
  // part of the rent price (Yari, 2026-09-29, about the pet fee; the same is
  // true of the rest), so it is split at ownerPct like the rent.
  //
  // Recognised by NOT being a pass-through rather than by name, which is what
  // makes a charge added in GHL tomorrow reach somebody without a deploy. The
  // pet fee needed six edits across five files before anyone was paid for it,
  // and the next fee would have needed the same six.
  //
  // Cleaning is excluded because it is already earned, by whoever
  // cleaningFeeTo names -- usually the manager, since it pays the cleaner.
  // Adding it here would pay it to the owner as well.
  //
  // Kept OUT of charges.rentTotal on purpose. That field divides by nights to
  // give nightlyRate, which sizes the deposit and drives the nights-based
  // cancellation tiers, and none of these buy a night. They are separate
  // amounts that happen to be split on the same terms.
  const addOnItems = nativeItems
    .slice(1)
    .filter((i) => !isCleaningFee(i) && !isPassThrough(i, tenant));
  const addOns = round2(addOnItems.reduce((s, i) => s + lineTotal(i), 0));
  const basis = round2(rent + addOns);

  snapshot.stay.nightlyRate = nightlyRate;
  snapshot.charges.rentTotal = rent;
  if (addOns > 0) {
    snapshot.charges.addOns = addOns;
    // Named individually so a statement can say "Pet Fee 300, Late Checkout
    // 50" rather than "Add-ons 350", and so a client can see what the split
    // was taken on without opening the invoice.
    snapshot.charges.addOnDetail = addOnItems.map((i) => ({ name: String(i.name || "").trim(), amount: lineTotal(i) }));
  }
  snapshot.charges.processingFee = processingFee;
  snapshot.charges.grandTotal = round2(nativeSubtotal + processingFee + deposit.totalDeposit);
  snapshot.charges.amountsSource = "ghl_invoice";
  snapshot.securityDeposit.total = deposit.totalDeposit;
  snapshot.securityDeposit.blocks = deposit.blocks;
  if (snapshot.payout) {
    snapshot.payout.basis = basis;
    snapshot.payout.owner = round2(basis * snapshot.payout.ownerPct);
    snapshot.payout.manager = round2(basis - snapshot.payout.owner);
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
// userId is required by send-invoice. It was taken only from the booking
// webhook's {{user.id}}, on the reasoning that who sends an invoice is a
// per-request fact rather than a per-client one.
//
// That reasoning was wrong in practice, and it cost three bookings on
// 2026-09-26: a Rental Booking trigger has no user in context, so {{user.id}}
// resolves to nothing, every time. enrichAndSendInvoice threw on its first
// line and the invoice went out as GHL built it -- no processing fee, no
// deposit, and no Pet Fee removal for a guest who said they had no pet. The
// Worker reported it correctly (mode: enrich_failed, with the merge tag named)
// and the report sat unread in an execution log nobody could open.
//
// So the webhook value still wins when it resolves, and tenant.invoiceSenderUserId
// is the fallback. One unresolved merge tag must not be able to silently
// un-price every booking a client takes.
// GHL's native Additional Fees can't be conditional, so a Pet Fee lands on
// every booking. The booking form asks (required) whether the guest brings a
// pet; on "No" that line is dropped before the invoice is sent. Payment at
// booking is off, so nothing has been paid on it yet. Matched by name, in
// English or Spanish (policy.js isPetFeeName).
// An optional add-on the guest was asked about and said no to.
//
// GHL charges a listing's add-ons on every booking -- there is no way to mark
// one optional in the booking widget (Yari, 2026-09-29). So the account
// configures the add-on on the listing, the form asks whether the guest wants
// it, and the line comes back off here when the answer is no. That is the
// pet-fee mechanism, which has worked since the beginning; this is the same
// thing for everything else the account sells.
//
// tenant.optionalAddOns is [{ field, name }] -- the booking-form field that
// carries the answer, and the fee's name as GHL writes it. The pet fee stays
// hard-wired alongside it: every account already has it, none has this config
// yet, and there is nothing to gain from making them re-enter it.
//
// ONLY an explicit no removes a line. An answer that is missing or
// unrecognisable leaves the charge in place, the same way the pet fee always
// has -- overcharging is visible to the guest and recoverable, while dropping
// a charge nobody notices is neither. Unanswered add-ons are recorded on the
// snapshot so the silence is at least legible.
export function optionalAddOnsToRemove(tenant, answers) {
  const configured = Array.isArray(tenant?.optionalAddOns) ? tenant.optionalAddOns : [];
  const declined = [];
  const unanswered = [];
  for (const addOn of configured) {
    if (!addOn?.field || !addOn?.name) continue;
    const said = yesNo(answers?.[addOn.field]);
    if (said === false) declined.push(addOn.name);
    else if (said === null) unanswered.push(addOn.name);
  }
  return { declined, unanswered };
}

// "Pet Fee" matches both "Pet Fee" and "Pet Fee - Test Villa 2".
//
// Matched on the separator rather than as a prefix, so an add-on called
// "Late Checkout" cannot claim a different one called "Late Checkout Premium".
// This is the same suffix rule multi-listing.js reads for attribution, applied
// from the other end.
export function matchesAddOnName(lineName, addOnName) {
  const line = normName(lineName);
  const name = normName(addOnName);
  if (!line || !name) return false;
  return line === name || line.startsWith(`${name} - `);
}

const normName = (s) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .toLowerCase().replace(/\s+/g, " ").trim();

export const isCleaningFee = item => /clean|limpieza/i.test(String(item?.name || ""));
// The property name, taken from what the guest is actually being charged for.
//
// The booking webhook cannot supply it: the inbound payload carries the guest's
// name in that field and there is no merge tag that fixes it. But the invoice
// GHL built already names the listing as a line item, beside the fees:
//
//   Test Villa 2   270.00   <- the listing
//   Cleaning Fee    65.00
//   Pet Fee        300.00
//
// So the property is the line that is not a fee. This is not a guess about what
// property names look like -- it is the one item on the invoice that is not
// something the system itself added or recognises as a charge.
//
// It refuses to choose when there is more than one candidate. A booking with an
// add-on (Fridge Stock, Airport Shuttle) has two non-fee lines, and picking the
// first would attribute revenue to whichever GHL happened to list first. A
// wrong property is worse than none: it keys per-property owner names, so it
// would address an owner statement to someone with no claim on the money.
const FEE_LINE_PATTERNS = [
  /clean|limpieza/i,
  /\bpet\b|mascota/i,
  /deposit|dep(ó|o)sito|garant(í|i)a/i,
  /process|procesamiento|service fee|tarifa/i,
  /\btax|impuesto|itbis/i,
];

// What the client does NOT earn. Three things, and it is a closed list:
//
//   tax             remitted to the government
//   deposit         the guest's own money, held and given back
//   processing fee  the gateway's cut, and our own appended line
//
// Everything else the guest is charged, the client earned. That is the way
// round this has to be, because the list of things a client can sell is open
// and grows every time they add one -- a late check-out, an early check-in, an
// extra guest, an airport transfer, firewood -- while the list of things that
// merely pass through is short and does not move.
//
// Enumerating the earnings instead is what cost us: the pet fee reached nobody
// for as long as it existed, and every new charge needed the same six edits
// before anyone was paid for it. The failure mode of getting THIS list wrong is
// visible -- a client sees a line on a statement they did not expect. The
// failure mode of the other way round is money silently reaching no one, which
// is what we kept finding.
export function isPassThrough(item, tenant) {
  const name = String(item?.name ?? "").trim();
  if (!name) return true;
  // Cleaning is earned -- by whoever cleaningFeeTo names -- and an account is
  // free to word it "Cleaning Service Fee", which the processing pattern below
  // would otherwise claim. There is deliberately no equivalent check for the
  // pet fee: once the processing pattern stopped matching every "tarifa", no
  // pet-fee wording collided with anything here, and a name-based pet rule is
  // the exact thing this change exists to retire.
  if (isCleaningFee(item)) return false;
  return PASS_THROUGH_PATTERNS.some((re) => re.test(name));
}

const PASS_THROUGH_PATTERNS = [
  /\btax|impuesto|itbis|\bitbi\b/i,
  /deposit|dep(ó|o)sito|garant(í|i)a/i,
  // "tarifa de servicio" is deliberately NOT here. The real line reads "Cargo
  // por procesamiento / Processing fee" and is caught by "procesamiento", and
  // the broader wording swallowed anything an account chose to call a service
  // charge -- a pet fee worded "Tarifa de servicio para mascotas" would have
  // been paid to nobody, which is the failure this whole inversion exists to
  // stop. A charge has to look like the gateway's cut, not merely like a fee.
  /process|procesamiento|service fee/i,
];

export function isFeeLine(item, tenant) {
  const name = String(item?.name ?? "").trim();
  if (!name) return true;
  if (isPetFeeName(name, tenant)) return true;
  return FEE_LINE_PATTERNS.some((re) => re.test(name));
}

// What GHL says this booking is for, when the invoice cannot say.
//
// One listing means one booked service, and the catalog holds its name. More
// than one means a bundled reservation, which multi-listing.js splits and which
// therefore has no single property to name -- so this returns null rather than
// picking one, the same refusal propertyNameFromInvoice makes for the same
// reason: a wrong property keys a per-property owner name, and addresses a
// statement to somebody with no claim on the money.
export async function propertyFromBooking({ tenant, env, bookingId }, fetchImpl = fetch) {
  if (!bookingId) return null;
  // Read through ghlFetch rather than importing multi-listing.js's copy:
  // multi-listing.js already imports from here, and a cycle between the two is
  // not a thing to introduce for two calls it can make itself.
  let services;
  try {
    const booking = await ghlFetch(tenant, env, `/calendars/services/bookings/${encodeURIComponent(bookingId)}`, {}, fetchImpl);
    services = booking?.services || [];
  } catch {
    return null;
  }
  // More than one booked service is a bundled reservation, which has no single
  // property to name. Returning null is the same refusal propertyNameFromInvoice
  // makes when it cannot choose, and for the same reason.
  if (services.length !== 1) return null;

  try {
    const entry = await ghlFetch(tenant, env, `/calendars/services/catalog/${encodeURIComponent(services[0].id)}`, {}, fetchImpl);
    const name = String(entry?.service?.name ?? "").trim();
    return name || null;
  } catch {
    return null;
  }
}

export function propertyNameFromInvoice(items, tenant) {
  const candidates = (items || []).filter((i) => !isFeeLine(i, tenant));
  if (candidates.length === 1) {
    return { name: String(candidates[0].name).trim(), reason: null };
  }
  return {
    name: null,
    reason: candidates.length === 0
      ? "no_non_fee_line_on_invoice"
      : `ambiguous_${candidates.length}_non_fee_lines`,
  };
}

// Reprice the guest's existing invoice after a stay changed length.
//
// A booking settled by GHL invoice has no capture to charge against, so the
// old code fell through to createOrder and raised a PayPal order for the
// difference -- on DEMO-HOMS, against a sandbox account, for a guest who had
// paid by invoice and would never see it. Found 2026-09-28 on booking
// SiKoozWmXBEFIaiIqOkO: the Transaction record repriced correctly, the invoice
// still read paid, and the extra two nights were collectible nowhere.
//
// PUTting new items onto a paid invoice is the supported move: GHL recomputes
// the total, works out amountDue itself, and flips status to partially_paid.
// The guest pays from the link they already have.
//
// Deliberately does NOT re-send the invoice. That would email every guest on
// every date change, and whether they hear about it is a decision for a
// workflow that can see the reason, not a side effect of repricing.
// Close an invoice so nobody can pay it.
//
// A booking cancelled for non-payment leaves its invoice live, and the link is
// already in the guest's inbox. DEMO-HOMS 2026-09-29: booking cancelled 14:17,
// $975.20 paid 14:49 against a stay that was no longer happening. The Worker
// caught it and refused to book the revenue, but by then the money had moved.
//
// Voiding closes the door rather than catching what comes through it.
//
// Refuses to void anything already paid, and says so rather than throwing: a
// cancellation that reached this point has already decided the booking is over,
// and an invoice this could not close is worth reporting, not worth failing the
// cancellation over. The caller records the outcome either way.
export async function voidInvoice({ tenant, env, locationId, invoiceId }, fetchImpl = fetch) {
  if (!invoiceId) return { ok: false, reason: "no_invoice_on_booking" };

  let existing;
  try {
    existing = await ghlFetch(
      tenant, env, `/invoices/${invoiceId}?altId=${encodeURIComponent(locationId)}&altType=location`, {}, fetchImpl
    );
  } catch (err) {
    return { ok: false, reason: "invoice_unreadable", detail: err.message };
  }

  const status = normStatus(existing.status);
  if (status === "void") return { ok: true, alreadyVoid: true, invoiceId, status };

  // Never void money that has already arrived. A paid or part-paid invoice is a
  // record of a real payment, and voiding it would hide a refund that is owed.
  if (isSettled(status) || Number(existing.amountPaid ?? 0) > 0) {
    return {
      ok: false,
      reason: "invoice_already_paid",
      detail: `Invoice ${existing.invoiceNumber || invoiceId} is ${status} with ${existing.amountPaid ?? 0} paid; voiding it would hide money that actually arrived.`,
      invoiceId, status, amountPaid: existing.amountPaid ?? 0,
    };
  }

  try {
    const res = await ghlFetch(
      tenant, env, `/invoices/${invoiceId}/void`,
      { method: "POST", body: { altId: locationId, altType: "location" } },
      fetchImpl
    );
    return {
      ok: true,
      invoiceId,
      invoiceNumber: existing.invoiceNumber || null,
      status: normStatus(res?.status) || "void",
    };
  } catch (err) {
    return { ok: false, reason: "void_rejected", detail: err.message, invoiceId };
  }
}

export async function updateInvoiceForReschedule(
  { tenant, env, locationId, invoiceId, snapshot, previousNights },
  fetchImpl = fetch
) {
  const existing = await ghlFetch(
    tenant, env, `/invoices/${invoiceId}?altId=${encodeURIComponent(locationId)}&altType=location`, {}, fetchImpl
  );

  // Our own lines are rebuilt from the new totals rather than edited, the same
  // way enrichAndSendInvoice treats them.
  const nativeItems = (existing.invoiceItems || []).filter((i) => !OUR_LINES.has(i?.name));
  if (!nativeItems.length) {
    return { ok: false, reason: "no_native_items", detail: `Invoice ${invoiceId} has no stay line to reprice.` };
  }

  // The first native line is the stay, by the same convention repriceFromInvoice
  // reads it back with. Keep the shape the guest is already looking at: a line
  // billed per night stays per night with a new quantity, and a line billed as
  // one lump stays one lump with a new amount. Rewriting a "9 x 135" line into
  // a single "1215" is a worse invoice even though the total matches.
  const [stayLine, ...otherNative] = nativeItems;
  const billedPerNight = previousNights > 1 && Number(stayLine.qty) === previousNights;
  const newStayLine = billedPerNight
    ? { ...stayLine, qty: snapshot.stay.nights }
    : { ...stayLine, amount: round2(snapshot.charges.rentTotal), qty: 1 };

  // The processing fee is recomputed from the invoice's own new subtotal rather
  // than read off the snapshot.
  //
  // The gateway path charges a fee on the DELTA and leaves
  // snapshot.charges.processingFee at whatever the guest already paid, which is
  // right when the difference is a separate order. An invoice is not a
  // difference -- it is the whole bill, and a fee line still reading the
  // original stay's amount understates what the guest owes. Same basis
  // repriceFromInvoice used when the invoice was first built: the fee applies to
  // everything on it, plus any deposit.
  const cur = tenant.currency || "USD";
  const nativeSubtotal = round2([newStayLine, ...otherNative]
    .reduce((s, i) => s + Number(i.amount || 0) * Number(i.qty || 1), 0));
  const deposit = round2(snapshot.securityDeposit?.total || 0);
  const feePct = snapshot.charges.feePct ?? tenant.processingFeePct ?? 0.06;
  const processingFee = round2(feePct * (nativeSubtotal + deposit));

  const ourLines = [];
  if (deposit > 0) ourLines.push({ name: DEPOSIT_LINE, currency: cur, amount: deposit, qty: 1 });
  if (processingFee > 0) ourLines.push({ name: FEE_LINE, currency: cur, amount: processingFee, qty: 1 });

  const invoiceItems = [newStayLine, ...otherNative, ...ourLines];

  const updated = await ghlFetch(
    tenant, env, `/invoices/${invoiceId}`,
    {
      method: "PUT",
      body: {
        altId: locationId,
        altType: "location",
        name: existing.name || `Reserva ${snapshot.bookingId}`,
        title: existing.title,
        currency: existing.currency || tenant.currency || "USD",
        invoiceNumber: existing.invoiceNumber || snapshot.bookingId,
        contactDetails: existing.contactDetails,
        invoiceItems,
        issueDate: dateOnly(existing.issueDate) || dateOnly(new Date().toISOString()),
        dueDate: dateOnly(existing.dueDate) || dateOnly(new Date().toISOString()),
        // Both of these 422 if omitted, and neither is marked required. Same
        // two traps enrichAndSendInvoice already pays for; kept in step here.
        discount: existing.discount || { value: 0, type: "percentage" },
        businessDetails: existing.businessDetails
      }
    },
    fetchImpl
  );

  // GHL computes amountDue, so report what it decided rather than what we
  // expected it to decide -- those disagreeing is worth seeing, not hiding.
  const after = updated?.invoice || updated || {};
  return {
    ok: true,
    invoiceId,
    invoiceNumber: existing.invoiceNumber || null,
    status: after.status ?? null,
    processingFee,
    nativeSubtotal,
    amountDue: after.amountDue ?? null,
    total: after.total ?? null,
  };
}

export async function enrichAndSendInvoice(
  { tenant, env, locationId, invoiceId, snapshot, contact, userId, hasPets, addOnAnswers },
  fetchImpl = fetch
) {
  const senderUserId = userId || tenant?.invoiceSenderUserId || null;
  if (!senderUserId) {
    throw new Error(
      "No userId available -- send-invoice requires one. The webhook's {{user.id}} merge tag " +
      "did not resolve (a Rental Booking trigger has no user in context), and this tenant has no " +
      "invoiceSenderUserId set in KV as a fallback. Set one, or the invoice cannot be sent."
    );
  }

  // update-invoice requires the full body (name/currency/issueDate/dueDate
  // are required alongside invoiceItems) -- fetch the draft first so we can
  // echo its existing fields back untouched and only grow invoiceItems.
  const existing = await ghlFetch(
    tenant, env, `/invoices/${invoiceId}?altId=${encodeURIComponent(locationId)}&altType=location`, {}, fetchImpl
  );

  const noPets = yesNo(hasPets) === false;
  const { declined, unanswered } = optionalAddOnsToRemove(tenant, addOnAnswers);
  // A run that died after its PUT left our lines on the draft already; drop
  // them so finishing it doesn't add them twice.
  const ghlItems = (existing.invoiceItems || []).filter(i => !OUR_LINES.has(i?.name));
  const nativeItems = ghlItems.filter((i) =>
    !(noPets && isPetFeeName(i?.name, tenant)) &&
    !declined.some((name) => matchesAddOnName(i?.name, name))
  );
  const removedItems = ghlItems.length - nativeItems.length;
  // Legible rather than silent: an add-on the account charges, configured as
  // optional, and never answered is a form that has drifted from the listing.
  if (unanswered.length) {
    snapshot.unansweredAddOns = unanswered;
    console.error(
      `Booking ${snapshot.bookingId}: optional add-ons with no answer on the form, charged as configured: ` +
      unanswered.join(", ")
    );
  }
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

  // Fill in the property from the invoice when the booking webhook could not
  // supply it -- either it sent nothing, or it sent the guest name and the
  // guard in index.js rejected it. Never overrides a value that arrived intact.
  if (!snapshot.propertyCode) {
    const { name, reason } = propertyNameFromInvoice(nativeItems, tenant);
    if (name) {
      snapshot.propertyCode = name;
      snapshot.propertyCodeSource = "ghl_invoice";
    } else {
      // The invoice could not say which line was the property, so ask GHL what
      // it actually booked.
      //
      // Reading it off the invoice works by elimination -- the line that is not
      // a fee -- and that stops working the moment an account sells something
      // the fee patterns have never heard of. DEMO-HOMS added Early Check-in
      // and Late Check-out, and booking mRHVdjX72Ip49jQckB6W came out with
      // THREE candidate property lines and no property at all
      // (unresolved:ambiguous_3_non_fee_lines, 2026-09-29). Its owner then fell
      // back to the account default rather than the one keyed to Test Villa 3
      // -- invisible on an account with one owner, the wrong person credited on
      // an account with several.
      //
      // The catalog answers it outright: the booked service's own name, which
      // is the listing. Same call multi-listing.js uses to identify a bundled
      // reservation's listings, and the reason bundled bookings never had this
      // problem.
      //
      // Only reached when the invoice was ambiguous, so an ordinary booking
      // pays for no extra calls. Fails soft: unreadable leaves the snapshot
      // exactly as it was, recording why, which is today's behaviour.
      const booked = await propertyFromBooking({ tenant, env, bookingId: snapshot.bookingId }, fetchImpl);
      if (booked) {
        snapshot.propertyCode = booked;
        snapshot.propertyCodeSource = "ghl_service_catalog";
      } else {
        snapshot.propertyCodeSource = `unresolved:${reason}`;
      }
    }
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
        userId: senderUserId,
        action: tenant.ghlInvoiceSendAction || "sms_and_email",
        liveMode: tenant.ghlInvoiceLiveMode ?? true
      }
    },
    fetchImpl
  );

  // nativeItems comes back so the caller can see what GHL itself billed,
  // separately from what we appended. A bundled reservation is recognised by
  // having more than one non-fee line among these, and re-fetching the invoice
  // to find that out would be a second call for something already in hand.
  return { invoiceId, items: invoiceItems, appendedItems: appendItems, nativeItems, removedItems, sent };
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
