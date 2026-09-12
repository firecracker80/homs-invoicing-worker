// Custom-value reconciler for a HOMS client sub-account.
//
// Declarative, not imperative: it computes desired state from the blueprint plus
// caller input, diffs against what GHL actually holds, and issues only the calls
// that change something. Re-running it is therefore free and safe, which is what
// turns it into a drift detector as well as a provisioner.
//
// Invariants, in order of how badly they bite if broken:
//   1. A `manual` key is NEVER written. Enforced twice - once in the planner,
//      once as a hard throw in the writer. Those keys hold live webhook URLs.
//   2. Nothing is ever deleted. Values outside the blueprint are left untouched.
//   3. A generated secret is minted only into a blank slot, never over an
//      existing one - otherwise every run would rotate the client's secrets.
//   4. Missing input means "leave alone", never "blank it".

import { BLUEPRINT, slugFromFieldKey, generateSecret, derivedValue } from "./blueprint.js";
import { fetchCustomValues, createCustomValue, updateCustomValue } from "./ghl.js";

const isBlank = (v) => v === undefined || v === null || String(v).trim() === "";

// Thrown before any write is planned, so a misaddressed run does nothing at all.
export class WrongAccountError extends Error {
  constructor(expected, actual) {
    super(
      `Refusing to provision: caller expected brand "${expected}" but this account's WBrand Name is ` +
        (actual ? `"${actual}"` : "(empty)")
    );
    this.name = "WrongAccountError";
    this.status = 409;
  }
}

// Builds the full plan without touching GHL for writes. Exported so a caller can
// preview (dryRun) with the exact code path a real run uses - no parallel logic.
export function planReconcile(existing, { locationId, input = {}, overwrite = false, expectBrand = null }) {
  const bySlug = new Map();
  for (const cv of existing) {
    const slug = slugFromFieldKey(cv.fieldKey);
    if (slug) bySlug.set(slug, cv);
  }

  // Identity guard. The overwrite flag protects values that already exist, but a
  // payload aimed at the wrong locationId would still populate whatever happens to
  // be blank in a live account. Passing expectBrand makes the caller assert which
  // client it thinks it is configuring, checked against what the account actually
  // says, before a single write is planned. Always pass it for a live account.
  if (expectBrand !== null) {
    const actual = bySlug.get("wbrand_name")?.value ?? "";
    const norm = (s) => String(s).trim().toLowerCase();
    if (norm(actual) !== norm(expectBrand)) throw new WrongAccountError(expectBrand, actual);
  }

  // Luminara keeps its W* values inside a folder; DEMO-HOMS does not. Any value
  // this reconciler creates should land wherever the account already keeps them,
  // rather than loose at the root. Take the most common parentId as the hint.
  const parentCounts = new Map();
  for (const cv of existing) {
    if (cv.parentId) parentCounts.set(cv.parentId, (parentCounts.get(cv.parentId) || 0) + 1);
  }
  const parentIdHint = [...parentCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  const plan = [];

  for (const entry of BLUEPRINT) {
    const current = bySlug.get(entry.slug) || null;
    const currentValue = current?.value ?? "";
    const base = {
      slug: entry.slug,
      name: entry.name,
      label: entry.label,
      policy: entry.policy,
      sensitive: Boolean(entry.sensitive),
      id: current?.id || null,
    };

    if (entry.policy === "manual") {
      plan.push({
        ...base,
        action: "skipped-manual",
        reason: !current
          ? "not present in this account - must be created and filled by hand"
          : isBlank(currentValue)
            ? "PRESENT BUT EMPTY - must be filled by hand"
            : "already set - left untouched",
        needsAttention: !current || isBlank(currentValue),
      });
      continue;
    }

    let desired = null;
    if (entry.policy === "derived") {
      desired = derivedValue(entry.slug, { locationId });
    } else if (entry.policy === "generated") {
      if (!isBlank(currentValue)) {
        plan.push({ ...base, action: "unchanged", reason: "secret already set - never rotated automatically" });
        continue;
      }
      desired = generateSecret();
    } else {
      const supplied = input[entry.slug];
      if (isBlank(supplied)) {
        plan.push({
          ...base,
          action: "skipped-no-input",
          reason: isBlank(currentValue)
            ? "no value supplied and none stored"
            : "no value supplied - existing value left alone",
        });
        continue;
      }
      desired = String(supplied);
    }

    if (isBlank(desired)) {
      plan.push({ ...base, action: "skipped-no-input", reason: "nothing to write" });
      continue;
    }

    if (!current) {
      plan.push({ ...base, action: "create", desired, parentId: parentIdHint, reason: "key absent from account" });
    } else if (String(currentValue) === String(desired)) {
      plan.push({ ...base, action: "unchanged", reason: "stored value already matches" });
    } else if (!isBlank(currentValue) && !overwrite) {
      // The protection for accounts that are already live and configured. Filling
      // a blank is always safe; replacing a working value is not, and must be an
      // explicit decision rather than a side effect of running provisioning.
      plan.push({
        ...base,
        action: "blocked-needs-overwrite",
        from: currentValue,
        desired,
        reason: "account already holds a different value - pass overwrite:true to replace it",
        needsAttention: true,
      });
    } else {
      plan.push({ ...base, action: "update", desired, from: currentValue, reason: "stored value differs" });
    }
  }

  const known = new Set(BLUEPRINT.map((e) => e.slug));
  const extras = existing
    .map((cv) => ({ slug: slugFromFieldKey(cv.fieldKey), name: cv.name }))
    .filter((x) => x.slug && !known.has(x.slug));

  return { plan, extras };
}

export async function provision(pit, locationId, { input = {}, dryRun = false, overwrite = false, expectBrand = null } = {}) {
  if (!locationId) throw new Error("provision: locationId is required");

  const existing = await fetchCustomValues(pit, locationId);
  const { plan, extras } = planReconcile(existing, { locationId, input, overwrite, expectBrand });

  const results = [];
  let writes = 0;

  for (const step of plan) {
    // Invariant 1, second enforcement point. Unreachable unless the planner
    // regresses; kept because the cost of it regressing is a silently broken
    // payment flow in a live client account.
    if (step.policy === "manual" && (step.action === "create" || step.action === "update")) {
      throw new Error(`Refusing to write manual-policy key ${step.slug}`);
    }

    if (step.action !== "create" && step.action !== "update") {
      results.push(redact(step));
      continue;
    }

    if (dryRun) {
      results.push(redact({ ...step, action: `would-${step.action}` }));
      continue;
    }

    if (step.action === "create") {
      const created = await createCustomValue(pit, locationId, step.name, step.desired, step.parentId);
      writes += 1;
      results.push(redact({ ...step, action: "created", id: created?.id || null }));
    } else {
      await updateCustomValue(pit, locationId, step.id, step.name, step.desired);
      writes += 1;
      results.push(redact({ ...step, action: "updated" }));
    }
  }

  return {
    locationId,
    dryRun,
    overwrite,
    ranAt: new Date().toISOString(),
    writes,
    summary: tally(results),
    needsAttention: results.filter((r) => r.needsAttention).map((r) => r.slug),
    extras,
    results,
  };
}

// Secrets and credentials must never reach a log, an HTTP response, or a report.
function redact(step) {
  const out = { ...step };
  if (out.sensitive) {
    if (out.desired !== undefined) out.desired = "<redacted>";
    if (out.from !== undefined) out.from = "<redacted>";
  }
  return out;
}

function tally(results) {
  return results.reduce((acc, r) => {
    acc[r.action] = (acc[r.action] || 0) + 1;
    return acc;
  }, {});
}
