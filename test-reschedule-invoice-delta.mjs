// The extra nights have to be payable by the guest who paid the invoice.
// Run: node test-reschedule-invoice-delta.mjs
//
// DEMO-HOMS booking SiKoozWmXBEFIaiIqOkO, 2026-09-28. Extended three nights to
// five to seven; the Transaction record repriced correctly each time and the
// guest's invoice never moved off "paid". Mara went looking for the balance and
// found none.
//
// The reason was not a missing feature. reschedule.js branched on
// tenant.gateway, which on DEMO-HOMS reads "paypal" with a sandbox API URL,
// while the booking itself settled as "ghl_invoice". So a PayPal sandbox order
// WAS raised for the difference, against an instrument the guest has no
// relationship with, and no workflow surfaces the link. Real intent, orphaned.
//
// Which gateway settles a difference is a fact about the booking, not the
// account.
import assert from "node:assert";

global.Response = class { constructor(b, i = {}) { this.body = b; this.status = i.status || 200; } async json() { return JSON.parse(this.body); } };
global.btoa = (s) => Buffer.from(s).toString("base64");

const LOC = "ZghxU8I60bEm39JUbtCm";
const BOOKING = "SiKoozWmXBEFIaiIqOkO";
const INVOICE = "6ab8075da480a05c4a4a5000";

const store = new Map();
const kv = {
  async get(k, o) { const v = store.get(k); return v == null ? null : (o?.type === "json" ? JSON.parse(v) : v); },
  async put(k, v) { store.set(k, v); },
};
const hdr = (s) => ({ get: (n) => (n === "X-Admin-Secret" ? s : null) });

// The account is configured for PayPal. The booking was not paid that way.
const tenant = {
  brandName: "Casa Bonita", currency: "USD", ownerPct: 0.85, processingFeePct: 0.06,
  defaultCleaningFee: 65, cleaningFeeRecipient: "manager", bookingWorkerEnabled: true,
  gateway: "paypal", deposit: { rule: "none" },
  paypalApi: "https://api-m.sandbox.paypal.com", paypalClientId: "C", paypalSecret: "S",
  adminSecret: "admin123", ghlPit: "pit", tzOffsetHours: -4, checkInHour: 15,
};

const paidSnapshot = (over = {}) => ({
  bookingId: BOOKING, locationId: LOC, ghlContactId: "c1", propertyCode: "Test Villa 3",
  createdAt: "2026-09-27T01:51:00.000Z",
  guest: { name: "Reschedule Test", email: "g@example.com" },
  stay: { checkIn: "2026-10-17", checkOut: "2026-10-20", nights: 3, nightlyRate: 110 },
  charges: { rentTotal: 330, cleaningFee: 65, processingFee: 23.7, feePct: 0.06, grandTotal: 418.7 },
  securityDeposit: { total: 0, blocks: [], status: "none" },
  payout: { basis: 330, ownerPct: 0.85, owner: 280.5, manager: 49.5, cleaningFeeTo: "manager", status: "paid" },
  gateway: "ghl_invoice", settled: true,
  captures: { RENT: { gross: 418.7, source: "ghl_invoice", invoiceNumber: "000013" } },
  ghlInvoice: { invoiceId: INVOICE, status: "paid", sentAt: "2026-09-27T01:51:06Z" },
  ghl: { transactionId: "tx-1", paymentIds: [] },
  ...over,
});

// The invoice as GHL holds it: a per-night stay line, a cleaning line, and our
// own processing fee line appended at booking time.
const invoiceOnFile = () => ({
  _id: INVOICE, invoiceNumber: "000013", status: "paid", total: 418.7, amountDue: 0,
  name: "Reserva SiKoozWmXBEFIaiIqOkO", title: "Reserva", currency: "USD",
  issueDate: "2026-09-27T04:00:00.000Z", dueDate: "2026-09-28T04:00:00.000Z",
  contactDetails: { id: "c1", name: "Reschedule Test", email: "g@example.com" },
  businessDetails: { name: "Casa Bonita" },
  discount: { value: 0, type: "percentage" },
  invoiceItems: [
    { name: "Test Villa 3", amount: 110, qty: 3 },
    { name: "Cleaning Fee", amount: 65, qty: 1 },
    { name: "Cargo por procesamiento / Processing fee", amount: 23.7, qty: 1 },
  ],
});

let invoicePuts = [];
let gatewayCalls = [];
const makeFetch = (invoice = invoiceOnFile()) => async (url, opts = {}) => {
  const u = String(url);
  const ok = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });
  if (u.includes("paypal") || u.includes("stripe")) { gatewayCalls.push(u); return ok({ id: "PP-1", links: [{ rel: "payer-action", href: "https://x" }], access_token: "T" }); }
  if (u.includes(`/invoices/${INVOICE}`) && opts.method === "PUT") {
    const body = JSON.parse(opts.body);
    invoicePuts.push(body);
    const total = body.invoiceItems.reduce((s, i) => s + Number(i.amount) * Number(i.qty ?? 1), 0);
    return ok({ ...invoice, ...body, total, amountDue: Math.round((total - 418.7) * 100) / 100, status: "partially_paid" });
  }
  if (u.includes(`/invoices/${INVOICE}`)) return ok(invoice);
  if (u.includes("backend.leadconnectorhq.com/calendars/bookings/details/")) {
    return ok({ serviceBooking: { contactId: "c1", appointmentTitle: "stay", deleted: false,
      services: [{ id: "s1", position: 0, name: "Test Villa 3", price: 110, unitPrice: 110, startDate: "o", endDate: "o" }] } });
  }
  if (u.includes("/hooks/")) return ok({});
  return ok({ records: [], record: { id: "r" }, associations: [], ok: true });
};

const worker = (await import("./src/index.js")).default;
const env = { WORKER_URL: "https://w.dev", TENANTS: kv, BOOKINGS: kv, ADMIN_SECRET: "admin123" };
await kv.put(LOC, JSON.stringify(tenant));

const reschedule = async (newCheckOut, { snapshot = paidSnapshot(), invoice } = {}) => {
  invoicePuts = []; gatewayCalls = [];
  global.fetch = makeFetch(invoice ?? invoiceOnFile());
  await kv.put(BOOKING, JSON.stringify(snapshot));
  const res = await worker.fetch({
    method: "POST", url: "https://w.dev/reschedule",
    json: async () => ({ bookingId: BOOKING, newCheckIn: "2026-10-17", newCheckOut, reason: "guest asked" }),
    headers: hdr("admin123"),
  }, env);
  return { status: res.status, body: await res.json() };
};

// ---- 1. the difference lands on the guest's own invoice ---------------
// Three nights to five: two more at 110.
{
  const out = await reschedule("2026-10-22");
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));
  assert.strictEqual(invoicePuts.length, 1, "the existing invoice is repriced, once");
  assert.deepStrictEqual(gatewayCalls, [], "and no gateway order is raised for a guest who paid by invoice");
  console.log("1) An extension reprices the invoice the guest already has, and calls no gateway");
}

// ---- 2. the stay line keeps the shape the guest is looking at --------
// It was billed 3 x 110. It becomes 5 x 110, not 1 x 550 -- the total would be
// right either way and the invoice would be worse.
{
  await reschedule("2026-10-22");
  const items = invoicePuts[0].invoiceItems;
  assert.deepStrictEqual(
    { name: items[0].name, amount: items[0].amount, qty: items[0].qty },
    { name: "Test Villa 3", amount: 110, qty: 5 },
    "per-night stays per night"
  );
  assert.deepStrictEqual(items[1], { name: "Cleaning Fee", amount: 65, qty: 1 },
    "and the lines that did not change are passed straight back");
  console.log("2) A per-night stay line gains nights rather than collapsing into a lump sum");
}

// ---- 3. our own lines are rebuilt, never duplicated ------------------
// The processing fee was already on the invoice from booking time. Appending a
// second one is the failure this convention exists to prevent.
{
  await reschedule("2026-10-22");
  const items = invoicePuts[0].invoiceItems;
  const fees = items.filter((i) => i.name === "Cargo por procesamiento / Processing fee");
  assert.strictEqual(fees.length, 1, "exactly one processing fee line, not two");
  assert.ok(fees[0].amount > 23.7, "and it is recomputed for the longer stay, not echoed");
  console.log("3) The Worker's own invoice lines are rebuilt from the new totals, not appended again");
}

// ---- 4. the two undocumented 422 traps are still paid ----------------
// discount and businessDetails are both required despite neither being marked
// so, and issueDate/dueDate must be date-only. Each one 422s the whole PUT.
{
  await reschedule("2026-10-22");
  const body = invoicePuts[0];
  assert.ok(body.discount, "discount is echoed -- omitting it 422s");
  assert.ok(body.businessDetails, "so is businessDetails");
  assert.match(body.issueDate, /^\d{4}-\d{2}-\d{2}$/, "dates are date-only, not the datetime GHL returns");
  assert.match(body.dueDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.strictEqual(body.altId, LOC, "and altId, without which the invoices service 401s");
  console.log("4) The PUT carries every field GHL requires but does not document");
}

// ---- 5. what GHL decided is reported, not what we assumed ------------
{
  const out = await reschedule("2026-10-22");
  const resched = JSON.parse(store.get(BOOKING)).reschedules.at(-1);
  assert.strictEqual(resched.settlement.type, "invoice_balance_due");
  assert.strictEqual(resched.settlement.status, "partially_paid",
    "GHL flips the status itself once the total exceeds what was paid");
  assert.ok(resched.settlement.amountDue > 0, "and computes the balance due");
  assert.strictEqual(resched.settlement.invoiceNumber, "000013", "against the invoice the guest knows by number");
  console.log("5) The settlement records the status and balance GHL itself computed");
}

// ---- 6. a booking that really did pay by gateway is untouched --------
// The fix must not send every tenant down the invoice path.
{
  const viaPaypal = paidSnapshot({
    gateway: "paypal",
    captures: { RENT: { gross: 418.7, captureId: "cap-1", source: "paypal" } },
    ghlInvoice: undefined,
  });
  const out = await reschedule("2026-10-22", { snapshot: viaPaypal });
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));
  assert.deepStrictEqual(invoicePuts, [], "no invoice is touched");
  assert.ok(gatewayCalls.length > 0, "and the PayPal order is still raised, as it always was");
  const resched = JSON.parse(store.get(BOOKING)).reschedules.at(-1);
  assert.strictEqual(resched.settlement.type, "additional_charge_pending");
  console.log("6) A booking actually settled by gateway still gets a gateway charge");
}

// ---- 7. a reprice that fails does not undo the reschedule -----------
// The dates have moved and the ledger is about to be written. Throwing here
// would leave the caller unable to tell which half happened.
{
  const out = await reschedule("2026-10-22", { invoice: { ...invoiceOnFile(), invoiceItems: [] } });
  assert.strictEqual(out.status, 200, "the reschedule still succeeds");
  const snap = JSON.parse(store.get(BOOKING));
  assert.strictEqual(snap.stay.nights, 5, "and the dates did move");
  const settlement = snap.reschedules.at(-1).settlement;
  assert.strictEqual(settlement.ok, false, "while the settlement says plainly that it did not reprice");
  assert.strictEqual(settlement.reason, "no_native_items");
  console.log("7) An invoice that cannot be repriced is reported, and never rolls back the reschedule");
}

console.log("\nPASS — a stay extended on an invoiced booking becomes a balance due on that invoice, not an orphaned gateway order.");
