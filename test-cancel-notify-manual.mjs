// The cancellation notification has to say what somebody has to do about it.
// Run: node test-cancel-notify-manual.mjs
//
// GHL shipped native guest cancellation on 2026-09-28. The booking is released
// immediately and, by GHL's own design, "refund amounts stay a manual
// decision". So a cancellation is not finished when it fires -- it is finished
// when a person has moved the money.
//
// Yari went to build the workflow that tells the manager and found there was
// nothing to tell them with: manualRefunds lived only on the HTTP response, and
// this notify is a separate outbound POST that nothing reads the response of.
// The workflow could announce that a booking was cancelled and could not
// mention the 132.50 owed to the guest, which is the only actionable part.
import assert from "node:assert";

global.Response = class { constructor(b, i = {}) { this.body = b; this.status = i.status || 200; } async json() { return JSON.parse(this.body); } };

const LOC = "ZghxU8I60bEm39JUbtCm";
const BOOKING = "1Iq3gDIB2V3MTZnP6zco";
const HOOK = "https://services.leadconnectorhq.com/hooks/cancel";

const store = new Map();
const kv = {
  async get(k, o) { const v = store.get(k); return v == null ? null : (o?.type === "json" ? JSON.parse(v) : v); },
  async put(k, v) { store.set(k, v); },
};
const hdr = (s) => ({ get: (n) => (n === "X-Admin-Secret" ? s : null) });

const tenant = {
  brandName: "Casa Bonita", currency: "USD", ownerPct: 0.85, adminSecret: "admin123",
  cancellationPolicy: { tiers: [{ underHours: 120, nights: 1, remainderPct: 0.5 }], checkedInChargePct: 1 },
  ghlCancellationUrl: HOOK, ghlPit: "pit", tzOffsetHours: -4, checkInHour: 15,
};

// Paid by GHL invoice: settled, no captureId, so refunds are manual by design.
const paidSnapshot = (over = {}) => ({
  bookingId: BOOKING, locationId: LOC, ghlContactId: "c1", propertyCode: "Test Villa 2",
  createdAt: "2026-09-28T14:46:20.973Z",
  guest: { name: "Native Cancel Test", email: "guest@example.com" },
  stay: { checkIn: "2026-09-30", checkOut: "2026-10-02", nights: 2, nightlyRate: 135 },
  charges: { rentTotal: 270, cleaningFee: 65, processingFee: 20.1, feePct: 0.06, grandTotal: 355.1 },
  securityDeposit: { total: 0, blocks: [], status: "none" },
  payout: { basis: 270, ownerPct: 0.85, owner: 229.5, manager: 40.5, cleaningFeeTo: "manager", status: "paid" },
  gateway: "ghl_invoice", settled: true,
  captures: { RENT: { gross: 355.1, source: "ghl_invoice", invoiceNumber: "000014" } },
  ghl: { transactionId: "tx-1", paymentIds: [] },
  ...over,
});

let notified = [];
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const ok = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });
  if (u.includes("/hooks/")) { notified.push(JSON.parse(opts.body || "{}")); return ok({}); }
  if (u.includes("stripe.com") || u.includes("/refund")) return ok({ id: "REF-1" });
  return ok({ records: [], record: { id: "r" }, associations: [] });
};

const { handleCancel } = await import("./src/cancellation.js");
const env = { TENANTS: kv, BOOKINGS: kv, ADMIN_SECRET: "admin123" };
await kv.put(LOC, JSON.stringify(tenant));

const cancel = async (snapshot = paidSnapshot(), body = {}) => {
  notified = [];
  await kv.put(BOOKING, JSON.stringify(snapshot));
  const res = await handleCancel({
    method: "POST", url: "https://w.dev/cancel",
    json: async () => ({ bookingId: BOOKING, locationId: LOC, reason: "guest cancelled", ...body }),
    headers: hdr("admin123"),
  }, env);
  return { status: res.status, body: await res.json(), sent: notified[0] };
};

// ---- 1. the notification names the amount owed ------------------------
{
  const out = await cancel();
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));
  assert.ok(out.sent, "a notification went out");

  assert.strictEqual(out.sent.manualRefundRequired, "yes",
    "a workflow branches on this -- and on a string, not a number that might read 0.00");
  assert.strictEqual(out.sent.manualRefundTotal, out.body.calculation.totalRefund.toFixed(2),
    "the amount owed matches what the calculation decided, to the cent");
  assert.match(out.sent.manualRefundDetail, /^Rent \d+\.\d{2}$/,
    "and says what it is for, in words a person reads rather than an entry_type");
  console.log("1) The notification carries the amount the manager has to refund by hand");
}

// ---- 2. a task and a fault are not the same thing --------------------
// manualRefundRequired means go and pay someone. refundFailed means the gateway
// refused and something is wrong. A manager reading one as the other either
// pays twice or not at all.
{
  const out = await cancel();
  assert.strictEqual(out.sent.refundFailed, "no",
    "nothing failed -- no refund was attempted, so there was nothing to fail");
  assert.strictEqual(out.sent.manualRefundRequired, "yes");
  console.log("2) An unattempted refund reports as a task, never as a failure");
}

// ---- 3. nothing owed says so plainly --------------------------------
// The notification still fires when no money is owed, and must not leave a
// manager wondering whether a number is missing or genuinely zero.
//
// Getting to zero takes both halves: the guest already checked in, so the rent
// is retained in full, AND there is no cleaning fee. A checked-in cancellation
// on a booking that HAS one still refunds the cleaning -- retaining the rent
// does not mean keeping money for a clean nobody performed. That surprised this
// test before it surprised anyone in production.
{
  const checkedIn = paidSnapshot({
    stay: { checkIn: "2026-09-27", checkOut: "2026-09-29", nights: 2, nightlyRate: 135 },
    charges: { rentTotal: 270, cleaningFee: 0, processingFee: 16.2, feePct: 0.06, grandTotal: 286.2 },
  });
  const out = await cancel(checkedIn);
  assert.strictEqual(out.sent.manualRefundRequired, "no");
  assert.strictEqual(out.sent.manualRefundTotal, "0.00", "zero, written as money, not absent");
  assert.strictEqual(out.sent.manualRefundDetail, "", "and nothing to describe");
  console.log("3) A cancellation that owes nothing says no and 0.00, rather than omitting the field");
}

// ---- 4. the guest is named ------------------------------------------
// The payload carried an email and no name. "Refund guest@example.com" is a
// worse instruction than it looks when a manager is working a list.
{
  const out = await cancel();
  assert.strictEqual(out.sent.guestName, "Native Cancel Test");
  assert.strictEqual(out.sent.email, "guest@example.com", "the email is still there too");
  assert.strictEqual(out.sent.propertyName, "Test Villa 2");
  console.log("4) The notification names the guest, not only their email address");
}

// ---- 5. the existing fields are untouched ---------------------------
// A workflow may already be built against these. Adding to the payload must not
// rename or drop anything in it.
{
  const out = await cancel();
  for (const k of ["event", "bookingId", "contactId", "email", "paid", "tier",
                   "chargePct", "chargeTotal", "refundTotal", "depositRefund",
                   "checkIn", "propertyName"]) {
    assert.ok(k in out.sent, `${k} is still on the payload`);
  }
  assert.strictEqual(out.sent.event, "booking_cancelled");
  assert.strictEqual(out.sent.paid, true);
  console.log("5) Every field a workflow could already be reading is still present");
}

// ---- 6. an unpaid cancellation is not a refund task -----------------
// Nothing was ever captured, so nobody owes anybody anything.
{
  const unpaid = paidSnapshot({ settled: false, captures: undefined, ghl: undefined });
  const out = await cancel(unpaid);
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));
  assert.strictEqual(out.sent.paid, false);
  assert.ok(!out.sent.manualRefundRequired || out.sent.manualRefundRequired === "no",
    "an unpaid booking never generates a refund to chase");
  console.log("6) Cancelling an unpaid booking raises no manual refund");
}

// ---- 7. a refund the gateway refused reports as a fault ---------------
// The other half of test 2, and the half that matters. Without this, hardcoding
// refundFailed to "no" passes everything above -- nothing here had ever
// attempted a refund, so "no" was right for the wrong reason.
{
  const withCapture = paidSnapshot({
    gateway: "stripe",
    captures: { RENT: { gross: 355.1, captureId: "ch_live_1", source: "stripe" } },
  });
  const realFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    if (String(url).includes("stripe.com")) {
      const payload = { error: { message: "charge already refunded" } };
      return { ok: false, status: 402, text: async () => JSON.stringify(payload), json: async () => payload };
    }
    return realFetch(url, opts);
  };
  const out = await cancel(withCapture);
  global.fetch = realFetch;

  assert.strictEqual(out.sent.refundFailed, "yes", "the gateway refused, and the notification says so");
  assert.strictEqual(out.sent.manualRefundRequired, "no",
    "and does NOT also ask the manager to pay it -- a refund that failed is a fault to look at, not a task to complete");
  assert.strictEqual(out.sent.manualRefundTotal, "0.00");
  console.log("7) A refund the gateway refused reports as a fault, and never as money to go and pay");
}

console.log("\nPASS — the cancellation notification tells the manager what to pay, to whom, and whether anything went wrong.");
