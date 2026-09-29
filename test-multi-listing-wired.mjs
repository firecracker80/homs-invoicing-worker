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
  // Set so case 11 can prove nothing is posted to it. Without a URL here,
  // notifyAndRecord has nowhere to post and the assertion passes on a tenant
  // that could not have been notified in the first place.
  ghlPaymentConfirmedUrl: "https://ghl.test/payment-confirmed",
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

  // Cleaning is per listing, and the invoice carries one line per listing to
  // match. Nothing was reading them: composeBooking sets cleaningFee to 0 and
  // the enrich step that fills it back in has already run by the time the
  // children exist. On the DEMO-HOMS booking that found this, 130.00 of
  // cleaning the guest had paid belonged to no listing at all.
  assert.strictEqual(a.charges.cleaningFee, 65, "the first listing earns its own cleaning fee");
  assert.strictEqual(b.charges.cleaningFee, 65, "and so does the second");

  // And the processing fee follows it, because the guest was charged a
  // percentage of the cleaning too. Without this the children sum to less than
  // the invoice, which is the number settlement divides.
  assert.strictEqual(a.charges.processingFee, 28.2, "6% of 405 + 65");
  assert.strictEqual(b.charges.processingFee, 43.5, "6% of 660 + 65");
  console.log("3) Each listing keeps its own dates, rent, owner and cleaning fee");
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
  assert.strictEqual(parent.charges.cleaningFee, 130, "both cleaning lines, summed from the children");
  assert.strictEqual(parent.charges.processingFee, 71.7, "6% of rent + cleaning across the reservation");
  assert.deepStrictEqual(parent.stayRange, { checkIn: "2026-11-02", checkOut: "2026-11-11" });

  // The children have to add up to what the guest is being charged, because
  // that is the sum settlement divides. Anything left over is a discrepancy,
  // and a parent that quietly disagreed with its own children by the fee on
  // the cleaning would make every real discrepancy unreadable.
  const childTotal = Math.round((JSON.parse(store.get(`${BOOKING}#1`)).charges.grandTotal
    + JSON.parse(store.get(`${BOOKING}#2`)).charges.grandTotal) * 100) / 100;
  assert.strictEqual(childTotal, 1266.7);
  assert.strictEqual(
    Math.round((parent.charges.rentTotal + parent.charges.cleaningFee + parent.charges.processingFee) * 100) / 100,
    childTotal,
    "the parent and its children price the same reservation"
  );
  console.log("4) The parent holds the invoice and the span, and agrees with its children to the cent");
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

// ---- 7..11 paying a bundled reservation ---------------------------
// One invoice over several stays settles as several bookings. The parent has no
// stay of its own, so it cannot be priced -- and until this existed it was not
// priced at all: the whole payment returned "not settled" and nothing reached
// the ledger.
const { handleGhlInvoicePaid } = await import("./src/payment.js");

let objectPosts = [];
let confirmPosts = [];
const payInvoice = async ({ amountPaid = 1266.7 } = {}) => {
  objectPosts = []; confirmPosts = [];
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const ok = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
    if (u.includes("/objects/") && opts.method === "POST") objectPosts.push(JSON.parse(opts.body || "{}"));
    if (u === tenant.ghlPaymentConfirmedUrl) { confirmPosts.push(u); return ok({}); }
    if (u.includes("/invoices/")) {
      return ok({ _id: INVOICE, invoiceNumber: "000030", status: "paid", total: amountPaid, amountPaid,
        altId: LOC, source: "calendar", sourceId: BOOKING });
    }
    return ok({ records: [], record: { id: "r" } });
  };
  const res = await handleGhlInvoicePaid({
    method: "POST", url: "https://w.dev/ghl-invoice-paid",
    json: async () => ({ invoiceId: INVOICE, locationId: LOC, secret: "s3cret" }),
    headers: { get: () => null },
  }, env);
  return { status: res.status, body: await res.json() };
};

{
  await book();
  const out = await payInvoice();

  assert.strictEqual(out.status, 200, JSON.stringify(out.body));
  assert.strictEqual(out.body.settled, true);
  assert.strictEqual(out.body.multiListing, true);
  assert.strictEqual(out.body.listingCount, 2);

  const a = JSON.parse(store.get(`${BOOKING}#1`));
  const b = JSON.parse(store.get(`${BOOKING}#2`));
  assert.strictEqual(a.settled, true, "the first listing is settled in its own right");
  assert.strictEqual(b.settled, true, "and so is the second");
  assert.strictEqual(JSON.parse(store.get(BOOKING)).settled, true, "and the reservation as a whole");
  console.log("7) A paid bundled reservation settles as each of its listings");
}

// ---- 8. each listing is priced on its own money, and they add up ----
// The division needs no apportioning rule, because each child already holds
// what the guest was charged for it. That only adds up because the cleaning
// fee -- and the processing fee on the cleaning -- reached the children at all.
{
  await book();
  const out = await payInvoice();
  assert.deepStrictEqual(
    out.body.listings.map((l) => l.amount), [498.2, 768.5],
    "405 + 65 + 28.20, and 660 + 65 + 43.50"
  );
  assert.strictEqual(out.body.allocated, 1266.7);
  assert.strictEqual(out.body.variance, undefined, "nothing is left over on a reservation that adds up");
  console.log("8) Each listing settles on its own money, and the listings account for the whole invoice");
}

// ---- 9. money that does not add up is recorded, never spread --------
// Spreading a discrepancy over the listings would make the books balance by
// moving somebody's split. A part payment, a manual GHL adjustment or a
// missing child all land here, and all have to stay visible.
{
  await book();
  const out = await payInvoice({ amountPaid: 1200 });
  assert.strictEqual(out.body.allocated, 1266.7, "the listings are priced on what they cost");
  assert.strictEqual(out.body.variance, -66.7, "and the shortfall is stated rather than absorbed");
  assert.deepStrictEqual(
    out.body.listings.map((l) => l.amount), [498.2, 768.5],
    "no listing's split moved to make the total work"
  );
  assert.strictEqual(JSON.parse(store.get(BOOKING)).settlement.variance, -66.7,
    "and it is on the record, not only in a log");
  console.log("9) A payment that does not match the listings is recorded as a variance, not spread over them");
}

// ---- 10. a listing that fails leaves the reservation retryable ------
{
  await book();
  store.delete(`${BOOKING}#2`);
  const out = await payInvoice();

  assert.strictEqual(out.status, 207, "partial settlement is not a success");
  assert.strictEqual(out.body.settled, false);
  assert.deepStrictEqual(out.body.failedListings, [{ bookingId: `${BOOKING}#2`, reason: "child_missing" }],
    "and the listing that failed is named, not counted");

  const parent = JSON.parse(store.get(BOOKING));
  assert.notStrictEqual(parent.settled, true,
    "the reservation stays unsettled so the same webhook firing again finishes it");
  assert.strictEqual(JSON.parse(store.get(`${BOOKING}#1`)).settled, true,
    "while the listing that did settle keeps its settlement");

  // The retry. settle() is idempotent per booking, so the listing that already
  // went through must not be paid a second time -- it reports back rather than
  // writing another set of ledger rows.
  store.set(`${BOOKING}#2`, JSON.stringify({
    ...JSON.parse(store.get(`${BOOKING}#1`)), bookingId: `${BOOKING}#2`, settled: false, settledAt: null,
  }));
  const retry = await payInvoice();
  assert.strictEqual(retry.status, 200);
  assert.strictEqual(retry.body.settled, true, "the retry finishes the reservation");
  assert.strictEqual(retry.body.listings[0].alreadySettled, true,
    "without settling the listing that was already done twice");
  console.log("10) A listing that fails leaves the reservation retryable, and the retry does not double-settle");
}

// ---- 11. one reservation, one confirmation --------------------------
// The guest booked once and paid once. The cancellation fan-out sends one
// notification per listing, which is how a bundled cancellation reached the
// guest twice -- this deliberately does not copy it.
{
  await book();
  const out = await payInvoice();
  assert.strictEqual(confirmPosts.length, 0,
    "the GHL-invoice route never posts back to the workflow that called it");
  assert.strictEqual(out.body.event, "payment_confirmed", "the response is the confirmation");
  assert.strictEqual(out.body.amountPaid, "1266.70", "for the whole reservation");
  assert.strictEqual(out.body.propertyName, "Test Villa 2 + Test Villa 3", "naming every listing on it");
  assert.strictEqual(out.body.checkIn, "2026-11-02");
  assert.strictEqual(out.body.checkOut, "2026-11-11", "over the reservation's whole span, not one listing's");
  console.log("11) One reservation gets one confirmation, covering every listing on it");
}

// ---- 12. paid after cancellation, on a bundled reservation ----------
// A guest can pay an invoice that is still sitting in their inbox after the
// booking was cancelled, and on a bundled reservation the bundled branch used
// to answer first -- so the money came back as "not settled yet", which reads
// as a system that has not got round to it rather than money owed back to
// somebody. Cancelled is checked first now.
{
  await book();
  const parent = JSON.parse(store.get(BOOKING));
  parent.cancelled = true;
  parent.cancellation = { at: "2026-10-20T12:00:00.000Z", reason: "guest cancelled" };
  store.set(BOOKING, JSON.stringify(parent));

  const out = await payInvoice();
  assert.strictEqual(out.body.skipped, "booking_cancelled", "not a settlement, and not a bundled skip");
  assert.strictEqual(out.body.refundOwed, 1266.7, "the money is named as owed back");
  assert.strictEqual(JSON.parse(store.get(`${BOOKING}#1`)).settled, undefined,
    "and no listing was settled on a reservation nobody is honouring");
  console.log("12) A bundled reservation paid after cancellation escalates instead of settling");
}

// ---- 13..14 a pet fee on a bundled invoice --------------------------
// Everything the guest was charged that is neither the stay nor its cleaning
// belonged to no listing, so a bundled booking with a pet fee settled short by
// the fee plus the processing charged on it -- and reported it as a variance,
// on a reservation with nothing actually wrong. A variance that fires on an
// ordinary booking is worse than no variance at all: it is the signal that a
// real shortfall was supposed to raise.
const WITH_PET = [...INVOICE_ITEMS, { name: "Pet Fee", amount: 300, qty: 1 }];

{
  await book({ items: WITH_PET });
  const a = JSON.parse(store.get(`${BOOKING}#1`));
  const b = JSON.parse(store.get(`${BOOKING}#2`));

  // One pet fee across two listings cannot be attributed, so it is kept whole
  // on the first and flagged rather than split on a guess.
  assert.strictEqual(a.charges.otherFees, 300);
  assert.strictEqual(b.charges.otherFees, undefined, "the second listing earns none of it");
  assert.strictEqual(JSON.parse(store.get(BOOKING)).feePairing.reason, "fee_line_count_mismatch",
    "and the reservation records that the attribution is a fallback, not a pairing");

  // The processing fee follows it, because the guest paid a percentage of the
  // pet fee too.
  assert.strictEqual(a.charges.processingFee, 46.2, "6% of 405 + 65 + 300");
  assert.strictEqual(a.charges.grandTotal, 816.2);
  assert.strictEqual(b.charges.processingFee, 43.5, "6% of 660 + 65, unchanged");

  // The parent re-sums it from the children, the same as cleaning. Settlement
  // divides the payment by the children, so a parent that did not carry what
  // they carry would describe a different reservation from the one being paid.
  const parent = JSON.parse(store.get(BOOKING));
  assert.strictEqual(parent.charges.otherFees, 300);
  assert.strictEqual(
    Math.round((parent.charges.rentTotal + parent.charges.cleaningFee
      + parent.charges.otherFees + parent.charges.processingFee) * 100) / 100,
    1584.7,
    "and the reservation adds up to the invoice the guest was sent"
  );
  console.log("13) A pet fee lands on a listing, and the processing fee on it follows");
}

{
  // The number that proves it: 1584.70 is the whole invoice -- 1065 of rent,
  // 130 of cleaning, 300 of pet fee and 89.70 of processing on all of it.
  await book({ items: WITH_PET });
  const out = await payInvoice({ amountPaid: 1584.7 });

  assert.strictEqual(out.body.allocated, 1584.7, "the listings account for every cent on the invoice");
  assert.strictEqual(out.body.variance, undefined,
    "so nothing is reported as unexplained -- it used to be 318.00, the pet fee plus its 6%");
  assert.deepStrictEqual(out.body.listings.map((l) => l.amount), [816.2, 768.5]);
  console.log("14) A bundled reservation with a pet fee settles whole, with no variance left over");
}

// ---- 15. and none of it is quietly turned into income ---------------
// No ledger row credits a pet fee to anyone on a single-listing booking --
// cleaning is the only native fee that is split -- so a bundled booking
// inventing one would pay somebody money their own single bookings do not.
// Whether these fees SHOULD be income, and whose, is a question about the
// business rather than about bundling.
{
  await book({ items: WITH_PET });
  const a = JSON.parse(store.get(`${BOOKING}#1`));
  assert.strictEqual(a.payout.basis, a.charges.rentTotal,
    "the split is still on rent alone, with the pet fee outside it");
  assert.strictEqual(a.payout.owner + a.payout.manager, a.charges.rentTotal,
    "so nobody is credited with the fee, the same as on a single booking");
  console.log("15) The fee is attached to a listing without being made income nobody else earns");
}

console.log("\nPASS — a bundled reservation is invoiced once, split into its listings, and settles as each of them.");
