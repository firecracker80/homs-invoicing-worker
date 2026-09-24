// Late cancellations: pricing one at the moment it happened, and reversing the
// revenue on a booking that was paid by GHL invoice (no gateway capture).
// Mock KV + fetch only. Run: node test-cancel-backfill.js
//
// Replays the live DEMO-HOMS case that exposed both gaps: booking
// HN6Yg0vVM9Z4H8rBhli0, cancelled in GHL on 21 Sep, which never reached the
// Worker because the "Reservation Cancelled" workflow was parked at a wait step.
import assert from "node:assert";

const LOC = "ZghxU8I60bEm39JUbtCm";
const BOOKING = "HN6Yg0vVM9Z4H8rBhli0";

const store = new Map();
const kv = {
  async get(k, o) { const v = store.get(k); return v == null ? null : (o?.type === "json" ? JSON.parse(v) : v); },
  async put(k, v) { store.set(k, v); },
};

// DEMO-HOMS' own policy, copied from its live TENANTS entry (read 2026-09-23):
// 24h 100%, 14d 20%, 3650d 10%, already checked in 100%.
const tenant = {
  brandName: "Casa Bonita Vacation Rentals", currency: "USD", ownerPct: 0.85, adminSecret: "admin-secret",
  cancellationPolicy: {
    tiers: [
      { underHours: 24, chargePct: 1 },
      { underHours: 336, chargePct: 0.2 },
      { underHours: 87600, chargePct: 0.1 },
    ],
    checkedInChargePct: 1,
  },
  ghlCancellationUrl: "https://services.leadconnectorhq.com/hooks/cancel",
  ghlPit: "pit", tzOffsetHours: -4, checkInHour: 15,
};

// Paid through a GHL invoice: settled, but no captureId -- refunds are manual.
const paidSnapshot = () => ({
  bookingId: BOOKING, locationId: LOC, ghlContactId: "c1", propertyCode: "Arpel 07",
  guest: { name: "Test Booking E2E Two", email: "g@example.com" },
  stay: { checkIn: "2026-09-24", checkOut: "2026-09-25", nights: 1, nightlyRate: 135 },
  charges: { rentTotal: 135, cleaningFee: 65, processingFee: 12, grandTotal: 212 },
  securityDeposit: { total: 0, blocks: [], status: "pending_payment" },
  payout: { basis: 135, ownerPct: 0.85, owner: 114.75, manager: 20.25, cleaningFeeTo: "manager", status: "paid" },
  gateway: "ghl_invoice", settled: true,
  captures: { RENT: { gross: 212, source: "ghl_invoice", invoiceNumber: "000006", gatewayTransactionId: "ghl-tx-1" } },
  ghlInvoice: { invoiceId: "inv1", status: "paid" },
});

let ledgerRows = [];
let notified = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const res = (obj, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(obj), json: async () => obj });
  if (u.includes("/hooks/")) { notified.push(JSON.parse(opts.body || "{}")); return res({}); }
  if (u.includes("/objects/") && opts.method === "POST") { ledgerRows.push(JSON.parse(opts.body)); return res({ record: { id: "r" + ledgerRows.length } }); }
  return res({ records: [], record: { id: "r" }, associations: [], id: "r" });
};
globalThis.Response = class {
  constructor(b, i = {}) { this.body = b; this.status = i.status || 200; }
  async json() { return JSON.parse(this.body); }
};

// D1 keeps the signed amounts -- the GHL mirror stores magnitudes, because
// MONETORY fields reject negatives. The ledger is what the books are read from,
// so that is what these assertions check.
// Column order: location_id, booking_id, invoice_number, invoice_id, recipient,
// recipient_name, category, entry_type, amount_minor, currency, description,
// source, reference, created_at.
let d1Rows = [];
const LEDGER_DB = {
  prepare: () => ({ bind: (...args) => ({ args }) }),
  batch: async (stmts) => { for (const st of stmts) d1Rows.push(st.args); return []; },
};
const ledger = () => d1Rows.map((a) => ({ recipient: a[4], category: a[6], entry_type: a[7], amount: a[8] / 100, reference: a[12] }));

const { handleCancel, resolveAsOf, calcCancellation, MANUAL_REFUND_REF } = await import("./src/cancellation.js");
const env = { TENANTS: kv, BOOKINGS: kv, LEDGER_DB };
await kv.put(LOC, JSON.stringify(tenant));

const post = async (body) => {
  const h = new Map([["X-Admin-Secret", body.secret ?? "admin-secret"]]);
  const r = await handleCancel({
    method: "POST", url: "https://w.dev/cancel",
    json: async () => ({ locationId: LOC, bookingId: BOOKING, ...body }),
    headers: { get: (k) => h.get(k) ?? null },
  }, env);
  return { status: r.status, body: await r.json() };
};
const round2 = (n) => Math.round(n * 100) / 100;
// Seeded with what settlement booked for this booking, so the assertions below
// net the cancellation against the real income rather than against nothing.
const SETTLED_ROWS = [
  ["owner", "income", "rent_split_owner", 11475],
  ["manager", "income", "rent_split_manager", 2025],
  ["manager", "income", "cleaning_fee", 6500],
];
const reset = async (snap = paidSnapshot(), withSettlement = false) => {
  ledgerRows = []; notified = []; d1Rows = [];
  if (withSettlement) for (const [rec, cat, type, minor] of SETTLED_ROWS) d1Rows.push([LOC, BOOKING, null, null, rec, null, cat, type, minor, "USD", "", "payment_confirmed", type, ""]);
  await kv.put(BOOKING, JSON.stringify(snap));
};

// ---- 1. asOf bounds -----------------------------------------------------------
{
  const now = Date.parse("2026-09-23T21:40:00Z");
  assert.equal(resolveAsOf(undefined, now).ms, now, "no asOf -> now");
  assert.equal(resolveAsOf(undefined, now).backfilled, false);
  assert.equal(resolveAsOf("2026-09-21T12:47:00Z", now).ms, Date.parse("2026-09-21T12:47:00Z"));
  assert.equal(resolveAsOf("2026-09-21T12:47:00Z", now).backfilled, true);
  assert.match(resolveAsOf("2026-09-24T00:00:00Z", now).error, /future/, "a cancellation cannot be dated forward");
  assert.match(resolveAsOf("2020-01-01T00:00:00Z", now).error, /year/);
  assert.match(resolveAsOf("not a date", now).error, /valid date/);
  console.log("1) asOf: absent -> now; past accepted; future, ancient and unparseable rejected");
}

// ---- 2. the tier is the one in force when it happened -------------------------
{
  // Cancelled 21 Sep, ~82h before a 24 Sep 3PM check-in -> the 14-day tier, 20%.
  const atCancellation = calcCancellation(paidSnapshot(), Date.parse("2026-09-21T12:47:00Z"), tenant);
  // Imported 23 Sep, ~21h out -> the under-24h tier, 100%. Same booking.
  const atImport = calcCancellation(paidSnapshot(), Date.parse("2026-09-23T21:40:00Z"), tenant);
  assert.equal(atCancellation.chargePct, 0.2);
  assert.equal(atImport.chargePct, 1);
  assert.deepEqual([atCancellation.charge, atCancellation.rentRefund], [27, 108]);
  assert.deepEqual([atImport.charge, atImport.rentRefund], [135, 0]);
  console.log("2) Same booking: 20% retained at the moment it was cancelled, 100% if priced on import day — $108 of guest money");
}

// ---- 3. backfilling uses the real date, and says it was backfilled ------------
{
  await reset(paidSnapshot(), true);
  const out = await post({ asOf: "2026-09-21T12:47:00Z", reason: "Cancelled in GHL 21 Sep; workflow was parked" });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  const snap = JSON.parse(store.get(BOOKING));
  assert.equal(snap.cancelled, true);
  assert.equal(snap.cancellation.at, "2026-09-21T12:47:00.000Z", "dated when it happened");
  assert.equal(snap.cancellation.backfilled, true);
  assert.ok(snap.cancellation.recordedAt > snap.cancellation.at, "and says when we actually learned");
  assert.equal(snap.cancellation.tier, "under_336h");
  assert.equal(snap.cancellation.charge, 27);
  console.log("3) Backfill priced at the real cancellation moment, flagged backfilled with recordedAt");
}

// ---- 4. an invoice-paid booking still reverses its revenue --------------------
{
  const rows = ledger();
  const amounts = rows.map((r) => r.amount);
  const refs = rows.map((r) => r.reference);

  assert.ok(rows.length > 0, "cancelling a paid booking writes ledger rows even with no gateway capture");
  assert.ok(ledgerRows.length > 0, "and mirrors them into GHL");
  assert.ok(amounts.filter((a) => a < 0).length >= 3, "the original income is reversed: " + JSON.stringify(rows));
  // 108 rent refund split 85/15, plus the 65 cleaning fee, all reversed.
  assert.ok(amounts.some((a) => Math.abs(a + 114.75) < 0.01), "the owner's booked income is reversed in FULL: " + JSON.stringify(amounts));
  assert.ok(amounts.some((a) => Math.abs(a + 20.25) < 0.01), "and the manager's");
  assert.ok(amounts.some((a) => Math.abs(a + 65) < 0.01), "cleaning fee");
  // ...and the 20% retained is booked as income, split the same way.
  assert.ok(amounts.some((a) => Math.abs(a - 22.95) < 0.01), "owner share of the retained charge");
  assert.ok(amounts.some((a) => Math.abs(a - 4.05) < 0.01), "manager share of the retained charge");
  assert.ok(refs.some((r) => r === MANUAL_REFUND_REF), "the rows say the refund still has to be issued by hand");
  const net = amounts.reduce((s, a) => s + a, 0);
  assert.ok(Math.abs(net - (114.75 + 20.25 + 65 - 114.75 - 20.25 - 65 + 22.95 + 4.05)) < 0.01, "net: " + net);
  console.log("4) Invoice-paid booking: revenue reversed and the retained 20% booked, flagged manual_refund_pending");
}

// ---- 4b. what each party is left with, which is the only number that matters --
{
  // Settlement booked owner 114.75 + manager 20.25 + cleaning 65 (manager)
  // + processing fee 12 (platform). After a 20% cancellation the only income
  // anyone keeps is the $27 retained, split 85/15, plus the non-refundable fee.
  const net = {};
  for (const r of ledger()) net[r.recipient] = round2((net[r.recipient] || 0) + r.amount);
  assert.equal(net.owner, 22.95, "owner keeps 85% of the 27 retained, not a penny more: " + JSON.stringify(net));
  assert.equal(net.manager, 4.05, "manager keeps 15% of it: " + JSON.stringify(net));
  assert.equal(net.platform ?? 0, 0, "the processing fee was booked at settlement, not here");
  assert.equal(round2(net.owner + net.manager), 27, "and the two shares are exactly the retained charge");
  console.log("4b) Nets out to exactly the retained charge — reversing in full then booking the charge cannot double-count");
}

// ---- 5. the manual refund is reported, not silently swallowed ----------------
{
  const snap = JSON.parse(store.get(BOOKING));
  const failures = snap.cancellation.refundFailures || [];
  assert.ok(failures.some((f) => f.type === "rent_refund_needed_manual" && Math.abs(f.amount - 173) < 0.01),
    "173 owed back to the guest, by hand: " + JSON.stringify(failures));
  assert.equal(notified.length, 1, "GHL is told once");
  assert.equal(notified[0].chargeTotal, "27.00");
  assert.equal(notified[0].refundTotal, "173.00");
  console.log("5) $173 owed to the guest is recorded on the booking and sent to GHL, not dropped");
}

// ---- 6. an unpaid booking voids cleanly, and dates itself too ----------------
{
  const unpaid = { ...paidSnapshot(), settled: false, captures: undefined, charges: { rentTotal: 465, cleaningFee: 65, processingFee: 0, grandTotal: 530 } };
  await reset(unpaid);
  const out = await post({ asOf: "2026-09-21T12:47:00Z", reason: "Expired unpaid, cancelled in GHL" });
  assert.equal(out.body.cancelled, true);
  assert.equal(out.body.paid, false);
  assert.equal(out.body.refunds, null);
  const snap = JSON.parse(store.get(BOOKING));
  assert.equal(snap.cancellation.tier, "unpaid_void");
  assert.equal(snap.cancellation.at, "2026-09-21T12:47:00.000Z");
  assert.equal(snap.cancellation.backfilled, true);
  assert.equal(ledgerRows.length, 0, "no money moved, so nothing is booked -- no phantom income");
  assert.equal(notified[0].paid, false);
  console.log("6) Unpaid booking voids with no ledger rows at all, dated when it was cancelled");
}

// ---- 7. gates ---------------------------------------------------------------
{
  await reset();
  assert.equal((await post({ secret: "wrong" })).status, 401);
  await reset();
  assert.equal((await post({ asOf: "2027-01-01T00:00:00Z" })).status, 400, "no forward-dating");
  assert.equal(JSON.parse(store.get(BOOKING)).cancelled, undefined, "a rejected asOf changes nothing");
  await reset();
  await post({ asOf: "2026-09-21T12:47:00Z" });
  const second = await post({ asOf: "2026-09-21T12:47:00Z" });
  assert.equal(second.body.alreadyCancelled, true, "backfilling twice cannot double-reverse the books");
  console.log("7) Gated: admin secret, no forward-dating, and a second backfill is a no-op");
}

console.log("\nPASS — late cancellations price at the moment they happened, and invoice-paid bookings stop counting as revenue.");
