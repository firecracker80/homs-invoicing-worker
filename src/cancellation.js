// cancellation.js — cancellation engine + post-checkout deposit refunds.
// Admin-triggered (no guest-facing link exists for rental calendars):
//   POST /cancel          { bookingId, override?, reason? }   header: X-Admin-Secret
//   POST /deposit/refund  { bookingId, claimAmount?, reason? } header: X-Admin-Secret
//
// Rent retained on cancellation depends on the tenant (policy.js, 2026-09-16):
//   default            → the tenant's own cancellationPolicy; none = full refund
//   "tiered_legacy"    → Luminara's ladder below, unchanged
//
// Legacy policy (confirmed 2026-07-18, already-checked-in tier added 2026-08-07):
//   Charge basis: RENT ONLY. Tiers by time before check-in (3PM local, configurable):
//     already checked in → 100% (common practice: those nights can't be resold)
//     < 24 hrs           → 50%
//     24 hrs – 5 days    → 30%
//     > 5 days           → 20%
//   Deposit: always 100% refunded on cancellation. Cleaning: 100% refunded.
//   Processing fee: non-refundable. Cancellation charge splits per profile (85/15).
//   override: "full_refund" → documented exceptions (refund rent+cleaning+deposit; fee still retained).
//   The same tier ladder (cancellationTier, below) is reused by reschedule.js:
//   shortening a paid stay is treated as a partial cancellation of the dropped
//   nights, charged at the same rate a full cancellation would be at that
//   notice period.

import { getAccessToken } from "./paypal.js";
import { writeAndSyncRows } from "./ledger.js";
import { updateObjectRecord } from "./ghl.js";
import { isLegacyPolicy, nativeCancellationPolicy } from "./policy.js";

const round2 = n => Math.round(n * 100) / 100;
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

function resolveSecret(tenant, env, nameKey, inlineKey) {
  if (tenant[nameKey] && env[tenant[nameKey]]) return env[tenant[nameKey]];
  return tenant[inlineKey];
}

function adminAuthorized(request, env, tenant) {
  const given = request.headers?.get?.("X-Admin-Secret") || "";
  const expected = tenant.adminSecret || env.ADMIN_SECRET;
  return expected && given === expected;
}

export { adminAuthorized, notifyGHL };

// ---- tier math ----
// Shared by /cancel (whole booking) and reschedule.js (partial cancellation
// of dropped nights). checkInDateStr is "YYYY-MM-DD" -- the CURRENT check-in
// on record, not a prospective new one.
export function cancellationTier(checkInDateStr, nowMs, tenant, override) {
  const checkInHour = tenant.checkInHour ?? 15;              // 3 PM
  const tzOffsetHours = tenant.tzOffsetHours ?? -4;          // AST
  const anchor = new Date(`${checkInDateStr}T00:00:00Z`).getTime()
    + (checkInHour - tzOffsetHours) * 3600000;               // check-in moment in UTC ms
  const hoursUntil = (anchor - nowMs) / 3600000;

  // Accept any affirmative form of the exception flag (form dropdowns send
  // human values: "Sí", "Yes", "true", checkbox "on", or the literal "full_refund")
  const isException = ["full_refund", "yes", "si", "sí", "true", "1", "on", "excepcion", "excepción"]
    .includes(String(override || "").trim().toLowerCase());

  if (isException) return { tier: "exception_full_refund", chargePct: 0, hoursUntil: round2(hoursUntil) };

  // Default tenants: their own policy, guest-friendly unless they set tiers.
  if (!isLegacyPolicy(tenant)) {
    const policy = nativeCancellationPolicy(tenant);
    if (hoursUntil < 0) return { tier: "already_checked_in", chargePct: policy.checkedInChargePct, hoursUntil: round2(hoursUntil) };
    const hit = policy.tiers.find(t => hoursUntil < t.underHours);
    return hit
      ? { tier: `under_${hit.underHours}h`, chargePct: hit.chargePct, hoursUntil: round2(hoursUntil) }
      : { tier: "full_refund", chargePct: 0, hoursUntil: round2(hoursUntil) };
  }

  // "tiered_legacy" (Luminara) -- unchanged.
  let chargePct, tier;
  // hoursUntil < 0 means the check-in moment has already passed -- the guest
  // is mid-stay (or a no-show past arrival). Common practice: those nights
  // aren't resellable on that notice, so nothing is refunded on them.
  if (hoursUntil < 0)        { chargePct = 1.00; tier = "already_checked_in"; }
  else if (hoursUntil < 24)  { chargePct = 0.50; tier = "under_24h"; }
  else if (hoursUntil < 120) { chargePct = 0.30; tier = "24h_to_5d"; }
  else                       { chargePct = 0.20; tier = "over_5d"; }

  return { tier, chargePct, hoursUntil: round2(hoursUntil) };
}

export function calcCancellation(snapshot, nowMs, tenant, override) {
  const { tier, chargePct, hoursUntil } = cancellationTier(snapshot.stay.checkIn, nowMs, tenant, override);

  const rent = snapshot.charges.rentTotal;
  const cleaning = snapshot.charges.cleaningFee;
  const deposit = snapshot.securityDeposit.total;
  const fee = snapshot.charges.processingFee ?? 0;

  const charge = round2(rent * chargePct);
  const rentRefund = round2(rent - charge);
  const ownerPct = snapshot.payout.ownerPct;
  const ownerCharge = round2(charge * ownerPct);
  const managerCharge = round2(charge - ownerCharge);

  return {
    tier, chargePct, hoursUntil: round2(hoursUntil),
    charge, rentRefund,
    cleaningRefund: cleaning,
    depositRefund: deposit,
    feeRetained: fee,
    rentUnitRefund: round2(rentRefund + cleaning),   // refunded against the RENT capture
    totalRefund: round2(rentRefund + cleaning + deposit),
    totalRetained: round2(charge + fee),
    payoutSplit: { owner: ownerCharge, manager: managerCharge }
  };
}

// ---- gateway refunds ----
async function refundPayPalCapture(tenant, env, captureId, amount, note) {
  const token = await getAccessToken(tenant, env);
  const body = amount != null
    ? { amount: { value: amount.toFixed(2), currency_code: tenant.currency || "USD" }, note_to_payer: note }
    : { note_to_payer: note }; // omit amount = full refund
  const res = await fetch(`${tenant.paypalApi}/v2/payments/captures/${captureId}/refund`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
      "PayPal-Request-Id": `refund-${captureId}-${amount ?? "full"}`
    },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`PayPal refund failed for ${captureId}: ${res.status} ${JSON.stringify(data)}`);
  return data.id; // refund id
}

async function refundStripe(tenant, env, captureId, amount, note) {
  const secret = resolveSecret(tenant, env, "stripeSecretName", "stripeSecret");
  const params = new URLSearchParams();
  // captureId for Stripe settlements is the charge id (ch_...) or payment_intent
  if (captureId.startsWith("pi_")) params.set("payment_intent", captureId);
  else params.set("charge", captureId);
  if (amount != null) params.set("amount", String(Math.round(amount * 100)));
  params.set("metadata[note]", note || "");
  const res = await fetch("https://api.stripe.com/v1/refunds", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${secret}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": `refund-${captureId}-${amount ?? "full"}`
    },
    body: params.toString()
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Stripe refund failed: ${res.status} ${JSON.stringify(data)}`);
  return data.id;
}

async function gatewayRefund(tenant, env, snapshot, captureId, amount, note) {
  return snapshot.gateway === "stripe"
    ? refundStripe(tenant, env, captureId, amount, note)
    : refundPayPalCapture(tenant, env, captureId, amount, note);
}

// ---- shared helpers ----
async function loadContext(request, env) {
  const body = await request.json();
  const snapshot = body.bookingId ? await env.BOOKINGS.get(body.bookingId, { type: "json" }) : null;
  if (!snapshot) {
    console.error(`Cancel/refund reject: Unknown bookingId. Raw body:`, JSON.stringify(body));
    return { error: json({ error: "Unknown bookingId", receivedBookingId: body.bookingId ?? null }, 404) };
  }
  const tenant = await env.TENANTS.get(snapshot.locationId, { type: "json" });
  if (!tenant) return { error: json({ error: "Unknown tenant" }, 404) };
  if (!adminAuthorized(request, env, tenant)) return { error: json({ error: "Unauthorized" }, 401) };
  return { body, snapshot, tenant };
}

// The Transaction record only exists once a booking has actually settled
// (payment.js's settle(), via ledger.js, is what creates it) -- an unpaid
// booking has none to update.
function resolveTransactionId(snapshot) {
  return snapshot.ghl?.transactionId || null;
}

async function notifyGHL(url, payload) {
  if (!url) return;
  try {
    await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  } catch (err) { console.error("GHL notify failed:", err.message); }
}

// =============================================================== /cancel ====
export async function handleCancel(request, env) {
  const ctx = await loadContext(request, env);
  if (ctx.error) return ctx.error;
  const { body, snapshot, tenant } = ctx;

  if (snapshot.cancelled) return json({ alreadyCancelled: true, cancellation: snapshot.cancellation });

  const now = Date.now();

  // ---- UNPAID booking: no refunds, just void ----
  if (!snapshot.settled) {
    snapshot.cancelled = true;
    snapshot.cancellation = { tier: "unpaid_void", at: new Date(now).toISOString(), reason: body.reason || "" };
    await env.BOOKINGS.put(snapshot.bookingId, JSON.stringify(snapshot));
    // No Transaction record exists yet for an unpaid booking, and no money
    // moved -- nothing to write to D1 or GHL here.
    await notifyGHL(tenant.ghlCancellationUrl, {
      event: "booking_cancelled", bookingId: snapshot.bookingId,
      contactId: snapshot.ghlContactId || "",
      email: snapshot.guest?.email || "", paid: false,
      refundTotal: "0.00", chargeTotal: "0.00",
      checkIn: snapshot.stay.checkIn, propertyName: snapshot.propertyCode || tenant.brandName
    });
    return json({ cancelled: true, paid: false, refunds: null });
  }

  // ---- PAID booking: tiered refunds ----
  const calc = calcCancellation(snapshot, now, tenant, body.override);
  const note = `Cancelación ${snapshot.bookingId} — reembolso según política`;

    const rentCaptureId = snapshot.captures?.RENT?.captureId;
  const depCaptureId = snapshot.captures?.DEP?.captureId;
  const refundIds = {};
  const refundFailures = [];

  if (calc.rentUnitRefund > 0) {
    if (!rentCaptureId) {
      refundFailures.push({ type: "rent_refund_needed_manual", amount: calc.rentUnitRefund });
    } else {
      try {
        refundIds.rent = await gatewayRefund(tenant, env, snapshot, rentCaptureId, calc.rentUnitRefund, note);
      } catch (err) {
        console.error(`Cancel rent refund failed for ${snapshot.bookingId}: ${err.message}`);
        refundFailures.push({ type: "rent_refund_failed", amount: calc.rentUnitRefund, error: err.message });
      }
    }
  }

  if (calc.depositRefund > 0) {
    if (!depCaptureId) {
      refundFailures.push({ type: "deposit_refund_needed_manual", amount: calc.depositRefund });
    } else {
      try {
        refundIds.deposit = await gatewayRefund(tenant, env, snapshot, depCaptureId,
          snapshot.gateway === "stripe" ? calc.depositRefund : null, note); // PayPal DEP = full refund
      } catch (err) {
        console.error(`Cancel deposit refund failed for ${snapshot.bookingId}: ${err.message}`);
        refundFailures.push({ type: "deposit_refund_failed", amount: calc.depositRefund, error: err.message });
      }
    }
  } // PayPal DEP = full refund

  // ---- snapshot ----
  snapshot.cancelled = true;
  snapshot.cancellation = {
    at: new Date(now).toISOString(), reason: body.reason || "",
    ...calc, refundIds
  };
  snapshot.securityDeposit.status = "refunded";
  snapshot.securityDeposit.refundedAmount = calc.depositRefund;
  snapshot.payout.status = "cancelled_adjusted";
  await env.BOOKINGS.put(snapshot.bookingId, JSON.stringify(snapshot));

  // ---- D1 + GHL ledger ----
  // Reverses the income originally booked at settlement (rent + cleaning
  // splits) and books the retained cancellation charge as new income, split
  // the same way the original rent was. Deposit refund is a liability
  // clearing (deposit was never counted as income), tracked for audit only.
  try {
    const ownerPct = snapshot.payout.ownerPct;
    const rows = [];

    if (refundIds.rent) {
      const ownerRentReversal = round2(calc.rentRefund * ownerPct);
      rows.push({
        recipient: "owner", category: "income", entry_type: "cancellation_rent_refund_owner",
        amount: -ownerRentReversal, reference: refundIds.rent, source: "cancellation",
        description: `Rent refund reversal (${Math.round(ownerPct * 100)}% share) — ${calc.tier}`
      });
      rows.push({
        recipient: "manager", category: "income", entry_type: "cancellation_rent_refund_manager",
        amount: -round2(calc.rentRefund - ownerRentReversal), reference: refundIds.rent, source: "cancellation",
        description: `Rent refund reversal (manager share) — ${calc.tier}`
      });
      if (calc.cleaningRefund > 0) {
        const cleaningTo = snapshot.payout.cleaningFeeTo === "owner" ? "owner" : "manager";
        rows.push({
          recipient: cleaningTo, category: "income", entry_type: "cancellation_cleaning_refund",
          amount: -calc.cleaningRefund, reference: refundIds.rent, source: "cancellation",
          description: "Cleaning fee refund reversal"
        });
      }
    }

    if (refundIds.deposit) {
      rows.push({
        recipient: "guest", category: "liability", entry_type: "cancellation_deposit_refund",
        amount: calc.depositRefund, reference: refundIds.deposit, source: "cancellation",
        description: "Security deposit returned on cancellation"
      });
    }

    if (calc.charge > 0) {
      rows.push({
        recipient: "owner", category: "income", entry_type: "cancellation_charge_owner",
        amount: calc.payoutSplit.owner, reference: "cancellation", source: "cancellation",
        description: `Cancellation charge ${Math.round(calc.chargePct * 100)}% (${calc.tier}), owner share`
      });
      rows.push({
        recipient: "manager", category: "income", entry_type: "cancellation_charge_manager",
        amount: calc.payoutSplit.manager, reference: "cancellation", source: "cancellation",
        description: `Cancellation charge ${Math.round(calc.chargePct * 100)}% (${calc.tier}), manager share`
      });
    }

    if (rows.length) {
      const result = await writeAndSyncRows(env, tenant, snapshot, rows);
      if (!result.d1.ok) console.error(`Cancellation D1 write failed for ${snapshot.bookingId}: ${result.d1.reason} ${result.d1.error || ""}`);
      if (!result.ghl.ok) console.error(`Cancellation GHL sync failed for ${snapshot.bookingId}: ${result.ghl.reason} ${result.ghl.error || ""}`);

      const transactionId = resolveTransactionId(snapshot);
      if (transactionId) {
        const pit = resolveSecret(tenant, env, "ghlPitSecretName", "ghlPit");
        if (pit) await updateObjectRecord(pit, "custom_objects.transactions", transactionId, { payment_status: "refunded" });
      }
      if (!result.d1.ok || !result.ghl.ok) {
        snapshot.cancellationSyncFailed = true;
        snapshot.cancellationSyncError = [result.d1.error, result.ghl.error].filter(Boolean).join("; ");
        await env.BOOKINGS.put(snapshot.bookingId, JSON.stringify(snapshot));
      }
    }
  } catch (err) {
    console.error(`Cancellation ledger sync failed for ${snapshot.bookingId}: ${err.message}`);
    snapshot.cancellationSyncFailed = true;
    snapshot.cancellationSyncError = err.message;
    await env.BOOKINGS.put(snapshot.bookingId, JSON.stringify(snapshot));
  }

  await notifyGHL(tenant.ghlCancellationUrl, {
    event: "booking_cancelled", bookingId: snapshot.bookingId,
    contactId: snapshot.ghlContactId || "",
    email: snapshot.guest?.email || "", paid: true,
    tier: calc.tier, chargePct: String(Math.round(calc.chargePct * 100)),
    chargeTotal: calc.charge.toFixed(2),
    refundTotal: calc.totalRefund.toFixed(2),
    depositRefund: calc.depositRefund.toFixed(2),
    checkIn: snapshot.stay.checkIn, propertyName: snapshot.propertyCode || tenant.brandName
  });

    return json({
    cancelled: true, paid: true, calculation: calc, refundIds,
    refundFailures: refundFailures.length ? refundFailures : null,
    ledgerSync: snapshot.cancellationSyncFailed ? "failed" : "ok",
    ledgerSyncError: snapshot.cancellationSyncError || null
  });
}

// ======================================================= /deposit/refund ====
export async function handleDepositRefund(request, env) {
  const ctx = await loadContext(request, env);
  if (ctx.error) return ctx.error;
  const { body, snapshot, tenant } = ctx;

  const dep = snapshot.securityDeposit;
  if (!snapshot.settled) return json({ error: "Booking was never paid" }, 400);
  if (dep.total <= 0) return json({ error: "No deposit on this booking" }, 400);
  if (["refunded", "claimed", "partial"].includes(dep.status))
    return json({ alreadyProcessed: true, status: dep.status, refundedAmount: dep.refundedAmount });

  const claim = round2(Math.max(0, Math.min(Number(body.claimAmount) || 0, dep.total)));
  const refundAmount = round2(dep.total - claim);
  const captureId = snapshot.captures?.DEP?.captureId || dep.paypalCaptureId;
  if (!captureId) return json({ error: "No deposit capture ID on record" }, 500);

  const note = `Devolución de depósito ${snapshot.bookingId}` + (claim > 0 ? ` (menos $${claim.toFixed(2)} por daños)` : "");

  let refundId = null;
  if (refundAmount > 0) {
    refundId = await gatewayRefund(tenant, env, snapshot, captureId,
      (snapshot.gateway === "stripe" || claim > 0) ? refundAmount : null, note);
  }

  const status = claim === 0 ? "refunded" : (refundAmount > 0 ? "partial" : "claimed");
  snapshot.securityDeposit.status = status;
  snapshot.securityDeposit.refundedAmount = refundAmount;
  snapshot.securityDeposit.claimAmount = claim;
  await env.BOOKINGS.put(snapshot.bookingId, JSON.stringify(snapshot));

  // ---- D1 + GHL ledger ----
  // The refund itself is a liability clearing (the deposit was never counted
  // as income). A retained damage claim IS new income -- attributed to the
  // owner, since property damage compensation is the owner's, not the
  // manager's, in every profile this worker has seen. Revisit if a tenant
  // ever needs the manager to receive damage claims instead.
  try {
    const rows = [];
    if (refundId) rows.push({
      recipient: "guest", category: "liability", entry_type: "deposit_refund_inspection",
      amount: refundAmount, reference: refundId, source: "deposit_refund",
      description: "Security deposit returned after inspection"
    });
    if (claim > 0) rows.push({
      recipient: "owner", category: "income", entry_type: "deposit_claim_retained",
      amount: claim, reference: "deposit_claim", source: "deposit_refund",
      description: `Damage claim retained. ${body.reason || ""}`.trim()
    });

    if (rows.length) {
      const result = await writeAndSyncRows(env, tenant, snapshot, rows);
      if (!result.d1.ok) console.error(`Deposit refund D1 write failed for ${snapshot.bookingId}: ${result.d1.reason} ${result.d1.error || ""}`);
      if (!result.ghl.ok) console.error(`Deposit refund GHL sync failed for ${snapshot.bookingId}: ${result.ghl.reason} ${result.ghl.error || ""}`);

      const transactionId = resolveTransactionId(snapshot);
      if (transactionId && status === "refunded") {
        const pit = resolveSecret(tenant, env, "ghlPitSecretName", "ghlPit");
        if (pit) await updateObjectRecord(pit, "custom_objects.transactions", transactionId, { payment_status: "refunded" });
      }
    }
  } catch (err) {
    console.error(`Deposit refund ledger sync failed for ${snapshot.bookingId}:`, err.message);
  }

  await notifyGHL(tenant.ghlDepositRefundUrl, {
    event: "deposit_refunded", bookingId: snapshot.bookingId,
    contactId: snapshot.ghlContactId || "",
    email: snapshot.guest?.email || "",
    refundTotal: refundAmount.toFixed(2),   // same field name as cancellation payloads
    refundAmount: refundAmount.toFixed(2),  // kept for back-compat
    claimAmount: claim.toFixed(2),
    status, propertyName: snapshot.propertyCode || tenant.brandName
  });

  return json({ processed: true, status, refundAmount, claimAmount: claim, refundId });
}
