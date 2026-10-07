// ledger.js
// Materializes money movements into D1 ledger_entries rows, and syncs the
// same rows into the tenant's own GHL account. Two entry points:
//   writeLedgerEntries()  -- settlement (called from payment.js's settle())
//   writeAndSyncRows()    -- shared writer, also called directly by
//                            cancellation.js/reschedule.js for refunds,
//                            cancellation charges, and reschedule adjustments
//
// amount_minor is an INTEGER in minor currency units (cents) -- D1/SQLite
// has no fixed-point decimal type, and floats drift under repeated
// aggregation across a statement period.
//
// Non-blocking by design: a D1 or GHL write failure must never roll back or
// fail money that has already moved. Every caller logs and moves on.
//
// GHL sync (added 2026-09-11): the same rows written to D1 are also written
// into custom_objects.payments (labeled "Revenue" in GHL since 2026-09-21) in
// the tenant's own GHL account, linked to a
// custom_objects.transactions record for the booking. D1 stays the durable
// ledger; GHL is what feeds the admin dashboard's Owner Statement, since the
// dashboard already reads GHL objects and already has the Property/OTA/
// Guest associations in place.
//
// `reference` (added 2026-09-12, schema/002_ledger_add_reference.sql): the
// original (booking_id, entry_type) unique index could tell whether *a* row
// of that type existed for a booking, but not which specific event it was --
// fine for settlement (happens once per booking) but not for refunds/
// reschedules, which can recur on the same booking. Every row now carries a
// `reference` -- ideally the gateway capture/refund id, since that's a real,
// naturally-unique idempotency key; callers without one fall back to a
// caller-supplied constant. Rows that omit it entirely default to their own
// entry_type, preserving the original settlement behavior untouched.

import {
  fetchAllObjectRecords, createObjectRecord, fetchAssociations, linkIfPossible, findRecordByName,
  propertyContactsFor, fetchContactName,
} from "./ghl.js";

const toMinor = n => Math.round(Number(n) * 100);
const round2 = n => Math.round(n * 100) / 100;

// The bookingSource values that mean "no platform was involved". composeBooking
// defaults to "Direct"; the others are what a hand-entered or imported booking
// tends to carry for the same thing.
const DIRECT_SOURCES = new Set(["direct", "direct booking", "directo", "website", "manual", ""]);
const isDirectSource = (source) => DIRECT_SOURCES.has(String(source ?? "").trim().toLowerCase());

// "15.5%", and "15%" rather than "15.0%". This is read by prospects.
const formatPct = (rate) => `${Number((rate * 100).toFixed(1))}%`;

// What the Transaction record's booking_total and net_payout hold.
//
// Rent, the pet fee and cleaning, and deliberately NOT the processing fee or
// the deposit: the fee is the guest paying the gateway's cut and the deposit is
// the guest's own money held, so neither is revenue. The pet fee is (Yari,
// 2026-09-29: it is part of the rent price), and was missing from this for as
// long as this existed -- a booking with one reported a total lower than the
// guest had paid, on the record everybody reads.
//
// Exported because a reschedule has to recompute it and settlement has to write
// it, and those two being separate expressions of the same rule is exactly how
// the record went stale in the first place -- a duration change moved the dates
// on the Transaction and left the money at whatever the original booking cost.
// petFee is the name this held for the day between the pet fee becoming
// revenue and every add-on becoming revenue. A snapshot has one or the other,
// never both, so summing both is how bookings already in KV keep their totals.
export const bookingTotalOf = (snapshot) =>
  round2(snapshot.charges.rentTotal + earnedAddOns(snapshot) + snapshot.charges.cleaningFee);

export const earnedAddOns = (snapshot) =>
  round2((snapshot.charges?.addOns || 0) + (snapshot.charges?.petFee || 0));

function resolveSecret(tenant, env, nameKey, inlineKey) {
  if (tenant[nameKey] && env[tenant[nameKey]]) return env[tenant[nameKey]];
  return tenant[inlineKey];
}

// Who this booking's property belongs to, read from GHL rather than from
// configuration.
//
// propertyOwnerNames and propertyManagerNames are maps in the tenant record that
// nothing populates, so an account with several owners or several managers meant
// hand-editing KV. GHL already carries both as labelled associations to real
// contacts -- property_owner, and property_manager since 2026-10-07 -- which is
// better than a configured string because somebody maintains it as part of
// running the business rather than as a deployment chore.
//
// Returns only what it is sure of. Every failure here falls back to the
// configured names, which is what every account uses today.
export async function resolvePayoutNamesFromGhl(pit, locationId, propertyCode) {
  if (!pit || !locationId || !propertyCode) return {};
  try {
    const [properties, associations] = await Promise.all([
      fetchAllObjectRecords(pit, locationId, "custom_objects.properties"),
      fetchAssociations(pit, locationId),
    ]);
    const property = findRecordByName(properties, "property_name", propertyCode);
    if (!property) return {};

    const { ownerContactId, managerContactId } = propertyContactsFor(property, associations);
    const [ownerName, managerName] = await Promise.all([
      ownerContactId ? fetchContactName(pit, ownerContactId) : null,
      managerContactId ? fetchContactName(pit, managerContactId) : null,
    ]);
    return { ownerName: ownerName || undefined, managerName: managerName || undefined };
  } catch {
    return {};
  }
}

export async function writeLedgerEntries(env, tenant, snapshot, captures) {
  const basis = snapshot.payout.basis;
  const rows = [];

  // Which named individual each role resolves to for this booking's property
  // -- a tenant with several owners/managers needs this to tell their
  // statements apart; a tenant with just one of each can leave it unset and
  // every row for that role just carries a null recipient_name.
  //
  // A contact linked on the property wins over a configured name: somebody
  // linked it while running the business, where a custom value was typed once at
  // provisioning and never revisited.
  //
  // Looked up every time, not only when the configured names are missing. The
  // first version skipped it whenever both were already set, which saved two
  // calls and defeated the entire point -- a configured name can only be
  // overridden by something that bothers to look. The lookup returns {} without
  // a request when there is no PIT or no property, and every failure inside it
  // falls back, so the cost is two reads on a path that already makes many and
  // the risk to a settlement is none.
  const fromGhl = await resolvePayoutNamesFromGhl(
    resolveSecret(tenant, env, "ghlPitSecretName", "ghlPit"), snapshot.locationId, snapshot.propertyCode);

  const ownerName = fromGhl.ownerName ?? snapshot.payout.ownerName ?? null;
  const managerName = fromGhl.managerName ?? snapshot.payout.managerName ?? null;

  // Written back onto the snapshot, not just held locally. nameFor() fills any
  // row that did not set a name of its own from snapshot.payout -- so a resolved
  // name that stayed a local would reach the rows named explicitly below and
  // none of the others, putting two different names on one statement.
  snapshot.payout.ownerName = ownerName;
  snapshot.payout.managerName = managerName;

  // 1. Owner's rent split -- income
  rows.push({
    recipient: "owner", recipientName: ownerName, category: "income", entry_type: "rent_split_owner",
    amount: snapshot.payout.owner, source: "payment_confirmed",
    description: `Rent split ${Math.round(snapshot.payout.ownerPct * 100)}% of $${basis.toFixed(2)}`
  });

  // 2. Manager's rent split -- income
  rows.push({
    recipient: "manager", recipientName: managerName, category: "income", entry_type: "rent_split_manager",
    amount: snapshot.payout.manager, source: "payment_confirmed",
    description: `Rent split ${Math.round((1 - snapshot.payout.ownerPct) * 100)}% of $${basis.toFixed(2)}`
  });

  // 3. Cleaning fee -- income to whoever the profile says (owner or manager)
  if (snapshot.charges.cleaningFee > 0) {
    const cleaningTo = snapshot.payout.cleaningFeeTo === "owner" ? "owner" : "manager";
    rows.push({
      recipient: cleaningTo, recipientName: cleaningTo === "owner" ? ownerName : managerName,
      category: "income", entry_type: "cleaning_fee", source: "payment_confirmed",
      amount: snapshot.charges.cleaningFee,
      description: "Cleaning fee"
    });
  }

  // 4. Security deposit -- liability, held pending inspection, never split,
  // excluded from income. Only if a deposit was actually captured.
  if (captures?.DEP && snapshot.securityDeposit.total > 0) {
    rows.push({
      recipient: "guest", category: "liability", entry_type: "deposit_held", source: "payment_confirmed",
      amount: snapshot.securityDeposit.total,
      description: "Security deposit held pending inspection"
    });
  }

  // 5. Processing fee -- pass-through, retained by whoever received the
  // funds (the tenant's own gateway account), never split, excluded from income.
  if (snapshot.charges.processingFee > 0) {
    const feePct = snapshot.charges.feePct ?? tenant.processingFeePct ?? 0;
    rows.push({
      recipient: "platform", category: "pass_through", entry_type: "processing_fee", source: "payment_confirmed",
      amount: snapshot.charges.processingFee,
      description: `Guest-paid processing fee (${(feePct * 100).toFixed(1)}%)`
    });
  }

  // 6. Shadow OTA commission -- informational only, no real money moved, and
  // excluded from incomeTotal on every statement.
  //
  // Written only when a tenant has actually configured a rate. A flat default
  // of 15.5% shipped on 2026-09-28 and was reverted the next day, for a reason
  // worth keeping written down: it conflated two different things.
  //
  // A booking that CAME FROM an OTA has a real commission, at that channel's
  // real rate. Applying one invented percentage to it is wrong, and the right
  // number is already recorded -- custom_objects.ota_channels has a
  // commission_rate field, and findRecordByName below resolves that very
  // channel record for snapshot.bookingSource. The rate sits one field away
  // from code that was already fetching it.
  //
  // A DIRECT booking has no commission at all. "What Airbnb would have charged"
  // is a marketing comparison, and if it is worth showing it should quote the
  // tenant's own recorded Airbnb rate rather than a constant in this file --
  // then it moves when their rate does, and it is their number to defend.
  //
  // Both are still to build, and the open question ahead of either is whether
  // the rent the Worker sees on an OTA booking is gross or already net of the
  // channel's cut. Booking a commission on a net figure would double-count it.
  const otaRate = tenant.otaRate ?? 0;
  if (otaRate > 0) {
    rows.push({
      recipient: "owner", recipientName: ownerName, category: "shadow", entry_type: "shadow_ota_commission",
      amount: round2(otaRate * basis), source: "payment_confirmed",
      // Math.round rendered 0.155 as "16%" beside an amount computed at 15.5%
      // -- a line arguing with itself, on the one figure meant to be shown to
      // prospects. One decimal, and no trailing ".0" on a whole number.
      description: `What a ${formatPct(otaRate)} OTA commission would have cost on this booking`
    });
  }

  return writeAndSyncRows(env, tenant, snapshot, rows);
}

// Shared writer: takes fully-built rows ({ recipient, recipientName?,
// category, entry_type, amount, description, source, reference? }) and
// writes them to D1 + syncs them to GHL. `reference` should be the gateway
// capture/refund id when one exists (the natural idempotency key); rows that
// omit it default to their own entry_type, which is exactly the original
// (booking_id, entry_type) behavior for settlement's one-row-per-type rows.
// What real payment a Revenue row came from: a refund's own id when the row
// carries one, otherwise the settlement capture -- GHL's native payment id for
// an invoice paid in GHL, the PayPal/Stripe capture id for our own links.
function gatewayRefFor(snapshot, r) {
  if (r.source && r.source !== "payment_confirmed") {
    return r.reference && r.reference !== r.entry_type && !/^(cancellation|reschedule)$/.test(r.reference) ? r.reference : "";
  }
  const cap = r.entry_type === "deposit_held" ? (snapshot.captures?.DEP || snapshot.captures?.RENT) : snapshot.captures?.RENT;
  return cap?.gatewayTransactionId || cap?.captureId || cap?.invoiceId || "";
}

// The name on a row, filled in here rather than at each of the fifteen places
// that build one.
//
// Settlement sets recipientName explicitly. Nothing else did -- every row from
// cancellation.js and reschedule.js went in with it null. That did not matter
// while propertyOwnerNames was broken (fixed in #89), because nobody could
// scope a statement by name. The moment they could, it mattered a great deal:
// queryStatement filters with `recipient_name = ?`, a SQL equality, and NULL
// matches nothing. So Elena's statement showed her 629.00 of rent and neither
// the 629.00 reversal nor the 157.25 cancellation charge -- she would have read
// it as owed 629.00 when she was owed 157.25.
//
// Filled at the boundary instead of at the call sites on purpose: it covers
// every row type that exists and every one added later, and there is no
// sixteenth place to forget.
//
// guest and platform rows stay unnamed. Neither is a statement recipient, and
// giving them a name would put the deposit and the gateway's cut on somebody's
// statement.
const nameFor = (row, snapshot) => row.recipientName ?? (
  row.recipient === "owner" ? snapshot.payout?.ownerName :
  row.recipient === "manager" ? snapshot.payout?.managerName : null
) ?? null;

export async function writeAndSyncRows(env, tenant, snapshot, rows) {
  const cur = tenant.currency || "USD";
  const now = new Date().toISOString();
  const invoiceId = snapshot.ghlInvoice?.invoiceId || null;

  let d1 = { ok: false, reason: "no_ledger_db_binding" };
  if (env.LEDGER_DB) {
    const sql = `INSERT OR IGNORE INTO ledger_entries
      (location_id, booking_id, invoice_number, invoice_id, recipient, recipient_name, category, entry_type, amount_minor, currency, description, source, reference, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    try {
      // OR IGNORE + the (booking_id, entry_type, reference) unique index
      // makes this safe to call more than once for the same event -- a
      // retry just no-ops on rows already written, never double-counts.
      // Different events of the same entry_type on the same booking (e.g.
      // two separate partial refunds) get distinct references instead.
      const stmts = rows.map(r => env.LEDGER_DB.prepare(sql).bind(
        snapshot.locationId, snapshot.bookingId, null, invoiceId,
        r.recipient, nameFor(r, snapshot), r.category, r.entry_type, toMinor(r.amount), cur,
        r.description, r.source || "payment_confirmed", r.reference || r.entry_type, now
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
// record per booking (created once at settlement, reused on every later call
// via snapshot.ghl.transactionId), one Payment record per row, each linked
// to that Transaction.
async function syncRowsToGHL(env, tenant, snapshot, rows, now) {
  try {
    const pit = resolveSecret(tenant, env, "ghlPitSecretName", "ghlPit");
    if (!pit) return { ok: false, reason: "no_ghl_pit_configured" };
    const locationId = snapshot.locationId;

    let transactionId = snapshot.ghl?.transactionId || null;
    let associations = null;
    const unlinked = [];

    if (!transactionId) {
      const [properties, otaChannels, assocs] = await Promise.all([
        fetchAllObjectRecords(pit, locationId, "custom_objects.properties"),
        fetchAllObjectRecords(pit, locationId, "custom_objects.ota_channels"),
        fetchAssociations(pit, locationId),
      ]);
      associations = assocs;
      const property = findRecordByName(properties, "property_name", snapshot.propertyCode);
      const otaChannel = findRecordByName(otaChannels, "channel_name", snapshot.bookingSource);

      // A Transaction carries no property NAME of its own -- the dashboard
      // resolves it entirely through this relation. So a lookup that finds
      // nothing shows up as a booking with a blank property and no other clue,
      // and on 2026-09-26 that cost two sessions to trace back to a webhook
      // sending the guest's name in the property field.
      //
      // Linking to a guessed property would be worse than not linking, so the
      // behaviour is unchanged: it still skips. What changes is that it says so.
      // The same value keys per-property owner and manager names, so a bad one
      // also silently addresses statements to the account default instead.
      if (!property) {
        unlinked.push({
          object: "custom_objects.properties",
          lookedFor: snapshot.propertyCode ?? null,
          field: "property_name",
          reason: snapshot.propertyCode ? "no_property_record_with_that_name" : "no_propertyCode_on_booking",
          consequence: "dashboard shows no property for this booking, and per-property owner/manager names fall back to the account default",
        });
      }
      // "Direct" is not a channel and never will be: money from a booking
      // platform goes to the client directly and never passes through GHL, so
      // an OTA booking produces no invoice and never reaches this code at all.
      // Every booking that gets here is direct, which made this warn on all of
      // them -- an unlinked report that fires every time is one nobody reads,
      // and it was crowding out the property misses that do matter.
      if (!otaChannel && snapshot.bookingSource && !isDirectSource(snapshot.bookingSource)) {
        unlinked.push({
          object: "custom_objects.ota_channels",
          lookedFor: snapshot.bookingSource,
          field: "channel_name",
          reason: "no_ota_channel_record_with_that_name",
          consequence: "booking is not attributed to a channel",
        });
      }

      // No OTA platform fee applies to a directly-booked, PayPal/Stripe-settled
      // reservation -- the guest-paid processing fee covers the gateway's own
      // cut, so net payout to the business is the full rent+cleaning total.
      const bookingTotal = bookingTotalOf(snapshot);
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
        recipient_name: nameFor(r, snapshot) || "",
        category: r.category,
        // D1 keeps the signed amount (negative = income reversal, for the
        // SUM math statements run on it); GHL just shows how much moved --
        // the entry_type/category already say which direction.
        amount: { value: Math.abs(r.amount), currency: "default" },
        payment_status: "paid",
        // Only real payable income clears for payout -- liabilities (deposit
        // held), pass-throughs (processing fee), and shadow/informational
        // rows never do.
        cleared_for_payout: r.category === "income" ? "yes" : "no",
        processed_at: now.slice(0, 10),
        notes: r.description,
        gateway_transaction_id: gatewayRefFor(snapshot, r),
      });
      paymentIds.push(payment.id);
      await linkIfPossible(pit, locationId, associations, "custom_objects.payments", payment.id, "custom_objects.transactions", transactionId);
    }

    // Reported alongside a successful sync, not instead of one: the rows were
    // written and the Transaction exists. Something just is not joined to it.
    return { ok: true, transactionId, paymentIds, unlinked };
  } catch (err) {
    return { ok: false, reason: "ghl_sync_failed", error: err.message };
  }
}
