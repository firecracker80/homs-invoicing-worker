// The OTA comparison line, and the rate it is allowed to use.
// Run: node test-ota-shadow-rate.mjs
//
// A flat 15.5% default shipped on 2026-09-28 and was reverted the next day,
// because it conflated two different things:
//
//   A booking that CAME FROM an OTA has a real commission at that channel's
//   real rate. custom_objects.ota_channels already carries a commission_rate
//   field, and ledger.js already resolves that channel record for the booking's
//   source -- so the true number was one field away from the code inventing one.
//
//   A DIRECT booking has no commission at all. "What Airbnb would have charged"
//   is a marketing comparison, not an accounting fact.
//
// So the line is written only when a rate has been configured deliberately.
// What this file still pins is the part that was a genuine bug either way: the
// sentence and the amount have to agree.
import assert from "node:assert";

const { writeLedgerEntries } = await import("./src/ledger.js");

const BOOKING = "BK-OTA";
const LOC = "L1";

function makeD1() {
  return {
    prepare: () => ({ bind: () => ({ run: async () => ({ changes: 1 }), all: async () => ({ results: [] }) }) }),
    batch: async () => [],
  };
}

let created = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const body = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o) });
  if (u.includes("/records/search")) return body({ records: [] });
  if (u.includes("/associations")) return body({ associations: [] });
  if (u.includes("/records") && init.method === "POST") {
    created.push(JSON.parse(init.body));
    return body({ record: { id: "rec-" + created.length } });
  }
  return body({});
};

const snapshot = () => ({
  bookingId: BOOKING, locationId: LOC, propertyCode: "Test Villa 2",
  guest: { name: "OTA Test" },
  stay: { checkIn: "2026-10-10", checkOut: "2026-10-12", nights: 2, nightlyRate: 135 },
  charges: { rentTotal: 270, cleaningFee: 65, processingFee: 20.1, feePct: 0.06 },
  securityDeposit: { total: 0 },
  payout: { basis: 270, ownerPct: 0.85, owner: 229.5, manager: 40.5, cleaningFeeTo: "manager" },
});

const run = async (tenantOver = {}) => {
  created = [];
  const tenant = { ghlPit: "pit", brandName: "Casa Bonita", currency: "USD", ...tenantOver };
  await writeLedgerEntries({ LEDGER_DB: makeD1() }, tenant, snapshot(), { RENT: { gross: 355.1 } });
  return created
    .filter((r) => r.properties?.payment_type === "shadow_ota_commission")
    .map((r) => r.properties);
};

// ---- 1. no configured rate, no line ----------------------------------
// The revert. A tenant that has said nothing about commission gets nothing
// asserted on its behalf.
{
  assert.deepStrictEqual(await run(), [], "nothing is written without a rate somebody chose");
  console.log("1) A tenant with no configured rate gets no comparison line");
}

// ---- 2. an explicit zero is also no line -----------------------------
// Absent and zero are different inputs that must reach the same place, so the
// opt-out cannot be undone by a later change to how the default is read.
{
  assert.deepStrictEqual(await run({ otaRate: 0 }), [], "an explicit zero is still none");
  console.log("2) An explicit zero rate writes no line either");
}

// ---- 3. a configured rate is used exactly as given -------------------
{
  const [row] = await run({ otaRate: 0.155 });
  assert.strictEqual(Number(row.amount?.value ?? row.amount), 41.85, "15.5% of the 270 rent basis");
  console.log("3) A configured rate is applied to the rent basis, to the cent");
}

// ---- 4. the label matches the arithmetic -----------------------------
// The bug that was real regardless of where the rate comes from:
// Math.round(0.155 * 100) is 16, so the line read "a 16% OTA commission" beside
// an amount computed at 15.5% -- on the one figure meant for prospects.
{
  const [row] = await run({ otaRate: 0.155 });
  assert.match(row.notes, /15\.5%/, "the sentence says the rate the amount was computed at");
  assert.doesNotMatch(row.notes, /16%/, "and never a rounded one");
  console.log("4) The description says 15.5%, matching the amount, not a rounded 16%");
}

// ---- 5. a whole number loses its decimal -----------------------------
{
  const [row] = await run({ otaRate: 0.15 });
  assert.match(row.notes, /\b15%/);
  assert.doesNotMatch(row.notes, /15\.0%/);
  console.log("5) A whole-number rate reads 15%, not 15.0%");
}

// ---- 6. rates differ between tenants, and are honoured ---------------
// The reason a constant was wrong: channels do not charge the same.
{
  const [row] = await run({ otaRate: 0.18 });
  assert.strictEqual(Number(row.amount?.value ?? row.amount), 48.6, "18% of 270");
  assert.match(row.notes, /18%/);
  console.log("6) A different rate produces a different amount and a matching label");
}

// ---- 7. it never counts as income ------------------------------------
// No money moved. A shadow row reaching incomeTotal would overstate what an
// owner earned by the commission rate on every booking.
{
  const [row] = await run({ otaRate: 0.155 });
  assert.strictEqual(row.category, "shadow");
  assert.strictEqual(row.cleared_for_payout, "no", "and never clears for payout");
  console.log("7) The line is category shadow and never clears for payout");
}

console.log("\nPASS — the comparison line appears only at a rate somebody chose, and says the rate it actually used.");
