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
import { fetchAllObjectRecords, fetchContactName } from "./ghl.js";

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
// Which owner an expense belongs to.
//
// There is no owner field on an expense, and the first version of this read a
// `p.owner_name` that does not exist -- so every row carried a null name. On a
// single-owner account nothing showed, which is exactly why it survived review.
// On an account with several owners it would have put one owner's repair on
// another owner's statement.
//
// The expense knows its PROPERTY, and the tenant record knows each property's
// owner, which is the same chain composeBooking already walks for a rent split.
// Resolved the same way deliberately: an expense and a booking on the same
// property must never disagree about whose it is.
// The contact ids this expense could resolve an owner from, best first.
//
// Yari, 2026-10-07: "since the custom values only capture 1 owner name, did the
// merger fix how to capture various owner names? my suggestion would be to tag
// them." It did not, and tags turn out not to be needed: GHL already carries
// this as two LABELLED associations, which beats a tag because it is a typed
// relation to a real contact rather than a string somebody has to keep spelling
// the same way.
//
//   expense_owner    contact <-> expenses, labelled "Owner"
//   property_owner   contact <-> properties, labelled "Owner"
//
// The expense's own link comes first because it is the more specific statement
// and because handleCreateExpense already sets it. The property's is the
// fallback for an expense created anywhere else -- the GHL form, an import, a
// workflow -- which is most of them.
export function ownerContactIdsFor(record, propertyOwners) {
  const ids = [];
  const own = (record?.relations || []).find((r) => r.objectKey === "contact");
  if (own?.recordId) ids.push(own.recordId);
  const propLink = (record?.relations || []).find((r) => r.objectKey === "custom_objects.properties");
  const viaProperty = propLink && propertyOwners.get(propLink.recordId);
  if (viaProperty && !ids.includes(viaProperty)) ids.push(viaProperty);
  return ids;
}

export function ownerNameFor(record, propertyNames, tenant, contactNames = new Map(), propertyOwners = new Map()) {
  // A real contact on the record beats anything configured, because it is what
  // somebody actually linked rather than what was typed into a custom value
  // once at provisioning.
  for (const id of ownerContactIdsFor(record, propertyOwners)) {
    const name = contactNames.get(id);
    if (name) return name;
  }

  const link = (record?.relations || []).find((r) => r.objectKey === "custom_objects.properties");
  const propertyName = link && propertyNames.get(link.recordId);
  // Then the hand-kept per-property map, then the account-wide name. An account
  // with one owner has no map, finds nothing, and keeps the name it already had.
  return (propertyName && tenant?.propertyOwnerNames?.[propertyName]) || tenant?.ownerName || null;
}

export function ownerLedgerRowFor(record, recordId, ownerName = null) {
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
      recipientName: ownerName,
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
export async function reconcileOwnerExpenses(env, locationId, records, {
  propertyNames = new Map(), propertyOwners = new Map(), contactNames = new Map(), tenant = null,
} = {}) {
  const want = new Map();
  const skipped = {};
  for (const rec of records) {
    const id = rec?.id;
    if (!id) continue;
    const { row, skip } = ownerLedgerRowFor(
      rec, id, ownerNameFor(rec, propertyNames, tenant, contactNames, propertyOwners));
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

  // Property names, so each expense can be traced to its owner. Only worth
  // fetching when something actually needs attributing; an account whose
  // expenses are all the manager's pays nothing for this.
  let propertyNames = new Map();
  let propertyOwners = new Map();
  let contactNames = new Map();

  const ownerBorne = records.filter((r) => String(r?.properties?.paid_by || "").toLowerCase() === "owner");
  if (ownerBorne.length) {
    try {
      const props = await fetchAllObjectRecords(pit, locationId, "custom_objects.properties");
      // The filter is defensive, not load-bearing: a nameless property mapped to
      // its own id would still miss propertyOwnerNames, which is keyed by name,
      // and fall back identically. No test can tell the two apart and none
      // pretends to -- it is here so the map never claims a name it does not
      // have, which would mislead anyone reading it later.
      propertyNames = new Map(props.map((r) => [r.id, r?.properties?.property_name]).filter(([, n]) => n));
      propertyOwners = new Map(props
        .map((r) => [r.id, (r?.relations || []).find((x) => x.objectKey === "contact")?.recordId])
        .filter(([, c]) => c));
    } catch {
      // A name nobody can resolve is better than no statement at all: the rows
      // still post, carrying the account-wide owner, which is correct on every
      // account that has one.
    }

    // Only the contacts actually referenced, which on a real account is a
    // handful however many contacts it holds. Fetched in parallel because each
    // is an independent lookup and a statement should not wait on them in turn.
    const ids = [...new Set(ownerBorne.flatMap((r) => ownerContactIdsFor(r, propertyOwners)))];
    const names = await Promise.all(ids.map((id) => fetchContactName(pit, id)));
    contactNames = new Map(ids.map((id, i) => [id, names[i]]).filter(([, n]) => n));
  }

  const result = await reconcileOwnerExpenses(env, locationId, records,
    { propertyNames, propertyOwners, contactNames, tenant });
  // 200 even when nothing was posted, deliberately. This is a workflow step: a
  // non-2xx marks the run failed in GHL and invites a retry that would do the
  // same work to the same effect.
  return json({ ok: true, locationId, read: records.length, ...result });
}
