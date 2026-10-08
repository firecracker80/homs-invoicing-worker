// A booking records what happened to it, and payment records only the money.
// Run: node test-booking-status.mjs
//
// The Transactions object had one status field, payment_status, and three
// different events were being pushed through it:
//
//   - a cancellation wrote "refunded" whenever it produced a ledger row, which
//     it does even when the guest was charged in full and got nothing back;
//   - a security deposit released after a clean inspection ALSO wrote
//     "refunded" -- so a completed stay, paid in full, read as refunded;
//   - a reschedule wrote nothing, so a moved booking was indistinguishable from
//     one booked for those dates in the first place.
//
// booking_status (created on DEMO-HOMS 2026-10-07, SINGLE_OPTIONS:
// confirmed/cancelled/rescheduled) carries the lifecycle. payment_status goes
// back to meaning money.
import assert from "node:assert";

global.Response = class { constructor(b, i = {}) { this.body = b; this.status = i.status || 200; } async json() { return JSON.parse(this.body); } };
global.btoa = (s) => Buffer.from(s).toString("base64");

const LOC = "ZghxU8I60bEm39JUbtCm";
const BOOKING = "BSTATUS-1";
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
  gateway: "ghl_invoice", deposit: { rule: "none" },
  adminSecret: "admin123", ghlPit: "pit", tzOffsetHours: -4, checkInHour: 15,
  // A gateway that can actually issue a refund, so the deposit-refund path in
  // case 4 reaches the code being tested rather than returning early.
  paypalApi: "https://p", paypalClientId: "C", paypalSecret: "S",
  // A mid-stay cancellation keeps the whole rent; cancel 5+ days out keeps 20%.
  cancellationPolicy: { checkedInChargePct: 1, tiers: [{ underHours: 24, chargePct: 0.5 }, { underHours: 120, chargePct: 0.3 }, { underHours: 100000, chargePct: 0.2 }] },
};

// Checked in two days ago, so hoursUntil < 0 -> the 100% tier. Paid in full.
const snap = (over = {}) => ({
  bookingId: BOOKING, locationId: LOC, ghlContactId: "c1", propertyCode: "Test Villa 3",
  createdAt: "2026-09-01T01:51:00.000Z",
  guest: { name: "Status Test", email: "g@example.com" },
  stay: { checkIn: "2026-10-05", checkOut: "2026-10-12", nights: 7, nightlyRate: 80 },
  charges: { rentTotal: 560, cleaningFee: 65, processingFee: 0, feePct: 0, grandTotal: 625 },
  securityDeposit: { total: 0, blocks: [], status: "none" },
  payout: { basis: 560, ownerPct: 0.85, owner: 476, manager: 84, cleaningFeeTo: "manager", status: "paid" },
  gateway: "ghl_invoice", settled: true,
  ghl: { transactionId: TX, paymentIds: [] },
  ...over,
});

let txUpdates = [];
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const ok = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });
  if (u.includes("oauth2/token")) return ok({ access_token: "T" });
  if (u.includes("/refund")) return ok({ id: "REF-1", status: "COMPLETED" });
  if (u.includes("/objects/custom_objects.transactions/records/") && opts.method === "PUT") {
    txUpdates.push(JSON.parse(opts.body).properties);
    return ok({ record: { id: TX } });
  }
  if (u.includes("backend.leadconnectorhq.com/calendars/bookings/details/")) {
    return ok({ serviceBooking: { contactId: "c1", appointmentTitle: "stay", deleted: false,
      services: [{ id: "svc1", position: 0, name: "Test Villa 3", price: 80, unitPrice: 80, startDate: "o", endDate: "o" }] } });
  }
  if (u.includes("leadconnector")) return ok({ ok: true, records: [], record: { id: "r" }, associations: [] });
  if (u.includes("/objects/")) return ok({ record: { id: "r" }, records: [] });
  return ok({ ok: true });
};

const worker = (await import("./src/index.js")).default;
const env = { WORKER_URL: "https://w.dev", TENANTS: kv, BOOKINGS: kv, ADMIN_SECRET: "admin123" };
await kv.put(LOC, JSON.stringify(tenant));

const post = async (path, body, snapshot) => {
  txUpdates = [];
  await kv.put(BOOKING, JSON.stringify(snapshot));
  const res = await worker.fetch({
    method: "POST", url: `https://w.dev${path}`,
    json: async () => ({ bookingId: BOOKING, ...body }),
    headers: hdr("admin123"),
  }, env);
  return { status: res.status, body: await res.json() };
};
const merged = () => Object.assign({}, ...txUpdates);

// ---- 1. a cancellation says it was cancelled ------------------------
{
  const out = await post("/cancel", { reason: "test" }, snap());
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));
  assert.strictEqual(merged().booking_status, "cancelled",
    "nothing recorded a cancellation on the record before this -- the dashboard could not show one");
  console.log("1) A cancellation writes booking_status: cancelled");
}

// ---- 2. charged in full is not refunded -----------------------------
// Mid-stay cancellation on the 100% tier with no cleaning fee: the guest is
// charged everything and gets nothing back. This wrote payment_status
// "refunded" anyway, because it wrote it whenever a ledger row existed -- and
// the retained cancellation charge IS a ledger row.
{
  await post("/cancel", { reason: "test" },
    snap({ charges: { rentTotal: 560, cleaningFee: 0, processingFee: 0, feePct: 0, grandTotal: 560 } }));
  const p = merged();
  assert.strictEqual(p.booking_status, "cancelled", "still cancelled");
  assert.ok(!("payment_status" in p),
    `nothing went back to the guest, so payment_status must be left alone -- got ${JSON.stringify(p.payment_status)}`);
  console.log("2) A cancellation that refunded nothing does not claim a refund");
}

// ---- 3. and one that did refund says so -----------------------------
// The other side of case 2, or "never write payment_status" would pass it.
// Cancelled five days out on the legacy policy: 20% charged, 80% back.
{
  await post("/cancel", { reason: "test" },
    snap({ stay: { checkIn: "2026-12-01", checkOut: "2026-12-08", nights: 7, nightlyRate: 80 } }));
  const p = merged();
  assert.strictEqual(p.booking_status, "cancelled");
  assert.strictEqual(p.payment_status, "refunded",
    "money did go back, so the payment status still has to say so");
  console.log("3) A cancellation that did refund still records the refund");
}

// ---- 4. a returned security deposit is not a refunded booking -------
// The bug this set out to fix. A stay ends, the inspection is clean, the
// deposit goes back -- and the BOOKING was marked refunded, although its rent
// was paid in full and kept. Two different moneys.
{
  const paid = snap({
    gateway: "paypal", // so a refund id comes back and the ledger rows are written
    securityDeposit: { total: 200, blocks: [], status: "held" },
    captures: { DEP: { gross: 200, captureId: "cap-dep", source: "paypal" } },
  });
  const out = await post("/deposit/refund", { amount: 200, reason: "clean" }, paid);
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));
  assert.deepStrictEqual(txUpdates, [],
    "the Transaction record must not be touched at all: nothing about the booking changed");
  console.log("4) Releasing a deposit after inspection leaves the booking's payment status alone");
}

// ---- 5. a reschedule records that it moved --------------------------
{
  const out = await post("/reschedule", { newCheckIn: "2026-12-01", newCheckOut: "2026-12-06" },
    snap({ stay: { checkIn: "2026-11-01", checkOut: "2026-11-06", nights: 5, nightlyRate: 80 },
           captures: { RENT: { gross: 465, captureId: "cap-1", source: "ghl_invoice" } } }));
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));
  const p = merged();
  assert.strictEqual(p.booking_status, "rescheduled",
    "a reschedule overwrote the dates in place and left no trace that it had");
  // The dates and the money still move -- this must not have displaced them.
  assert.strictEqual(p.checkin_date, "2026-12-01");
  assert.strictEqual(p.checkout_date, "2026-12-06");
  assert.ok(p.booking_total && typeof p.booking_total.value === "number",
    "and the total is still rewritten, which a previous fix put there");
  console.log("5) A reschedule records that it moved, without displacing the dates or the total");
}

// ---- 6. the two fields never carry each other's meaning -------------
// The whole point. Asserted across every write this file made rather than per
// case, so a future change that reaches for payment_status to mean "cancelled"
// fails here.
{
  const lifecycle = ["cancelled", "rescheduled", "confirmed"];
  const writes = [];
  await post("/cancel", { reason: "t" }, snap());
  writes.push(...txUpdates);
  await post("/cancel", { reason: "t" },
    snap({ charges: { rentTotal: 560, cleaningFee: 0, processingFee: 0, feePct: 0, grandTotal: 560 } }));
  writes.push(...txUpdates);
  await post("/reschedule", { newCheckIn: "2026-12-01", newCheckOut: "2026-12-06" },
    snap({ stay: { checkIn: "2026-11-01", checkOut: "2026-11-06", nights: 5, nightlyRate: 80 } }));
  writes.push(...txUpdates);

  assert.ok(writes.length >= 3, "there are writes to check");
  for (const p of writes) {
    if (p.payment_status) {
      assert.ok(!lifecycle.includes(p.payment_status),
        `payment_status carried a lifecycle value: ${p.payment_status}`);
      assert.ok(["paid", "pending", "refunded", "failed"].includes(p.payment_status),
        `payment_status must be one of the four the field defines, got ${p.payment_status}`);
    }
    if (p.booking_status) {
      assert.ok(lifecycle.includes(p.booking_status),
        `booking_status must be one the field defines, got ${p.booking_status}`);
    }
  }
  console.log("6) Neither field is ever written with the other's vocabulary");
}

console.log("\nPASS — the lifecycle is on booking_status and payment_status is about money again.");
