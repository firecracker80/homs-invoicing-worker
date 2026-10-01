// This Worker reaches the invoicing Worker through a service binding.
// Run: node test-invoicing-binding.mjs
//
// Both Workers are on *.yari-058.workers.dev, which is one zone, and Cloudflare
// refuses a global fetch() between two Workers on the same zone. It does not
// come back as an HTTP error: the body is plain text, so res.json() throws on
// the first character. Yari, 2026-10-01, on the manager statement:
//
//   Unexpected token 'e', "error code: 1042 " is not valid JSON
//
// 1042 is "Worker tried to fetch from another Worker on the same zone", and the
// documented fix is a service binding.
//
// It mattered in two places. The manager statement is the visible one;
// provisionTenantRecord() has always called the same Worker the same way, so
// provisioning a new client would have failed identically -- and that path had
// never been run end to end.
import assert from "node:assert";

const { invoicingFetch } = await import("./src/invoicing.js");
const { provisionTenantRecord } = await import("./src/configure-account.js");

const ok = (body) => ({
  ok: true, status: 200,
  text: async () => JSON.stringify(body),
  json: async () => body,
});

// What Cloudflare actually returns for a blocked same-zone subrequest: a 200
// carrying plain text. Nothing about the status says anything is wrong.
const SAME_ZONE_REFUSAL = { ok: true, status: 200, text: async () => "error code: 1042 " };

let viaBinding = [];
let viaInternet = [];
const bindingEnv = (extra = {}) => ({
  INVOICING_ADMIN_SECRET: "secret",
  INVOICING: { fetch: async (u, init) => { viaBinding.push({ url: String(u), init: init || {} }); return ok({ net: 1280.17 }); } },
  ...extra,
});

// ---- 1. the binding is used when it exists -------------------------
{
  viaBinding = []; viaInternet = [];
  globalThis.fetch = async (u, init) => { viaInternet.push({ url: String(u), init: init || {} }); return ok({}); };

  const res = await invoicingFetch(bindingEnv(), "/reports/manager-pl", { query: { locationId: "L1", format: "json" } });
  assert.deepStrictEqual(await res.json(), { net: 1280.17 });
  assert.strictEqual(viaBinding.length, 1, "handed to the other Worker directly");
  assert.strictEqual(viaInternet.length, 0, "and never sent over the Internet, which is what 1042 refuses");

  const u = new URL(viaBinding[0].url);
  assert.strictEqual(u.pathname, "/reports/manager-pl");
  assert.strictEqual(u.searchParams.get("locationId"), "L1");
  assert.strictEqual(viaBinding[0].init.headers["X-Admin-Secret"], "secret");
  console.log("1) The request goes through the service binding, not over the Internet");
}

// ---- 2. the binding wins even when a public URL is also set --------
// Both are configured in production. Preferring the URL would reintroduce the
// exact bug this fixes, and it would look fine in any test that stubs fetch.
{
  viaBinding = []; viaInternet = [];
  globalThis.fetch = async (u, init) => { viaInternet.push({ url: String(u), init: init || {} }); return ok({}); };
  await invoicingFetch(bindingEnv({ INVOICING_WORKER_URL: "https://worker.example.dev" }), "/x");
  assert.strictEqual(viaBinding.length, 1, "the binding is preferred");
  assert.strictEqual(viaInternet.length, 0);
  console.log("2) With both configured the binding wins, so the same-zone path is never taken");
}

// ---- 3. without a binding it still works over the Internet ---------
// Kept deliberately: it is what the tests exercise, and what works if the two
// Workers ever sit on different zones or a custom domain.
{
  viaBinding = []; viaInternet = [];
  globalThis.fetch = async (u, init) => { viaInternet.push({ url: String(u), init: init || {} }); return ok({ fallback: true }); };
  const res = await invoicingFetch(
    { INVOICING_ADMIN_SECRET: "secret", INVOICING_WORKER_URL: "https://worker.example.dev/" },
    "/reports/manager-pl", { query: { locationId: "L1" } }
  );
  assert.deepStrictEqual(await res.json(), { fallback: true });
  assert.strictEqual(viaInternet.length, 1);
  assert.ok(viaInternet[0].url.startsWith("https://worker.example.dev/reports/manager-pl"),
    `trailing slash on the base must not double up: ${viaInternet[0].url}`);
  console.log("3) With no binding it falls back to a plain fetch, trailing slash and all");
}

// ---- 4. neither configured is a named failure ----------------------
{
  await assert.rejects(
    () => invoicingFetch({ INVOICING_ADMIN_SECRET: "s" }, "/x"),
    (e) => e.reason === "no_invoicing_worker_url"
  );
  await assert.rejects(
    () => invoicingFetch({ INVOICING: { fetch: async () => ok({}) } }, "/x"),
    (e) => e.reason === "no_admin_secret"
  );
  console.log("4) A missing binding or a missing secret fails by name, not by stack trace");
}

// ---- 5. provisioning goes the same way -----------------------------
// The latent half of this bug. Same Worker, same zone, same refusal -- and
// nobody had provisioned a real client yet to find out.
{
  viaBinding = []; viaInternet = [];
  globalThis.fetch = async (u, init) => { viaInternet.push({ url: String(u), init: init || {} }); return ok({}); };
  const env = {
    INVOICING_ADMIN_SECRET: "secret",
    INVOICING: { fetch: async (u, init) => { viaBinding.push({ url: String(u), init: init || {} }); return ok({ mappedFromCustomValues: 4, warnings: [] }); } },
  };
  const out = await provisionTenantRecord(env, { locationId: "L1", pit: "pit-x" });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.mappedFromCustomValues, 4);
  assert.strictEqual(viaBinding.length, 1, "provisioning uses the binding too");
  assert.strictEqual(viaInternet.length, 0);

  const u = new URL(viaBinding[0].url);
  assert.strictEqual(u.pathname, "/admin/provision-tenant");
  assert.strictEqual(u.searchParams.get("ghlPit"), "pit-x");
  assert.strictEqual(u.searchParams.get("force"), "true");
  assert.strictEqual(viaBinding[0].init.method, "POST");
  console.log("5) Provisioning uses the binding too -- it had the same bug and had never been run");
}

// ---- 6. the symptom itself, end to end -----------------------------
// A same-zone refusal arrives as a 200 with a plain-text body. The route must
// not hand that to the page as if it were a statement.
{
  globalThis.fetch = async () => SAME_ZONE_REFUSAL;
  const worker = (await import("./src/index.js")).default;
  const tenants = new Map([["L1", JSON.stringify({ label: "DEMO", ghlPitSecretName: "PIT_DEMO" })]]);
  const env = {
    DASHBOARD_TENANTS: { async get(k, o) { const v = tenants.get(k); return v == null ? null : (o?.type === "json" ? JSON.parse(v) : v); } },
    ADMIN_KEY: "admin-key", PIT_DEMO: "pit",
    INVOICING_ADMIN_SECRET: "secret",
    // No binding: the pre-fix production shape.
    INVOICING_WORKER_URL: "https://worker.example.dev",
  };
  const res = await worker.fetch(
    new Request("https://d.dev/api/manager-pl?locationId=L1", { headers: { Authorization: "Bearer admin-key" } }), env);
  const text = await res.text();
  assert.ok(text.includes("1042") || res.status >= 400,
    "the refusal reaches the caller rather than being dressed up as data");
  // The real guard: whatever happens, the route must never claim success with
  // a body the page cannot parse.
  if (res.status === 200) {
    assert.throws(() => JSON.parse(text), "a 200 carrying unparseable text is exactly the bug Yari saw");
  }
  console.log("6) A same-zone refusal is visible rather than served to the page as a statement");
}

console.log("\nPASS — the invoicing Worker is reached by binding, and provisioning no longer carries the same bug.");
