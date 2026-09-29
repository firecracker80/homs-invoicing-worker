// OTA Channels are hidden unless a client asks for them.
// Run: node test-ota-visibility.mjs
//
// Yari, 2026-09-29: "i don't want to completely remove it, but just not display
// it anywhere, until they ask for it." The object and its records stay exactly
// where they are -- each listing holds the iCal links for the platforms it is
// on, and deleting that would cost real configuration -- so this is a display
// decision, not a data one.
//
// The flag is what the front end reads to hide the tab, the panel, the overview
// count, the disconnected-channel alert, the reports section and the search
// group. Those are template conditionals in a browser script and are not
// reachable from here; this covers the decision they all read.
import assert from "node:assert";

const CLIENT = "ZghxU8I60bEm39JUbtCm";

const tenants = new Map();
const env = {
  DASHBOARD_TENANTS: {
    async get(k, o) { const v = tenants.get(k); return v == null ? null : (o?.type === "json" ? JSON.parse(v) : v); },
    async put(k, v) { tenants.set(k, v); },
  },
  PIT_DEMO: "pit-token",
  // The data route is behind requireAdmin; a bearer stands in for the session
  // cookie a browser would carry.
  ADMIN_KEY: "admin-key",
};

// Every GHL read the data route makes, answered empty. What is being tested is
// the flag on the response, not the records under it.
global.fetch = async () => ({
  ok: true, status: 200,
  json: async () => ({ records: [], contacts: [], customValues: [] }),
  text: async () => JSON.stringify({ records: [], contacts: [], customValues: [] }),
});

const worker = (await import("./src/index.js")).default;

const dataFor = async (tenant) => {
  tenants.set(CLIENT, JSON.stringify({ label: "DEMO", ghlPitSecretName: "PIT_DEMO", ...tenant }));
  const res = await worker.fetch(
    new Request(`https://d.dev/api/data?locationId=${CLIENT}`, {
      headers: { Authorization: "Bearer admin-key" },
    }),
    env
  );
  return { status: res.status, body: await res.json() };
};

// ---- 1. off unless asked for --------------------------------------
{
  const out = await dataFor({});
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));
  assert.strictEqual(out.body.showOtaChannels, false,
    "nobody has asked, so nobody sees it");
  console.log("1) An account that has not asked for OTA Channels does not get them");
}

// ---- 2. one field turns it back on --------------------------------
// No deploy: the front end reads the flag off the payload, so a client who
// asks is served by editing their registry entry.
{
  const out = await dataFor({ showOtaChannels: true });
  assert.strictEqual(out.body.showOtaChannels, true);
  console.log("2) A client who asks gets it back with one field in KV");
}

// ---- 3. only true is true -----------------------------------------
// A registry entry is hand-edited JSON. "true", 1 and "yes" are the shapes a
// person reaches for, and each would quietly show a tab nobody asked for if
// this were loosely compared.
{
  for (const v of ["true", 1, "yes", {}, [], "1"]) {
    const out = await dataFor({ showOtaChannels: v });
    assert.strictEqual(out.body.showOtaChannels, false,
      `${JSON.stringify(v)} is not the boolean true and must not show the tab`);
  }
  assert.strictEqual((await dataFor({ showOtaChannels: false })).body.showOtaChannels, false);
  console.log("3) Only a real boolean true shows it, so a mistyped registry entry stays hidden");
}

// ---- 4. the records are still fetched and still served ------------
// Hidden, not removed. The transaction joins read OTA names for their property
// and commission columns, and a client turning the flag on must find their
// channels still there rather than having to re-enter them.
{
  const out = await dataFor({});
  assert.ok("otaChannels" in out.body,
    "the payload still carries them, because this is a display decision and not a data one");
  assert.ok(Array.isArray(out.body.otaChannels));
  console.log("4) The channels are still fetched and still on the payload, just not shown");
}

console.log("\nPASS — OTA Channels are hidden until a client asks, and nothing about them is deleted.");
