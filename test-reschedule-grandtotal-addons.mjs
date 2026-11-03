// grandTotal must include add-ons after a reschedule.
// Run: node test-reschedule-grandtotal-addons.mjs
//
// THE BUG. Three sites in reschedule.js compute
//   rent + cleaningFee + processingFee + deposit
// and never add the add-ons. snapshot.charges.grandTotal is echoed in the
// reschedule response and GHL maps it into guest-facing messages, so a
// rescheduled booking carrying add-ons quotes a total short by the add-on
// amount. The invoice itself and amountDue are correct; only the figure the
// guest is TOLD is wrong, which is the harder kind to notice.
//
// Measured live on DEMO-HOMS 2026-11-03 20:48:53Z, booking 93pEdosO7S4oAoDOHJhW
// extended 7-13 Dec to 7-14 Dec: invoice 1950.40, snapshot grandTotal 1925.40 --
// short by exactly the 25.00 Late Check-out.
//
// Pre-existing, from 970815c. PR #168 did not cause it; it made it reliably
// VISIBLE, by putting the stripped add-on line back.
//
// Nothing in the suite caught this because no reschedule test asserted
// grandTotal against a booking carrying an add-on. That is the gap this file
// closes, so it checks the arithmetic rather than that a field exists.
import assert from "node:assert";

const LOC = "ZghxU8I60bEm39JUbtCm";

// Casa Bonita's real config, matching the other reschedule tests.
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

// 1400 rent + 65 cleaning + 25 add-on + 350 deposit = 1840, fee 6% = 110.40.
const RENT = 1400, CLEANING = 65, ADDON = 25, DEPOSIT = 350;
const INVOICE_SUBTOTAL = RENT + CLEANING + ADDON + DEPOSIT;   // 1840
const FEE = Math.round(0.06 * INVOICE_SUBTOTAL * 100) / 100;  // 110.40
const INVOICE_TOTAL = Math.round((INVOICE_SUBTOTAL + FEE) * 100) / 100;  // 1950.40

// Whether the INVOICE carries the add-on line. It has to track the snapshot:
// a fixture where the snapshot has no add-on but the invoice still bills one is
// not a real state, and an expected value derived from it means nothing.
let invoiceHasAddOn = true;

const nativeItems = () => ([
  { name: "Villa Azul", currency: "USD", productId: "p-stay", amount: RENT, qty: 1 },
  ...(invoiceHasAddOn ? [{ name: "Late Check-out", currency: "USD", productId: "p-late", amount: ADDON, qty: 1 }] : []),
  { name: "Cleaning Fee", currency: "USD", productId: "p-clean", amount: CLEANING, qty: 1 },
  { name: "Security Deposit", currency: "USD", productId: "p-dep", amount: DEPOSIT, qty: 1 },
]);

// ---- harness ---------------------------------------------------------
const store = new Map();
const kv = {
  async get(k, o) { const v = store.get(k); return v == null ? null : (o?.type === "json" ? JSON.parse(v) : v); },
  async put(k, v) { store.set(k, v); },
};
let invoicePuts = [];
let invoiceStatus = "paid";
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const ok = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
  if (u.includes("/invoices/") && opts.method === "PUT") {
    invoicePuts.push(JSON.parse(opts.body));
    const b = JSON.parse(opts.body);
    const total = Math.round((b.invoiceItems || [])
      .reduce((s, i) => s + Number(i.amount || 0) * Number(i.qty || 1), 0) * 100) / 100;
    return ok({ invoice: { _id: "inv1", status: invoiceStatus, total, amountDue: total } });
  }
  if (u.includes("/invoices/inv1")) return ok({
    _id: "inv1", name: "Guest", currency: "USD", invoiceNumber: "000040", status: invoiceStatus,
    issueDate: "2026-11-01", dueDate: "2026-11-10",
    invoiceItems: nativeItems(), businessDetails: { name: "DEMO-HOMS" },
    contactDetails: { id: "c1" },
  });
  if (u.includes("backend.leadconnectorhq.com/calendars/bookings/details/")) return ok({
    serviceBooking: { contactId: "c1", appointmentTitle: "stay", deleted: false,
      services: [{ id: "s1", position: 0, name: "Villa Azul", price: 200, unitPrice: 200,
                   startDate: "o", endDate: "o" }] },
  });
  if (u.includes("leadconnector")) return ok({ ok: true, records: [], record: { id: "r" }, associations: [] });
  return ok({ ok: true });
};

const worker = (await import("./src/index.js")).default;
const env = { WORKER_URL: "https://w.dev", TENANTS: kv, BOOKINGS: kv, ADMIN_SECRET: "admin123" };
await kv.put(LOC, JSON.stringify(tenant));

const post = async (path, body, snapshot) => {
  invoicePuts = [];
  await kv.put(snapshot.bookingId, JSON.stringify(snapshot));
  const res = await worker.fetch({
    method: "POST", url: `https://w.dev${path}`,
    json: async () => ({ bookingId: snapshot.bookingId, ...body }),
    headers: { get: (n) => (n === "X-Admin-Secret" ? "admin123" : null) },
  }, env);
  return { status: res.status, body: await res.json(), stored: await kv.get(snapshot.bookingId, { type: "json" }) };
};

const d = (t) => new Date(t).toISOString().slice(0, 10);
const snapshotWith = (over = {}) => {
  const checkIn = new Date(Date.now() + 30 * 86400000);
  return {
    bookingId: "GT-1", locationId: LOC, ghlContactId: "c1", ghlBookingId: "b1",
    propertyCode: "Villa Azul",
    // settled + ghlInvoice.invoiceId is what puts this down the paid path, where
    // sites 658 and 699 live. snapshot.paid is not the branch key.
    settled: true, gateway: "ghl_invoice", ghlInvoice: { invoiceId: "inv1" },
    guest: { name: "Guest", email: "g@example.com" },
    stay: { checkIn: d(checkIn), checkOut: d(checkIn.getTime() + 6 * 86400000), nights: 6, nightlyRate: 200 },
    charges: {
      rentTotal: 1200, cleaningFee: CLEANING, processingFee: 99.3, feePct: 0.06,
      // The add-on. This is the whole point of the file: a booking with one.
      addOns: ADDON, addOnDetail: [{ name: "Late Check-out", amount: ADDON }],
      cleaningFeeSource: "ghl_native", cleaningFeeName: "Cleaning Fee",
      amountsSource: "ghl_invoice", grandTotal: 1737.3,
    },
    securityDeposit: { total: DEPOSIT, source: "ghl_native", passThrough: true, status: "held", blocks: [] },
    payout: { ownerPct: 0.85, basis: 1240, owner: 1054, manager: 186 },
    status: "confirmed", paid: true, ...over,
  };
};

// The new stay: 7 nights at 200 = 1400, matching the live case's new rent.
const newDates = () => {
  const ci = new Date(Date.now() + 30 * 86400000);
  return { newCheckIn: d(ci), newCheckOut: d(ci.getTime() + 7 * 86400000) };
};

const near = (a, b) => Math.abs(Number(a) - Number(b)) <= 0.01;

// ---- 1. the main path: grandTotal must equal the invoice -------------
{
  const out = await post("/reschedule", newDates(), snapshotWith());
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));

  const gt = out.stored.charges.grandTotal;
  const put = invoicePuts.at(-1);
  assert.ok(put, "the invoice was repriced");
  const invoiceTotal = Math.round((put.invoiceItems || [])
    .reduce((s, i) => s + Number(i.amount || 0) * Number(i.qty || 1), 0) * 100) / 100;

  assert.ok(near(invoiceTotal, INVOICE_TOTAL),
    `the invoice should total ${INVOICE_TOTAL}, got ${invoiceTotal} -- the fixture is wrong, not the code`);

  // THE ASSERTION. What the guest is told must equal what the guest is billed.
  assert.ok(near(gt, invoiceTotal),
    `grandTotal ${gt} does not match the invoice total ${invoiceTotal} -- the guest is quoted ` +
    `${Math.round((invoiceTotal - gt) * 100) / 100} less than they are billed, which is the ${ADDON} add-on`);
  assert.ok(near(gt, INVOICE_TOTAL), `grandTotal ${gt} should be ${INVOICE_TOTAL}`);
  console.log(`1) After a reschedule, grandTotal ${gt} equals the invoice total ${invoiceTotal}`);
}

// ---- 2. the add-on is what is missing, not something else ------------
// Guards against a fix that makes the numbers line up for the wrong reason: if
// grandTotal were patched by adding a constant, this would still pass, so the
// check is that REMOVING the add-on moves grandTotal by exactly the add-on.
{
  const noAddOn = snapshotWith();
  noAddOn.bookingId = "GT-2";
  noAddOn.charges.addOns = 0;
  noAddOn.charges.addOnDetail = [];
  invoiceHasAddOn = false;          // the invoice must agree with the snapshot
  const out = await post("/reschedule", newDates(), noAddOn);
  invoiceHasAddOn = true;
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));

  const gt = out.stored.charges.grandTotal;
  const expected = Math.round((RENT + CLEANING + DEPOSIT) * 1.06 * 100) / 100;
  assert.ok(near(gt, expected),
    `without an add-on grandTotal should be ${expected}, got ${gt}`);
  console.log(`2) With no add-on, grandTotal is ${gt} -- the difference is the add-on, nothing else`);
}

// ---- 3. the legacy petFee counts too --------------------------------
// Older snapshots carry charges.petFee rather than charges.addOns. earnedAddOns
// in ledger.js exists precisely for that, which is why the fix uses it instead
// of reading charges.addOns directly -- a snapshot mid-migration would
// otherwise be short by its pet fee and nothing would say so.
{
  const legacy = snapshotWith();
  legacy.bookingId = "GT-3";
  legacy.charges.addOns = 0;
  legacy.charges.addOnDetail = [];
  legacy.charges.petFee = ADDON;
  const out = await post("/reschedule", newDates(), legacy);
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));

  const gt = out.stored.charges.grandTotal;
  assert.ok(near(gt, INVOICE_TOTAL),
    `a snapshot carrying the legacy petFee quoted ${gt} instead of ${INVOICE_TOTAL} -- ` +
    `reading charges.addOns directly misses petFee`);
  console.log(`3) A legacy petFee snapshot also quotes ${gt}, not ${INVOICE_TOTAL - ADDON}`);
}

console.log("\nPASS — a rescheduled booking quotes the guest the same total it bills them, " +
  "add-ons included, whether they sit in charges.addOns or the legacy petFee.");
