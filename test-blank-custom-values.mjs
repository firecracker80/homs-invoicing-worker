// An empty Custom Value must not erase a tenant field that is already right.
// Run: node test-blank-custom-values.mjs
//
// Luminara, read live 2026-09-26: WProperty Owner and WManager are both empty,
// while KV holds "Yajahira Velazquez" and "Maguisthel Fabian". A force run
// mapped the blanks straight through, so provisioning a live account would have
// stripped the names off every owner and manager statement it produces -- and
// returned 200 with nothing in the response to say so.
//
// deepStrictEqual throughout: deepEqual treats "" == null == 0 as equal, which
// is exactly the distinction every test in this file turns on.
import assert from "node:assert";
global.Response = class { constructor(b, i = {}) { this.body = b; this.status = i.status || 200; } async json() { return JSON.parse(this.body); } };

const cv = (slug, name, value) => ({ fieldKey: `{{ custom_values.${slug} }}`, name, value });

// Keyed by locationId so each case picks its own GHL state.
const SETS = {
  "blanks-shadow-values": [
    cv("wbrand_name", "WBrand Name", "Luminara"),
    cv("wproperty_owner", "WProperty Owner", ""),
    cv("wmanager", "WManager", ""),
  ],
  "blanks-shadow-nothing": [
    cv("wbrand_name", "WBrand Name", "Luminara"),
    cv("wproperty_owner", "WProperty Owner", ""),
  ],
  "whitespace-only": [cv("wmanager", "WManager", "   ")],
  "cleared-policy": [cv("wcancellation_policy", "WCancellation Policy", "")],
  "populated": [
    cv("wbrand_name", "WBrand Name", "Luminara"),
    cv("wproperty_owner", "WProperty Owner", "Yajahira Velazquez"),
    cv("wmanager", "WManager", "Maguisthel Fabian"),
  ],
};

global.fetch = async (url) => {
  const key = Object.keys(SETS).find((k) => url.includes(k));
  if (!key) throw new Error("unmocked: " + url);
  return { ok: true, status: 200, text: async () => JSON.stringify({ customValues: SETS[key] }) };
};

function makeKv(seed = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    async get(k, o) { const v = store.get(k); return v == null ? null : (o?.type === "json" ? JSON.parse(v) : v); },
    async put(k, v) { store.set(k, v); },
    read(k) { return JSON.parse(store.get(k)); },
  };
}
const hdr = (s) => ({ get: (n) => (n === "X-Admin-Secret" ? s : null) });

const { handleProvisionTenant } = await import("./src/provision.js");
const post = (env, loc) => handleProvisionTenant(
  { method: "POST", url: `https://w.dev/admin/provision-tenant?locationId=${loc}&ghlPit=pit&force=true&invoiceSenderUserId=u1`, headers: hdr("admin123") },
  env
);

// ---- 1. the Luminara case: blanks keep what KV already holds ---------------
{
  const kv = makeKv({ "blanks-shadow-values": { ownerName: "Yajahira Velazquez", managerName: "Maguisthel Fabian", brandName: "Old Brand" } });
  const body = await (await post({ ADMIN_SECRET: "admin123", TENANTS: kv }, "blanks-shadow-values")).json();

  assert.deepStrictEqual(body.written.ownerName, "Yajahira Velazquez", "an empty WProperty Owner must not erase the owner");
  assert.deepStrictEqual(body.written.managerName, "Maguisthel Fabian", "nor an empty WManager the manager");
  // And the populated value beside them still updates, so the guard is not a freeze.
  assert.deepStrictEqual(body.written.brandName, "Luminara", "a value that IS filled in still overwrites");
  assert.deepStrictEqual(kv.read("blanks-shadow-values").ownerName, "Yajahira Velazquez", "and that is what actually landed in KV");
  console.log("1) Empty custom values keep the existing KV value; filled ones still overwrite");
}

// ---- 2. the disagreement is reported, not just survived --------------------
// Silently doing the right thing is how the field stays wrong in GHL forever.
{
  const kv = makeKv({ "blanks-shadow-values": { ownerName: "Yajahira Velazquez", managerName: "Maguisthel Fabian" } });
  const body = await (await post({ ADMIN_SECRET: "admin123", TENANTS: kv }, "blanks-shadow-values")).json();

  assert.deepStrictEqual(
    body.blankCustomValues.map((b) => b.tenantField).sort(),
    ["managerName", "ownerName"],
    "both blanks are listed, by the tenant field they would have overwritten"
  );
  assert.deepStrictEqual(body.blankCustomValues.find((b) => b.tenantField === "ownerName").name, "WProperty Owner",
    "named as GHL names it, so it can be found and filled in");

  const warned = body.warnings.filter((w) => /empty in GHL/.test(w));
  assert.deepStrictEqual(warned.length, 2, "each shadowed field warns");
  assert.ok(warned.some((w) => w.includes("WProperty Owner") && w.includes("ownerName")),
    "the warning names both the GHL value and the tenant field");
  assert.ok(warned.every((w) => /disagree/.test(w)), "and says what the state now is, not just what was skipped");
  console.log("2) Every blank that shadows a populated field is listed and warned about");
}

// ---- 3. a blank with nothing behind it leaves the field absent -------------
// Not "", which would make a later "is this configured" check read as yes.
{
  const kv = makeKv();
  const body = await (await post({ ADMIN_SECRET: "admin123", TENANTS: kv }, "blanks-shadow-nothing")).json();

  assert.deepStrictEqual("ownerName" in body.written, false, "an unconfigured field is absent, not empty-string");
  assert.deepStrictEqual(body.blankCustomValues.map((b) => b.tenantField), ["ownerName"], "still reported");
  assert.deepStrictEqual(body.warnings.filter((w) => /empty in GHL/.test(w)), [],
    "but not warned about -- nothing was shadowed, so there is no disagreement to report");
  console.log("3) A blank with no existing value leaves the field absent and raises no false alarm");
}

// ---- 4. a cleared cancellation policy IS applied ---------------------------
// The one field where blank is an instruction: no tiers and checkedInChargePct 0
// means refund everything. Skipping it would keep charging guests under a policy
// the account has explicitly cleared.
{
  const kv = makeKv({ "cleared-policy": { cancellationPolicy: { tiers: [{ underHours: 24, chargePct: 1 }], checkedInChargePct: 1 } } });
  const body = await (await post({ ADMIN_SECRET: "admin123", TENANTS: kv }, "cleared-policy")).json();

  assert.deepStrictEqual(body.written.cancellationPolicy.tiers, [], "clearing the policy in GHL clears it in KV");
  assert.deepStrictEqual(body.written.cancellationPolicy.checkedInChargePct, 0, "which means a full refund, always");
  assert.deepStrictEqual(body.blankCustomValues, [], "and it is not reported as a skipped blank, because it was not skipped");
  console.log("4) A cleared cancellation policy is applied, not skipped -- blank means full refund there");
}

// ---- 5. whitespace is blank ------------------------------------------------
// A space typed into a GHL field looks identical to an empty one on screen.
{
  const kv = makeKv({ "whitespace-only": { managerName: "Maguisthel Fabian" } });
  const body = await (await post({ ADMIN_SECRET: "admin123", TENANTS: kv }, "whitespace-only")).json();
  assert.deepStrictEqual(body.written.managerName, "Maguisthel Fabian", "a space is not a name");
  assert.deepStrictEqual(body.blankCustomValues.length, 1);
  console.log("5) A whitespace-only custom value counts as blank");
}

// ---- 6. a fully populated account reports no blanks -----------------------
// The guard must be invisible when there is nothing to guard against.
{
  const kv = makeKv({ populated: { ownerName: "Someone Else" } });
  const body = await (await post({ ADMIN_SECRET: "admin123", TENANTS: kv }, "populated")).json();
  assert.deepStrictEqual(body.blankCustomValues, []);
  assert.deepStrictEqual(body.warnings.filter((w) => /empty in GHL/.test(w)), []);
  assert.deepStrictEqual(body.written.ownerName, "Yajahira Velazquez", "and real values still overwrite stale ones");
  assert.deepStrictEqual(body.written.managerName, "Maguisthel Fabian");
  console.log("6) An account with everything filled in reports no blanks and updates normally");
}

console.log("\nPASS — an empty custom value keeps the value already in KV, says so, and never passes for a real one.");
