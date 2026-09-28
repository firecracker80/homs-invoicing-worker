// Every booking shows what an OTA would have taken.
// Run: node test-ota-shadow-rate.mjs
//
// The shadow commission line was skipped unless a tenant had configured
// otaRate, so as never to guess a commission rate on a client's behalf. In
// practice no tenant ever had one -- otaRate lives only in KV, is not a custom
// value, and is not in the provisioning blueprint. The number the marketing
// leans on had never been written for anybody, and could not be turned on
// through onboarding at all. Found 2026-09-28 answering what was safe to film.
//
// Yari's call: 15.5% across the board, Airbnb's host-only fee. It does not vary
// by client, so a default beats a field nobody fills in.
import assert from "node:assert";

const { writeLedgerEntries, OTA_RATE_DEFAULT } = await import("./src/ledger.js");

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

// ---- 1. a tenant with no otaRate still gets the line ------------------
{
  const rows = await run();
  assert.strictEqual(rows.length, 1, "the line is written without any per-client configuration");
  assert.strictEqual(OTA_RATE_DEFAULT, 0.155, "at Airbnb's host-only fee");
  console.log("1) Every tenant gets a shadow commission line, with no configuration needed");
}

// ---- 2. the amount is 15.5% of the rent basis ------------------------
{
  const [row] = await run();
  const amount = Number(row.amount?.value ?? row.amount);
  assert.strictEqual(amount, 41.85, "15.5% of 270, to the cent");
  console.log("2) It is reckoned against the rent basis: 41.85 on a 270 stay");
}

// ---- 3. the label matches the arithmetic ----------------------------
// This is the assertion that exists because of the bug. Math.round(0.155 * 100)
// is 16, so the line read "a 16% OTA commission" beside an amount computed at
// 15.5% -- on the single figure meant to be shown to prospects.
{
  const [row] = await run();
  assert.match(row.notes, /15\.5%/, "the sentence says the rate the amount was computed at");
  assert.doesNotMatch(row.notes, /16%/, "and never a rounded one");
  console.log("3) The description says 15.5%, matching the amount, not a rounded 16%");
}

// ---- 4. a whole number loses its decimal ----------------------------
// "15.0%" is not how anyone writes a rate.
{
  const [row] = await run({ otaRate: 0.15 });
  assert.match(row.notes, /\b15%/);
  assert.doesNotMatch(row.notes, /15\.0%/);
  console.log("4) A whole-number rate reads 15%, not 15.0%");
}

// ---- 5. a tenant can still set its own -------------------------------
{
  const [row] = await run({ otaRate: 0.18 });
  assert.strictEqual(Number(row.amount?.value ?? row.amount), 48.6, "18% of 270");
  assert.match(row.notes, /18%/);
  console.log("5) A tenant with a different channel mix can override the default");
}

// ---- 6. and zero turns it off entirely -------------------------------
// The escape hatch has to be an explicit 0, not merely an absent field -- which
// is exactly the distinction the default now depends on.
{
  const rows = await run({ otaRate: 0 });
  assert.deepStrictEqual(rows, [], "no line at all for a tenant that wants none");
  console.log("6) Setting the rate to zero removes the line, rather than falling back to the default");
}

// ---- 7. it never counts as income ------------------------------------
// No money moved. A shadow row leaking into incomeTotal would overstate what an
// owner earned by 15.5% of every booking.
{
  const [row] = await run();
  assert.strictEqual(row.category, "shadow");
  assert.notStrictEqual(row.category, "income");
  console.log("7) The line is category shadow, so it never reaches an owner's income total");
}

console.log("\nPASS — every booking records what an OTA would have taken, at a rate the sentence and the amount agree on.");
