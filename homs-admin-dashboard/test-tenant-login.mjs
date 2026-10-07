// A login reaches one account, and the operator's reaches all of them.
// Run: node test-tenant-login.mjs
//
// Phase 1 of CLIENT-MOBILE-APP-SCOPE.md, and a security fix in its own right.
//
// Before this, the dashboard had ONE password for every client. handleLogin
// compared against a single ADMIN_KEY and set a cookie carrying it; nothing
// afterwards checked which tenant the caller could see, so `?locationId=` chose
// the account and any authenticated caller could pass any id. Survivable while
// one person held the key. Fatal the moment a client is given access -- their
// key would have been the key to every other client's revenue.
import assert from "node:assert";

const { mintSession, readSession } = await import("./src/auth.js");

const MINE = "ZghxU8I60bEm39JUbtCm";
const THEIRS = "wLGDbGcQ4QSG3nlT3Sis";
const ADMIN_KEY = "operator-key";

const tenants = {
  [MINE]: { label: "DEMO", kind: "client", clientKey: "demo-client-key", ghlPitSecretName: "PIT" },
  [THEIRS]: { label: "Luminara", kind: "client", clientKey: "luminara-client-key", ghlPitSecretName: "PIT" },
  "no-key": { label: "Unprotected", kind: "client", ghlPitSecretName: "PIT" },
};

const env = {
  ADMIN_KEY,
  PIT: "pit-token",
  DASHBOARD_TENANTS: {
    get: async (k, o) => {
      const v = tenants[k];
      if (!v) return null;
      return o?.type === "json" ? v : JSON.stringify(v);
    },
  },
};

const worker = (await import("./src/index.js")).default;

const login = async (body) => {
  const res = await worker.fetch(new Request("https://d.dev/api/login", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), env);
  const cookie = res.headers.get("Set-Cookie") || "";
  const token = decodeURIComponent((cookie.match(/homs_admin=([^;]*)/) || [])[1] || "");
  return { status: res.status, token, body: await res.json().catch(() => null) };
};

// Any gated route will do; /api/data is the one every client opens.
const callAs = async (token, locationId) => {
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ records: [] }) });
  const res = await worker.fetch(new Request(
    `https://d.dev/api/data${locationId ? `?locationId=${locationId}` : ""}`,
    { headers: token ? { Cookie: `homs_admin=${encodeURIComponent(token)}` } : {} }), env);
  return res.status;
};

// ---- 1. the operator keeps the reach they had ------------------------
// This whole change is a narrowing, and it must not narrow Yari.
{
  const out = await login({ key: ADMIN_KEY });
  assert.strictEqual(out.status, 200);
  assert.notStrictEqual(await callAs(out.token, MINE), 401);
  assert.notStrictEqual(await callAs(out.token, THEIRS), 401);
  assert.notStrictEqual(await callAs(out.token, THEIRS), 403, "every account, as before");

  // And without a locationId at all, which a client session cannot do.
  assert.notStrictEqual(await callAs(out.token, null), 401);

  // The operator's cookie is a session too. Keeping the key in it would still
  // WORK -- readSession honours a raw ADMIN_KEY so this deploy locks nobody out
  // -- which is exactly why it needs asserting: the one path where the old
  // behaviour is indistinguishable from the new one by outcome alone.
  assert.notStrictEqual(out.token, ADMIN_KEY, "the operator's cookie is not their password");
  assert.ok(out.token.startsWith("operator."), "it is a signed session like any other");
  console.log("1) The operator's key still opens every account, and their cookie is a session not a password");
}

// ---- 2. a client key opens its own account --------------------------
{
  const out = await login({ key: "demo-client-key", locationId: MINE });
  assert.strictEqual(out.status, 200);
  assert.notStrictEqual(await callAs(out.token, MINE), 403);

  // The cookie is a session, not the password. Before this it carried the key
  // itself, which is survivable for one operator and unthinkable for a client.
  assert.ok(!out.token.includes("demo-client-key"), "the cookie does not contain the key");
  assert.ok(!out.token.includes(ADMIN_KEY), "and certainly not the operator's");
  const session = await readSession(env, out.token);
  assert.deepStrictEqual(session, { scope: "client", locationId: MINE });
  console.log("2) A client key opens its own account, and the cookie carries a session rather than the key");
}

// ---- 3. and reaches no other ----------------------------------------
// The whole point. Before this, any authenticated caller could pass any id.
{
  const { token } = await login({ key: "demo-client-key", locationId: MINE });
  assert.strictEqual(await callAs(token, THEIRS), 403,
    "a client cannot read another client's account by changing the URL");

  // 403 rather than 404: pretending the account does not exist would send a
  // confused client chasing a bug that is not there.
  assert.strictEqual(await callAs(token, null), 401, "and cannot omit the id to dodge the check");
  console.log("3) A client session is refused on every account but its own");
}

// ---- 4. a POST is checked too ---------------------------------------
// The id travels in the body on a write, and a check that only reads the query
// string would wave every write through.
{
  const { token } = await login({ key: "demo-client-key", locationId: MINE });
  const post = async (locationId) => (await worker.fetch(new Request("https://d.dev/api/expenses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `homs_admin=${encodeURIComponent(token)}` },
    body: JSON.stringify({ locationId, name: "x", categoryKey: "other", amount: 1, paidBy: "owner" }),
  }), env)).status;

  assert.strictEqual(await post(THEIRS), 403, "writing into another account is refused");
  assert.notStrictEqual(await post(MINE), 403, "and into its own is not");
  console.log("4) A write is scoped by the locationId in its body, not just the query string");
}

// ---- 5. every failure looks the same ---------------------------------
// A wrong key, an unknown account, and an account with no client key set must be
// indistinguishable, or the login form becomes a way to enumerate which accounts
// exist and which are unprotected.
{
  const attempts = [
    ["wrong key", { key: "guessing", locationId: MINE }],
    ["right key, wrong account", { key: "demo-client-key", locationId: THEIRS }],
    ["unknown account", { key: "demo-client-key", locationId: "does-not-exist" }],
    ["account with no client key", { key: "anything", locationId: "no-key" }],
    ["no account given", { key: "demo-client-key" }],
  ];
  const seen = new Set();
  for (const [what, body] of attempts) {
    const out = await login(body);
    assert.strictEqual(out.status, 401, what);
    assert.strictEqual(out.token, "", `${what} sets no cookie`);
    seen.add(out.body?.error);
  }
  assert.strictEqual(seen.size, 1, `every failure reads the same: ${[...seen].join(" / ")}`);
  console.log("5) Every way to fail a login is one status and one message, so none of them enumerate accounts");
}

// ---- 6. a token nobody signed is not a session -----------------------
{
  const { token } = await login({ key: "demo-client-key", locationId: MINE });
  const [scope, loc, exp, sig] = token.split(".");

  // The attack this exists to stop: edit the account out of your own session.
  assert.strictEqual(await readSession(env, `${scope}.${THEIRS}.${exp}.${sig}`), null,
    "the account cannot be swapped");
  assert.strictEqual(await readSession(env, `operator.${loc}.${exp}.${sig}`), null,
    "nor the scope raised to operator");
  assert.strictEqual(await readSession(env, `${scope}.${loc}.${Number(exp) + 99999}.${sig}`), null,
    "nor the expiry pushed out");
  assert.strictEqual(await readSession(env, `${scope}.${loc}.${exp}.deadbeef`), null);
  assert.strictEqual(await readSession(env, "garbage"), null);

  // Signed under a different secret, i.e. another deployment's cookie.
  const other = await mintSession({ ...env, SESSION_SECRET: "somewhere-else" }, { scope: "operator" });
  assert.strictEqual(await readSession(env, other), null);
  console.log("6) A session that was edited, forged or signed elsewhere is not a session");
}

// ---- 7. a session stops working on its own ---------------------------
{
  const expired = await mintSession({ ...env, SESSION_SECRET: "s" }, { scope: "client", locationId: MINE });
  const [scope, loc, , sig] = expired.split(".");
  const past = `${scope}.${loc}.${Math.floor(Date.now() / 1000) - 60}`;
  // Re-signed honestly, so only the expiry can be what rejects it.
  const { mintSession: _m } = await import("./src/auth.js");
  const envS = { ...env, SESSION_SECRET: "s" };
  const honest = await (async () => {
    const enc = new TextEncoder();
    const k = await crypto.subtle.importKey("raw", enc.encode("s"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const raw = await crypto.subtle.sign("HMAC", k, enc.encode(past));
    const b64 = btoa(String.fromCharCode(...new Uint8Array(raw))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return `${past}.${b64}`;
  })();
  assert.strictEqual(await readSession(envS, honest), null, "a correctly signed but expired session is refused");
  assert.ok(sig, "and a fresh one is not");
  assert.ok(await readSession(envS, expired));
  console.log("7) A session expires on its own, so a stolen cookie is not forever");
}

// ---- 8. nobody is locked out by this deploy --------------------------
// Existing cookies carry the raw ADMIN_KEY. Honoured as an operator session --
// the same check the old code made, not a weaker one -- so shipping this does
// not sign Yari out mid-task.
{
  assert.deepStrictEqual(await readSession(env, ADMIN_KEY), { scope: "operator", locationId: null });
  assert.notStrictEqual(await callAs(ADMIN_KEY, THEIRS), 403, "a cookie from before this still works");

  // The bearer path is unchanged: curl, and the invoicing Worker's own calls.
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ records: [] }) });
  const viaBearer = await worker.fetch(new Request(`https://d.dev/api/data?locationId=${THEIRS}`,
    { headers: { Authorization: `Bearer ${ADMIN_KEY}` } }), env);
  assert.notStrictEqual(viaBearer.status, 401);
  assert.notStrictEqual(viaBearer.status, 403);
  console.log("8) An old cookie and a bearer token both still work, so this deploy locks nobody out");
}

console.log("\nPASS — a client login reaches exactly one account, the operator's reaches all of them, and the cookie is no longer anybody's password.");
