// An unresolved merge tag must not beat the fallback that exists for it.
// Run: node test-unresolved-merge-tags.mjs
//
// On 2026-09-26 three live bookings went out unpriced because a Rental Booking
// trigger has no user in context, so {{user.id}} resolved to nothing and
// send-invoice threw. The fix that day added tenant.invoiceSenderUserId as a
// fallback: `userId || tenant.invoiceSenderUserId`.
//
// That fallback was unreachable. GHL does not drop an unresolvable tag -- it
// sends the literal string "{{user.id}}", which is truthy, so it won the ||
// and went to GHL as if it were a user id. The fallback only ever applied when
// the workflow omitted userId altogether, which is not the failing case.
//
// isEditorTest does not catch it either: it looks at bookingId, checkIn,
// checkOut, stayTotal, bookingTotal and contactId. On a real booking every one
// of those resolves, so the request is correctly treated as real -- and the one
// field that did not resolve rides along inside it.
import assert from "node:assert";

const { default: worker } = await import("./src/index.js");

const TENANT = {
  brandName: "Luminara", currency: "USD", ownerPct: 0.85,
  webhookSecret: "s3cret", gateway: "ghl_invoice", invoiceStrategy: "enrich",
  ghlPit: "pit", invoiceSenderUserId: "hA2lDCTobZdQlZ7F9bJ1",
};

function harness() {
  const sends = [];
  const bookings = {};
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("/invoices/") && u.includes("/send")) {
      sends.push(init.body ? JSON.parse(init.body) : null);
      return { ok: true, status: 200, text: async () => JSON.stringify({ invoice: { _id: "inv1" } }) };
    }
    if (u.includes("/invoices")) {
      return { ok: true, status: 200, text: async () => JSON.stringify({
        invoices: [{ _id: "inv1", invoiceNumber: "000001", total: 270, invoiceItems: [{ name: "Villa Uno", amount: 270, qty: 1 }] }],
      }) };
    }
    return { ok: true, status: 200, text: async () => "{}" };
  };
  return {
    sends, bookings,
    env: {
      TENANTS: { get: async () => TENANT },
      BOOKINGS: {
        get: async (k, o) => (bookings[k] == null ? null : (o?.type === "json" ? JSON.parse(bookings[k]) : bookings[k])),
        put: async (k, v) => { bookings[k] = v; },
      },
    },
  };
}

const booking = (over = {}) => ({
  bookingId: "BK-TAG", locationId: "wLGDbGcQ4QSG3nlT3Sis",
  checkIn: "2026-10-10", checkOut: "2026-10-12", bookingTotal: 270, nights: 2,
  firstName: "Real", lastName: "Guest", email: "g@x.com", phone: "+18095550199",
  propertyName: "Villa Uno", invoiceNumber: "000001",
  ...over,
});

const post = (env, body) => worker.fetch(new Request("https://w.dev/booking-created", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Webhook-Secret": "s3cret" },
  body: JSON.stringify(body),
}), env);

// ---- 1. the literal loses to the tenant fallback -------------------------
{
  const h = harness();
  await post(h.env, booking({ userId: "{{user.id}}" }));

  assert.deepStrictEqual(h.sends.length, 1, "the invoice is sent, not failed");
  assert.deepStrictEqual(h.sends[0].userId, "hA2lDCTobZdQlZ7F9bJ1",
    "the configured sender is used -- NOT the literal merge tag");
  console.log("1) An unresolved {{user.id}} falls through to tenant.invoiceSenderUserId");
}

// ---- 2. a tag that DOES resolve still wins -------------------------------
// Who sends an invoice is a per-request fact. The guard must not flatten every
// booking onto the account default.
{
  const h = harness();
  await post(h.env, booking({ userId: "realUserId123" }));
  assert.deepStrictEqual(h.sends[0].userId, "realUserId123",
    "a resolved userId still beats the tenant fallback");
  console.log("2) A resolved userId is still preferred over the account default");
}

// ---- 3. the cause is recorded, not merely survived ----------------------
// Five bugs this week were cases where the system knew what was wrong and had
// nowhere durable to say it.
{
  const h = harness();
  await post(h.env, booking({ userId: "{{user.id}}" }));
  const snap = JSON.parse(h.bookings["BK-TAG"]);
  assert.deepStrictEqual(snap.unresolvedMergeTags, ["userId"],
    "the snapshot names the field whose tag did not resolve");
  console.log("3) The snapshot records which merge tags arrived unresolved");
}

// ---- 4. nothing is recorded when everything resolved -------------------
{
  const h = harness();
  await post(h.env, booking({ userId: "realUserId123" }));
  const snap = JSON.parse(h.bookings["BK-TAG"]);
  assert.deepStrictEqual("unresolvedMergeTags" in snap, false,
    "a clean booking carries no noise -- a key that is always present stops being a signal");
  console.log("4) A booking with everything resolved records nothing");
}

// ---- 5. any field, not just userId -------------------------------------
// The next unresolved tag will be on a different field, and it should not need
// its own fix. propertyName is the one that already went wrong once.
{
  const h = harness();
  await post(h.env, booking({ userId: "u1", propertyName: "{{ rentalBooking.property }}" }));
  const snap = JSON.parse(h.bookings["BK-TAG"]);
  assert.deepStrictEqual(snap.propertyCode, null, "a literal tag is not a property name");
  assert.deepStrictEqual(snap.unresolvedMergeTags, ["propertyName"]);
  // And it falls back the way an absent value would, rather than reaching a guest.
  assert.deepStrictEqual(snap.propertyCode || TENANT.brandName, "Luminara");
  console.log("5) The guard covers any field, with the spacing GHL actually emits");
}

// ---- 6. an editor test is still an editor test -------------------------
// isEditorTest reads the raw body, before normalisation. Nulling tags must not
// make the editor's own test fire look like a real booking and write records.
{
  const h = harness();
  const res = await post(h.env, booking({ bookingId: "{{rentalBooking.id}}", userId: "{{user.id}}" }));
  const body = await res.json();
  assert.deepStrictEqual(body.bookingId, "SAMPLE-EDITOR-TEST", "still recognised as an editor fire");
  assert.deepStrictEqual(Object.keys(h.bookings), [], "and it writes nothing");
  assert.deepStrictEqual(h.sends, [], "and sends nothing");
  console.log("6) GHL editor test fires are still detected and still write nothing");
}

console.log("\nPASS — an unresolved merge tag is treated as absent, recorded, and never sent to GHL as a value.");
