// Pins the five Airbnb standard policies to Airbnb's published terms.
// Source: airbnb.com/help/article/475, read 2026-09-25.
//
// Every case runs the whole chain a real client goes through: the name the
// client picked in the intake workbook -> parseCancellationPolicy -> the tenant
// record -> calcCancellation. A test that skipped the parse would pass on a
// policy no client can actually select.
//
//   node test-cancellation-policies.mjs

import { parseCancellationPolicy, AIRBNB_POLICIES } from "./src/policy.js";
import { calcCancellation } from "./src/cancellation.js";

let pass = 0;
const failures = [];

function is(label, actual, expected) {
  if (actual === expected) { pass++; return; }
  failures.push(`${label}: expected ${expected}, got ${actual}`);
}

// A 10-night stay at $100/night. Check-in 1 Oct 2026, 3 PM AST = 19:00 UTC.
const CHECK_IN_MS = Date.parse("2026-10-01T19:00:00Z");
const HOUR = 3600000;
const DAY = 24 * HOUR;

function snapshotFor({ nights = 10, nightlyRate = 100, bookedAt = "2026-01-01T00:00:00Z" } = {}) {
  return {
    createdAt: bookedAt,
    stay: { checkIn: "2026-10-01", checkOut: "2026-10-11", nights, nightlyRate },
    charges: { rentTotal: nights * nightlyRate, cleaningFee: 50, processingFee: 30 },
    securityDeposit: { total: 200 },
    payout: { ownerPct: 0.85 },
  };
}

// The tenant record provisioning writes from the workbook answer.
const tenantFor = (name) => ({ cancellationPolicy: parseCancellationPolicy(name) });

// `before` is how long before check-in the guest cancels; negative = after.
function charge(policyName, before, snapOverrides) {
  const snap = snapshotFor(snapOverrides);
  const calc = calcCancellation(snap, CHECK_IN_MS - before, tenantFor(policyName), undefined);
  return { amount: calc.charge, tier: calc.tier, refund: calc.rentRefund };
}

// ---------------------------------------------------------------- Flexible --
// Full refund up to 24h before check-in; after that, one night.
is("flexible 48h out", charge("Flexible", 48 * HOUR).amount, 0);
is("flexible 25h out", charge("Flexible", 25 * HOUR).amount, 0);
is("flexible 12h out", charge("Flexible", 12 * HOUR).amount, 100);
is("flexible after check-in", charge("Flexible", -1 * HOUR).amount, 1000);

// ---------------------------------------------------------------- Moderate --
// Full refund up to 5 days; after that one night plus 50% of the unused ones.
is("moderate 6d out", charge("Moderate", 6 * DAY).amount, 0);
is("moderate 3d out", charge("Moderate", 3 * DAY).amount, 550);   // 100 + 50% of 900
is("moderate 2h out", charge("Moderate", 2 * HOUR).amount, 550);
is("moderate after check-in", charge("Moderate", -1 * HOUR).amount, 1000);

// ----------------------------------------------------------------- Limited --
// Full refund to 14 days, 50% from 7 to 14, nothing inside 7.
is("limited 20d out", charge("Limited", 20 * DAY).amount, 0);
is("limited 10d out", charge("Limited", 10 * DAY).amount, 500);
is("limited 8d out", charge("Limited", 8 * DAY).amount, 500);
is("limited 3d out", charge("Limited", 3 * DAY).amount, 1000);

// -------------------------------------------------------------------- Firm --
// As Limited, but the full-refund window is 30 days.
is("firm 40d out", charge("Firm", 40 * DAY).amount, 0);
is("firm 20d out", charge("Firm", 20 * DAY).amount, 500);
is("firm 10d out", charge("Firm", 10 * DAY).amount, 500);
is("firm 3d out", charge("Firm", 3 * DAY).amount, 1000);

// ------------------------------------------------------------------ Strict --
// No full-refund window at all. 50% until 7 days before, nothing inside 7.
is("strict 200d out", charge("Strict", 200 * DAY).amount, 500);
is("strict 30d out", charge("Strict", 30 * DAY).amount, 500);
is("strict 8d out", charge("Strict", 8 * DAY).amount, 500);
is("strict 3d out", charge("Strict", 3 * DAY).amount, 1000);

// ---------------------------------------------------- 24h grace on booking --
// Full refund within 24h of BOOKING, if check-in is 7+ days away. Strict is the
// only policy where this changes the answer at 30 days out.
const bookedAt = (msBeforeCancel, before) =>
  new Date(CHECK_IN_MS - before - msBeforeCancel).toISOString();

is("strict, booked 2h ago, 30d out",
  charge("Strict", 30 * DAY, { bookedAt: bookedAt(2 * HOUR, 30 * DAY) }).amount, 0);
is("strict, booked 2h ago, 30d out -> tier",
  charge("Strict", 30 * DAY, { bookedAt: bookedAt(2 * HOUR, 30 * DAY) }).tier, "grace_period");
is("strict, booked 25h ago, 30d out",
  charge("Strict", 30 * DAY, { bookedAt: bookedAt(25 * HOUR, 30 * DAY) }).amount, 500);
// Booked 2h ago but check-in is only 3 days off: under the 7-day lead, no grace.
is("strict, booked 2h ago, 3d out",
  charge("Strict", 3 * DAY, { bookedAt: bookedAt(2 * HOUR, 3 * DAY) }).amount, 1000);
is("moderate, booked 2h ago, 3d out",
  charge("Moderate", 3 * DAY, { bookedAt: bookedAt(2 * HOUR, 3 * DAY) }).amount, 550);
// Exactly 7 days out, booked an hour ago: the lead time is met.
is("strict, booked 1h ago, exactly 7d out",
  charge("Strict", 7 * DAY, { bookedAt: bookedAt(1 * HOUR, 7 * DAY) }).amount, 0);

// ----------------------------------------------- a night is not a percentage --
// The whole reason for the nights format. One night of a one-night stay is
// everything; of a twenty-night stay it is 5%.
is("flexible, 1-night stay, 12h out",
  charge("Flexible", 12 * HOUR, { nights: 1 }).amount, 100);
is("flexible, 20-night stay, 12h out",
  charge("Flexible", 12 * HOUR, { nights: 20 }).amount, 100);
is("moderate, 1-night stay, 3d out",
  charge("Moderate", 3 * DAY, { nights: 1 }).amount, 100);
is("moderate, 2-night stay, 3d out",
  charge("Moderate", 3 * DAY, { nights: 2 }).amount, 150);   // 100 + 50% of 100

// A nights charge can never exceed the rent, and charge + refund is the rent.
for (const n of [1, 2, 3, 10, 20]) {
  const rent = n * 100;
  for (const p of ["Flexible", "Moderate", "Limited", "Firm", "Strict"]) {
    for (const before of [-HOUR, HOUR, 3 * DAY, 10 * DAY, 40 * DAY]) {
      const c = charge(p, before, { nights: n });
      if (c.amount < 0 || c.amount > rent) {
        failures.push(`${p} ${n}n at ${before / DAY}d: charge ${c.amount} outside 0..${rent}`);
      } else pass++;
      if (Math.round((c.amount + c.refund) * 100) !== Math.round(rent * 100)) {
        failures.push(`${p} ${n}n at ${before / DAY}d: charge+refund ${c.amount + c.refund} is not rent ${rent}`);
      } else pass++;
    }
  }
}

// ------------------------------------------------------ names and fallbacks --
is("Spanish name resolves", charge("Moderada", 3 * DAY).amount, 550);
is("name with a note resolves", charge("Moderate (5 days)", 3 * DAY).amount, 550);
is("no policy = full refund", charge("", 2 * HOUR).amount, 0);
is("unreadable policy = full refund", charge("ask me", 2 * HOUR).amount, 0);

// The legacy written format still parses and still wins where it is set.
const legacy = parseCancellationPolicy("24h 50%, 5 dias 20%, llegada 100%");
is("legacy tiers kept", legacy.tiers.length, 2);
is("legacy first tier", legacy.tiers[0].chargePct, 0.5);
is("legacy checked-in", legacy.checkedInChargePct, 1);
is("legacy has no grace", legacy.grace, null);

// Every preset must parse into something usable -- an unparsed fragment means a
// client picked a policy the Worker silently ignores.
for (const [name, text] of Object.entries(AIRBNB_POLICIES)) {
  const p = parseCancellationPolicy(text);
  is(`${name} parses cleanly`, p.unparsed.length, 0);
  is(`${name} has a grace window`, p.grace?.withinHoursOfBooking, 24);
  is(`${name} charges in full after check-in`, p.checkedInChargePct, 1);
  if (p.tiers.length) pass++; else failures.push(`${name} produced no tiers`);
}

// --------------------------------------------------------- tier boundaries --
// Added 2026-10-16. Every case above brackets a boundary without landing on
// one -- "moderate 6d out" and "moderate 3d out" sit either side of the 5-day
// edge and never test it -- so changing the tier predicate from
//
//   hoursUntil < t.underHours      to      hoursUntil <= t.underHours
//
// passed all 308 assertions, plus test-native-policies and
// test-cancel-backfill. Verified by mutation, not assumed.
//
// It decides real money. A guest cancelling at exactly 5 days out gets a full
// refund under "<" and is charged a night plus half the rest under "<=" --
// $550 of a $1,000 stay, on a one-character difference nothing was watching.
//
// The rule these pin: a tier applies STRICTLY INSIDE its window. At exactly
// the boundary the guest gets the gentler treatment, which is the reading
// Airbnb's own wording supports ("free cancellation up to 5 days before").
is("moderate exactly 5d out is still free", charge("Moderate", 120 * HOUR).amount, 0);
is("moderate a minute inside 5d charges", charge("Moderate", 120 * HOUR - 60000).amount, 550);

is("flexible exactly 24h out is still free", charge("Flexible", 24 * HOUR).amount, 0);
is("flexible a minute inside 24h charges", charge("Flexible", 24 * HOUR - 60000).amount, 100);

// Limited and Firm have two tiers, so each has two edges: the inner one where
// the whole stay starts being charged, and the outer one where the 50% band
// gives way to a full refund.
is("limited exactly 7d out is the 50% band", charge("Limited", 168 * HOUR).amount, 500);
is("limited a minute inside 7d charges in full", charge("Limited", 168 * HOUR - 60000).amount, 1000);
is("limited exactly 14d out is free", charge("Limited", 336 * HOUR).amount, 0);
is("limited a minute inside 14d is the 50% band", charge("Limited", 336 * HOUR - 60000).amount, 500);

is("firm exactly 7d out is the 50% band", charge("Firm", 168 * HOUR).amount, 500);
is("firm exactly 30d out is free", charge("Firm", 720 * HOUR).amount, 0);
is("firm a minute inside 30d is the 50% band", charge("Firm", 720 * HOUR - 60000).amount, 500);

is("strict exactly 7d out is the 50% band", charge("Strict", 168 * HOUR).amount, 500);
is("strict a minute inside 7d charges in full", charge("Strict", 168 * HOUR - 60000).amount, 1000);

// The check-in moment itself. `hoursUntil < 0` decides "already checked in",
// so AT 3 PM on the check-in day the guest has not checked in yet and the
// nearest tier applies -- not the 100% checked-in rate. A minute later it
// does. Both sides pinned: this is the one boundary where the two outcomes
// are a full stay apart.
is("moderate exactly at check-in is not yet checked in", charge("Moderate", 0).tier, "under_120h");
is("moderate exactly at check-in charges the tier", charge("Moderate", 0).amount, 550);
is("moderate a minute after check-in is checked in", charge("Moderate", -60000).tier, "already_checked_in");
is("moderate a minute after check-in charges in full", charge("Moderate", -60000).amount, 1000);

// And the grace lead, which has the same shape. "exactly 7d out" above covers
// Strict; this covers the minute inside it, where the lead is NOT met.
is("grace at exactly the 7d lead applies",
  charge("Strict", 168 * HOUR, { bookedAt: new Date(CHECK_IN_MS - 168 * HOUR - HOUR).toISOString() }).tier,
  "grace_period");
is("grace a minute inside the 7d lead does not apply",
  charge("Strict", 168 * HOUR - 60000, { bookedAt: new Date(CHECK_IN_MS - 168 * HOUR - HOUR).toISOString() }).tier,
  "under_168h");

// The other edge of the same window: how long AFTER booking the guest still
// has. 24h exactly is inside it; a minute later is not. Nothing tested this,
// so flipping `sinceBooking <= withinHoursOfBooking` to `<` survived every
// other assertion here, including the ones added above.
const far = 30 * DAY;   // well beyond any lead requirement, so only the window decides
is("grace at exactly 24h after booking still applies",
  charge("Strict", far, { bookedAt: new Date(CHECK_IN_MS - far - 24 * HOUR).toISOString() }).tier,
  "grace_period");
is("grace a minute past 24h after booking does not",
  charge("Strict", far, { bookedAt: new Date(CHECK_IN_MS - far - 24 * HOUR - 60000).toISOString() }).tier,
  "under_87600h");

// ------------------------------------------------------------------ report --
console.log(`${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log("  FAIL " + f);
process.exit(failures.length ? 1 : 0);
