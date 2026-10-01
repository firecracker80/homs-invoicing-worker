// A tenant's own admin secret adds to the operator's, it does not replace it.
// Run: node test-admin-secret-scope.mjs
//
// Yari, 2026-10-01: "when i enter the admin key it says i am unauthorized but
// everything else opens."
//
// Two defects, one symptom.
//
//   adminAuthorized() read `tenant?.adminSecret || env.ADMIN_SECRET`, so an
//   account that had its own secret REPLACED the global one. The admin
//   dashboard holds exactly one secret, so it was locked out of precisely those
//   accounts -- DEMO-HOMS among them -- while working everywhere else. That is
//   why only the manager statement failed.
//
//   The dashboard then passed that 401 straight through, and apiFetch() in the
//   page treats ANY 401 as "your session expired" and opens the key prompt. So
//   the reader was asked to re-enter a key that could not help, and told they
//   were unauthorized when their session was never in question.
import assert from "node:assert";

const { handleManagerPL } = await import("./src/reports.js");

const TENANT_SECRET = "tenant-own-secret";
const GLOBAL_SECRET = "operator-global-secret";

const envFor = (tenant, env = {}) => ({
  TENANTS: { get: async () => ({ brandName: "B", currency: "USD", ghlPit: "pit", ...tenant }) },
  LEDGER_DB: {
    prepare: (sql) => ({
      bind: () => ({
        all: async () => ({
          results: sql.includes("recipient = 'owner'") ? []
            : sql.includes("cleaning_fee") ? [{ total_minor: 0 }]
            : [{ currency: "USD", total_minor: 50000, n: 1 }],
        }),
      }),
    }),
  },
  ADMIN_SECRET: GLOBAL_SECRET,
  ...env,
});

const call = async (secret, tenant = {}) => {
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ records: [] }) });
  const headers = secret ? { "X-Admin-Secret": secret } : {};
  const res = await handleManagerPL(
    new Request("https://w.dev/reports/manager-pl?locationId=l&format=json", { headers }), envFor(tenant));
  return res.status;
};

// ---- 1. the operator's global secret works on a tenant that has its own ----
// The regression itself. Before this, the global secret was refused by exactly
// the accounts that had been given their own.
{
  assert.strictEqual(await call(GLOBAL_SECRET, { adminSecret: TENANT_SECRET }), 200,
    "the operator is not locked out of an account for having given it a secret of its own");
  console.log("1) The operator's global secret opens a tenant that has its own secret");
}

// ---- 2. the tenant's own secret still works -------------------------
// It has to keep working: it is what a client was given, and revoking it by
// accident would be the same bug pointing the other way.
{
  assert.strictEqual(await call(TENANT_SECRET, { adminSecret: TENANT_SECRET }), 200);
  console.log("2) The tenant's own secret still works, so nothing issued to a client is revoked");
}

// ---- 3. an account with no secret of its own is unchanged -----------
{
  assert.strictEqual(await call(GLOBAL_SECRET, {}), 200);
  console.log("3) An account with no secret of its own behaves exactly as before");
}

// ---- 4. a wrong secret is still refused ----------------------------
// The whole point of widening this was that it grants nothing new.
{
  assert.strictEqual(await call("not-the-secret", { adminSecret: TENANT_SECRET }), 401);
  assert.strictEqual(await call("not-the-secret", {}), 401);
  assert.strictEqual(await call(""), 401, "an empty header is not a match for an unset secret");
  assert.strictEqual(await call(null), 401, "and neither is no header at all");
  console.log("4) A wrong, empty or absent secret is still refused on every account");
}

// ---- 5. one tenant's secret does not open another ------------------
// The guard that makes per-tenant secrets worth having at all.
{
  assert.strictEqual(await call("other-tenants-secret", { adminSecret: TENANT_SECRET }), 401,
    "a secret issued to one account must not open another");
  console.log("5) A secret issued to one account does not open a different one");
}

// ---- 6. an unset global cannot be matched by an empty header -------
// `expected && given === expected` protected against this before; the array
// form has to keep doing so, or an account with neither secret set would admit
// anybody sending nothing.
{
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ records: [] }) });
  const res = await handleManagerPL(
    new Request("https://w.dev/reports/manager-pl?locationId=l", { headers: { "X-Admin-Secret": "" } }),
    envFor({}, { ADMIN_SECRET: undefined }));
  assert.strictEqual(res.status, 401, "no secret configured anywhere admits nobody, rather than everybody");
  console.log("6) With no secret configured at all, an empty header still opens nothing");
}

// ---- 7. a secret configured as an empty string opens nothing -------
// A tenant record is hand-edited JSON, so adminSecret can end up as "". Two
// guards stand between that and an open door -- `if (!given) return false` and
// the `expected &&` inside the comparison -- and each one alone is enough,
// which is why removing either in isolation changes no behaviour. This asserts
// the outcome rather than either mechanism, so losing BOTH is caught.
{
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ records: [] }) });
  const blank = await handleManagerPL(
    new Request("https://w.dev/reports/manager-pl?locationId=l", { headers: { "X-Admin-Secret": "" } }),
    envFor({ adminSecret: "" }, { ADMIN_SECRET: "" }));
  assert.strictEqual(blank.status, 401,
    "a secret left blank must not be matched by sending nothing");
  console.log("7) A secret configured as an empty string is matched by nothing, including an empty header");
}

console.log("\nPASS — a tenant's secret adds to the operator's rather than replacing it, and nothing else widened.");
