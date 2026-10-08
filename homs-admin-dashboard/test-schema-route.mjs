// The schema check runs where the secret lives.
// Run: node test-schema-route.mjs
//
// A client's PIT is a per-tenant Worker secret. Capturing a provisioned
// account's schema from a laptop would mean exporting it, so the capture moved
// into the Worker and the diff stayed local -- the comparison logic keeps one
// home and one set of tests (test-schema-fingerprint.mjs).
//
// Gated by PROVISION_KEY rather than the dashboard login, because the account
// being checked has usually just been provisioned and has no dashboard user.
import assert from "node:assert";

const LOC = "aOBTcPWktqBI0IpfXDgI";
const worker = (await import("./src/index.js")).default;

const tenant = { label: "YV Guest Properties", ghlPitSecretName: "PIT_YV" };
const env = {
  PROVISION_KEY: "prov-key",
  ADMIN_KEY: "admin-key",
  PIT_YV: "pit-token",
  DASHBOARD_TENANTS: { get: async (k, o) => (o?.type === "json" ? tenant : JSON.stringify(tenant)) },
};

const OBJECTS = [
  { key: "contact", type: "SYSTEM_DEFINED", labels: { singular: "Contact", plural: "Contacts" } },
  {
    key: "custom_objects.expenses", type: "USER_DEFINED",
    labels: { singular: "Expense", plural: "Expenses" },
    primaryDisplayProperty: "custom_objects.expenses.expense_name",
    requiredProperties: ["custom_objects.expenses.expense_name"],
  },
  {
    key: "custom_objects.payments", type: "USER_DEFINED",
    labels: { singular: "Revenue", plural: "Revenue Streams" },
    primaryDisplayProperty: "custom_objects.payments.payment_reference",
    requiredProperties: ["custom_objects.payments.payment_reference"],
  },
];

let failFieldsFor = null;
const install = () => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    const ok = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o) });
    if (u.includes("/objects/?")) return ok({ objects: OBJECTS });
    if (u.includes("/custom-fields/object-key/")) {
      const key = decodeURIComponent(u.split("/custom-fields/object-key/")[1].split("?")[0]);
      if (key === failFieldsFor) {
        return { ok: false, status: 403, text: async () => JSON.stringify({ message: "scope denied" }) };
      }
      return ok({
        fields: [{
          fieldKey: `${key}.paid_by`, dataType: "SINGLE_OPTIONS", name: "Paid By",
          options: [{ key: "owner", label: "Owner" }, { key: "manager", label: "Manager" }],
        }],
        folders: [],
      });
    }
    throw new Error("unmocked: " + u);
  };
};

const get = async (qs, auth = "Bearer prov-key") => {
  install();
  const res = await worker.fetch(new Request(`https://d.dev/api/schema/fingerprint${qs}`, {
    headers: auth ? { Authorization: auth } : {},
  }), env);
  return { status: res.status, body: await res.json() };
};

// ---- 1. it fingerprints the account -----------------------------------
{
  failFieldsFor = null;
  const r = await get(`?locationId=${LOC}`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.locationId, LOC);

  // Only the user-defined objects: the three system ones exist on every GHL
  // account and say nothing about whether a snapshot loaded.
  assert.deepStrictEqual(Object.keys(r.body.objects).sort(),
    ["custom_objects.expenses", "custom_objects.payments"]);
  assert.deepStrictEqual(
    r.body.objects["custom_objects.expenses"].fields["custom_objects.expenses.paid_by"].options,
    ["manager", "owner"], "option keys come through, sorted");
  assert.ok(!("unreadable" in r.body), "and nothing is reported unreadable when all of it read");
  console.log("1) The route returns a fingerprint of the user-defined objects");
}

// ---- 2. PROVISION_KEY, not the dashboard login ------------------------
{
  assert.strictEqual((await get(`?locationId=${LOC}`, null)).status, 401, "no credentials");
  assert.strictEqual((await get(`?locationId=${LOC}`, "Bearer wrong")).status, 401, "wrong key");
  // The dashboard's own key must not open it: this is a provisioning tool, and
  // the two keys exist so they can be given to different people.
  assert.strictEqual((await get(`?locationId=${LOC}`, "Bearer admin-key")).status, 401);
  console.log("2) Gated by PROVISION_KEY; the dashboard key does not open it");
}

// ---- 3. a missing or unknown account is refused clearly ---------------
{
  assert.strictEqual((await get("")).status, 400, "no locationId");
  const unknown = { ...env, DASHBOARD_TENANTS: { get: async () => null } };
  install();
  const res = await worker.fetch(new Request(`https://d.dev/api/schema/fingerprint?locationId=NOPE`,
    { headers: { Authorization: "Bearer prov-key" } }), unknown);
  assert.ok(res.status >= 400, "an account with no tenant record cannot be checked");
  console.log("3) A missing locationId or an unregistered account is refused");
}

// ---- 4. an unreadable object is REPORTED, not read as empty -----------
// The failure mode worth preventing. Swallowing a 403 fingerprints the object
// as having no fields at all, and the diff then reports every field missing --
// which reads as a catastrophic snapshot failure and sends somebody looking at
// the snapshot instead of at the token's scopes.
{
  failFieldsFor = "custom_objects.payments";
  const r = await get(`?locationId=${LOC}`);
  assert.strictEqual(r.status, 200, "one unreadable object does not fail the whole check");

  assert.ok(Array.isArray(r.body.unreadable), "it is reported");
  assert.strictEqual(r.body.unreadable.length, 1);
  assert.strictEqual(r.body.unreadable[0].objectKey, "custom_objects.payments");
  assert.match(r.body.unreadable[0].error, /scope denied/, "with the reason GHL gave");

  // The object that DID read is still complete, so one bad scope does not cost
  // the whole run.
  assert.ok(r.body.objects["custom_objects.expenses"].fields["custom_objects.expenses.paid_by"]);
  console.log("4) An object whose fields cannot be read is named, not fingerprinted as empty");
}

console.log("\nPASS — the schema check runs where the PIT already is, and says what it could not read.");
