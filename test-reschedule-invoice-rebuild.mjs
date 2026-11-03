// Repricing an invoice GHL has just regenerated.
// Run: node test-reschedule-invoice-rebuild.mjs
//
// THE BUG. Moving a booking's dates makes GHL regenerate a calendar-sourced
// invoice from the booking's own products -- the listing and the Security
// Deposit, nothing else. The cleaning fee, every add-on and the processing fee
// are gone. The Worker moves the dates itself, so it causes this, and then
// reads the stripped invoice back and prices a correct 6% onto the wrong base.
//
// Measured on DEMO-HOMS twice. 2026-11-02 the reprice ran first and was
// overwritten outright (short 188.40). 2026-11-03, with the calendar moved
// first, the receipt showed nativeSubtotal 1550 on a booking priced at 1640 and
// amount 424 against amountDue 328.60 (short 95.40). That second receipt held
// everything needed to catch this, and nothing was comparing the two numbers.
//
// So this file asks four things. Are the stripped lines put back from the
// snapshot? If GHL did NOT strip them, are they left alone rather than added
// twice -- which would be a worse bug than the one being fixed? Is the fee the
// right percentage of the whole bill? And does the invoice announce it when its
// total still disagrees with what was billed?
import assert from "node:assert";
import { updateInvoiceForReschedule, isCleaningFee } from "./src/ghl-invoice.js";

const LOC = "ZghxU8I60bEm39JUbtCm";
const INV = "inv-1";

const tenant = {
  brandName: "Casa Bonita Vacation Rentals", currency: "USD", locale: "en-US",
  ownerPct: 0.85, processingFeePct: 0.06, ghlPit: "pit",
};

// INV-000035's real shape. 4 nights at 300.
const STAY_LINE = { name: "Villa Azul", productId: "p-stay", currency: "USD", amount: 1200, qty: 1 };
const EARLY     = { name: "Early Check-In", productId: "p-early", currency: "USD", amount: 15, qty: 1 };
const LATE      = { name: "Late Check-out", productId: "p-late", currency: "USD", amount: 25, qty: 1 };
const CLEANING  = { name: "Cleaning Fee", productId: "p-clean", currency: "USD", amount: 65, qty: 1 };
const DEPOSIT   = { name: "Security Deposit", productId: "p-dep", currency: "USD", amount: 350, qty: 1 };

// Extended by a night: rent 1200 -> 1500.
const NEW_RENT = 1500;
// What the guest should owe. The native deposit is already a line on the
// invoice, so it sits in the fee basis exactly once and gets no line of its own.
const EXPECTED_SUBTOTAL = 1500 + 65 + 15 + 25 + 350;   // 1955
const EXPECTED_FEE = 117.3;                            // 6% of 1955
const EXPECTED_TOTAL = 2072.3;

const snapshotFor = (extra = {}) => ({
  bookingId: "RB-1", locationId: LOC,
  stay: { checkIn: "2026-12-13", checkOut: "2026-12-18", nights: 5 },
  // A GHL-native deposit: recorded, but not the Worker's to bill.
  securityDeposit: { total: 350, source: "ghl_native" },
  charges: {
    rentTotal: NEW_RENT,
    cleaningFee: 65, cleaningFeeSource: "ghl_native",
    addOns: 40,
    addOnDetail: [{ name: "Early Check-In", amount: 15 }, { name: "Late Check-out", amount: 25 }],
    ...extra,
  },
});

// A GHL that returns `lines` on the GET and echoes whatever is PUT, with the
// total it would have computed from them.
let puts = [];
const ghlReturning = (lines, { totalOverride = null } = {}) => async (url, init = {}) => {
  const method = init.method || "GET";
  if (method === "PUT") {
    const body = JSON.parse(init.body);
    puts.push(body);
    const sum = (body.invoiceItems || [])
      .reduce((s, i) => s + Number(i.amount || 0) * Number(i.qty || 1), 0);
    const total = totalOverride == null ? Math.round(sum * 100) / 100 : totalOverride;
    return { ok: true, status: 200, text: async () => JSON.stringify({
      invoice: { _id: INV, status: "sent", total, amountDue: total },
    }) };
  }
  return { ok: true, status: 200, text: async () => JSON.stringify({
    _id: INV, invoiceNumber: "INV-000035", name: "Reserva RB-1", currency: "USD",
    status: "sent", issueDate: "2026-11-01", dueDate: "2026-11-10",
    contactDetails: { id: "c1" }, businessDetails: { name: "Casa Bonita" },
    invoiceItems: lines,
  }) };
};

const reprice = (lines, snapshot, opts) => {
  puts = [];
  return updateInvoiceForReschedule(
    { tenant, env: {}, locationId: LOC, invoiceId: INV, snapshot, previousNights: 4 },
    ghlReturning(lines, opts),
  );
};
const sent = () => puts.at(-1).invoiceItems;
const byName = (re) => sent().filter((i) => re.test(String(i.name || "")));
const sumOf = (items) =>
  Math.round(items.reduce((s, i) => s + Number(i.amount || 0) * Number(i.qty || 1), 0) * 100) / 100;

// ---- 1. THE BUG: GHL stripped the invoice before the Worker read it -------
{
  const out = await reprice([STAY_LINE, DEPOSIT], snapshotFor());
  assert.strictEqual(out.ok, true);

  const cleaning = byName(/clean|limpieza/i);
  assert.strictEqual(cleaning.length, 1,
    "the cleaning fee was not put back -- the guest is not being billed the 65 the booking was priced with");
  assert.strictEqual(cleaning[0].amount, 65);
  // The NAME matters as much as the amount: the ledger decides whose money the
  // cleaning fee is by matching this regex, so a line called "Cleaning" by any
  // other word is silently split with the owner instead of paying the cleaner.
  assert.ok(isCleaningFee(cleaning[0]),
    `a restored cleaning line named "${cleaning[0].name}" does not read as cleaning to the ledger`);

  assert.strictEqual(byName(/Early Check-In/).length, 1, "the early check-in add-on was not put back");
  assert.strictEqual(byName(/Late Check-out/).length, 1, "the late check-out add-on was not put back");

  assert.strictEqual(out.nativeSubtotal, EXPECTED_SUBTOTAL,
    `priced off a subtotal of ${out.nativeSubtotal} instead of ${EXPECTED_SUBTOTAL} -- ` +
    "this is the 1550-instead-of-1640 shape from the 11-03 receipt");
  assert.strictEqual(out.processingFee, EXPECTED_FEE,
    `fee ${out.processingFee} instead of ${EXPECTED_FEE}: a correct 6% of the wrong bill`);
  assert.strictEqual(sumOf(sent()), EXPECTED_TOTAL,
    `the invoice totals ${sumOf(sent())}, short-billing the guest ` +
    `${Math.round((EXPECTED_TOTAL - sumOf(sent())) * 100) / 100}`);
  assert.deepStrictEqual(out.restoredLines.slice().sort(),
    ["Cleaning Fee", "Early Check-In", "Late Check-out"],
    "and the receipt says what had to be put back");
  console.log("1) A regenerated invoice is rebuilt from the snapshot, fee on the whole bill");
}

// ---- 2. the opposite risk: GHL did NOT strip anything --------------------
// Ensure-present, not append. If this ever appends, the guest pays the cleaning
// fee and both add-ons twice -- louder than under-billing and harder to undo.
{
  const out = await reprice([STAY_LINE, EARLY, LATE, CLEANING, DEPOSIT], snapshotFor());
  const cleaning = byName(/clean|limpieza/i);
  assert.strictEqual(cleaning.length, 1,
    `${cleaning.length} cleaning lines -- the guest is being billed for cleaning twice`);
  assert.strictEqual(byName(/Early Check-In/).length, 1, "Early Check-In billed twice");
  assert.strictEqual(byName(/Late Check-out/).length, 1, "Late Check-out billed twice");
  assert.strictEqual(byName(/Security Deposit/).length, 1, "the deposit is billed twice");
  assert.deepStrictEqual(out.restoredLines, [], "nothing needed restoring, and the receipt says so");
  assert.strictEqual(out.nativeSubtotal, EXPECTED_SUBTOTAL);
  assert.strictEqual(sumOf(sent()), EXPECTED_TOTAL, "the same invoice either way, which is the point");
  console.log("2) An intact invoice is repriced, not doubled -- same total as the rebuilt one");
}

// ---- 3. half-stripped, the case neither branch above covers --------------
{
  const out = await reprice([STAY_LINE, CLEANING, DEPOSIT], snapshotFor());
  assert.strictEqual(byName(/clean|limpieza/i).length, 1, "the surviving cleaning line was duplicated");
  assert.deepStrictEqual(out.restoredLines.slice().sort(), ["Early Check-In", "Late Check-out"],
    "only the missing add-ons are restored");
  assert.strictEqual(sumOf(sent()), EXPECTED_TOTAL);
  console.log("3) A partly-stripped invoice restores only what is missing");
}

// ---- 4. the snapshot's own name for the cleaning line is used ------------
{
  await reprice([STAY_LINE, DEPOSIT], snapshotFor({ cleaningFeeName: "Limpieza final" }));
  const cleaning = byName(/clean|limpieza/i);
  assert.strictEqual(cleaning[0].name, "Limpieza final",
    "the guest's bill changed wording between versions instead of using the recorded name");
  console.log("4) A recorded cleaning-line name is reused verbatim");
}

// ---- 5. the reconcile check can fail ------------------------------------
// The residual risk the rebuild cannot remove: a manager who edits the dates in
// the GHL calendar AFTER this runs re-triggers the regeneration, with nothing
// watching. So the invoice's own total is compared to what was billed.
{
  const out = await reprice([STAY_LINE, DEPOSIT], snapshotFor(), { totalOverride: 1961 });
  assert.strictEqual(out.reconciled, false,
    "GHL reported a total 111.30 below the lines that were sent, and the Worker called it fine");
  assert.strictEqual(out.expectedTotal, EXPECTED_TOTAL);
  console.log("5) An invoice GHL rewrote after the update is reported, not passed as correct");
}

// ---- 6. and it can pass, or case 5 proves nothing -----------------------
{
  const out = await reprice([STAY_LINE, DEPOSIT], snapshotFor());
  assert.strictEqual(out.reconciled, true,
    "a correct invoice was flagged as mismatched -- the check cries wolf and will be ignored");
  assert.strictEqual(out.total, EXPECTED_TOTAL);
  console.log("6) A correct invoice reconciles clean");
}

console.log("\nPASS — a regenerated invoice is rebuilt from the snapshot, an intact one is left alone, " +
  "the fee is 6% of the whole bill either way, and a total that still disagrees is reported.");
