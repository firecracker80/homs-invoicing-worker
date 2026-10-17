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
let transactionUrls = [];
// Serves mockTransactions as real pages: honours limit/offset and reports
// totalCount, the way the live endpoint does. A mock that returns the whole
// list for any offset cannot tell a paged reader from an unpaged one, which is
// why cases 1-13 could not have caught a missing second page.
let pageMode = "paged";
global.fetch = async (url) => {
  const u = String(url);
  const ok = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o), json: async () => o });
  if (u.includes("/payments/transactions")) {
    transactionUrls.push(u);
    const q = new URL(u).searchParams;
    const limit = Number(q.get("limit") || 100);
    const offset = Number(q.get("offset") || 0);
    if (pageMode === "ignores_offset") return ok({ data: mockTransactions.slice(0, limit), totalCount: mockTransactions.length });
    if (pageMode === "no_total") return ok({ data: mockTransactions.slice(offset, offset + limit) });
    return ok({ data: mockTransactions.slice(offset, offset + limit), totalCount: mockTransactions.length });
  }
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

const seed = async ({ bookingId = "BK-CANCEL", snapshot, transactions, mode = "paged" }) => {
  transactionUrls = [];
  pageMode = mode;
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

// ---- 12. the transactions request is shaped so GHL will answer it --------
// Not a detail. ghlFetchTransactions had sent locationId and no altId since
// 2026-08-29 and threw 422 on every live call -- handleReconcile catches that
// into ghlFetchError and carries on with an empty list, so it answered 200
// while reporting every enrich booking as unmatched (15 of them on DEMO-HOMS,
// all false) and every refund as zero.
//
// A mock that answers any URL cannot catch that, which is why nine passing
// cases above did not. This asserts the request itself.
{
  await seed({
    snapshot: cancelled(935),
    transactions: [{ entityId: INVOICE, status: "partially_refunded", amountRefunded: 935 }],
  });
  await reconcile();
  assert.strictEqual(transactionUrls.length, 1, "reconcile fetches the transaction list once");
  const q = new URL(transactionUrls[0]).searchParams;
  assert.strictEqual(q.get("altId"), LOC,
    "altId is required on every payments/* operation -- without it GHL answers 422 and the whole report degrades silently");
  assert.strictEqual(q.get("altType"), "location");
  assert.strictEqual(q.get("startAt"), "2026-10-01", "and the window is passed through");
  assert.strictEqual(q.get("endAt"), "2026-10-31");
  console.log("12) The transactions request carries altId, which GHL rejects the call without");
}

// ---- 13. an all-time window omits the dates rather than sending "null" ---
// resolveWindow returns null labels for period=all, and URLSearchParams turns
// a null into the string "null". So ?period=all sent startAt=null&endAt=null.
{
  await seed({
    snapshot: cancelled(935),
    transactions: [{ entityId: INVOICE, status: "partially_refunded", amountRefunded: 935 }],
  });
  const res = await handleReconcile({
    method: "GET",
    url: `https://w.dev/reports/reconcile?locationId=${LOC}&period=all`,
    headers: { get: (n) => (n === "X-Admin-Secret" ? "admin123" : null) },
  }, env);
  const out = await res.json();
  assert.strictEqual(out.ghlFetchError, null, "an all-time reconcile must still reach GHL");
  const q = new URL(transactionUrls[0]).searchParams;
  assert.ok(!q.has("startAt"), `all-time must omit startAt, not send it as a string -- got ${q.get("startAt")}`);
  assert.ok(!q.has("endAt"), `and omit endAt -- got ${q.get("endAt")}`);
  assert.strictEqual(q.get("altId"), LOC, "and still carry altId");
  assert.strictEqual(out.refunds[0].state, "settled", "and still reconcile the refund");
  console.log("13) period=all omits the date params instead of sending the string 'null'");
}

// ---- 14. more transactions than fit on one page --------------------------
// The request asked for limit=100 offset=0 and took the answer as the whole
// account. DEMO-HOMS already returns 50 all-time against 25 invoices -- one
// invoice carries three, a success and two failed attempts -- so a real client
// passes 100 and the list truncates.
//
// Truncation does not look like an error. The missing transactions make their
// bookings read as "no GHL transaction" in the unmatched check and "nothing
// refunded" in the refund check: the same silent, confident wrongness the
// altId 422 produced for two months.
//
// 250 transactions, with the one that matters LAST, so a single-page read
// cannot pass by luck.
{
  const filler = Array.from({ length: 249 }, (_, i) => ({
    _id: "tx-" + i, entityId: "inv-other-" + i, status: "succeeded", amountRefunded: 0,
  }));
  await seed({
    snapshot: cancelled(935),
    transactions: [...filler, { _id: "tx-last", entityId: INVOICE, status: "partially_refunded", amountRefunded: 935 }],
  });
  const out = await reconcile();
  assert.strictEqual(out.ghlTransactionCount, 250, "every page is read, not just the first");
  assert.strictEqual(out.ghlPagesFetched, 3, "250 at 100 a page is three requests");
  assert.strictEqual(out.ghlTransactionsTruncated, false, "and the answer is complete");
  assert.strictEqual(out.refunds.length, 1, "the booking on the last page is still reconciled");
  assert.strictEqual(out.refunds[0].state, "settled");
  assert.strictEqual(out.unmatched.length, 0, "and is not falsely flagged as missing from GHL");
  const offsets = transactionUrls.map((u) => new URL(u).searchParams.get("offset"));
  assert.deepStrictEqual(offsets, ["0", "100", "200"], "offset advances by the page size");
  console.log("14) 250 transactions are read across 3 pages, and the booking on the last page reconciles");
}

// ---- 15. an endpoint that ignores offset must not spin -------------------
// If offset is ignored, every page is page one. Without a guard this loops to
// the page cap, sends a hundred identical requests to a live endpoint, and
// then reports a truncation that was really a repeat. A page that adds nothing
// new ends the read instead.
{
  const filler = Array.from({ length: 150 }, (_, i) => ({
    _id: "dup-" + i, entityId: "inv-dup-" + i, status: "succeeded", amountRefunded: 0,
  }));
  await seed({ snapshot: cancelled(935), transactions: filler, mode: "ignores_offset" });
  const out = await reconcile();
  assert.ok(out.ghlPagesFetched <= 2, "a repeating endpoint must stop at once, took " + out.ghlPagesFetched + " pages");
  assert.strictEqual(out.ghlTransactionCount, 100, "deduplicated by id, so the repeat is not counted twice");
  assert.strictEqual(out.ghlTransactionsTruncated, true,
    "and it says the answer is short of the 150 the endpoint claims, rather than passing 100 off as all of them");
  console.log("15) An endpoint that ignores offset stops after one repeat and reports the answer as short");
}

// ---- 16. no totalCount still pages to the end ----------------------------
// totalCount drives the completeness check, but it must not be required to
// page: a short page is the last page either way.
{
  const filler = Array.from({ length: 120 }, (_, i) => ({
    _id: "nt-" + i, entityId: "inv-nt-" + i, status: "succeeded", amountRefunded: 0,
  }));
  await seed({
    snapshot: cancelled(935),
    transactions: [...filler, { _id: "nt-last", entityId: INVOICE, status: "partially_refunded", amountRefunded: 935 }],
    mode: "no_total",
  });
  const out = await reconcile();
  assert.strictEqual(out.ghlTransactionCount, 121, "a short page ends the read without needing a count");
  assert.strictEqual(out.ghlTransactionTotal, null, "and the count is reported as unknown rather than guessed");
  assert.strictEqual(out.ghlTransactionsTruncated, false, "an unknown total is not a truncation");
  assert.strictEqual(out.refunds[0].state, "settled");
  console.log("16) With no totalCount it still pages to the end, and reports the total as unknown");
}

// ---- 17. one past a page boundary ----------------------------------------
// The totalCount break is `collected >= totalCount`, and case 14 cannot tell
// that from `>= totalCount - 1`: with 250 of 250, both stop in the same place.
// Mutation testing found it survive.
//
// It is reachable, and it costs exactly one transaction. At 201 the off-by-one
// stops after two full pages holding 200, satisfied that 200 >= 200, and the
// 201st is never read. Here that last one is the refund, so the booking would
// read as unmatched AND as nothing-refunded -- both false, and both quiet.
{
  const filler = Array.from({ length: 200 }, (_, i) => ({
    _id: "edge-" + i, entityId: "inv-edge-" + i, status: "succeeded", amountRefunded: 0,
  }));
  await seed({
    snapshot: cancelled(935),
    transactions: [...filler, { _id: "edge-last", entityId: INVOICE, status: "partially_refunded", amountRefunded: 935 }],
  });
  const out = await reconcile();
  assert.strictEqual(out.ghlTransactionCount, 201,
    "the 201st transaction is read -- stopping at 200 of 201 is a full page that looks complete");
  assert.strictEqual(out.ghlPagesFetched, 3, "which takes a third page holding one row");
  assert.strictEqual(out.ghlTransactionsTruncated, false);
  assert.strictEqual(out.refunds.length, 1, "and the refund on it is still found");
  assert.strictEqual(out.refunds[0].state, "settled");
  assert.strictEqual(out.unmatched.length, 0);
  console.log("17) A count one past a page boundary still reads the final page");
}

console.log("\nPASS — reconcile compares what the Worker priced against what the processor refunded.");
