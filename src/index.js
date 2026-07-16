// index.js (v2) — Cloudflare Worker entry
// POST /booking-created ← GHL Webhook action (after Calcular Reserva)
import { composeBooking } from "./booking-composer.js";
import { createOrder } from "./paypal.js";
import { createCheckoutSession } from "./stripe.js";
import { createBookingRecords } from "./airtable.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json" }
  });
}

async function handleBookingCreated(request, env) {
  const payload = await request.json();

  const missing = ["bookingId", "locationId", "checkIn", "checkOut"].filter(k => !payload[k]);
  if (missing.length) return json({ error: `Missing fields: ${missing.join(", ")}` }, 400);
  if (!payload.bookingTotal && !payload.nightlyRate)
    return json({ error: "Need bookingTotal or nightlyRate" }, 400);

  const tenant = await env.TENANTS.get(payload.locationId, { type: "json" });
  if (!tenant) return json({ error: `Unknown locationId: ${payload.locationId}` }, 404);
  if (tenant.bookingWorkerEnabled === false)
    return json({ error: "Booking worker disabled for this account" }, 403);

  // idempotency: existing snapshot → return existing link
  const existing = await env.BOOKINGS.get(payload.bookingId, { type: "json" });
  const existingUrl = existing?.paypal?.approveUrl || existing?.stripe?.checkoutUrl;
  if (existingUrl) {
    return json({ bookingId: payload.bookingId, approveUrl: existingUrl, idempotent: true });
  }

  const { snapshot, purchaseUnits } = composeBooking(payload, tenant);

  // Gateway dispatch — per-tenant (Accounts."Default Payment Gateway")
  const gateway = (tenant.gateway || "paypal").toLowerCase();
  let approveUrl, gatewayRef;
  if (gateway === "stripe") {
    const { sessionId, checkoutUrl } = await createCheckoutSession(tenant, env, snapshot, env.WORKER_URL);
    snapshot.stripe = { sessionId, checkoutUrl };
    approveUrl = checkoutUrl;
    gatewayRef = sessionId;
  } else {
    const { orderId, approveUrl: ppUrl } = await createOrder(tenant, env, snapshot.bookingId, purchaseUnits, env.WORKER_URL);
    snapshot.paypal = { orderId, approveUrl: ppUrl };
    approveUrl = ppUrl;
    gatewayRef = orderId;
  }
  snapshot.gateway = gateway;

  await env.BOOKINGS.put(snapshot.bookingId, JSON.stringify(snapshot));

  // Airtable mirror — non-blocking by design
  let airtable = null;
  try {
    airtable = await createBookingRecords(tenant, snapshot, gatewayRef);
  } catch (err) {
    console.error(`Airtable sync failed for ${snapshot.bookingId}:`, err.message);
    airtable = { error: err.message, needsRetry: true };
  }

  return json({
    bookingId: snapshot.bookingId,
    approveUrl,
    grandTotal: snapshot.charges.grandTotal.toFixed(2),
    rentTotal: snapshot.charges.rentTotal.toFixed(2),
    cleaningFee: snapshot.charges.cleaningFee.toFixed(2),
    processingFee: snapshot.charges.processingFee.toFixed(2),
    depositTotal: snapshot.securityDeposit.total.toFixed(2),
    nights: snapshot.stay.nights,
    nightlyRate: snapshot.stay.nightlyRate.toFixed(2),
    gateway,
    gatewayRef,
    airtableSync: airtable?.needsRetry ? "failed_will_retry" : "ok"
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/booking-created")
        return handleBookingCreated(request, env);
      if (url.pathname === "/paypal/return")
        return json({ todo: "capture + redirect — payment-webhook worker phase" });
      if (url.pathname === "/stripe/return")
        return json({ todo: "verify session + confirm — payment-webhook worker phase" });
      if (url.pathname === "/stripe/cancel")
        return json({ todo: "notify GHL cancellation workflow — next phase" });
      if (url.pathname === "/paypal/cancel")
        return json({ todo: "notify GHL cancellation workflow — next phase" });
      return json({ error: "Not found" }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: err.message }, 500);
    }
  }
};
