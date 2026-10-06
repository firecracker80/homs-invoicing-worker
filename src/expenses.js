// An owner's expense reaches the owner's statement.
//
// Phase 4 of EXPENSE-ATTRIBUTION-SCOPE.md. Before this, an expense the OWNER
// bore existed only in GHL's Expenses object and showed up on exactly one page:
// the manager's. The owner -- the person actually paying for it -- never saw it,
// because the owner statement is built from the ledger and the ledger had no
// expense entry type at all.
//
// GHL is the trigger surface, as it already is for a paid invoice: a workflow on
// the Expenses object POSTs here when Review Status becomes Approved. That keeps
// the thing that knows an expense changed in charge of saying so, instead of
// this Worker polling for changes it cannot subscribe to.
import { moneyOf } from "./manager-pl.js";

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// A merge tag GHL failed to resolve arrives as the literal "{{...}}", or as the
// string "null". Same guard the invoice-paid path uses, for the same reason.
const unresolved = (v) =>
  v == null || /^\s*$|^\s*(null|undefined)\s*$|\{\{/i.test(String(v));

const toMinor = (n) => Math.round(Number(n) * 100);

export async function fetchExpenseRecord(pit, locationId, recordId) {
  const res = await fetch(
    `${GHL_BASE}/objects/custom_objects.expenses/records/${encodeURIComponent(recordId)}`,
    { headers: { Authorization: `Bearer ${pit}`, Version: GHL_VERSION, Accept: "application/json" } }
  );
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = null; }
  if (!res.ok) {
    const err = new Error(`GHL expense fetch -> ${res.status} ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return data?.record ?? data ?? null;
}

// What, if anything, belongs on the owner's statement for this record.
//
// Every refusal is named rather than returned as a bare null, because this runs
// from a webhook nobody watches: "skipped" with a reason is the only trace of
// why an expense never reached a statement.
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

// Keyed on the expense record id, and an UPDATE rather than an ignore.
//
// Yari, 2026-10-06: "use the expense record id". An expense can be edited,
// unapproved and re-approved, so the row has to end up matching what the record
// currently says -- INSERT OR IGNORE would leave an owner charged the old
// amount forever after a correction, which is a quieter wrong than a double
// charge and just as costly.
//
// The honest trade-off: this mutates a ledger row in place, and the ledger is
// otherwise append-only. The alternative is a reversing entry, which keeps the
// history but puts two rows on the owner's statement for one expense and needs
// the reader to net them. Chosen deliberately; a correction to an expense is
// not an event the owner needs to see, only its result.
export async function upsertOwnerExpense(env, locationId, row) {
  const sql = `INSERT INTO ledger_entries
      (location_id, booking_id, invoice_number, invoice_id, recipient, recipient_name,
       category, entry_type, amount_minor, currency, description, source, reference, created_at)
    VALUES (?1, ?2, NULL, NULL, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'expense_approved', ?10, ?11)
    ON CONFLICT(booking_id, entry_type, reference) DO UPDATE SET
      amount_minor = excluded.amount_minor,
      currency     = excluded.currency,
      description  = excluded.description,
      recipient_name = excluded.recipient_name,
      created_at   = excluded.created_at`;

  // created_at carries the expense's own Paid On, not the moment the webhook
  // fired. A receipt entered in October for a repair paid in July belongs in
  // July, or every statement period is decided by when somebody got round to
  // typing it in.
  await env.LEDGER_DB.prepare(sql).bind(
    locationId, row.bookingId, row.recipient, row.recipientName,
    row.category, row.entryType, row.amountMinor, row.currency,
    row.description, row.reference, `${row.paidOn}T00:00:00.000Z`
  ).run();
}

export async function handleExpenseApproved(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Expected JSON body" }, 400); }

  const locationId = (request.headers?.get?.("X-Location-Id") || body.locationId || "").trim();
  const secret = (request.headers?.get?.("X-Webhook-Secret") || body.secret || "").trim();
  if (unresolved(locationId)) return json({ error: "locationId is required" }, 400);

  const tenant = await env.TENANTS.get(locationId, { type: "json" });
  if (!tenant) return json({ error: `Unknown locationId: ${locationId}` }, 404);
  if (tenant.webhookSecret && secret !== tenant.webhookSecret) return json({ error: "Unauthorized" }, 401);
  if (!env.LEDGER_DB) return json({ error: "Ledger not configured (LEDGER_DB binding missing)" }, 500);

  const recordId = unresolved(body.recordId) ? null : String(body.recordId).trim();
  if (!recordId) return json({ ok: true, skipped: "no_record_id" });

  const pit = tenant.ghlPit || (tenant.ghlPitSecretName && env[tenant.ghlPitSecretName]);
  if (!pit) return json({ error: "No GHL PIT configured for this tenant" }, 500);

  // Re-read from GHL rather than trusting the webhook body. A workflow sends
  // whatever merge tags it was configured with, and this writes money -- the
  // record is the only thing that knows what it currently says.
  let record;
  try {
    record = await fetchExpenseRecord(pit, locationId, recordId);
  } catch (err) {
    if (err.status === 404) return json({ ok: true, skipped: "record_not_found", recordId });
    return json({ error: err.message }, 502);
  }

  const { row, skip } = ownerLedgerRowFor(record, recordId);
  // 200 on every skip, deliberately. This is a workflow step: a non-2xx marks
  // the run failed in GHL and invites a retry that would skip identically.
  if (skip) return json({ ok: true, skipped: skip, recordId });

  await upsertOwnerExpense(env, locationId, row);
  return json({
    ok: true, posted: true, recordId,
    entryType: row.entryType, amountMinor: row.amountMinor, currency: row.currency, paidOn: row.paidOn,
  });
}
