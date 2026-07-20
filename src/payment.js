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
import { atUpdate, atFind, atCreate } from "./airtable.js";

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

// Idempotent settlement: updates snapshot, Airtable, ledgers, notifies GHL.
async function settle(env, tenant, snapshot, captures) {
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

  // ---- Airtable ----
  const at = snapshot.airtable || {};
  let airtableOk = true;
  try {
    // Orders: resolve record id (stored, else search by GHL Booking ID)
    let orderId = at.orderRecordId;
    if (!orderId) {
      const found = await atFind(tenant, "Orders", `{GHL Booking ID}="${snapshot.bookingId}"`);
      orderId = found?.[0]?.id;
    }
    if (!orderId) throw new Error("Order record not found");

    await atUpdate(tenant, "Orders", orderId, {
      "Total Paid": totalPaid,
      "Deposit Paid": dep?.gross || 0,
      "Remaining Balance": 0,
      "Balance Due": 0,
      "Order Status": "Paid",
      "Deposit Status": dep ? "Held" : "Pending Payment"
    });

    // Payments rows
    for (const unit of ["RENT", "DEP"]) {
      const cap = captures[unit];
      if (!cap) continue;
      let payId = at.paymentIds?.[unit];
      if (!payId) {
        const found = await atFind(tenant, "Payments", `{Notes}="${snapshot.bookingId}-${unit}"`);
        payId = found?.[0]?.id;
      }
      if (!payId) continue;
      await atUpdate(tenant, "Payments", payId, {
        "Payment Status": "Completed",
        "Gateway Transaction ID": cap.captureId,
        "Gateway Fee": cap.fee,
        "Net Received": cap.net,
        "Received Date": now,
        "PayPal Payer ID": captures.payerId || "",
        "PayPal Email": captures.payerEmail || "",
        "Cleared for Payout": unit === "RENT" // deposits never clear for payout
      });
    }

    // Transaction Ledger: one row per capture
    const ledgerRows = [];
    if (rent) ledgerRows.push({
      "Entry Date": now, "Related Order": [orderId],
      "Transaction Type": "rent_capture", "Direction": "In",
      "Gateway": snapshot.gateway === "stripe" ? "Stripe" : "PayPal",
      "Reference Number": rent.captureId, "Amount": rent.gross,
      "Currency": tenant.currency || "USD", "Reconciled": false,
      "Notes": `${snapshot.bookingId} rent+cleaning+fee | fee ${rent.fee} | net ${rent.net}`
    });
    if (dep) ledgerRows.push({
      "Entry Date": now, "Related Order": [orderId],
      "Transaction Type": "deposit_capture", "Direction": "In",
      "Gateway": snapshot.gateway === "stripe" ? "Stripe" : "PayPal",
      "Reference Number": dep.captureId, "Amount": dep.gross,
      "Currency": tenant.currency || "USD", "Reconciled": false,
      "Notes": `${snapshot.bookingId} security deposit (held) | fee ${dep.fee} | net ${dep.net}`
    });
    if (ledgerRows.length) await atCreate(tenant, "Transaction Ledger", ledgerRows);

    // Payout Ledger: owner split, manager split, cleaning fee — rent-only basis,
    // scheduled per "After Check-in" policy.
    const p = snapshot.payout;
    const sched = snapshot.stay.checkIn;
    const cur = tenant.currency || "USD";
    // "Recipient" is a single-select ("Owner" / "Manager") — plain string.
    // "Recipient Name" / "Recipient PayPal" are computed Lookups off the
    // Order link — never write them; Airtable derives them.
    const payoutRows = [
      {
        "Recipient": "Owner",
        "Payout Method": "Manual Transfer",
        "Reason": `Rent split ${Math.round(p.ownerPct * 100)}% — ${snapshot.bookingId}`,
        "Payout Amount": p.owner, "Currency": cur,
        "Scheduled Date": sched, "Payout Status": "Pending",
        "Order": [orderId]
      },
      {
        "Recipient": "Manager",
        "Payout Method": "Manual Transfer",
        "Reason": `Rent split ${Math.round((1 - p.ownerPct) * 100)}% — ${snapshot.bookingId}`,
        "Payout Amount": p.manager, "Currency": cur,
        "Scheduled Date": sched, "Payout Status": "Pending",
        "Order": [orderId]
      }
    ];
    if (snapshot.charges.cleaningFee > 0) payoutRows.push({
      "Recipient": p.cleaningFeeTo === "owner" ? "Owner" : "Manager",
      "Payout Method": "Manual Transfer",
      "Reason": `Cleaning fee — ${snapshot.bookingId}`,
      "Payout Amount": snapshot.charges.cleaningFee, "Currency": cur,
      "Scheduled Date": sched, "Payout Status": "Pending",
      "Order": [orderId]
    });
    const createdPayouts = await atCreate(tenant, "Payout Ledger", payoutRows);
    // Store payout row IDs so cancellations can void them directly
    snapshot.airtable = snapshot.airtable || {};
    snapshot.airtable.payoutLedgerIds = createdPayouts.map(r => r.id);
    await env.BOOKINGS.put(snapshot.bookingId, JSON.stringify(snapshot));
  } catch (err) {
    console.error(`Settlement Airtable sync failed for ${snapshot.bookingId}:`, err.message);
    airtableOk = false;
    snapshot.settlementSyncFailed = true;
    await env.BOOKINGS.put(snapshot.bookingId, JSON.stringify(snapshot));
  }

  // ---- GHL notification (fire-and-forget) ----
  if (tenant.ghlPaymentConfirmedUrl) {
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

  return { settled: true, totalPaid, airtableOk };
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

export async function handlePayPalReturn(request, env) {
  const url = new URL(request.url);
  const bookingId = url.searchParams.get("bookingId");
  const snapshot = await findSnapshot(env, bookingId);
  if (!snapshot) return html("<h1>Reserva no encontrada</h1>", 404);
  const tenant = await tenantFor(env, snapshot);
  if (!tenant) return html("<h1>Configuración no encontrada</h1>", 500);

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
  const bookingId = inv.replace(/-(RENT|DEP)$/, "");
  const snapshot = await findSnapshot(env, bookingId);
  if (!snapshot) return json({ error: "Unknown booking" }, 404);
  const tenant = await tenantFor(env, snapshot);
  if (!tenant) return json({ error: "Unknown tenant" }, 404);

  const verified = await verifyPayPalWebhook(tenant, env, request, rawBody);
  if (!verified) return json({ error: "Signature verification failed" }, 401);

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
