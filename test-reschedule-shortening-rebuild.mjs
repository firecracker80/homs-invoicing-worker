// Shortening a stay must rebuild the invoice too.
// Run: node test-reschedule-shortening-rebuild.mjs
//
// THE GAP, and it is mine. PR #168 rebuilds an invoice GHL regenerated when the
// dates moved -- but the rebuild was gated on
// `settlement.type === "invoice_balance_due"`, which is set in ONE place: the
// charge branch, when the guest owes more.
//
// A shortening falls to refund_partial_manual, admin_fee_only, or stays "none".
// Meanwhile updateGhlBookingDates runs unconditionally, and GHL regenerates a
// calendar-sourced invoice on any date change in either direction. So
// shortening a stay stripped the cleaning fee, every add-on and the processing
// fee off a live invoice, put nothing back, and said nothing -- because the
// reconcile warning that would have announced it lives inside the same skipped
// block.
//
// My #168 test only extended a stay. That is why the suite was green over this.
//
// This file models the regeneration rather than asserting on a flag: the GHL
// mock returns the FULL invoice until the calendar is moved and the STRIPPED
// invoice afterwards, exactly as the live account behaves. So the test fails for
// the real reason, not because a counter is zero.
import assert from "node:assert";

const LOC = "ZghxU8I60bEm39JUbtCm";

const tenant = {
  brandName: "Casa Bonita Vacation Rentals", currency: "USD", locale: "en-US",
  ownerPct: 0.85, processingFeePct: 0.06, defaultCleaningFee: 65,
  cleaningFeeRecipient: "manager", bookingWorkerEnabled: true,
  gateway: "ghl_invoice", invoiceStrategy: "enrich",
  adminSecret: "admin123", ghlPit: "pit", invoiceSenderUserId: "u1",
  tzOffsetHours: -4, checkInHour: 15,
  cancellationPolicy: {
    tiers: [{ underHours: 120, nights: 1, remainderPct: 0.5 }, { underHours: 336, chargePct: 0.25 }],
    checkedInChargePct: 1,
    grace: { withinHoursOfBooking: 24, minHoursBeforeCheckIn: 336 },
  },
};

const RATE = 200, CLEANING = 65, ADDON = 25, DEPOSIT = 350;
const OLD_NIGHTS = 7, NEW_NIGHTS = 5;
const NEW_RENT = RATE * NEW_NIGHTS;                                  // 1000
const EXPECTED_SUBTOTAL = NEW_RENT + CLEANING + ADDON + DEPOSIT;     // 1440
const EXPECTED_FEE = Math.round(0.06 * EXPECTED_SUBTOTAL * 100) / 100;  // 86.40
const EXPECTED_TOTAL = Math.round((EXPECTED_SUBTOTAL + EXPECTED_FEE) * 100) / 100;  // 1526.40

const STAY = { name: "Villa Azul", currency: "USD", productId: "p-stay", amount: RATE * OLD_NIGHTS, qty: 1 };
const LATE = { name: "Late Check-out", currency: "USD", productId: "p-late", amount: ADDON, qty: 1 };
const CLEAN = { name: "Cleaning Fee", currency: "USD", productId: "p-clean", amount: CLEANING, qty: 1 };
const DEP = { name: "Security Deposit", currency: "USD", productId: "p-dep", amount: DEPOSIT, qty: 1 };
const FEELINE = { name: "Processing fee", currency: "USD", amount: 110.4, qty: 1 };

// ---- harness ---------------------------------------------------------
const store = new Map();
const kv = {
  async get(k, o) { const v = store.get(k); return v == null ? null : (o?.type === "json" ? JSON.parse(v) : v); },
  async put(k, v) { store.set(k, v); },
};
let invoicePuts = [];
let calendarMoved = false;

global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const ok = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });

  // The regeneration. Once the booking's dates move, GHL rebuilds the invoice
  // from the booking's own products: the listing and the deposit, nothing else.
  if (u.includes("/calendars/bookings/manage/")) { calendarMoved = true; return ok({ ok: true }); }

  if (u.includes("/invoices/") && opts.method === "PUT") {
    const b = JSON.parse(opts.body);
    invoicePuts.push(b);
    const total = Math.round((b.invoiceItems || [])
      .reduce((s, i) => s + Number(i.amount || 0) * Number(i.qty || 1), 0) * 100) / 100;
    return ok({ invoice: { _id: "inv1", status: "paid", total, amountDue: 0 } });
  }
  if (u.includes("/invoices/inv1")) return ok({
    _id: "inv1", name: "Guest", currency: "USD", invoiceNumber: "000041", status: "paid",
    issueDate: "2026-11-01", dueDate: "2026-11-10", contactDetails: { id: "c1" },
    businessDetails: { name: "DEMO-HOMS" },
    invoiceItems: calendarMoved ? [STAY, DEP] : [STAY, LATE, CLEAN, DEP, FEELINE],
  });
  if (u.includes("backend.leadconnectorhq.com/calendars/bookings/details/")) return ok({
    serviceBooking: { contactId: "c1", appointmentTitle: "stay", deleted: false,
      services: [{ id: "s1", position: 0, name: "Villa Azul", price: RATE, unitPrice: RATE,
                   startDate: "o", endDate: "o" }] },
  });
  if (u.includes("leadconnector")) return ok({ ok: true, records: [], record: { id: "r" }, associations: [] });
  return ok({ ok: true });
};

const worker = (await import("./src/index.js")).default;
const env = { WORKER_URL: "https://w.dev", TENANTS: kv, BOOKINGS: kv, ADMIN_SECRET: "admin123" };
await kv.put(LOC, JSON.stringify(tenant));

const post = async (path, body, snapshot) => {
  invoicePuts = []; calendarMoved = false;
  await kv.put(snapshot.bookingId, JSON.stringify(snapshot));
  const res = await worker.fetch({
    method: "POST", url: `https://w.dev${path}`,
    json: async () => ({ bookingId: snapshot.bookingId, ...body }),
    headers: { get: (n) => (n === "X-Admin-Secret" ? "admin123" : null) },
  }, env);
  return { status: res.status, body: await res.json(), stored: await kv.get(snapshot.bookingId, { type: "json" }) };
};

const d = (t) => new Date(t).toISOString().slice(0, 10);
const CHECKIN = new Date(Date.now() + 30 * 86400000);

const settledSnapshot = (over = {}) => ({
  bookingId: "SH-1", locationId: LOC, ghlContactId: "c1", ghlBookingId: "b1",
  propertyCode: "Villa Azul",
  settled: true, gateway: "ghl_invoice", ghlInvoice: { invoiceId: "inv1" },
  guest: { name: "Guest", email: "g@example.com" },
  stay: {
    checkIn: d(CHECKIN),
    checkOut: d(CHECKIN.getTime() + OLD_NIGHTS * 86400000),
    nights: OLD_NIGHTS, nightlyRate: RATE,
  },
  charges: {
    rentTotal: RATE * OLD_NIGHTS, cleaningFee: CLEANING, processingFee: 110.4, feePct: 0.06,
    addOns: ADDON, addOnDetail: [{ name: "Late Check-out", amount: ADDON }],
    cleaningFeeSource: "ghl_native", cleaningFeeName: "Cleaning Fee",
    amountsSource: "ghl_invoice", grandTotal: 1950.4,
  },
  securityDeposit: { total: DEPOSIT, source: "ghl_native", passThrough: true, status: "held", blocks: [] },
  payout: { ownerPct: 0.85, basis: 1425, owner: 1211.25, manager: 213.75 },
  status: "confirmed", paid: true, ...over,
});

const shorten = () => ({
  newCheckIn: d(CHECKIN),
  newCheckOut: d(CHECKIN.getTime() + NEW_NIGHTS * 86400000),
});
const sumOf = (items) =>
  Math.round((items || []).reduce((s, i) => s + Number(i.amount || 0) * Number(i.qty || 1), 0) * 100) / 100;
const near = (a, b) => Math.abs(Number(a) - Number(b)) <= 0.01;

// ---- 1. a shortening rebuilds the invoice ----------------------------
{
  const out = await post("/reschedule", shorten(), settledSnapshot());
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));

  // Confirm we really are on the shortening path, or this proves nothing: if
  // the fixture accidentally charged more, the OLD code would have rebuilt too.
  const type = out.body.settlement?.type || out.stored.reschedules?.at(-1)?.settlement?.type;
  assert.notStrictEqual(type, "invoice_balance_due",
    `the fixture charged the guest instead of shortening (settlement ${type}) -- the test is wrong`);

  assert.ok(invoicePuts.length > 0,
    "the invoice was never repriced on a shortening -- GHL stripped the cleaning fee, " +
    "the add-on and the processing fee and nothing put them back");

  const sent = invoicePuts.at(-1).invoiceItems;
  const named = (re) => sent.filter((i) => re.test(String(i.name || "")));
  assert.strictEqual(named(/clean|limpieza/i).length, 1, "the cleaning fee was not restored");
  assert.strictEqual(named(/Late Check-out/).length, 1, "the add-on was not restored");
  assert.strictEqual(named(/process|procesamiento/i).length, 1, "there is not exactly one fee line");
  assert.strictEqual(named(/Security Deposit/).length, 1, "the native deposit was duplicated or lost");

  assert.ok(near(sumOf(sent), EXPECTED_TOTAL),
    `the rebuilt invoice totals ${sumOf(sent)}, expected ${EXPECTED_TOTAL}`);
  assert.ok(near(named(/process/i)[0].amount, EXPECTED_FEE),
    `fee ${named(/process/i)[0].amount}, expected 6% of ${EXPECTED_SUBTOTAL} = ${EXPECTED_FEE}`);
  console.log(`1) Shortening rebuilds the invoice: ${sumOf(sent)} with the fee on the whole bill`);
}

// ---- 2. the reconcile check runs on a shortening too -----------------
// It lives in the same block, so the old gate silenced it as well. A shortening
// could go wrong with nothing in the log at all.
{
  const out = await post("/reschedule", shorten(), settledSnapshot({ bookingId: "SH-2" }));
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));
  const last = out.stored.reschedules.at(-1);
  assert.notStrictEqual(last.settlement.reconciled, undefined,
    "no reconcile verdict on a shortening -- the invoice could be wrong and nothing would say so");
  assert.strictEqual(last.settlement.reconciled, true);
  assert.ok(near(last.settlement.expectedTotal, EXPECTED_TOTAL));
  assert.deepStrictEqual(last.settlement.restoredLines.slice().sort(),
    ["Cleaning Fee", "Late Check-out"],
    "the receipt should name what GHL had stripped");
  console.log(`2) The reconcile verdict is recorded on a shortening: reconciled=${last.settlement.reconciled}`);
}

// ---- 3. an extension still works -------------------------------------
// The equivalence guard. Widening the gate must not break the case #168 fixed.
{
  const ext = {
    newCheckIn: d(CHECKIN),
    newCheckOut: d(CHECKIN.getTime() + 8 * 86400000),
  };
  const out = await post("/reschedule", ext, settledSnapshot({ bookingId: "SH-3" }));
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));
  assert.ok(invoicePuts.length > 0, "an extension stopped repricing");
  const sent = invoicePuts.at(-1).invoiceItems;
  const expSub = RATE * 8 + CLEANING + ADDON + DEPOSIT;
  assert.ok(near(sumOf(sent), Math.round(expSub * 1.06 * 100) / 100),
    `extension totals ${sumOf(sent)}, expected ${Math.round(expSub * 1.06 * 100) / 100}`);
  console.log(`3) An extension still rebuilds correctly: ${sumOf(sent)}`);
}

// ---- 4. a booking with no GHL invoice is left alone ------------------
// The new gate is "is there an invoice", so it must not invent one.
{
  const noInv = settledSnapshot({ bookingId: "SH-4" });
  delete noInv.ghlInvoice;
  const out = await post("/reschedule", shorten(), noInv);
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));
  assert.strictEqual(invoicePuts.length, 0,
    "a booking with no invoice had one repriced anyway");
  console.log("4) A booking with no GHL invoice is not repriced");
}

console.log("\nPASS — a shortening rebuilds and reconciles like an extension, an extension still " +
  "works, and a booking without an invoice is left alone.");
