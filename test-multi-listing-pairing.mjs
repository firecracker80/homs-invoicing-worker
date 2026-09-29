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

const { pairListings } = await import("./src/multi-listing.js");

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

console.log("\nPASS — invoice lines and booking services join into listings in date order, or refuse.");
