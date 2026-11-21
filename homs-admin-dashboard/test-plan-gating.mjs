// The tenant `plan` field is the only thing gating HOMS-built features. The
// SaaS Configurator gates GHL-native ones and cannot reach this Worker, so if
// these comparisons are wrong, an Operate client sees owner and manager
// statements -- which is the entire difference they would be paying Report for.
import assert from "node:assert";
import {
  PLANS,
  PLAN_WHEN_UNSET,
  getTenantPlan,
  planAtLeast,
  planDenied,
} from "./src/tenants.js";

const t = (plan) => ({ label: "X", ghlPitSecretName: "GHL_PIT_X", plan });

// --- ordering ---------------------------------------------------------------
assert.deepEqual(PLANS, ["operate", "report", "control"], "order IS the comparison");

assert.equal(planAtLeast(t("operate"), "report").ok, false, "Operate must NOT reach Report");
assert.equal(planAtLeast(t("report"), "report").ok, true);
assert.equal(planAtLeast(t("control"), "report").ok, true, "Control includes Report");
assert.equal(planAtLeast(t("operate"), "operate").ok, true);
assert.equal(planAtLeast(t("report"), "control").ok, false, "Report must NOT reach Control");

// --- the pre-migration default ----------------------------------------------
// Every record predates the field. Denying by default would strip statements
// from accounts that have them today, DEMO-HOMS included.
assert.equal(PLAN_WHEN_UNSET, "control");
assert.equal(getTenantPlan(t(undefined)).source, "default");
assert.equal(planAtLeast(t(undefined), "report").ok, true, "a record with no plan keeps today's access");
assert.equal(planAtLeast(null, "report").ok, true, "and so does a locationId with no record at all");
assert.equal(getTenantPlan(null).source, "no-tenant-record", "but it says WHICH of the two it was");

// --- a typo must fail toward the noisy direction -----------------------------
// Granting Report to an Operate client is invisible and nobody reports it.
// Denying Report to a Report client produces a ticket the same day.
for (const typo of ["reporting", "Report ing", "REPORTX", "operate2", " "]) {
  const got = planAtLeast(t(typo), "report");
  assert.equal(got.ok, false, `"${typo}" must not grant Report`);
}
assert.ok(getTenantPlan(t("reporting")).source.startsWith("unrecognised:"), "and it says so");

// ...while casing and stray whitespace are NOT typos, they are the same plan.
assert.equal(planAtLeast(t("  Report  "), "report").ok, true, "trimmed and lowercased");
assert.equal(planAtLeast(t("CONTROL"), "report").ok, true);

// --- a typo in OUR OWN call site must not open the gate ----------------------
// `PLANS.indexOf("reprot")` is -1, and a bare `have >= need` would pass for
// every plan. That failure would be silent and would grant, not deny.
assert.equal(planAtLeast(t("operate"), "reprot").ok, false, "an unknown requirement denies");
assert.ok(String(planAtLeast(t("operate"), "reprot").required).startsWith("invalid:"));

// --- the denial response ------------------------------------------------------
// Never 401: apiFetch() in the page treats any 401 as an expired session and
// opens the admin key prompt, so the reader would be asked to re-enter a key
// that cannot help them.
const denied = planDenied({ feature: "Owner statement", plan: "operate", source: "tenant", required: "report" });
assert.equal(denied.status, 403, "403, never 401");
const body = await denied.json();
assert.equal(body.plan, "operate");
assert.equal(body.required, "report");
assert.equal(body.planSource, "tenant", "planSource is how we know when it is safe to flip the default");
assert.ok(body.error.includes("Owner statement"), "names the feature that was refused");

console.log("PASS — plan ordering, pre-migration default, typo direction, and 403 shape");
