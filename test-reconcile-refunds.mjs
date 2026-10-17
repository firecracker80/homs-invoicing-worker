// What the Worker said is owed, against what the processor says went back.
// Run: node test-reconcile-refunds.mjs
//
// Every refund on every live account is issued by hand: the Worker prices it and
// a person pays it. Nothing compared the two. MANUAL_REFUND_REF marked the
// ledger rows pending and no code path ever cleared it, so the "owed" list could
// only grow -- 12 bookings carried the marker on 2026-10-16, one of them already
// paid in full.
//
// The answer was not a route for a person to tick off. GHL records the truth on
// its own payment transaction, and /reports/reconcile already fetched those
// transactions for the unmatched check -- reading entityId and discarding status
// and amountRefunded.
//
// Figures throughout are the live Villa Azul cancellation (invoice 000035,
// booking Lr9D99uSMEtqBtDU5D6m): captured 1,754.30, priced refund 935.00,
// retained 819.30, and GHL reporting status "partially_refunded" with
// amountRefunded 935.
import assert from "node:assert";

global.Response = class { constructor(b, i = {}) { this.body = b; this.status = i.status || 200; } async json() { return JSON.parse(this.body); } };
global.btoa = (s) => Buffer.from(s).toString("base64");

const LOC = "ZghxU8I60bEm39JUbtCm";
const INVOICE = "6ad215ec07479c1eab6d6f3b";

const store = new Map();
const kv = {
  async get(k, o) { const v = store.get(k); return v == null ? null : (o?.type === "json" ? JSON.parse(v) : v); },
  async put(k, v) { store.set(k, v); },
};

// One income row per booking is all reconcile reads from D1.
const ledgerRows = [];
const ledgerDb = {
  prepare: () => ({
    bind: () => ({
      all: async () => ({ results: ledgerRows }),
      run: async () => ({ changes: 1 }),
    }),
  }),
  batch: async () => [],
};

let mockTransactions = [];
global.fetch = async (url) => {
  const u = String(url);
  const ok = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o), json: async () => o });
  if (u.includes("/payments/transactions")) return ok({ data: mockTransactions });
  return ok({});
};

const { handleReconcile } = await import("./src/reports.js");
const env = { TENANTS: kv, BOOKINGS: kv, LEDGER_DB: ledgerDb, ADMIN_SECRET: "admin123" };
await kv.put(LOC, JSON.stringify({ brandName: "Casa Bonita", ghlPit: "pit", adminSecret: "admin123" }));

const cancelled = (totalRefund) => ({
  bookingId: "BK-CANCEL", locationId: LOC,
  charges: { rentTotal: 1200, cleaningFee: 65, processingFee: 99.3 },
  securityDeposit: { total: 350, refundedAmount: 350, source: "ghl_native", status: "refunded" },
  captures: { RENT: { invoiceId: INVOICE, gross: 1754.3 } },
  cancelled: true,
  cancellation: { tier: "under_120h", totalRefund, totalRetained: 819.3, depositRefund: 350 },
});

async function reconcile() {
  const res = await handleReconcile({
    method: "GET",
    url: `https://w.dev/reports/reconcile?locationId=${LOC}&from=2026-10-01&to=2026-10-31`,
    headers: { get: (n) => (n === "X-Admin-Secret" ? "admin123" : null) },
  }, env);
  return res.json();
}

const seed = async ({ bookingId = "BK-CANCEL", snapshot, transactions }) => {
  ledgerRows.length = 0;
  ledgerRows.push({ booking_id: bookingId, invoice_id: INVOICE, invoice_number: "000035" });
  store.delete(bookingId);
  if (snapshot) await kv.put(bookingId, JSON.stringify(snapshot));
  mockTransactions = transactions;
};

// ---- 1. priced and nothing paid back: owed -------------------------------
// The list that matters, and the one the stale ledger marker was pretending to
// be. Sourced from the processor, so it empties itself when somebody pays.
{
  await seed({
    snapshot: cancelled(935),
    transactions: [{ entityId: INVOICE, status: "succeeded", amountRefunded: 0 }],
  });
  const out = await reconcile();
  assert.strictEqual(out.refunds.length, 1);
  assert.strictEqual(out.refunds[0].state, "owed");
  assert.strictEqual(out.refunds[0].expected, 935);
  assert.strictEqual(out.refunds[0].refunded, 0);
  assert.strictEqual(out.refundSummary.owed, 1);
  assert.strictEqual(out.refundSummary.owedTotal, 935, "and the total owed is reported, so it can be read at a glance");
  console.log("1) A priced refund with nothing paid back reads as owed, and totals 935");
}

// ---- 2. paid in full: settled --------------------------------------------
// The live state of the Villa Azul booking. Its ledger rows still carry
// manual_refund_pending, and this is what says that marker is stale.
{
  await seed({
    snapshot: cancelled(935),
    transactions: [{ entityId: INVOICE, status: "partially_refunded", amountRefunded: 935 }],
  });
  const out = await reconcile();
  assert.strictEqual(out.refunds[0].state, "settled");
  assert.match(out.refunds[0].note, /stale/i, "and says the pending marker is stale rather than outstanding");
  assert.strictEqual(out.refundSummary.owed, 0, "a settled refund is not owed");
  assert.strictEqual(out.refundSummary.settled, 1);
  console.log("2) A refund paid in full reads as settled, and reports the ledger marker as stale");
}

// ---- 3. the wrong amount: mismatch ---------------------------------------
// The case this was built for. The cancellation notification went out saying
// 585 before the deposit bug was fixed; the real figure was 935. Anyone acting
// on that email leaves the guest 350 short, and nothing else would say so.
{
  await seed({
    snapshot: cancelled(935),
    transactions: [{ entityId: INVOICE, status: "partially_refunded", amountRefunded: 585 }],
  });
  const out = await reconcile();
  const r = out.refunds[0];
  assert.strictEqual(r.state, "mismatch");
  assert.strictEqual(r.delta, -350, "the shortfall is the deposit the pre-fix notification omitted");
  assert.match(r.note, /LESS/, "and names the direction, because under and over need different responses");
  assert.strictEqual(out.refundSummary.mismatch, 1);
  assert.strictEqual(out.refundSummary.owed, 0, "a mismatch is not owed -- part of it was paid, which is a different problem");
  console.log("3) Refunding 585 against a priced 935 reads as a mismatch of -350");
}

// ---- 4. over-refunded is its own direction -------------------------------
// The other half of case 3, or "any difference is a shortfall" would pass it.
{
  await seed({
    snapshot: cancelled(935),
    transactions: [{ entityId: INVOICE, status: "refunded", amountRefunded: 1754.3 }],
  });
  const out = await reconcile();
  assert.strictEqual(out.refunds[0].state, "mismatch");
  assert.strictEqual(out.refunds[0].delta, 819.3, "the whole capture went back, so the retained charge went with it");
  assert.match(out.refunds[0].note, /MORE/);
  console.log("4) Refunding the whole 1,754.30 reads as +819.30 over, not as settled");
}

// ---- 5. a failed attempt is not a zero refund ----------------------------
// The Villa Azul invoice carries THREE transactions: one succeeded and two
// failed PayPal orders. Counting a failed attempt as a successful zero-refund
// would report a paid refund as owed.
{
  await seed({
    snapshot: cancelled(935),
    transactions: [
      { entityId: INVOICE, status: "failed", amountRefunded: 0 },
      { entityId: INVOICE, status: "failed", amountRefunded: 0 },
      { entityId: INVOICE, status: "partially_refunded", amountRefunded: 935 },
    ],
  });
  const out = await reconcile();
  assert.strictEqual(out.refunds.length, 1, "three transactions on one invoice are one booking, not three");
  assert.strictEqual(out.refunds[0].state, "settled",
    "the two failed attempts must not drag a settled refund back to owed");
  assert.ok(!out.refunds[0].ghlStatus.includes("failed"), "and the failed ones are not reported as its status");
  console.log("5) Failed payment attempts on the same invoice are ignored, not read as zero refunds");
}

// ---- 6. a refund nobody priced -------------------------------------------
// Money back on a booking with no cancellation and no deposit release. Either
// it was refunded outside the system or against the wrong invoice; both need a
// person, and neither is "owed".
{
  await seed({
    snapshot: {
      bookingId: "BK-CANCEL", locationId: LOC,
      charges: { rentTotal: 1200, cleaningFee: 65, processingFee: 99.3 },
      securityDeposit: { total: 350, refundedAmount: null, status: "held" },
      captures: { RENT: { invoiceId: INVOICE, gross: 1754.3 } },
    },
    transactions: [{ entityId: INVOICE, status: "partially_refunded", amountRefunded: 400 }],
  });
  const out = await reconcile();
  assert.strictEqual(out.refunds[0].state, "unexpected");
  assert.strictEqual(out.refunds[0].expected, 0);
  assert.strictEqual(out.refunds[0].refunded, 400);
  assert.strictEqual(out.refundSummary.unexpected, 1);
  console.log("6) A refund the Worker never priced reads as unexpected, not as owed");
}

// ---- 7. a deposit released after inspection is expected ------------------
// The trap in case 6's rule. A completed stay whose deposit came back clean has
// no cancellation at all, and reading expected as 0 there would flag every
// normal deposit release as a refund nobody priced.
//
// Counted from securityDeposit.refundedAmount ONLY when there is no
// cancellation: a cancellation's totalRefund already includes the deposit, so
// adding both would double it and turn every settled cancellation into a
// mismatch.
{
  await seed({
    snapshot: {
      bookingId: "BK-CANCEL", locationId: LOC,
      charges: { rentTotal: 1200, cleaningFee: 65, processingFee: 99.3 },
      securityDeposit: { total: 350, refundedAmount: 350, status: "refunded" },
      captures: { RENT: { invoiceId: INVOICE, gross: 1754.3 } },
    },
    transactions: [{ entityId: INVOICE, status: "partially_refunded", amountRefunded: 350 }],
  });
  const out = await reconcile();
  assert.strictEqual(out.refunds[0].state, "settled",
    "an inspection deposit release is a priced refund, not an unexpected one");
  assert.strictEqual(out.refunds[0].expected, 350);
  console.log("7) A deposit released after inspection is expected, and is not double-counted");
}

// ---- 8. a cancelled booking's deposit is not counted twice ---------------
// The other side of 7. This snapshot has BOTH cancellation.totalRefund 935 and
// securityDeposit.refundedAmount 350, which is exactly what a real cancellation
// looks like. Summing them would expect 1,285 and call a correct 935 refund a
// mismatch.
{
  await seed({
    snapshot: cancelled(935),
    transactions: [{ entityId: INVOICE, status: "partially_refunded", amountRefunded: 935 }],
  });
  const out = await reconcile();
  assert.strictEqual(out.refunds[0].expected, 935,
    "the deposit is already inside totalRefund -- expecting 1,285 would make every cancellation a mismatch");
  assert.strictEqual(out.refunds[0].state, "settled");
  console.log("8) A cancellation's deposit is counted once, inside totalRefund");
}

// ---- 9. no snapshot at all ------------------------------------------------
// Money back on an invoice this Worker never settled. Distinct from
// "unexpected": there is no booking record to reason about, which is the same
// hole /reports/reconcile's unmatched check exists for.
{
  await seed({
    snapshot: null,
    transactions: [{ entityId: INVOICE, status: "refunded", amountRefunded: 500 }],
  });
  const out = await reconcile();
  assert.strictEqual(out.refunds[0].state, "no_snapshot");
  assert.strictEqual(out.refundSummary.noSnapshot, 1);
  console.log("9) A refund on an invoice with no booking snapshot is reported separately");
}

// ---- 10. a clean settled booking says nothing ----------------------------
// An unremarkable paid stay must produce no row at all. A report that lists
// every booking is one nobody reads -- the same reason the OTA-channel warning
// was narrowed when it fired on every direct booking.
{
  await seed({
    snapshot: {
      bookingId: "BK-CANCEL", locationId: LOC,
      charges: { rentTotal: 1200, cleaningFee: 65, processingFee: 99.3 },
      securityDeposit: { total: 350, refundedAmount: null, status: "held" },
      captures: { RENT: { invoiceId: INVOICE, gross: 1754.3 } },
    },
    transactions: [{ entityId: INVOICE, status: "succeeded", amountRefunded: 0 }],
  });
  const out = await reconcile();
  assert.deepStrictEqual(out.refunds, [], "nothing owed and nothing refunded is not worth a row");
  assert.strictEqual(out.refundSummary.owed, 0);
  assert.strictEqual(out.unmatched.length, 0, "and it is matched, so the existing check stays quiet too");
  console.log("10) A booking with no refund activity produces no row");
}

// ---- 11. the existing unmatched check is untouched -----------------------
// Refund reconciliation reads the same transactions. A booking with no GHL
// transaction has no refund question to answer -- it is already flagged as
// unmatched, and reporting it twice under two names would be worse than once.
{
  await seed({
    snapshot: cancelled(935),
    transactions: [],
  });
  const out = await reconcile();
  assert.strictEqual(out.unmatched.length, 1, "no transaction at all is still unmatched");
  assert.deepStrictEqual(out.refunds, [], "and is not also listed as a refund problem");
  console.log("11) A booking with no GHL transaction stays in unmatched and only there");
}

console.log("\nPASS — reconcile compares what the Worker priced against what the processor refunded.");
