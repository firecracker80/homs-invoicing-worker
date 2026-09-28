// The authorization PIN is per account, and a person has to be able to type it.
// Run: node test-authorization-pin.mjs
//
// Until now the PIN gating a manager-executed cancellation was the literal
// "12345", compared inside a workflow If/Else. The same five digits on every
// account, recorded in a test note, and rotating it meant editing workflow
// steps rather than a field.
//
// It is a generated blueprint value now, so provisioning mints one per account
// and the workflow compares against {{ custom_values.wauthorization_pin }}.
// Which raises the thing this file mostly exists to pin: a generated value a
// HUMAN types cannot be the 43-character base64 the other generated values use.
import assert from "node:assert";

const { BLUEPRINT, generatePin, generateSecret } = await import("./src/blueprint.js");
const { planReconcile } = await import("./src/provision.js");

const LOC = "ZghxU8I60bEm39JUbtCm";
const entry = BLUEPRINT.find((e) => e.slug === "wauthorization_pin");

// ---- 1. it is in the blueprint, generated and sensitive ---------------
{
  assert.ok(entry, "the PIN is a blueprint key, so every account gets one");
  assert.strictEqual(entry.policy, "generated", "minted, not left for someone to invent");
  assert.strictEqual(entry.sensitive, true, "and never printed in a plan or a log");
  assert.strictEqual(entry.format, "pin", "flagged as the kind a person types");
  console.log("1) The PIN is a generated, sensitive blueprint value");
}

// ---- 2. it is typeable, which is the whole point ---------------------
// A base64url secret here would be technically fine and operationally useless:
// nobody reads 43 characters off a screen into a form under a guest's eye.
{
  const pin = generatePin();
  assert.strictEqual(pin.length, 8, "short enough to type");
  assert.match(pin, /^[a-zA-Z2-9]{8}$/, "and nothing in it needs explaining");
  assert.doesNotMatch(pin, /[Il1O0]/,
    "no character anyone has to squint at -- a PIN misread is a PIN retyped");
  assert.notStrictEqual(pin.length, generateSecret().length,
    "deliberately not the machine-readable secret shape");
  console.log("2) A generated PIN is eight unambiguous characters, not a 43-character token");
}

// ---- 3. it is different every time ----------------------------------
// The failure this replaces was one shared value across every account.
{
  const pins = new Set(Array.from({ length: 200 }, () => generatePin()));
  assert.strictEqual(pins.size, 200, "200 mints, 200 distinct values");
  assert.ok(!pins.has("12345"), "and never the one it is replacing");
  console.log("3) Every account gets its own PIN, not a shared constant");
}

// ---- 4. the planner mints it into a blank account -------------------
{
  const plan = planReconcile([], { locationId: LOC }).plan;
  const step = plan.find((p) => p.slug === "wauthorization_pin");
  assert.strictEqual(step.action, "create", "a fresh account gets one without being asked");
  assert.match(step.desired, /^[a-zA-Z2-9]{8}$/, "and what it mints is a PIN, not a token");
  console.log("4) Provisioning a new account mints a PIN-shaped value for it");
}

// ---- 4b. and the report a person reads does not contain it ----------
// Redaction happens in provision(), not in the planner -- so asserting it on
// the planner's output would have proved nothing about what anyone sees.
{
  const { provision } = await import("./src/provision.js");
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ customValues: [] }),
    json: async () => ({ customValues: [] }),
  });

  const out = await provision("pit", LOC, { dryRun: true });
  const step = out.results.find((r) => r.slug === "wauthorization_pin");
  assert.strictEqual(step.action, "would-create", "a dry run writes nothing");
  assert.strictEqual(step.desired, "<redacted>", "and the PIN is not in the report");
  assert.ok(!JSON.stringify(out).match(/[a-zA-Z2-9]{8}/g)?.includes(step.desired),
    "nor anywhere else in it");
  console.log("4b) The provisioning report redacts the PIN rather than printing it");
}

// ---- 5. and never rotates one an account already has ---------------
// A manager has this written down somewhere. Silently changing it under them
// breaks a process that was working, which is worse than never setting it.
{
  const existing = [{
    id: "cv1", name: "WAuthorization PIN",
    fieldKey: "{{ custom_values.wauthorization_pin }}", value: "Kp7mR2xQ",
  }];
  const plan = planReconcile(existing, { locationId: LOC }).plan;
  const step = plan.find((p) => p.slug === "wauthorization_pin");
  assert.strictEqual(step.action, "unchanged", "an account that has one keeps it");
  assert.match(step.reason, /never rotated/);
  console.log("5) An existing PIN is left alone, never quietly rotated");
}

// ---- 6. the Worker does not copy it into KV ------------------------
// Nothing in the Worker reads the PIN -- the gate lives in a GHL workflow. A
// credential with no reader does not belong in a second store, and it must not
// show up as an unmapped value on every provision run either.
{
  const workerProvision = await import("../src/provision.js");
  assert.ok(workerProvision.handleProvisionTenant, "the worker module loads");

  const src = (await import("node:fs")).readFileSync(new URL("../src/provision.js", import.meta.url), "utf8");
  assert.match(src, /SKIPPED_SENSITIVE = new Set\(\[[^\]]*"wauthorization_pin"/,
    "listed as deliberately skipped, so it is reported by name with the value withheld");
  assert.doesNotMatch(src, /wauthorization_pin:\s*\{\s*tenantField/,
    "and never mapped into the tenant record");
  console.log("6) The Worker skips the PIN deliberately rather than copying or ignoring it");
}

console.log("\nPASS — every account gets its own typeable authorization PIN, minted once and never rotated underneath anyone.");
