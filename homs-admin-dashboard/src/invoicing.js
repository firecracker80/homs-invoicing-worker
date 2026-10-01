// Calling the invoicing Worker from this one.
//
// Both Workers live on *.yari-058.workers.dev, which is a single zone, and
// Cloudflare refuses a global fetch() from one Worker to another on the same
// zone. It does not fail as an HTTP error either -- it returns a plain-text
// body, so the caller's res.json() throws on the first character and the page
// shows "Unexpected token 'e', \"error code: 1042\" is not valid JSON". That is
// what Yari saw on the manager statement, 2026-10-01.
//
//   1042: "Worker tried to fetch from another Worker on the same zone, which is
//          only supported when the global_fetch_strictly_public compatibility
//          flag is used."
//
// The documented fix is a service binding: the request is handed straight to
// the other Worker, never going over the Internet, and the zone rule does not
// apply. The binding is declared in wrangler.toml as INVOICING.
//
// This mattered twice. The manager statement is the visible one, but
// provisionTenantRecord() has always called the same Worker the same way --
// which means provisioning a new client would have failed in exactly this way,
// and that path had never been exercised end to end.
//
// The global-fetch path is kept as a fallback, deliberately: it is what the
// tests exercise, it is what works if the two Workers ever end up on different
// zones or a custom domain, and losing it would make this untestable without a
// live binding.

/**
 * @param env   Worker env -- INVOICING (service binding) is preferred,
 *              INVOICING_WORKER_URL + INVOICING_ADMIN_SECRET are the fallback.
 * @param path  Path on the invoicing Worker, e.g. "/reports/manager-pl".
 * @param opts  { query, method, headers }
 */
export async function invoicingFetch(env, path, { query = {}, method = "GET", headers = {} } = {}) {
  // A service binding still needs a URL to route on inside the target Worker,
  // but the hostname is never resolved, so a placeholder is honest here when no
  // public URL is configured.
  const base = env.INVOICING_WORKER_URL
    ? String(env.INVOICING_WORKER_URL).replace(/\/+$/, "")
    : (env.INVOICING ? "https://invoicing.internal" : null);

  // Reachability before credentials, which is the order provisionTenantRecord
  // has always reported these in: "there is nowhere to send this" is a more
  // useful first answer than "you have no key for the place you cannot reach".
  if (!base) {
    const err = new Error("Neither the INVOICING service binding nor INVOICING_WORKER_URL is configured, so the invoicing Worker cannot be reached.");
    err.reason = "no_invoicing_worker_url";
    throw err;
  }

  if (!env.INVOICING_ADMIN_SECRET) {
    const err = new Error("INVOICING_ADMIN_SECRET is not set on this Worker, and the invoicing Worker accepts nothing else.");
    err.reason = "no_admin_secret";
    throw err;
  }

  const url = new URL(base + path);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  }

  // (url, init) rather than a Request on purpose: a service binding's fetch
  // takes the same arguments as the global one, and every existing caller and
  // test stub in this Worker is written against that shape. Switching to a
  // Request here broke two of them for no gain.
  const init = { method, headers: { ...headers, "X-Admin-Secret": env.INVOICING_ADMIN_SECRET } };

  // The binding when it exists; the open Internet when it does not.
  return env.INVOICING ? env.INVOICING.fetch(url.toString(), init) : fetch(url.toString(), init);
}
