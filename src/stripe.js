// stripe.js — Stripe Checkout Session integration.
// Used when tenant.gateway === "stripe" (client has a Stripe account — US entity required).
// One session covers everything (Stripe has no purchase-unit split like PayPal);
// the deposit lives as a line item and refunds later as a PARTIAL refund of the
// PaymentIntent for the deposit amount. Ledger tracks the logical split.
// Amounts in CENTS (integers) — Stripe requirement.

function resolveSecret(tenant, env, nameKey, inlineKey) {
  if (tenant[nameKey] && env[tenant[nameKey]]) return env[tenant[nameKey]];
  return tenant[inlineKey];
}

// Flatten nested objects/arrays to Stripe's bracket form encoding:
// { line_items: [{ price_data: { currency: "usd" } }] }
//   → line_items[0][price_data][currency]=usd
function formEncode(obj, prefix = "", out = []) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === null || v === undefined) continue;
    if (typeof v === "object") formEncode(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out.join("&");
}

const toCents = n => Math.round(n * 100);

// Build Stripe line items from the booking snapshot
function buildStripeLineItems(s, currency = "usd") {
  const cur = currency.toLowerCase();
  const items = [
    {
      quantity: s.stay.nights,
      price_data: {
        currency: cur,
        unit_amount: toCents(s.stay.nightlyRate),
        product_data: { name: `Estadía — ${s.stay.nights} noche${s.stay.nights === 1 ? "" : "s"}` }
      }
    }
  ];
  if (s.charges.cleaningFee > 0) items.push({
    quantity: 1,
    price_data: { currency: cur, unit_amount: toCents(s.charges.cleaningFee),
      product_data: { name: "Tarifa de limpieza" } }
  });
  if (s.charges.processingFee > 0) items.push({
    quantity: 1,
    price_data: { currency: cur, unit_amount: toCents(s.charges.processingFee),
      product_data: { name: "Tarifa de procesamiento de pago" } }
  });
  const multiBlock = s.securityDeposit.blocks.length > 1;
  for (const b of s.securityDeposit.blocks) items.push({
    quantity: 1,
    price_data: { currency: cur, unit_amount: toCents(b.amount),
      product_data: { name: multiBlock
        ? `Depósito de seguridad (reembolsable) — bloque ${b.block}`
        : "Depósito de seguridad (reembolsable)" } }
  });
  return items;
}

async function createCheckoutSession(tenant, env, snapshot, workerUrl) {
  const secret = resolveSecret(tenant, env, "stripeSecretName", "stripeSecret");
  const bookingId = snapshot.bookingId;

  const params = {
    mode: "payment",
    client_reference_id: bookingId,
    success_url: `${workerUrl}/stripe/return?bookingId=${encodeURIComponent(bookingId)}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${workerUrl}/stripe/cancel?bookingId=${encodeURIComponent(bookingId)}`,
    line_items: buildStripeLineItems(snapshot, tenant.currency || "USD"),
    payment_intent_data: {
      metadata: {
        bookingId,
        locationId: snapshot.locationId,
        depositAmount: snapshot.securityDeposit.total.toFixed(2) // payment worker reads this for refund math
      }
    },
    metadata: { bookingId, locationId: snapshot.locationId }
  };

  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${secret}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": `booking-${bookingId}` // Stripe-native idempotency
    },
    body: formEncode(params)
  });
  if (!res.ok) throw new Error(`Stripe session failed: ${res.status} ${await res.text()}`);
  const session = await res.json();
  return { sessionId: session.id, checkoutUrl: session.url };
}

export { createCheckoutSession, buildStripeLineItems, formEncode };
