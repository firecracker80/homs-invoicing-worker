// The other plan tests use fixtures I wrote, which proves the comparison logic
// and assumes the shape. This one uses the EXACT settings block GHL returned for
// the sub-account a real purchase created on 2026-11-21 (read live 2026-11-23),
// so it proves the part the others take on trust: that a genuine activated
// subscription parses into the right tier.
//
// It is also the only place the gate is seen DENYING anything against real data.
// Every live result so far has been a fail-open path -- saas:not_activated on
// DEMO-HOMS, lookup-failed on HOMS -- because neither of those is a SaaS
// account, and converting one would mean a payment method and a Stripe
// customer. This costs nothing and tests the same thing.
import assert from "node:assert";
import { planAtLeast, resolvePlan } from "./src/tenants.js";

// Verbatim from GET /locations/i4QaTNKkYfeQj07Ec1eZ. Do not "tidy" it --
// its value is being exactly what GHL sends.
const REAL_ACTIVATED = {
  settings: {
    saasSettings: {
      saasMode: "activated",
      customerId: "cus_VfhrXkLp4RV2Va",
      planDetails: {
        subscriptionId: "sub_1UeMS1CE5X2ua1b6zembDiNu",
        priceId: "price_1UddkoCE5X2ua1b6TGuPv0bG",
        productId: "prod_Vex1k1bjvv40dI",
        subscriptionStatus: "trialing",
      },
      mailgunRebilling: { markup: 170, enabled: true },
      saasPlanId: "6aff6d95237234f142186272",
      locationDowngradeEnabled: true,
    },
  },
};

const env = {
  PIT: "token",
  DASHBOARD_TENANTS: { async get() { return { label: "Test", ghlPitSecretName: "PIT" }; } },
};
const withLocation = (loc) => ({ fetchLocation: async () => loc, noCache: true });

// --- a real Operate subscription resolves to Operate -------------------------
{
  const r = await resolvePlan(env, "L", withLocation(REAL_ACTIVATED));
  assert.equal(r.plan, "operate", "prod_Vex1k1bjvv40dI is the Operate product");
  assert.equal(r.source, "subscription", "read from the subscription, not a fallback");
  assert.equal(r.status, "trialing");
  assert.equal(r.productId, "prod_Vex1k1bjvv40dI");
}

// --- and is DENIED the Report tier -------------------------------------------
// This is the assertion the whole branch exists for: a $97 Operate client must
// not see owner statements, manager statements or the P&L.
{
  const g = await planAtLeast(env, "L", "report", withLocation(REAL_ACTIVATED));
  assert.equal(g.ok, false, "a real Operate subscription must NOT reach Report");
  assert.equal(g.plan, "operate");
}
{
  const g = await planAtLeast(env, "L", "control", withLocation(REAL_ACTIVATED));
  assert.equal(g.ok, false, "nor Control");
}
{
  const g = await planAtLeast(env, "L", "operate", withLocation(REAL_ACTIVATED));
  assert.equal(g.ok, true, "but it keeps everything it paid for");
}

// --- the same real payload, upgraded ------------------------------------------
// Same shape, Report's product id. If a client upgrades, nothing else about the
// payload changes -- which is the point of keying on the product.
{
  const upgraded = structuredClone(REAL_ACTIVATED);
  upgraded.settings.saasSettings.planDetails.productId = "prod_VexLcVjcq98VFz";
  const g = await planAtLeast(env, "L", "report", withLocation(upgraded));
  assert.equal(g.ok, true, "Report's product id unlocks Report on the real shape");
}

// --- and cancelled ------------------------------------------------------------
{
  const cancelled = structuredClone(REAL_ACTIVATED);
  cancelled.settings.saasSettings.planDetails.productId = "prod_VexU1CINuAU0tr";
  cancelled.settings.saasSettings.planDetails.subscriptionStatus = "canceled";
  const g = await planAtLeast(env, "L", "report", withLocation(cancelled));
  assert.equal(g.ok, false, "a cancelled Control subscription loses the paid tier");
  assert.equal(g.plan, "operate", "and drops to the floor, not to nothing");
}

console.log("PASS — GHL's real activated-subscription payload resolves to Operate, and is denied Report");
