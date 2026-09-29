// Joining the two halves of a bundled booking, and refusing when they disagree.
// Run: node test-multi-listing-pairing.mjs
//
// Neither source is complete. GET /calendars/services/bookings/{id} returns one
// services entry per listing with dates and no name or amount; the invoice
// carries names and amounts and no dates. They have to be joined.
//
// The join had to be proven rather than assumed, because a wrong pairing does
// not fail -- it prices the wrong property, which keys the wrong owner, which
// pays the wrong person.
//
// Proven on DEMO-HOMS booking JI1yIAnf498IgFIV7J9M: lines Test Villa 2 at 405
// and Test Villa 3 at 660, against stays of 3 and 6 nights. In order that gives
// 135 and 110 a night, and 110 is Test Villa 3's rate confirmed across five
// other bookings the same day. Reversed it gives 67.50 and 220, matching
// nothing. Invoice line order is chronological order.
import assert from "node:assert";

const { pairListings, pairCleaning, pairAddOns } = await import("./src/multi-listing.js");

const tenant = { currency: "USD" };

// The real invoice, #000015.
const invoiceItems = () => [
  { name: "Test Villa 2", amount: 405, qty: 1 },
  { name: "Test Villa 3", amount: 660, qty: 1 },
  { name: "Cleaning Fee", amount: 65, qty: 1 },
  { name: "Cargo por procesamiento / Processing fee", amount: 67.8, qty: 1 },
];

// The services array, in the shape the live endpoint returns.
const services = (ranges) => ranges.map(([start, end], i) => ({
  id: `svc-${i}`, serviceCategoryId: `cat-${i}`, serviceStaffId: "",
  serviceStartTime: start, serviceEndTime: end,
  serviceResources: [], serviceAddOns: [],
}));

const STAGGERED = [
  ["2026-09-30T15:00:00-04:00", "2026-10-03T11:00:00-04:00"],
  ["2026-10-03T15:00:00-04:00", "2026-10-09T11:00:00-04:00"],
];

// ---- 1. the pairing that the arithmetic proved ----------------------
{
  const out = pairListings(invoiceItems(), services(STAGGERED), tenant);
  assert.strictEqual(out.ok, true, JSON.stringify(out));
  assert.deepStrictEqual(out.listings.map((l) => [l.propertyCode, l.checkIn, l.checkOut, l.rentTotal]), [
    ["Test Villa 2", "2026-09-30", "2026-10-03", 405],
    ["Test Villa 3", "2026-10-03", "2026-10-09", 660],
  ]);

  // The check that makes it a proof rather than a coincidence: implied nightly
  // rates. 405 over 3 nights is 135; 660 over 6 is 110, Test Villa 3's known
  // rate. The reverse pairing would give 67.50 and 220.
  const nights = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
  const rates = out.listings.map((l) => l.rentTotal / nights(l.checkIn, l.checkOut));
  assert.deepStrictEqual(rates, [135, 110], "the implied nightly rates are the real ones");
  console.log("1) Invoice lines pair with date ranges in order, giving the known nightly rates");
}

// ---- 2. the services array's own order does not matter --------------
// The part that could not be proven, made irrelevant: sorting by start time
// means whatever order GHL returns produces the same pairing.
{
  const forwards = pairListings(invoiceItems(), services(STAGGERED), tenant);
  const backwards = pairListings(invoiceItems(), services([...STAGGERED].reverse()), tenant);
  assert.deepStrictEqual(backwards.listings, forwards.listings,
    "reversing the services array changes nothing, because they are sorted by date");
  console.log("2) The services array can arrive in any order -- sorting by start time settles it");
}

// ---- 3. identical dates are ambiguous exactly where it cannot matter -
// The other real booking had both listings on the same nights. Sorting cannot
// separate them, and does not need to: the ranges are the same either way, and
// the name and amount come from the line.
{
  const same = [
    ["2026-10-01T15:00:00-04:00", "2026-10-03T11:00:00-04:00"],
    ["2026-10-01T15:00:00-04:00", "2026-10-03T11:00:00-04:00"],
  ];
  const out = pairListings(invoiceItems(), services(same), tenant);
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(out.listings.map((l) => [l.propertyCode, l.rentTotal]), [
    ["Test Villa 2", 405], ["Test Villa 3", 660],
  ], "each listing keeps its own name and price");
  assert.ok(out.listings.every((l) => l.checkIn === "2026-10-01" && l.checkOut === "2026-10-03"),
    "and both get the range they share");
  console.log("3) Two listings on identical dates pair safely -- the ambiguity has no consequence");
}

// ---- 4. a single-listing invoice is not a bundle --------------------
{
  const single = [
    { name: "Test Villa 3", amount: 330, qty: 1 },
    { name: "Cleaning Fee", amount: 65, qty: 1 },
  ];
  const out = pairListings(single, services([STAGGERED[0]]), tenant);
  assert.strictEqual(out.ok, false);
  assert.match(out.reason, /not_bundled_1_priced_lines/);
  console.log("4) An ordinary booking is not treated as a bundle");
}

// ---- 5. counts that disagree are refused, never truncated ------------
// A cancelled or deleted booking comes back with its per-service dates wiped to
// empty strings, so two priced lines can meet one usable range. Pricing what we
// can see and dropping the rest loses money silently.
{
  const wiped = [
    { id: "a", serviceCategoryId: "", serviceStartTime: "", serviceEndTime: "" },
    { id: "b", serviceCategoryId: "", serviceStartTime: STAGGERED[1][0], serviceEndTime: STAGGERED[1][1] },
  ];
  const out = pairListings(invoiceItems(), wiped, tenant);
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.reason, "listing_count_mismatch");
  assert.strictEqual(out.pricedLines, 2);
  assert.strictEqual(out.datedListings, 1, "and says how far apart the two sources were");
  console.log("5) Two priced lines against one dated listing is refused, and says why");
}

// ---- 6. an empty string is not a date -------------------------------
// Worth its own case: "" parses to nothing useful and would otherwise become a
// stay with no start.
{
  const allWiped = [
    { id: "a", serviceStartTime: "", serviceEndTime: "" },
    { id: "b", serviceStartTime: "", serviceEndTime: "" },
  ];
  const out = pairListings(invoiceItems(), allWiped, tenant);
  assert.strictEqual(out.ok, false, "a booking whose dates GHL has wiped cannot be reconstructed");
  assert.strictEqual(out.datedListings, 0);
  console.log("6) Dates wiped to empty strings are rejected rather than parsed");
}

// ---- 7. fees never become listings ----------------------------------
// The cleaning and processing lines sit in the same array as the properties.
// Counting them would turn a two-listing booking into a four-listing one.
{
  const out = pairListings(invoiceItems(), services(STAGGERED), tenant);
  const names = out.listings.map((l) => l.propertyCode);
  assert.deepStrictEqual(names, ["Test Villa 2", "Test Villa 3"]);
  assert.ok(!names.some((n) => /clean|procesamiento/i.test(n)), "no fee line became a listing");
  console.log("7) Fee lines are excluded, so only the properties are counted as listings");
}

// ---- 8. a nameless or unpriced line is refused ----------------------
{
  const noName = [{ name: "", amount: 405, qty: 1 }, { name: "Test Villa 3", amount: 660, qty: 1 }];
  assert.strictEqual(pairListings(noName, services(STAGGERED), tenant).ok, false,
    "a listing with no name cannot key an owner");

  const zero = [{ name: "Test Villa 2", amount: 0, qty: 1 }, { name: "Test Villa 3", amount: 660, qty: 1 }];
  assert.strictEqual(pairListings(zero, services(STAGGERED), tenant).ok, false,
    "a listing priced at nothing is a line we do not understand");
  console.log("8) A line without a name or a price refuses the whole split");
}

// ---- 9..11 the cleaning fees ---------------------------------------
// Cleaning is per listing, and GHL's Additional Fees add one line per service,
// so the lines pair with the listings the same way the rent lines do. Nothing
// was reading them at all: composeBooking zeroes cleaningFee and the enrich
// step that fills it back in runs before the children exist.
const TWO = [{ propertyCode: "Test Villa 2" }, { propertyCode: "Test Villa 3" }];

{
  const items = [
    { name: "Test Villa 2", amount: 405, qty: 1 },
    { name: "Cleaning Fee", amount: 65, qty: 1 },
    { name: "Test Villa 3", amount: 660, qty: 1 },
    { name: "Limpieza", amount: 80, qty: 1 },
  ];
  const out = pairCleaning(items, TWO);
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(out.perListing, [65, 80],
    "in line order, the same order the rent lines pair in -- and different amounts, so the order shows");
  assert.strictEqual(out.total, 145);
  console.log("9) One cleaning line per listing pairs in order, Spanish or English");
}

{
  // A reservation with no cleaning at all. Zero is a real answer here, not the
  // absence of one, and must not be confused with the bug it replaces.
  const out = pairCleaning([{ name: "Test Villa 2", amount: 405, qty: 1 }], TWO);
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(out.perListing, [0, 0]);
  assert.strictEqual(out.total, 0);
  console.log("10) A reservation with no cleaning line is answered with zero, not refused");
}

{
  // One line, two listings -- the account charges cleaning once per booking
  // rather than once per stay. It cannot be attributed, and the choice is
  // between two wrongs: losing the money, or naming the wrong listing as
  // having earned it. The total is what the guest paid and the owner or
  // manager is owed, so the total wins and the attribution is flagged.
  const items = [
    { name: "Test Villa 2", amount: 405, qty: 1 },
    { name: "Test Villa 3", amount: 660, qty: 1 },
    { name: "Cleaning Fee", amount: 90, qty: 1 },
  ];
  const out = pairCleaning(items, TWO);
  assert.strictEqual(out.ok, false, "and it says so rather than looking like an ordinary pairing");
  assert.strictEqual(out.reason, "cleaning_line_count_mismatch");
  assert.strictEqual(out.cleaningLines, 1);
  assert.strictEqual(out.listingCount, 2);
  assert.strictEqual(out.total, 90);
  assert.deepStrictEqual(out.perListing, [90, 0], "the whole fee is kept, on one listing");
  assert.strictEqual(out.perListing.reduce((s, n) => s + n, 0), out.total,
    "nothing is lost, which is the failure this replaces");
  console.log("11) Cleaning that cannot be attributed keeps its total and flags the attribution");
}

// ---- 12..14 everything else the guest was charged -------------------
// A pet fee, a late check-out, an early check-in, a tax. Everything that is
// not the stay, not its cleaning and not a pass-through is the client's, and
// is split at ownerPct like the rent. Recognised by NOT being a pass-through,
// which is what lets a charge added in GHL tomorrow reach somebody without a
// deploy -- the pet fee took six edits across five files before anyone was
// paid for it, and the next charge would have taken the same six.
//
// pairAddOns is told which lines were claimed as listings, so the add-ons are
// exactly what is left rather than a second guess at the same question.
{
  const listings = [{ name: "Test Villa 2", amount: 405, qty: 1 }, { name: "Test Villa 3", amount: 660, qty: 1 }];
  const items = [
    listings[0],
    { name: "Cleaning Fee - Test Villa 2", amount: 65, qty: 1 },
    { name: "Late Checkout", amount: 50, qty: 1 },
    listings[1],
    { name: "Cleaning Fee - Test Villa 3", amount: 65, qty: 1 },
    { name: "Extra Guest", amount: 75, qty: 1 },
  ];
  const addOns = pairAddOns(items, listings, TWO, tenant);
  assert.strictEqual(addOns.ok, true);
  assert.deepStrictEqual(addOns.perListing, [50, 75],
    "two charges nothing in the code has heard of, paired in line order like the rest");
  assert.strictEqual(addOns.total, 125);

  assert.deepStrictEqual(pairCleaning(items, TWO).perListing, [65, 65],
    "cleaning is still its own, for its own recipient");
  console.log("12) Charges the code has never heard of pair per listing, apart from the cleaning");
}

{
  // The three that pass through, and are nobody's earnings.
  const listings = [{ name: "Test Villa 2", amount: 405, qty: 1 }, { name: "Test Villa 3", amount: 660, qty: 1 }];
  const items = [
    listings[0], { name: "ITBIS 18%", amount: 72.9, qty: 1 },
    listings[1], { name: "Depósito de garantía", amount: 200, qty: 1 },
    { name: "Cargo por procesamiento / Processing fee", amount: 80, qty: 1 },
  ];
  assert.strictEqual(pairAddOns(items, listings, TWO, tenant).total, 0,
    "a tax is remitted, a deposit is the guest's, a processing fee is the gateway's");

  // And the pet fee, which needed a named rule of its own a day ago.
  const withPet = [listings[0], { name: "Tarifa por mascota", amount: 150, qty: 1 },
                   listings[1], { name: "Pet Fee", amount: 200, qty: 1 }];
  assert.deepStrictEqual(pairAddOns(withPet, listings, TWO, tenant).perListing, [150, 200],
    "in Spanish and English, with no list naming either");
  console.log("13) Tax, deposit and processing fee pass through; the pet fee is just an add-on now");
}

{
  // One late check-out across a two-listing trip. Cannot be attributed, so the
  // total is kept whole on the first listing and flagged, rather than split on
  // a guess -- the same fallback cleaning uses.
  const listings = [{ name: "Test Villa 2", amount: 405, qty: 1 }, { name: "Test Villa 3", amount: 660, qty: 1 }];
  const items = [listings[0], listings[1], { name: "Late Checkout", amount: 90, qty: 1 }];
  const addOns = pairAddOns(items, listings, TWO, tenant);

  assert.strictEqual(addOns.ok, false);
  assert.strictEqual(addOns.reason, "add_on_line_count_mismatch");
  assert.deepStrictEqual(addOns.perListing, [90, 0]);
  assert.strictEqual(addOns.perListing.reduce((s, n) => s + n, 0), addOns.total,
    "nothing is lost, which is the whole point");

  const none = pairAddOns([listings[0], listings[1]], listings, TWO, tenant);
  assert.strictEqual(none.ok, true);
  assert.strictEqual(none.total, 0, "and nothing to attribute is a real answer, not a missing one");
  console.log("14) A single add-on across the reservation keeps its total and flags the attribution");
}

// ---- 15..18 GHL says which listing a fee belongs to -----------------
// On a booking with more than one listing, GHL names a per-listing fee after
// the listing: "Cleaning Fee - Test Villa 2". That is the account telling us,
// not a heuristic, and it beats every other rule here.
//
// It matters because every fee is per LISTING (Yari, 2026-09-29: rental
// calendars are listings, and the same manager runs properties under different
// rules -- one may allow pets at 300, another at 150, another not at all). So
// the listings in a reservation can carry different fees, or different amounts
// of the same fee, and neither order nor count can tell you which.
{
  // Deliberately out of order, and the second listing's fee is larger, so
  // pairing in order would give exactly the wrong answer.
  const listings = [{ name: "Test Villa 2", amount: 405, qty: 1 }, { name: "Test Villa 3", amount: 660, qty: 1 }];
  const items = [
    listings[0], listings[1],
    { name: "Cleaning Fee - Test Villa 3", amount: 90, qty: 1 },
    { name: "Cleaning Fee - Test Villa 2", amount: 65, qty: 1 },
  ];
  const cleaning = pairCleaning(items, TWO);

  assert.strictEqual(cleaning.attributedBy, "listing_name");
  assert.deepStrictEqual(cleaning.perListing, [65, 90],
    "each fee on the listing GHL named, not the listing its line happened to sit above");
  assert.strictEqual(cleaning.total, 155);
  console.log("15) A fee named after its listing goes to that listing, whatever order the lines arrive in");
}

{
  // Two pet fees, one per listing, at different amounts -- the same manager
  // running two properties under different rules. Impossible to get right by
  // order alone once the lines are interleaved with the cleaning.
  const listings = [{ name: "Test Villa 2", amount: 405, qty: 1 }, { name: "Test Villa 3", amount: 660, qty: 1 }];
  const items = [
    listings[0], { name: "Pet Fee - Test Villa 3", amount: 150, qty: 1 },
    listings[1], { name: "Pet Fee - Test Villa 2", amount: 300, qty: 1 },
  ];
  const addOns = pairAddOns(items, listings, TWO, tenant);

  assert.strictEqual(addOns.attributedBy, "listing_name");
  assert.deepStrictEqual(addOns.perListing, [300, 150],
    "Villa 2 charges 300 for a pet and Villa 3 charges 150, and each is credited its own");
  console.log("16) Two listings charging different amounts for the same fee are each credited their own");
}

{
  // One listing carrying SEVERAL add-ons, which is the ordinary case once an
  // account sells more than one thing: a pet fee and a late check-out on the
  // same property, both named after it, both the same listing's money.
  const listings = [{ name: "Test Villa 2", amount: 405, qty: 1 }, { name: "Test Villa 3", amount: 660, qty: 1 }];
  const items = [
    listings[0], { name: "Pet Fee - Test Villa 2", amount: 300, qty: 1 },
    { name: "Late Checkout - Test Villa 2", amount: 50, qty: 1 },
    listings[1], { name: "Late Checkout - Test Villa 3", amount: 40, qty: 1 },
  ];
  const addOns = pairAddOns(items, listings, TWO, tenant);

  assert.strictEqual(addOns.attributedBy, "listing_name");
  assert.deepStrictEqual(addOns.perListing, [350, 40], "both of Villa 2's add up rather than one replacing the other");
  assert.strictEqual(addOns.total, 390);
  console.log("16b) A listing carrying several add-ons is credited the sum, not the last one");
}

{
  // A listing whose name is contained in another listing's. Matching the name
  // anywhere in the line would put Villa Azul's fee on Villa, since
  // "cleaning fee - villa azul" contains "villa".
  const two = [{ propertyCode: "Villa" }, { propertyCode: "Villa Azul" }];
  const listings = [{ name: "Villa", amount: 405, qty: 1 }, { name: "Villa Azul", amount: 660, qty: 1 }];
  const items = [
    listings[0], listings[1],
    { name: "Cleaning Fee - Villa", amount: 65, qty: 1 },
    { name: "Cleaning Fee - Villa Azul", amount: 90, qty: 1 },
  ];
  const cleaning = pairCleaning(items, two);

  assert.strictEqual(cleaning.attributedBy, "listing_name");
  assert.deepStrictEqual(cleaning.perListing, [65, 90],
    "the suffix is matched on its separator, so one property name inside another does not claim it");
  console.log("16c) A listing whose name sits inside another's does not claim the other's fees");
}

{
  // Nothing suffixed: a single-listing booking's fee reads "Cleaning Fee"
  // plain, and a bundled booking predating the per-listing configuration does
  // too. The order rule still applies, so nothing that worked before stops.
  const listings = [{ name: "Test Villa 2", amount: 405, qty: 1 }, { name: "Test Villa 3", amount: 660, qty: 1 }];
  const items = [
    listings[0], { name: "Cleaning Fee", amount: 65, qty: 1 },
    listings[1], { name: "Cleaning Fee", amount: 65, qty: 1 },
  ];
  const cleaning = pairCleaning(items, TWO);
  assert.strictEqual(cleaning.attributedBy, "line_order", "the rule that was there before, unchanged");
  assert.deepStrictEqual(cleaning.perListing, [65, 65]);

  // Half configured -- one fee suffixed, one not -- is all-or-nothing. Guessing
  // the unsuffixed one belongs to whatever listing is left is the coin flip
  // this whole thing exists to avoid.
  const halfDone = [
    listings[0], { name: "Cleaning Fee - Test Villa 2", amount: 65, qty: 1 },
    listings[1], { name: "Cleaning Fee", amount: 90, qty: 1 },
  ];
  assert.strictEqual(pairCleaning(halfDone, TWO).attributedBy, "line_order",
    "one named and one not falls back rather than half-attributing");
  console.log("17) Unsuffixed fees still pair in order, and a half-configured booking does not half-attribute");
}

{
  // A fee configured on ONE listing of two. It is that listing's -- pets are
  // allowed at one property and not the other -- but the line does not say
  // which, so we cannot know. Kept whole and flagged.
  //
  // Emphatically NOT spread across the listings: that would credit an owner
  // for a fee their property does not charge.
  const listings = [{ name: "Test Villa 2", amount: 405, qty: 1 }, { name: "Test Villa 3", amount: 660, qty: 1 }];
  const items = [listings[0], listings[1], { name: "Pet Fee", amount: 300, qty: 1 }];
  const addOns = pairAddOns(items, listings, TWO, tenant);

  assert.strictEqual(addOns.ok, false);
  assert.strictEqual(addOns.attributedBy, undefined, "nothing claims to know which listing it was");
  assert.deepStrictEqual(addOns.perListing, [300, 0], "kept whole rather than split across properties");
  assert.strictEqual(addOns.total, 300);

  // And once the account names it, the same booking attributes exactly.
  const named = [listings[0], listings[1], { name: "Pet Fee - Test Villa 3", amount: 300, qty: 1 }];
  const fixed = pairAddOns(named, listings, TWO, tenant);
  assert.strictEqual(fixed.ok, true);
  assert.deepStrictEqual(fixed.perListing, [0, 300],
    "on the listing that actually charges it, which is the one the fallback got wrong");
  console.log("18) A fee on one listing of two is kept whole and flagged, and named it attributes exactly");
}

console.log("\nPASS — invoice lines and booking services join into listings in date order, or refuse.");
