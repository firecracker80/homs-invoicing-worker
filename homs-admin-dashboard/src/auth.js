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
  if (!(await secureEquals(supplied, env.ADMIN_KEY))) return unauthorized("Invalid credentials");
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
  let key;
  try {
    ({ key } = await request.json());
  } catch {
    return Response.json({ error: "Expected JSON body { key }" }, { status: 400 });
  }
  if (!(await secureEquals(key, env.ADMIN_KEY))) {
    return Response.json({ error: "Invalid key" }, { status: 401 });
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie":
        `${COOKIE_NAME}=${encodeURIComponent(key)}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=2592000`,
    },
  });
}

export function handleLogout() {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0`,
    },
  });
}
