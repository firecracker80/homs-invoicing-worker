// A statement says what it covers, and a direct booking is not a missing channel.
// Run: node test-statement-scope.mjs
//
// Established 2026-09-29: money from a booking platform goes to the client
// directly and never passes through GHL. An OTA booking therefore produces no
// invoice, no payment and no ledger entry -- it never reaches the Worker at all.
//
// Two things follow. Every booking on a statement is a direct booking, and an
// owner with Airbnb income as well is reading a partial picture with nothing
// saying so. And "Direct" was being reported as an OTA channel that could not be
// found, on every single booking.
import assert from "node:assert";

const { writeLedgerEntries } = await import("./src/ledger.js");

const LOC = "L1";

function makeD1() {
  return {
    prepare: () => ({ bind: () => ({ run: async () => ({ changes: 1 }), all: async () => ({ results: [] }) }) }),
    batch: async () => [],
  };
}

const snapshot = (bookingSource) => ({
  bookingId: "BK-SCOPE", locationId: LOC, propertyCode: "Test Villa 2", bookingSource,
  guest: { name: "Scope Test" },
  stay: { checkIn: "2026-10-10", checkOut: "2026-10-12", nights: 2, nightlyRate: 135 },
  charges: { rentTotal: 270, cleaningFee: 65, processingFee: 20.1, feePct: 0.06 },
  securityDeposit: { total: 0 },
  payout: { basis: 270, ownerPct: 0.85, owner: 229.5, manager: 40.5, cleaningFeeTo: "manager" },
});

// A property record exists so the only possible unlinked report is the channel.
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const body = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o) });
  if (u.includes("custom_objects.properties/records/search")) {
    return body({ records: [{ id: "prop-1", properties: { property_name: "Test Villa 2" } }] });
  }
  if (u.includes("/records/search")) return body({ records: [] });
  if (u.includes("/associations")) return body({ associations: [] });
  if (u.includes("/records")) return body({ record: { id: "rec-1" } });
  return body({});
};

const unlinkedFor = async (bookingSource) => {
  const res = await writeLedgerEntries(
    { LEDGER_DB: makeD1() },
    { ghlPit: "pit", brandName: "Casa Bonita", currency: "USD" },
    snapshot(bookingSource),
    { RENT: { gross: 355.1 } }
  );
  return (res.ghl.unlinked || []).filter((u) => u.object === "custom_objects.ota_channels");
};

// ---- 1. a direct booking is not a missing channel --------------------
{
  assert.deepStrictEqual(await unlinkedFor("Direct"), [],
    "there is no Direct channel record and there never will be");
  console.log("1) A direct booking reports no missing OTA channel");
}

// ---- 2. nor are its other spellings ----------------------------------
// composeBooking writes "Direct"; imported and hand-entered bookings carry
// their own words for the same thing, and each one warning on every booking
// would bring the noise straight back.
{
  for (const source of ["direct", "DIRECT", " Direct ", "Direct Booking", "Website", "manual", "Directo"]) {
    assert.deepStrictEqual(await unlinkedFor(source), [], `"${source}" means no platform was involved`);
  }
  console.log("2) The other ways of writing 'direct' are treated the same");
}

// ---- 3. a real channel with no record still reports ------------------
// The guard must not swallow the case it was built for. If a booking ever does
// arrive carrying a platform name, an unrecorded channel is worth knowing about.
{
  const missing = await unlinkedFor("Airbnb");
  assert.strictEqual(missing.length, 1, "an unrecorded Airbnb channel is still reported");
  assert.strictEqual(missing[0].lookedFor, "Airbnb");
  assert.strictEqual(missing[0].reason, "no_ota_channel_record_with_that_name");
  console.log("3) A booking naming a real platform with no channel record still reports it");
}

// ---- 4. the statement says what it covers ----------------------------
// Read out of the rendered HTML rather than asserted on a constant, because the
// point is that an owner sees it.
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./src/reports.js", import.meta.url), "utf8");

  assert.match(src, /Direct bookings only/, "the statement states its scope");
  assert.match(src, /paid out by that platform and do not appear here/,
    "and says why the other bookings are absent, not merely that they are");
  assert.match(src, /class="scope-note"/, "with its own style rather than buried in the subtitle");

  // Above the total, not below it: a reader should take in what the number
  // covers before reading the number.
  //
  // Matched on the sentence rather than the class, which is what the first
  // version did -- and "scope-note" appears in the CSS block near the top of
  // the file, so it sat before "Total earned" no matter where the markup went.
  // The mutation that moved the note below the total passed cleanly.
  assert.ok(src.indexOf("Direct bookings only") < src.indexOf("Total earned"),
    "the scope is stated before the total it qualifies");
  console.log("4) The statement says it covers direct bookings only, above the total");
}

console.log("\nPASS — a statement states the scope of the money it reports, and a direct booking stops being reported as a missing channel.");
