// Local mock tests for provision.js -- no network, no live GHL/KV.
// Same dependency-free style as the rest of the suite: hand-rolled fetch and
// KV mocks, plain assert + console.log, no test framework.
import assert from "node:assert";
global.Response = class { constructor(b, i = {}) { this.body = b; this.status = i.status || 200; } async json() { return JSON.parse(this.body); } };

function makeKv(seed = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  return { async get(k, o) { const v = store.get(k); return v == null ? null : (o?.type === "json" ? JSON.parse(v) : v); }, async put(k, v) { store.set(k, v); }, _store: store };
}
const hdr = s => ({ get: n => n === "X-Admin-Secret" ? s : null });

const REAL_CUSTOM_VALUES = [
  { fieldKey: "wadmin_secret", name: "WAdmin Secret", value: "sekret123" },
  { fieldKey: "wbrand_name", name: "WBrand Name", value: "Luminara Hospitality" },
  { fieldKey: "wcleaning_fee", name: "WCleaning Fee", value: "69" },
  { fieldKey: "wcurrency", name: "WCurrency", value: "USD" },
  { fieldKey: "wghl_cancelation_url", name: "WGHL Cancelation URL", value: "https://services.leadconnectorhq.com/hooks/cancel" },
  { fieldKey: "wlocale", name: "WLocale", value: "es-ES" },
  { fieldKey: "wlocation_id", name: "WLocation ID", value: "wLGDbGcQ4QSG3nlT3Sis" },
  { fieldKey: "wmanager", name: "WManager", value: "Priya" },
  { fieldKey: "wowner_revenue_split", name: "WOwner Revenue Split", value: "85" },
  { fieldKey: "wpaypal_client_id", name: "WPayPal Client ID", value: "client_abc" },
  { fieldKey: "wpaypal_secret_key", name: "WPaypal Secret Key", value: "secret_xyz" },
  { fieldKey: "wproperty_owner", name: "WProperty Owner", value: "Yari" },
  { fieldKey: "wwebhook_secret", name: "WWebhook Secret", value: "whsec_1" },
  { fieldKey: "wmgr_paypal_email", name: "WMgr PayPal Email", value: "mgr@x.com" },
  { fieldKey: "wpaypal_webhook_id", name: "WPaypal Webhook ID", value: "WH-999" }
];

let lastFetchedUrl = null;
global.fetch = async (url) => {
  lastFetchedUrl = url;
  if (url.includes("/customValues")) {
    if (url.includes("bad-pit-location")) return { ok: false, status: 403, text: async () => JSON.stringify({ message: "The token does not have access to this location." }) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ customValues: REAL_CUSTOM_VALUES }) };
  }
  throw new Error("unmocked: " + url);
};

const { handleProvisionTenant } = await import("./src/provision.js");

// ---- 1. Unauthorized without the (global) admin secret ----
const kv1 = makeKv();
const env1 = { ADMIN_SECRET: "admin123", TENANTS: kv1 };
const unauth = await handleProvisionTenant({ method: "GET", url: "https://w.dev/admin/provision-tenant?locationId=L1&ghlPit=pit1", headers: { get: () => null } }, env1);
assert.equal(unauth.status, 401);
console.log("1) No X-Admin-Secret -> 401");

// ---- 2. Missing locationId / ghlPit -> 400 ----
const noLoc = await handleProvisionTenant({ method: "GET", url: "https://w.dev/admin/provision-tenant?ghlPit=pit1", headers: hdr("admin123") }, env1);
assert.equal(noLoc.status, 400);
const noPit = await handleProvisionTenant({ method: "GET", url: "https://w.dev/admin/provision-tenant?locationId=L1", headers: hdr("admin123") }, env1);
assert.equal(noPit.status, 400);
console.log("2) Missing locationId or ghlPit -> 400 for each");

// ---- 3. GET (dry run): maps known fields, converts percent, infers gateway, never writes ----
const dry = await (await handleProvisionTenant({ method: "GET", url: "https://w.dev/admin/provision-tenant?locationId=L1&ghlPit=pit1", headers: hdr("admin123") }, env1)).json();
assert.equal(dry.dryRun, true);
assert.equal(dry.wouldWrite.brandName, "Luminara Hospitality");
assert.equal(dry.wouldWrite.ownerPct, 0.85, "\"85\" from GHL must convert to the 0.85 fraction the worker's split math expects");
assert.equal(dry.wouldWrite.gateway, "paypal", "paypalClientId + paypalSecret both present -> gateway inferred as paypal");
assert.equal(dry.wouldWrite.ghlPit, "pit1", "the PIT handed to this call must end up in the written tenant too, not just used to fetch");
assert.equal(dry.wouldWrite.bookingWorkerEnabled, true);
assert.ok(!("wlocation_id" in dry.wouldWrite) && dry.wouldWrite.locationId === undefined, "wlocation_id is the KV key, must never become a JSON field");
assert.equal(dry.unmappedCustomValues.length, 2, "wmgr_paypal_email and wpaypal_webhook_id have no matching Worker field -- surfaced, not silently dropped");
assert.ok(dry.unmappedCustomValues.some(u => u.fieldKey === "wmgr_paypal_email"));
assert.equal(kv1._store.size, 0, "GET must never write, regardless of what it found");
console.log("3) GET dry run: correct field mapping, 85 -> 0.85, gateway inferred, PIT carried through, nothing written");

// ---- 4. POST creates a brand-new tenant ----
const written = await (await handleProvisionTenant({ method: "POST", url: "https://w.dev/admin/provision-tenant?locationId=L1&ghlPit=pit1", headers: hdr("admin123") }, env1)).json();
assert.equal(written.dryRun, false);
assert.equal(JSON.parse(kv1._store.get("L1")).brandName, "Luminara Hospitality");
console.log("4) POST with no existing tenant -> writes to KV under the literal locationId key");

// ---- 5. POST again without force -> 409, doesn't touch the existing entry ----
const conflict = await handleProvisionTenant({ method: "POST", url: "https://w.dev/admin/provision-tenant?locationId=L1&ghlPit=pit1", headers: hdr("admin123") }, env1);
assert.equal(conflict.status, 409);
console.log("5) POST against an already-provisioned locationId without &force=true -> 409, refuses to clobber");

// ---- 6. force=true merges -- a hand-set field survives, provisioned fields still update ----
const existingTenant = JSON.parse(kv1._store.get("L1"));
existingTenant.otaRate = 0.15; // set by hand, not something provisioning knows about
existingTenant.brandName = "Old Name"; // should get overwritten by the fresher custom value
kv1._store.set("L1", JSON.stringify(existingTenant));
const merged = await (await handleProvisionTenant({ method: "POST", url: "https://w.dev/admin/provision-tenant?locationId=L1&ghlPit=pit1&force=true", headers: hdr("admin123") }, env1)).json();
assert.equal(merged.written.otaRate, 0.15, "a field only a human set (otaRate) must survive a forced re-provision");
assert.equal(merged.written.brandName, "Luminara Hospitality", "provisioned fields overwrite stale existing values");
console.log("6) &force=true merges: hand-set fields preserved, provisioned fields refreshed");

// ---- 7. GHL API error (e.g. wrong PIT / no access) propagates cleanly, not a 500 crash ----
const kv2 = makeKv();
const ghlErr = await handleProvisionTenant({ method: "GET", url: "https://w.dev/admin/provision-tenant?locationId=bad-pit-location&ghlPit=badpit", headers: hdr("admin123") }, { ADMIN_SECRET: "admin123", TENANTS: kv2 });
assert.equal(ghlErr.status, 403);
console.log("7) GHL rejects the PIT/location -> that status code propagates, not a generic 500");

console.log("\nPASS — provision.js maps custom values correctly, never writes on GET, guards against clobbering an existing tenant, merges cleanly under &force=true.");
