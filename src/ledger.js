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
//
// GHL sync (added 2026-09-11): the SAME rows this function computes for D1
// are also written into the tenant's own GHL account as custom_objects.payments
// records, linked to a custom_objects.transactions record for this booking.
// D1 stays the durable ledger; GHL is what feeds the admin dashboard's Owner
// Statement, since the dashboard already reads GHL objects and already has
// the Property/OTA/Guest associations in place. GHL sync is equally
// non-blocking -- a failure here never affects D1 or the settlement itself.

import {
  fetchAllObjectRecords, createObjectRecord, fetchAssociations, linkIfPossible, findRecordByName,
} from "./ghl.js";

const toMinor = n => Math.round(Number(n) * 100);
const round2 = n => Math.round(n * 100) / 100;

function resolveSecret(tenant, env, nameKey, inlineKey) {
  if (tenant[nameKey] && env[tenant[nameKey]]) return env[tenant[nameKey]];
  return tenant[inlineKey];
}

export async function writeLedgerEntries(env, tenant, snapshot, captures) {
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

  let d1 = { ok: false, reason: "no_ledger_db_binding" };
  if (env.LEDGER_DB) {
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
      d1 = { ok: true, rowsWritten: stmts.length };
    } catch (err) {
      d1 = { ok: false, reason: "d1_write_failed", error: err.message };
    }
  }

  const ghl = await syncRowsToGHL(env, tenant, snapshot, rows, now);

  return { ok: d1.ok, d1, ghl };
}

// Writes the same rows into the tenant's own GHL account: one Transaction
// record per booking (created once, reused on retry via snapshot.ghl.transactionId),
// one Payment record per ledger row, each linked to that Transaction.
async function syncRowsToGHL(env, tenant, snapshot, rows, now) {
  try {
    const pit = resolveSecret(tenant, env, "ghlPitSecretName", "ghlPit");
    if (!pit) return { ok: false, reason: "no_ghl_pit_configured" };
    const locationId = snapshot.locationId;

    let transactionId = snapshot.ghl?.transactionId || null;
    let associations = null;

    if (!transactionId) {
      const [properties, otaChannels, assocs] = await Promise.all([
        fetchAllObjectRecords(pit, locationId, "custom_objects.properties"),
        fetchAllObjectRecords(pit, locationId, "custom_objects.ota_channels"),
        fetchAssociations(pit, locationId),
      ]);
      associations = assocs;
      const property = findRecordByName(properties, "property_name", snapshot.propertyCode);
      const otaChannel = findRecordByName(otaChannels, "channel_name", snapshot.bookingSource);

      // No OTA platform fee applies to a directly-booked, PayPal/Stripe-settled
      // reservation -- the guest-paid processing fee covers the gateway's own
      // cut, so net payout to the business is the full rent+cleaning total.
      const bookingTotal = round2(snapshot.charges.rentTotal + snapshot.charges.cleaningFee);
      const transaction = await createObjectRecord(pit, locationId, "custom_objects.transactions", {
        transaction_name: `${snapshot.guest?.name || "Guest"} — ${snapshot.stay.checkIn}`,
        guest_name: snapshot.guest?.name || "",
        checkin_date: snapshot.stay.checkIn,
        checkout_date: snapshot.stay.checkOut,
        booking_reference: snapshot.bookingId,
        booking_total: { value: bookingTotal, currency: "default" },
        platform_fee: { value: 0, currency: "default" },
        net_payout: { value: bookingTotal, currency: "default" },
        payment_status: "paid",
      });
      transactionId = transaction.id;

      if (property) await linkIfPossible(pit, locationId, associations, "custom_objects.transactions", transactionId, "custom_objects.properties", property.id);
      if (otaChannel) await linkIfPossible(pit, locationId, associations, "custom_objects.transactions", transactionId, "custom_objects.ota_channels", otaChannel.id);
      if (snapshot.ghlContactId) await linkIfPossible(pit, locationId, associations, "custom_objects.transactions", transactionId, "contact", snapshot.ghlContactId);
    } else {
      associations = await fetchAssociations(pit, locationId);
    }

    const paymentIds = [];
    for (const r of rows) {
      const payment = await createObjectRecord(pit, locationId, "custom_objects.payments", {
        payment_reference: `${snapshot.bookingId}-${r.entry_type}`,
        payment_type: r.entry_type,
        recipient: r.recipient,
        recipient_name: r.recipientName || "",
        category: r.category,
        amount: { value: r.amount, currency: "default" },
        payment_status: "paid",
        // Only real payable income clears for payout -- liabilities (deposit
        // held), pass-throughs (processing fee), and shadow/informational
        // rows never do.
        cleared_for_payout: r.category === "income" ? "yes" : "no",
        processed_at: now.slice(0, 10),
        notes: r.description,
      });
      paymentIds.push(payment.id);
      await linkIfPossible(pit, locationId, associations, "custom_objects.payments", payment.id, "custom_objects.transactions", transactionId);
    }

    return { ok: true, transactionId, paymentIds };
  } catch (err) {
    return { ok: false, reason: "ghl_sync_failed", error: err.message };
  }
}
