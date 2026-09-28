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

export const MULTI_PARENT_TYPE = "multi_listing_parent";

// A parent holds no stay of its own, so anything that reads snapshot.stay must
// not be handed one by accident.
export function isMultiListingParent(snapshot) {
  return snapshot?.type === MULTI_PARENT_TYPE;
}

export const childBookingId = (bookingId, index) => `${bookingId}#${index + 1}`;

const blank = (v) => v === undefined || v === null || String(v).trim() === "";

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
