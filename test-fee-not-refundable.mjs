// Processing fees are not refundable, and a shortening refunds only overpayment.
// Run: node test-fee-not-refundable.mjs
//
// TWO RULES, one from policy and one from arithmetic. They were tangled together
// and the tangle is why neither was right.
//
// 1. POLICY (Yari, 2026-11-10): processing fees are NOT refundable. The 6%
//    recovers the gateway's cut and the USD-to-DOP spread, both spent the moment
//    the guest paid. So a fee already collected is never reduced. Before this,
//    shortening INV-000039 from 7 nights to 6 recomputed the fee from 110.40
//    down to 98.40 -- an invoice showing 12.00 less fee than was taken, and a
//    12.00 credit the business cannot recover.
//
// 2. ARITHMETIC, independent of the policy: a refund instruction built from the
//    rent delta double-counts on a part-paid booking. INV-000039 had 1314.40
//    paid of 1950.40. Shortened, the invoice is 1750.40, so the guest still OWES
//    436.00 and is owed nothing -- yet the settlement instructed a 200.00 cash
//    refund. Paying it collects 1538.40 against 1750.40.
//
// Note where rule 2 lands: 636.00 due less the 200.00 night is 436.00, the
// number an operator would have guessed. The intuitive answer was right and the
// code was wrong.
import assert from "node:assert";

import { updateInvoiceForReschedule } from "./src/ghl-invoice.js";

const LOC = "ZghxU8I60bEm39JUbtCm";
const tenant = {
  brandName: "Casa Bonita", currency: "USD", locale: "en-US",
  ownerPct: 0.85, processingFeePct: 0.06, ghlPit: "pit",
};

// INV-000039's real shape. 7 nights at 200.
const RATE = 200, CLEANING = 65, ADDON = 25, DEPOSIT = 350;
const FEE_7N = 110.4;                       // 6% of (1400 + 65 + 25 + 350)
const TOTAL_7N = 1950.4;
const NEW_RENT_6N = RATE * 6;               // 1200
const FEE_6N_COMPUTED = 98.4;               // 6% of 1640 -- what it WOULD recompute to

const near = (a, b) => Math.abs(Number(a) - Number(b)) <= 0.01;

// A GHL that reports what the guest has paid, and echoes the rewrite.
const makeGhl = ({ amountDue }) => {
  const state = { put: null };
  const fn = async (url, init = {}) => {
    const ok = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o) });
    if (init.method === "PUT") {
      state.put = JSON.parse(init.body);
      const total = Math.round((state.put.invoiceItems || [])
        .reduce((s, i) => s + Number(i.amount || 0) * Number(i.qty || 1), 0) * 100) / 100;
      return ok({ invoice: { _id: "inv1", status: "paid", total, amountDue: 0 } });
    }
    return ok({
      _id: "inv1", invoiceNumber: "000039", name: "Reserva", currency: "USD", status: "paid",
      issueDate: "2026-11-01", dueDate: "2026-11-10",
      contactDetails: { id: "c1" }, businessDetails: { name: "DEMO-HOMS" },
      total: TOTAL_7N, amountDue,
      invoiceItems: [
        { name: "Villa Azul", productId: "p1", currency: "USD", amount: RATE * 7, qty: 1 },
        { name: "Late Check-out", productId: "p2", currency: "USD", amount: ADDON, qty: 1 },
        { name: "Cleaning Fee", productId: "p3", currency: "USD", amount: CLEANING, qty: 1 },
        { name: "Security Deposit", productId: "p4", currency: "USD", amount: DEPOSIT, qty: 1 },
        { name: "Processing fee", currency: "USD", amount: FEE_7N, qty: 1 },
      ],
    });
  };
  fn.state = state;
  return fn;
};

const snapshotFor = ({ settled }) => ({
  bookingId: "FR-1", locationId: LOC,
  settled, gateway: "ghl_invoice", ghlInvoice: { invoiceId: "inv1" },
  stay: { checkIn: "2026-12-07", checkOut: "2026-12-13", nights: 6 },
  securityDeposit: { total: DEPOSIT, source: "ghl_native" },
  charges: {
    rentTotal: NEW_RENT_6N, cleaningFee: CLEANING, cleaningFeeSource: "ghl_native",
    cleaningFeeName: "Cleaning Fee", processingFee: FEE_7N,   // what was already charged
    addOns: ADDON, addOnDetail: [{ name: "Late Check-out", amount: ADDON }],
  },
});

const feeOn = (put) =>
  put.invoiceItems.find((i) => /process|procesamiento/i.test(String(i.name || "")))?.amount;
const totalOf = (put) => Math.round(put.invoiceItems
  .reduce((s, i) => s + Number(i.amount || 0) * Number(i.qty || 1), 0) * 100) / 100;

// ---- 1. a PAID booking keeps the fee it was charged ------------------
{
  const ghl = makeGhl({ amountDue: 0 });                       // paid in full
  const out = await updateInvoiceForReschedule(
    { tenant, env: {}, locationId: LOC, invoiceId: "inv1",
      snapshot: snapshotFor({ settled: true }), previousNights: 7 }, ghl);
  assert.strictEqual(out.ok, true);

  assert.ok(near(feeOn(ghl.state.put), FEE_7N),
    `the fee was reduced to ${feeOn(ghl.state.put)} -- processing fees are not refundable, ` +
    `so a collected ${FEE_7N} must not fall to ${FEE_6N_COMPUTED}`);
  assert.ok(near(out.feeNotRefunded, 12),
    `feeNotRefunded should record the 12.00 kept, got ${out.feeNotRefunded}`);
  // Invoice agrees with the money: 1200 + 65 + 25 + 350 + 110.40.
  assert.ok(near(totalOf(ghl.state.put), 1750.4),
    `invoice totals ${totalOf(ghl.state.put)}, expected 1750.40`);
  assert.ok(near(out.paidBefore, TOTAL_7N), `paidBefore ${out.paidBefore} should be ${TOTAL_7N}`);
  console.log(`1) A paid booking keeps its ${feeOn(ghl.state.put)} fee; invoice ${totalOf(ghl.state.put)}`);
}

// ---- 2. an UNPAID booking recomputes the fee down --------------------
// Nothing was incurred, so there is no sunk cost to protect. If this failed,
// the policy would be overcharging a guest who never paid.
{
  const ghl = makeGhl({ amountDue: TOTAL_7N });                // nothing paid
  const out = await updateInvoiceForReschedule(
    { tenant, env: {}, locationId: LOC, invoiceId: "inv1",
      snapshot: snapshotFor({ settled: false }), previousNights: 7 }, ghl);

  assert.ok(near(feeOn(ghl.state.put), FEE_6N_COMPUTED),
    `an unpaid booking should recompute the fee to ${FEE_6N_COMPUTED}, got ${feeOn(ghl.state.put)} ` +
    `-- no gateway cut or exchange loss has been incurred, so there is nothing to keep`);
  assert.strictEqual(out.feeNotRefunded, 0);
  assert.ok(near(out.paidBefore, 0), `paidBefore ${out.paidBefore} should be 0`);
  console.log(`2) An unpaid booking recomputes the fee down to ${feeOn(ghl.state.put)}`);
}

// ---- 3. an EXTENSION still raises the fee ----------------------------
// The equivalence guard: a floor must not become a ceiling.
{
  const ghl = makeGhl({ amountDue: 0 });
  const longer = snapshotFor({ settled: true });
  longer.charges.rentTotal = RATE * 9;          // 1800
  longer.stay = { checkIn: "2026-12-07", checkOut: "2026-12-16", nights: 9 };
  const out = await updateInvoiceForReschedule(
    { tenant, env: {}, locationId: LOC, invoiceId: "inv1", snapshot: longer, previousNights: 7 }, ghl);

  const expected = Math.round(0.06 * (1800 + CLEANING + ADDON + DEPOSIT) * 100) / 100;  // 134.40
  assert.ok(near(feeOn(ghl.state.put), expected),
    `an extension must RAISE the fee to ${expected}, got ${feeOn(ghl.state.put)} -- the floor ` +
    `has become a ceiling`);
  assert.strictEqual(out.feeNotRefunded, 0, "nothing is withheld when the fee went up");
  console.log(`3) An extension raises the fee to ${feeOn(ghl.state.put)}, floor is not a ceiling`);
}

// ---- 4. the part-paid case: nothing is owed back --------------------
// The arithmetic rule, and the one that would have cost real money.
{
  const ghl = makeGhl({ amountDue: 636 });                     // 1314.40 paid
  const out = await updateInvoiceForReschedule(
    { tenant, env: {}, locationId: LOC, invoiceId: "inv1",
      snapshot: snapshotFor({ settled: true }), previousNights: 7 }, ghl);

  assert.ok(near(out.paidBefore, 1314.4), `paidBefore ${out.paidBefore} should be 1314.40`);
  const overpaid = Math.max(0, Math.round((out.paidBefore - totalOf(ghl.state.put)) * 100) / 100);
  assert.strictEqual(overpaid, 0,
    `a part-paid booking is owed ${overpaid} -- it should be 0, because the shortening comes ` +
    `off the 436.00 still owed rather than being paid back as cash`);
  // And the balance is the number an operator would have guessed.
  const stillOwed = Math.round((totalOf(ghl.state.put) - out.paidBefore) * 100) / 100;
  assert.ok(near(stillOwed, 436), `still owed ${stillOwed}, expected 436.00`);
  console.log(`4) Part-paid: owed back 0, still owes ${stillOwed} -- 636.00 less the 200.00 night`);
}

// ---- 5. the fully-paid case: exactly the night, not the fee ---------
{
  const ghl = makeGhl({ amountDue: 0 });
  const out = await updateInvoiceForReschedule(
    { tenant, env: {}, locationId: LOC, invoiceId: "inv1",
      snapshot: snapshotFor({ settled: true }), previousNights: 7 }, ghl);

  const overpaid = Math.round((out.paidBefore - totalOf(ghl.state.put)) * 100) / 100;
  assert.ok(near(overpaid, 200),
    `a fully-paid guest is owed ${overpaid}; it should be exactly the 200.00 night, with the ` +
    `12.00 fee kept`);
  assert.ok(!near(overpaid, 212), "212.00 would mean the processing fee was refunded");
  console.log(`5) Fully paid: owed back ${overpaid} -- the night, not the 12.00 fee`);
}

console.log("\nPASS — a collected processing fee is never reduced, an unpaid one still recomputes, " +
  "an extension still raises it, and only genuine overpayment is cash.");
