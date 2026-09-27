// A record update has to say which account it belongs to.
// Run: node test-update-record-scope.mjs
//
// DEMO-HOMS booking 5LJInecEx6XApoXe19Qn, 2026-09-26. The cancellation reached
// the Worker, priced correctly (202.50 retained, 132.50 refunded) and notified
// the guest. Then the write back to GHL failed:
//
//   cancellationSyncError: "Custom Object (custom_objects.transactions) not found"
//
// That object plainly exists -- createObjectRecord had written a Transaction
// and four Payment records into it minutes earlier with the SAME PIT. What
// differed is that create passes locationId and update did not, so the schema
// lookup had nothing to scope to. It was the only object call in ghl.js that
// left it out.
//
// The visible symptom was the worst kind: the booking is cancelled and the
// guest has been told, while the Transaction still reads paid. Anyone looking
// at the CRM sees a live booking.
import assert from "node:assert";

const { updateObjectRecord } = await import("./src/ghl.js");

const LOC = "ZghxU8I60bEm39JUbtCm";
const TX = "6ab80c0c901aff2ab0e8137b";

function capture(response = { record: { id: TX } }) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, text: async () => JSON.stringify(response) };
  };
  return calls;
}

// ---- 1. the account is on the request --------------------------------
{
  const calls = capture();
  await updateObjectRecord("pit", LOC, "custom_objects.transactions", TX, { payment_status: "refunded" });

  const u = new URL(calls[0].url);
  assert.strictEqual(u.searchParams.get("locationId"), LOC,
    "without this GHL cannot resolve the schema and reports the object as not found");
  assert.strictEqual(u.pathname, `/objects/custom_objects.transactions/records/${TX}`);
  assert.strictEqual(calls[0].method, "PUT");
  assert.deepStrictEqual(calls[0].body, { properties: { payment_status: "refunded" } },
    "and locationId rides in the query string, not the body -- the body is the record's own fields");
  console.log("1) The update names the account, in the query string, alongside the record path");
}

// ---- 2. the record id is not mistaken for the object key -------------
// The argument the fix inserts sits between pit and objectKey, so a call site
// that was not updated would shift every following argument by one and send
// the object key as the location. That fails as a confusing 404 rather than a
// type error, which is exactly how this went unnoticed.
{
  const calls = capture();
  await updateObjectRecord("pit", LOC, "custom_objects.transactions", TX, { checkin_date: "2026-10-01" });
  assert.ok(!calls[0].url.includes("locationId=custom_objects"),
    "the object key must never end up in the locationId slot");
  assert.ok(calls[0].url.includes(`/records/${TX}?`), "and the record id stays in the path");
  console.log("2) A shifted argument would be visible, not silent");
}

// ---- 3. every call site passes one ------------------------------------
// Checked against the source rather than by exercising four handlers: the point
// is that no call site is left on the old shape, and a fifth added later is
// caught the same way.
{
  const { readFileSync } = await import("node:fs");
  const offenders = [];
  for (const file of ["src/cancellation.js", "src/reschedule.js", "src/ledger.js", "src/payment.js"]) {
    const src = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    for (const m of src.matchAll(/updateObjectRecord\(\s*([^,]+),\s*([^,]+),/g)) {
      // Second argument must be a location, never an object key.
      if (m[2].includes("custom_objects.")) offenders.push(`${file}: ${m[0].trim()}`);
    }
  }
  assert.deepStrictEqual(offenders, [], "a call site still passing the object key second");
  console.log("3) No call site still uses the old argument order");
}

// ---- 4. a missing locationId does not silently build a broken URL ----
// Defensive: if a future caller has no locationId to hand, the request should
// not carry "locationId=undefined" -- that reads as a real account to GHL and
// produces a different, less searchable error.
{
  const calls = capture();
  await updateObjectRecord("pit", undefined, "custom_objects.transactions", TX, { payment_status: "paid" });
  assert.ok(!calls[0].url.includes("locationId="),
    "no locationId is better than the string undefined");
  console.log("4) A missing locationId is omitted, never sent as the literal undefined");
}

console.log("\nPASS — record updates are scoped to their account, so GHL can find the object they belong to.");
