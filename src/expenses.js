// An owner's expense reaches the owner's statement.
//
// Phase 4 of EXPENSE-ATTRIBUTION-SCOPE.md. Before this, an expense the OWNER
// bore existed only in GHL's Expenses object and showed up on exactly one page:
// the manager's. The owner -- the person actually paying for it -- never saw it,
// because the owner statement is built from the ledger and the ledger had no
// expense entry type at all.
//
// GHL is the trigger surface, as it already is for a paid invoice: a workflow on
// the Expenses object POSTs here when Review Status becomes Approved.
//
// But the webhook carries no record id. Yari, 2026-10-07: "record.id is not
// exposed on the object workflow" -- GHL offers no merge tag for the triggering
// record's own id, so the call cannot say WHICH expense changed.
//
// So it does not try. The POST is a nudge meaning "something about this
// location's expenses changed", and this reconciles the whole location: every
// qualifying expense is posted, and every ledger row whose expense no longer
// qualifies is removed. That turns out to be better than the design it replaces
// rather than a concession to it -- a missed webhook heals on the next one, and
// un-approving an expense actually stops the deduction, which a per-record call
// could never have done because nothing fires for a record that stopped
// qualifying.
import { moneyOf, fetchExpenseRecords } from "./manager-pl.js";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// A merge tag GHL failed to resolve arrives as the literal "{{...}}", or as the
// string "null". Same guard the invoice-paid path uses, for the same reason.
const unresolved = (v) =>
  v == null || /^\s*$|^\s*(null|undefined)\s*$|\{\{/i.test(String(v));

const toMinor = (n) => Math.round(Number(n) * 100);

// What, if anything, belongs on the owner's statement for this record.
//
// Every refusal is named rather than returned as a bare null, because this runs
// from a webhook nobody watches: a reason is the only trace of why an expense
// never reached a statement.
export function ownerLedgerRowFor(record, recordId) {
  const p = record?.properties || {};

  const paidBy = String(p.paid_by || "").toLowerCase();
  if (paidBy !== "owner") {
    // The manager's own cost belongs in the manager's P&L, which reads the GHL
    // object directly and needs nothing from the ledger. An unattributed one is
    // already reported on the manager statement; posting it to an owner would
    // be guessing at exactly the thing Paid By exists to stop guessing about.
    return { skip: paidBy === "manager" ? "manager_borne" : "not_attributed" };
  }
  if (String(p.review_status || "").toLowerCase() !== "approved") return { skip: "not_approved" };

  const gross = moneyOf(p.amount);
  if (gross === null) return { skip: "no_amount" };
  if (gross === 0) return { skip: "zero_amount" };

  const paidOn = p.paid_on ? String(p.paid_on).slice(0, 10) : null;
  if (!paidOn) return { skip: "no_paid_on" };

  // Stored in the currency it was incurred in, with no conversion here. The
  // statement converts at read time (see #104), where the rate on the record is
  // still available and where one wrong rate can be corrected by re-reading
  // rather than by rewriting history.
  const currency = (p.currency ? String(p.currency) : "USD").toUpperCase();

  return {
    row: {
      bookingId: `expense:${recordId}`,
      reference: recordId,
      entryType: "expense_owner",
      category: "expense",
      recipient: "owner",
      recipientName: p.owner_name ?? null,
      amountMinor: -Math.abs(toMinor(gross)),
      currency,
      description: p.expense_name || p.line_item_description || "Expense",
      paidOn,
    },
  };
}

const UPSERT = `INSERT INTO ledger_entries
    (location_id, booking_id, invoice_number, invoice_id, recipient, recipient_name,
     category, entry_type, amount_minor, currency, description, source, reference, created_at)
  VALUES (?1, ?2, NULL, NULL, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'expense_approved', ?10, ?11)
  ON CONFLICT(booking_id, entry_type, reference) DO UPDATE SET
    amount_minor = excluded.amount_minor,
    currency     = excluded.currency,
    description  = excluded.description,
    recipient_name = excluded.recipient_name,
    created_at   = excluded.created_at`;

// Make the ledger match what the Expenses object currently says, for one
// location. Not "apply this change" -- there is no way to know what changed --
// but "end up correct either way", which is the only thing a nudge can promise.
export async function reconcileOwnerExpenses(env, locationId, records) {
  const want = new Map();
  const skipped = {};
  for (const rec of records) {
    const id = rec?.id;
    if (!id) continue;
    const { row, skip } = ownerLedgerRowFor(rec, id);
    if (skip) { skipped[skip] = (skipped[skip] || 0) + 1; continue; }
    want.set(id, row);
  }

  for (const row of want.values()) {
    // created_at carries the expense's own Paid On, not the moment the webhook
    // fired. A receipt entered in October for a repair paid in July belongs in
    // July, or every statement period is decided by when somebody got round to
    // typing it in.
    await env.LEDGER_DB.prepare(UPSERT).bind(
      locationId, row.bookingId, row.recipient, row.recipientName,
      row.category, row.entryType, row.amountMinor, row.currency,
      row.description, row.reference, `${row.paidOn}T00:00:00.000Z`
    ).run();
  }

  // Anything this location has posted that no longer qualifies: an expense
  // un-approved, re-attributed to the manager, deleted, or emptied of its
  // amount. Leaving those would keep deducting from an owner for something that
  // has been retracted -- and nothing fires a webhook for a record that stopped
  // qualifying, so this is the only moment it can be noticed.
  const existing = await env.LEDGER_DB.prepare(
    `SELECT reference FROM ledger_entries WHERE location_id = ?1 AND entry_type = 'expense_owner'`
  ).bind(locationId).all();

  const stale = (existing?.results || [])
    .map((r) => r.reference)
    .filter((ref) => ref && !want.has(ref));

  for (const ref of stale) {
    await env.LEDGER_DB.prepare(
      `DELETE FROM ledger_entries WHERE location_id = ?1 AND entry_type = 'expense_owner' AND reference = ?2`
    ).bind(locationId, ref).run();
  }

  return { posted: want.size, removed: stale.length, skipped };
}

export async function handleExpenseApproved(request, env) {
  let body = {};
  try { body = await request.json(); } catch { /* a nudge needs no body */ }

  const locationId = (request.headers?.get?.("X-Location-Id") || body.locationId || "").trim();
  const secret = (request.headers?.get?.("X-Webhook-Secret") || body.secret || "").trim();
  if (unresolved(locationId)) return json({ error: "locationId is required" }, 400);

  const tenant = await env.TENANTS.get(locationId, { type: "json" });
  if (!tenant) return json({ error: `Unknown locationId: ${locationId}` }, 404);
  if (tenant.webhookSecret && secret !== tenant.webhookSecret) return json({ error: "Unauthorized" }, 401);
  if (!env.LEDGER_DB) return json({ error: "Ledger not configured (LEDGER_DB binding missing)" }, 500);

  const pit = tenant.ghlPit || (tenant.ghlPitSecretName && env[tenant.ghlPitSecretName]);
  if (!pit) return json({ error: "No GHL PIT configured for this tenant" }, 500);

  // Read from GHL rather than from the request. The body is a nudge and carries
  // nothing this trusts: a workflow sends whatever merge tags it was configured
  // with, and this writes money.
  let records;
  try {
    records = await fetchExpenseRecords(pit, locationId);
  } catch (err) {
    if (err.status === 404) return json({ ok: true, skipped: "no_expenses_object", locationId });
    return json({ error: err.message }, 502);
  }

  const result = await reconcileOwnerExpenses(env, locationId, records);
  // 200 even when nothing was posted, deliberately. This is a workflow step: a
  // non-2xx marks the run failed in GHL and invites a retry that would do the
  // same work to the same effect.
  return json({ ok: true, locationId, read: records.length, ...result });
}
