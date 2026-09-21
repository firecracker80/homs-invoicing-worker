// payment.js — payment confirmation, settlement, ledgers, GHL notification.
// Routes handled (wired in index.js):
//   GET  /paypal/return   — guest returns from PayPal → capture both purchase units
//   POST /paypal/webhook  — PAYMENT.CAPTURE.COMPLETED (source of truth; verified)
//   GET  /stripe/return   — guest returns from Stripe → verify session paid
//   POST /stripe/webhook  — checkout.session.completed (HMAC-verified)
//
// All paths converge on settle(), which is idempotent: a booking settles once,
// no matter how many of these fire or in what order.

import { getAccessToken } from "./paypal.js";
import { settleRescheduleAdjustment } from "./reschedule.js";
import { writeLedgerEntries } from "./ledger.js";
import { fetchInvoice, listContactInvoices, bookingIdOf, normStatus, findInvoiceTransactionId } from "./ghl-invoice.js";

const round2 = n => Math.round(n * 100) / 100;

function html(body, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function resolveSecret(tenant, env, nameKey, inlineKey) {
  if (tenant[nameKey] && env[tenant[nameKey]]) return env[tenant[nameKey]];
  return tenant[inlineKey];
}

// ---------------------------------------------------------------- PayPal ----

async function capturePayPalOrder(tenant, env, paypalOrderId) {
  const token = await getAccessToken(tenant, env);
  const res = await fetch(`${tenant.paypalApi}/v2/checkout/orders/${paypalOrderId}/capture`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
      "PayPal-Request-Id": `capture-${paypalOrderId}` // idempotent capture
    }
  });
  const data = await res.json();
  // ORDER_ALREADY_CAPTURED is fine — fetch the order for its capture details
  if (!res.ok) {
    const already = JSON.stringify(data).includes("ORDER_ALREADY_CAPTURED");
    if (!already) throw new Error(`PayPal capture failed: ${res.status} ${JSON.stringify(data)}`);
    const getRes = await fetch(`${tenant.paypalApi}/v2/checkout/orders/${paypalOrderId}`, {
      headers: { "Authorization": `Bearer ${token}` }
    });
    if (!getRes.ok) throw new Error(`PayPal order fetch failed: ${getRes.status}`);
    return getRes.json();
  }
  return data;
}

// Extract the sole capture from a reschedule delta-charge order (one
// purchase unit, not the RENT/DEP split of a normal booking).
function extractSingleCapture(orderData) {
  const pu = orderData?.purchase_units?.[0];
  const cap = pu?.payments?.captures?.[0];
  if (!cap) return null;
  const brk = cap.seller_receivable_breakdown || {};
  return {
    captureId: cap.id,
    gross: Number(brk.gross_amount?.value ?? cap.amount?.value ?? 0),
    fee: Number(brk.paypal_fee?.value ?? 0),
    net: Number(brk.net_amount?.value ?? cap.amount?.value ?? 0),
    payerEmail: orderData?.payer?.email_address || "",
    payerId: orderData?.payer?.payer_id || ""
  };
}

// Normalize a PayPal order-with-captures into per-unit capture info
function extractPayPalCaptures(orderData, bookingId) {
  const out = { payerEmail: orderData?.payer?.email_address || "", payerId: orderData?.payer?.payer_id || "" };
  for (const pu of orderData?.purchase_units || []) {
    const unit = (pu.reference_id || "").endsWith("-DEP") ? "DEP" : "RENT";
    const cap = pu.payments?.captures?.[0];
    if (!cap) continue;
    const brk = cap.seller_receivable_breakdown || {};
    out[unit] = {
      captureId: cap.id,
      status: cap.status,
      gross: Number(brk.gross_amount?.value ?? cap.amount?.value ?? 0),
      fee: Number(brk.paypal_fee?.value ?? 0),
      net: Number(brk.net_amount?.value ?? cap.amount?.value ?? 0)
    };
  }
  return out;
}

// Verify a PayPal webhook signature. Requires tenant.paypalWebhookId
// (Accounts."PayPal Webhook ID"). Returns true/false.
async function verifyPayPalWebhook(tenant, env, request, rawBody) {
  if (!tenant.paypalWebhookId) return false;
  const token = await getAccessToken(tenant, env);
  const h = request.headers;
  const res = await fetch(`${tenant.paypalApi}/v1/notifications/verify-webhook-signature`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({
      auth_algo: h.get("paypal-auth-algo"),
      cert_url: h.get("paypal-cert-url"),
      transmission_id: h.get("paypal-transmission-id"),
      transmission_sig: h.get("paypal-transmission-sig"),
      transmission_time: h.get("paypal-transmission-time"),
      webhook_id: tenant.paypalWebhookId,
      webhook_event: JSON.parse(rawBody)
    })
  });
  if (!res.ok) return false;
  return (await res.json()).verification_status === "SUCCESS";
}

// ---------------------------------------------------------------- Stripe ----

async function fetchStripeSession(tenant, env, sessionId) {
  const secret = resolveSecret(tenant, env, "stripeSecretName", "stripeSecret");
  const res = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${sessionId}?expand[]=payment_intent.latest_charge.balance_transaction`,
    { headers: { "Authorization": `Bearer ${secret}` } }
  );
  if (!res.ok) throw new Error(`Stripe session fetch failed: ${res.status} ${await res.text()}`);
  return res.json();
}

function extractStripeCapture(session, snapshot) {
  const pi = session.payment_intent;
  const charge = pi?.latest_charge;
  const bt = charge?.balance_transaction;
  const gross = (session.amount_total ?? 0) / 100;
  const fee = bt ? (bt.fee ?? 0) / 100 : 0;
  const net = bt ? (bt.net ?? 0) / 100 : round2(gross - fee);
  const depositTotal = snapshot.securityDeposit.total;
  const rentGross = round2(gross - depositTotal);
  // Stripe is one charge: allocate the fee proportionally between units for ledger clarity
  const depFee = gross > 0 ? round2(fee * (depositTotal / gross)) : 0;
  const rentFee = round2(fee - depFee);
  const out = {
    payerEmail: session.customer_details?.email || "",
    payerId: session.customer || "",
    RENT: { captureId: charge?.id || pi?.id || session.id, status: "COMPLETED", gross: rentGross, fee: rentFee, net: round2(rentGross - rentFee) }
  };
  if (depositTotal > 0) {
    out.DEP = { captureId: charge?.id || pi?.id || session.id, status: "COMPLETED", gross: depositTotal, fee: depFee, net: round2(depositTotal - depFee) };
  }
  return out;
}

// Stripe webhook HMAC verification (Stripe-Signature: t=...,v1=...)
async function verifyStripeWebhook(tenant, env, request, rawBody) {
  const whSecret = resolveSecret(tenant, env, "stripeWebhookSecretName", "stripeWebhookSecret");
  if (!whSecret) return false;
  const sigHeader = request.headers.get("stripe-signature") || "";
  const parts = Object.fromEntries(sigHeader.split(",").map(p => p.split("=")));
  if (!parts.t || !parts.v1) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(whSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${parts.t}.${rawBody}`));
  const expected = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
  return expected === parts.v1;
}

// ------------------------------------------------------------- Settlement ----

// Idempotent settlement: updates snapshot, writes the D1 + GHL ledger, notifies GHL.
async function settle(env, tenant, snapshot, captures, { notify = true } = {}) {
  if (snapshot.settled) return { alreadySettled: true };

  const now = new Date().toISOString();
  const rent = captures.RENT;
  const dep = captures.DEP || null;
  const totalPaid = round2((rent?.gross || 0) + (dep?.gross || 0));

  // ---- snapshot ----
  snapshot.settled = true;
  snapshot.settledAt = now;
  snapshot.captures = captures;
  snapshot.securityDeposit.status = dep ? "held" : snapshot.securityDeposit.status;
  snapshot.securityDeposit.paypalCaptureId = dep?.captureId || null;
  await env.BOOKINGS.put(snapshot.bookingId, JSON.stringify(snapshot));

  // ---- Ledger (D1 + GHL, non-blocking) ----
  // writeLedgerEntries materializes the same split rows into D1 (the durable
  // ledger) and into the tenant's own GHL account (custom_objects.payments,
  // linked to custom_objects.transactions) -- the latter is what feeds the
  // admin dashboard's Owner Statement, since the dashboard already reads GHL
  // objects and already has the Property/OTA/Guest associations in place.
  // Either half failing must never roll back or fail a completed settlement.
  let ledgerOk = true;
  let ghlOk = true;
  try {
    const ledger = await writeLedgerEntries(env, tenant, snapshot, captures);
    if (!ledger.d1.ok) {
      console.error(`D1 ledger write failed for ${snapshot.bookingId}: ${ledger.d1.reason} ${ledger.d1.error || ""}`);
      ledgerOk = false;
    }
    if (!ledger.ghl.ok) {
      console.error(`GHL ledger sync failed for ${snapshot.bookingId}: ${ledger.ghl.reason} ${ledger.ghl.error || ""}`);
      ghlOk = false;
    } else {
      snapshot.ghl = { transactionId: ledger.ghl.transactionId, paymentIds: ledger.ghl.paymentIds };
      await env.BOOKINGS.put(snapshot.bookingId, JSON.stringify(snapshot));
    }
  } catch (err) {
    console.error(`Ledger write threw for ${snapshot.bookingId}:`, err.message);
    ledgerOk = false;
    ghlOk = false;
  }

  // ---- GHL notification (fire-and-forget) ----
  // Skipped when GHL itself told us about the payment (an invoice paid in
  // GHL): the workflow that called us is already the confirmation, and
  // posting back to its own inbound-webhook trigger would run it twice.
  if (notify && tenant.ghlPaymentConfirmedUrl) {
    try {
      await fetch(tenant.ghlPaymentConfirmedUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "payment_confirmed",
          bookingId: snapshot.bookingId,
          contactId: snapshot.ghlContactId || "",
          status: "paid",
          amountPaid: totalPaid.toFixed(2),
          depositTotal: (dep?.gross || 0).toFixed(2),
          checkIn: snapshot.stay.checkIn,
          checkOut: snapshot.stay.checkOut,
          propertyName: snapshot.propertyCode || tenant.brandName
        })
      });
    } catch (err) {
      console.error(`GHL payment-confirmed notify failed for ${snapshot.bookingId}:`, err.message);
    }
  }

  return { settled: true, totalPaid, ledgerOk, ghlOk };
}

function confirmationPage(tenant, snapshot) {
  const b = tenant.brandName || "";
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pago confirmado — ${b}</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f6f7f9}
.card{background:#fff;border-radius:16px;padding:40px;max-width:420px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08)}
h1{font-size:1.4rem;margin:.5em 0}.ok{font-size:3rem}p{color:#555;line-height:1.5}</style></head>
<body><div class="card"><div class="ok">✅</div><h1>¡Pago confirmado!</h1>
<p>Gracias por tu reserva con <strong>${b}</strong>.<br>
Recibirás la confirmación con todos los detalles en breve.</p>
<p style="font-size:.85rem;color:#999">Reserva: ${snapshot.bookingId}</p></div></body></html>`;
}

// ------------------------------------------------------------------ routes ----

async function findSnapshot(env, bookingId) {
  if (!bookingId) return null;
  return env.BOOKINGS.get(bookingId, { type: "json" });
}

async function tenantFor(env, snapshot) {
  return env.TENANTS.get(snapshot.locationId, { type: "json" });
}

// ------------------------------------------------- GHL invoice paid ----
// POST /ghl-invoice-paid  <- GHL "Payment Confirmed" workflow (trigger:
// Invoice status is Paid), Custom Webhook action. Body (any of the ids):
//   { locationId, invoiceId, invoiceNumber, contactId, secret? }
//   headers X-Location-Id / X-Webhook-Secret work too, as on /booking-created.
// A booking whose invoice was enriched is paid inside GHL, so no PayPal or
// Stripe return/webhook ever reaches us. This settles it the same way:
// ledger rows (D1 + GHL Transaction/Payments), owner/manager split.
// GHL is the source of truth: the invoice is re-read and must be Paid; the
// booking is the one GHL's calendar stamped on it (sourceId). Anything else
// -- the same workflow's other trigger, a non-booking invoice -- is skipped
// with a 200 so the workflow carries on. Settling twice is a no-op.
const unresolved = v => v == null || /^\s*$|^\s*(null|undefined)\s*$|\{\{/i.test(String(v));

export async function handleGhlInvoicePaid(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Expected JSON body" }, 400); }
  const locationId = (request.headers?.get?.("X-Location-Id") || body.locationId || "").trim();
  const secret = (request.headers?.get?.("X-Webhook-Secret") || body.secret || "").trim();
  if (unresolved(locationId)) return json({ error: "locationId is required" }, 400);

  const tenant = await env.TENANTS.get(locationId, { type: "json" });
  if (!tenant) return json({ error: `Unknown locationId: ${locationId}` }, 404);
  if (tenant.webhookSecret && secret !== tenant.webhookSecret) return json({ error: "Unauthorized" }, 401);

  const invoiceId = unresolved(body.invoiceId) ? null : String(body.invoiceId).trim();
  const invoiceNumber = unresolved(body.invoiceNumber) ? null : String(body.invoiceNumber).trim();
  const contactId = unresolved(body.contactId) ? null : String(body.contactId).trim();
  if (!invoiceId && !invoiceNumber) return json({ ok: true, skipped: "no_invoice_in_request" });

  // Find the invoice. Merge tags can hand over the NUMBER instead of the id
  // (seen live on RL Santana), so an id that doesn't load is tried as a number.
  let invoice = null;
  if (invoiceId) invoice = await fetchInvoice({ tenant, env, locationId, invoiceId }).catch(() => null);
  if (!invoice && contactId) {
    const wanted = invoiceNumber || invoiceId;
    const same = n => String(n ?? "").trim() === wanted || (Number(n) && Number(n) === Number(wanted));
    const hit = (await listContactInvoices({ tenant, env, locationId, contactId })).find(i => i._id === wanted || same(i.invoiceNumber));
    if (hit) invoice = await fetchInvoice({ tenant, env, locationId, invoiceId: hit._id });
  }
  if (!invoice) return json({ error: "Invoice not found", invoiceId, invoiceNumber, contactId }, 404);

  const bookingId = bookingIdOf(invoice);
  if (!bookingId) return json({ ok: true, skipped: "not_a_booking_invoice", invoiceId: invoice._id });
  const status = normStatus(invoice.status);
  if (status !== "paid") return json({ ok: true, skipped: `invoice_${status || "unknown"}`, invoiceId: invoice._id, bookingId });

  const snapshot = await findSnapshot(env, bookingId);
  if (!snapshot) return json({ error: `No booking ${bookingId} on record for invoice ${invoice.invoiceNumber || invoice._id}` }, 404);
  if (snapshot.locationId !== locationId) return json({ error: "Invoice and booking belong to different accounts" }, 409);
  if (snapshot.settled) return json({ ok: true, alreadySettled: true, bookingId });

  const paid = Number(invoice.amountPaid ?? invoice.total ?? 0);
  const depositHeld = Number(snapshot.securityDeposit?.total || 0);
  // No captureId: the money sits with GHL's processor, not a PayPal/Stripe
  // capture of ours, so cancellation refunds for it stay manual (in GHL).
  // gatewayTransactionId ties our Revenue rows to GHL's native payment.
  const gatewayTransactionId = await findInvoiceTransactionId({ tenant, env, locationId, invoiceId: invoice._id }).catch(() => null);
  const common = { source: "ghl_invoice", invoiceId: invoice._id, invoiceNumber: invoice.invoiceNumber || null, gatewayTransactionId, paidAt: invoice.lastPaidAt || invoice.updatedAt || null };
  const captures = {
    RENT: { ...common, gross: round2(paid - depositHeld) },
    ...(depositHeld > 0 ? { DEP: { ...common, gross: depositHeld } } : {})
  };
  const result = await settle(env, tenant, snapshot, captures, { notify: false });
  return json({ ok: true, bookingId, invoiceId: invoice._id, amountPaid: round2(paid), ...result });
}

export async function handlePayPalReturn(request, env) {
  const url = new URL(request.url);
  const bookingId = url.searchParams.get("bookingId");
  const snapshot = await findSnapshot(env, bookingId);
  if (!snapshot) return html("<h1>Reserva no encontrada</h1>", 404);
  const tenant = await tenantFor(env, snapshot);
  if (!tenant) return html("<h1>Configuración no encontrada</h1>", 500);

  // Reschedule delta-charge orders settle differently (single capture,
  // updates the PARENT order, no RENT/DEP split).
  if (snapshot.type === "reschedule_adjustment") {
    if (!snapshot.settled) {
      const orderData = await capturePayPalOrder(tenant, env, snapshot.paypal.orderId);
      const cap = extractSingleCapture(orderData);
      if (!cap) return html("<h1>El pago no pudo completarse. Intenta nuevamente desde tu enlace de pago.</h1>", 402);
      await settleRescheduleAdjustment(env, tenant, snapshot, cap);
    }
    if (tenant.thankYouUrl) return Response.redirect(tenant.thankYouUrl, 302);
    return html(confirmationPage(tenant, snapshot));
  }

  if (!snapshot.settled) {
    const orderData = await capturePayPalOrder(tenant, env, snapshot.paypal.orderId);
    const captures = extractPayPalCaptures(orderData, bookingId);
    if (!captures.RENT) return html("<h1>El pago no pudo completarse. Intenta nuevamente desde tu enlace de pago.</h1>", 402);
    await settle(env, tenant, snapshot, captures);
  }
  if (tenant.thankYouUrl) return Response.redirect(tenant.thankYouUrl, 302);
  return html(confirmationPage(tenant, snapshot));
}

export async function handlePayPalWebhook(request, env) {
  const rawBody = await request.text();
  let event;
  try { event = JSON.parse(rawBody); } catch { return json({ error: "Bad JSON" }, 400); }
  if (event.event_type !== "PAYMENT.CAPTURE.COMPLETED") return json({ ignored: event.event_type });

  // Resolve booking via the capture's invoice_id / custom_id (bookingId-RENT / -DEP)
  const inv = event.resource?.invoice_id || event.resource?.custom_id || "";
  const bookingId = inv.replace(/-(RENT|DEP|ADJ)$/, "");
  const snapshot = await findSnapshot(env, bookingId);
  if (!snapshot) return json({ error: "Unknown booking" }, 404);
  const tenant = await tenantFor(env, snapshot);
  if (!tenant) return json({ error: "Unknown tenant" }, 404);

  const verified = await verifyPayPalWebhook(tenant, env, request, rawBody);
  if (!verified) return json({ error: "Signature verification failed" }, 401);

  if (snapshot.type === "reschedule_adjustment") {
    if (!snapshot.settled) {
      const orderData = await capturePayPalOrder(tenant, env, snapshot.paypal.orderId);
      const cap = extractSingleCapture(orderData);
      if (cap) await settleRescheduleAdjustment(env, tenant, snapshot, cap);
    }
    return json({ ok: true });
  }

  if (!snapshot.settled) {
    // Capture may have happened via return URL or webhook-first; fetch full order
    const orderData = await capturePayPalOrder(tenant, env, snapshot.paypal.orderId);
    const captures = extractPayPalCaptures(orderData, bookingId);
    if (captures.RENT) await settle(env, tenant, snapshot, captures);
  }
  return json({ ok: true });
}

export async function handleStripeReturn(request, env) {
  const url = new URL(request.url);
  const bookingId = url.searchParams.get("bookingId");
  const sessionId = url.searchParams.get("session_id");
  const snapshot = await findSnapshot(env, bookingId);
  if (!snapshot) return html("<h1>Reserva no encontrada</h1>", 404);
  const tenant = await tenantFor(env, snapshot);
  if (!tenant) return html("<h1>Configuración no encontrada</h1>", 500);

  if (!snapshot.settled) {
    const session = await fetchStripeSession(tenant, env, sessionId || snapshot.stripe?.sessionId);
    if (session.payment_status !== "paid")
      return html("<h1>El pago no pudo completarse. Intenta nuevamente desde tu enlace de pago.</h1>", 402);
    const captures = extractStripeCapture(session, snapshot);
    await settle(env, tenant, snapshot, captures);
  }
  if (tenant.thankYouUrl) return Response.redirect(tenant.thankYouUrl, 302);
  return html(confirmationPage(tenant, snapshot));
}

export async function handleStripeWebhook(request, env, locationIdHint) {
  const rawBody = await request.text();
  let event;
  try { event = JSON.parse(rawBody); } catch { return json({ error: "Bad JSON" }, 400); }
  if (event.type !== "checkout.session.completed") return json({ ignored: event.type });

  const session = event.data?.object || {};
  const bookingId = session.client_reference_id || session.metadata?.bookingId;
  const snapshot = await findSnapshot(env, bookingId);
  if (!snapshot) return json({ error: "Unknown booking" }, 404);
  const tenant = await tenantFor(env, snapshot);
  if (!tenant) return json({ error: "Unknown tenant" }, 404);

  const verified = await verifyStripeWebhook(tenant, env, request, rawBody);
  if (!verified) return json({ error: "Signature verification failed" }, 401);

  if (!snapshot.settled) {
    const full = await fetchStripeSession(tenant, env, session.id);
    if (full.payment_status === "paid") {
      const captures = extractStripeCapture(full, snapshot);
      await settle(env, tenant, snapshot, captures);
    }
  }
  return json({ ok: true });
}
