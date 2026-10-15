// webhook-seed.js -- give each of a tenant's four GHL Inbound Webhook triggers
// its first payload, so the workflow can be saved and its fields mapped.
//
// WHY THIS EXISTS
//
// A GHL Inbound Webhook trigger learns its field schema from the FIRST payload
// the URL ever receives. Until one arrives there is nothing to map and nothing
// to save against. Loading a snapshot into a new account mints fresh
// per-account webhook UUIDs, so every provisioning run starts four webhooks
// with no schema at all.
//
// WHY A UNION AND NOT JUST ANY PAYLOAD
//
// Two of the four URLs receive structurally different bodies depending on which
// branch fires:
//
//   cancellation  <- booking_cancelled          (tier, chargePct, refundTotal...)
//                 <- payment_after_cancellation (amountPaid, refundOwed, invoiceNumber...)
//
// Seed with one and the other branch's fields are never learned: the workflow
// saves, publishes, and then references a field GHL has no record of. That is
// the shape the Payment Confirmed chain broke in. So each URL is seeded with
// the UNION of every payload that can reach it, assembled by calling the
// Worker's own builders -- the seed cannot drift from production, because it IS
// production's code with sample values in it.
//
// SAFETY
//
// Seed BEFORE publishing the workflow. A published inbound webhook runs the
// whole workflow on receipt, which would send real notifications. contactId is
// deliberately empty so nothing can enrol a real contact, and every value is
// visibly fake. POST requires &confirm=seed; without it the payloads come back
// and nothing is sent.
import { adminAuthorized } from "./provision.js";
import { cancellationNotifyPayload, depositRefundNotifyPayload } from "./cancellation.js";
import { paymentConfirmedPayload, paymentAfterCancellationPayload } from "./payment.js";
import { rescheduleNotifyPayload } from "./reschedule.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { "Content-Type": "application/json" } });
}

// Fixed, obviously-not-real, and never built from today's clock: a fixture made
// with new Date() expires the moment the calendar moves past it, and makes any
// assertion about which date was sent unfalsifiable.
const SEED = {
  bookingId: "SEED-WEBHOOK-SCHEMA",
  contactId: "",                       // empty on purpose: enrols nobody
  email: "seed@example.invalid",
  guestName: "Seed Payload",
  checkIn: "2030-01-10",
  checkOut: "2030-01-14",
  propertyName: "SEED PROPERTY",
};

// The extra keys a bundled reservation's cancellation spreads in. Seeded too,
// or a multi-listing cancellation has four unmappable fields.
const MULTI_LISTING_SEED = {
  multiListing: "yes",
  listingCount: "2",
  listingDetail: "SEED-A 2030-01-10: tier_seed, refund 0.00; SEED-B 2030-01-12: tier_seed, refund 0.00",
  failedListings: "",
};

// tenant field -> the union of every payload that URL receives.
//
// `events` names what this URL can carry, so a new notify added to an existing
// URL is a visible omission here rather than a silent one. test-webhook-seed.mjs
// holds this map to every builder's actual output.
export const SEED_PAYLOADS = {
  ghlPaymentConfirmedUrl: {
    label: "Payment confirmation",
    events: ["payment_confirmed"],
    payload: () => paymentConfirmedPayload({
      bookingId: SEED.bookingId, contactId: SEED.contactId,
      amountPaid: 0, depositTotal: 0,
      checkIn: SEED.checkIn, checkOut: SEED.checkOut, propertyName: SEED.propertyName,
    }),
  },

  ghlCancellationUrl: {
    label: "Cancellation",
    events: ["booking_cancelled", "payment_after_cancellation"],
    payload: () => ({
      ...cancellationNotifyPayload({
        bookingId: SEED.bookingId, contactId: SEED.contactId, email: SEED.email,
        guestName: SEED.guestName, paid: false, tier: "tier_seed", chargePct: "0",
        chargeTotal: 0, refundTotal: 0, depositRefund: 0,
        manualRefunds: [], refundFailed: false,
        checkIn: SEED.checkIn, checkOut: SEED.checkOut, propertyName: SEED.propertyName,
        multiListing: MULTI_LISTING_SEED,
      }),
      // A union, not a replacement. `event` lands on whichever spread is last
      // and that is fine: GHL only needs to have SEEN each key once, and the
      // seed is not a real cancellation of anything.
      ...paymentAfterCancellationPayload({
        bookingId: SEED.bookingId, contactId: SEED.contactId, email: SEED.email,
        guestName: SEED.guestName, amount: 0, invoiceNumber: "SEED-0000",
        cancelledAt: "2030-01-01T00:00:00.000Z", checkIn: SEED.checkIn,
        propertyName: SEED.propertyName,
      }),
      event: "webhook_schema_seed",
    }),
  },

  ghlRescheduleUrl: {
    label: "Reschedule",
    events: ["booking_rescheduled"],
    payload: () => rescheduleNotifyPayload({
      bookingId: SEED.bookingId, contactId: SEED.contactId, email: SEED.email,
      guestName: SEED.guestName,
      oldCheckIn: SEED.checkIn, oldCheckOut: SEED.checkOut,
      newCheckIn: "2030-02-10", newCheckOut: "2030-02-14", newNights: 4,
      rentTotal: 0, depositTotal: 0, processingFee: 0, totalDelta: 0,
      settlementType: "seed", approveUrl: "", balanceDue: 0, invoiceNumber: "SEED-0000",
      adminFeeRetained: 0, cancellationTier: "tier_seed",
      manualRefundTotal: 0, refundFailed: false,
      propertyName: SEED.propertyName, calendarUpdateRequired: false,
    }),
  },

  ghlDepositRefundUrl: {
    label: "Deposit refund",
    events: ["deposit_refunded"],
    payload: () => depositRefundNotifyPayload({
      bookingId: SEED.bookingId, contactId: SEED.contactId, email: SEED.email,
      refundAmount: 0, claim: 0, status: "seed", propertyName: SEED.propertyName,
    }),
  },
};

// Built per call rather than once at module load, so a builder change cannot be
// baked into a stale constant.
export function seedPlan(tenant) {
  return Object.entries(SEED_PAYLOADS).map(([tenantField, spec]) => ({
    tenantField,
    label: spec.label,
    events: spec.events,
    url: tenant?.[tenantField] || null,
    payload: spec.payload(),
  }));
}

export async function handleSeedWebhooks(request, env) {
  const url = new URL(request.url);
  const locationId = url.searchParams.get("locationId");
  if (!locationId) return json({ error: "locationId is required" }, 400);
  if (!env.TENANTS) return json({ error: "TENANTS KV binding missing" }, 500);

  // Read first, authorize second, so the tenant's OWN adminSecret can be
  // accepted -- every tenant has one, and the statements and /cancel already
  // take it. An unauthorized caller gets the same 401 whether or not the
  // locationId exists, so this order tells them nothing.
  const tenant = await env.TENANTS.get(locationId, { type: "json" });
  if (!(await adminAuthorized(request, env, tenant))) return json({ error: "Unauthorized" }, 401);
  if (!tenant) return json({ error: `No tenant at locationId ${locationId}` }, 404);

  const plan = seedPlan(tenant);
  const missing = plan.filter((p) => !p.url).map((p) => p.tenantField);
  const warnings = [];
  if (missing.length) {
    warnings.push(
      `${missing.length} of ${plan.length} webhook URLs are not set on this tenant (${missing.join(", ")}). ` +
      "Fill the matching WGHL_*_URL custom values in GHL and re-provision, then seed again -- " +
      "an unset URL means that workflow never fires at all."
    );
  }

  // A seed that reaches a PUBLISHED workflow sends real notifications, so it
  // must not be something a stray request can do.
  const confirmed = request.method === "POST" && url.searchParams.get("confirm") === "seed";
  if (!confirmed) {
    return json({
      dryRun: true, locationId, plan, warnings,
      note: "Nothing sent. POST with &confirm=seed to deliver these. Seed while the workflows are still DRAFT -- " +
            "a published inbound webhook runs the whole workflow on receipt.",
    });
  }

  const sent = [];
  const failed = [];
  for (const p of plan) {
    if (!p.url) continue;
    try {
      const res = await fetch(p.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(p.payload),
      });
      const body = await res.text();
      // GHL answering 200 is evidence it accepted the request, NOT evidence it
      // captured the schema. That is only visible in the trigger's own field
      // list, so the response says so rather than implying otherwise.
      (res.ok ? sent : failed).push({
        tenantField: p.tenantField, label: p.label, status: res.status,
        keys: Object.keys(p.payload).length,
        ...(res.ok ? {} : { body: body.slice(0, 300) }),
      });
    } catch (err) {
      failed.push({ tenantField: p.tenantField, label: p.label, error: err.message });
    }
  }

  return json({
    dryRun: false, locationId, sent, failed, warnings,
    verify: "Open each Inbound Webhook trigger in GHL and confirm its field list now shows these keys. " +
            "A 200 here only means the request was accepted.",
  }, failed.length && !sent.length ? 502 : 200);
}
