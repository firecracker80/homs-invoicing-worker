// A GHL-native security deposit is money the Worker has to know about.
// Run: node test-native-deposit.mjs
//
// Until 2026-10-16 it did not. Only a "tiered_legacy" tenant (Luminara) has the
// Worker size a deposit and bill it; every other account uses GHL's own native
// Security Deposit, which is a line on the draft before the Worker sees it. The
// Worker's deposit engine returns 0 for such a tenant, securityDeposit.total was
// written as 0, and so nothing recorded that the guest had paid a deposit at all.
//
// The live case this was found on -- Villa Azul, DEMO-HOMS, invoice INV-000035,
// cancelled 2026-10-16:
//
//   billed    1200 rent + 15 + 25 add-ons + 65 cleaning + 350 deposit + 99.30 fee
//   paid      1,754.30   (one capture: GHL's invoice covers the deposit too)
//   refunded     585.00   rent 520 + cleaning 65
//   retained     819.30   charge 720 + fee 99.30
//   ------------------
//   unaccounted  350.00   <- the deposit, in neither column
//
// Two more consequences of the same blind spot:
//   - the cancellation marked securityDeposit "refunded" with refundedAmount 0,
//   - /deposit/refund answered "No deposit on this booking" (400) to the form an
//     account holder submits to find out what is owed back -- on every enrich
//     account, for every booking, cancelled or not.
//
// The fix reads the amount off the invoice. Nothing about enrichment's
// arithmetic moves, because a native deposit line is already inside
// nativeSubtotal and so was always in the fee basis and the grand total. What
// changes is that the figure is recorded -- and that opens two seams this file
// guards, because the Worker must not then bill the deposit a second time.
import assert from "node:assert";
import {
  enrichAndSendInvoice, buildAppendItems, nativeDepositTotal,
  workerBillsDeposit, DEPOSIT_GHL_NATIVE, DEPOSIT_WORKER,
} from "./src/ghl-invoice.js";

global.Response = class { constructor(b, i = {}) { this.body = b; this.status = i.status || 200; } async json() { return JSON.parse(this.body); } };
global.btoa = (s) => Buffer.from(s).toString("base64");

const LOC = "ZghxU8I60bEm39JUbtCm";
const PAID = 1754.3;
const isDepositLine = (i) => /deposit|dep(ó|o)sito|garant(í|i)a/i.test(String(i?.name || ""));

// Casa Bonita's real configuration, read from the tenant record 2026-10-16.
const casaBonita = {
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

// Exactly what GHL's rental calendar billed on INV-000035, in order. The first
// line is the stay by the convention repriceFromInvoice reads it with.
const nativeItems = () => ([
  { name: "Villa Azul", currency: "USD", productId: "6abdc235cf48ea76b8fb01ff", amount: 1200, qty: 1 },
  { name: "Early Check-In", currency: "USD", productId: "6acea589b2f2c5f63334c530", amount: 15, qty: 1 },
  { name: "Late Check-out", currency: "USD", productId: "6acea57715a76e3832119467", amount: 25, qty: 1 },
  { name: "Cleaning Fee", currency: "USD", productId: "6aa9c762a0a9f461807d6a97", amount: 65, qty: 1 },
  { name: "Security Deposit", currency: "USD", productId: "6aab19d6ad863d21e900988d", amount: 350, qty: 1 },
]);

const freshSnapshot = () => ({
  bookingId: "ND-1", locationId: LOC, ghlContactId: "c1", propertyCode: "Villa Azul",
  createdAt: "2026-09-20T00:00:00.000Z",
  guest: { name: "Native Deposit", email: "g@example.com" },
  stay: { checkIn: "2026-10-18", checkOut: "2026-10-24", nights: 6, nightlyRate: 200 },
  charges: { rentTotal: 1200, cleaningFee: 65, processingFee: 0, feePct: 0.06, grandTotal: 1265 },
  securityDeposit: { total: 0, blocks: [], status: "pending_payment", refundedAmount: null, claimAmount: null },
  payout: { basis: 1200, ownerPct: 0.85, owner: 1020, manager: 180, cleaningFeeTo: "manager" },
  gateway: "ghl_invoice",
});

// ---- 1. the amount is recorded -------------------------------------------
// The whole fix in one assertion. Everything after it is a consequence.
let put = null;
const enrichFetch = async (url, opts = {}) => {
  const ok = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o), json: async () => o });
  if (opts.method === "PUT") { put = JSON.parse(opts.body); return ok({}); }
  if (String(url).includes("/send")) return ok({ invoice: { _id: "inv1" } });
  if (String(url).includes("/invoices/inv1")) return ok({
    _id: "inv1", name: "Yajahira Velazquez", currency: "USD", invoiceNumber: "000035",
    issueDate: "2026-10-16T04:00:00.000Z", dueDate: "2026-10-27T03:59:59.999Z",
    invoiceItems: nativeItems(), businessDetails: { name: "DEMO-HOMS" },
  });
  return ok({});
};

const snap1 = freshSnapshot();
await enrichAndSendInvoice({
  env: {}, locationId: LOC, invoiceId: "inv1", snapshot: snap1, tenant: casaBonita,
  userId: "u1", contact: { id: "c1", name: "Native Deposit", email: "g@example.com" },
}, enrichFetch);

assert.strictEqual(snap1.securityDeposit.total, 350,
  "the guest paid a 350 deposit on this invoice -- recording 0 is what left it in neither column on cancellation");
assert.strictEqual(snap1.securityDeposit.source, DEPOSIT_GHL_NATIVE,
  "and it has to be marked as GHL's, or the Worker will bill it again");
console.log("1) A native Security Deposit line is recorded on the snapshot as GHL's");

// ---- 2. and nothing else about the invoice moves --------------------------
// The claim that makes this fix safe to deploy against live unpaid invoices.
// A native deposit line was ALREADY inside nativeSubtotal, so it was always in
// the fee basis and the grand total; only the record of it is new. If any of
// these moved, every unpaid invoice would be repriced by a deploy.
assert.strictEqual(snap1.charges.rentTotal, 1200, "rent is the stay line");
assert.strictEqual(snap1.charges.addOns, 40, "add-ons are the non-cleaning, non-pass-through lines");
assert.strictEqual(snap1.charges.processingFee, 99.3, "6% of the whole 1655 invoice, deposit included -- the live figure");
assert.strictEqual(snap1.charges.grandTotal, PAID, "and the guest is asked for exactly what INV-000035 asked for");
assert.strictEqual(snap1.payout.basis, 1240,
  "the deposit is the guest's own money and must stay out of the commission basis");
console.log("2) Recording it changes no figure on the invoice: fee 99.30, total 1,754.30, basis 1,240");

// ---- 3. the Worker does not bill it a second time ------------------------
// First seam. buildAppendItems appends DEPOSIT_LINE whenever
// securityDeposit.total > 0, which was unreachable while the total was always 0
// on a native-deposit account. The moment step 1 started recording 350, it
// became reachable -- and would have put a second 350 line on the invoice
// beside GHL's own.
const depositLines = (put.invoiceItems || []).filter(isDepositLine);
assert.strictEqual(depositLines.length, 1,
  `the invoice must carry exactly ONE deposit line -- GHL's own -- got ${JSON.stringify(depositLines.map((i) => i.name))}`);
assert.strictEqual(depositLines[0].name, "Security Deposit", "and it is GHL's line, untouched");
assert.deepStrictEqual(buildAppendItems(snap1, casaBonita).filter(isDepositLine), [],
  "buildAppendItems must append nothing deposit-shaped for a native deposit");
console.log("3) The Worker appends no deposit line of its own beside GHL's");

// ---- 4. a Worker-billed deposit still works ------------------------------
// The equivalence guard. Luminara pays for this fix if the native branch
// swallowed its case: its deposit IS the Worker's to size and to bill, and
// dropping its line would stop it collecting one at all.
const luminara = { ...casaBonita, locale: "es-ES", depositPolicy: "tiered_legacy", deposit: { rule: "tiered" } };
const snapL = freshSnapshot();
let putL = null;
await enrichAndSendInvoice({
  env: {}, locationId: LOC, invoiceId: "inv1", snapshot: snapL, tenant: luminara,
  userId: "u1", contact: { id: "c1", name: "L", email: "g@example.com" },
}, async (url, opts = {}) => {
  const ok = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o), json: async () => o });
  if (opts.method === "PUT") { putL = JSON.parse(opts.body); return ok({}); }
  if (String(url).includes("/send")) return ok({ invoice: { _id: "inv1" } });
  if (String(url).includes("/invoices/inv1")) return ok({
    _id: "inv1", name: "L", currency: "USD", invoiceNumber: "000036",
    issueDate: "2026-10-16T04:00:00.000Z", dueDate: "2026-10-27T03:59:59.999Z",
    // No native deposit line: this account does not use GHL's.
    invoiceItems: nativeItems().filter((i) => !isDepositLine(i)),
    businessDetails: { name: "Luminara" },
  });
  return ok({});
});
assert.strictEqual(snapL.securityDeposit.source, DEPOSIT_WORKER,
  "a tenant whose own engine sizes the deposit still owns it");
assert.ok(snapL.securityDeposit.total > 0, "and still has one");
assert.ok(snapL.securityDeposit.blocks.length > 0, "with its blocks, which only the engine produces");
assert.strictEqual((putL.invoiceItems || []).filter(isDepositLine).length, 1,
  "and the Worker still bills it, since nothing else will");
assert.ok(workerBillsDeposit(snapL), "workerBillsDeposit separates the two arrangements");
assert.ok(!workerBillsDeposit(snap1), "and does not confuse them");
console.log(`4) A tiered_legacy tenant still sizes (${snapL.securityDeposit.total}) and bills its own deposit`);

// ---- 5. nativeDepositTotal never reads the stay as a deposit -------------
// Index 0 is the stay. A property called "Villa Depósito" would otherwise have
// its whole rent treated as a refundable deposit.
assert.strictEqual(nativeDepositTotal([{ name: "Villa Depósito", amount: 900, qty: 1 }]), 0,
  "the stay line is never a deposit, however the property is named");
assert.strictEqual(nativeDepositTotal([{ name: "Stay", amount: 900, qty: 1 }, { name: "Depósito de garantía", amount: 200, qty: 1 }]), 200,
  "and a Spanish deposit line is still read");
assert.strictEqual(nativeDepositTotal([]), 0, "an empty invoice has no deposit");
console.log("5) The stay line is never read as a deposit, and Spanish deposit lines are");

// ======================= the worker, end to end ==========================
const store = new Map();
const kv = {
  async get(k, o) { const v = store.get(k); return v == null ? null : (o?.type === "json" ? JSON.parse(v) : v); },
  async put(k, v) { store.set(k, v); },
};
let txUpdates = [];
let invoicePuts = [];
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const ok = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
  if (u.includes("/objects/custom_objects.transactions/records/") && opts.method === "PUT") {
    txUpdates.push(JSON.parse(opts.body).properties); return ok({ record: { id: "tx1" } });
  }
  if (u.includes("/invoices/") && opts.method === "PUT") { invoicePuts.push(JSON.parse(opts.body)); return ok({ invoice: {} }); }
  if (u.includes("/invoices/inv1")) return ok({
    _id: "inv1", name: "Yajahira Velazquez", currency: "USD", invoiceNumber: "000035", status: "paid",
    issueDate: "2026-10-16T04:00:00.000Z", dueDate: "2026-10-27T03:59:59.999Z",
    invoiceItems: nativeItems(), businessDetails: { name: "DEMO-HOMS" },
  });
  if (u.includes("backend.leadconnectorhq.com/calendars/bookings/details/")) return ok({
    serviceBooking: { contactId: "c1", appointmentTitle: "stay", deleted: false,
      services: [{ id: "s1", position: 0, name: "Villa Azul", price: 200, unitPrice: 200, startDate: "o", endDate: "o" }] },
  });
  if (u.includes("leadconnector")) return ok({ ok: true, records: [], record: { id: "r" }, associations: [] });
  return ok({ ok: true });
};
const worker = (await import("./src/index.js")).default;
const env = { WORKER_URL: "https://w.dev", TENANTS: kv, BOOKINGS: kv, ADMIN_SECRET: "admin123" };
await kv.put(LOC, JSON.stringify(casaBonita));

const post = async (path, body, snapshot) => {
  txUpdates = []; invoicePuts = [];
  await kv.put(snapshot.bookingId, JSON.stringify(snapshot));
  const res = await worker.fetch({
    method: "POST", url: `https://w.dev${path}`,
    json: async () => ({ bookingId: snapshot.bookingId, ...body }),
    headers: { get: (n) => (n === "X-Admin-Secret" ? "admin123" : null) },
  }, env);
  return { status: res.status, body: await res.json(), stored: await kv.get(snapshot.bookingId, { type: "json" }) };
};

// A paid, settled booking in the state enrichment leaves it in. Check-in is
// computed from the clock on purpose: the tier under test is defined by hours
// until check-in, so a fixed date would drift into a different tier and the
// expected figures below would stop being the ones this tier produces. 52h out
// is the live case -- inside 120h, so "one night plus half the rest".
const settledSnapshot = (over = {}) => {
  const checkIn = new Date(Date.now() + 52 * 3600 * 1000);
  const d = (t) => new Date(t).toISOString().slice(0, 10);
  return {
    ...freshSnapshot(),
    bookingId: "ND-2",
    stay: { checkIn: d(checkIn), checkOut: d(checkIn.getTime() + 6 * 86400000), nights: 6, nightlyRate: 200 },
    charges: {
      rentTotal: 1200, cleaningFee: 65, processingFee: 99.3, feePct: 0.06, grandTotal: PAID,
      addOns: 40, addOnDetail: [{ name: "Early Check-In", amount: 15 }, { name: "Late Check-out", amount: 25 }],
      amountsSource: "ghl_invoice",
    },
    securityDeposit: {
      passThrough: true, total: 350, blocks: [], source: DEPOSIT_GHL_NATIVE,
      status: "pending_payment", refundedAmount: null, claimAmount: null,
    },
    payout: { basis: 1240, ownerPct: 0.85, owner: 1054, manager: 186, cleaningFeeTo: "manager", status: "paid" },
    settled: true, settledAt: "2026-10-16T12:20:27.369Z",
    captures: { RENT: { source: "ghl_invoice", invoiceId: "inv1", invoiceNumber: "000035", gross: PAID } },
    ghlInvoice: { invoiceId: "inv1", status: "sent" },
    ghl: { transactionId: "tx1", paymentIds: [] },
    ...over,
  };
};

// ---- 6. every cent the guest paid lands in one column or the other -------
// The live failure, as an invariant rather than a figure: refunded + retained
// must equal what was captured. It was 1,404.30 against 1,754.30.
{
  const out = await post("/cancel", { reason: "test" }, settledSnapshot());
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));
  const c = out.body.calculation;
  assert.strictEqual(c.tier, "under_120h", `52h out is the 5-day tier, got ${c.tier}`);
  assert.strictEqual(c.charge, 720, "one night (200) plus half the remaining 1,040");
  assert.strictEqual(c.depositRefund, 350, "the deposit comes back in full on a cancellation");
  assert.strictEqual(c.totalRefund, 935, "rent 520 + cleaning 65 + deposit 350 -- it was 585");
  assert.strictEqual(c.totalRetained, 819.3, "charge 720 + fee 99.30");
  assert.strictEqual(Math.round((c.totalRefund + c.totalRetained) * 100) / 100, PAID,
    `every cent captured must be refunded or retained, no third option: ${c.totalRefund} + ${c.totalRetained} != ${PAID}`);
  console.log(`6) A cancelled native-deposit booking accounts for all ${PAID}: ${c.totalRefund} back, ${c.totalRetained} kept`);
}

// ---- 7. and the deposit is named in what a person has to pay -------------
// The figure is useless if nobody is told it. manualRefunds is what reaches the
// manager; on enrich there is no capture to refund against, so it is the only
// instruction that exists.
{
  const out = await post("/cancel", { reason: "test" }, settledSnapshot());
  const dep = (out.body.manualRefunds || []).find((m) => m.type === "deposit_refund_needed_manual");
  assert.ok(dep, `the deposit refund must be in manualRefunds, got ${JSON.stringify(out.body.manualRefunds)}`);
  assert.strictEqual(dep.amount, 350, "for the amount the guest actually paid");
  assert.strictEqual(out.stored.securityDeposit.refundedAmount, 350,
    "and the snapshot records 350 owed back, not the 0 it recorded live");
  console.log("7) The manager is told to refund the 350 deposit, not left to find it");
}

// ---- 8. /deposit/refund answers at all ----------------------------------
// It returned 400 "No deposit on this booking" for every booking on every
// enrich account -- the form an account holder submits to find out what is
// owed back after an inspection. A completed stay, no cancellation.
{
  const done = settledSnapshot({ bookingId: "ND-3" });
  done.securityDeposit = { ...done.securityDeposit, status: "held" };
  const out = await post("/deposit/refund", { reason: "clean inspection" }, done);
  assert.strictEqual(out.status, 200,
    `the deposit-refund form must get an answer, got ${out.status} ${JSON.stringify(out.body)}`);
  assert.strictEqual(out.body.refundAmount, 350, "all of it back on a clean inspection");
  assert.strictEqual(out.body.manualRefund, true, "to be issued by hand, as every enrich refund is");
  console.log("8) /deposit/refund returns the 350 owed instead of 'No deposit on this booking'");
}

// ---- 9. a damage claim still comes off the real deposit ------------------
// The other half of case 8, or returning the full amount unconditionally would
// pass it.
{
  const done = settledSnapshot({ bookingId: "ND-4" });
  done.securityDeposit = { ...done.securityDeposit, status: "held" };
  const out = await post("/deposit/refund", { claimAmount: 120, reason: "broken lamp" }, done);
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));
  assert.strictEqual(out.body.refundAmount, 230, "350 held less a 120 claim");
  assert.strictEqual(out.body.claimAmount, 120);
  assert.strictEqual(out.body.status, "partial");
  console.log("9) A damage claim is deducted from the deposit the guest actually paid");
}

// ---- 10. a reschedule neither erases nor re-bills the deposit ------------
// Second seam, and two bugs in one. reschedule.js recomputes the deposit from
// the tenant's own engine, which is disabled on a native-deposit account and
// returns 0 -- so the recorded 350 would be wiped, and a pure date shift would
// read as a price change. Meanwhile updateInvoiceForReschedule adds
// securityDeposit.total to the fee basis and appends DEPOSIT_LINE, both of
// which would double a deposit that is already a line on the invoice.
// Extended by two nights, not merely moved: the invoice is only repriced when
// the guest owes more (settlement.type "invoice_balance_due"), and repricing is
// where both of those bugs live.
{
  const base = settledSnapshot({ bookingId: "ND-5" });
  const newIn = new Date(Date.parse(base.stay.checkIn) + 14 * 86400000);
  const d = (t) => new Date(t).toISOString().slice(0, 10);
  const out = await post("/reschedule", {
    newCheckIn: d(newIn), newCheckOut: d(newIn.getTime() + 8 * 86400000),
  }, base);
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));
  assert.strictEqual(out.stored.securityDeposit.total, 350,
    "a GHL-native deposit is not the Worker's to resize, and erasing it loses the guest's money again");
  assert.strictEqual(out.stored.securityDeposit.source, DEPOSIT_GHL_NATIVE, "and it is still GHL's");

  assert.ok(invoicePuts.length > 0, "the guest's invoice is repriced for the new dates");
  for (const p of invoicePuts) {
    const deps = (p.invoiceItems || []).filter(isDepositLine);
    assert.strictEqual(deps.length, 1,
      `a repriced invoice must carry exactly one deposit line, got ${JSON.stringify(deps.map((i) => i.name))}`);
    const fee = (p.invoiceItems || []).find((i) => /process|procesamiento/i.test(String(i.name || "")));
    assert.ok(fee, "a repriced invoice still carries a fee line");
    const rest = (p.invoiceItems || [])
      .filter((i) => i !== fee)
      .reduce((s, i) => s + Number(i.amount || 0) * Number(i.qty || 1), 0);
    assert.strictEqual(fee.amount, Math.round(0.06 * rest * 100) / 100,
      "and the fee is 6% of the rest of the invoice ONCE -- counting the native deposit again overcharges it");
  }
  console.log("10) A reschedule keeps the 350 deposit, bills it once, and charges the fee on it once");
}

console.log("\nPASS — a GHL-native security deposit is recorded, refundable, and billed exactly once.");
