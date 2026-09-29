// Moving a bundled reservation, and moving one leg of it.
// Run: node test-multi-listing-reschedule.mjs
//
// Cancelling a bundle is unambiguous: GHL cancels every listing together and
// each child prices against its own check-in date. Moving one is not. A parent
// has no stay of its own, so a single new check-in and check-out could mean the
// whole trip shifted, or one leg got longer -- and those two readings bill
// different properties and pay different owners.
//
// So a parent accepts a SHIFT and refuses a span change, naming the listings to
// target instead. Changing one leg is done by rescheduling that leg directly,
// which already worked; what did not work was the reservation keeping the dates
// and money of a trip that no longer existed.
import assert from "node:assert";

global.Response = class { constructor(b, i = {}) { this.body = b; this.status = i.status || 200; } async json() { return JSON.parse(this.body); } };
global.btoa = (s) => Buffer.from(s).toString("base64");

const { composeMultiListing, listingsFrom, childBookingId } = await import("./src/multi-listing.js");

const LOC = "ZghxU8I60bEm39JUbtCm";
const BOOKING = "JI1yIAnf498IgFIV7J9M";

const tenant = {
  brandName: "Casa Bonita", currency: "USD", ownerPct: 0.85, processingFeePct: 0.06,
  deposit: { rule: "none" }, adminSecret: "admin123", ghlPit: "pit",
  tzOffsetHours: -4, checkInHour: 15,
  propertyOwnerNames: { "Test Villa 2": "Carlos Mendoza", "Test Villa 3": "Rosa Jimenez" },
  gateway: "paypal", paypalApi: "https://p", paypalClientId: "C", paypalSecret: "S",
  ghlRescheduleUrl: "https://services.leadconnectorhq.com/hooks/resched",
};

const bundled = () => ({
  bookingId: BOOKING, locationId: LOC, contactId: "c1",
  firstName: "Family", lastName: "Booking", email: "g@example.com", phone: "+18095550111",
  bookingTotal: 1065,
  listings: [
    { propertyName: "Test Villa 2", startDate: "2026-11-02", endDate: "2026-11-05", unitPrice: 135 },
    { propertyName: "Test Villa 3", startDate: "2026-11-05", endDate: "2026-11-11", unitPrice: 110 },
  ],
});

const store = new Map();
const kv = {
  async get(k, o) { const v = store.get(k); return v == null ? null : (o?.type === "json" ? JSON.parse(v) : v); },
  async put(k, v) { store.set(k, v); },
};
global.fetch = async (url) => {
  const ok = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
  if (String(url).includes("backend.leadconnectorhq.com")) {
    return ok({ serviceBooking: { contactId: "c1", appointmentTitle: "stay", deleted: false, services: [{ id: "s1", position: 0, name: "V", price: 100, unitPrice: 100, startDate: "o", endDate: "o" }] } });
  }
  return ok({ records: [], record: { id: "r" }, associations: [], access_token: "T", id: "PP-1", links: [{ rel: "payer-action", href: "https://x" }] });
};

const { handleReschedule } = await import("./src/reschedule.js");
const env = { WORKER_URL: "https://w.dev", TENANTS: kv, BOOKINGS: kv, ADMIN_SECRET: "admin123" };

async function seed() {
  store.clear();
  await kv.put(LOC, JSON.stringify(tenant));
  const { parent, children } = composeMultiListing(bundled(), tenant, listingsFrom(bundled()));
  for (const c of children) await kv.put(c.bookingId, JSON.stringify(c));
  await kv.put(parent.bookingId, JSON.stringify(parent));
  return { parent, children };
}

const reschedule = async (bookingId, newCheckIn, newCheckOut) => {
  const res = await handleReschedule({
    method: "POST", url: "https://w.dev/reschedule",
    json: async () => ({ bookingId, newCheckIn, newCheckOut, reason: "guest asked" }),
    headers: { get: (n) => (n === "X-Admin-Secret" ? "admin123" : null) },
  }, env);
  return { status: res.status, body: await res.json() };
};

// ---- 1. the whole trip moves, every leg keeping its own length -------
// Nov 2-11 becomes Nov 9-18: both listings shift seven days, 3 nights stays 3
// nights and 6 stays 6, and they stay chained end to end.
{
  await seed();
  const out = await reschedule(BOOKING, "2026-11-09", "2026-11-18");
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));
  assert.strictEqual(out.body.multiListing, true);
  assert.strictEqual(out.body.shiftDays, 7);

  const a = JSON.parse(store.get(childBookingId(BOOKING, 0)));
  const b = JSON.parse(store.get(childBookingId(BOOKING, 1)));
  assert.deepStrictEqual([a.stay.checkIn, a.stay.checkOut], ["2026-11-09", "2026-11-12"]);
  assert.deepStrictEqual([b.stay.checkIn, b.stay.checkOut], ["2026-11-12", "2026-11-18"]);
  assert.strictEqual(a.stay.nights, 3, "each leg keeps its own length");
  assert.strictEqual(b.stay.nights, 6);
  console.log("1) A parent shift moves every listing by the same days, keeping each leg's length");
}

// ---- 2. the money does not move when only the dates do --------------
// A pure shift changes no nights, so it must change no rent. Worth pinning:
// the shift runs each leg through the ordinary reschedule, which is the code
// that DOES reprice, and it would be easy for a rounding or a re-derivation to
// creep in.
{
  const { children } = await seed();
  const before = children.map((c) => c.charges.rentTotal);
  await reschedule(BOOKING, "2026-11-09", "2026-11-18");
  const after = [
    JSON.parse(store.get(childBookingId(BOOKING, 0))).charges.rentTotal,
    JSON.parse(store.get(childBookingId(BOOKING, 1))).charges.rentTotal,
  ];
  assert.deepStrictEqual(after, before, "moving a trip is not repricing it");
  console.log("2) Shifting dates leaves every listing's rent exactly as it was");
}

// ---- 3. the reservation follows its children ------------------------
{
  await seed();
  await reschedule(BOOKING, "2026-11-09", "2026-11-18");
  const parent = JSON.parse(store.get(BOOKING));
  assert.deepStrictEqual(parent.stayRange, { checkIn: "2026-11-09", checkOut: "2026-11-18" },
    "the parent's span is rebuilt from where its listings actually ended up");
  assert.strictEqual(parent.charges.rentTotal, 1065);
  console.log("3) The reservation's span is rebuilt from its listings, not assumed");
}

// ---- 4. a span change is refused, and says what to do instead -------
// "Two nights longer" does not say which leg grew. The two answers bill
// different properties and pay different owners, so this is not a default to
// pick -- it is a question for whoever knows.
{
  await seed();
  const out = await reschedule(BOOKING, "2026-11-09", "2026-11-20");
  assert.strictEqual(out.status, 422);
  assert.match(out.body.error, /only be moved as a whole/);
  assert.match(out.body.error, /which listing changed/);
  assert.deepStrictEqual(out.body.listings.map((l) => l.bookingId),
    [childBookingId(BOOKING, 0), childBookingId(BOOKING, 1)],
    "and names the listings, so the caller can say which one");

  const a = JSON.parse(store.get(childBookingId(BOOKING, 0)));
  assert.strictEqual(a.stay.checkIn, "2026-11-02", "nothing moved");
  console.log("4) A parent whose span would change is refused, naming the listings to target instead");
}

// ---- 5. one leg can still be changed, by its own id ------------------
// This is the supported way to extend a single listing, and it already worked.
{
  await seed();
  const secondId = childBookingId(BOOKING, 1);
  const out = await reschedule(secondId, "2026-11-05", "2026-11-13");
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));

  const b = JSON.parse(store.get(secondId));
  assert.strictEqual(b.stay.nights, 8, "six nights became eight");
  assert.strictEqual(b.charges.rentTotal, 880, "and it is repriced at its own nightly rate");
  console.log("5) A single leg is rescheduled by its own booking id, and reprices normally");
}

// ---- 6. and the reservation notices ---------------------------------
// The gap this closes. Before, the parent kept the span and the money of a trip
// that no longer existed -- the same drift #61 closed against the Transaction
// record and #64 against the invoice.
{
  await seed();
  const parentBefore = JSON.parse(store.get(BOOKING));
  assert.strictEqual(parentBefore.stayRange.checkOut, "2026-11-11");
  assert.strictEqual(parentBefore.charges.rentTotal, 1065);

  await reschedule(childBookingId(BOOKING, 1), "2026-11-05", "2026-11-13");

  const parentAfter = JSON.parse(store.get(BOOKING));
  assert.strictEqual(parentAfter.stayRange.checkOut, "2026-11-13", "the reservation now ends when the trip does");
  assert.strictEqual(parentAfter.charges.rentTotal, 1285, "405 + 880");
  console.log("6) Changing one leg updates the reservation's span and totals");
}

// ---- 7. a no-op move is rejected rather than run ---------------------
{
  await seed();
  const out = await reschedule(BOOKING, "2026-11-02", "2026-11-11");
  assert.strictEqual(out.status, 400);
  assert.match(out.body.error, /already has/);
  console.log("7) Moving a reservation to the dates it already has is rejected, not processed");
}

// ---- 8. one leg failing does not hide the rest ----------------------
{
  await seed();
  store.delete(childBookingId(BOOKING, 1));
  const out = await reschedule(BOOKING, "2026-11-09", "2026-11-18");

  assert.strictEqual(out.status, 207, "a partial result reports as one");
  assert.strictEqual(out.body.failedListings.length, 1);
  assert.strictEqual(out.body.failedListings[0].bookingId, childBookingId(BOOKING, 1));
  assert.strictEqual(JSON.parse(store.get(childBookingId(BOOKING, 0))).stay.checkIn, "2026-11-09",
    "and the leg that could move still did");
  console.log("8) A listing that fails is named, and the others still move");
}

console.log("\nPASS — a bundled reservation moves as a whole or not at all, one leg moves on its own, and the reservation follows either way.");
