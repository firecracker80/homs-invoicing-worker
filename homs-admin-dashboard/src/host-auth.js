// Sign-in for the host board.
//
// The board is a public page. It can be opened by anyone with the URL, so it is
// trusted with nothing: it holds a cookie and the Worker decides what it may
// see. The sensitive act is CLAIMING a request, because a claim releases
// another host's WhatsApp number and their free-text notes. Everything here
// exists to make a claim attributable to a real client.
//
// WHY NOT THE OBVIOUS DESIGN. The scope file's first sketch was "check the
// email against contacts in that account". That would be a hole: a GHL account's
// contacts are its GUESTS, its cleaners and its owners. Anyone who ever stayed
// at a property could sign in as the business that hosted them. Authorization
// comes from an explicit allowlist on the tenant record instead - see
// `hostBoard.owners` below - so being known to an account and being able to act
// as it stay separate.
//
// WHY THE WORKER SENDS NO EMAIL. Yari, 2026-11-03: the Worker does not mail
// anyone. It POSTs the code to a GHL inbound webhook and a GHL workflow sends it
// in a branded template. Note the direction: HOST_LOGIN_WEBHOOK_URL must be
// GHL's OWN inbound-webhook trigger URL, the one the workflow builder gives you,
// NOT an endpoint on this Worker. That pair has been got backwards here before.
//
// Tenant record additions (DASHBOARD_TENANTS, per locationId):
//   "hostBoard": {
//     "enabled": true,                  // the tier gate
//     "owners":  ["owner@example.com"], // who may sign in AS this account
//     "canPost": true                   // posting is the paid side; see below
//   }
//
// Posting and claiming are gated apart on purpose. The board is worth having
// only if requests actually get filled, and that depends on how many hosts can
// claim. Gating claims to a paid tier would make the feature worse for the
// people who paid for it. So `enabled` lets an account claim, `canPost` lets it
// post.

import { mintSession, readSession } from "./auth.js";

const COOKIE_NAME = "homs_host";

// Seven days, not the dashboard's thirty. A dashboard session shows you your own
// data; a board session can take another host's phone number.
const HOST_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const CODE_TTL_SECONDS = 600;
const MAX_ATTEMPTS = 5;
const codeKey = (emailHash) => `hostlogin:${emailHash}`;

const json = (body, status = 200, headers = {}) =>
  Response.json(body, { status, headers });

const normalizeEmail = (e) => String(e || "").trim().toLowerCase();

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Six digits, uniformly. Math.random() is not a source of secrets, and a modulo
// of a random byte is biased; rejection sampling costs nothing here.
function generateCode() {
  const digits = [];
  while (digits.length < 6) {
    const byte = crypto.getRandomValues(new Uint8Array(1))[0];
    if (byte < 250) digits.push(byte % 10);
  }
  return digits.join("");
}

function cookieFrom(request) {
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === COOKIE_NAME) return decodeURIComponent(rest.join("="));
  }
  return null;
}

// Which account does this email sign in as?
//
// A scan of the tenant list rather than an email->account index. At six tenants
// that is six reads on a login attempt and no second structure to keep true; an
// index that drifts would silently deny real people. Revisit if the roster grows
// into the hundreds, not before.
async function findHostAccount(env, email) {
  const listed = await env.DASHBOARD_TENANTS.list();
  for (const { name } of listed.keys || []) {
    if (name.includes(":")) continue; // onboarding: and hostlogin: keys are not tenants
    const tenant = await env.DASHBOARD_TENANTS.get(name, { type: "json" });
    const board = tenant?.hostBoard;
    if (!board?.enabled) continue;
    const owners = (board.owners || []).map(normalizeEmail);
    if (owners.includes(email)) return { locationId: name, tenant };
  }
  return null;
}

// POST /api/host/login/start   { email }
//
// Always 204, whether or not the address is known. An endpoint that answers
// differently for a registered address is an endpoint that tells a stranger
// which businesses are HOMS clients, one guess at a time. The page says "if that
// address is on the board, a code is on its way" and moves on either way.
export async function handleHostLoginStart(request, env) {
  let email;
  try {
    ({ email } = await request.json());
  } catch {
    return json({ error: "Expected JSON body { email }" }, 400);
  }
  email = normalizeEmail(email);
  if (!email || !email.includes("@")) {
    // Shape, not existence. Rejecting "not an email at all" leaks nothing.
    return json({ error: "A valid email address is required" }, 422);
  }

  const match = await findHostAccount(env, email);
  if (!match) return new Response(null, { status: 204 });

  if (!env.HOST_LOGIN_WEBHOOK_URL) {
    // Loud on the server, silent to the caller: a misconfiguration must not
    // become a way to tell known addresses from unknown ones by timing or text.
    console.error("HOST_LOGIN_WEBHOOK_URL is not set - no login code can be delivered");
    return new Response(null, { status: 204 });
  }

  const code = generateCode();
  const emailHash = await sha256Hex(email);

  // The CODE is never stored, only its digest. KV is not a secret store, and a
  // reader of this namespace should not be able to sign in as anybody.
  await env.DASHBOARD_TENANTS.put(
    codeKey(emailHash),
    JSON.stringify({
      codeHash: await sha256Hex(code),
      locationId: match.locationId,
      attempts: 0,
      issuedAt: Date.now(),
    }),
    { expirationTtl: CODE_TTL_SECONDS }
  );

  try {
    await fetch(env.HOST_LOGIN_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "host_login_code",
        email,
        code,
        locationId: match.locationId,
        businessName: match.tenant?.label || match.locationId,
        expiresInMinutes: Math.round(CODE_TTL_SECONDS / 60),
      }),
    });
  } catch (err) {
    // The code is already stored, so a delivery failure means the person waits
    // and retries rather than being locked into a broken state.
    console.error(`Host login code delivery failed for ${email}: ${err.message}`);
  }

  return new Response(null, { status: 204 });
}

// POST /api/host/login/verify   { email, code }
export async function handleHostLoginVerify(request, env) {
  let email, code;
  try {
    ({ email, code } = await request.json());
  } catch {
    return json({ error: "Expected JSON body { email, code }" }, 400);
  }
  email = normalizeEmail(email);
  code = String(code || "").trim();
  if (!email || !code) return json({ error: "Email and code are required" }, 422);

  const emailHash = await sha256Hex(email);
  const key = codeKey(emailHash);
  const record = await env.DASHBOARD_TENANTS.get(key, { type: "json" });

  // One message for every failure. "No code outstanding", "wrong code" and
  // "expired" are the same sentence to the caller, or the differences become a
  // way to probe.
  const reject = () => json({ error: "That code is not valid. Request a new one." }, 401);
  if (!record) return reject();

  if ((record.attempts || 0) >= MAX_ATTEMPTS) {
    // Burn it rather than leave a guessable code alive to its TTL.
    await env.DASHBOARD_TENANTS.delete(key);
    return reject();
  }

  if (await sha256Hex(code) !== record.codeHash) {
    await env.DASHBOARD_TENANTS.put(
      key,
      JSON.stringify({ ...record, attempts: (record.attempts || 0) + 1 }),
      // Keep the ORIGINAL expiry rather than extending it: a wrong guess must
      // not buy the guesser another ten minutes.
      { expirationTtl: Math.max(1, Math.round((record.issuedAt + CODE_TTL_SECONDS * 1000 - Date.now()) / 1000)) }
    );
    return reject();
  }

  // Single use.
  await env.DASHBOARD_TENANTS.delete(key);

  const token = await mintSession(env, {
    scope: "host",
    locationId: record.locationId,
    ttlSeconds: HOST_SESSION_TTL_SECONDS,
  });

  return new Response(JSON.stringify({ ok: true, locationId: record.locationId }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      // SameSite=None because the board is framed cross-origin, the same reason
      // the dashboard's cookie carries it.
      "Set-Cookie": `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=${HOST_SESSION_TTL_SECONDS}`,
    },
  });
}

export function handleHostLogout() {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0`,
    },
  });
}

// The gate for every host route.
//
// Returns { locationId, tenant } on success, or a Response to return as-is.
// Scope is checked exactly: an operator token or a dashboard client session must
// not satisfy a host route, and a host session must never satisfy a dashboard
// one. They are different cookies carrying different scopes for that reason.
export async function requireHost(request, env) {
  const token = cookieFrom(request);
  if (!token) return { denied: json({ error: "Sign in to use the board" }, 401) };

  const session = await readSession(env, token);
  if (!session || session.scope !== "host" || !session.locationId) {
    return { denied: json({ error: "Sign in to use the board" }, 401) };
  }

  const tenant = await env.DASHBOARD_TENANTS.get(session.locationId, { type: "json" });
  // Re-read the tenant on every request rather than trusting the token. A
  // session minted while the module was enabled must stop working when it is
  // turned off, or the tier gate is only as current as the oldest live cookie.
  if (!tenant?.hostBoard?.enabled) {
    return { denied: json({ error: "This account does not have the host board" }, 403) };
  }

  return { locationId: session.locationId, tenant };
}
