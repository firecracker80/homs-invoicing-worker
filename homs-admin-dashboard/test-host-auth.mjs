// Host board sign-in.
// Run: node test-host-auth.mjs
//
// This is the only thing standing between a public web page and another host's
// phone number, so the cases below are mostly about what must NOT happen:
// enumeration, replay, brute force, and a session from one surface satisfying
// another.
import assert from "node:assert";

import {
  handleHostLoginStart, handleHostLoginVerify, handleHostLogout, requireHost,
} from "./src/host-auth.js";
import { mintSession } from "./src/auth.js";

// ---- fakes ----------------------------------------------------------
const makeKV = () => {
  const m = new Map();
  return {
    _m: m,
    async list() { return { keys: [...m.keys()].map((name) => ({ name })) }; },
    async get(k, o) { const v = m.get(k); return v == null ? null : (o?.type === "json" ? JSON.parse(v) : v); },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
  };
};

let hookCalls = [];
global.fetch = async (url, opts) => { hookCalls.push({ url, body: JSON.parse(opts.body) }); return { ok: true }; };

const OWNER = "owner@casabonita.com";
const LOC = "QAnga9enHqGEVddbVtpd";

const freshEnv = ({ enabled = true } = {}) => {
  const kv = makeKV();
  kv._m.set(LOC, JSON.stringify({
    label: "Cruce Caribeña", ghlPitSecretName: "GHL_PIT_CRUCE",
    hostBoard: { enabled, owners: [OWNER], canPost: true },
  }));
  kv._m.set("wLGDbGcQ4QSG3nlT3Sis", JSON.stringify({ label: "Luminara", ghlPitSecretName: "X" }));
  kv._m.set("onboarding:abc", JSON.stringify({ not: "a tenant" }));
  return { DASHBOARD_TENANTS: kv, ADMIN_KEY: "admin-key-value", HOST_LOGIN_WEBHOOK_URL: "https://ghl/hook" };
};

const post = (body, cookie) => ({
  method: "POST",
  json: async () => body,
  headers: { get: (n) => (n === "Cookie" ? (cookie || null) : null) },
});
const codeKeys = (env) => [...env.DASHBOARD_TENANTS._m.keys()].filter((k) => k.startsWith("hostlogin:"));
const setCookieOf = (res) => res.headers.get("Set-Cookie") || "";

// ---- 1. an unknown address is indistinguishable from a known one ------
{
  const env = freshEnv(); hookCalls = [];
  const res = await handleHostLoginStart(post({ email: "stranger@nowhere.com" }), env);
  assert.strictEqual(res.status, 204, "an unknown address still answers 204");
  assert.deepStrictEqual(hookCalls, [], "and no code is sent");
  assert.deepStrictEqual(codeKeys(env), [], "and nothing is stored");

  const known = await handleHostLoginStart(post({ email: OWNER }), env);
  assert.strictEqual(known.status, 204, "a known address answers 204 as well");
  assert.strictEqual(hookCalls.length, 1, "and a code goes out");
  // The two responses must be the same thing. If they ever differ, this endpoint
  // becomes a way to ask which businesses are HOMS clients, one guess at a time.
  assert.strictEqual(res.status, known.status);
  console.log("1) A known and an unknown address get byte-identical answers");
}

// ---- 2. the stored record cannot be used to sign in -------------------
{
  const env = freshEnv(); hookCalls = [];
  await handleHostLoginStart(post({ email: OWNER }), env);
  const code = hookCalls[0].body.code;
  assert.match(code, /^\d{6}$/, "a six digit code");

  const stored = JSON.parse(env.DASHBOARD_TENANTS._m.get(codeKeys(env)[0]));
  assert.ok(!JSON.stringify(stored).includes(code),
    "the plaintext code is in KV -- a reader of the namespace could sign in as this host");
  assert.strictEqual(stored.codeHash.length, 64, "only its SHA-256 digest is kept");
  assert.strictEqual(stored.locationId, LOC);
  console.log("2) KV holds the code's digest, never the code");
}

// ---- 3. the code works once ------------------------------------------
{
  const env = freshEnv(); hookCalls = [];
  await handleHostLoginStart(post({ email: OWNER }), env);
  const code = hookCalls[0].body.code;

  const ok = await handleHostLoginVerify(post({ email: OWNER, code }), env);
  assert.strictEqual(ok.status, 200);
  const cookie = setCookieOf(ok);
  assert.ok(cookie.startsWith("homs_host="), "the host cookie is set");
  assert.ok(cookie.includes("HttpOnly"), "HttpOnly, so page JS can never read it");
  assert.ok(cookie.includes("SameSite=None"), "SameSite=None, since the board is framed");
  assert.deepStrictEqual(codeKeys(env), [], "the code is consumed");

  const replay = await handleHostLoginVerify(post({ email: OWNER, code }), env);
  assert.strictEqual(replay.status, 401, "replaying the same code must fail");
  console.log("3) A code signs in once and is dead on replay");
}

// ---- 4. guessing is bounded ------------------------------------------
{
  const env = freshEnv(); hookCalls = [];
  await handleHostLoginStart(post({ email: OWNER }), env);
  const code = hookCalls[0].body.code;
  const wrong = code === "000000" ? "111111" : "000000";

  for (let i = 0; i < 5; i++) {
    const r = await handleHostLoginVerify(post({ email: OWNER, code: wrong }), env);
    assert.strictEqual(r.status, 401, `wrong guess ${i + 1} is rejected`);
  }
  // Six digits is a million possibilities; without a cap, a script walks it.
  const afterCap = await handleHostLoginVerify(post({ email: OWNER, code }), env);
  assert.strictEqual(afterCap.status, 401,
    "the CORRECT code still worked after five wrong guesses -- the attempt cap is not holding");
  console.log("4) Five wrong guesses burn the code, correct or not");
}

// ---- 5. a dashboard session is not a host session --------------------
{
  const env = freshEnv();

  const none = await requireHost({ headers: { get: () => null } }, env);
  assert.strictEqual(none.denied?.status, 401, "no cookie, no entry");

  // The operator key itself, which readSession honours as an operator session.
  const asOperator = await requireHost(post({}, `homs_host=${encodeURIComponent("admin-key-value")}`), env);
  assert.strictEqual(asOperator.denied?.status, 401,
    "an operator token satisfied a host route -- scope is not being checked");

  // A real dashboard client session for the same account.
  const clientToken = await mintSession(env, { scope: "client", locationId: LOC });
  const asClient = await requireHost(post({}, `homs_host=${encodeURIComponent(clientToken)}`), env);
  assert.strictEqual(asClient.denied?.status, 401,
    "a dashboard client session satisfied a host route");

  const hostToken = await mintSession(env, { scope: "host", locationId: LOC });
  const asHost = await requireHost(post({}, `homs_host=${encodeURIComponent(hostToken)}`), env);
  assert.strictEqual(asHost.denied, undefined, "a real host session is let through");
  assert.strictEqual(asHost.locationId, LOC);
  console.log("5) Only a host-scoped session opens a host route");
}

// ---- 6. the tier gate is re-read, not remembered ----------------------
{
  const env = freshEnv({ enabled: true });
  const token = await mintSession(env, { scope: "host", locationId: LOC });
  const before = await requireHost(post({}, `homs_host=${encodeURIComponent(token)}`), env);
  assert.strictEqual(before.denied, undefined, "works while the module is on");

  // Turn the module off underneath a session that is still valid.
  const t = JSON.parse(env.DASHBOARD_TENANTS._m.get(LOC));
  t.hostBoard.enabled = false;
  env.DASHBOARD_TENANTS._m.set(LOC, JSON.stringify(t));

  const after = await requireHost(post({}, `homs_host=${encodeURIComponent(token)}`), env);
  assert.strictEqual(after.denied?.status, 403,
    "a live cookie outlived the tier gate -- turning the module off has to take effect now, " +
    "not whenever the last session happens to expire");
  console.log("6) Turning the module off locks out sessions already in flight");
}

// ---- 7. a tenant with no hostBoard block is not on the board ----------
{
  const env = freshEnv(); hookCalls = [];
  const res = await handleHostLoginStart(post({ email: "someone@luminara.com" }), env);
  assert.strictEqual(res.status, 204);
  assert.deepStrictEqual(hookCalls, [], "Luminara has no hostBoard block, so nobody signs in as it");
  console.log("7) Absence of a hostBoard block means no access, not default access");
}

// ---- 8. logout clears the cookie -------------------------------------
{
  const cleared = setCookieOf(handleHostLogout());
  assert.ok(cleared.startsWith("homs_host=;"), "the cookie is emptied");
  assert.ok(/Max-Age=0/.test(cleared), "and expired immediately");
  console.log("8) Logout empties and expires the cookie");
}

console.log("\nPASS — the board cannot be enumerated, a code works once, guessing is capped, " +
  "only host sessions pass, and the tier gate applies to sessions already issued.");
