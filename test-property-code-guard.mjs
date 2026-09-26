// A property is not a person.
// Run: node test-property-code-guard.mjs
//
// Seen live from 2026-09-17: an inbound webhook mapped the guest's name into
// the property field, so every booking claimed to be at a property named after
// its own guest. The value then keys per-property owner and manager names, and
// is sent onward as propertyName in the payloads that drive guest-facing
// messages -- so a guest could read their own name where the property belongs.
import assert from "node:assert";

const { composeBooking } = await import("./src/booking-composer.js");

// normalizePayload is not exported, so the guard is exercised where it lives:
// through the /booking-created handler's own normalisation.
const { default: worker } = await import("./src/index.js");

const TENANT = {
  brandName: "Casa Bonita", currency: "USD", ownerPct: 0.85,
  ownerName: "Account Default Owner", managerName: "Account Default Manager",
  propertyOwnerNames: { "Test Villa 2": "Carlos Mendoza" },
  propertyManagerNames: { "Test Villa 2": "Rosa Jimenez" },
  webhookSecret: "s3cret", gateway: "ghl_invoice", invoiceStrategy: "enrich",
};

function envWith() {
  const bookings = {};
  return {
    bookings,
    TENANTS: { get: async () => TENANT },
    BOOKINGS: {
      get: async (k, o) => (bookings[k] == null ? null : (o?.type === "json" ? JSON.parse(bookings[k]) : bookings[k])),
      put: async (k, v) => { bookings[k] = v; },
    },
  };
}

const post = (env, body) => worker.fetch(new Request("https://w.dev/booking-created", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Webhook-Secret": "s3cret" },
  body: JSON.stringify(body),
}), env);

const booking = (over = {}) => ({
  bookingId: "BK-GUARD", locationId: "L1",
  checkIn: "2026-09-28", checkOut: "2026-09-30",
  bookingTotal: 270, nights: 2,
  firstName: "PetFee", lastName: "Retest",
  email: "g@x.com", phone: "+18095550100",
  ...over,
});

// ---- 1. a property named after the guest is rejected --------------------
{
  const env = envWith();
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => "{}" });
  await post(env, booking({ propertyName: "PetFee Retest" }));

  const snap = JSON.parse(env.bookings["BK-GUARD"]);
  assert.strictEqual(snap.propertyCode, null, "the guest's own name is not a property");
  assert.strictEqual(snap.propertyCodeRejected, "PetFee Retest", "and what was rejected is kept, so the cause is traceable");
  console.log("1) A propertyCode identical to the guest name is rejected and recorded");
}

// ---- 2. matching is not case or whitespace sensitive -------------------
// The same wrong mapping with different casing is the same wrong mapping.
{
  const env = envWith();
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => "{}" });
  await post(env, booking({ propertyName: "  petfee retest  " }));
  assert.strictEqual(JSON.parse(env.bookings["BK-GUARD"]).propertyCode, null);
  console.log("2) The guard is not defeated by casing or padding");
}

// ---- 3. a real property is untouched ----------------------------------
// The guard must never reject a legitimate name -- a property can be called
// anything, including something that merely resembles a person.
{
  const env = envWith();
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => "{}" });
  await post(env, booking({ propertyName: "Test Villa 2" }));

  const snap = JSON.parse(env.bookings["BK-GUARD"]);
  assert.strictEqual(snap.propertyCode, "Test Villa 2");
  assert.strictEqual(snap.propertyCodeRejected, undefined);
  // And the per-property names resolve, which is what the bad value was breaking.
  assert.strictEqual(snap.payout.ownerName, "Carlos Mendoza",
    "a good propertyCode reaches the property's real owner, not the account default");
  assert.strictEqual(snap.payout.managerName, "Rosa Jimenez");
  console.log("3) A real property name passes through and resolves its own owner and manager");
}

// ---- 4. a property that happens to be a person's name is allowed ------
// "Casa Yajahira" or a villa named after its owner is legitimate. Only an EXACT
// match against the guest on this booking is evidence of a mis-mapping.
{
  const env = envWith();
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => "{}" });
  // The hard case: the property legitimately CONTAINS the guest's own name. A
  // guest called Yajahira Velazquez booking "Villa Yajahira" is completely
  // ordinary, and rejecting it would be a new bug in place of the old one.
  await post(env, booking({ propertyName: "Villa Yajahira", firstName: "Yajahira", lastName: "Velazquez" }));
  assert.strictEqual(JSON.parse(env.bookings["BK-GUARD"]).propertyCode, "Villa Yajahira",
    "a property containing the guest name is still a property -- only an exact match is evidence");

  // And a one-word property matching only the guest's first name.
  await post(env, booking({ propertyName: "Arpel", firstName: "Arpel", lastName: "Jones" }));
  assert.strictEqual(JSON.parse(env.bookings["BK-GUARD"]).propertyCode, "Arpel",
    "matching the first name alone is not evidence of a mis-mapping");
  console.log("4) Only an exact match against THIS booking's guest is treated as a mis-mapping");
}

// ---- 5. rejection falls back to the account default, not the guest ----
// The whole point: what gets sent onward must never be the guest's own name.
{
  const env = envWith();
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => "{}" });
  await post(env, booking({ propertyName: "PetFee Retest" }));
  const snap = JSON.parse(env.bookings["BK-GUARD"]);
  // propertyName in every outbound payload is `snapshot.propertyCode || tenant.brandName`.
  const outboundPropertyName = snap.propertyCode || TENANT.brandName;
  assert.strictEqual(outboundPropertyName, "Casa Bonita",
    "a guest must never be told their booking is at a property named after themselves");
  console.log("5) A rejected propertyCode falls back to the brand, never reaching a guest-facing message");
}

console.log("\nPASS — a propertyCode that is the guest's own name is rejected, recorded, and never sent onward.");
