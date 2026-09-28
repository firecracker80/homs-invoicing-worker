// A stay that got longer has to cost more in the CRM too.
// Run: node test-reschedule-transaction-money.mjs
//
// DEMO-HOMS booking SiKoozWmXBEFIaiIqOkO, found 2026-09-27: rescheduled from
// three nights to five, checkin_date and checkout_date updated correctly on the
// Transaction record, and booking_total / net_payout left at the three-night
// figure. The Worker had priced the extension right and charged for it; only
// the record anyone actually looks at stayed wrong.
//
// The cause was two expressions of one rule. ledger.js computed rent + cleaning
// at settlement; reschedule.js wrote dates and nothing else. Nothing compared
// them, so the second never learned what the first knew. They now share
// bookingTotalOf, which is the part of this fix that keeps it fixed.
import assert from "node:assert";

global.Response = class { constructor(b, i = {}) { this.body = b; this.status = i.status || 200; } async json() { return JSON.parse(this.body); } };
global.btoa = (s) => Buffer.from(s).toString("base64");

const LOC = "ZghxU8I60bEm39JUbtCm";
const BOOKING = "SiKoozWmXBEFIaiIqOkO";
const TX = "6ab876a5bc3a50ac99453994";

const store = new Map();
const kv = {
  async get(k, o) { const v = store.get(k); return v == null ? null : (o?.type === "json" ? JSON.parse(v) : v); },
  async put(k, v) { store.set(k, v); },
};
const hdr = (s) => ({ get: (n) => (n === "X-Admin-Secret" ? s : null) });

const tenant = {
  brandName: "Casa Bonita", currency: "USD", ownerPct: 0.85, processingFeePct: 0.06,
  defaultCleaningFee: 65, cleaningFeeRecipient: "manager", bookingWorkerEnabled: true,
  gateway: "paypal", deposit: { rule: "none" },
  paypalApi: "https://p", paypalClientId: "C", paypalSecret: "S",
  adminSecret: "admin123", ghlPit: "pit", tzOffsetHours: -4, checkInHour: 15,
};

// Three nights at 80, plus a 65 cleaning fee. booking_total at settlement = 305.
const paidSnapshot = () => ({
  bookingId: BOOKING, locationId: LOC, ghlContactId: "c1", propertyCode: "Test Villa 3",
  createdAt: "2026-09-27T01:51:00.000Z",
  guest: { name: "Reschedule Test", email: "g@example.com" },
  stay: { checkIn: "2026-10-17", checkOut: "2026-10-20", nights: 3, nightlyRate: 80 },
  charges: { rentTotal: 240, cleaningFee: 65, processingFee: 19.8, feePct: 0.06, grandTotal: 324.8 },
  securityDeposit: { total: 0, blocks: [], status: "none" },
  payout: { basis: 240, ownerPct: 0.85, owner: 204, manager: 36, cleaningFeeTo: "manager", status: "paid" },
  gateway: "paypal", settled: true,
  captures: { RENT: { gross: 324.8, captureId: "cap-1", source: "paypal" } },
  ghl: { transactionId: TX, paymentIds: [] },
});

let txUpdates = [];
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const ok = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });
  if (u.includes("oauth2/token")) return ok({ access_token: "T" });
  if (u.includes("checkout/orders")) {
    return ok({ id: "PP-1", links: [{ rel: "payer-action", href: "https://sandbox.paypal.com/checkoutnow?token=PP1" }] });
  }
  if (u.includes("/refund")) return ok({ id: "REF-1", status: "COMPLETED" });
  if (u.includes("/objects/custom_objects.transactions/records/") && opts.method === "PUT") {
    txUpdates.push({ url: u, body: JSON.parse(opts.body) });
    return ok({ record: { id: TX } });
  }
  if (u.includes("backend.leadconnectorhq.com/calendars/bookings/details/")) {
    return ok({ serviceBooking: { contactId: "c1", appointmentTitle: "stay", deleted: false,
      services: [{ id: "svc1", position: 0, name: "Test Villa 3", price: 80, unitPrice: 80, startDate: "old", endDate: "old" }] } });
  }
  if (u.includes("leadconnector")) return ok({ ok: true, records: [], record: { id: "r" }, associations: [] });
  if (u.includes("/objects/")) return ok({ record: { id: "r" }, records: [] });
  throw new Error("unmocked: " + u);
};

const worker = (await import("./src/index.js")).default;
const { bookingTotalOf } = await import("./src/ledger.js");
const env = { WORKER_URL: "https://w.dev", TENANTS: kv, BOOKINGS: kv, ADMIN_SECRET: "admin123" };
await kv.put(LOC, JSON.stringify(tenant));

const reschedule = async (body) => {
  txUpdates = [];
  await kv.put(BOOKING, JSON.stringify(body.snapshot ?? paidSnapshot()));
  const res = await worker.fetch({
    method: "POST", url: "https://w.dev/reschedule",
    json: async () => ({ bookingId: BOOKING, newCheckIn: body.newCheckIn, newCheckOut: body.newCheckOut, reason: "test" }),
    headers: hdr("admin123"),
  }, env);
  return { status: res.status, body: await res.json() };
};

// ---- 1. the extension that started this -------------------------------
// Three nights to five. 5 x 80 = 400 rent, plus the unchanged 65 cleaning.
{
  const out = await reschedule({ newCheckIn: "2026-10-17", newCheckOut: "2026-10-22" });
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));

  assert.strictEqual(txUpdates.length, 1, "the Transaction record is updated exactly once");
  const props = txUpdates[0].body.properties;
  assert.strictEqual(props.checkout_date, "2026-10-22", "the dates still move");
  assert.deepStrictEqual(props.booking_total, { value: 465, currency: "default" },
    "and so does the money -- 400 rent + 65 cleaning, not the original 305");
  assert.deepStrictEqual(props.net_payout, { value: 465, currency: "default" });
  console.log("1) Extending a stay updates booking_total and net_payout, not just the dates");
}

// ---- 2. it agrees with what settlement would have written --------------
// The assertion that outlives this fix: both sides call bookingTotalOf, so a
// future change to what counts as booking_total cannot move one and not the
// other. A hardcoded 465 above would pass even if the two drifted apart again.
{
  await reschedule({ newCheckIn: "2026-10-17", newCheckOut: "2026-10-22" });
  const written = txUpdates[0].body.properties.booking_total.value;

  const asSettled = bookingTotalOf(JSON.parse(store.get(BOOKING)));
  assert.strictEqual(written, asSettled,
    "the reschedule writes exactly what settlement would write for the same stay");
  console.log("2) The rescheduled total is the same expression settlement uses, not a copy of it");
}

// ---- 3. a shortened stay comes down, not just up ----------------------
// The refund path is a different branch. It was equally silent.
{
  const out = await reschedule({ newCheckIn: "2026-10-17", newCheckOut: "2026-10-19" });
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));
  const props = txUpdates[0].body.properties;
  assert.deepStrictEqual(props.booking_total, { value: 225, currency: "default" },
    "two nights at 80 plus cleaning -- the CRM must not keep showing three");
  assert.deepStrictEqual(props.net_payout, { value: 225, currency: "default" });
  console.log("3) Shortening a stay brings the recorded total down as well");
}

// ---- 4. a same-length move touches the dates only in effect -----------
// Mara's first reschedule was same-duration and looked fine, which is why the
// gap survived a passing test. The total is still written; it is simply equal.
{
  const out = await reschedule({ newCheckIn: "2026-10-24", newCheckOut: "2026-10-27" });
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));
  const props = txUpdates[0].body.properties;
  assert.strictEqual(props.checkin_date, "2026-10-24");
  assert.deepStrictEqual(props.booking_total, { value: 305, currency: "default" },
    "unchanged duration, unchanged total -- and still written rather than assumed");
  console.log("4) A same-duration move leaves the total equal, having recomputed it");
}

// ---- 5. platform_fee is left alone -----------------------------------
// It is 0 at creation and a date change earns no platform anything. Writing it
// would be a second place for it to drift from whatever creation decides.
{
  await reschedule({ newCheckIn: "2026-10-17", newCheckOut: "2026-10-22" });
  const props = txUpdates[0].body.properties;
  assert.strictEqual("platform_fee" in props, false, "not this record's business to restate");
  assert.deepStrictEqual(Object.keys(props).sort(),
    ["booking_total", "checkin_date", "checkout_date", "net_payout"],
    "and nothing else is written either -- an update that touches more than it means to is how records get clobbered");
  console.log("5) The update writes four fields and no more");
}

// ---- 6. an unsettled booking has no Transaction to update ------------
// resolveTransactionId returns null before settlement, so the whole block is
// skipped. Writing to a record id of undefined would 404 against a real GHL.
{
  const unpaid = { ...paidSnapshot(), settled: false, captures: undefined, ghl: undefined };
  const out = await reschedule({ newCheckIn: "2026-10-17", newCheckOut: "2026-10-22", snapshot: unpaid });
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));
  assert.deepStrictEqual(txUpdates, [], "nothing is written for a booking that never settled");
  console.log("6) An unsettled booking writes no Transaction update at all");
}

console.log("\nPASS — a reschedule moves the money on the Transaction record, not only the dates.");
