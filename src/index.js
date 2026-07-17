// index.js (v2) — Cloudflare Worker entry
// POST /booking-created ← GHL Webhook action (after Calcular Reserva)
import { composeBooking } from "./booking-composer.js";
import { createOrder } from "./paypal.js";
import { createCheckoutSession } from "./stripe.js";
import { createBookingRecords } from "./airtable.js";
import { handlePayPalReturn, handlePayPalWebhook, handleStripeReturn, handleStripeWebhook } from "./payment.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json" }
  });
}

// Normalize the GHL webhook body to the worker's internal shape.
// Accepts both the natural GHL flat form (firstName/lastName, stayTotal,
// contactId, propertyName) and the canonical nested form.
function normalizePayload(raw) {
  const p = { ...raw };
  // money: GHL sends stayTotal (often as a string)
  if (p.bookingTotal == null && p.stayTotal != null) p.bookingTotal = Number(p.stayTotal);
  if (typeof p.bookingTotal === "string") p.bookingTotal = Number(p.bookingTotal);
  if (typeof p.cleaningFee === "string") p.cleaningFee = Number(p.cleaningFee);
  // guest: flat firstName/lastName/email/phone → nested guest{}
  if (!p.guest) {
    const name = [p.firstName, p.lastName].filter(Boolean).join(" ").trim();
    p.guest = { name: name || p.name || "", email: p.email || "", phone: p.phone || "" };
  }
  // ids: GHL vocabulary → internal vocabulary
  if (!p.ghlContactId && p.contactId) p.ghlContactId = p.contactId;
  if (!p.propertyCode && p.propertyName) p.propertyCode = p.propertyName;
  if (!p.language && raw.language) p.language = raw.language;
  return p;
}

async function handleBookingCreated(request, env) {
  const payload = normalizePayload(await request.json());
  // Headers take precedence over body values when present — lets GHL configs
  // carry routing/auth in HEADERS instead of the raw body.
  const headerLoc = request.headers?.get?.("X-Location-Id");
  if (headerLoc) payload.locationId = headerLoc.trim();
  const headerSecret = request.headers?.get?.("X-Webhook-Secret");
  if (headerSecret) payload.secret = headerSecret.trim();

  const missing = ["bookingId", "locationId", "checkIn", "checkOut"].filter(k => !payload[k]);
  if (missing.length) return json({ error: `Missing fields: ${missing.join(", ")}` }, 400);
  if (!payload.bookingTotal && !payload.nightlyRate)
    return json({ error: "Need bookingTotal or nightlyRate" }, 400);

  const tenant = await env.TENANTS.get(payload.locationId, { type: "json" });
  if (!tenant) return json({ error: `Unknown locationId: ${payload.locationId}` }, 404);
  // Shared-secret check: if the tenant config defines webhookSecret,
  // the payload must carry a matching "secret" field.
  if (tenant.webhookSecret && payload.secret !== tenant.webhookSecret)
    return json({ error: "Unauthorized" }, 401);
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
    // Persist record IDs so the payment worker updates directly (no searching)
    snapshot.airtable = { orderRecordId: airtable.orderRecordId, paymentIds: airtable.paymentIds };
    await env.BOOKINGS.put(snapshot.bookingId, JSON.stringify(snapshot));
  } catch (err) {
    console.error(`Airtable sync failed for ${snapshot.bookingId}:`, err.message);
    airtable = { error: err.message, needsRetry: true };
  }

  // Optional push notification: if the tenant config defines ghlPaymentLinkUrl
  // (a GHL Inbound Webhook trigger URL), POST the payment link + totals there.
  // Fire-and-forget: a failure here must never block the booking response.
  if (tenant.ghlPaymentLinkUrl) {
    try {
      await fetch(tenant.ghlPaymentLinkUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "payment_link_ready",
          bookingId: snapshot.bookingId,
          contactId: snapshot.ghlContactId || "",
          email: snapshot.guest.email || "",
          phone: snapshot.guest.phone || "",
          firstName: (snapshot.guest.name || "").split(" ")[0],
          approveUrl,
          grandTotal: snapshot.charges.grandTotal.toFixed(2),
          rentTotal: snapshot.charges.rentTotal.toFixed(2),
          cleaningFee: snapshot.charges.cleaningFee.toFixed(2),
          processingFee: snapshot.charges.processingFee.toFixed(2),
          depositTotal: snapshot.securityDeposit.total.toFixed(2),
          nights: snapshot.stay.nights,
          checkIn: snapshot.stay.checkIn,
          checkOut: snapshot.stay.checkOut,
          propertyName: snapshot.propertyCode || tenant.brandName
        })
      });
    } catch (err) {
      console.error(`GHL payment-link notify failed for ${snapshot.bookingId}:`, err.message);
    }
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
        return handlePayPalReturn(request, env);
      if (request.method === "POST" && url.pathname === "/paypal/webhook")
        return handlePayPalWebhook(request, env);
      if (url.pathname === "/stripe/return")
        return handleStripeReturn(request, env);
      if (request.method === "POST" && url.pathname === "/stripe/webhook")
        return handleStripeWebhook(request, env);
      if (url.pathname === "/paypal/cancel" || url.pathname === "/stripe/cancel")
        return json({ status: "cancelled", note: "guest cancelled checkout" });
      return json({ error: "Not found" }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: err.message }, 500);
    }
  }
};
