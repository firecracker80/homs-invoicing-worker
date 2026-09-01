// Local mock tests for the D1 ledger + owner/manager statements +
// reconciliation -- no network, no live D1. Mirrors test-worker.js's
// dependency-free style: a hand-rolled in-memory D1 mock recognizing the
// exact query shapes ledger.js/reports.js actually issue, not a generic
// SQL engine.
import assert from "node:assert";
import { writeLedgerEntries } from "./src/ledger.js";
import { composeBooking } from "./src/booking-composer.js";

// ---- minimal in-memory D1 mock ----
function makeMockD1() {
  const rows = [];
  let nextId = 1;

  function insert(params) {
    const [location_id, booking_id, invoice_number, invoice_id, recipient, recipient_name,
      category, entry_type, amount_minor, currency, description, source, created_at] = params;
    // Mirrors the real UNIQUE INDEX (booking_id, entry_type) + INSERT OR IGNORE.
    if (rows.some(r => r.booking_id === booking_id && r.entry_type === entry_type)) return { changes: 0 };
    rows.push({ id: nextId++, location_id, booking_id, invoice_number, invoice_id, recipient,
      recipient_name, category, entry_type, amount_minor, currency, description, source, created_at, reconciled: 0 });
    return { changes: 1 };
  }

  function select(sql, params) {
    if (sql.includes("GROUP BY entry_type, category, currency")) {
      const [locationId, recipient, from, to, recipientName] = params;
      const filtered = rows.filter(r => r.location_id === locationId && r.recipient === recipient && r.created_at >= from && r.created_at < to
        && (recipientName === undefined || r.recipient_name === recipientName));
      const groups = new Map();
      for (const r of filtered) {
        const key = `${r.entry_type}|${r.category}|${r.currency}`;
        const g = groups.get(key) || { entry_type: r.entry_type, category: r.category, currency: r.currency, total_minor: 0, entry_count: 0 };
        g.total_minor += r.amount_minor; g.entry_count += 1;
        groups.set(key, g);
      }
      return { results: [...groups.values()] };
    }
    if (sql.includes("ORDER BY created_at DESC")) {
      const [locationId, recipient, from, to, recipientName] = params;
      return { results: rows.filter(r => r.location_id === locationId && r.recipient === recipient && r.created_at >= from && r.created_at < to
        && (recipientName === undefined || r.recipient_name === recipientName))
        .sort((a, b) => b.created_at.localeCompare(a.created_at)) };
    }
    if (sql.includes("DISTINCT booking_id, invoice_id, invoice_number")) {
      const [locationId, from, to] = params;
      const seen = new Set(); const out = [];
      for (const r of rows) {
        if (r.location_id !== locationId || r.category !== "income" || r.created_at < from || r.created_at >= to) continue;
        if (seen.has(r.booking_id)) continue;
        seen.add(r.booking_id); out.push({ booking_id: r.booking_id, invoice_id: r.invoice_id, invoice_number: r.invoice_number });
      }
      return { results: out };
    }
    throw new Error("mock D1: unrecognized query shape: " + sql.slice(0, 100));
  }

  return {
    _rows: rows,
    prepare(sql) {
      return { bind: (...params) => ({ run: async () => insert(params), all: async () => select(sql, params) }) };
    },
    batch: async (stmts) => Promise.all(stmts.map(s => s.run()))
  };
}

// ---- fixtures matching the real snapshot shape ----
const tenant = { currency: "USD", processingFeePct: 0.06, otaRate: 0.15 };
function makeSnapshot(bookingId, overrides = {}) {
  return {
    bookingId, locationId: "L1", ghlInvoice: { invoiceId: "inv_123" },
    charges: { rentTotal: 700, cleaningFee: 69, processingFee: 46.14, feePct: 0.06 },
    securityDeposit: { total: 490 },
    payout: { basis: 700, ownerPct: 0.85, owner: 595, manager: 105, cleaningFeeTo: "manager" },
    ...overrides
  };
}
const captures = { RENT: { gross: 815.14 }, DEP: { gross: 490 } };

// ---- 1. writeLedgerEntries: all 6 rows, correct amounts, correct minor-unit conversion ----
const db1 = makeMockD1();
const env1 = { LEDGER_DB: db1 };
const r1 = await writeLedgerEntries(env1, tenant, makeSnapshot("BK-1"), captures);
assert.equal(r1.ok, true);
assert.equal(r1.rowsWritten, 6, "expected 6 rows: owner rent, manager rent, cleaning, deposit, processing fee, shadow OTA");

const byType = Object.fromEntries(db1._rows.map(r => [r.entry_type, r]));
assert.equal(byType.rent_split_owner.amount_minor, 59500, "owner 85% of $700 = $595.00 -> 59500 minor units");
assert.equal(byType.rent_split_owner.recipient, "owner");
assert.equal(byType.rent_split_owner.category, "income");
assert.equal(byType.rent_split_manager.amount_minor, 10500, "manager 15% of $700 = $105.00");
assert.equal(byType.cleaning_fee.amount_minor, 6900, "$69.00 cleaning fee");
assert.equal(byType.cleaning_fee.recipient, "manager", "cleaningFeeTo=manager");
assert.equal(byType.deposit_held.recipient, "guest");
assert.equal(byType.deposit_held.category, "liability", "deposit must never count as income");
assert.equal(byType.deposit_held.amount_minor, 49000);
assert.equal(byType.processing_fee.recipient, "platform");
assert.equal(byType.processing_fee.category, "pass_through", "processing fee must never count as income");
assert.equal(byType.processing_fee.amount_minor, 4614);
assert.equal(byType.shadow_ota_commission.category, "shadow", "shadow entry must be its own category, excluded from real income");
assert.equal(byType.shadow_ota_commission.amount_minor, round2(0.15 * 700) * 100, "15% of $700 basis");
assert.equal(byType.shadow_ota_commission.recipient, "owner");
console.log("1) writeLedgerEntries: 6 rows, correct recipients/categories/amounts");

// ---- 2. Idempotency: calling twice for the SAME booking must not double-count ----
const r2 = await writeLedgerEntries(env1, tenant, makeSnapshot("BK-1"), captures);
assert.equal(r2.ok, true);
assert.equal(db1._rows.length, 6, "re-writing the same booking must not create duplicate rows (OR IGNORE + unique index)");
console.log("2) Idempotent: re-write of BK-1 added 0 new rows, still 6 total");

// ---- 3. No otaRate configured -> shadow row skipped, never guess a commission rate ----
const db3 = makeMockD1();
const r3 = await writeLedgerEntries({ LEDGER_DB: db3 }, { currency: "USD" }, makeSnapshot("BK-NO-OTA"), captures);
assert.equal(r3.rowsWritten, 5, "no otaRate on tenant -> 5 rows, no shadow_ota_commission");
assert.ok(!db3._rows.some(r => r.entry_type === "shadow_ota_commission"));
console.log("3) No tenant.otaRate -> shadow entry correctly omitted (never guesses a rate)");

// ---- 3b. booking-composer.js: owner/manager name resolution order ----
// Per-property override wins over the tenant-wide default; a tenant with
// only one owner/manager can skip per-property config entirely.
const multiOwnerTenant = {
  ownerPct: 0.85, currency: "USD", ownerName: "Yari", managerName: "Priya",
  propertyOwnerNames: { "PROP-B": "Marco" }, propertyManagerNames: { "PROP-B": "Diego" }
};
const { snapshot: compA } = composeBooking({ bookingId: "CMP-A", locationId: "L1", propertyCode: "PROP-A", checkIn: "2026-09-01", checkOut: "2026-09-04", nightlyRate: 100 }, multiOwnerTenant);
assert.equal(compA.payout.ownerName, "Yari", "no per-property override for PROP-A -> falls back to tenant-wide ownerName");
assert.equal(compA.payout.managerName, "Priya");
const { snapshot: compB } = composeBooking({ bookingId: "CMP-B", locationId: "L1", propertyCode: "PROP-B", checkIn: "2026-09-01", checkOut: "2026-09-04", nightlyRate: 100 }, multiOwnerTenant);
assert.equal(compB.payout.ownerName, "Marco", "PROP-B has its own owner -> per-property override wins");
assert.equal(compB.payout.managerName, "Diego");
const { snapshot: compNone } = composeBooking({ bookingId: "CMP-C", locationId: "L1", propertyCode: null, checkIn: "2026-09-01", checkOut: "2026-09-04", nightlyRate: 100 }, { ownerPct: 0.85, currency: "USD" });
assert.equal(compNone.payout.ownerName, null, "single-owner tenant with no name config at all -> null, not an error");
console.log("3b) booking-composer name resolution: per-property override > tenant-wide default > null");

// ---- 3c. ledger.js writes the resolved name onto every row for that role ----
const db3c = makeMockD1();
await writeLedgerEntries({ LEDGER_DB: db3c }, { ...multiOwnerTenant, otaRate: 0.15 }, makeSnapshot("BK-NAMED", { payout: { basis: 700, ownerPct: 0.85, owner: 595, manager: 105, cleaningFeeTo: "manager", ownerName: "Marco", managerName: "Diego" } }), captures);
const namedRows = Object.fromEntries(db3c._rows.map(r => [r.entry_type, r]));
assert.equal(namedRows.rent_split_owner.recipient_name, "Marco");
assert.equal(namedRows.rent_split_manager.recipient_name, "Diego");
assert.equal(namedRows.cleaning_fee.recipient_name, "Diego", "cleaningFeeTo=manager -> carries the manager's name, not the owner's");
assert.equal(namedRows.shadow_ota_commission.recipient_name, "Marco");
assert.equal(namedRows.deposit_held.recipient_name, null, "guest/platform rows never carry an owner/manager name");
console.log("3c) ledger.js: recipient_name flows onto every owner/manager row, correctly split by who actually earned it");

// ---- 4. No LEDGER_DB binding -> reports non-fatal, doesn't throw ----
const r4 = await writeLedgerEntries({}, tenant, makeSnapshot("BK-NO-DB"), captures);
assert.equal(r4.ok, false);
assert.equal(r4.reason, "no_ledger_db_binding");
console.log("4) Missing LEDGER_DB binding -> reports failure cleanly, does not throw");

// ---- 5. Statement query shape: owner statement totals match what was written ----
// Uses the SAME sql the real reports.js issues, run against the mock directly
// (index.js E2E coverage for the HTTP layer is below).
const summaryRes = await db1.prepare(
  `SELECT entry_type, category, currency, SUM(amount_minor) AS total_minor, COUNT(*) AS entry_count
   FROM ledger_entries WHERE location_id = ?1 AND recipient = ?2 AND created_at >= ?3 AND created_at < ?4
   GROUP BY entry_type, category, currency ORDER BY entry_type`
).bind("L1", "owner", "2000-01-01T00:00:00.000Z", "2100-01-01T00:00:00.000Z").all();
const incomeTotal = summaryRes.results.filter(r => r.category === "income").reduce((s, r) => s + r.total_minor, 0);
assert.equal(incomeTotal, 59500, "owner's income-only total must be exactly the rent split, excluding the shadow row");
console.log("5) Owner statement summary query: income total excludes shadow entry, matches rent split exactly");

function round2(n) { return Math.round(n * 100) / 100; }
console.log("\nPASS — ledger.js materializes correct, idempotent, category-correct rows.");

// =========================================================================
// Part 2 — end-to-end through the actual worker: booking -> settle -> the
// real /reports/* HTTP endpoints, proving the wiring (not just ledger.js
// in isolation).
// =========================================================================
global.Response = class { constructor(b, i = {}) { this.body = b; this.status = i.status || 200; } async json() { return JSON.parse(this.body); } };
global.btoa = s => Buffer.from(s).toString("base64");
const store = new Map();
const kv = { async get(k, o) { const v = store.get(k); return v == null ? null : (o?.type === "json" ? JSON.parse(v) : v); }, async put(k, v) { store.set(k, v); } };
const ledgerDb = makeMockD1();
const hdr = s => ({ get: n => n === "X-Admin-Secret" ? s : null });

let ghlTransactionCalls = 0;
let mockTransactions = [];
global.fetch = async (url, opts = {}) => {
  if (url.includes("oauth2/token")) return { ok: true, json: async () => ({ access_token: "T" }) };
  if (url.includes("/capture")) return { ok: true, json: async () => ({
    id: "PP", status: "COMPLETED", payer: { email_address: "g@x.com", payer_id: "P" },
    purchase_units: [
      { reference_id: "E2E-1-RENT", payments: { captures: [{ id: "CAP-RENT", status: "COMPLETED", amount: { value: "815.14" },
        seller_receivable_breakdown: { gross_amount: { value: "815.14" }, paypal_fee: { value: "20" }, net_amount: { value: "795.14" } } }] } },
      { reference_id: "E2E-1-DEP", payments: { captures: [{ id: "CAP-DEP", status: "COMPLETED", amount: { value: "490" },
        seller_receivable_breakdown: { gross_amount: { value: "490" }, paypal_fee: { value: "15" }, net_amount: { value: "475" } } }] } }
    ]
  }) };
  if (url.includes("checkout/orders")) return { ok: true, json: async () => ({ id: "PP-ORDER", links: [{ rel: "payer-action", href: "https://sandbox.paypal.com/checkoutnow?token=PP" }] }) };
  if (url.includes("/payments/transactions")) {
    ghlTransactionCalls++;
    return { ok: true, text: async () => JSON.stringify({ data: mockTransactions }) };
  }
  if (url.includes("airtable")) {
    const b = opts.body ? JSON.parse(opts.body) : null;
    if (opts.method === "PATCH") return { ok: true, json: async () => ({ id: "patched" }) };
    return { ok: true, json: async () => ({ records: (b?.records || []).map((r, i) => ({ id: "rec" + i, fields: r.fields })) }) };
  }
  if (url.includes("leadconnector")) return { ok: true, json: async () => ({ ok: true }) };
  throw new Error("unmocked: " + url);
};

const worker = (await import("./src/index.js")).default;
const env = { WORKER_URL: "https://w.dev", TENANTS: kv, BOOKINGS: kv, LEDGER_DB: ledgerDb, ADMIN_SECRET: "admin123" };
await kv.put("L1", JSON.stringify({
  brandName: "JT1", currency: "USD", ownerPct: 0.85, processingFeePct: 0.06,
  defaultCleaningFee: 69, cleaningFeeRecipient: "manager", bookingWorkerEnabled: true,
  gateway: "paypal", deposit: { rule: "tiered" }, otaRate: 0.15,
  paypalApi: "https://p", paypalClientId: "C", paypalSecret: "S",
  airtableBaseId: "a", airtableToken: "pat", defaultPropertyRecId: "rP",
  ghlPit: "test-pit"
}));

// Book + settle a real booking through the actual worker (not a direct
// writeLedgerEntries call) -- proves settle() in payment.js actually calls
// the ledger write, not just that ledger.js works when called directly.
await worker.fetch({ method: "POST", url: "https://w.dev/booking-created", json: async () => ({
  bookingId: "E2E-1", locationId: "L1", contactId: "c1", firstName: "Ana", lastName: "G",
  email: "a@x.com", phone: "+1", checkIn: "2026-09-01", checkOut: "2026-09-11", stayTotal: "700"
}), headers: { get: () => null } }, env);
await worker.fetch({ method: "GET", url: "https://w.dev/paypal/return?bookingId=E2E-1", headers: { get: () => null } }, env);

const afterSettle = await kv.get("E2E-1", { type: "json" });
assert.equal(afterSettle.settled, true, "booking must actually be settled before checking the ledger");
assert.ok(ledgerDb._rows.some(r => r.booking_id === "E2E-1"), "settle() must have written ledger rows for this real booking");
console.log("6) Real booking settled through the worker -> ledger rows written:", ledgerDb._rows.filter(r => r.booking_id === "E2E-1").length);

// ---- 7. /reports/owner-statement (JSON): unauthorized without the admin secret ----
const unauth = await worker.fetch({ method: "GET", url: "https://w.dev/reports/owner-statement?locationId=L1&format=json", headers: { get: () => null } }, env);
assert.equal(unauth.status, 401);
console.log("7) /reports/owner-statement without X-Admin-Secret -> 401");

// ---- 8. /reports/owner-statement (JSON): correct totals for the real settled booking ----
const ownerRes = await (await worker.fetch({ method: "GET", url: "https://w.dev/reports/owner-statement?locationId=L1&format=json&from=2026-01-01&to=2026-12-31", headers: hdr("admin123") }, env)).json();
assert.equal(ownerRes.recipient, "owner");
assert.equal(ownerRes.incomeTotal, 595.00, "owner's income total must be exactly the 85% rent split for this real settled booking");
assert.ok(ownerRes.shadowTotal > 0, "shadow OTA comparison must appear (tenant has otaRate configured)");
console.log("8) /reports/owner-statement JSON -> incomeTotal:", ownerRes.incomeTotal, "| shadowTotal:", ownerRes.shadowTotal);

// ---- 9. /reports/owner-statement (HTML, default format) renders without throwing ----
const htmlRes = await worker.fetch({ method: "GET", url: "https://w.dev/reports/owner-statement?locationId=L1", headers: hdr("admin123") }, env);
assert.equal(htmlRes.status, 200);
assert.ok(htmlRes.body.includes("<!doctype html>"));
assert.ok(htmlRes.body.includes("595.00"), "rendered HTML must contain the actual owner total, not just structure");
console.log("9) /reports/owner-statement HTML renders and contains the real total");

// ---- 10. /reports/manager-statement: cleaning fee + rent split, correct recipient ----
const mgrRes = await (await worker.fetch({ method: "GET", url: "https://w.dev/reports/manager-statement?locationId=L1&format=json&from=2026-01-01&to=2026-12-31", headers: hdr("admin123") }, env)).json();
assert.equal(mgrRes.incomeTotal, round2(105 + 69), "manager income = 15% rent split + cleaning fee (cleaningFeeTo=manager)");
console.log("10) /reports/manager-statement JSON -> incomeTotal:", mgrRes.incomeTotal, "(15% rent split + cleaning fee)");

// ---- 10b. Iframe-friendly ?token= auth: scoped per recipient, can't cross over ----
await kv.put("L2", JSON.stringify({
  brandName: "JT2", ownerReportToken: "owner-tok-abc", managerReportToken: "mgr-tok-xyz"
}));
const noAuth = await worker.fetch({ method: "GET", url: "https://w.dev/reports/owner-statement?locationId=L2&format=json", headers: { get: () => null } }, env);
assert.equal(noAuth.status, 401, "no header and no token -> still 401");

const wrongToken = await worker.fetch({ method: "GET", url: "https://w.dev/reports/owner-statement?locationId=L2&format=json&token=not-it", headers: { get: () => null } }, env);
assert.equal(wrongToken.status, 401, "a token that doesn't match ownerReportToken -> 401");

const crossToken = await worker.fetch({ method: "GET", url: "https://w.dev/reports/owner-statement?locationId=L2&format=json&token=mgr-tok-xyz", headers: { get: () => null } }, env);
assert.equal(crossToken.status, 401, "the manager's token must not unlock the owner statement");

const rightOwnerToken = await worker.fetch({ method: "GET", url: "https://w.dev/reports/owner-statement?locationId=L2&format=json&token=owner-tok-abc", headers: { get: () => null } }, env);
assert.equal(rightOwnerToken.status, 200, "the owner's own scoped token, with no header at all, must work (this is the iframe path)");

const rightManagerToken = await worker.fetch({ method: "GET", url: "https://w.dev/reports/manager-statement?locationId=L2&format=json&token=mgr-tok-xyz", headers: { get: () => null } }, env);
assert.equal(rightManagerToken.status, 200, "the manager's own scoped token must work on the manager route");

const ownerTokenOnManagerRoute = await worker.fetch({ method: "GET", url: "https://w.dev/reports/manager-statement?locationId=L2&format=json&token=owner-tok-abc", headers: { get: () => null } }, env);
assert.equal(ownerTokenOnManagerRoute.status, 401, "the owner's token must not unlock the manager statement");
console.log("10b) ?token= auth: scoped correctly per recipient, no cross-over, admin header still works alongside it");

// ---- 10c. ?recipientName= filtering: one location, two owners (several
// properties under the same tenant) -- must never blend their totals ----
await kv.put("L3", JSON.stringify({ brandName: "Multi-owner Tenant" }));
const seedOwnerRow = (recipientName, amountMinor, bookingId) => ledgerDb.prepare(
  `INSERT OR IGNORE INTO ledger_entries
   (location_id, booking_id, invoice_number, invoice_id, recipient, recipient_name, category, entry_type, amount_minor, currency, description, source, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
).bind("L3", bookingId, null, null, "owner", recipientName, "income", "rent_split_owner", amountMinor, "USD", "test", "payment_confirmed", new Date().toISOString()).run();
await seedOwnerRow("Yari", 59500, "BK-YARI-1");
await seedOwnerRow("Marco", 42000, "BK-MARCO-1");

const yariOnly = await (await worker.fetch({ method: "GET", url: "https://w.dev/reports/owner-statement?locationId=L3&format=json&recipientName=Yari", headers: hdr("admin123") }, env)).json();
assert.equal(yariOnly.incomeTotal, 595.00, "recipientName=Yari must only total Yari's row, not Marco's");

const marcoOnly = await (await worker.fetch({ method: "GET", url: "https://w.dev/reports/owner-statement?locationId=L3&format=json&recipientName=Marco", headers: hdr("admin123") }, env)).json();
assert.equal(marcoOnly.incomeTotal, 420.00, "recipientName=Marco must only total Marco's row, not Yari's");

const bothCombined = await (await worker.fetch({ method: "GET", url: "https://w.dev/reports/owner-statement?locationId=L3&format=json", headers: hdr("admin123") }, env)).json();
assert.equal(bothCombined.incomeTotal, 1015.00, "omitting recipientName -> the old whole-location behavior, both owners combined");
console.log("10c) ?recipientName= filtering: two owners under one location, each statement scoped correctly, omitting it still aggregates both (unchanged default behavior)");

// ---- 10d. ?brandName= overrides tenant.brandName -- lets a GHL merge tag
// (resolved by GHL in the Custom Menu Link's own URL field) drive the
// displayed name, editable from GHL without touching KV ----
const brandOverrideRes = await worker.fetch({ method: "GET", url: "https://w.dev/reports/owner-statement?locationId=L3&recipientName=Yari&brandName=Luminara%20Hospitality", headers: hdr("admin123") }, env);
assert.ok(brandOverrideRes.body.includes("Luminara Hospitality"), "?brandName= in the URL must override tenant.brandName from KV");
const brandFallbackRes = await worker.fetch({ method: "GET", url: "https://w.dev/reports/owner-statement?locationId=L3&recipientName=Yari", headers: hdr("admin123") }, env);
assert.ok(brandFallbackRes.body.includes("Multi-owner Tenant"), "omitting ?brandName= must still fall back to tenant.brandName from KV");
console.log("10d) ?brandName= in the URL overrides tenant.brandName; omitted, falls back to KV as before");

// ---- 11/12. /reports/reconcile is only meaningful for enrich-mode bookings
// (ones with a real GHL invoice_id) -- E2E-1 went through paypal_url and
// never set snapshot.ghlInvoice, so it's correctly EXCLUDED from unmatched
// (nothing on GHL's side to compare a direct-PayPal booking against). Seed
// a second ledger row shaped like a settled enrich-mode booking directly to
// exercise the actual matching logic.
await ledgerDb.prepare(
  `INSERT OR IGNORE INTO ledger_entries
   (location_id, booking_id, invoice_number, invoice_id, recipient, recipient_name, category, entry_type, amount_minor, currency, description, source, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
).bind("L1", "E2E-ENRICH", "000018-E2E-ENRICH", "inv_999", "owner", null, "income", "rent_split_owner", 59500, "USD", "test", "payment_confirmed", new Date().toISOString()).run();
assert.equal(ledgerDb._rows.filter(r => r.category === "income" && r.location_id === "L1").length >= 2, true, "sanity: both E2E-1's and the seeded enrich booking's income rows must be present");

mockTransactions = []; // GHL shows nothing -> the enrich booking's income is genuinely unmatched
const recon1 = await (await worker.fetch({ method: "GET", url: "https://w.dev/reports/reconcile?locationId=L1&from=2026-01-01&to=2026-12-31", headers: hdr("admin123") }, env)).json();
assert.equal(recon1.unmatched.length, 1, "only the enrich-mode booking (has an invoice_id) should ever be flagged -- E2E-1 (paypal_url, no invoice_id) must never appear here");
assert.equal(recon1.unmatched[0].bookingId, "E2E-ENRICH");
console.log("11) /reports/reconcile: paypal_url booking (E2E-1) correctly excluded; enrich-mode booking with no matching GHL transaction -> flagged");

mockTransactions = [{ entityId: "inv_999", amount: 595.00 }]; // matches the seeded row's invoice_id
const recon2 = await (await worker.fetch({ method: "GET", url: "https://w.dev/reports/reconcile?locationId=L1&from=2026-01-01&to=2026-12-31", headers: hdr("admin123") }, env)).json();
assert.equal(recon2.unmatched.length, 0, "a booking whose invoice_id matches a GHL transaction's entityId must NOT be flagged");
console.log("12) /reports/reconcile with a matching GHL transaction -> 0 unmatched");

console.log("\nPASS (E2E) — settle() writes the ledger, /reports/* endpoints return correct real totals, reconcile diffs correctly both ways.");
