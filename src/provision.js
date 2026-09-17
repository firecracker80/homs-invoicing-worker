// provision.js — one-shot tenant onboarding.
//
// Today, onboarding a new client means typing the same information twice:
// once into GHL's Custom Values (when cloning the snapshot for the new
// sub-account), and again by hand into the TENANTS KV entry. This reads
// whatever's already filled in on the GHL side and builds/writes the KV
// entry from it, so the second pass collapses into one request.
//
//   GET  /admin/provision-tenant?locationId&ghlPit[&paypalSecretName]          -- dry run, never writes
//   POST /admin/provision-tenant?locationId&ghlPit[&paypalSecretName]&force    -- writes to TENANTS KV
//
// Admin-gated by the GLOBAL env.ADMIN_SECRET only (X-Admin-Secret header) --
// never tenant.adminSecret, since the tenant doesn't exist in KV yet.
//
// ghlPit is NOT read from a custom value. GHL never sees anything sitting in
// our KV (same reasoning as brandName's bug, and why the PIT itself doesn't
// belong in Custom Values at all -- see STATEMENTS.md), so there's no way to
// bootstrap the PIT from GHL's side. It has to be handed to this endpoint
// directly, once, and gets written into the resulting KV entry so the Worker
// can keep using it for its own outbound GHL calls afterward.
//
// The PayPal secret follows the same rule. wpaypal_secret_key is never copied
// out of GHL -- a plaintext credential in Custom Values is readable by every
// sub-account user and every read-scoped token. Put the secret in a Worker
// secret (wrangler secret put PAYPAL_SECRET_<X>) and pass its NAME as
// &paypalSecretName=; paypal.js already resolves tenant.paypalSecretName.
//
// fieldKey format, verified live 2026-09-11 against DEMO-HOMS and Luminara
// (all 19 values on both): GHL returns the merge-tag form,
// "{{ custom_values.wbrand_name }}", not the bare "wbrand_name". slugOf()
// extracts the slug; matching the raw string misses every value. Still run a
// GET first and check "unmappedCustomValues" before trusting a POST.

import { parseCancellationPolicy } from "./policy.js";

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { "Content-Type": "application/json" } });
}

// Constant-time: compare SHA-256 digests so length and early mismatch don't leak.
async function adminAuthorized(request, env) {
  const given = request.headers?.get?.("X-Admin-Secret") || "";
  if (!env.ADMIN_SECRET) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(env.ADMIN_SECRET))
  ]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// "{{ custom_values.wbrand_name }}" -> "wbrand_name". Bare keys pass through.
// Falls back to the display name only if fieldKey is absent.
function slugOf(cv) {
  const raw = String(cv.fieldKey || cv.name || "");
  const m = raw.match(/custom_values.([a-z0-9_]+)/i);
  return (m ? m[1] : raw).trim().toLowerCase();
}

// "85" or "85%" -> 0.85. Already-a-fraction ("0.85") passes through unchanged.
function pctToFraction(raw) {
  const n = Number(String(raw).replace("%", "").trim());
  if (!Number.isFinite(n)) return null;
  return n > 1 ? Math.round((n / 100) * 10000) / 10000 : n;
}

// GHL custom value fieldKey -> { tenantField, transform? }
const FIELD_MAP = {
  wadmin_secret: { tenantField: "adminSecret" },
  wbrand_name: { tenantField: "brandName" },
  // wcleaning_fee is no longer mapped: cleaning is a GHL-native Additional Fee.
  wcurrency: { tenantField: "currency" },
  // Rent kept on a cancellation, e.g. "24h 50%, 5d 20%, check-in 100%". Blank = full refund.
  wcancellation_policy: { tenantField: "cancellationPolicy", transform: parseCancellationPolicy },
  wghl_cancelation_url: { tenantField: "ghlCancellationUrl" },
  wghl_deposit_url: { tenantField: "ghlDepositRefundUrl" },
  wghl_payment_confirmation_url: { tenantField: "ghlPaymentConfirmedUrl" },
  wghl_reschedule_url: { tenantField: "ghlRescheduleUrl" },
  wlocale: { tenantField: "locale" },
  wmanager: { tenantField: "managerName" },
  wowner_revenue_split: { tenantField: "ownerPct", transform: pctToFraction },
  wpaypal_client_id: { tenantField: "paypalClientId" },
  // Read by payment.js to verify PayPal webhook signatures -- without it
  // every webhook fails verification.
  wpaypal_webhook: { tenantField: "paypalWebhookId" },
  // Not read by Worker code yet; mapped so they land in KV under the same
  // names Luminara's entry already uses, ready for payout automation.
  wowner_paypal_email: { tenantField: "ownerPaypalEmail" },
  wmgr_paypal_email: { tenantField: "managerPaypalEmail" },
  wproperty_owner: { tenantField: "ownerName" },
  wwebhook_secret: { tenantField: "webhookSecret" }
  // wlocation_id is the KV key itself, not a JSON field -- deliberately
  // not mapped. wpaypal_secret_key is deliberately not mapped either -- see
  // SKIPPED_SENSITIVE and the header comment.
};

// Present in GHL but never copied into KV. Reported by slug only, value
// withheld, so the response doesn't echo a credential back either.
const SKIPPED_SENSITIVE = new Set(["wpaypal_secret_key"]);

// Still present in older client accounts, no longer read by the Worker.
const RETIRED = new Set(["wcleaning_fee"]);

async function fetchCustomValues(locationId, ghlPit) {
  const res = await fetch(`${GHL_BASE}/locations/${locationId}/customValues`, {
    headers: { Authorization: `Bearer ${ghlPit}`, Version: GHL_VERSION, Accept: "application/json" }
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`GHL GET /locations/${locationId}/customValues -> ${res.status} ${JSON.stringify(data).slice(0, 500)}`);
    err.status = res.status;
    throw err;
  }
  return data.customValues || [];
}

function buildTenantFromCustomValues(customValues, ghlPit, paypalSecretName) {
  const tenant = { ghlPit, bookingWorkerEnabled: true };
  if (paypalSecretName) tenant.paypalSecretName = paypalSecretName;
  const mapped = [];
  const unmapped = [];
  const skippedSensitive = [];
  const policyProblems = [];

  for (const cv of customValues) {
    const key = slugOf(cv);
    if (key === "wlocation_id" || RETIRED.has(key)) continue;
    if (SKIPPED_SENSITIVE.has(key)) { skippedSensitive.push(key); continue; }
    const rule = FIELD_MAP[key];
    if (!rule) { unmapped.push({ fieldKey: cv.fieldKey, name: cv.name, value: cv.value }); continue; }
    const value = rule.transform ? rule.transform(cv.value) : cv.value;
    if (value?.unparsed) {
      for (const part of value.unparsed) policyProblems.push(`${cv.name || key}: could not read "${part}"`);
      delete value.unparsed;
    }
    tenant[rule.tenantField] = value;
    mapped.push({ fieldKey: cv.fieldKey, tenantField: rule.tenantField, value });
  }

  // gateway isn't itself a custom value -- infer it from what got mapped,
  // since guessing a payment processor wrong would misroute live payments.
  if (tenant.paypalClientId && tenant.paypalSecretName) tenant.gateway = "paypal";

  return { tenant, mapped, unmapped, skippedSensitive, policyProblems };
}

export async function handleProvisionTenant(request, env) {
  if (!(await adminAuthorized(request, env))) return json({ error: "Unauthorized" }, 401);

  const url = new URL(request.url);
  const locationId = url.searchParams.get("locationId");
  const ghlPit = url.searchParams.get("ghlPit");
  const force = url.searchParams.get("force") === "true";
  const paypalSecretName = url.searchParams.get("paypalSecretName") || null;
  if (!locationId) return json({ error: "locationId is required" }, 400);
  if (!ghlPit) return json({ error: "ghlPit is required -- can't fetch GHL's custom values without it, and it can't come from a custom value itself (see provision.js's header comment)" }, 400);
  if (!env.TENANTS) return json({ error: "TENANTS KV binding missing" }, 500);

  let customValues;
  try {
    customValues = await fetchCustomValues(locationId, ghlPit);
  } catch (err) {
    return json({ error: err.message }, err.status || 502);
  }

  const { tenant: provisioned, mapped, unmapped, skippedSensitive, policyProblems } = buildTenantFromCustomValues(customValues, ghlPit, paypalSecretName);

  // Names a secret that isn't set on this Worker -> payments would fail at
  // auth time. Surface it now rather than at the first guest checkout.
  const warnings = [...policyProblems];
  if (paypalSecretName && !env[paypalSecretName]) {
    warnings.push(`paypalSecretName "${paypalSecretName}" is not set as a Worker secret on this environment -- run: wrangler secret put ${paypalSecretName}`);
  }
  if (provisioned.paypalClientId && !paypalSecretName) {
    warnings.push("PayPal client ID found but no &paypalSecretName= given -- gateway not inferred. The PayPal secret is never read from GHL custom values.");
  }
  const existing = await env.TENANTS.get(locationId, { type: "json" });
  const isWrite = request.method === "POST";

  if (isWrite && existing && !force) {
    return json({
      error: `A tenant already exists at locationId ${locationId}. Pass &force=true to merge the provisioned fields into it (provisioned values overwrite matching existing fields; anything only in the existing entry is kept).`,
      existingKeys: Object.keys(existing)
    }, 409);
  }

  const finalTenant = existing ? { ...existing, ...provisioned } : provisioned;

  if (!isWrite) {
    return json({ dryRun: true, locationId, wouldWrite: finalTenant, mappedFromCustomValues: mapped, unmappedCustomValues: unmapped, skippedSensitive, warnings, tenantAlreadyExists: Boolean(existing) });
  }

  await env.TENANTS.put(locationId, JSON.stringify(finalTenant));
  return json({ dryRun: false, locationId, written: finalTenant, mappedFromCustomValues: mapped, unmappedCustomValues: unmapped, skippedSensitive, warnings, mergedWithExisting: Boolean(existing) });
}
