// multi-listing.js -- one reservation, several listings.
//
// GHL shipped bundled Rentals bookings as a per-account toggle: one booking id,
// one guest, one payment, two or more listings with their own date ranges. Seen
// live on DEMO-HOMS 2026-09-28 -- booking JI1yIAnf498IgFIV7J9M, Test Villa 2 for
// Sep 30 to Oct 3 and Test Villa 3 for Oct 3 to Oct 9, $1,430 together. There is
// real demand for it, families moving between properties being the obvious case.
//
// The Worker had no snapshot for that booking at all, and could not have priced
// it if it did: a snapshot holds ONE stay, ONE propertyCode, ONE payout with one
// owner and one split. Two listings means two date ranges, potentially two
// owners on two different splits, and one payment to divide between them.
//
// So a bundled booking becomes one snapshot PER LISTING, under a parent record.
// Each child is shaped exactly like an ordinary single-listing booking, which is
// the whole point: every per-property thing already built -- owner attribution,
// the Transaction-to-Property link, statement rows, cancellation tiers computed
// from a check-in date -- keeps working untouched. Teaching one snapshot to hold
// two properties would have meant reopening all of it.
//
// It also gets the awkward case right for free. A cancellation that lands after
// the guest checked into the first listing but before the second one starts
// prices each child against its own check-in date, so one hits the checked-in
// tier and the other does not. That is correct, and no branch had to know.
//
// Cleaning fee and deposit are per listing (Yari, 2026-09-28). The processing
// fee needs no apportioning: it is a flat percentage, so charging each child on
// its own rent and deposit sums to exactly the fee on the whole booking.

import { composeBooking } from "./booking-composer.js";
import { isFeeLine, isCleaningFee, isPassThrough } from "./ghl-invoice.js";

export const MULTI_PARENT_TYPE = "multi_listing_parent";

// Split a booking that has already been composed and invoiced.
//
// Runs AFTER enrichAndSendInvoice rather than before, which is what makes the
// restructure small. By then GHL's own lines are in hand, the processing fee
// and deposit have been computed across the whole reservation (correct either
// way, since the fee is a flat percentage of everything on the invoice), and
// the invoice has gone to the guest. What is wrong at that point is only the
// booking's own shape: one stay, one property, one split, describing a
// reservation that has several of each.
//
// Returns { split: false, reason } when it is an ordinary booking or when the
// two sources disagree -- the caller then leaves the snapshot exactly as it is,
// which is today's behaviour, rather than half-applying something.
export async function splitBookedReservation({ tenant, env, snapshot, nativeItems }, fetchImpl = fetch) {
  const priced = (nativeItems || []).filter((i) => !isFeeLine(i, tenant));
  if (priced.length < 2) return { split: false, reason: "single_listing" };

  const fetched = await fetchBookingServices({ tenant, env, bookingId: snapshot.bookingId }, fetchImpl);
  if (!fetched.ok) return { split: false, reason: fetched.reason, detail: fetched.detail };

  const paired = pairListings(nativeItems, fetched.services, tenant);
  if (!paired.ok) return { split: false, reason: paired.reason, ...paired };

  const cleaning = pairCleaning(nativeItems, paired.listings);
  const addOns = pairAddOns(nativeItems, paired.listingLines, paired.listings, tenant);

  const { parent, children } = composeMultiListing(
    {
      bookingId: snapshot.bookingId,
      locationId: snapshot.locationId,
      ghlContactId: snapshot.ghlContactId,
      firstName: snapshot.guest?.name, email: snapshot.guest?.email, phone: snapshot.guest?.phone,
      bookingSource: snapshot.bookingSource,
    },
    tenant,
    paired.listings
  );

  applyFees(children, cleaning, addOns, tenant);

  // The reservation-level facts stay on the parent: the guest pays one invoice
  // and one payment arrives against it, so that is where they belong. The
  // children are stays, not sales.
  parent.ghlInvoice = snapshot.ghlInvoice ?? null;
  parent.gateway = snapshot.gateway ?? null;
  parent.guest = snapshot.guest ?? parent.guest;
  parent.charges.grandTotal = snapshot.charges?.grandTotal ?? null;
  // Re-summed after the cleaning fees landed on the children. Taking the fee
  // from the reservation-level snapshot instead would leave the parent and its
  // children disagreeing by exactly the fee on the cleaning -- 7.80 on the
  // DEMO-HOMS booking that found this -- and settlement divides the payment by
  // the children.
  parent.charges.cleaningFee = sum(children.map((c) => c.charges.cleaningFee));
  parent.charges.addOns = sum(children.map((c) => c.charges.addOns ?? 0));
  // Summed from the children rather than copied from the reservation-level
  // snapshot. The two agree on every booking seen so far, because
  // repriceFromInvoice charges the fee on the whole invoice subtotal and that
  // is the same base once cleaning has reached the children -- no test can
  // currently tell them apart. The children are still the right source:
  // settlement divides the payment by them, so a parent that disagreed with
  // its children would be describing a reservation nobody was paid for.
  parent.charges.processingFee = sum(children.map((c) => c.charges.processingFee));
  if (!cleaning.ok) parent.cleaningPairing = cleaning;
  if (!addOns.ok) parent.addOnPairing = addOns;

  return { split: true, parent, children };
}

// A parent holds no stay of its own, so anything that reads snapshot.stay must
// not be handed one by accident.
export function isMultiListingParent(snapshot) {
  return snapshot?.type === MULTI_PARENT_TYPE;
}

export const childBookingId = (bookingId, index) => `${bookingId}#${index + 1}`;

const blank = (v) => v === undefined || v === null || String(v).trim() === "";

// Fetch the per-listing date ranges GHL holds for a booking.
//
// GET /calendars/services/bookings/{id} returns one `services` entry per
// listing, each with serviceStartTime and serviceEndTime. Documented endpoint,
// and the tenant PIT already carries the scope -- verified live 2026-09-29
// against DEMO-HOMS before any of this was written.
//
// Cancelling or deleting a booking wipes those fields to empty strings (Mara,
// same day), so a bundled booking cannot be reconstructed from GHL after the
// fact. That is why the split happens at booking time and is stored, and why
// an empty string has to be rejected rather than parsed.
export async function fetchBookingServices({ tenant, env, bookingId }, fetchImpl = fetch) {
  const pit = tenant.ghlPitSecretName && env?.[tenant.ghlPitSecretName]
    ? env[tenant.ghlPitSecretName]
    : tenant.ghlPit;
  if (!pit) return { ok: false, reason: "no_pit" };

  try {
    const res = await fetchImpl(`${GHL_BASE}/calendars/services/bookings/${encodeURIComponent(bookingId)}`, {
      headers: { Authorization: `Bearer ${pit}`, Version: GHL_VERSION, Accept: "application/json" },
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, reason: "booking_unreadable", status: res.status, detail: text.slice(0, 200) };
    const body = text ? JSON.parse(text) : {};
    const services = body.services || [];
    // Ask the catalog what each booked service actually is. It answers with
    // the listing's name and its nightly rate -- "Test Villa 2", 135 --
    // verified live 2026-09-29 against both legs of 3at3yw3tMEYQ1MWGfHFM.
    //
    // This is what lets a listing line be recognised for being a listing,
    // rather than for not looking like a fee. Under the old rule a charge the
    // code had never heard of -- a late check-out -- counted as a listing, and
    // a two-property booking with one would come out as three listings against
    // two date ranges and refuse to split at all.
    //
    // Fails soft: a catalog that cannot be read leaves the names off, and
    // pairListings falls back to the order-based join it used before.
    await Promise.all(services.map(async (s) => {
      const entry = await fetchServiceCatalog({ tenant, env, pit, serviceId: s.id }, fetchImpl);
      if (entry.ok) { s.catalogName = entry.name; s.catalogRate = entry.nightlyRate; }
    }));
    return { ok: true, services };
  } catch (err) {
    return { ok: false, reason: "booking_fetch_failed", detail: err.message };
  }
}

// One service in the account's catalog: what it is called and what a night of
// it costs. GET /calendars/services/catalog/{serviceId}, documented, and the
// tenant PIT already carries calendars.readonly.
async function fetchServiceCatalog({ tenant, env, pit, serviceId }, fetchImpl = fetch) {
  if (!pit || blank(serviceId)) return { ok: false };
  try {
    const res = await fetchImpl(`${GHL_BASE}/calendars/services/catalog/${encodeURIComponent(serviceId)}`, {
      headers: { Authorization: `Bearer ${pit}`, Version: GHL_VERSION, Accept: "application/json" },
    });
    if (!res.ok) return { ok: false };
    const body = JSON.parse((await res.text()) || "{}");
    const name = String(body?.service?.name ?? "").trim();
    if (!name) return { ok: false };
    return { ok: true, name, nightlyRate: numberOrNull(body?.service?.payment?.amount) };
  } catch {
    return { ok: false };
  }
}

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";

// Pair the booking's listings with the invoice lines that priced them.
//
// Neither source is complete on its own. The services carry dates and no names
// or amounts; the invoice lines carry names and amounts and no dates. Both have
// to be joined, and the join is the part that had to be proven rather than
// assumed -- a wrong pairing does not fail, it prices the wrong property, which
// keys the wrong owner, which pays the wrong person.
//
// Proven on DEMO-HOMS booking JI1yIAnf498IgFIV7J9M: invoice lines Test Villa 2
// at 405 and Test Villa 3 at 660, against stays of 3 and 6 nights. Pairing in
// order gives 135 and 110 a night, and 110 is Test Villa 3's rate confirmed
// across five other bookings the same day. The reverse pairing gives 67.50 and
// 220, which match nothing. So invoice line order is CHRONOLOGICAL order.
//
// Which means the services array's own order is irrelevant: sort its ranges by
// start time and pair against the lines in order. Where two listings share a
// date range, sorting cannot separate them -- and does not need to, because
// their ranges are identical and the name and amount come from the line.
export function pairListings(invoiceItems, services, tenant) {
  // Prefer the names the catalog gave, which turn this from a join on ORDER
  // into a join on identity: the line called "Test Villa 2" is the stay of
  // Test Villa 2, and no argument about invoice ordering is needed. Falls back
  // to the order-based rule when the catalog could not be read, which is the
  // behaviour every bundled booking used before and is still proven below.
  const named = new Set((services || []).map((s) => normalize(s.catalogName)).filter(Boolean));
  const isListingLine = named.size
    ? (i) => named.has(normalize(i?.name)) && !isCleaningFee(i)
    : (i) => !isFeeLine(i, tenant);

  const lines = (invoiceItems || []).filter(isListingLine);
  const ranges = (services || [])
    .map((s) => ({ checkIn: dateOnly(s.serviceStartTime), checkOut: dateOnly(s.serviceEndTime) }))
    .filter((r) => !blank(r.checkIn) && !blank(r.checkOut))
    .sort((a, b) => (a.checkIn < b.checkIn ? -1 : a.checkIn > b.checkIn ? 1 : 0));

  if (lines.length < 2) return { ok: false, reason: `not_bundled_${lines.length}_priced_lines` };
  if (ranges.length !== lines.length) {
    // Refused rather than truncated. Pricing the listings we can see and
    // dropping the rest loses money silently, and guessing which line lost its
    // dates is the coin flip this whole function exists to avoid.
    return { ok: false, reason: "listing_count_mismatch", pricedLines: lines.length, datedListings: ranges.length };
  }

  const listings = lines.map((line, i) => ({
    propertyCode: String(line.name || "").trim(),
    checkIn: ranges[i].checkIn,
    checkOut: ranges[i].checkOut,
    rentTotal: round2(Number(line.amount || 0) * Number(line.qty || 1)),
    nightlyRate: null,
  }));

  if (listings.some((l) => !(l.rentTotal > 0) || !l.propertyCode)) {
    return { ok: false, reason: "unpriced_or_unnamed_line" };
  }
  return { ok: true, listings, listingLines: lines };
}

const round2 = (n) => Math.round(n * 100) / 100;
const normalize = (s) => String(s ?? "").trim().toLowerCase();

// Pair the invoice's cleaning lines with the listings they cleaned.
//
// Cleaning is per listing (Yari, 2026-09-28) and GHL's Additional Fees add one
// line per service, so a two-listing reservation carries two cleaning lines.
// They pair in the same order the rent lines do, which is chronological -- the
// order proven on JI1yIAnf498IgFIV7J9M and confirmed again on the staggered
// 3at3yw3tMEYQ1MWGfHFM.
//
// Nothing was reading them. composeBooking sets cleaningFee to 0 for every
// booking and the enrich step fills it back in from the invoice afterwards, but
// the children are composed AFTER enrich has already run, so no step ever put
// cleaning on them. On 3at3yw3tMEYQ1MWGfHFM that left two 65.00 lines, 130.00
// the guest actually paid, attributed to no listing at all -- and cleaning is
// income, so settlement would have paid the manager 130.00 less than the guest
// was charged.
//
// A count that does not match cannot be attributed, and the choice there is
// between two wrongs. Leaving it at zero loses the money outright, which is the
// bug this exists to fix. Putting the whole total on the first listing keeps the
// reservation's total exactly right and misattributes only WHICH listing earned
// it -- and only on a tenant that names owners or managers per property, since
// cleaningFeeTo is tenant-wide. So: total preserved, attribution flagged.
export function pairCleaning(invoiceItems, listings) {
  return pairAmounts(lineTotals(invoiceItems, isCleaningFee), listings, "cleaning_line_count_mismatch");
}

// Everything the guest was charged that is not the stay, not its cleaning and
// not a pass-through: a pet fee, a late check-out, an early check-in, an extra
// guest, whatever the account sells next. All of it is part of the rent price,
// so it is split at ownerPct like the rent -- see applyFees.
//
// Recognised by NOT being a pass-through, which is what lets a charge added in
// GHL tomorrow reach somebody without a deploy. This was three named buckets a
// day ago -- pet fees split, everything else attributed and paid to nobody --
// and the pet fee alone had taken six edits across five files to start paying.
export function pairAddOns(invoiceItems, listingLines, listings, tenant) {
  const used = new Set(listingLines || []);
  const isAddOn = (i) => !used.has(i) && !isCleaningFee(i) && !isPassThrough(i, tenant);
  return pairAmounts(lineTotals(invoiceItems, isAddOn), listings, "add_on_line_count_mismatch");
}

// The pass-throughs, kept only so the caller can prove the invoice adds up.
export function passThroughTotal(invoiceItems, tenant) {
  return round2(lineTotals(invoiceItems, (i) => isPassThrough(i, tenant)).reduce((s, n) => s + n, 0));
}

const lineTotals = (invoiceItems, match) => (invoiceItems || [])
  .filter(match)
  .map((i) => round2(Number(i.amount || 0) * Number(i.qty || 1)))
  .filter((n) => n > 0);

// One line per listing pairs in order, the way the rent lines do. Any other
// count cannot be attributed, and the choice there is between two wrongs:
// losing the money, or naming the wrong listing as having earned it. The total
// is what the guest paid, so the total wins and the attribution is flagged.
function pairAmounts(amounts, listings, mismatchReason) {
  const total = round2(amounts.reduce((s, n) => s + n, 0));
  if (!(total > 0)) return { ok: true, perListing: listings.map(() => 0), total: 0 };
  if (amounts.length === listings.length) return { ok: true, perListing: amounts, total };

  return {
    ok: false,
    reason: mismatchReason,
    cleaningLines: amounts.length,
    feeLines: amounts.length,
    listingCount: listings.length,
    total,
    perListing: listings.map((_, i) => (i === 0 ? total : 0)),
  };
}

// Put each listing's cleaning on its child, and re-derive what depends on it.
//
// The processing fee has to move with it. It is a flat percentage of everything
// the guest is charged, so a child holding cleaning but a fee computed without
// it under-states the fee -- and the children would then sum to less than the
// invoice the guest paid. With cleaning included they sum to it exactly: on
// 3at3yw3tMEYQ1MWGfHFM, 6% of (945 + 65) plus 6% of (880 + 65) is 117.30, which
// is the fee on the invoice to the cent.
//
// The deposit deliberately does NOT move with it. calcSecurityDeposit is called
// with a cleaning fee of 0 everywhere else too (booking-composer, and
// repriceFromInvoice on the single-listing path), because a deposit is sized
// against the stay rather than against the fees on it.
function applyFees(children, cleaning, addOns, tenant) {
  children.forEach((child, index) => {
    const cleaningAmt = cleaning.perListing?.[index] ?? 0;
    const addOnAmt = addOns.perListing?.[index] ?? 0;
    if (!(cleaningAmt > 0) && !(addOnAmt > 0)) return;

    if (cleaningAmt > 0) {
      child.charges.cleaningFee = cleaningAmt;
      child.charges.cleaningFeeSource = cleaning.ok ? "ghl_native" : "ghl_native_unattributed";
    }
    if (addOnAmt > 0) {
      child.charges.addOns = addOnAmt;
      child.charges.addOnsSource = addOns.ok ? "ghl_native" : "ghl_native_unattributed";
      // Part of the rent price, so it joins the basis the split is taken on --
      // the same thing repriceFromInvoice does for a single-listing booking.
      // composeBooking sized this listing's payout on rent alone, because the
      // invoice lines had not been paired yet when it ran.
      child.payout.basis = round2(child.charges.rentTotal + addOnAmt);
      child.payout.owner = round2(child.payout.basis * child.payout.ownerPct);
      child.payout.manager = round2(child.payout.basis - child.payout.owner);
    }

    const deposit = child.securityDeposit?.total ?? 0;
    const feePct = child.charges.feePct ?? tenant.processingFeePct ?? 0.06;
    const charged = round2(child.charges.rentTotal + cleaningAmt + addOnAmt);
    child.charges.processingFee = round2(feePct * (charged + deposit));
    child.charges.grandTotal = round2(charged + child.charges.processingFee + deposit);
  });
}

// Pull the listings out of whatever GHL actually sends.
//
// Deliberately conservative: it returns null unless it can see MORE THAN ONE
// listing, each with the dates a stay needs. A single listing stays on the
// existing path, byte for byte, and a shape this does not recognise is treated
// as single rather than guessed at -- a booking priced as one listing is wrong
// in a way somebody notices, while a booking split on a guess is wrong in a way
// that quietly pays the wrong owner.
//
// The field names are not yet confirmed against a real bundled payload; the
// candidates below are the ones GHL uses elsewhere for the same idea. When the
// real one arrives, this is the only function that should need changing.
export function listingsFrom(payload) {
  const raw = payload?.listings ?? payload?.services ?? payload?.bookings ?? payload?.items;
  if (!Array.isArray(raw) || raw.length < 2) return null;

  const listings = raw.map((l) => ({
    propertyCode: l.propertyCode ?? l.propertyName ?? l.name ?? l.listingName ?? null,
    checkIn: dateOnly(l.checkIn ?? l.startDate ?? l.start_time ?? l.startTime),
    checkOut: dateOnly(l.checkOut ?? l.endDate ?? l.end_time ?? l.endTime),
    nightlyRate: numberOrNull(l.nightlyRate ?? l.unitPrice ?? l.price),
    rentTotal: numberOrNull(l.rentTotal ?? l.amount ?? l.total),
  }));

  // Every listing needs its own dates. One without them cannot be priced, and
  // pricing the rest while dropping it would lose money silently.
  if (listings.some((l) => blank(l.checkIn) || blank(l.checkOut))) return null;
  return listings;
}

function dateOnly(v) {
  if (blank(v)) return null;
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

function numberOrNull(v) {
  if (blank(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Build the parent and one child snapshot per listing.
//
// Each child goes through composeBooking with a payload describing just that
// listing, so it gets its own nights, deposit, processing fee, owner/manager
// names and split without any of that logic being duplicated here.
export function composeMultiListing(payload, tenant, listings) {
  const children = listings.map((listing, index) => {
    const childPayload = {
      ...payload,
      bookingId: childBookingId(payload.bookingId, index),
      parentBookingId: payload.bookingId,
      propertyCode: listing.propertyCode,
      propertyName: listing.propertyCode,
      checkIn: listing.checkIn,
      checkOut: listing.checkOut,
      nightlyRate: listing.nightlyRate ?? undefined,
      // bookingTotal is the WHOLE reservation on a bundled payload. Handing it
      // to a child would price that listing at the price of all of them, so it
      // is replaced by this listing's own rent and dropped when unknown --
      // composeBooking then works from nights and the nightly rate.
      bookingTotal: listing.rentTotal ?? undefined,
    };
    const { snapshot } = composeBooking(childPayload, tenant);
    snapshot.parentBookingId = payload.bookingId;
    snapshot.listingIndex = index;
    return snapshot;
  });

  const parent = {
    type: MULTI_PARENT_TYPE,
    bookingId: payload.bookingId,
    locationId: payload.locationId,
    createdAt: new Date().toISOString(),
    childBookingIds: children.map((c) => c.bookingId),
    listingCount: children.length,
    guest: children[0]?.guest ?? null,
    ghlContactId: payload.ghlContactId ?? payload.contactId ?? null,
    // The reservation-level totals, summed from the children rather than taken
    // from the payload, so the parent can never disagree with what was priced.
    charges: {
      rentTotal: sum(children.map((c) => c.charges.rentTotal)),
      cleaningFee: sum(children.map((c) => c.charges.cleaningFee)),
      processingFee: sum(children.map((c) => c.charges.processingFee)),
    },
    securityDeposit: { total: sum(children.map((c) => c.securityDeposit?.total ?? 0)) },
    stayRange: {
      checkIn: children.map((c) => c.stay.checkIn).sort()[0],
      checkOut: children.map((c) => c.stay.checkOut).sort().at(-1),
    },
  };

  return { parent, children };
}

const sum = (xs) => Math.round(xs.reduce((s, n) => s + (Number(n) || 0), 0) * 100) / 100;
