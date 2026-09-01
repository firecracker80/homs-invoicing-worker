// ledger.js
// Materializes the money split into D1 ledger_entries rows at settlement
// time (called from payment.js's settle()). A statement is a plain
// GROUP BY over these written facts (see reports.js) -- not a recomputation
// of booking-composer's split logic a second time in SQL.
//
// amount_minor is an INTEGER in minor currency units (cents) -- D1/SQLite
// has no fixed-point decimal type, and floats drift under repeated
// aggregation across a statement period.
//
// Non-blocking by design, same philosophy as the Airtable mirror in
// index.js/payment.js: a D1 write failure must never roll back or fail a
// completed settlement. The caller logs and moves on.

const toMinor = n => Math.round(Number(n) * 100);
const round2 = n => Math.round(n * 100) / 100;

export async function writeLedgerEntries(env, tenant, snapshot, captures) {
  if (!env.LEDGER_DB) return { ok: false, reason: "no_ledger_db_binding" };

  const cur = tenant.currency || "USD";
  const basis = snapshot.payout.basis;
  const rows = [];

  // Which named individual each role resolves to for this booking's property
  // -- a tenant with several owners/managers needs this to tell their
  // statements apart; a tenant with just one of each can leave it unset and
  // every row for that role just carries a null recipient_name.
  const ownerName = snapshot.payout.ownerName ?? null;
  const managerName = snapshot.payout.managerName ?? null;

  // 1. Owner's rent split -- income
  rows.push({
    recipient: "owner", recipientName: ownerName, category: "income", entry_type: "rent_split_owner",
    amount: snapshot.payout.owner,
    description: `Rent split ${Math.round(snapshot.payout.ownerPct * 100)}% of $${basis.toFixed(2)}`
  });

  // 2. Manager's rent split -- income
  rows.push({
    recipient: "manager", recipientName: managerName, category: "income", entry_type: "rent_split_manager",
    amount: snapshot.payout.manager,
    description: `Rent split ${Math.round((1 - snapshot.payout.ownerPct) * 100)}% of $${basis.toFixed(2)}`
  });

  // 3. Cleaning fee -- income to whoever the profile says (owner or manager)
  if (snapshot.charges.cleaningFee > 0) {
    const cleaningTo = snapshot.payout.cleaningFeeTo === "owner" ? "owner" : "manager";
    rows.push({
      recipient: cleaningTo, recipientName: cleaningTo === "owner" ? ownerName : managerName,
      category: "income", entry_type: "cleaning_fee",
      amount: snapshot.charges.cleaningFee,
      description: "Cleaning fee"
    });
  }

  // 4. Security deposit -- liability, held pending inspection, never split,
  // excluded from income. Only if a deposit was actually captured.
  if (captures?.DEP && snapshot.securityDeposit.total > 0) {
    rows.push({
      recipient: "guest", category: "liability", entry_type: "deposit_held",
      amount: snapshot.securityDeposit.total,
      description: "Security deposit held pending inspection"
    });
  }

  // 5. Processing fee -- pass-through, retained by whoever received the
  // funds (the tenant's own gateway account), never split, excluded from income.
  if (snapshot.charges.processingFee > 0) {
    const feePct = snapshot.charges.feePct ?? tenant.processingFeePct ?? 0;
    rows.push({
      recipient: "platform", category: "pass_through", entry_type: "processing_fee",
      amount: snapshot.charges.processingFee,
      description: `Guest-paid processing fee (${(feePct * 100).toFixed(1)}%)`
    });
  }

  // 6. Shadow OTA commission -- informational only, no real money moved.
  // Skipped entirely unless the tenant has actually configured a rate --
  // never guess a commission percentage on a client's behalf.
  if (tenant.otaRate > 0) {
    rows.push({
      recipient: "owner", recipientName: ownerName, category: "shadow", entry_type: "shadow_ota_commission",
      amount: round2(tenant.otaRate * basis),
      description: `What a ${Math.round(tenant.otaRate * 100)}% OTA commission would have cost on this booking`
    });
  }

  const now = new Date().toISOString();
  const invoiceId = snapshot.ghlInvoice?.invoiceId || null;
  const sql = `INSERT OR IGNORE INTO ledger_entries
    (location_id, booking_id, invoice_number, invoice_id, recipient, recipient_name, category, entry_type, amount_minor, currency, description, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  try {
    // OR IGNORE + the (booking_id, entry_type) unique index makes this safe
    // to call more than once for the same booking -- a retry just no-ops on
    // rows already written, never double-counts.
    const stmts = rows.map(r => env.LEDGER_DB.prepare(sql).bind(
      snapshot.locationId, snapshot.bookingId, null, invoiceId,
      r.recipient, r.recipientName ?? null, r.category, r.entry_type, toMinor(r.amount), cur,
      r.description, "payment_confirmed", now
    ));
    await env.LEDGER_DB.batch(stmts);
    return { ok: true, rowsWritten: stmts.length };
  } catch (err) {
    return { ok: false, reason: "d1_write_failed", error: err.message };
  }
}
