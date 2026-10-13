// The seed payload for each webhook URL must be a SUPERSET of every payload
// the Worker actually posts to that URL. GHL captures a webhook's field schema
// from the first payload it ever receives, so a key the seed omits is a key the
// workflow can never reference -- and the omission is invisible until a
// particular branch fires at a client, months later.
//
// These tests call the real builders rather than restating their keys, so a
// field added to a notify payload and not to the seed fails here.
import assert from "node:assert/strict";
import { SEED_PAYLOADS, seedPlan } from "./src/webhook-seed.js";
import { cancellationNotifyPayload, depositRefundNotifyPayload } from "./src/cancellation.js";
import { paymentConfirmedPayload, paymentAfterCancellationPayload } from "./src/payment.js";
import { rescheduleNotifyPayload } from "./src/reschedule.js";

const keys = (o) => Object.keys(o).sort();
const seedKeysFor = (field) => keys(SEED_PAYLOADS[field].payload());

function assertCovered(field, builderOutput, what) {
  const seeded = new Set(seedKeysFor(field));
  const missing = keys(builderOutput).filter((k) => !seeded.has(k));
  assert.deepStrictEqual(missing, [],
    `${what} posts to ${field} with key(s) the seed never sends: ${missing.join(", ")}`);
}

// Values are irrelevant to key coverage; what matters is that nothing is
// omitted because an argument happened to be falsy. Every optional input is
// populated so no builder can take a short branch and hide a key.
const FULL = {
  bookingId: "B1", contactId: "C1", email: "g@example.invalid", guestName: "Ana Perez",
  checkIn: "2030-03-01", checkOut: "2030-03-05", propertyName: "P1",
};

console.log("1) payment confirmation URL covers paymentConfirmedPayload");
assertCovered("ghlPaymentConfirmedUrl", paymentConfirmedPayload({
  ...FULL, amountPaid: 100, depositTotal: 50,
}), "paymentConfirmedPayload");

console.log("2) cancellation URL covers booking_cancelled, including its bundled extension");
assertCovered("ghlCancellationUrl", cancellationNotifyPayload({
  ...FULL, paid: true, tier: "t", chargePct: 50, chargeTotal: 10, refundTotal: 20,
  depositRefund: 30, manualRefunds: [{ type: "rent_needed_manual", amount: 5 }],
  refundFailed: true,
  multiListing: { multiListing: "yes", listingCount: "2", listingDetail: "d", failedListings: "f" },
}), "cancellationNotifyPayload");

console.log("3) cancellation URL also covers payment_after_cancellation -- the shape with almost no overlap");
assertCovered("ghlCancellationUrl", paymentAfterCancellationPayload({
  ...FULL, amount: 975.2, invoiceNumber: "INV-000031", cancelledAt: "2030-01-01T00:00:00.000Z",
}), "paymentAfterCancellationPayload");

// The regression this whole file exists for. These five were absent from the
// unpaid reschedule body until 2026-10-13, so an account whose first reschedule
// was unpaid could never map them -- and a shortened paid stay owing a guest
// money had nowhere to say so.
console.log("4) reschedule URL covers both paths, and both paths now emit one key set");
const rsUnpaid = rescheduleNotifyPayload({
  ...FULL, oldCheckIn: "2030-03-01", oldCheckOut: "2030-03-05",
  newCheckIn: "2030-04-01", newCheckOut: "2030-04-05", newNights: 4,
  rentTotal: 100, depositTotal: 0, processingFee: 0, totalDelta: 100,
  settlementType: "unpaid_new_link", approveUrl: "https://pay",
  balanceDue: null, invoiceNumber: "", adminFeeRetained: 0, cancellationTier: "",
  calendarUpdateRequired: false,
});
const rsSettled = rescheduleNotifyPayload({
  ...FULL, oldCheckIn: "2030-03-01", oldCheckOut: "2030-03-05",
  newCheckIn: "2030-04-01", newCheckOut: "2030-04-05", newNights: 4,
  rentTotal: 100, depositTotal: 50, processingFee: 9, totalDelta: -40,
  settlementType: "refund_due", approveUrl: "",
  balanceDue: 12.5, invoiceNumber: "INV-9", adminFeeRetained: 3, cancellationTier: "t2",
  manualRefundTotal: 40, refundFailed: true, calendarUpdateRequired: true,
});
assert.deepStrictEqual(keys(rsUnpaid), keys(rsSettled),
  "the two reschedule paths must emit the SAME key set, or GHL's captured schema depends on which fired first");
for (const k of ["balanceDue", "invoiceNumber", "manualRefundRequired", "manualRefundTotal", "refundFailed"]) {
  assert.ok(k in rsUnpaid, `${k} must be present on the unpaid path too, even when blank`);
}
assertCovered("ghlRescheduleUrl", rsUnpaid, "rescheduleNotifyPayload (unpaid)");
assertCovered("ghlRescheduleUrl", rsSettled, "rescheduleNotifyPayload (settled)");

console.log("5) deposit refund URL covers depositRefundNotifyPayload");
assertCovered("ghlDepositRefundUrl", depositRefundNotifyPayload({
  ...FULL, refundAmount: 200, claim: 50, status: "partial",
}), "depositRefundNotifyPayload");

// calendarUpdateRequired is inverted relative to calendar.ok at both call
// sites, and I got it backwards once while extracting the builder. A reschedule
// that silently reported the calendar as updated would leave a property double
// bookable with nobody told.
console.log("6) calendarUpdateRequired is true exactly when the calendar did NOT update");
assert.strictEqual(rescheduleNotifyPayload({ calendarUpdateRequired: true }).calendarUpdateRequired, "true");
assert.strictEqual(rescheduleNotifyPayload({ calendarUpdateRequired: false }).calendarUpdateRequired, "false");

console.log("7) the seed enrols nobody and carries no real dates");
for (const [field, spec] of Object.entries(SEED_PAYLOADS)) {
  const p = spec.payload();
  assert.strictEqual(p.contactId, "", `${field}: contactId must be empty so a seed cannot enrol a contact`);
  const asText = JSON.stringify(p);
  const thisYear = String(new Date().getFullYear());
  assert.ok(!asText.includes(thisYear),
    `${field}: the seed must not contain the current year -- a fixture built from the clock expires, and "which date did it send?" stops being falsifiable`);
}

console.log("8) a tenant missing a URL yields a plan entry with url null, not a skipped one");
const partial = seedPlan({ ghlCancellationUrl: "https://x/c" });
assert.strictEqual(partial.length, Object.keys(SEED_PAYLOADS).length, "every URL is reported, set or not");
assert.strictEqual(partial.find((p) => p.tenantField === "ghlRescheduleUrl").url, null);
assert.strictEqual(partial.find((p) => p.tenantField === "ghlCancellationUrl").url, "https://x/c");

console.log("9) seedPlan reads the builders live, so a stale constant cannot be served");
const a = seedPlan({}), b = seedPlan({});
assert.notStrictEqual(a[0].payload, b[0].payload, "each call builds a fresh payload object");
assert.deepStrictEqual(a[0].payload, b[0].payload, "...with identical content");

console.log("\nall webhook-seed tests passed");

// ---- the handler ------------------------------------------------------------
//
// This is the half that actually POSTs to a client's GHL account, so the gate
// matters more than the payload: a seed that fires without being asked for
// reaches a published workflow and sends real notifications.
import { handleSeedWebhooks } from "./src/webhook-seed.js";

const TENANT = {
  brandName: "Test",
  ghlPaymentConfirmedUrl: "https://ghl.test/hooks/payment",
  ghlCancellationUrl: "https://ghl.test/hooks/cancel",
  ghlRescheduleUrl: "https://ghl.test/hooks/resched",
  // ghlDepositRefundUrl deliberately absent
};
const envFor = (tenant = TENANT) => ({
  ADMIN_SECRET: "s3cret",
  TENANTS: { get: async (k) => (k === "LOC1" ? tenant : null) },
});
const req = (qs, { method = "GET", secret = "s3cret" } = {}) =>
  new Request(`https://w.test/admin/seed-webhooks${qs}`, {
    method, headers: secret == null ? {} : { "X-Admin-Secret": secret },
  });

let posts = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  posts.push({ url, body: JSON.parse(opts.body) });
  return new Response("{}", { status: 200 });
};

console.log("10) the wrong admin secret gets nothing, and posts nothing");
posts = [];
let res = await handleSeedWebhooks(req("?locationId=LOC1", { method: "POST", secret: "wrong" }), envFor());
assert.strictEqual(res.status, 401);
assert.deepStrictEqual(posts, [], "an unauthorized call must not reach the client's account");

console.log("11) a GET sends nothing, even with confirm");
posts = [];
res = await handleSeedWebhooks(req("?locationId=LOC1&confirm=seed"), envFor());
let out = await res.json();
assert.strictEqual(out.dryRun, true);
assert.deepStrictEqual(posts, [], "a GET must never deliver a payload");

console.log("12) a POST without confirm=seed sends nothing");
posts = [];
out = await (await handleSeedWebhooks(req("?locationId=LOC1", { method: "POST" }), envFor())).json();
assert.strictEqual(out.dryRun, true);
assert.deepStrictEqual(posts, [], "the confirm gate is what stops an accidental send");

console.log("13) an unset URL is warned about, not silently skipped");
assert.ok(out.warnings.some((w) => w.includes("ghlDepositRefundUrl")),
  "a webhook with no URL means that workflow never fires -- it has to be said");

console.log("14) POST with confirm posts once per configured URL, and nothing to the unset one");
posts = [];
out = await (await handleSeedWebhooks(req("?locationId=LOC1&confirm=seed", { method: "POST" }), envFor())).json();
assert.strictEqual(out.dryRun, false);
assert.strictEqual(posts.length, 3, "three URLs are set, so three posts");
assert.deepStrictEqual(posts.map((p) => p.url).sort(), [
  "https://ghl.test/hooks/cancel", "https://ghl.test/hooks/payment", "https://ghl.test/hooks/resched",
]);
assert.strictEqual(out.sent.length, 3);
assert.strictEqual(out.failed.length, 0);

console.log("15) each posted body is the union the plan promised, not a subset");
for (const p of posts) {
  const field = Object.entries(TENANT).find(([, v]) => v === p.url)[0];
  assert.deepStrictEqual(keys(p.body), seedKeysFor(field), `${field} posted a different key set than planned`);
}

console.log("16) a webhook GHL rejects is reported as failed, not counted as sent");
posts = [];
globalThis.fetch = async (url) => url.includes("cancel")
  ? new Response("bad hook", { status: 404 })
  : new Response("{}", { status: 200 });
out = await (await handleSeedWebhooks(req("?locationId=LOC1&confirm=seed", { method: "POST" }), envFor())).json();
assert.strictEqual(out.sent.length, 2);
assert.deepStrictEqual(out.failed.map((f) => f.tenantField), ["ghlCancellationUrl"]);
assert.strictEqual(out.failed[0].status, 404);

// A 200 from GHL says the request was accepted. Whether the trigger actually
// captured the field schema is only visible in the trigger's own field list.
console.log("17) the response does not claim the schema was captured");
assert.ok(/only means the request was accepted/i.test(out.verify));

console.log("18) an unknown locationId is a 404, not an empty success");
res = await handleSeedWebhooks(req("?locationId=NOPE", { method: "POST" }), envFor());
assert.strictEqual(res.status, 404);

globalThis.fetch = realFetch;
console.log("\nall webhook-seed handler tests passed");
