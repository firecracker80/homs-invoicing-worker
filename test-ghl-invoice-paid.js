// POST /ghl-invoice-paid -- settling a booking whose GHL invoice was paid in GHL.
// Mock GHL + KV only; replays the live DEMO-HOMS booking HN6Yg0vVM9Z4H8rBhli0
// (invoice 000006: Arpel 07 135 + Cleaning 65 + processing fee 12 = 212).
import assert from "node:assert";

const LOC = "ZghxU8I60bEm39JUbtCm";
const BOOKING = "HN6Yg0vVM9Z4H8rBhli0";
const INV = "6ab18b4a1d8db91b4040f5f3";

const store = new Map();
const kv = {
  async get(k, o) { const v = store.get(k); return v == null ? null : (o?.type === "json" ? JSON.parse(v) : v); },
  async put(k, v) { store.set(k, v); }
};
const tenant = { brandName: "DEMO-HOMS", currency: "USD", ownerPct: 0.85, processingFeePct: 0.06, ghlPit: "pit", invoiceStrategy: "enrich", webhookSecret: "hook-secret", ghlPaymentConfirmedUrl: "https://services.leadconnectorhq.com/hooks/payment-confirmation" };
const snapshot = () => ({
  bookingId: BOOKING, locationId: LOC, ghlContactId: "ALDS6JyzJiH4a5mDPdnA", propertyCode: "Arpel 07", bookingSource: "Direct",
  guest: { name: "Test Booking E2E Two" }, stay: { checkIn: "2026-09-24", checkOut: "2026-09-25", nights: 1, nightlyRate: 135 },
  charges: { rentTotal: 135, cleaningFee: 65, processingFee: 12, feePct: 0.06, grandTotal: 212, amountsSource: "ghl_invoice", cleaningFeeSource: "ghl_native" },
  securityDeposit: { total: 0, blocks: [], status: "pending_payment" },
  payout: { basis: 135, ownerPct: 0.85, owner: 114.75, manager: 20.25, cleaningFeeTo: "manager", status: "pending" },
  gateway: "ghl_invoice", ghlInvoice: { invoiceId: INV, status: "sent" }
});

let invoiceStatus = "paid";
let notifyCalls = 0;
let invoiceGets = 0;
const invoice = () => ({
  _id: INV, invoiceNumber: "000006", status: invoiceStatus, source: "calendar", sourceId: BOOKING,
  meta: { serviceBookingId: BOOKING, subSource: "rental" }, total: 212, amountPaid: invoiceStatus === "paid" ? 212 : 0,
  lastPaidAt: "2026-09-21T20:30:00.000Z", altId: LOC
});
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const res = (obj, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(obj), json: async () => obj });
  if (u.includes("/hooks/")) { notifyCalls++; return res({}); }
  if (u.includes(`/invoices/${INV}?`)) { invoiceGets++; return res(invoice()); }
  if (u.includes("/invoices/000006?")) return res({ message: "Invoice not found" }, 404);
  if (u.includes("/invoices/?")) return res({ invoices: [{ _id: "other", invoiceNumber: "000004", status: "paid" }, { _id: INV, invoiceNumber: "000006", status: invoiceStatus }] });
  if (u.includes("/invoices/other?")) return res({ _id: "other", invoiceNumber: "000004", status: "paid" });
  // Ledger's GHL object writes: accept anything.
  return res({ records: [], record: { id: "rec1" }, associations: [], id: "rec1" });
};
global.Response = class { constructor(b, i = {}) { this.body = b; this.status = i.status || 200; this.headers = i.headers; } async json() { return JSON.parse(this.body); } };

const worker = (await import("./src/index.js")).default;
const env = { TENANTS: kv, BOOKINGS: kv };
await kv.put(LOC, JSON.stringify(tenant));
const post = async (body, headers = {}) => {
  const h = new Map(Object.entries(headers));
  const r = await worker.fetch({ method: "POST", url: "https://w.dev/ghl-invoice-paid", json: async () => body, headers: { get: k => h.get(k) ?? null } }, env);
  return { status: r.status, body: await r.json() };
};
const base = { locationId: LOC, contactId: "ALDS6JyzJiH4a5mDPdnA", secret: "hook-secret" };

// 1. auth + request shape
assert.equal((await post({ ...base, secret: "wrong", invoiceId: INV })).status, 401);
assert.equal((await post({ ...base, locationId: "{{location.id}}", invoiceId: INV })).status, 400);
const other = await post({ ...base, invoiceId: "{{invoice.id}}" });
assert.equal(other.body.skipped, "no_invoice_in_request", "the workflow's inbound-webhook trigger carries no invoice -- skipped, 200");
console.log("1) Wrong secret 401; unresolved location 400; no invoice (other trigger) -> skipped");

// 2. not paid yet / not a booking invoice / unknown booking
await kv.put(BOOKING, JSON.stringify(snapshot()));
invoiceStatus = "sent";
assert.equal((await post({ ...base, invoiceId: INV })).body.skipped, "invoice_sent", "GHL is re-read: a webhook alone never settles");
invoiceStatus = "paid";
assert.equal((await post({ ...base, invoiceNumber: "000004" })).body.skipped, "not_a_booking_invoice");
console.log("2) Invoice not Paid in GHL -> skipped; non-booking invoice -> skipped");

// 3. paid -> settled, split recorded, no echo to the payment-confirmation webhook
notifyCalls = 0;
const paid = await post({ ...base, invoiceId: INV }, { "X-Webhook-Secret": "hook-secret" });
assert.equal(paid.status, 200, JSON.stringify(paid.body));
assert.equal(paid.body.settled, true, JSON.stringify(paid.body));
assert.equal(paid.body.amountPaid, 212);
const snap = JSON.parse(store.get(BOOKING));
assert.equal(snap.settled, true);
assert.equal(snap.captures.RENT.gross, 212);
assert.equal(snap.captures.RENT.source, "ghl_invoice");
assert.equal(snap.captures.RENT.invoiceNumber, "000006");
assert.equal(snap.captures.DEP, undefined, "no deposit line on a native tenant");
assert.deepEqual([snap.payout.owner, snap.payout.manager], [114.75, 20.25]);
assert.equal(notifyCalls, 0, "no post back to the Payment Confirmation webhook -- the workflow would run twice");
console.log("3) Paid -> settled: RENT 212 via ghl_invoice, split 114.75 / 20.25, no echo to the confirmation webhook");

// 4. twice -> no-op
const again = await post({ ...base, invoiceId: INV });
assert.equal(again.body.alreadySettled, true);
console.log("4) Second call -> alreadySettled");

// 5. merge tag gave the NUMBER, not the id -> found through the contact's invoices
await kv.put(BOOKING, JSON.stringify(snapshot()));
const byNumber = await post({ ...base, invoiceId: "000006" });
assert.equal(byNumber.body.settled, true, JSON.stringify(byNumber.body));
assert.equal(byNumber.body.invoiceId, INV);
console.log("5) Invoice number in place of the id -> resolved via the contact's invoices");

// 6. legacy tenant with a Worker deposit line: payment split into RENT + DEP
await kv.put(BOOKING, JSON.stringify({ ...snapshot(), securityDeposit: { total: 135, blocks: [], status: "pending_payment" } }));
const legacy = await post({ ...base, invoiceId: INV });
const lsnap = JSON.parse(store.get(BOOKING));
assert.equal(legacy.body.settled, true);
assert.equal(lsnap.captures.DEP.gross, 135);
assert.equal(lsnap.captures.RENT.gross, 77, "212 paid - 135 deposit");
assert.equal(lsnap.securityDeposit.status, "held");
console.log("6) Legacy deposit on the invoice -> DEP 135 held, RENT the rest");

// 7. booking the Worker never saw -> 404, nothing written
store.delete(BOOKING);
assert.equal((await post({ ...base, invoiceId: INV })).status, 404);
console.log("7) Booking not on record -> 404");

console.log("\nPASS — /ghl-invoice-paid settles GHL-paid booking invoices once, from GHL's own status.");
