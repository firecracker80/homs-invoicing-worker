// Regression test for the "reschedule an UNPAID booking" path in
// src/reschedule.js: re-prices the booking and issues a fresh payment link
// instead of computing a charge/refund delta (nothing was ever captured).
//
// Guards against the idempotency-collision bug found on merge: a second
// createOrder/createCheckoutSession call against the same bookingId must use
// a DISTINCT PayPal-Request-Id / Stripe Idempotency-Key, or PayPal/Stripe
// will either return the stale original order or reject the new body under
// the reused key.
import assert from "node:assert";
global.Response = class { constructor(b, i = {}) { this.body = b; this.status = i.status || 200; } async json() { return JSON.parse(this.body); } };
global.btoa = s => Buffer.from(s).toString("base64");
const store = new Map();
const kv = { async get(k, o) { const v = store.get(k); return v == null ? null : (o?.type === "json" ? JSON.parse(v) : v); }, async put(k, v) { store.set(k, v); } };
const hdr = s => ({ get: n => n === "X-Admin-Secret" ? s : null });

const paypalOrderRequestIds = [];
global.fetch = async (url, opts = {}) => {
  if (url.includes("oauth2/token")) return { ok: true, json: async () => ({ access_token: "T" }) };
  if (url.includes("checkout/orders")) {
    paypalOrderRequestIds.push(opts.headers["PayPal-Request-Id"]);
    return { ok: true, json: async () => ({ id: "PP-" + paypalOrderRequestIds.length, links: [{ rel: "payer-action", href: "https://sandbox.paypal.com/checkoutnow?token=PP" + paypalOrderRequestIds.length }] }) };
  }
  if (url.includes("airtable")) {
    const b = opts.body ? JSON.parse(opts.body) : null;
    if (opts.method === "PATCH") return { ok: true, json: async () => ({ id: "patched" }) };
    return { ok: true, json: async () => ({ records: (b?.records || []).map((r, i) => ({ id: "rec" + i, fields: r.fields })) }) };
  }
  if (url.includes("leadconnector")) return { ok: true, json: async () => ({ ok: true }) };
  throw new Error("unmocked: " + url);
};

const worker = (await import("./src/index.js")).default;
const env = { WORKER_URL: "https://w.dev", TENANTS: kv, BOOKINGS: kv, ADMIN_SECRET: "admin123" };
await kv.put("L1", JSON.stringify({
  brandName: "JT1", currency: "USD", ownerPct: 0.85, processingFeePct: 0.06,
  defaultCleaningFee: 69, cleaningFeeRecipient: "manager", bookingWorkerEnabled: true,
  gateway: "paypal", deposit: { rule: "tiered" },
  paypalApi: "https://p", paypalClientId: "C", paypalSecret: "S",
  airtableBaseId: "a", airtableToken: "pat", defaultPropertyRecId: "rP"
}));

// Create a booking but never settle it (skip /paypal/return -- stays unpaid)
await worker.fetch({ method: "POST", url: "https://w.dev/booking-created", json: async () => ({
  bookingId: "UNPAID-1", locationId: "L1", contactId: "c1", firstName: "Ana", lastName: "G",
  email: "a@x.com", phone: "+1", checkIn: "2026-09-01", checkOut: "2026-09-04", stayTotal: "210"
}), headers: { get: () => null } }, env);

const before = await kv.get("UNPAID-1", { type: "json" });
assert(!before.settled, "booking must start unsettled");
const firstRequestId = paypalOrderRequestIds[0];

// Reschedule to a different (longer) stay before ever paying
const r = await (await worker.fetch({ method: "POST", url: "https://w.dev/reschedule", json: async () => ({
  bookingId: "UNPAID-1", newCheckIn: "2026-09-01", newCheckOut: "2026-09-08", reason: "guest wants more nights"
}), headers: hdr("admin123") }, env)).json();

console.log("1) Unpaid reschedule 3n->7n:", JSON.stringify({ newDates: r.newDates, settlementType: r.settlement?.type, approveUrl: !!r.settlement?.approveUrl }));

assert(r.settlement.type === "unpaid_new_link", "expected unpaid_new_link settlement type");
assert(r.newDates.nights === 7, "new night count must reflect the reschedule");

const secondRequestId = paypalOrderRequestIds[1];
assert(paypalOrderRequestIds.length === 2, "expected exactly 2 PayPal order calls (original + reprice)");
assert(firstRequestId !== secondRequestId, `PayPal-Request-Id must differ between the original and repriced order (got "${firstRequestId}" twice) -- otherwise PayPal returns/rejects based on stale idempotency`);
assert(secondRequestId.startsWith("UNPAID-1-RESCHED-"), "repriced order's request id must be derived from, not equal to, the bare bookingId");

const after = await kv.get("UNPAID-1", { type: "json" });
assert(after.stay.nights === 7, "snapshot must reflect new night count");
assert(after.charges.rentTotal === 490, `snapshot rent must reflect new price (7 nights x $70 = $490), got ${after.charges.rentTotal}`);
assert(!after.settled, "still unsettled -- guest has not paid yet, this only issued a fresh link");
assert(after.paypal.orderId === "PP-2", "snapshot must point at the NEW order, not the stale original");

// Cancelled bookings must still be rejected (indentation fix must not have broken the guard)
await worker.fetch({ method: "POST", url: "https://w.dev/booking-created", json: async () => ({
  bookingId: "CANCELLED-1", locationId: "L1", contactId: "c2", firstName: "Ben", lastName: "G",
  email: "b@x.com", phone: "+1", checkIn: "2026-09-10", checkOut: "2026-09-13", stayTotal: "210"
}), headers: { get: () => null } }, env);
const cSnap = await kv.get("CANCELLED-1", { type: "json" });
cSnap.cancelled = true;
await kv.put("CANCELLED-1", JSON.stringify(cSnap));
const rc = await (await worker.fetch({ method: "POST", url: "https://w.dev/reschedule", json: async () => ({
  bookingId: "CANCELLED-1", newCheckIn: "2026-09-10", newCheckOut: "2026-09-14"
}), headers: hdr("admin123") }, env)).json();
assert(rc.error === "Booking is cancelled", `cancelled-booking guard must still reject (got: ${JSON.stringify(rc)})`);
console.log("2) Cancelled booking still rejected:", rc.error);

console.log("\nPASS — unpaid-booking reschedule re-prices correctly and uses a fresh PayPal idempotency key.");
