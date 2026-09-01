// reports.js — owner/manager statements + D1-vs-GHL reconciliation.
// Routes (wired in index.js):
//   GET /reports/owner-statement    ?locationId&from&to&format=json|html&token=...
//   GET /reports/manager-statement  ?locationId&from&to&format=json|html&token=...
//   GET /reports/reconcile          ?locationId&from&to
//
// /reconcile is admin-gated (X-Admin-Secret) only, same model as /cancel and
// /reschedule -- it's an internal diagnostic tool, never iframed.
//
// The two statement routes accept EITHER the admin header OR a per-recipient
// ?token=, so they can be embedded as an iframe (e.g. a GHL Custom Menu Link)
// where no custom header can be sent. See statementAuthorized() below for why
// that token is intentionally its own thing, not adminSecret.
//
// Statements are a plain GROUP BY + detail list over ledger_entries, which
// is already the materialized split (see ledger.js) -- no split logic gets
// recomputed here.

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
function html(body, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
function fromMinor(n) { return round2((n || 0) / 100); }
function round2(n) { return Math.round(n * 100) / 100; }

function adminAuthorized(request, tenant, env) {
  const given = request.headers?.get?.("X-Admin-Secret") || "";
  const expected = tenant?.adminSecret || env.ADMIN_SECRET;
  return expected && given === expected;
}

// Owner/manager statements are meant to be iframed (GHL Custom Menu Link),
// which can't send the X-Admin-Secret header -- so these two routes also
// accept a ?token= query param, checked against a token scoped to just this
// recipient (tenant.ownerReportToken / tenant.managerReportToken). Deliberately
// NOT the same value as adminSecret: adminSecret also gates /cancel and
// /reschedule, and this token ends up sitting in an iframe src (browser
// history, possibly referrer headers) -- a leak of the report token only
// exposes one recipient's statement, not the ability to cancel a booking.
// Scoped per recipient (not one shared report token) so the owner's link
// can't be used to view the manager's numbers, or vice versa.
function statementAuthorized(request, tenant, env, url, tokenField) {
  if (adminAuthorized(request, tenant, env)) return true;
  const expected = tenant?.[tokenField];
  const given = url.searchParams.get("token") || "";
  return Boolean(expected) && given === expected;
}

// Default window: last 30 days, if the caller didn't specify one.
function resolveWindow(url) {
  const now = new Date();
  const to = url.searchParams.get("to") || now.toISOString().slice(0, 10);
  const fromDefault = new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10);
  const from = url.searchParams.get("from") || fromDefault;
  // Half-open range [from 00:00:00, to+1day 00:00:00) so "to" is inclusive
  // of that whole day, matching how a human reads a date-range statement.
  const toExclusive = new Date(`${to}T00:00:00.000Z`);
  toExclusive.setUTCDate(toExclusive.getUTCDate() + 1);
  return { from: `${from}T00:00:00.000Z`, to: toExclusive.toISOString(), fromLabel: from, toLabel: to };
}

async function queryStatement(env, locationId, recipient, from, to) {
  const summaryRes = await env.LEDGER_DB.prepare(
    `SELECT entry_type, category, currency, SUM(amount_minor) AS total_minor, COUNT(*) AS entry_count
     FROM ledger_entries
     WHERE location_id = ?1 AND recipient = ?2 AND created_at >= ?3 AND created_at < ?4
     GROUP BY entry_type, category, currency
     ORDER BY entry_type`
  ).bind(locationId, recipient, from, to).all();

  const detailRes = await env.LEDGER_DB.prepare(
    `SELECT booking_id, invoice_number, invoice_id, entry_type, category, amount_minor, currency, description, created_at
     FROM ledger_entries
     WHERE location_id = ?1 AND recipient = ?2 AND created_at >= ?3 AND created_at < ?4
     ORDER BY created_at DESC`
  ).bind(locationId, recipient, from, to).all();

  const summary = (summaryRes.results || []).map(r => ({
    entryType: r.entry_type, category: r.category, currency: r.currency,
    total: fromMinor(r.total_minor), count: r.entry_count
  }));
  const detail = (detailRes.results || []).map(r => ({
    bookingId: r.booking_id, invoiceNumber: r.invoice_number, invoiceId: r.invoice_id,
    entryType: r.entry_type, category: r.category,
    amount: fromMinor(r.amount_minor), currency: r.currency,
    description: r.description, createdAt: r.created_at
  }));

  // Income total excludes shadow (informational) and pass_through/liability
  // (never this recipient's earnings) -- "what did they actually earn".
  const incomeTotal = round2(summary.filter(s => s.category === "income").reduce((s, r) => s + r.total, 0));
  const shadowTotal = round2(summary.filter(s => s.category === "shadow").reduce((s, r) => s + r.total, 0));

  return { summary, detail, incomeTotal, shadowTotal, currency: detail[0]?.currency || summary[0]?.currency || "USD" };
}

function statementHtml({ brandName, recipientLabel, fromLabel, toLabel, stmt }) {
  const rows = stmt.detail.map(d => `
    <tr>
      <td>${d.createdAt.slice(0, 10)}</td>
      <td>${escapeHtml(d.bookingId)}</td>
      <td>${escapeHtml(d.description || d.entryType)}</td>
      <td class="cat cat-${d.category}">${d.category}</td>
      <td class="amt">${d.currency} ${d.amount.toFixed(2)}</td>
    </tr>`).join("");

  const summaryRows = stmt.summary.map(s => `
    <tr>
      <td>${escapeHtml(s.entryType)}</td>
      <td class="cat cat-${s.category}">${s.category}</td>
      <td class="amt">${s.currency} ${s.total.toFixed(2)}</td>
      <td class="amt muted">${s.count}</td>
    </tr>`).join("");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(recipientLabel)} statement — ${escapeHtml(brandName)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Manrope:wght@400;600&display=swap" rel="stylesheet">
<style>
  :root { --teal:#1D9E75; --coral:#FF5A3C; --ink:#1A1D1F; --muted:#6B7280; --line:#E5E7EB; --bg:#F9FAFB; }
  * { box-sizing: border-box; }
  body { font-family:'Manrope',system-ui,sans-serif; color:var(--ink); background:var(--bg); margin:0; padding:32px 20px; }
  .wrap { max-width:820px; margin:0 auto; background:#fff; border-radius:16px; padding:36px; box-shadow:0 1px 3px rgba(0,0,0,.06); }
  h1 { font-family:'Space Grotesk',sans-serif; font-weight:700; font-size:1.6rem; margin:0 0 4px; }
  h2 { font-family:'Space Grotesk',sans-serif; font-weight:500; font-size:1.05rem; margin:28px 0 10px; color:var(--ink); }
  .sub { color:var(--muted); font-size:.9rem; margin-bottom:24px; }
  .total-card { background:var(--bg); border:1px solid var(--line); border-radius:12px; padding:18px 20px; margin-bottom:8px; }
  .total-card .label { font-size:.8rem; color:var(--muted); text-transform:uppercase; letter-spacing:.03em; }
  .total-card .value { font-family:'Space Grotesk',sans-serif; font-weight:700; font-size:1.8rem; color:var(--teal); }
  .shadow-note { font-size:.82rem; color:var(--muted); margin-top:4px; }
  table { width:100%; border-collapse:collapse; font-size:.88rem; }
  th { text-align:left; font-weight:600; color:var(--muted); font-size:.75rem; text-transform:uppercase; letter-spacing:.03em; padding:8px 10px; border-bottom:1px solid var(--line); }
  td { padding:10px; border-bottom:1px solid var(--line); vertical-align:top; }
  td.amt { text-align:right; font-variant-numeric:tabular-nums; }
  td.muted { color:var(--muted); }
  .cat { font-size:.72rem; padding:2px 8px; border-radius:999px; display:inline-block; }
  .cat-income { background:#E6F6EF; color:var(--teal); }
  .cat-liability, .cat-pass_through { background:#F3F4F6; color:var(--muted); }
  .cat-shadow { background:#FFF1EC; color:var(--coral); }
  a { color:var(--coral); }
</style></head>
<body><div class="wrap">
  <h1>${escapeHtml(brandName)}</h1>
  <div class="sub">${escapeHtml(recipientLabel)} statement · ${fromLabel} – ${toLabel}</div>

  <div class="total-card">
    <div class="label">Total earned</div>
    <div class="value">${stmt.currency} ${stmt.incomeTotal.toFixed(2)}</div>
    ${stmt.shadowTotal > 0 ? `<div class="shadow-note">A comparable OTA commission on this period's bookings would have been ${stmt.currency} ${stmt.shadowTotal.toFixed(2)}.</div>` : ""}
  </div>

  <h2>By type</h2>
  <table><thead><tr><th>Entry type</th><th>Category</th><th>Total</th><th>Count</th></tr></thead>
  <tbody>${summaryRows || `<tr><td colspan="4" class="muted">No entries in this period.</td></tr>`}</tbody></table>

  <h2>Detail</h2>
  <table><thead><tr><th>Date</th><th>Booking</th><th>Description</th><th>Category</th><th>Amount</th></tr></thead>
  <tbody>${rows || `<tr><td colspan="5" class="muted">No entries in this period.</td></tr>`}</tbody></table>
</div></body></html>`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function handleStatement(request, env, recipient, recipientLabel, tokenField) {
  const url = new URL(request.url);
  const locationId = url.searchParams.get("locationId");
  if (!locationId) return json({ error: "locationId is required" }, 400);

  const tenant = await env.TENANTS.get(locationId, { type: "json" });
  if (!tenant) return json({ error: `Unknown locationId: ${locationId}` }, 404);
  if (!statementAuthorized(request, tenant, env, url, tokenField)) return json({ error: "Unauthorized" }, 401);
  if (!env.LEDGER_DB) return json({ error: "Ledger not configured (LEDGER_DB binding missing)" }, 500);

  const { from, to, fromLabel, toLabel } = resolveWindow(url);
  const stmt = await queryStatement(env, locationId, recipient, from, to);

  if ((url.searchParams.get("format") || "html") === "json") {
    return json({ locationId, recipient, from: fromLabel, to: toLabel, ...stmt });
  }
  return html(statementHtml({ brandName: tenant.brandName || locationId, recipientLabel, fromLabel, toLabel, stmt }));
}

export async function handleOwnerStatement(request, env) {
  return handleStatement(request, env, "owner", "Owner", "ownerReportToken");
}
export async function handleManagerStatement(request, env) {
  return handleStatement(request, env, "manager", "Manager", "managerReportToken");
}

// --- reconciliation ---------------------------------------------------------
// Only meaningful for enrich-mode bookings (invoiceStrategy: "enrich") --
// paypal_url bookings pay PayPal/Stripe directly, never touching GHL's own
// transactions ledger, so there's nothing on GHL's side to compare those
// against. Diffs D1's income-bearing bookings for the period against GHL's
// list-transactions for the same window; a booking with an income row in D1
// but no matching GHL transaction is flagged for manual review -- catches a
// payment that got recorded directly in GHL (e.g. manually marked paid)
// without ever hitting this Worker's settle() path.
//
// list-transactions schema (2026-08-29, not yet exercised against real
// settled data -- verify against a live account with real enrich-mode
// transactions before trusting this in production): GET /payments/transactions
// ?altType=location&locationId=...&startAt&endAt, response { data: [...] }
// with entityId/entitySourceType per transaction. Unlike invoices, this
// endpoint's own schema lists locationId as the scoping param, not altId --
// don't assume it needs altId too just because invoices did.
async function ghlFetchTransactions(tenant, env, locationId, fromLabel, toLabel) {
  const pit = tenant.ghlPit || (tenant.ghlPitSecretName && env[tenant.ghlPitSecretName]);
  if (!pit) throw new Error("No GHL PIT configured for this tenant (ghlPit / ghlPitSecretName)");
  const q = new URLSearchParams({ altType: "location", locationId, startAt: fromLabel, endAt: toLabel, limit: "100", offset: "0" });
  const res = await fetch(`${GHL_BASE}/payments/transactions?${q}`, {
    headers: { Authorization: `Bearer ${pit}`, Version: GHL_VERSION, Accept: "application/json" }
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) { const err = new Error(`GHL GET /payments/transactions -> ${res.status} ${JSON.stringify(data).slice(0, 500)}`); err.status = res.status; throw err; }
  return data.data || [];
}

export async function handleReconcile(request, env) {
  const url = new URL(request.url);
  const locationId = url.searchParams.get("locationId");
  if (!locationId) return json({ error: "locationId is required" }, 400);

  const tenant = await env.TENANTS.get(locationId, { type: "json" });
  if (!tenant) return json({ error: `Unknown locationId: ${locationId}` }, 404);
  if (!adminAuthorized(request, tenant, env)) return json({ error: "Unauthorized" }, 401);
  if (!env.LEDGER_DB) return json({ error: "Ledger not configured (LEDGER_DB binding missing)" }, 500);

  const { from, to, fromLabel, toLabel } = resolveWindow(url);

  const ledgerRes = await env.LEDGER_DB.prepare(
    `SELECT DISTINCT booking_id, invoice_id, invoice_number
     FROM ledger_entries
     WHERE location_id = ?1 AND category = 'income' AND created_at >= ?2 AND created_at < ?3`
  ).bind(locationId, from, to).all();
  const ledgerBookings = ledgerRes.results || [];

  let transactions = [];
  let ghlError = null;
  try {
    transactions = await ghlFetchTransactions(tenant, env, locationId, fromLabel, toLabel);
  } catch (err) {
    ghlError = err.message;
  }

  const ghlEntityIds = new Set(transactions.map(t => t.entityId).filter(Boolean));
  const unmatched = ledgerBookings.filter(b => b.invoice_id && !ghlEntityIds.has(b.invoice_id));

  return json({
    locationId, from: fromLabel, to: toLabel,
    ledgerBookingCount: ledgerBookings.length,
    ghlTransactionCount: transactions.length,
    ghlFetchError: ghlError,
    unmatched: unmatched.map(b => ({ bookingId: b.booking_id, invoiceId: b.invoice_id, invoiceNumber: b.invoice_number })),
    note: "Only meaningful for invoiceStrategy:'enrich' bookings -- paypal_url bookings never touch GHL's transactions ledger, so they'll always show as unmatched here (that's expected, not a desync)."
  });
}
