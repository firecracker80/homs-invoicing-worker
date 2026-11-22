// Multi-tenant lookup, mirroring homs-invoicing-worker's TENANTS KV convention
// (keyed by GHL locationId), but in a separate DASHBOARD_TENANTS namespace so
// this Worker never reads or writes the production invoicing worker's KV.
//
// DASHBOARD_TENANTS entry shape (per locationId key):
//   { "label": "DEMO-HOMS", "ghlPitSecretName": "GHL_PIT_DEMO_HOMS" }
//
// The PIT itself is never stored in KV -- only the name of the Worker secret
// that holds it, resolved dynamically via env[tenant.ghlPitSecretName].
//
// Note there is deliberately NO `plan` field here. See the plan gate below.

import { fetchLocation } from "./ghl.js";

export async function getTenant(env, locationId) {
  if (!locationId) return null;
  return env.DASHBOARD_TENANTS.get(locationId, { type: "json" });
}

export function resolvePit(env, tenant) {
  if (!tenant?.ghlPitSecretName) return null;
  return env[tenant.ghlPitSecretName] || null;
}

// --- Plan gating -------------------------------------------------------------
//
// Yari, 2026-11-21: "I don't want drift. It needs to keep in check when a plan
// is up/downgraded."
//
// So the client's SUBSCRIPTION is the source of truth and it is read LIVE from
// GHL on demand. Nothing about the plan is stored here, which means there is
// no second copy that can fall out of step -- an upgrade or a downgrade is in
// effect on the next page load, with no webhook to fire and no sync to miss.
//
// This replaces an earlier design that stored `plan` on the tenant record and
// kept it fresh via a webhook. That was built on my own wrong claim that GHL
// did not expose a sub-account's plan anywhere. It does:
// settings.saasSettings.planDetails, on the sub-account record.
//
// It also buys something the stored field could not do at all: the subscription
// STATUS comes with it, so a cancelled or past-due client loses the paid tier
// automatically rather than keeping it until somebody notices.

export const PLANS = ["operate", "report", "control"];

// Keyed on the STRIPE PRODUCT id, and that choice matters (Yari, 2026-11-21).
// The monthly and annual prices of one plan are two different price ids, and a
// price id changes whenever the price is edited. GHL's own saasPlanId is not
// stable either -- it can be regenerated. The Stripe product survives all of
// that, so it is the only durable key.
export const PLAN_BY_STRIPE_PRODUCT = {
  prod_Vex1k1bjvv40dI: "operate",
  prod_VexLcVjcq98VFz: "report",
  prod_VexU1CINuAU0tr: "control",
};

// Anything else -- canceled, past_due, unpaid, incomplete, paused -- is not a
// paying subscription, whatever it once was.
const ENTITLED_STATUSES = new Set(["active", "trialing"]);

// Where a lapsed or unrecognised subscription lands. Not "no access": they are
// still a client with data, and cutting a past_due account off from its own
// bookings mid-dunning helps nobody. They lose the paid tier, not the product.
const PLAN_FLOOR = PLANS[0];

// What an account that is NOT a SaaS customer gets. That is the agency's own
// accounts -- HOMS, DEMO-HOMS -- and any client provisioned by hand. They are
// not subscribers and never will be, so gating them would take statements away
// from the people who built them.
//
// This is also the fail-open value, used when the lookup itself fails. A GHL
// outage must not read as "your statements are gone" to a paying client; the
// cost of the opposite error is a brief over-grant during an outage, which is
// the cheaper mistake by a wide margin.
const PLAN_WHEN_NOT_SAAS = "control";

const CACHE_TTL_MS = 60_000;
const planCache = new Map();

/**
 * Resolve a sub-account's plan from its live subscription.
 *
 * Returns { plan, source, status?, productId? }. `source` is always specific
 * enough to explain a denial without reading the code:
 *   "subscription"              - read from an active/trialing subscription
 *   "no-tenant-record"          - locationId is not in DASHBOARD_TENANTS
 *   "no-pit"                    - tenant record names a secret that is not set
 *   "saas:<mode>"               - not a SaaS customer (e.g. "not_activated")
 *   "status:<status>"           - subscription exists but is not paying
 *   "unmapped-product:<id>"     - a plan nobody has added to the map
 *   "lookup-failed:<status>"    - GHL could not be reached; failed open
 */
export async function resolvePlan(env, locationId, deps = {}) {
  const now = deps.now ?? Date.now();
  const load = deps.fetchLocation ?? fetchLocation;
  const cache = deps.cache ?? planCache;

  if (!deps.noCache) {
    const hit = cache.get(locationId);
    if (hit && hit.expires > now) return hit.value;
  }

  const value = await computePlan(env, locationId, load, deps);
  if (!deps.noCache) cache.set(locationId, { value, expires: now + CACHE_TTL_MS });
  return value;
}

async function computePlan(env, locationId, load, deps) {
  const tenant = deps.tenant ?? (await getTenant(env, locationId));
  if (!tenant) return { plan: PLAN_WHEN_NOT_SAAS, source: "no-tenant-record" };

  const pit = resolvePit(env, tenant);
  if (!pit) return { plan: PLAN_WHEN_NOT_SAAS, source: "no-pit" };

  let location;
  try {
    location = await load(pit, locationId);
  } catch (err) {
    // Fail OPEN. See PLAN_WHEN_NOT_SAAS.
    return { plan: PLAN_WHEN_NOT_SAAS, source: `lookup-failed:${err?.status ?? "error"}` };
  }

  const saas = location?.settings?.saasSettings;
  if (!saas || saas.saasMode !== "activated") {
    return { plan: PLAN_WHEN_NOT_SAAS, source: `saas:${saas?.saasMode ?? "none"}` };
  }

  const status = saas.planDetails?.subscriptionStatus ?? null;
  if (!ENTITLED_STATUSES.has(status)) {
    return { plan: PLAN_FLOOR, source: `status:${status ?? "none"}`, status };
  }

  const productId = saas.planDetails?.productId ?? null;
  const plan = PLAN_BY_STRIPE_PRODUCT[productId];
  if (!plan) {
    // A real subscription on a plan nobody mapped. Falling to the floor denies
    // a paying client, which they will report within the day. Falling to the
    // ceiling grants a tier nobody paid for, which is silent and permanent.
    return { plan: PLAN_FLOOR, source: `unmapped-product:${productId ?? "none"}`, status, productId };
  }

  return { plan, source: "subscription", status, productId };
}

/**
 * Does this sub-account hold at least `required`?
 * Returns { ok, plan, source, required, ... } -- never a bare boolean, because
 * a caller that denies needs the plan and the source to say anything useful.
 */
export async function planAtLeast(env, locationId, required, deps = {}) {
  const resolved = await resolvePlan(env, locationId, deps);
  const have = PLANS.indexOf(resolved.plan);
  const need = PLANS.indexOf(required);
  if (need === -1) {
    // A typo in OUR OWN call site. Deny loudly rather than quietly allowing
    // everything, which is what a bare `have >= need` does when need is -1.
    return { ...resolved, ok: false, required: `invalid:${required}` };
  }
  return { ...resolved, ok: have >= need, required };
}

/** Clear the plan cache. Tests, and anything that changes a plan deliberately. */
export function clearPlanCache() {
  planCache.clear();
}

/**
 * The 403 body for a feature the sub-account's plan does not include.
 *
 * Deliberately NOT 401: apiFetch() in the page treats any 401 as an expired
 * session and opens the admin key prompt, so a plan denial would ask the reader
 * to re-enter a key that cannot help. Not 402 either -- "payment required"
 * reads as "this account is unpaid", which is wrong for an Operate client who
 * is paid up and simply on a smaller plan.
 */
export function planDenied({ feature, plan, source, required, status }) {
  return Response.json(
    {
      error: `${feature} is not included in this account's plan`,
      plan,
      required,
      planSource: source,
      subscriptionStatus: status ?? null,
      detail: `This account is on "${plan}". ${feature} is part of "${required}".`,
    },
    { status: 403 }
  );
}
