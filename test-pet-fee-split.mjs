// The pet fee is part of the rent price, so it is split like rent.
// Run: node test-pet-fee-split.mjs
//
// Yari, 2026-09-29, asked who earns a pet fee. The answer turned out to be
// that nobody did. There was no pet_fee entry type in ledger.js, nothing in
// reports.js or manager-pl.js, and bookingTotalOf was rentTotal + cleaningFee
// -- so the guest paid it, the processing fee was charged on it, and it
// appeared in no owner or manager statement and in no Transaction total.
//
// Her answer -- it is part of the rent price -- makes it revenue split at
// ownerPct like the rest of the rent. This is mostly about SINGLE-listing
// bookings, which is nearly all of them; the bundled case is in
// test-multi-listing-wired.mjs.
//
// The care needed is in what it must NOT change. charges.rentTotal divides by
// nights to give nightlyRate, which sizes the deposit and drives the
// nights-based cancellation tiers. A pet fee does not buy a night, so it is a
// separate amount that happens to be split on the same terms -- never folded
// into the rent itself.
import assert from "node:assert";

const { repriceFromInvoice } = await import("./src/ghl-invoice.js");
const { bookingTotalOf } = await import("./src/ledger.js");
const { calcCancellation } = await import("./src/cancellation.js");

const round2 = (n) => Math.round(n * 100) / 100;

const tenant = {
  brandName: "Casa Bonita", currency: "USD", ownerPct: 0.85, processingFeePct: 0.06,
  cleaningFeeRecipient: "manager", tzOffsetHours: -4, checkInHour: 15,
  cancellationPolicy: { tiers: [{ underHours: 120, chargePct: 0.5 }], checkedInChargePct: 1 },
};

// Four nights at 100. The invoice GHL built: the listing, its cleaning, the
// pet fee the guest agreed to.
const snapshotFor = (nights = 4) => ({
  bookingId: "PET-1", locationId: "LOC", propertyCode: "Test Villa 3",
  createdAt: "2026-09-01T00:00:00.000Z",
  stay: { checkIn: "2026-12-01", checkOut: "2026-12-05", nights, nightlyRate: 100 },
  charges: { rentTotal: 400, cleaningFee: 65, processingFee: 0, feePct: 0.06, grandTotal: 0 },
  securityDeposit: { total: 0, blocks: [], status: "none" },
  payout: { basis: 400, ownerPct: 0.85, owner: 340, manager: 60, cleaningFeeTo: "manager", status: "pending" },
});

const ITEMS = [
  { name: "Test Villa 3", amount: 100, qty: 4 },
  { name: "Cleaning Fee", amount: 65, qty: 1 },
  { name: "Pet Fee", amount: 300, qty: 1 },
];

// ---- 1. the split it was never in -----------------------------------
{
  const snap = snapshotFor();
  repriceFromInvoice(snap, tenant, ITEMS);

  assert.strictEqual(snap.charges.petFee, 300, "recorded in its own right, rather than only inside a total");
  assert.strictEqual(snap.payout.basis, 700, "400 of rent plus the 300 pet fee");
  assert.strictEqual(snap.payout.owner, 595, "85% of 700, not of 400");
  assert.strictEqual(snap.payout.manager, 105);
  assert.strictEqual(round2(snap.payout.owner + snap.payout.manager), snap.payout.basis,
    "and the two shares are the whole of it -- 255 of this reached nobody before");
  console.log("1) The pet fee joins the basis the owner/manager split is taken on");
}

// ---- 2. and does not become the rent -------------------------------
// This is the part that would break quietly. rentTotal / nights is the nightly
// rate, and the nightly rate sizes deposits and prices nights-based
// cancellation tiers.
{
  const snap = snapshotFor();
  repriceFromInvoice(snap, tenant, ITEMS);

  assert.strictEqual(snap.charges.rentTotal, 400, "the stay still costs what the stay costs");
  assert.strictEqual(snap.stay.nightlyRate, 100, "so a night is still 100, not 175");
  console.log("2) The rent and the nightly rate are left alone, because a pet fee buys no nights");
}

// ---- 3. the record everybody reads ---------------------------------
// bookingTotalOf is what the Transaction's booking_total and net_payout hold.
// It was rent + cleaning, so a booking with a pet fee reported a total lower
// than the guest had actually paid.
{
  const snap = snapshotFor();
  repriceFromInvoice(snap, tenant, ITEMS);
  assert.strictEqual(bookingTotalOf(snap), 765, "400 rent + 300 pet + 65 cleaning");

  const noPet = snapshotFor();
  repriceFromInvoice(noPet, tenant, ITEMS.filter((i) => i.name !== "Pet Fee"));
  assert.strictEqual(bookingTotalOf(noPet), 465, "and a booking without one is unchanged");
  console.log("3) The Transaction's total counts the pet fee the guest actually paid");
}

// ---- 4. cancelled, it is charged and refunded like the rent --------
// It used to sit outside the calculation entirely: the guest got their rent
// back and their pet fee kept, with nobody credited for it.
{
  const snap = snapshotFor();
  repriceFromInvoice(snap, tenant, ITEMS);
  snap.charges.processingFee = 0;

  // Two days out: the 120-hour tier keeps half.
  const twoDaysOut = Date.parse("2026-11-29T12:00:00Z");
  const calc = calcCancellation(snap, twoDaysOut, tenant, null);

  assert.strictEqual(calc.chargePct, 0.5);
  assert.strictEqual(calc.charge, 350, "half of 700, not half of 400");
  assert.strictEqual(calc.rentRefund, 350, "and the guest gets the other half of both back");
  assert.strictEqual(round2(calc.charge + calc.rentRefund), snap.payout.basis,
    "the pet fee is on one side of the line or the other, never off it");
  assert.strictEqual(calc.payoutSplit.owner, 297.5, "85% of the 350 kept");
  assert.strictEqual(calc.payoutSplit.manager, 52.5);
  console.log("4) A cancelled booking charges and refunds the pet fee at the same tier as the rent");
}

// ---- 5. names that merely contain the word --------------------------
// isPetFeeName is exact after trimming case and accents, which is what keeps
// this from splitting somebody's money on a substring.
{
  const snap = snapshotFor();
  repriceFromInvoice(snap, tenant, [
    { name: "Test Villa 3", amount: 100, qty: 4 },
    { name: "Pet Cleaning", amount: 40, qty: 1 },
    { name: "Pet Insurance", amount: 25, qty: 1 },
  ]);
  assert.strictEqual(snap.charges.petFee, undefined, "neither is the pet fee");
  assert.strictEqual(snap.payout.basis, 400, "so neither is paid out to anybody");
  console.log("5) A name containing \"pet\" is not a pet fee, and nobody is paid on one");
}

// ---- 6. Spanish, and a tenant's own wording ------------------------
{
  const spanish = snapshotFor();
  repriceFromInvoice(spanish, tenant, [
    { name: "Test Villa 3", amount: 100, qty: 4 },
    { name: "Tarifa por mascota", amount: 300, qty: 1 },
  ]);
  assert.strictEqual(spanish.charges.petFee, 300, "clients start in the DR, so the Spanish name counts");

  const custom = snapshotFor();
  repriceFromInvoice(custom, { ...tenant, petFeeName: "Cargo Perruno" }, [
    { name: "Test Villa 3", amount: 100, qty: 4 },
    { name: "Cargo Perruno", amount: 120, qty: 1 },
  ]);
  assert.strictEqual(custom.charges.petFee, 120, "and a client with its own wording sets petFeeName");
  assert.strictEqual(custom.payout.basis, 520);
  console.log("6) The Spanish name and a tenant's own wording are both recognised");
}

// ---- 7. a booking with no pet fee is untouched ---------------------
// The change has to be invisible to every booking that does not have one,
// which is most of them.
{
  const snap = snapshotFor();
  repriceFromInvoice(snap, tenant, ITEMS.filter((i) => i.name !== "Pet Fee"));
  assert.strictEqual(snap.charges.petFee, undefined, "no key at all, rather than a zero to explain");
  assert.strictEqual(snap.payout.basis, 400);
  assert.strictEqual(snap.payout.owner, 340);
  assert.strictEqual(snap.payout.manager, 60);
  console.log("7) A booking with no pet fee prices exactly as it did before");
}

console.log("\nPASS — the pet fee is split like the rent it is part of, without being mistaken for it.");
