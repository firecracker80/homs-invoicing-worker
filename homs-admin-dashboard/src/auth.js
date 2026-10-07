// Authentication for the dashboard Worker.
//
// Context: this Worker is embedded inside GHL as a custom menu link, so the page
// loads in a cross-origin iframe with `?locationId={{location.id}}` appended.
// Before this file existed there was NO auth of any kind - `GET /api/data` handed
// a tenant's entire CRM to anyone who supplied a locationId, and locationIds are
// not secret (they appear in every wghl_* webhook URL). `POST /api/expenses` wrote
// records with no credential at all.
//
// Two separate keys, on purpose:
//
//   ADMIN_KEY      - read the dashboard, create expenses. Held by humans.
//   PROVISION_KEY  - reconfigure a sub-account's custom values and mint its
//                    secrets. Machine-only, never typed into a browser.
//
// A leaked ADMIN_KEY should not let anyone reconfigure client accounts, which is
// why provisioning does not accept it.
//
// Secrets are never in KV or the repo:
//   wrangler secret put ADMIN_KEY
//   wrangler secret put PROVISION_KEY

const COOKIE_NAME = "homs_admin";

// How long a client stays logged in. Thirty days, matching what the cookie
// already promised -- the difference is that the token now says so itself, so a
// stolen cookie stops working on its own rather than forever.
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

// Signed with a dedicated secret where one exists, and otherwise derived from
// ADMIN_KEY so this needs no new configuration to work. Deriving has a property
// worth having: rotating ADMIN_KEY invalidates every outstanding session,
// which is exactly what rotating it is for.
const signingKeyFor = (env) => env.SESSION_SECRET || env.ADMIN_KEY;

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function hmac(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

// A session token says who the caller is and when it stops being true, and is
// signed so neither can be edited.
//
// The cookie used to carry the ADMIN_KEY itself. That was survivable while one
// person held it: a client cannot be given a cookie containing the operator's
// password.
export async function mintSession(env, { scope, locationId = null }) {
  const body = `${scope}.${locationId || ""}.${Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS}`;
  return `${body}.${await hmac(signingKeyFor(env), body)}`;
}

export async function readSession(env, token) {
  if (!token) return null;

  // A cookie from before sessions existed carries the raw ADMIN_KEY. Honoured as
  // an operator session so this deploy does not log Yari out mid-session; it is
  // the same check the old code made, not a weaker one.
  if (await secureEquals(token, env.ADMIN_KEY)) return { scope: "operator", locationId: null };

  const parts = String(token).split(".");
  if (parts.length !== 4) return null;
  const [scope, locationId, exp, sig] = parts;
  const body = `${scope}.${locationId}.${exp}`;
  if (!(await secureEquals(sig, await hmac(signingKeyFor(env), body)))) return null;
  if (!Number(exp) || Number(exp) * 1000 < Date.now()) return null;
  return { scope, locationId: locationId || null };
}

// Constant-time comparison. Workers has no crypto.timingSafeEqual, so compare
// SHA-256 digests instead - fixed 32-byte length, which also removes the length
// side channel that a naive string compare leaks.
async function secureEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function bearerFrom(request) {
  const h = request.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function cookieFrom(request) {
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === COOKIE_NAME) return decodeURIComponent(rest.join("="));
  }
  return null;
}

const unauthorized = (msg) =>
  Response.json({ error: msg }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });

// Dashboard-level access: bearer header (machine/curl) or the session cookie set
// by POST /api/login (browser, including inside GHL's iframe).
export async function requireAdmin(request, env) {
  if (!env.ADMIN_KEY) {
    return Response.json(
      { error: "Server misconfigured: ADMIN_KEY secret is not set" },
      { status: 500 }
    );
  }
  const supplied = bearerFrom(request) || cookieFrom(request);
  if (!supplied) return unauthorized("Authentication required");

  // A bearer token is still the operator's key, for curl and for the invoicing
  // Worker. A cookie is now a session, which may be a client's.
  if (await secureEquals(supplied, env.ADMIN_KEY)) return null;

  const session = await readSession(env, supplied);
  if (!session) return unauthorized("Invalid credentials");
  if (session.scope === "operator") return null;

  // A client session reaches exactly one account.
  //
  // Checked HERE, in the one gate every /api/* route passes through, rather than
  // in each route. A route that forgot would be indistinguishable from one that
  // did not need it, and that is precisely how the hole this closes would come
  // back.
  const url = new URL(request.url);
  let wanted = url.searchParams.get("locationId");
  if (!wanted && request.method === "POST") {
    // A POST carries it in the body. The body is read here and handed on, since
    // a Request body can only be consumed once.
    try {
      const clone = request.clone();
      wanted = (await clone.json())?.locationId || null;
    } catch { wanted = null; }
  }
  if (!wanted) return unauthorized("locationId is required");
  if (wanted !== session.locationId) {
    // 403, not 404. Pretending the account does not exist would send a
    // legitimately confused client chasing a bug that is not there, and that
    // another account exists is not a secret worth engineering around.
    return Response.json({ error: "This login does not have access to that account" }, { status: 403 });
  }
  return null;
}

// Provisioning: bearer only, PROVISION_KEY only. Deliberately does not accept the
// cookie or ADMIN_KEY - a browser session must never be able to rewrite a client's
// configuration or rotate its secrets.
export async function requireProvision(request, env) {
  if (!env.PROVISION_KEY) {
    return Response.json(
      { error: "Server misconfigured: PROVISION_KEY secret is not set" },
      { status: 500 }
    );
  }
  const supplied = bearerFrom(request);
  if (!supplied) return unauthorized("Bearer token required");
  if (!(await secureEquals(supplied, env.PROVISION_KEY))) return unauthorized("Invalid credentials");
  return null;
}

// Exchanges the key for an HttpOnly cookie so the UI never holds it in JS.
// SameSite=None + Secure is required because GHL frames this page cross-origin.
export async function handleLogin(request, env) {
  if (!env.ADMIN_KEY) {
    return Response.json({ error: "Server misconfigured: ADMIN_KEY secret is not set" }, { status: 500 });
  }
  let key, locationId;
  try {
    ({ key, locationId } = await request.json());
  } catch {
    return Response.json({ error: "Expected JSON body { key, locationId }" }, { status: 400 });
  }

  // The operator's key still opens everything, with or without a locationId.
  // Yari's reach must not narrow because clients gained one of their own.
  if (await secureEquals(key, env.ADMIN_KEY)) {
    return sessionResponse(await mintSession(env, { scope: "operator" }));
  }

  // Otherwise it is a client key, and a client key is only meaningful against
  // the account it belongs to.
  if (!locationId) return Response.json({ error: "Invalid key" }, { status: 401 });
  const tenant = await env.DASHBOARD_TENANTS.get(locationId, { type: "json" });

  // One failure message and one shape for every way this can fail: a wrong key,
  // an unknown account, an account with no client key set. Distinguishing them
  // tells an attacker which accounts exist and which are unprotected.
  if (!tenant?.clientKey || !(await secureEquals(key, tenant.clientKey))) {
    return Response.json({ error: "Invalid key" }, { status: 401 });
  }
  return sessionResponse(await mintSession(env, { scope: "client", locationId }));
}

const sessionResponse = (token) =>
  new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie":
        `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=${SESSION_TTL_SECONDS}`,
    },
  });

export function handleLogout() {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0`,
    },
  });
}

// Services flow webhooks: SERVICES_WEBHOOK_KEY only, never ADMIN_KEY or the cookie.
// Accepted as a bearer token or in X-Services-Key. The custom header exists
// because GHL's Custom Webhook in a Service Request workflow did not deliver an
// Authorization header, typed or via its Bearer option (live 401s, 2026-09-15).
export async function requireServices(request, env) {
  if (!env.SERVICES_WEBHOOK_KEY) {
    return Response.json(
      { error: "Server misconfigured: SERVICES_WEBHOOK_KEY secret is not set" },
      { status: 500 }
    );
  }
  const supplied = bearerFrom(request) || (request.headers.get("X-Services-Key") || "").trim() || null;
  if (!supplied) return unauthorized("Bearer token or X-Services-Key required");
  if (!(await secureEquals(supplied, env.SERVICES_WEBHOOK_KEY))) return unauthorized("Invalid credentials");
  return null;
}
