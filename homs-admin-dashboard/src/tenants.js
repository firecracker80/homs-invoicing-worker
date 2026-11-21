// Multi-tenant lookup, mirroring homs-invoicing-worker's TENANTS KV convention
// (keyed by GHL locationId), but in a separate DASHBOARD_TENANTS namespace so
// this Worker never reads or writes the production invoicing worker's KV.
//
// DASHBOARD_TENANTS entry shape (per locationId key):
//   { "label": "DEMO-HOMS", "ghlPitSecretName": "GHL_PIT_DEMO_HOMS",
//     "plan": "operate" | "report" | "control" }
//
// The PIT itself is never stored in KV -- only the name of the Worker secret
// that holds it, resolved dynamically via env[tenant.ghlPitSecretName].

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
// This record is the ONLY source of truth for which plan a sub-account is on.
// The SaaS Configurator gates GHL-native features (Conversation AI, premium
// workflow actions) and does that well -- but it cannot reach a Worker running
// on Cloudflare, so everything HOMS built is gated here or nowhere.
//
// Decided 2026-11-21 (Yari): the dashboard record is source of truth, and the
// invoicing Worker reads it from here over the service binding rather than
// keeping a second copy. One place to change a plan.

// Ordered weakest to strongest. Index position IS the comparison.
export const PLANS = ["operate", "report", "control"];

// What a tenant with NO `plan` field gets.
//
// Every existing record predates this field, so denying by default would strip
// owner and manager statements from the accounts that have them today --
// including DEMO-HOMS, which the conference demo runs on. Allowing preserves
// current behaviour exactly, which makes this safe to deploy before a single
// record has been migrated. The cost is that an unprovisioned tenant stays
// ungated, which is precisely the state we are already in, so it adds no new
// exposure.
//
// Flip to "operate" once every record carries a plan. That is a one-line
// change, and `planSource` in every gated response tells you when it is safe:
// while ANY tenant still reports "default", it is not.
export const PLAN_WHEN_UNSET = "control";

// A value that is present but unrecognised is treated as the WEAKEST plan, not
// as the default. The two failures are not symmetric. A typo that silently
// GRANTS Report to an Operate client is a revenue leak nobody can see from the
// outside and nobody will report. A typo that silently DENIES Report to a
// Report client produces a support ticket within the day and gets fixed. Fail
// toward the one that announces itself.
const PLAN_WHEN_UNRECOGNISED = PLANS[0];

/**
 * Resolve a tenant's effective plan.
 * Returns { plan, source } where source is one of:
 *   "tenant"              - read from the record, recognised
 *   "default"             - no plan field at all (pre-migration record)
 *   "no-tenant-record"    - no DASHBOARD_TENANTS entry for that locationId
 *   "unrecognised:<raw>"  - plan was set to something not in PLANS
 */
export function getTenantPlan(tenant) {
  if (!tenant) return { plan: PLAN_WHEN_UNSET, source: "no-tenant-record" };

  // Absent key vs present-but-junk are different mistakes and must fail in
  // opposite directions. No `plan` key at all means the record predates this
  // field -- legacy, keep it working. A key that IS set but holds "" or "   "
  // or "reporting" means somebody tried to set a plan and got it wrong, and
  // that must not be rewarded with the most generous default.
  if (typeof tenant.plan !== "string") {
    return { plan: PLAN_WHEN_UNSET, source: "default" };
  }

  const raw = tenant.plan.trim().toLowerCase();
  if (PLANS.includes(raw)) return { plan: raw, source: "tenant" };
  return { plan: PLAN_WHEN_UNRECOGNISED, source: `unrecognised:${JSON.stringify(tenant.plan)}` };
}

/**
 * Does this tenant hold at least `required`?
 * Returns { ok, plan, source, required } -- never a bare boolean, because a
 * caller that denies needs the plan and the source to say anything useful.
 */
export function planAtLeast(tenant, required) {
  const { plan, source } = getTenantPlan(tenant);
  const have = PLANS.indexOf(plan);
  const need = PLANS.indexOf(required);
  if (need === -1) {
    // A typo in OUR OWN call site. Deny loudly rather than quietly allowing
    // everything, which is what a bare `have >= need` would do when need is -1.
    return { ok: false, plan, source, required: `invalid:${required}` };
  }
  return { ok: have >= need, plan, source, required };
}

/**
 * The 403 body for a feature the tenant's plan does not include.
 *
 * Deliberately NOT 401: apiFetch() in the page treats any 401 as an expired
 * session and opens the admin key prompt, so a plan denial would ask the reader
 * to re-enter a key that cannot help. Not 402 either -- "payment required"
 * reads as "this account is unpaid", which is wrong and alarming. The account
 * is paid up; it is simply on a smaller plan.
 */
export function planDenied({ feature, plan, source, required }) {
  return Response.json(
    {
      error: `${feature} is not included in this account's plan`,
      plan,
      required,
      planSource: source,
      detail: `This account is on "${plan}". ${feature} is part of "${required}".`,
    },
    { status: 403 }
  );
}
