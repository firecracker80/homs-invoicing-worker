// Recognising our own invoice lines regardless of capitalisation.
// Run: node test-our-lines-case.mjs
//
// THE BUG. OUR_LINES matched exact strings, so a GHL product line named
// "Processing Fee" differed from the Worker's "Processing fee" in one letter
// and was treated as a native charge. Three consequences, all on a live
// invoice:
//
//   1. it survived the strip, so a SECOND fee line was appended beside it;
//   2. it sat inside nativeSubtotal, so 6% was charged ON a processing fee;
//   3. invoiceHasWorkerLines did not see it, so an already-enriched invoice
//      looked un-enriched and was eligible to be enriched again.
//
// The comment above LEGACY_LINES already named this exact mechanism, for
// renames rather than for case: a line of ours that is not recognised "would
// survive the strip AND a new one would be appended, and the guest would be
// charged the processing fee twice".
//
// Live example: INV-000032 on DEMO-HOMS carries "Processing Fee" WITH a
// productId, so it is a GHL product rather than a Worker line.
//
// The other half of this file matters as much: the fix must not swallow a
// native line. OUR_LINES answers "did the Worker write this exact line", while
// isFeeLine answers "is this not the stay". Making the identity check
// pattern-based would strip a native Cleaning Fee as though we had written it,
// so case 3 holds that line.
import assert from "node:assert";

import {
  isOurLine, invoiceHasWorkerLines, updateInvoiceForReschedule,
} from "./src/ghl-invoice.js";

const LOC = "ZghxU8I60bEm39JUbtCm";
const tenant = {
  brandName: "Casa Bonita", currency: "USD", locale: "en-US",
  ownerPct: 0.85, processingFeePct: 0.06, ghlPit: "pit",
};

// ---- 1. the predicate itself ----------------------------------------
{
  // Ours, in every casing GHL or a human might produce.
  for (const name of ["Processing fee", "Processing Fee", "PROCESSING FEE",
                      "  processing fee  ", "Cargo por procesamiento",
                      "CARGO POR PROCESAMIENTO",
                      "Cargo por procesamiento / Processing fee",
                      "Depósito de seguridad / Security deposit"]) {
    assert.ok(isOurLine({ name }), `"${name}" should be recognised as our own line`);
  }

  // NOT ours. These are the account's charges and must stay native -- stripping
  // any of them would delete a real charge from the guest's invoice.
  for (const name of ["Security Deposit", "Cleaning Fee", "Late Check-out",
                      "Early Check-In", "Tax", "ITBIS", "Pet Fee",
                      "Airport Shuttle", "Villa Azul", "", "   "]) {
    assert.ok(!isOurLine({ name }), `"${name}" is the account's line and must stay native`);
  }
  assert.ok(!isOurLine(undefined), "a missing item is not our line");
  assert.ok(!isOurLine({}), "a nameless item is not our line");
  console.log("1) Our fee and deposit lines are recognised in any casing; native lines are not");
}

// ---- 2. the already-enriched guard sees it --------------------------
// This is the one that lets an invoice be enriched twice.
{
  const invoiceWith = (items) => async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ _id: "inv1", status: "sent", invoiceItems: items }),
  });
  const args = { tenant, env: {}, locationId: LOC, invoiceId: "inv1" };

  assert.strictEqual(
    await invoiceHasWorkerLines(args, invoiceWith([
      { name: "Villa Azul", amount: 1000, qty: 1 },
      { name: "Processing Fee", productId: "p-fee", amount: 60, qty: 1 },
    ])), true,
    "an invoice already carrying a fee line looked un-enriched -- it can be enriched a second time");

  assert.strictEqual(
    await invoiceHasWorkerLines(args, invoiceWith([
      { name: "Villa Azul", amount: 1000, qty: 1 },
      { name: "Cleaning Fee", amount: 65, qty: 1 },
    ])), false,
    "a fresh draft with only native lines must still read as un-enriched, or nothing is ever enriched");
  console.log("2) The already-enriched guard recognises a differently-cased fee line");
}

// ---- 3. a reschedule bills ONE fee, on the right basis --------------
{
  const RENT = 1000, CLEANING = 65, ADDON = 25, DEPOSIT = 350;
  // What the guest should owe: the fee applies to the stay, cleaning, add-on
  // and deposit -- NOT to a previous processing fee.
  const BASIS = RENT + CLEANING + ADDON + DEPOSIT;              // 1440
  const FEE = Math.round(0.06 * BASIS * 100) / 100;             // 86.40
  const TOTAL = Math.round((BASIS + FEE) * 100) / 100;          // 1526.40

  let put = null;
  const ghl = async (url, init = {}) => {
    const ok = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o) });
    if (init.method === "PUT") {
      put = JSON.parse(init.body);
      const total = Math.round((put.invoiceItems || [])
        .reduce((s, i) => s + Number(i.amount || 0) * Number(i.qty || 1), 0) * 100) / 100;
      return ok({ invoice: { _id: "inv1", status: "sent", total, amountDue: total } });
    }
    return ok({
      _id: "inv1", invoiceNumber: "000032", name: "Reserva", currency: "USD", status: "sent",
      issueDate: "2026-11-01", dueDate: "2026-11-10",
      contactDetails: { id: "c1" }, businessDetails: { name: "DEMO-HOMS" },
      invoiceItems: [
        { name: "Villa Azul", productId: "p-stay", currency: "USD", amount: RENT, qty: 1 },
        { name: "Late Check-out", productId: "p-late", currency: "USD", amount: ADDON, qty: 1 },
        { name: "Cleaning Fee", productId: "p-clean", currency: "USD", amount: CLEANING, qty: 1 },
        { name: "Security Deposit", productId: "p-dep", currency: "USD", amount: DEPOSIT, qty: 1 },
        // INV-000032's shape: a GHL PRODUCT, capital F, carrying a productId.
        { name: "Processing Fee", productId: "p-fee", currency: "USD", amount: 110.4, qty: 1 },
      ],
    });
  };

  const snapshot = {
    bookingId: "OL-1", locationId: LOC,
    stay: { checkIn: "2026-12-07", checkOut: "2026-12-12", nights: 5 },
    securityDeposit: { total: DEPOSIT, source: "ghl_native" },
    charges: {
      rentTotal: RENT, cleaningFee: CLEANING, cleaningFeeSource: "ghl_native",
      cleaningFeeName: "Cleaning Fee",
      addOns: ADDON, addOnDetail: [{ name: "Late Check-out", amount: ADDON }],
    },
  };

  const out = await updateInvoiceForReschedule(
    { tenant, env: {}, locationId: LOC, invoiceId: "inv1", snapshot, previousNights: 7 }, ghl);
  assert.strictEqual(out.ok, true);

  const fees = put.invoiceItems.filter((i) => /process|procesamiento/i.test(String(i.name || "")));
  assert.strictEqual(fees.length, 1,
    `${fees.length} processing-fee lines on the invoice -- the guest is billed the fee twice: ` +
    JSON.stringify(fees.map((f) => `${f.name} ${f.amount}`)));
  assert.ok(Math.abs(fees[0].amount - FEE) <= 0.01,
    `fee ${fees[0].amount} should be ${FEE} -- 6% of ${BASIS}, not 6% of a total that already ` +
    `included a 110.40 fee`);
  assert.ok(Math.abs(out.nativeSubtotal - BASIS) <= 0.01,
    `fee basis ${out.nativeSubtotal} should be ${BASIS} -- the old fee line is in the basis`);

  const total = Math.round(put.invoiceItems
    .reduce((s, i) => s + Number(i.amount || 0) * Number(i.qty || 1), 0) * 100) / 100;
  assert.ok(Math.abs(total - TOTAL) <= 0.01, `invoice totals ${total}, expected ${TOTAL}`);

  // And the account's own charges all survived.
  for (const re of [/Villa Azul/, /Late Check-out/, /clean|limpieza/i, /Security Deposit/]) {
    assert.strictEqual(put.invoiceItems.filter((i) => re.test(String(i.name || ""))).length, 1,
      `${re} should appear exactly once`);
  }
  console.log(`3) One fee line at ${fees[0].amount} on a basis of ${out.nativeSubtotal}; invoice ${total}`);
}

console.log("\nPASS — our own lines are recognised whatever their capitalisation, the guest is " +
  "billed one processing fee on a basis that excludes it, and no native charge is stripped.");
