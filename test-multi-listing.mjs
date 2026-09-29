// One reservation, several listings.
// Run: node test-multi-listing.mjs
//
// DEMO-HOMS booking JI1yIAnf498IgFIV7J9M, 2026-09-28: Test Villa 2 for Sep 30
// to Oct 3 and Test Villa 3 for Oct 3 to Oct 9, one booking id, $1,430. The
// Worker had no snapshot for it at all, and could not have priced one -- a
// snapshot holds one stay, one property, one split.
//
// A single-listing booking made the same day came through perfectly, so the gap
// was specifically the bundled case.
import assert from "node:assert";

const { listingsFrom, composeMultiListing, isMultiListingParent, childBookingId, MULTI_PARENT_TYPE } =
  await import("./src/multi-listing.js");

const LOC = "ZghxU8I60bEm39JUbtCm";
const BOOKING = "JI1yIAnf498IgFIV7J9M";

// Two owners on purpose: the case a single snapshot cannot express at all.
const tenant = {
  brandName: "Casa Bonita", currency: "USD", ownerPct: 0.85, processingFeePct: 0.06,
  deposit: { rule: "none" },
  ownerName: "Account Default Owner", managerName: "Account Default Manager",
  propertyOwnerNames: { "Test Villa 2": "Carlos Mendoza", "Test Villa 3": "Rosa Jimenez" },
  propertyManagerNames: { "Test Villa 2": "Maguisthel Fabian" },
};

const bundled = (over = {}) => ({
  bookingId: BOOKING, locationId: LOC, contactId: "c1",
  firstName: "Family", lastName: "Booking", email: "g@example.com", phone: "+18095550111",
  bookingTotal: 1430,
  listings: [
    { propertyName: "Test Villa 2", startDate: "2026-09-30T00:00:00.000Z", endDate: "2026-10-03T00:00:00.000Z", unitPrice: 135, amount: 405 },
    { propertyName: "Test Villa 3", startDate: "2026-10-03T00:00:00.000Z", endDate: "2026-10-09T00:00:00.000Z", unitPrice: 110, amount: 660 },
  ],
  ...over,
});

// ---- 1. two listings are detected, one is not ------------------------
{
  assert.strictEqual(listingsFrom(bundled()).length, 2);
  assert.strictEqual(listingsFrom({ bookingId: BOOKING, checkIn: "2026-09-30", checkOut: "2026-10-03" }), null,
    "an ordinary booking stays on the ordinary path");
  assert.strictEqual(listingsFrom({ ...bundled(), listings: [bundled().listings[0]] }), null,
    "a bundle of one is not a bundle");
  console.log("1) A bundled payload is detected; a single-listing one is left alone");
}

// ---- 2. an unrecognisable shape is treated as single, not guessed ----
// A booking priced as one listing is wrong in a way somebody notices. A booking
// split on a guess is wrong in a way that quietly pays the wrong owner.
{
  const noDates = { ...bundled(), listings: [{ propertyName: "A" }, { propertyName: "B" }] };
  assert.strictEqual(listingsFrom(noDates), null, "listings without dates cannot be priced, so they are not split");

  const oneMissing = {
    ...bundled(),
    listings: [bundled().listings[0], { propertyName: "Test Villa 3", unitPrice: 110 }],
  };
  assert.strictEqual(listingsFrom(oneMissing), null,
    "one unpriceable listing stops the split -- pricing the rest would silently drop it");
  console.log("2) A shape that cannot be priced is never split on a guess");
}

// ---- 3. each listing becomes its own ordinary-looking snapshot -------
{
  const { children } = composeMultiListing(bundled(), tenant, listingsFrom(bundled()));
  assert.strictEqual(children.length, 2);

  const [a, b] = children;
  assert.strictEqual(a.bookingId, childBookingId(BOOKING, 0));
  assert.strictEqual(a.propertyCode, "Test Villa 2");
  assert.strictEqual(a.stay.checkIn, "2026-09-30");
  assert.strictEqual(a.stay.checkOut, "2026-10-03");
  assert.strictEqual(a.stay.nights, 3);
  assert.strictEqual(a.charges.rentTotal, 405, "3 nights at 135");

  assert.strictEqual(b.propertyCode, "Test Villa 3");
  assert.strictEqual(b.stay.nights, 6);
  assert.strictEqual(b.charges.rentTotal, 660, "6 nights at 110");
  assert.strictEqual(b.parentBookingId, BOOKING, "each child knows its reservation");
  console.log("3) Each listing gets its own dates, nights and rent, under its own booking id");
}

// ---- 4. the whole reason for doing it this way -----------------------
// Two properties, two owners, two splits. A single snapshot has one payout
// object and would have had to pick one of them.
{
  const { children } = composeMultiListing(bundled(), tenant, listingsFrom(bundled()));
  const [a, b] = children;
  assert.strictEqual(a.payout.ownerName, "Carlos Mendoza");
  assert.strictEqual(b.payout.ownerName, "Rosa Jimenez", "the second listing pays its own owner");
  assert.strictEqual(a.payout.managerName, "Maguisthel Fabian");
  assert.strictEqual(b.payout.managerName, "Account Default Manager",
    "and falls back per property, exactly as a single booking would");

  assert.strictEqual(a.payout.owner, 344.25, "85% of 405");
  assert.strictEqual(b.payout.owner, 561, "85% of 660");
  console.log("4) Two listings, two owners, two splits -- the thing one snapshot could not hold");
}

// ---- 5. the parent totals are summed from the children --------------
// Never read off the payload, so the parent cannot disagree with what was
// actually priced.
{
  const { parent, children } = composeMultiListing(bundled(), tenant, listingsFrom(bundled()));
  assert.strictEqual(parent.type, MULTI_PARENT_TYPE);
  assert.strictEqual(isMultiListingParent(parent), true);
  assert.strictEqual(isMultiListingParent(children[0]), false, "a child is an ordinary booking");

  assert.strictEqual(parent.charges.rentTotal, 1065, "405 + 660, not the payload's 1430");
  assert.deepStrictEqual(parent.childBookingIds, [childBookingId(BOOKING, 0), childBookingId(BOOKING, 1)]);
  assert.strictEqual(parent.stayRange.checkIn, "2026-09-30", "earliest arrival");
  assert.strictEqual(parent.stayRange.checkOut, "2026-10-09", "latest departure");
  console.log("5) The parent sums its children rather than trusting the payload total");
}

// ---- 6. the processing fee needs no apportioning --------------------
// It is a flat percentage, so charging each listing on its own rent sums to
// exactly the fee on the whole reservation. Worth pinning: the obvious
// alternative is to split the parent's fee by some ratio, and that is both more
// code and more rounding.
{
  const { parent, children } = composeMultiListing(bundled(), tenant, listingsFrom(bundled()));
  const perChild = children.reduce((s, c) => s + c.charges.processingFee, 0);
  const onWhole = Math.round(0.06 * parent.charges.rentTotal * 100) / 100;
  assert.strictEqual(Math.round(perChild * 100) / 100, onWhole,
    "per-listing fees sum to the fee on the whole booking");
  assert.strictEqual(parent.charges.processingFee, onWhole);
  console.log("6) Per-listing processing fees sum to the fee on the whole reservation");
}

// ---- 7. the reservation total never prices a single listing ----------
// A child inherits the payload, which carries bookingTotal for the WHOLE
// reservation. composeBooking falls back to bookingTotal/nights whenever no
// nightly rate is given -- so a listing quoted only as a total would otherwise
// be priced at the price of all of them.
//
// This case exists because a mutation escaped: with every listing carrying a
// unit price, the nightly rate always won and the override was never exercised.
{
  const noUnitPrice = {
    ...bundled(),
    listings: [
      { propertyName: "Test Villa 2", startDate: "2026-09-30", endDate: "2026-10-03", amount: 405 },
      { propertyName: "Test Villa 3", startDate: "2026-10-03", endDate: "2026-10-09", amount: 660 },
    ],
  };
  const { children } = composeMultiListing(noUnitPrice, tenant, listingsFrom(noUnitPrice));
  assert.strictEqual(children[0].charges.rentTotal, 405, "priced from its own total");
  assert.strictEqual(children[1].charges.rentTotal, 660);
  for (const c of children) {
    assert.notStrictEqual(c.charges.rentTotal, 1430, "never at the whole reservation's price");
  }
  console.log("7) A listing quoted only as a total is priced from its own, not the reservation's");
}

// ================================================ cancelling the bundle ====
// GHL gives the guest no way to drop one listing and keep the other, so
// cancelling the reservation cancels every listing on it.
global.Response = class { constructor(b, i = {}) { this.body = b; this.status = i.status || 200; } async json() { return JSON.parse(this.body); } };

const cancelTenant = {
  ...tenant, adminSecret: "admin123", ghlPit: "pit", tzOffsetHours: -4, checkInHour: 15,
  cancellationPolicy: { tiers: [{ underHours: 120, nights: 1, remainderPct: 0.5 }], checkedInChargePct: 1 },
  ghlCancellationUrl: "https://services.leadconnectorhq.com/hooks/cancel",
};


// Dates relative to now, so the first listing is always already under way and
// the second always still ahead -- the split-tier case cannot be expressed with
// fixed dates without the suite rotting the moment they pass.
const dayOffset = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const straddling = () => ({
  ...bundled(),
  listings: [
    { propertyName: "Test Villa 2", startDate: dayOffset(-2), endDate: dayOffset(1), unitPrice: 135, amount: 405 },
    { propertyName: "Test Villa 3", startDate: dayOffset(1), endDate: dayOffset(7), unitPrice: 110, amount: 660 },
  ],
});

const store = new Map();
const kv = {
  async get(k, o) { const v = store.get(k); return v == null ? null : (o?.type === "json" ? JSON.parse(v) : v); },
  async put(k, v) { store.set(k, v); },
};
global.fetch = async (url) => {
  const ok = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
  return ok({ records: [], record: { id: "r" }, associations: [] });
};

const { handleCancel } = await import("./src/cancellation.js");
const cancelEnv = { TENANTS: kv, BOOKINGS: kv, ADMIN_SECRET: "admin123" };

// Settled children, so the paid path runs and real tiers apply.
async function seedBundle({ nowIso }) {
  store.clear();
  await kv.put(LOC, JSON.stringify(cancelTenant));
  const { parent, children } = composeMultiListing(straddling(), cancelTenant, listingsFrom(straddling()));
  for (const c of children) {
    c.settled = true;
    c.gateway = "ghl_invoice";
    c.captures = { RENT: { gross: c.charges.rentTotal, source: "ghl_invoice" } };
    c.ghl = { transactionId: "tx-" + c.listingIndex, paymentIds: [] };
    await kv.put(c.bookingId, JSON.stringify(c));
  }
  await kv.put(parent.bookingId, JSON.stringify(parent));
  return { parent, children, nowIso };
}

const cancelParent = async () => {
  const res = await handleCancel({
    method: "POST", url: "https://w.dev/cancel",
    json: async () => ({ bookingId: BOOKING, locationId: LOC, reason: "family cancelled" }),
    headers: { get: (n) => (n === "X-Admin-Secret" ? "admin123" : null) },
  }, cancelEnv);
  return { status: res.status, body: await res.json() };
};

// ---- 8. cancelling the reservation cancels every listing -------------
{
  await seedBundle({});
  const out = await cancelParent();
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));
  assert.strictEqual(out.body.multiListing, true);
  assert.strictEqual(out.body.listingCount, 2);

  for (const id of [childBookingId(BOOKING, 0), childBookingId(BOOKING, 1)]) {
    assert.strictEqual(JSON.parse(store.get(id)).cancelled, true, `${id} is cancelled`);
  }
  assert.strictEqual(JSON.parse(store.get(BOOKING)).cancelled, true, "and so is the reservation itself");
  console.log("8) Cancelling a bundled reservation cancels every listing on it");
}

// ---- 9. the case the whole design exists for -------------------------
// Cancelling on Oct 1: the guest is already IN Test Villa 2 (checked in Sep 30)
// and has not started Test Villa 3 (Oct 3). One listing hits the checked-in
// tier at 100%, the other does not. A single snapshot would have had to pick
// one answer for both.
{
  await seedBundle({});
  const out = await cancelParent();
  const [first, second] = out.body.cancellation.listings;

  assert.strictEqual(first.tier, "already_checked_in", "the listing already under way is fully charged");
  assert.strictEqual(first.charge, 405, "all of its rent retained");
  assert.notStrictEqual(second.tier, "already_checked_in", "the one that has not started is not");
  assert.ok(second.charge < 660, "so it is charged at its own tier, not the first one's");
  console.log("9) Two listings on one cancellation land in different tiers, each judged by its own check-in");
}

// ---- 10. the reservation totals are what actually happened ----------
{
  await seedBundle({});
  const out = await cancelParent();
  const c = out.body.cancellation;
  const summed = c.listings.reduce((s, l) => s + l.charge, 0);
  assert.strictEqual(c.chargeTotal, Math.round(summed * 100) / 100,
    "summed from the listings, not recomputed against the reservation");
  assert.ok(c.manualRefundTotal > 0, "and the manual refunds across both listings are totalled for the manager");
  console.log("10) The reservation's cancellation totals are summed from what each listing actually did");
}

// ---- 11. one listing failing does not hide the others ---------------
// A reservation half-cancelled and silent is the worst outcome available.
{
  await seedBundle({});
  store.delete(childBookingId(BOOKING, 1)); // the second listing is gone
  const out = await cancelParent();

  assert.strictEqual(out.status, 207, "a partial result reports as one, rather than as success");
  assert.strictEqual(out.body.failedListings.length, 1);
  assert.strictEqual(out.body.failedListings[0].bookingId, childBookingId(BOOKING, 1),
    "named, because 1 of 2 failed tells nobody which guest to sort out");
  assert.strictEqual(JSON.parse(store.get(childBookingId(BOOKING, 0))).cancelled, true,
    "and the listing that could be cancelled still was");
  console.log("11) A listing that fails is named, and never stops the others cancelling");
}

// ---- 12. a listing that THROWS is caught, not just one that 404s ----
// Test 11 covers a child that returns an error status. A child that throws --
// KV unavailable mid-fan-out, say -- takes a different path, and without this
// the try/catch around the fan-out was never exercised at all.
{
  await seedBundle({});
  const secondId = childBookingId(BOOKING, 1);
  const realGet = kv.get;
  kv.get = async function (k, o) {
    if (k === secondId) throw new Error("KV unavailable");
    return realGet.call(this, k, o);
  };

  const out = await cancelParent();
  kv.get = realGet;

  assert.strictEqual(out.status, 207, "a thrown listing is still a partial result, not a success");
  assert.strictEqual(out.body.failedListings.length, 1);
  assert.strictEqual(out.body.failedListings[0].bookingId, secondId);
  assert.match(out.body.failedListings[0].error, /KV unavailable/,
    "and carries what actually went wrong, rather than a bare status");
  assert.strictEqual(JSON.parse(store.get(childBookingId(BOOKING, 0))).cancelled, true,
    "the listing that could be cancelled still was");
  console.log("12) A listing that throws mid-fan-out is caught, named, and does not stop the others");
}

console.log("\nPASS — a bundled reservation becomes one ordinary-looking booking per listing, each with its own dates, owner and split.");
