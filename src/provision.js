// provision.js — one-shot tenant onboarding.
//
// Today, onboarding a new client means typing the same information twice:
// once into GHL's Custom Values (when cloning the snapshot for the new
// sub-account), and again by hand into the TENANTS KV entry. This reads
// whatever's already filled in on the GHL side and builds/writes the KV
// entry from it, so the second pass collapses into one request.
//
//   GET  /admin/provision-tenant?locationId&ghlPit          -- dry run, never writes
//   POST /admin/provision-tenant?locationId&ghlPit&force    -- writes to TENANTS KV
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
// FIELD_MAP assumes GHL's customValues API returns each entry's fieldKey as
// the bare key (e.g. "wowner_revenue_split", no "custom_values." prefix) --
// GHL's documented behavior, but not yet verified against a live account
// from this codebase (no GHL MCP connection here has access to check).
// Always run a GET (dry run) first and check "unmappedCustomValues" in the
// response before trusting a POST -- if the real fieldKey format differs,
// every custom value will show up there instead of silently vanishing.

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { "Content-Type": "application/json" } });
}

function adminAuthorized(request, env) {
  const given = request.headers?.get?.("X-Admin-Secret") || "";
  return Boolean(env.ADMIN_SECRET) && given === env.ADMIN_SECRET;
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
  wcleaning_fee: { tenantField: "defaultCleaningFee", transform: Number },
  wcurrency: { tenantField: "currency" },
  wghl_cancelation_url: { tenantField: "ghlCancellationUrl" },
  wghl_deposit_url: { tenantField: "ghlDepositRefundUrl" },
  wghl_payment_confirmation_url: { tenantField: "ghlPaymentConfirmedUrl" },
  wghl_reschedule_url: { tenantField: "ghlRescheduleUrl" },
  wlocale: { tenantField: "locale" },
  wmanager: { tenantField: "managerName" },
  wowner_revenue_split: { tenantField: "ownerPct", transform: pctToFraction },
  wpaypal_client_id: { tenantField: "paypalClientId" },
  wpaypal_secret_key: { tenantField: "paypalSecret" },
  wproperty_owner: { tenantField: "ownerName" },
  wwebhook_secret: { tenantField: "webhookSecret" }
  // wlocation_id is the KV key itself, not a JSON field -- deliberately
  // not mapped. wmgr_paypal_email / wowner_paypal_email / wpaypal_webhook_id
  // exist in Luminara's custom values but no Worker code currently reads a
  // matching field -- they'll show up in "unmappedCustomValues" rather than
  // being silently dropped, in case that's a real gap and not dead config.
};

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

function buildTenantFromCustomValues(customValues, ghlPit) {
  const tenant = { ghlPit, bookingWorkerEnabled: true };
  const mapped = [];
  const unmapped = [];

  for (const cv of customValues) {
    const key = (cv.fieldKey || cv.name || "").toLowerCase();
    if (key === "wlocation_id") continue;
    const rule = FIELD_MAP[key];
    if (!rule) { unmapped.push({ fieldKey: cv.fieldKey, name: cv.name, value: cv.value }); continue; }
    const value = rule.transform ? rule.transform(cv.value) : cv.value;
    tenant[rule.tenantField] = value;
    mapped.push({ fieldKey: cv.fieldKey, tenantField: rule.tenantField, value });
  }

  // gateway isn't itself a custom value -- infer it from what got mapped,
  // since guessing a payment processor wrong would misroute live payments.
  if (tenant.paypalClientId && tenant.paypalSecret) tenant.gateway = "paypal";

  return { tenant, mapped, unmapped };
}

export async function handleProvisionTenant(request, env) {
  if (!adminAuthorized(request, env)) return json({ error: "Unauthorized" }, 401);

  const url = new URL(request.url);
  const locationId = url.searchParams.get("locationId");
  const ghlPit = url.searchParams.get("ghlPit");
  const force = url.searchParams.get("force") === "true";
  if (!locationId) return json({ error: "locationId is required" }, 400);
  if (!ghlPit) return json({ error: "ghlPit is required -- can't fetch GHL's custom values without it, and it can't come from a custom value itself (see provision.js's header comment)" }, 400);
  if (!env.TENANTS) return json({ error: "TENANTS KV binding missing" }, 500);

  let customValues;
  try {
    customValues = await fetchCustomValues(locationId, ghlPit);
  } catch (err) {
    return json({ error: err.message }, err.status || 502);
  }

  const { tenant: provisioned, mapped, unmapped } = buildTenantFromCustomValues(customValues, ghlPit);
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
    return json({ dryRun: true, locationId, wouldWrite: finalTenant, mappedFromCustomValues: mapped, unmappedCustomValues: unmapped, tenantAlreadyExists: Boolean(existing) });
  }

  await env.TENANTS.put(locationId, JSON.stringify(finalTenant));
  return json({ dryRun: false, locationId, written: finalTenant, mappedFromCustomValues: mapped, unmappedCustomValues: unmapped, mergedWithExisting: Boolean(existing) });
}
