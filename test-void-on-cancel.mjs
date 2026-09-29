// Close the invoice when the booking is cancelled, and shout if money lands anyway.
// Run: node test-void-on-cancel.mjs
//
// DEMO-HOMS booking wrDkB9DxAkLCisZYDtcL, 2026-09-29: cancelled unpaid at
// 14:17:54, and $975.20 paid at 14:49:13 against a stay that was no longer
// happening. GHL cancels an unpaid booking when its payment window closes, but
// the invoice link already sitting in the guest's inbox keeps working.
//
// The Worker caught it and refused to book the revenue, which was right -- but
// only after the money had moved, and the only record was a console.error,
// which is a note to nobody.
//
// Two halves here. Voiding the invoice at cancellation closes the door.
// Notifying on a payment that arrives anyway is the backstop for what still
// gets through: a payment already in flight, or a void GHL refused.
import assert from "node:assert";

global.Response = class { constructor(b, i = {}) { this.body = b; this.status = i.status || 200; } async json() { return JSON.parse(this.body); } };

const LOC = "ZghxU8I60bEm39JUbtCm";
const BOOKING = "wrDkB9DxAkLCisZYDtcL";
const INVOICE = "6abbba9bf08a72ce2570545a";
const HOOK = "https://services.leadconnectorhq.com/hooks/cancel";

const store = new Map();
const kv = {
  async get(k, o) { const v = store.get(k); return v == null ? null : (o?.type === "json" ? JSON.parse(v) : v); },
  async put(k, v) { store.set(k, v); },
};
const hdr = (s) => ({ get: (n) => (n === "X-Admin-Secret" ? s : null) });

const tenant = {
  brandName: "Casa Bonita", currency: "USD", ownerPct: 0.85, adminSecret: "admin123",
  ghlCancellationUrl: HOOK, ghlPit: "pit", tzOffsetHours: -4, checkInHour: 15,
  cancellationPolicy: { tiers: [], checkedInChargePct: 1 },
};

const unpaidSnapshot = (over = {}) => ({
  bookingId: BOOKING, locationId: LOC, ghlContactId: "c1", propertyCode: "Test Villa 2",
  createdAt: "2026-09-29T13:19:04.737Z",
  guest: { name: "Yajahira Velazquez", email: "guest@example.com" },
  stay: { checkIn: "2026-10-01", checkOut: "2026-10-03", nights: 2, nightlyRate: 135 },
  charges: { rentTotal: 270, cleaningFee: 130, processingFee: 55.2, grandTotal: 975.2 },
  securityDeposit: { total: 0, blocks: [], status: "pending_payment" },
  payout: { basis: 270, ownerPct: 0.85, owner: 229.5, manager: 40.5 },
  gateway: "ghl_invoice", settled: false,
  ghlInvoice: { invoiceId: INVOICE, status: "sent" },
  ...over,
});

let voidCalls = [];
let notified = [];
const makeFetch = (invoice) => async (url, opts = {}) => {
  const u = String(url);
  const ok = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
  if (u.includes("/hooks/")) { notified.push(JSON.parse(opts.body || "{}")); return ok({}); }
  if (u.includes(`/invoices/${INVOICE}/void`)) {
    voidCalls.push(JSON.parse(opts.body || "{}"));
    return ok({ ...invoice, status: "void" });
  }
  if (u.includes(`/invoices/${INVOICE}`)) return ok(invoice);
  return ok({ records: [], record: { id: "r" }, associations: [] });
};

const { handleCancel } = await import("./src/cancellation.js");
const env = { TENANTS: kv, BOOKINGS: kv, ADMIN_SECRET: "admin123" };
await kv.put(LOC, JSON.stringify(tenant));

const cancel = async ({ snapshot = unpaidSnapshot(), invoice } = {}) => {
  voidCalls = []; notified = [];
  global.fetch = makeFetch(invoice ?? { _id: INVOICE, invoiceNumber: "000020", status: "sent", total: 975.2, amountPaid: 0 });
  await kv.put(BOOKING, JSON.stringify(snapshot));
  const res = await handleCancel({
    method: "POST", url: "https://w.dev/cancel",
    json: async () => ({ bookingId: BOOKING, locationId: LOC, reason: "unpaid window closed" }),
    headers: hdr("admin123"),
  }, env);
  return { status: res.status, body: await res.json() };
};

// ---- 1. cancelling an unpaid booking closes its invoice --------------
{
  const out = await cancel();
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));
  assert.strictEqual(voidCalls.length, 1, "the invoice is voided");
  assert.deepStrictEqual(voidCalls[0], { altId: LOC, altType: "location" },
    "with altId, without which the invoices service 401s");

  const snap = JSON.parse(store.get(BOOKING));
  assert.strictEqual(snap.invoiceVoid.ok, true);
  assert.strictEqual(snap.invoiceVoid.invoiceNumber, "000020", "and the outcome is on the booking");
  console.log("1) Cancelling an unpaid booking voids its invoice, so the link stops working");
}

// ---- 2. a paid invoice is never voided ------------------------------
// Voiding one would hide money that actually arrived, and with it a refund
// somebody is owed. The refusal is reported, not thrown.
{
  const paidInvoice = { _id: INVOICE, invoiceNumber: "000020", status: "paid", total: 975.2, amountPaid: 975.2 };
  const out = await cancel({ invoice: paidInvoice });
  assert.strictEqual(out.status, 200, "the cancellation still succeeds");
  assert.deepStrictEqual(voidCalls, [], "and no void is attempted");

  const snap = JSON.parse(store.get(BOOKING));
  assert.strictEqual(snap.invoiceVoid.ok, false);
  assert.strictEqual(snap.invoiceVoid.reason, "invoice_already_paid");
  assert.match(snap.invoiceVoid.detail, /hide money that actually arrived/);
  console.log("2) An invoice with money on it is never voided, and says why");
}

// ---- 3. a void GHL refuses does not fail the cancellation -----------
// The booking is cancelled either way. An invoice that could not be closed is a
// fact to report, not a reason to leave the cancellation half-done.
{
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const ok = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
    if (u.includes("/hooks/")) { notified.push(JSON.parse(opts.body || "{}")); return ok({}); }
    if (u.includes("/void")) return { ok: false, status: 422, text: async () => JSON.stringify({ message: "cannot void" }) };
    if (u.includes(`/invoices/${INVOICE}`)) return ok({ _id: INVOICE, invoiceNumber: "000020", status: "sent", amountPaid: 0 });
    return ok({ records: [], record: { id: "r" }, associations: [] });
  };
  await kv.put(BOOKING, JSON.stringify(unpaidSnapshot()));
  const res = await handleCancel({
    method: "POST", url: "https://w.dev/cancel",
    json: async () => ({ bookingId: BOOKING, locationId: LOC, reason: "unpaid" }),
    headers: hdr("admin123"),
  }, env);
  assert.strictEqual(res.status, 200, "the cancellation stands");

  const snap = JSON.parse(store.get(BOOKING));
  assert.strictEqual(snap.cancelled, true);
  assert.strictEqual(snap.invoiceVoid.ok, false);
  assert.strictEqual(snap.invoiceVoid.reason, "void_rejected");
  console.log("3) A void GHL refuses is recorded, and the cancellation still stands");
}

// ---- 4. a booking with no invoice is not an error -------------------
{
  const noInvoice = unpaidSnapshot({ ghlInvoice: undefined });
  const out = await cancel({ snapshot: noInvoice });
  assert.strictEqual(out.status, 200);
  assert.deepStrictEqual(voidCalls, []);
  assert.strictEqual(JSON.parse(store.get(BOOKING)).invoiceVoid.reason, "no_invoice_on_booking");
  console.log("4) A booking that never had an invoice reports that, rather than failing");
}

// ================================================= the backstop ============
// What still gets through: a payment already in flight when the void ran, or a
// cancellation where the void was refused.
{
  const { handleGhlInvoicePaid } = await import("./src/payment.js");

  const cancelledSnapshot = unpaidSnapshot({
    cancelled: true,
    cancellation: { tier: "unpaid_void", at: "2026-09-29T14:17:54.694Z", reason: "" },
  });

  const runPayment = async () => {
    notified = [];
    await kv.put(BOOKING, JSON.stringify(cancelledSnapshot));
    global.fetch = async (url, opts = {}) => {
      const u = String(url);
      const ok = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
      if (u.includes("/hooks/")) { notified.push(JSON.parse(opts.body || "{}")); return ok({}); }
      if (u.includes("/invoices/")) {
        return ok({ _id: INVOICE, invoiceNumber: "000020", status: "paid", total: 975.2, amountPaid: 975.2,
          altId: LOC, sourceId: BOOKING, source: "calendar" });
      }
      return ok({ records: [], record: { id: "r" }, associations: [] });
    };
    const res = await handleGhlInvoicePaid({
      method: "POST", url: "https://w.dev/ghl-invoice-paid",
      json: async () => ({ invoiceId: INVOICE, locationId: LOC }),
      headers: hdr("admin123"),
    }, env);
    return { status: res.status, body: await res.json() };
  };

  // ---- 5. a payment on a cancelled booking is still refused ---------
  {
    const out = await runPayment();
    assert.strictEqual(out.body.skipped, "booking_cancelled", "the revenue is still not booked");
    assert.strictEqual(out.body.refundOwed, 975.2);
    console.log("5) A payment on a cancelled booking is still refused, not settled");
  }

  // ---- 6. and now it tells somebody --------------------------------
  // This is the change. Before, the only record was a console.error -- a note
  // to nobody, on real money against a stay that is not happening.
  {
    await runPayment();
    const alert = notified.find((n) => n.event === "payment_after_cancellation");
    assert.ok(alert, "a notification goes out, not only a log line");
    assert.strictEqual(alert.paymentAfterCancellation, "yes", "a workflow can branch on this");
    assert.strictEqual(alert.refundOwed, "975.20", "and it names the amount owed back");
    assert.strictEqual(alert.guestName, "Yajahira Velazquez", "and who it is owed to");
    assert.strictEqual(alert.invoiceNumber, "000020");
    assert.strictEqual(alert.cancelledAt, "2026-09-29T14:17:54.694Z",
      "and when the booking had been cancelled, which is what makes it obviously wrong");
    console.log("6) A payment after cancellation now reaches a person, naming the amount and the guest");
  }
}

console.log("\nPASS — cancelling closes the invoice, and money that arrives anyway is refused AND announced.");
