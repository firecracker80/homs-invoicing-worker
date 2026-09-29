// What the guest is charged, the client earned -- unless it passes through.
// Run: node test-add-on-split.mjs
//
// The rule used to run the other way: enumerate what is earned, and everything
// else reaches nobody. That cost us the pet fee, which reached nobody for as
// long as it existed, and it would have cost us the next charge too -- making
// the pet fee earned took six edits across five files, and late check-out,
// early check-in and extra guest were all queued behind it (Yari, 2026-09-29:
// "i wonder if we are overcomplicating this in an effort to streamline").
//
// So the list is inverted. Three things pass through -- tax, deposit,
// processing fee -- and they are a closed set that does not grow. Everything
// else the guest pays is the client's, split at ownerPct like the rent, with
// cleaning the one exception because it is already earned by whoever
// cleaningFeeTo names.
//
// The failure mode of getting the pass-through list wrong is visible: a client
// sees a line on a statement they did not expect. The failure mode of the old
// way round was money silently reaching no one, which is what we kept finding.
import assert from "node:assert";

const { repriceFromInvoice, isPassThrough } = await import("./src/ghl-invoice.js");
const { bookingTotalOf } = await import("./src/ledger.js");
const { calcCancellation } = await import("./src/cancellation.js");

const round2 = (n) => Math.round(n * 100) / 100;

const tenant = {
  brandName: "Casa Bonita", currency: "USD", ownerPct: 0.85, processingFeePct: 0.06,
  cleaningFeeRecipient: "manager", tzOffsetHours: -4, checkInHour: 15,
  cancellationPolicy: { tiers: [{ underHours: 120, chargePct: 0.5 }], checkedInChargePct: 1 },
};

// Four nights at 100. The listing line comes first, as GHL builds it.
const snapshotFor = () => ({
  bookingId: "ADDON-1", locationId: "LOC", propertyCode: "Test Villa 3",
  createdAt: "2026-09-01T00:00:00.000Z",
  stay: { checkIn: "2026-12-01", checkOut: "2026-12-05", nights: 4, nightlyRate: 100 },
  charges: { rentTotal: 400, cleaningFee: 65, processingFee: 0, feePct: 0.06, grandTotal: 0 },
  securityDeposit: { total: 0, blocks: [], status: "none" },
  payout: { basis: 400, ownerPct: 0.85, owner: 340, manager: 60, cleaningFeeTo: "manager", status: "pending" },
});

const LISTING = { name: "Test Villa 3", amount: 400, qty: 1 };
const CLEANING = { name: "Cleaning Fee - Test Villa 3", amount: 65, qty: 1 };

// ---- 1. the charge nobody wrote code for ---------------------------
// The point of the whole change. Nothing in the Worker has ever heard of a
// late check-out, and it is split correctly anyway.
{
  const snap = snapshotFor();
  repriceFromInvoice(snap, tenant, [
    LISTING, CLEANING,
    { name: "Late Checkout", amount: 50, qty: 1 },
    { name: "Early Check-in", amount: 40, qty: 1 },
  ]);

  assert.strictEqual(snap.charges.addOns, 90, "both of them, with no rule naming either");
  assert.strictEqual(snap.payout.basis, 490, "400 of rent plus the 90 they add to it");
  assert.strictEqual(snap.payout.owner, 416.5);
  assert.strictEqual(snap.payout.manager, 73.5);
  assert.deepStrictEqual(
    snap.charges.addOnDetail,
    [{ name: "Late Checkout", amount: 50 }, { name: "Early Check-in", amount: 40 }],
    "and each is named, so a statement can itemise what the split was taken on"
  );
  console.log("1) A charge the code has never heard of is split, with no rule naming it");
}

// ---- 2. the three that pass through --------------------------------
{
  const snap = snapshotFor();
  repriceFromInvoice(snap, tenant, [
    LISTING, CLEANING,
    { name: "ITBIS 18%", amount: 72, qty: 1 },
    { name: "Security Deposit", amount: 200, qty: 1 },
    { name: "Cargo por procesamiento / Processing fee", amount: 30, qty: 1 },
  ]);

  assert.strictEqual(snap.charges.addOns, undefined, "no key at all, rather than a zero to explain");
  assert.strictEqual(snap.payout.basis, 400, "a tax is remitted, a deposit is the guest's, a fee is the gateway's");
  assert.strictEqual(snap.payout.owner, 340, "so the split is the rent alone");
  console.log("2) Tax, deposit and processing fee pass through and are paid to nobody");
}

// ---- 3. cleaning stays with whoever cleaning belongs to ------------
// It is already earned -- by the manager, who pays the cleaner. Sweeping it
// into the add-ons would pay 85% of it to the owner as well.
{
  const snap = snapshotFor();
  repriceFromInvoice(snap, tenant, [LISTING, CLEANING]);
  assert.strictEqual(snap.charges.addOns, undefined);
  assert.strictEqual(snap.payout.basis, 400, "cleaning is not in the owner/manager rent split");
  assert.strictEqual(snap.charges.cleaningFee, 65, "it is still its own line, for its own recipient");
  console.log("3) Cleaning keeps its own recipient and is not swept into the rent split");
}

// ---- 4. the pet fee, which is just an add-on now -------------------
// It needed its own named rule yesterday. It needs none now, and behaves
// identically -- which is the test that the inversion did not lose anything.
{
  const snap = snapshotFor();
  repriceFromInvoice(snap, tenant, [LISTING, CLEANING, { name: "Pet Fee", amount: 300, qty: 1 }]);
  assert.strictEqual(snap.payout.basis, 700);
  assert.strictEqual(snap.payout.owner, 595, "85% of 700, exactly as the named rule gave");
  assert.strictEqual(snap.payout.manager, 105);

  // And in Spanish, which used to need isPetFeeName to catch. "Tarifa por
  // mascota" contains "tarifa", so the pass-through test has to be narrower
  // than the old fee patterns or this would be treated as a processing fee.
  const spanish = snapshotFor();
  repriceFromInvoice(spanish, tenant, [LISTING, { name: "Tarifa por mascota", amount: 300, qty: 1 }]);
  assert.strictEqual(spanish.payout.basis, 700, "and a Spanish name needs no list either");
  console.log("4) The pet fee is now just an add-on, and splits the same as when it had its own rule");
}

// ---- 5. the stay's own price is untouched --------------------------
// rentTotal divides by nights to give nightlyRate, which sizes the deposit and
// drives the nights-based cancellation tiers. None of these buy a night.
{
  const snap = snapshotFor();
  repriceFromInvoice(snap, tenant, [LISTING, { name: "Late Checkout", amount: 50, qty: 1 }]);
  assert.strictEqual(snap.charges.rentTotal, 400, "the stay still costs what the stay costs");
  assert.strictEqual(snap.stay.nightlyRate, 100, "so a night is 100, not 112.50");
  console.log("5) The rent and the nightly rate are left alone, because an add-on buys no nights");
}

// ---- 6. the record everybody reads ---------------------------------
{
  const snap = snapshotFor();
  repriceFromInvoice(snap, tenant, [LISTING, CLEANING, { name: "Late Checkout", amount: 50, qty: 1 }]);
  assert.strictEqual(bookingTotalOf(snap), 515, "400 rent + 50 late checkout + 65 cleaning");

  // A booking settled yesterday holds charges.petFee, not charges.addOns.
  // Its Transaction total has to keep counting it.
  const older = snapshotFor();
  older.charges = { ...older.charges, petFee: 300 };
  assert.strictEqual(bookingTotalOf(older), 765, "and a snapshot from before the rename still totals correctly");
  console.log("6) The Transaction's total counts add-ons, including on snapshots written before the change");
}

// ---- 7. cancelled, add-ons are charged and refunded like the rent --
{
  const snap = snapshotFor();
  repriceFromInvoice(snap, tenant, [LISTING, { name: "Late Checkout", amount: 50, qty: 1 }]);
  snap.charges.processingFee = 0;

  const twoDaysOut = Date.parse("2026-11-29T12:00:00Z");
  const calc = calcCancellation(snap, twoDaysOut, tenant, null);

  assert.strictEqual(calc.charge, 225, "half of 450, not half of 400");
  assert.strictEqual(calc.rentRefund, 225);
  assert.strictEqual(round2(calc.charge + calc.rentRefund), snap.payout.basis,
    "an add-on is on one side of the line or the other, never off it");
  console.log("7) A cancelled booking charges and refunds add-ons at the same tier as the rent");
}

// ---- 8. the predicate on its own -----------------------------------
{
  const pt = (name) => isPassThrough({ name }, tenant);
  assert.strictEqual(pt("ITBIS"), true);
  assert.strictEqual(pt("Impuesto sobre alojamiento"), true);
  assert.strictEqual(pt("Security Deposit"), true);
  assert.strictEqual(pt("Depósito de garantía"), true);
  assert.strictEqual(pt("Cargo por procesamiento / Processing fee"), true);

  assert.strictEqual(pt("Late Checkout"), false);
  assert.strictEqual(pt("Extra Guest"), false);
  assert.strictEqual(pt("Airport Transfer"), false);
  assert.strictEqual(pt("Firewood"), false, "a charge nobody has thought of yet is earned, not withheld");

  // Earned charges worded so that a pass-through pattern would otherwise claim
  // them. These are why isPassThrough checks cleaning and the pet fee FIRST --
  // an account is free to call its cleaning a service fee, and the money is
  // still the client's. Without that check both of these read as pass-through
  // and are paid to nobody, which is the bug the whole inversion is about.
  assert.strictEqual(pt("Cleaning Service Fee"), false,
    "an account may word its cleaning as a service fee, and the money is still earned");
  assert.strictEqual(pt("Tarifa de servicio para mascotas"), false,
    "and a charge that merely reads like a fee is the client's, not the gateway's");
  assert.strictEqual(pt("Tarifa por mascota"), false, "the ordinary Spanish pet fee, likewise");
  assert.strictEqual(pt("Cleaning Fee - Test Villa 3"), false, "cleaning is earned, by its own recipient");

  // A blank line is not money anybody can be paid.
  assert.strictEqual(pt(""), true);
  console.log("8) The pass-through list is three things, and everything else is the client's");
}

console.log("\nPASS — what the guest is charged, the client earned, unless it passes through.");
