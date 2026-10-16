// Rescheduling an UNPAID booking on the GHL-invoice path reprices that invoice.
// Run: node test-reschedule-unpaid-enrich.mjs
//
// It did not, until 2026-10-15. The settled path checked
// `settleVia === "ghl_invoice"` and repriced; the unpaid path checked nothing
// and called createOrder unconditionally. Every live account is on the invoice
// path, so every unpaid reschedule took that branch and either:
//
//   - produced a real PayPal order beside the guest's existing GHL invoice,
//     two live ways to pay for one booking (an account with PayPal creds), or
//   - threw in getAccessToken (an account without them).
//
// The gap was visible and missed: when the runtime default flipped to "enrich"
// in #142, test-reschedule-unpaid.js went red and was given an explicit
// `invoiceStrategy: "paypal_url"` to keep it green. That made the symptom go
// away. The reason it went red is this.
import assert from "node:assert/strict";

global.Response = class {
  constructor(b, i = {}) { this.body = b; this.status = i.status || 200; }
  async json() { return JSON.parse(this.body); }
};

const store = new Map();
const kv = {
  async get(k, o) { const v = store.get(k); return v == null ? null : (o?.type === "json" ? JSON.parse(v) : v); },
  async put(k, v) { store.set(k, v); },
};
const hdr = (s) => ({ get: (n) => (n === "X-Admin-Secret" ? s : null) });

let paypalOrderCalls = 0;
let invoicePuts = [];
let notified = [];

global.fetch = async (url, opts = {}) => {
  const u = String(url);
  // If this is ever hit, the unpaid path has gone back to issuing a second way
  // to pay for a booking that already has an invoice.
  if (u.includes("oauth2/token") || u.includes("checkout/orders")) {
    paypalOrderCalls++;
    return { ok: true, json: async () => ({ access_token: "T", id: "PP-1", links: [{ rel: "payer-action", href: "https://pp/x" }] }) };
  }
  if (u.includes("/invoices/INV-1")) {
    if (opts.method === "PUT") {
      invoicePuts.push(JSON.parse(opts.body));
      return { ok: true, text: async () => JSON.stringify({ _id: "INV-1", status: "sent", amountDue: 585, total: 585 }) };
    }
    return { ok: true, text: async () => JSON.stringify({
      _id: "INV-1", invoiceNumber: "000042", status: "sent", currency: "USD", amountDue: 418.7,
      invoiceItems: [
        { name: "Estadía", amount: 110, qty: 3, currency: "USD" },
        { name: "Cleaning Fee", amount: 65, qty: 1, currency: "USD" },
        { name: "Cargo por procesamiento", amount: 23.7, qty: 1, currency: "USD" },
      ],
    }) };
  }
  if (u.includes("backend.leadconnectorhq.com/calendars/bookings/details/")) {
    return { ok: true, text: async () => JSON.stringify({ serviceBooking: {
      contactId: "c1", appointmentTitle: "stay", deleted: false,
      services: [{ id: "svc1", position: 0, name: "Test Villa 3", price: 110, unitPrice: 110, startDate: "o", endDate: "o" }],
    } }) };
  }
  if (u.includes("backend.leadconnectorhq.com/calendars/bookings/manage/")) {
    return { ok: true, text: async () => JSON.stringify({ ok: true }) };
  }
  if (u.includes("/hooks/")) { notified.push(JSON.parse(opts.body || "{}")); return { ok: true, text: async () => "{}" }; }
  if (u.includes("leadconnector")) return { ok: true, json: async () => ({ ok: true }), text: async () => "{}" };
  throw new Error("unmocked: " + u);
};

const worker = (await import("./src/index.js")).default;
const env = { WORKER_URL: "https://w.dev", TENANTS: kv, BOOKINGS: kv, ADMIN_SECRET: "admin123" };

// An enrich tenant WITH PayPal credentials -- the dangerous combination, since
// createOrder would succeed rather than throw.
await kv.put("L1", JSON.stringify({
  brandName: "Casa Bonita", currency: "USD", ownerPct: 0.85, processingFeePct: 0.06,
  invoiceStrategy: "enrich", gateway: "paypal",
  paypalClientId: "AX", paypalSecretName: "PP_SECRET", paypalApi: "https://api-m.sandbox.paypal.com",
  ghlPit: "pit", adminSecret: "admin123", tzOffsetHours: -4, checkInHour: 15,
  ghlRescheduleUrl: "https://services.leadconnectorhq.com/hooks/L1/webhook-trigger/abc",
  ghlDepositRefundUrl: "https://services.leadconnectorhq.com/hooks/L1/webhook-trigger/dep",
}));

const unpaidBooking = () => ({
  bookingId: "BK-UNPAID", locationId: "L1", settled: false,
  ghlInvoice: { invoiceId: "INV-1", status: "sent" },
  ghlContactId: "c1", guest: { name: "Ana Perez", email: "ana@example.invalid" },
  stay: { checkIn: "2030-03-01", checkOut: "2030-03-04", nights: 3, nightlyRate: 110 },
  charges: { rentTotal: 330, cleaningFee: 65, processingFee: 23.7, feePct: 0.06, grandTotal: 418.7 },
  securityDeposit: { total: 0 },
  payout: { basis: 330, ownerPct: 0.85, owner: 280.5, manager: 49.5 },
});

const reschedule = async (body) => {
  paypalOrderCalls = 0; invoicePuts = []; notified = [];
  await kv.put("BK-UNPAID", JSON.stringify(unpaidBooking()));
  const res = await worker.fetch({
    method: "POST", url: "https://w.dev/reschedule",
    json: async () => ({ bookingId: "BK-UNPAID", locationId: "L1", ...body }),
    headers: hdr("admin123"),
  }, env);
  return { status: res.status, body: JSON.parse(res.body) };
};

console.log("1) an unpaid reschedule reprices the invoice and creates no PayPal order");
{
  const { status, body } = await reschedule({ newCheckIn: "2030-04-01", newCheckOut: "2030-04-06" });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(paypalOrderCalls, 0,
    "the guest already has an invoice -- a PayPal order would be a second way to pay for one booking");
  assert.equal(invoicePuts.length, 1, "the existing invoice is updated exactly once");
  assert.equal(body.settlement.type, "unpaid_invoice_repriced");
  assert.equal(body.settlement.invoiceId, "INV-1");
}

// Five nights at 110 instead of three. The stay line was billed per night, so
// it stays per night with a new quantity rather than being flattened to a lump.
console.log("2) the stay line is repriced in the shape the guest is already looking at");
{
  await reschedule({ newCheckIn: "2030-04-01", newCheckOut: "2030-04-06" });
  const items = invoicePuts[0].invoiceItems;
  const stay = items.find((i) => i.name === "Estadía");
  assert.equal(stay.qty, 5, "5 nights");
  assert.equal(stay.amount, 110, "still billed per night, not flattened into one lump");
}

console.log("3) the snapshot follows the invoice, so the two cannot disagree");
{
  await reschedule({ newCheckIn: "2030-04-01", newCheckOut: "2030-04-06" });
  const snap = JSON.parse(store.get("BK-UNPAID"));
  assert.equal(snap.stay.nights, 5);
  assert.equal(snap.stay.checkIn, "2030-04-01");
  assert.equal(snap.charges.rentTotal, 550, "5 x 110");
  assert.equal(snap.reschedules.at(-1).invoiceId, "INV-1");
  assert.equal(snap.reschedules.at(-1).unpaid, true);
}

console.log("4) the notification says the guest pays the invoice they already hold");
{
  await reschedule({ newCheckIn: "2030-04-01", newCheckOut: "2030-04-06" });
  const n = notified.find((x) => x.event === "booking_rescheduled");
  assert.ok(n, "a reschedule notification is still sent");
  assert.equal(n.settlementType, "unpaid_invoice_repriced");
  assert.equal(n.approveUrl, "", "no new payment link, because none was created");
  assert.equal(n.invoiceNumber, "000042", "the invoice they already have");
  assert.equal(n.balanceDue, "585.00", "GHL's own amountDue after the reprice, not a locally computed total");
}

// A failed reprice must not move the dates. A snapshot saying one thing while
// the guest's invoice says another is the drift this file exists to prevent.
console.log("5) a refused reprice leaves the booking exactly where it was");
{
  const realFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    if (String(url).includes("/invoices/INV-1") && opts.method === "PUT") {
      return { ok: false, status: 422, text: async () => JSON.stringify({ message: "invoice locked" }) };
    }
    return realFetch(url, opts);
  };
  const { status, body } = await reschedule({ newCheckIn: "2030-04-01", newCheckOut: "2030-04-06" });
  global.fetch = realFetch;

  assert.equal(status, 502, "the caller is told, rather than getting a 200 over a half-done move");
  assert.ok(/reprice/i.test(body.error));
  const snap = JSON.parse(store.get("BK-UNPAID"));
  assert.equal(snap.stay.checkIn, "2030-03-01", "dates unchanged");
  assert.equal(snap.stay.nights, 3);
  assert.equal(paypalOrderCalls, 0, "and no PayPal order as a consolation prize");
}

// The other refusal, and a different code path: updateInvoiceForReschedule
// RETURNS { ok: false } rather than throwing when the invoice has no stay line
// to reprice. Test 5 covers the throw; without this one, deleting the
// `!repriced.ok` check kills nothing.
console.log("6) an invoice with nothing to reprice is refused too, not silently accepted");
{
  const realFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    if (String(url).includes("/invoices/INV-1") && opts.method !== "PUT") {
      // Only the Worker's own lines -- no stay line to re-quantify.
      return { ok: true, text: async () => JSON.stringify({
        _id: "INV-1", invoiceNumber: "000042", status: "sent", currency: "USD",
        invoiceItems: [{ name: "Cargo por procesamiento", amount: 23.7, qty: 1, currency: "USD" }],
      }) };
    }
    return realFetch(url, opts);
  };
  const { status, body } = await reschedule({ newCheckIn: "2030-04-01", newCheckOut: "2030-04-06" });
  global.fetch = realFetch;

  assert.equal(status, 502, "a reprice that refuses must not read as success");
  assert.equal(body.reason, "no_native_items", "the machine-readable slug");
  assert.match(body.detail, /no stay line to reprice/, "and the sentence a person reads");
  const snap = JSON.parse(store.get("BK-UNPAID"));
  assert.equal(snap.stay.nights, 3, "dates unchanged");
  assert.equal(paypalOrderCalls, 0);
}



// ---- the deposit-refund form, on a booking with no capture ----------------
// The account holder submits a form, it hits /deposit/refund, and the Worker
// works out what is owed. On a GHL-invoice booking settle() records captures.DEP
// with NO captureId -- the money sits with GHL's processor -- so this endpoint
// returned a 500 on every enrich account, which is all of them. Luminara feels
// it: Worker-sized deposits, on enrich, and a form nobody could use.
console.log("7) a deposit refund with no capture is computed and recorded, not refused");
{
  const realFetch = global.fetch;
  // A D1 mock, so the ledger row is asserted rather than lost to a missing
  // binding -- without it the write fails quietly and the test proves nothing
  // about what was recorded.
  const ledgerRows = [];
  const LEDGER_DB = {
    prepare: (sql) => ({
      bind: (...params) => ({
        async run() { if (/INSERT/i.test(sql)) ledgerRows.push(params); return { changes: 1 }; },
        async all() { return { results: [] }; },
      }),
    }),
    batch: async (stmts) => Promise.all(stmts.map((s) => s.run())),
  };
  let depositNotice = null;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("/hooks/")) { depositNotice = JSON.parse(opts.body || "{}"); return { ok: true, text: async () => "{}" }; }
    return realFetch(url, opts);
  };

  await kv.put("BK-DEP", JSON.stringify({
    ...unpaidBooking(), bookingId: "BK-DEP", settled: true,
    securityDeposit: { total: 500, status: "held" },
    // Exactly what settle() writes on the GHL-invoice path: a DEP capture with
    // no captureId on it.
    captures: { RENT: { source: "ghl_invoice", gross: 330 }, DEP: { source: "ghl_invoice", gross: 500 } },
  }));

  const res = await worker.fetch({
    method: "POST", url: "https://w.dev/deposit/refund",
    json: async () => ({ bookingId: "BK-DEP", locationId: "L1", claimAmount: 0 }),
    headers: hdr("admin123"),
  }, { ...env, LEDGER_DB });
  global.fetch = realFetch;
  const body = JSON.parse(res.body);

  assert.equal(res.status, 200, "the form must get an answer, not a 500: " + res.body);
  assert.equal(body.refundAmount, 500);
  assert.equal(body.manualRefund, true, "nothing was issued -- a person pays this");
  assert.equal(body.refundId, null);

  const snap = JSON.parse(store.get("BK-DEP"));
  assert.equal(snap.securityDeposit.status, "refunded");
  assert.equal(snap.securityDeposit.refundedAmount, 500);

  assert.ok(depositNotice, "the deposit webhook still fires");
  assert.equal(depositNotice.manualRefundRequired, "yes",
    "or the notification says a deposit was returned when no money moved");
  assert.equal(depositNotice.refundTotal, "500.00");

  // A deposit returned by hand is still a deposit returned. The row used to be
  // written only when a gateway issued the refund, so on every enrich account
  // the money left the business and the ledger never said so.
  const depRow = ledgerRows.find((p) => p.includes("deposit_refund_inspection"));
  assert.ok(depRow, "the refund belongs in the ledger whoever pays it");
  assert.ok(depRow.includes("manual_refund_pending"),
    "and referenced so it is greppable as something somebody still owes");
}


console.log("\nPASS — an unpaid booking's own invoice is repriced; no second payment route is ever created.");
