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

// fieldKey in the exact shape GHL's live API returns it -- the merge-tag form,
// verified 2026-09-11 against all 19 values on DEMO-HOMS and Luminara. The
// previous fixture used bare keys ("wbrand_name"), which encoded the same
// wrong assumption as the code and so passed while production matched nothing.
const cv = (slug, name, value) => ({ fieldKey: `{{ custom_values.${slug} }}`, name, value });
const REAL_CUSTOM_VALUES = [
  cv("wadmin_secret", "WAdmin Secret", "sekret123"),
  cv("wbrand_name", "WBrand Name", "Luminara Hospitality"),
  cv("wcleaning_fee", "WCleaning Fee", "69"),
  cv("wcurrency", "WCurrency", "USD"),
  cv("wcancellation_policy", "WCancellation Policy", "24h 50%, 5 dias 20%, check-in 100%"),
  cv("wghl_cancelation_url", "WGHL Cancelation URL", "https://services.leadconnectorhq.com/hooks/cancel"),
  cv("wlocale", "WLocale", "es-ES"),
  cv("wlocation_id", "WLocation ID", "wLGDbGcQ4QSG3nlT3Sis"),
  cv("wmanager", "WManager", "Priya"),
  cv("wowner_revenue_split", "WOwner Revenue Split", "85"),
  cv("wpaypal_client_id", "WPayPal Client ID", "client_abc"),
  cv("wpaypal_secret_key", "WPaypal Secret Key", "secret_xyz"),
  cv("wproperty_owner", "WProperty Owner", "Yari"),
  cv("wwebhook_secret", "WWebhook Secret", "whsec_1"),
  cv("wowner_paypal_email", "WOwner PayPal Email", "owner@x.com"),
  cv("wmgr_paypal_email", "WMgr PayPal Email", "mgr@x.com"),
  cv("wpaypal_webhook", "WPaypal Webhook", "WH-999"),
  cv("wsomething_new", "WSomething New", "unmapped-on-purpose")
];

global.fetch = async (url) => {
  if (url.includes("/customValues")) {
    if (url.includes("bad-pit-location")) return { ok: false, status: 403, text: async () => JSON.stringify({ message: "The token does not have access to this location." }) };
    if (url.includes("bad-policy")) return { ok: true, status: 200, text: async () => JSON.stringify({ customValues: [cv("wcancellation_policy", "WCancellation Policy", "24h 50%, whenever")] }) };
    if (url.includes("bare-keys")) return { ok: true, status: 200, text: async () => JSON.stringify({ customValues: [{ fieldKey: "wbrand_name", name: "WBrand Name", value: "Bare" }] }) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ customValues: REAL_CUSTOM_VALUES }) };
  }
  throw new Error("unmocked: " + url);
};

const { handleProvisionTenant } = await import("./src/provision.js");
const call = (env, method, qs, secret = "admin123") =>
  handleProvisionTenant({ method, url: `https://w.dev/admin/provision-tenant?${qs}`, headers: secret == null ? { get: () => null } : hdr(secret) }, env);

// ---- 1. Unauthorized without, or with the wrong, admin secret ----
const kv1 = makeKv();
const env1 = { ADMIN_SECRET: "admin123", TENANTS: kv1, PAYPAL_SECRET_LUM: "set" };
assert.equal((await call(env1, "GET", "locationId=L1&ghlPit=pit1", null)).status, 401);
assert.equal((await call(env1, "GET", "locationId=L1&ghlPit=pit1", "admin12")).status, 401, "a prefix of the secret must not pass");
assert.equal((await call({ TENANTS: kv1 }, "GET", "locationId=L1&ghlPit=pit1", "")).status, 401, "unset ADMIN_SECRET fails closed, even against an empty header");
console.log("1) Missing, wrong, or unconfigured admin secret -> 401");

// ---- 2. Missing locationId / ghlPit -> 400 ----
assert.equal((await call(env1, "GET", "ghlPit=pit1")).status, 400);
assert.equal((await call(env1, "GET", "locationId=L1")).status, 400);
console.log("2) Missing locationId or ghlPit -> 400 for each");

// ---- 3. GET (dry run) against the real wrapped fieldKey format ----
const dry = await (await call(env1, "GET", "locationId=L1&ghlPit=pit1&paypalSecretName=PAYPAL_SECRET_LUM")).json();
assert.equal(dry.dryRun, true);
assert.equal(dry.wouldWrite.brandName, "Luminara Hospitality", "wrapped '{{ custom_values.wbrand_name }}' must map");
assert.equal(dry.wouldWrite.ownerPct, 0.85, "\"85\" from GHL must convert to the 0.85 fraction the worker's split math expects");
assert.equal(dry.wouldWrite.defaultCleaningFee, undefined, "cleaning is GHL-native; wcleaning_fee is no longer copied");
assert.deepEqual(dry.wouldWrite.cancellationPolicy, { tiers: [{ underHours: 24, chargePct: 0.5 }, { underHours: 120, chargePct: 0.2 }], checkedInChargePct: 1 }, "WCancellation Policy text -> cancellationPolicy");
assert.equal(dry.wouldWrite.paypalWebhookId, "WH-999", "wpaypal_webhook -> paypalWebhookId, read by payment.js webhook verification");
assert.equal(dry.wouldWrite.ownerPaypalEmail, "owner@x.com");
assert.equal(dry.wouldWrite.managerPaypalEmail, "mgr@x.com");
assert.equal(dry.wouldWrite.ghlPit, "pit1", "the PIT handed to this call must end up in the written tenant too, not just used to fetch");
assert.equal(dry.wouldWrite.bookingWorkerEnabled, true);
assert.ok(!("wlocation_id" in dry.wouldWrite) && dry.wouldWrite.locationId === undefined, "wlocation_id is the KV key, must never become a JSON field");
assert.equal(dry.mappedFromCustomValues.length, 14, "every known value maps -- none silently lost to the fieldKey wrapper");
assert.deepEqual(dry.unmappedCustomValues.map(u => u.name), ["WSomething New"], "only the genuinely unknown value is unmapped");
assert.equal(kv1._store.size, 0, "GET must never write, regardless of what it found");
console.log("3) GET dry run: wrapped fieldKeys map, 85 -> 0.85, webhook ID + payout emails mapped, nothing written");

// ---- 4. PayPal secret is never copied out of GHL ----
assert.equal(dry.wouldWrite.paypalSecret, undefined, "wpaypal_secret_key must not land in KV");
assert.ok(!JSON.stringify(dry).includes("secret_xyz"), "the secret value must not be echoed anywhere in the response");
assert.deepEqual(dry.skippedSensitive, ["wpaypal_secret_key"]);
assert.equal(dry.wouldWrite.paypalSecretName, "PAYPAL_SECRET_LUM");
assert.equal(dry.wouldWrite.gateway, "paypal", "client ID + paypalSecretName -> gateway inferred");
assert.deepEqual(dry.warnings, [], "named secret exists on this env -> no warning");
console.log("4) PayPal secret skipped and not echoed; paypalSecretName carried through; gateway inferred");

// ---- 5. No paypalSecretName, or one that isn't set -> no gateway guess, explicit warning ----
const noName = await (await call(env1, "GET", "locationId=L1&ghlPit=pit1")).json();
assert.equal(noName.wouldWrite.gateway, undefined, "never infer a payment gateway without a usable secret");
assert.ok(noName.warnings.some(w => w.includes("paypalSecretName")));
const unset = await (await call(env1, "GET", "locationId=L1&ghlPit=pit1&paypalSecretName=PAYPAL_SECRET_TYPO")).json();
assert.ok(unset.warnings.some(w => w.includes("wrangler secret put PAYPAL_SECRET_TYPO")));
console.log("5) Missing or unset paypalSecretName -> gateway not inferred, warning tells you the fix");

// ---- 6. Bare fieldKeys still map (in case GHL ever returns them) ----
const badPolicy = await (await call(env1, "GET", "locationId=bad-policy&ghlPit=pit1")).json();
assert.ok(badPolicy.warnings.some(w => w.includes("whenever")), "an unreadable cancellation rule is reported, not silently dropped");
assert.deepEqual(badPolicy.wouldWrite.cancellationPolicy.tiers, [{ underHours: 24, chargePct: 0.5 }], "the readable rules still apply");
console.log("   WCancellation Policy: unreadable rule -> warning, readable rules kept");

const bare = await (await call(env1, "GET", "locationId=bare-keys&ghlPit=pit1")).json();
assert.equal(bare.wouldWrite.brandName, "Bare");
console.log("6) Bare fieldKey form still maps");

// ---- 7. POST creates a brand-new tenant ----
const written = await (await call(env1, "POST", "locationId=L1&ghlPit=pit1&paypalSecretName=PAYPAL_SECRET_LUM")).json();
assert.equal(written.dryRun, false);
const stored = JSON.parse(kv1._store.get("L1"));
assert.equal(stored.brandName, "Luminara Hospitality");
assert.equal(stored.paypalSecret, undefined);
console.log("7) POST with no existing tenant -> writes to KV under the literal locationId key, no inline PayPal secret");

// ---- 8. POST again without force -> 409, doesn't touch the existing entry ----
assert.equal((await call(env1, "POST", "locationId=L1&ghlPit=pit1")).status, 409);
console.log("8) POST against an already-provisioned locationId without &force=true -> 409, refuses to clobber");

// ---- 9. force=true merges -- hand-set fields survive, including an existing inline secret ----
const existingTenant = JSON.parse(kv1._store.get("L1"));
existingTenant.otaRate = 0.15;           // set by hand, not something provisioning knows about
existingTenant.brandName = "Old Name";   // should get overwritten by the fresher custom value
existingTenant.paypalSecret = "legacy";  // pilot-era inline secret: provisioning must not delete it
kv1._store.set("L1", JSON.stringify(existingTenant));
const merged = await (await call(env1, "POST", "locationId=L1&ghlPit=pit1&force=true")).json();
assert.equal(merged.written.otaRate, 0.15, "a field only a human set (otaRate) must survive a forced re-provision");
assert.equal(merged.written.brandName, "Luminara Hospitality", "provisioned fields overwrite stale existing values");
assert.equal(merged.written.paypalSecret, "legacy", "re-provisioning a live tenant must not strip the inline secret payments still depend on");
console.log("9) &force=true merges: hand-set fields and the legacy inline secret preserved, provisioned fields refreshed");

// ---- 10. GHL API error (e.g. wrong PIT / no access) propagates cleanly, not a 500 crash ----
const ghlErr = await call({ ADMIN_SECRET: "admin123", TENANTS: makeKv() }, "GET", "locationId=bad-pit-location&ghlPit=badpit");
assert.equal(ghlErr.status, 403);
console.log("10) GHL rejects the PIT/location -> that status code propagates, not a generic 500");

console.log("\nPASS — provision.js maps GHL's real fieldKey format, never copies the PayPal secret, never writes on GET, guards against clobbering, merges cleanly under &force=true.");
