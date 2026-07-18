// extension.js — mid-stay extensions as linked child bookings.
//   POST /extend  { parentBookingId, newCheckOut? | additionalNights?, cleaningFee? }
//   header: X-Admin-Secret  (human-triggered: guest asks, manager decides, one command)
//
// Policy (confirmed 2026-07-18):
//   Rate continuity: extension uses the PARENT's nightly rate.
//   Deposit: extension nights get their OWN tiered deposit (per original spec).
//   Processing fee: 6% (tenant pct) on extension rent + cleaning + deposit.
//   Cleaning fee: 0 by default (no mid-stay turnover) — override via payload.
//   Settlement: the child settles through the normal payment worker unchanged.

import { composeBooking } from "./booking-composer.js";
import { createOrder } from "./paypal.js";
import { createCheckoutSession } from "./stripe.js";
import { createBookingRecords } from "./airtable.js";
import { adminAuthorized, notifyGHL } from "./cancellation.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export async function handleExtend(request, env) {
  const body = await request.json();
  const parent = body.parentBookingId
    ? await env.BOOKINGS.get(body.parentBookingId, { type: "json" }) : null;
  if (!parent) return json({ error: "Unknown parentBookingId" }, 404);
  const tenant = await env.TENANTS.get(parent.locationId, { type: "json" });
  if (!tenant) return json({ error: "Unknown tenant" }, 404);
  if (!adminAuthorized(request, env, tenant)) return json({ error: "Unauthorized" }, 401);
  if (parent.cancelled) return json({ error: "Parent booking is cancelled" }, 400);
  if (!parent.settled) return json({ error: "Parent booking is not paid — extend after settlement" }, 400);

  // Extension window: starts at parent check-out
  const checkIn = parent.stay.checkOut;
  let checkOut = body.newCheckOut;
  if (!checkOut && body.additionalNights) checkOut = addDays(checkIn, Number(body.additionalNights));
  if (!checkOut) return json({ error: "Provide newCheckOut or additionalNights" }, 400);
  const nights = Math.round((new Date(checkOut) - new Date(checkIn)) / 86400000);
  if (!Number.isFinite(nights) || nights <= 0)
    return json({ error: `Invalid extension window: ${checkIn} → ${checkOut}` }, 400);

  // Deterministic child ID per target date → idempotent re-runs
  const childId = `${parent.bookingId}-EXT-${checkOut}`;
  const existing = await env.BOOKINGS.get(childId, { type: "json" });
  const existingUrl = existing?.paypal?.approveUrl || existing?.stripe?.checkoutUrl;
  if (existingUrl) {
    return json({
      bookingId: childId, approveUrl: existingUrl,
      grandTotal: existing.charges.grandTotal.toFixed(2),
      depositTotal: existing.securityDeposit.total.toFixed(2),
      nights: existing.stay.nights, idempotent: true
    });
  }

  // Compose the child with rate continuity from the parent
  const payload = {
    bookingId: childId,
    parentBookingId: parent.bookingId,
    locationId: parent.locationId,
    propertyCode: parent.propertyCode,
    ghlContactId: parent.ghlContactId,
    bookingSource: "Extension",
    language: parent.guest?.language,
    guest: parent.guest,
    checkIn, checkOut,
    nightlyRate: parent.stay.nightlyRate,        // rate continuity
    cleaningFee: Number(body.cleaningFee) || 0   // default: no mid-stay turnover
  };
  const { snapshot, purchaseUnits } = composeBooking(payload, tenant);

  // Gateway dispatch (same as booking flow)
  const gateway = (tenant.gateway || "paypal").toLowerCase();
  let approveUrl, gatewayRef;
  if (gateway === "stripe") {
    const { sessionId, checkoutUrl } = await createCheckoutSession(tenant, env, snapshot, env.WORKER_URL);
    snapshot.stripe = { sessionId, checkoutUrl };
    approveUrl = checkoutUrl; gatewayRef = sessionId;
  } else {
    const { orderId, approveUrl: ppUrl } = await createOrder(tenant, env, snapshot.bookingId, purchaseUnits, env.WORKER_URL);
    snapshot.paypal = { orderId, approveUrl: ppUrl };
    approveUrl = ppUrl; gatewayRef = orderId;
  }
  snapshot.gateway = gateway;
  await env.BOOKINGS.put(childId, JSON.stringify(snapshot));

  // Link on the parent
  parent.extensions = [...(parent.extensions || []), { bookingId: childId, checkOut, nights, createdAt: new Date().toISOString() }];
  await env.BOOKINGS.put(parent.bookingId, JSON.stringify(parent));

  // Airtable mirror (non-blocking, Parent Booking ID written by createBookingRecords)
  let airtable = null;
  try {
    airtable = await createBookingRecords(tenant, snapshot, gatewayRef);
    snapshot.airtable = { orderRecordId: airtable.orderRecordId, paymentIds: airtable.paymentIds };
    await env.BOOKINGS.put(childId, JSON.stringify(snapshot));
  } catch (err) {
    console.error(`Extension Airtable sync failed for ${childId}:`, err.message);
    airtable = { needsRetry: true };
  }

  // Push the payment link to the "Extensión de Reserva" workflow
  await notifyGHL(tenant.ghlExtensionUrl, {
    event: "extension_link_ready",
    bookingId: childId, parentBookingId: parent.bookingId,
    contactId: parent.ghlContactId || "",
    email: parent.guest?.email || "",
    firstName: (parent.guest?.name || "").split(" ")[0],
    approveUrl,
    nights: snapshot.stay.nights,
    newCheckOut: checkOut,
    rentTotal: snapshot.charges.rentTotal.toFixed(2),
    processingFee: snapshot.charges.processingFee.toFixed(2),
    depositTotal: snapshot.securityDeposit.total.toFixed(2),
    grandTotal: snapshot.charges.grandTotal.toFixed(2),
    propertyName: snapshot.propertyCode || tenant.brandName
  });

  return json({
    bookingId: childId, parentBookingId: parent.bookingId,
    approveUrl,
    nights: snapshot.stay.nights, checkIn, checkOut,
    nightlyRate: snapshot.stay.nightlyRate.toFixed(2),
    rentTotal: snapshot.charges.rentTotal.toFixed(2),
    cleaningFee: snapshot.charges.cleaningFee.toFixed(2),
    processingFee: snapshot.charges.processingFee.toFixed(2),
    depositTotal: snapshot.securityDeposit.total.toFixed(2),
    depositBlocks: snapshot.securityDeposit.blocks,
    grandTotal: snapshot.charges.grandTotal.toFixed(2),
    gateway, gatewayRef,
    airtableSync: airtable?.needsRetry ? "failed_will_retry" : "ok"
  });
}
