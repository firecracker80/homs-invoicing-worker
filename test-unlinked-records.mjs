// A Transaction that could not be joined to its Property has to say so.
// Run: node test-unlinked-records.mjs
//
// custom_objects.transactions carries no property name of its own -- the
// dashboard resolves it entirely through the relation. So when the lookup finds
// nothing, the booking shows a blank property and there is no other clue. On
// 2026-09-26 that took two sessions to trace back to an inbound webhook putting
// the guest's name in the property field.
//
// The behaviour is deliberately unchanged: linking to a guessed property would
// be worse than not linking. What changes is that the miss is recorded.
import assert from "node:assert";

const { writeLedgerEntries } = await import("./src/ledger.js");

const tenant = { ghlPit: "pit", brandName: "Casa Bonita" };
const captures = { RENT: { gross: 335.1 } };

function makeD1() {
  const rows = [];
  return {
    _rows: rows,
    prepare: () => ({ bind: () => ({ run: async () => ({ changes: 1 }), all: async () => ({ results: [] }) }) }),
    batch: async () => [],
  };
}

// GHL with one property record, named exactly as the workbook names it.
function mockGhl(calls, { properties = ["Test Villa 2"] } = {}) {
  return async (url, init = {}) => {
    const u = String(url);
    calls.push(u);
    const body = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o) });
    if (u.includes("custom_objects.properties/records/search")) {
      return body({ records: properties.map((name, i) => ({ id: `prop-${i}`, properties: { property_name: name } })) });
    }
    if (u.includes("custom_objects.ota_channels/records/search")) return body({ records: [] });
    if (u.includes("/associations")) return body({ associations: [] });
    if (u.includes("/records/search")) return body({ records: [] });
    if (u.includes("/records")) return body({ record: { id: "rec-" + calls.length } });
    return body({});
  };
}

const snapshotFor = (propertyCode) => ({
  bookingId: "BK-UNLINKED", locationId: "L1",
  propertyCode, bookingSource: null,
  guest: { name: "PetFee Retest" },
  stay: { checkIn: "2026-09-28", checkOut: "2026-09-30", nights: 2, nightlyRate: 135 },
  charges: { rentTotal: 270, cleaningFee: 65, processingFee: 20.1 },
  securityDeposit: { total: 0 },
  payout: { basis: 270, ownerPct: 0.85, owner: 229.5, manager: 40.5, cleaningFeeTo: "manager" },
});

// ---- 1. a property that does not exist is reported ------------------------
// The real case: the webhook sent the guest's name in the property field, so
// the Worker looked up a property called "PetFee Retest".
{
  const calls = [];
  globalThis.fetch = mockGhl(calls);
  const res = await writeLedgerEntries({ LEDGER_DB: makeD1() }, tenant, snapshotFor("PetFee Retest"), captures);

  assert.strictEqual(res.ghl.ok, true, "the sync still succeeds -- the rows and Transaction are real");
  assert.ok(res.ghl.transactionId, "and the Transaction was created");

  const miss = (res.ghl.unlinked || []).find((u) => u.object === "custom_objects.properties");
  assert.ok(miss, "the missing property link is reported");
  assert.strictEqual(miss.lookedFor, "PetFee Retest", "and says exactly what it searched for");
  assert.strictEqual(miss.reason, "no_property_record_with_that_name");
  assert.match(miss.consequence, /blank|no property/i);
  assert.match(miss.consequence, /owner\/manager|default/i,
    "and names the quieter consequence -- statements falling back to the account default");
  console.log("1) A property name that matches nothing is reported, with what was searched for");
}

// ---- 2. a booking with no propertyCode at all reports differently --------
// "Nothing was sent" and "what was sent matched nothing" need different fixes.
{
  globalThis.fetch = mockGhl([]);
  const res = await writeLedgerEntries({ LEDGER_DB: makeD1() }, tenant, snapshotFor(null), captures);
  const miss = res.ghl.unlinked.find((u) => u.object === "custom_objects.properties");
  assert.strictEqual(miss.reason, "no_propertyCode_on_booking");
  assert.strictEqual(miss.lookedFor, null);
  console.log("2) A booking with no property name at all is a different report from one that matched nothing");
}

// ---- 3. a match reports nothing ------------------------------------------
{
  globalThis.fetch = mockGhl([], { properties: ["Test Villa 2"] });
  const res = await writeLedgerEntries({ LEDGER_DB: makeD1() }, tenant, snapshotFor("Test Villa 2"), captures);
  assert.deepStrictEqual(res.ghl.unlinked, [], "a booking that links cleanly reports nothing");
  console.log("3) A property that resolves reports no problem");
}

// ---- 4. the miss never fails the settlement -----------------------------
// Money has already moved. A missing relation is a reporting defect, not a
// reason to fail the write that records the payment.
{
  globalThis.fetch = mockGhl([]);
  const res = await writeLedgerEntries({ LEDGER_DB: makeD1() }, tenant, snapshotFor("Nonexistent"), captures);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.ghl.ok, true);
  console.log("4) An unlinked record never fails the settlement it belongs to");
}

// ---- 5. the Transaction is created with four money-bearing fields -------
// Added 2026-10-16, when platform_fee and net_payout were retired.
//
// Both were GHL's vocabulary for a marketplace that takes a cut and pays
// out, and neither was ever computed here: platform_fee went out as a
// hardcoded 0 beside a real processing fee, and net_payout went out equal to
// booking_total -- so the dashboard's "Revenue by property" table reported
// the gross under a "Net Payout" heading, cancelled bookings included. What
// each recipient is owed is computed in the ledger and the statements.
//
// This asserts the create payload the way test-reschedule-transaction-money
// case 5 asserts the update payload: nothing in this file read a request
// BODY before, so re-adding either field would have gone unnoticed on the
// settlement side while the reschedule side was guarded.
{
  const bodies = [];
  const recording = async (url, init = {}) => {
    const u = String(url);
    const body = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o) });
    if (u.includes("/records/search") || u.includes("/associations")) return body({ records: [], associations: [] });
    if (u.includes("/records")) {
      if (init.body) bodies.push({ url: u, props: JSON.parse(init.body).properties || {} });
      return body({ record: { id: "rec-" + bodies.length } });
    }
    return body({});
  };
  globalThis.fetch = recording;
  await writeLedgerEntries({ LEDGER_DB: makeD1() }, tenant, snapshotFor("Test Villa 2"), captures);

  const created = bodies.find((b) => b.url.includes("custom_objects.transactions"));
  assert.ok(created, "the settlement creates a Transaction record");
  assert.deepStrictEqual(Object.keys(created.props).sort(), [
    "booking_reference", "booking_total", "checkin_date", "checkout_date",
    "guest_name", "payment_status", "transaction_name",
  ], "an exact list on purpose -- it is meant to fail when the write grows a field");
  assert.strictEqual("platform_fee" in created.props, false, "HOMS takes no platform cut");
  assert.strictEqual("net_payout" in created.props, false, "and makes no payout from this record");
  assert.deepStrictEqual(created.props.booking_total, { value: 335, currency: "default" },
    "booking_total stays, and is real: 270 rent + 65 cleaning, no fee and no deposit");
  console.log("5) The Transaction is created without platform_fee or net_payout, and booking_total is still real");
}

console.log("\nPASS — a Transaction that could not find its Property says so, instead of showing a blank name.");
