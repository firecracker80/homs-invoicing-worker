// paypal.js (v2) — Orders v2 integration.
// Credentials follow your Accounts-table "Secret Name" pattern:
// tenant config stores paypalSecretName (e.g. "PAYPAL_SECRET_JT1"), the actual
// secret lives in Worker secrets (wrangler secret put PAYPAL_SECRET_JT1).
// Falls back to tenant.paypalSecret in KV for pilot convenience.

function resolveSecret(tenant, env, nameKey, inlineKey) {
  if (tenant[nameKey] && env[tenant[nameKey]]) return env[tenant[nameKey]];
  return tenant[inlineKey]; // pilot fallback: secret stored inline in KV
}

async function getAccessToken(tenant, env) {
  const secret = resolveSecret(tenant, env, "paypalSecretName", "paypalSecret");
  const creds = btoa(`${tenant.paypalClientId}:${secret}`);
  const res = await fetch(`${tenant.paypalApi}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${creds}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });
  if (!res.ok) throw new Error(`PayPal auth failed: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

async function createOrder(tenant, env, bookingId, purchaseUnits, workerUrl) {
  const token = await getAccessToken(tenant, env);
  const res = await fetch(`${tenant.paypalApi}/v2/checkout/orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
      "PayPal-Request-Id": bookingId
    },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: purchaseUnits,
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: tenant.brandName,
            locale: tenant.locale || "es-ES",
            user_action: "PAY_NOW",
            shipping_preference: "NO_SHIPPING",
            return_url: `${workerUrl}/paypal/return?bookingId=${encodeURIComponent(bookingId)}`,
            cancel_url: `${workerUrl}/paypal/cancel?bookingId=${encodeURIComponent(bookingId)}`
          }
        }
      }
    })
  });
  if (!res.ok) throw new Error(`PayPal order failed: ${res.status} ${await res.text()}`);
  const order = await res.json();
  const approveUrl =
    order.links?.find(l => l.rel === "payer-action")?.href ??
    order.links?.find(l => l.rel === "approve")?.href;
  if (!approveUrl) throw new Error("PayPal order created but no approval link returned");
  return { orderId: order.id, approveUrl };
}

export { getAccessToken, createOrder };
