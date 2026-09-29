// A bundled reservation, end to end through /booking-created.
// Run: node test-multi-listing-wired.mjs
//
// The split now runs AFTER the invoice is enriched and sent, which is what
// makes it small. By then GHL's own lines are in hand and the processing fee
// and deposit have been computed across the whole reservation -- correct either
// way, since the fee is a flat percentage of everything on the invoice.
//
// What is still wrong at that point is the booking's shape: one stay, one
// property, one split, describing a reservation that has several of each.
import assert from "node:assert";

global.Response = class { constructor(b, i = {}) { this.body = b; this.status = i.status || 200; } async json() { return JSON.parse(this.body); } };
global.btoa = (s) => Buffer.from(s).toString("base64");

const LOC = "ZghxU8I60bEm39JUbtCm";
const BOOKING = "BK-BUNDLE";
const INVOICE = "inv-bundle-1";

const store = new Map();
const kv = {
  async get(k, o) { const v = store.get(k); return v == null ? null : (o?.type === "json" ? JSON.parse(v) : v); },
  async put(k, v) { store.set(k, v); },
};

const tenant = {
  brandName: "Casa Bonita", currency: "USD", ownerPct: 0.85, processingFeePct: 0.06,
  deposit: { rule: "none" }, invoiceStrategy: "enrich", ghlPit: "pit",
  webhookSecret: "s3cret", invoiceSenderUserId: "u1",
  propertyOwnerNames: { "Test Villa 2": "Carlos Mendoza", "Test Villa 3": "Rosa Jimenez" },
  ownerName: "Account Default Owner", managerName: "Account Default Manager",
};

// GHL's own invoice: one line per listing, plus a cleaning fee per listing.
const INVOICE_ITEMS = [
  { name: "Test Villa 2", amount: 135, qty: 3 },
  { name: "Test Villa 3", amount: 110, qty: 6 },
  { name: "Cleaning Fee", amount: 65, qty: 1 },
  { name: "Cleaning Fee", amount: 65, qty: 1 },
];

const SERVICES = [
  { id: "s1", serviceStartTime: "2026-11-02T15:00:00-04:00", serviceEndTime: "2026-11-05T11:00:00-04:00" },
  { id: "s2", serviceStartTime: "2026-11-05T15:00:00-04:00", serviceEndTime: "2026-11-11T11:00:00-04:00" },
];

let sentInvoice = false;
let urls = [];
const makeFetch = ({ services = SERVICES, items = INVOICE_ITEMS } = {}) => async (url, opts = {}) => {
  const u = String(url);
  urls.push(u);
  const ok = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
  if (u.includes("/calendars/services/bookings/")) return ok({ bookingId: BOOKING, services });
  if (u.includes(`/invoices/${INVOICE}/send`)) { sentInvoice = true; return ok({ invoice: { _id: INVOICE } }); }
  if (u.includes(`/invoices/${INVOICE}`) && opts.method === "PUT") return ok({ _id: INVOICE });
  if (u.includes(`/invoices/${INVOICE}`)) {
    return ok({ _id: INVOICE, invoiceNumber: "000030", status: "sent", currency: "USD",
      name: "Reserva", title: "Reserva", issueDate: "2026-10-01T04:00:00.000Z", dueDate: "2026-10-02T04:00:00.000Z",
      contactDetails: { id: "c1" }, businessDetails: { name: "Casa Bonita" },
      discount: { value: 0, type: "percentage" }, invoiceItems: items });
  }
  if (u.includes("/invoices")) return ok({ invoices: [{ _id: INVOICE, invoiceNumber: "000030", status: "sent", source: "calendar", sourceId: BOOKING, invoiceItems: items }] });
  return ok({ records: [], record: { id: "r" }, associations: [] });
};

const worker = (await import("./src/index.js")).default;
const env = { WORKER_URL: "https://w.dev", TENANTS: kv, BOOKINGS: kv, ADMIN_SECRET: "admin123" };
await kv.put(LOC, JSON.stringify(tenant));

const book = async (opts = {}) => {
  store.clear(); sentInvoice = false; urls = [];
  await kv.put(LOC, JSON.stringify(tenant));
  global.fetch = makeFetch(opts);
  const res = await worker.fetch(new Request("https://w.dev/booking-created", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Webhook-Secret": "s3cret" },
    body: JSON.stringify({
      bookingId: BOOKING, locationId: LOC, contactId: "c1",
      checkIn: "2026-11-02", checkOut: "2026-11-05", bookingTotal: 405, nights: 3,
      firstName: "Family", lastName: "Booking", email: "g@example.com", phone: "+18095550111",
      invoiceId: INVOICE, userId: "u1",
    }),
  }), env);
  return { status: res.status, body: await res.json() };
};

// ---- 1. the reservation is recognised and split ----------------------
{
  const out = await book();
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));
  assert.strictEqual(out.body.mode, "multi_listing_recorded");
  assert.strictEqual(out.body.listingCount, 2);
  assert.strictEqual(out.body.rentTotal, "1065.00", "405 + 660, not the webhook's 405");
  assert.deepStrictEqual(out.body.childBookingIds, [`${BOOKING}#1`, `${BOOKING}#2`]);
  console.log("1) A bundled reservation is recognised from the invoice and split into listings");
}

// ---- 2. the invoice still went to the guest --------------------------
// The split happens after the send, so a bundled guest gets their invoice
// exactly as a single-listing guest does. Getting this backwards would mean
// nobody could pay.
{
  await book();
  assert.strictEqual(sentInvoice, true, "the guest is still invoiced");
  console.log("2) The invoice is still enriched and sent before the split happens");
}

// ---- 3. each listing carries its own dates, rent and owner ----------
{
  await book();
  const a = JSON.parse(store.get(`${BOOKING}#1`));
  const b = JSON.parse(store.get(`${BOOKING}#2`));

  assert.deepStrictEqual([a.propertyCode, a.stay.checkIn, a.stay.checkOut, a.charges.rentTotal],
    ["Test Villa 2", "2026-11-02", "2026-11-05", 405]);
  assert.deepStrictEqual([b.propertyCode, b.stay.checkIn, b.stay.checkOut, b.charges.rentTotal],
    ["Test Villa 3", "2026-11-05", "2026-11-11", 660]);
  assert.strictEqual(a.payout.ownerName, "Carlos Mendoza");
  assert.strictEqual(b.payout.ownerName, "Rosa Jimenez", "the second listing pays its own owner");
  console.log("3) Each listing keeps its own dates, rent and owner");
}

// ---- 4. the parent keeps the money side -----------------------------
// The guest pays one invoice, so the invoice belongs to the reservation, not to
// either stay.
{
  await book();
  const parent = JSON.parse(store.get(BOOKING));
  assert.strictEqual(parent.type, "multi_listing_parent");
  assert.strictEqual(parent.ghlInvoice.invoiceId, INVOICE);
  assert.strictEqual(parent.gateway, "ghl_invoice");
  assert.strictEqual(parent.charges.rentTotal, 1065);
  assert.deepStrictEqual(parent.stayRange, { checkIn: "2026-11-02", checkOut: "2026-11-11" });
  console.log("4) The parent holds the invoice and the reservation's span");
}

// ---- 5. an ordinary booking is untouched ----------------------------
// One priced line means nothing changes -- no extra call, no parent, the
// snapshot exactly as before.
{
  const single = [{ name: "Test Villa 3", amount: 110, qty: 3 }, { name: "Cleaning Fee", amount: 65, qty: 1 }];
  const out = await book({ items: single });
  assert.notStrictEqual(out.body.mode, "multi_listing_recorded");
  const snap = JSON.parse(store.get(BOOKING));
  assert.strictEqual(snap.type, undefined, "still an ordinary booking snapshot");
  assert.strictEqual(store.get(`${BOOKING}#1`), undefined, "and no children were written");

  // And it costs nothing. The one-priced-line check exists to stop every
  // ordinary booking making a services call it will never use -- a redundant
  // guard for correctness, since pairListings refuses a single line anyway, but
  // the only thing standing between here and an extra API call on every single
  // booking this system processes. Relaxing it broke no test until this one.
  assert.ok(!urls.some((u) => u.includes("/calendars/services/bookings/")),
    "a single-listing booking never asks GHL for its service breakdown");
  console.log("5) A single-listing booking goes through unchanged, and makes no extra call");
}

// ---- 6. sources that disagree leave the booking alone, and say so ---
// Half-applying a split would be worse than not splitting: the invoice has
// already gone to the guest.
{
  const out = await book({ services: [SERVICES[0]] });
  assert.notStrictEqual(out.body.mode, "multi_listing_recorded");
  const snap = JSON.parse(store.get(BOOKING));
  assert.strictEqual(snap.type, undefined, "the booking is left exactly as it was");
  assert.strictEqual(snap.multiListingSkipped.reason, "listing_count_mismatch");
  assert.strictEqual(snap.multiListingSkipped.pricedLines, 2);
  assert.strictEqual(snap.multiListingSkipped.datedListings, 1,
    "and the refusal is on the record rather than only in a log");
  console.log("6) Two sources that disagree leave the booking intact and record why");
}

// ---- 7. paying a bundled reservation is refused, not mishandled -----
// The parent has no stay, so settling it would price a booking with no nights.
// It has to say that rather than fail on a missing field somewhere deeper.
{
  await book();
  const { handleGhlInvoicePaid } = await import("./src/payment.js");
  global.fetch = async (url) => {
    const ok = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
    if (String(url).includes("/invoices/")) {
      return ok({ _id: INVOICE, invoiceNumber: "000030", status: "paid", total: 1198.9, amountPaid: 1198.9,
        altId: LOC, source: "calendar", sourceId: BOOKING });
    }
    return ok({ records: [], record: { id: "r" } });
  };
  const res = await handleGhlInvoicePaid({
    method: "POST", url: "https://w.dev/ghl-invoice-paid",
    json: async () => ({ invoiceId: INVOICE, locationId: LOC, secret: "s3cret" }),
    headers: { get: () => null },
  }, env);
  const body = await res.json();

  assert.strictEqual(body.skipped, "multi_listing_not_settled");
  assert.strictEqual(body.listingCount, 2);

  // Two different facts, two different names. amountPaid is the GHL-facing
  // "what we confirmed and booked", which is nothing -- and a workflow reading
  // it is entitled to assume that. What the guest actually handed over is
  // amountReceived. The first version of this collided them, and the spread
  // silently won.
  assert.strictEqual(body.amountReceived, 1198.9, "the payment is acknowledged");
  assert.strictEqual(body.amountPaid, "0.00", "while nothing is claimed to have been booked");
  console.log("7) A paid bundled reservation is refused explicitly, naming what was not written");
}

console.log("\nPASS — a bundled reservation is invoiced once, split into its listings, and says plainly that settlement is not wired.");
