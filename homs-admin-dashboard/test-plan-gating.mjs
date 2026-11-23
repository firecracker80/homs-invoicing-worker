// The plan gate is the only thing standing between an Operate client at $97 and
// the owner statements, manager statements and P&L that Report is sold for. It
// reads the client's live subscription, so every case below is a real state a
// real subscription passes through.
import assert from "node:assert";
import {
  PLANS,
  PLAN_BY_STRIPE_PRODUCT,
  resolvePlan,
  planAtLeast,
  planDenied,
  clearPlanCache,
} from "./src/tenants.js";

const TENANT = { label: "Client", ghlPitSecretName: "GHL_PIT_X" };

function envWith(tenant = TENANT) {
  return {
    GHL_PIT_X: "pit-value",
    DASHBOARD_TENANTS: {
      async get(k, opts) {
        if (k !== "L1" || !tenant) return null;
        return opts?.type === "json" ? tenant : JSON.stringify(tenant);
      },
    },
  };
}

// A sub-account record shaped the way GHL really returns one. Verified against
// the live account a real purchase created on 2026-11-21.
const saasLocation = (productId, subscriptionStatus = "active") => ({
  id: "L1",
  settings: {
    saasSettings: {
      saasMode: "activated",
      customerId: "cus_x",
      saasPlanId: "6aff6d95237234f142186272",
      planDetails: { productId, subscriptionStatus, priceId: "price_x", subscriptionId: "sub_x" },
    },
  },
});

const stub = (loc) => async () => loc;
const opts = (fetchLocation) => ({ fetchLocation, noCache: true });

// --- the map is keyed on STRIPE PRODUCT ids ---------------------------------
// Not price ids (monthly and annual are different prices of one plan, and a
// price id changes when the price is edited) and not saasPlanId (regenerable).
assert.deepEqual(PLANS, ["operate", "report", "control"], "order IS the comparison");
assert.equal(PLAN_BY_STRIPE_PRODUCT.prod_Vex1k1bjvv40dI, "operate");
assert.equal(PLAN_BY_STRIPE_PRODUCT.prod_VexLcVjcq98VFz, "report");
assert.equal(PLAN_BY_STRIPE_PRODUCT.prod_VexU1CINuAU0tr, "control");
for (const k of Object.keys(PLAN_BY_STRIPE_PRODUCT)) {
  assert.ok(k.startsWith("prod_"), `${k} must be a Stripe PRODUCT id`);
}

// --- a paying subscription resolves to its tier ------------------------------
{
  const r = await resolvePlan(envWith(), "L1", opts(stub(saasLocation("prod_Vex1k1bjvv40dI"))));
  assert.equal(r.plan, "operate");
  assert.equal(r.source, "subscription");
}
{
  const g = await planAtLeast(envWith(), "L1", "report", opts(stub(saasLocation("prod_Vex1k1bjvv40dI"))));
  assert.equal(g.ok, false, "Operate must NOT reach Report -- this is the whole gate");
}
{
  const g = await planAtLeast(envWith(), "L1", "report", opts(stub(saasLocation("prod_VexLcVjcq98VFz"))));
  assert.equal(g.ok, true, "Report reaches Report");
}
{
  const g = await planAtLeast(envWith(), "L1", "report", opts(stub(saasLocation("prod_VexU1CINuAU0tr"))));
  assert.equal(g.ok, true, "Control includes Report");
}
{
  const g = await planAtLeast(envWith(), "L1", "control", opts(stub(saasLocation("prod_VexLcVjcq98VFz"))));
  assert.equal(g.ok, false, "Report must NOT reach Control");
}

// --- a trial is paying; everything else is not -------------------------------
{
  const g = await planAtLeast(envWith(), "L1", "report", opts(stub(saasLocation("prod_VexU1CINuAU0tr", "trialing"))));
  assert.equal(g.ok, true, "a 30-day trial has full access to its tier");
}
for (const dead of ["canceled", "past_due", "unpaid", "incomplete", "incomplete_expired", "paused"]) {
  const g = await planAtLeast(envWith(), "L1", "report", opts(stub(saasLocation("prod_VexU1CINuAU0tr", dead))));
  assert.equal(g.ok, false, `a "${dead}" subscription must lose the paid tier`);
  assert.equal(g.plan, "operate", "it drops to the floor, not to nothing -- they still have their own data");
  assert.ok(g.source.startsWith("status:"), "and the denial says why");
}

// --- accounts that are not SaaS customers keep everything --------------------
// HOMS and DEMO-HOMS are the agency's own. Gating them would take statements
// away from the people who built them.
{
  const own = { id: "L1", settings: { saasSettings: { saasMode: "not_activated" } } };
  const g = await planAtLeast(envWith(), "L1", "report", opts(stub(own)));
  assert.equal(g.ok, true);
  assert.equal(g.source, "saas:not_activated");
}
{
  const g = await planAtLeast(envWith(), "L1", "report", opts(stub({ id: "L1", settings: {} })));
  assert.equal(g.ok, true, "a record with no saasSettings at all is not a subscriber either");
}

// --- failures fail OPEN ------------------------------------------------------
// A GHL outage must not read as "your statements are gone" to a paying client.
{
  const boom = async () => { const e = new Error("502"); e.status = 502; throw e; };
  const g = await planAtLeast(envWith(), "L1", "report", opts(boom));
  assert.equal(g.ok, true, "an outage must not revoke a paid feature");
  assert.equal(g.source, "lookup-failed:502", "but it says so, so it is visible");
}
{
  const g = await planAtLeast(envWith(null), "L1", "report", opts(stub(saasLocation("prod_Vex1k1bjvv40dI"))));
  assert.equal(g.ok, true, "no tenant record -> not gated");
  assert.equal(g.source, "no-tenant-record");
}
{
  const env = envWith();
  delete env.GHL_PIT_X;
  const g = await planAtLeast(env, "L1", "report", opts(stub(saasLocation("prod_Vex1k1bjvv40dI"))));
  assert.equal(g.ok, true, "a missing PIT secret is a config fault, not a downgrade");
  assert.equal(g.source, "no-pit");
}

// --- an unmapped product fails toward the NOISY direction --------------------
// Granting a tier nobody paid for is silent and permanent. Denying one produces
// a support ticket the same day.
{
  const g = await planAtLeast(envWith(), "L1", "report", opts(stub(saasLocation("prod_SomethingNew"))));
  assert.equal(g.ok, false, "a plan nobody mapped must not grant Report");
  assert.equal(g.plan, "operate");
  assert.ok(g.source.startsWith("unmapped-product:"), "and names the product so it can be mapped");
}

// --- a typo in OUR OWN call site must not open the gate ----------------------
// PLANS.indexOf("reprot") is -1, and a bare `have >= need` passes for every plan.
{
  const g = await planAtLeast(envWith(), "L1", "reprot", opts(stub(saasLocation("prod_Vex1k1bjvv40dI"))));
  assert.equal(g.ok, false, "an unknown requirement denies");
  assert.ok(String(g.required).startsWith("invalid:"));
}

// --- the cache serves, and does not outlive its TTL --------------------------
{
  clearPlanCache();
  let calls = 0;
  const counting = async () => { calls += 1; return saasLocation("prod_VexU1CINuAU0tr"); };
  const cache = new Map();
  const t0 = 1_000_000;
  await resolvePlan(envWith(), "L1", { fetchLocation: counting, cache, now: t0 });
  await resolvePlan(envWith(), "L1", { fetchLocation: counting, cache, now: t0 + 30_000 });
  assert.equal(calls, 1, "a second read inside the TTL must not hit GHL again");
  await resolvePlan(envWith(), "L1", { fetchLocation: counting, cache, now: t0 + 61_000 });
  assert.equal(calls, 2, "and a stale entry must not be served -- that is how drift gets back in");
}

// --- the denial response ------------------------------------------------------
{
  const denied = planDenied({
    feature: "Owner statement", plan: "operate", source: "subscription",
    required: "report", status: "active",
  });
  assert.equal(denied.status, 403, "403, never 401");
  const body = await denied.json();
  assert.equal(body.plan, "operate");
  assert.equal(body.required, "report");
  assert.equal(body.planSource, "subscription");
  assert.equal(body.subscriptionStatus, "active");
  assert.ok(body.error.includes("Owner statement"), "names the feature that was refused");
}

console.log("PASS — plan read live from the subscription: tiers, dead statuses, fail-open, unmapped products, cache TTL, 403 shape");
