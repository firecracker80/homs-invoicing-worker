// The manager statement shows what the manager earned, from the one place that knows.
// Run: node test-manager-statement.mjs
//
// Yari, 2026-09-30: "what we have is great but they already have that in the
// transactions tab under payments." The payments tab lists what GUESTS paid.
// What the MANAGER earned is a different number and appeared nowhere.
//
// It cannot be computed here. This Worker's transactions object carries
// booking_total, platform_fee and net_payout -- no cleaning fee, no commission
// split -- so the manager's economics only exist in the invoicing Worker's
// ledger. This proxies rather than recomputing, so there is one definition of
// the manager's money instead of two that drift apart.
import assert from "node:assert";

const CLIENT = "ZghxU8I60bEm39JUbtCm";
const tenants = new Map([[CLIENT, JSON.stringify({ label: "DEMO", ghlPitSecretName: "PIT_DEMO" })]]);

const baseEnv = {
  DASHBOARD_TENANTS: {
    async get(k, o) { const v = tenants.get(k); return v == null ? null : (o?.type === "json" ? JSON.parse(v) : v); },
    async put(k, v) { tenants.set(k, v); },
  },
  PIT_DEMO: "pit-token",
  ADMIN_KEY: "admin-key",
  INVOICING_WORKER_URL: "https://worker.example.dev",
  INVOICING_ADMIN_SECRET: "worker-admin-secret",
};

const PL = {
  currency: "USD", income: 1380.17, expenses: 100, net: 1280.17, reimbursableOutstanding: 215,
  byCategory: [{ category: "pest_control", label: "Pest Control", total: 35, count: 1 }],
  excluded: [], undated: [], mixedIncomeCurrency: false, incomeByCurrency: [],
  cleaning: { collected: 475, paidToCleaners: 100, margin: 375, jobsCounted: 2, byTurnover: [], jobsWithoutCost: [], unpaidCleaners: 0, unpaidCleanerJobs: 0 },
};

let seen = [];
const serveWorker = (status, body) => {
  seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: init?.headers || {} });
    return { ok: status < 400, status, text: async () => JSON.stringify(body) };
  };
};

const worker = (await import("./src/index.js")).default;
const call = async (qs, env = baseEnv, headers = { Authorization: "Bearer admin-key" }) => {
  const res = await worker.fetch(new Request(`https://d.dev/api/manager-pl?${qs}`, { headers }), env);
  return { status: res.status, body: await res.json() };
};

// ---- 1. it asks the Worker, and passes the figures straight back -----
{
  serveWorker(200, PL);
  const out = await call(`locationId=${CLIENT}`);
  assert.strictEqual(out.status, 200);
  assert.strictEqual(out.body.net, 1280.17, "the Worker's own number, unaltered");
  assert.strictEqual(out.body.cleaning.margin, 375);

  assert.strictEqual(seen.length, 1, "one call, to the invoicing Worker");
  assert.ok(seen[0].url.startsWith("https://worker.example.dev/reports/manager-pl"), seen[0].url);
  assert.ok(seen[0].url.includes("format=json"));
  assert.ok(seen[0].url.includes(`locationId=${CLIENT}`));
  console.log("1) The manager statement comes from the invoicing Worker, not recomputed here");
}

// ---- 2. authenticated with the secret the dashboard already holds ----
// Deliberately NOT a per-tenant report token: copying those into this Worker's
// KV would mean two stores to keep in step, and a stale one shows a client an
// Unauthorized page.
{
  serveWorker(200, PL);
  await call(`locationId=${CLIENT}`);
  assert.strictEqual(seen[0].headers["X-Admin-Secret"], "worker-admin-secret");
  assert.ok(!seen[0].url.includes("token="), "no per-tenant report token is involved");
  console.log("2) Authenticated with the admin secret already held for provisioning");
}

// ---- 3. the period is the caller's, not a default ------------------
{
  serveWorker(200, PL);
  await call(`locationId=${CLIENT}&from=2026-09-01&to=2026-09-30&recipientName=Rosa%20Jim%C3%A9nez`);
  const u = new URL(seen[0].url);
  assert.strictEqual(u.searchParams.get("from"), "2026-09-01");
  assert.strictEqual(u.searchParams.get("to"), "2026-09-30");
  assert.strictEqual(u.searchParams.get("recipientName"), "Rosa Jiménez",
    "so an account with two managers can scope to one");
  console.log("3) Period and manager name are forwarded, so a two-manager account can be scoped");
}

// ---- 4. it is behind the dashboard's own gate ----------------------
// The proxy carries a secret that can read any tenant's money. Without this it
// would hand that to anyone who knew a locationId, and locationIds are not
// secret -- they are in every webhook URL.
{
  serveWorker(200, PL);
  const out = await call(`locationId=${CLIENT}`, baseEnv, {});
  assert.strictEqual(out.status, 401, "no dashboard session, no statement");
  assert.strictEqual(seen.length, 0, "and the Worker is never called");
  console.log("4) Gated by the dashboard session, so the admin secret is never lent out");
}

// ---- 5. a missing locationId is refused before anything is called ---
{
  serveWorker(200, PL);
  const out = await call("");
  assert.strictEqual(out.status, 400);
  assert.strictEqual(seen.length, 0);
  console.log("5) A request with no locationId is refused without calling the Worker");
}

// ---- 6. the Worker's own failure is passed through, not reskinned ---
// A 404 for an unknown tenant and a 500 for a missing PIT each say more than
// anything this route could invent on their behalf.
{
  serveWorker(404, { error: "Unknown locationId: XYZ" });
  const out = await call(`locationId=${CLIENT}`);
  assert.strictEqual(out.status, 404, "the Worker's status survives");
  assert.match(out.body.error, /Unknown locationId/);
  console.log("6) The invoicing Worker's own status and error reach the reader intact");
}

// ---- 7. an unconfigured dashboard says so, rather than 500ing -------
{
  const out = await call(`locationId=${CLIENT}`, { ...baseEnv, INVOICING_WORKER_URL: undefined });
  assert.strictEqual(out.status, 503);
  assert.match(out.body.detail, /INVOICING_WORKER_URL/, "and names the setting that is missing");
  console.log("7) A dashboard missing the Worker URL explains itself instead of failing obscurely");
}

// ---- 8. the Worker being unreachable is not a blank page -----------
{
  seen = [];
  globalThis.fetch = async () => { throw new Error("connect ECONNREFUSED"); };
  const out = await call(`locationId=${CLIENT}`);
  assert.strictEqual(out.status, 502);
  assert.match(out.body.error, /Could not reach/);
  console.log("8) An unreachable invoicing Worker reports a reachability problem, not an empty statement");
}

// ---- 9. an upstream 401 is never handed to the page as a 401 -------
// Yari, 2026-10-01: "when i enter the admin key it says i am unauthorized but
// everything else opens."
//
// apiFetch() in the page treats ANY 401 as "this person's session expired" and
// opens the admin key prompt. Passing the invoicing Worker's 401 straight
// through therefore asks the reader to re-enter a key that cannot help, and
// tells them they are unauthorized when their session was never in question.
// What actually failed is this Worker's credential against that one, which is
// configuration and nothing the reader holds.
{
  for (const upstream of [401, 403]) {
    serveWorker(upstream, { error: "Unauthorized" });
    const out = await call(`locationId=${CLIENT}`);
    assert.notStrictEqual(out.status, 401,
      `an upstream ${upstream} must not reach the page as a 401, or it re-prompts for a key that cannot help`);
    assert.strictEqual(out.status, 502, "it is an upstream problem, and says so");
    assert.match(out.body.detail, /not your login/i, "and tells the reader their session is fine");
    assert.match(out.body.detail, /INVOICING_ADMIN_SECRET/, "and names the setting that actually has to change");
  }
  console.log("9) An upstream 401 becomes a 502 that names the real problem, instead of re-prompting for a key");
}

console.log("\nPASS — one definition of the manager's money, fetched under the dashboard's own gate.");
