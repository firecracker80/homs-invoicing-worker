// cancellation.js — cancellation engine + post-checkout deposit refunds.
// Admin-triggered (no guest-facing link exists for rental calendars):
//   POST /cancel          { bookingId, override?, reason? }   header: X-Admin-Secret
//   POST /deposit/refund  { bookingId, claimAmount?, reason? } header: X-Admin-Secret
//
// Policy (confirmed 2026-07-18):
//   Charge basis: RENT ONLY. Tiers by time before check-in (3PM local, configurable):
//     < 24 hrs        → 50%
//     24 hrs – 5 days → 30%
//     > 5 days        → 20%
//   Deposit: always 100% refunded on cancellation. Cleaning: 100% refunded.
//   Processing fee: non-refundable. Cancellation charge splits per profile (85/15).
//   override: "full_refund" → documented exceptions (refund rent+cleaning+deposit; fee still retained).

import { getAccessToken } from "./paypal.js";
import { atUpdate, atFind, atCreate } from "./airtable.js";

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

// ---- tier math ----
export function calcCancellation(snapshot, nowMs, tenant, override) {
  const checkInHour = tenant.checkInHour ?? 15;              // 3 PM
  const tzOffsetHours = tenant.tzOffsetHours ?? -4;          // AST
  const anchor = new Date(`${snapshot.stay.checkIn}T00:00:00Z`).getTime()
    + (checkInHour - tzOffsetHours) * 3600000;               // check-in moment in UTC ms
  const hoursUntil = (anchor - nowMs) / 3600000;

  let chargePct, tier;
  if (override === "full_refund") { chargePct = 0; tier = "exception_full_refund"; }
  else if (hoursUntil < 24)  { chargePct = 0.50; tier = "under_24h"; }
  else if (hoursUntil < 120) { chargePct = 0.30; tier = "24h_to_5d"; }
  else                       { chargePct = 0.20; tier = "over_5d"; }

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
  if (!snapshot) return { error: json({ error: "Unknown bookingId" }, 404) };
  const tenant = await env.TENANTS.get(snapshot.locationId, { type: "json" });
  if (!tenant) return { error: json({ error: "Unknown tenant" }, 404) };
  if (!adminAuthorized(request, env, tenant)) return { error: json({ error: "Unauthorized" }, 401) };
  return { body, snapshot, tenant };
}

async function resolveOrderRecordId(tenant, snapshot) {
  if (snapshot.airtable?.orderRecordId) return snapshot.airtable.orderRecordId;
  const found = await atFind(tenant, "Orders", `{GHL Booking ID}="${snapshot.bookingId}"`);
  return found?.[0]?.id || null;
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
  const cur = tenant.currency || "USD";

  // ---- UNPAID booking: no refunds, just void ----
  if (!snapshot.settled) {
    snapshot.cancelled = true;
    snapshot.cancellation = { tier: "unpaid_void", at: new Date(now).toISOString(), reason: body.reason || "" };
    await env.BOOKINGS.put(snapshot.bookingId, JSON.stringify(snapshot));
    try {
      const orderId = await resolveOrderRecordId(tenant, snapshot);
      if (orderId) await atUpdate(tenant, "Orders", orderId, {
        "Order Status": "Cancelled",
        "Notes": `Cancelled before payment. ${body.reason || ""}`.trim()
      });
    } catch (err) { console.error("Cancel(unpaid) Airtable failed:", err.message); }
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
  if (calc.rentUnitRefund > 0 && rentCaptureId)
    refundIds.rent = await gatewayRefund(tenant, env, snapshot, rentCaptureId, calc.rentUnitRefund, note);
  if (calc.depositRefund > 0 && depCaptureId)
    refundIds.deposit = await gatewayRefund(tenant, env, snapshot, depCaptureId,
      snapshot.gateway === "stripe" ? calc.depositRefund : null, note); // PayPal DEP = full refund

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

  // ---- Airtable ----
  try {
    const orderId = await resolveOrderRecordId(tenant, snapshot);
    if (orderId) {
      await atUpdate(tenant, "Orders", orderId, {
        "Order Status": "Cancelled",
        "Deposit Status": "Refunded",
        "Refunded Amount": calc.totalRefund,
        "Notes": `Cancelled (${calc.tier}, charge ${Math.round(calc.chargePct * 100)}% = $${calc.charge.toFixed(2)}). Refunded $${calc.totalRefund.toFixed(2)}. ${body.reason || ""}`.trim()
      });
      // Refund payment rows
      const refundRows = [];
      if (refundIds.rent) refundRows.push({
        "Order": [orderId], "Payment Method": snapshot.gateway === "stripe" ? "Stripe" : "PayPal",
        "Payment Type": "Refund", "Payment Amount": calc.rentUnitRefund,
        "Gateway Transaction ID": refundIds.rent, "Currency": cur,
        "Payment Status": "Completed", "Cleared for Payout": false,
        "Notes": `${snapshot.bookingId}-RENT refund (rent ${calc.rentRefund.toFixed(2)} + cleaning ${calc.cleaningRefund.toFixed(2)})`
      });
      if (refundIds.deposit) refundRows.push({
        "Order": [orderId], "Payment Method": snapshot.gateway === "stripe" ? "Stripe" : "PayPal",
        "Payment Type": "Refund", "Payment Amount": calc.depositRefund,
        "Gateway Transaction ID": refundIds.deposit, "Currency": cur,
        "Payment Status": "Completed", "Cleared for Payout": false,
        "Notes": `${snapshot.bookingId}-DEP refund (full deposit)`
      });
      if (refundRows.length) await atCreate(tenant, "Payments", refundRows);

      // Transaction Ledger
      const now8601 = new Date(now).toISOString();
      const gw = snapshot.gateway === "stripe" ? "Stripe" : "PayPal";
      const ledger = [];
      if (refundIds.rent) ledger.push({
        "Entry Date": now8601, "Related Order": [orderId], "Transaction Type": "rent_refund",
        "Direction": "Out", "Gateway": gw, "Reference Number": refundIds.rent,
        "Amount": calc.rentUnitRefund, "Currency": cur, "Reconciled": false,
        "Notes": `${snapshot.bookingId} cancellation refund (rent+cleaning)`
      });
      if (refundIds.deposit) ledger.push({
        "Entry Date": now8601, "Related Order": [orderId], "Transaction Type": "deposit_refund",
        "Direction": "Out", "Gateway": gw, "Reference Number": refundIds.deposit,
        "Amount": calc.depositRefund, "Currency": cur, "Reconciled": false,
        "Notes": `${snapshot.bookingId} deposit returned on cancellation`
      });
      if (calc.charge > 0) ledger.push({
        "Entry Date": now8601, "Related Order": [orderId], "Transaction Type": "cancellation_charge",
        "Direction": "In", "Gateway": gw, "Reference Number": snapshot.bookingId,
        "Amount": calc.charge, "Currency": cur, "Reconciled": false,
        "Notes": `${snapshot.bookingId} ${Math.round(calc.chargePct * 100)}% cancellation charge (${calc.tier})`
      });
      if (ledger.length) await atCreate(tenant, "Transaction Ledger", ledger);

      // Payout Ledger: void originals, create charge-split rows
      for (const id of snapshot.airtable?.payoutLedgerIds || []) {
        try { await atUpdate(tenant, "Payout Ledger", id, { "Payout Status": "Cancelled", "Notes": "Booking cancelled — superseded by cancellation-charge split" }); }
        catch (err) { console.error("Payout void failed:", err.message); }
      }
      if (calc.charge > 0) {
        await atCreate(tenant, "Payout Ledger", [
          {
            "Recipient Name": tenant.ownerName || "Owner", "Recipient PayPal": tenant.ownerPaypalEmail || "",
            "Payout Method": "Manual Transfer",
            "Reason": `Cancellation charge ${Math.round(calc.chargePct * 100)}% (owner ${Math.round(snapshot.payout.ownerPct * 100)}%) — ${snapshot.bookingId}`,
            "Payout Amount": calc.payoutSplit.owner, "Currency": cur,
            "Scheduled Date": new Date(now).toISOString().slice(0, 10),
            "Payout Status": "Pending", "Order": [orderId]
          },
          {
            "Recipient Name": tenant.managerName || "Manager", "Recipient PayPal": tenant.managerPaypalEmail || "",
            "Payout Method": "Manual Transfer",
            "Reason": `Cancellation charge ${Math.round(calc.chargePct * 100)}% (manager share) — ${snapshot.bookingId}`,
            "Payout Amount": calc.payoutSplit.manager, "Currency": cur,
            "Scheduled Date": new Date(now).toISOString().slice(0, 10),
            "Payout Status": "Pending", "Order": [orderId]
          }
        ]);
      }
    }
  } catch (err) {
    console.error(`Cancellation Airtable sync failed for ${snapshot.bookingId}:`, err.message);
    snapshot.cancellationSyncFailed = true;
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

  return json({ cancelled: true, paid: true, calculation: calc, refundIds });
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

  const cur = tenant.currency || "USD";
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

  try {
    const orderId = await resolveOrderRecordId(tenant, snapshot);
    if (orderId) {
      await atUpdate(tenant, "Orders", orderId, {
        "Deposit Status": status === "refunded" ? "Refunded" : status === "partial" ? "Partial" : "Claimed",
        "Refunded Amount": refundAmount,
        "Claim Amount": claim,
        "Inspection Date": new Date().toISOString().slice(0, 10)
      });
      const gw = snapshot.gateway === "stripe" ? "Stripe" : "PayPal";
      const rows = [];
      if (refundId) rows.push({
        "Entry Date": new Date().toISOString(), "Related Order": [orderId],
        "Transaction Type": "deposit_refund", "Direction": "Out", "Gateway": gw,
        "Reference Number": refundId, "Amount": refundAmount, "Currency": cur,
        "Reconciled": false, "Notes": `${snapshot.bookingId} deposit refund after inspection`
      });
      if (claim > 0) rows.push({
        "Entry Date": new Date().toISOString(), "Related Order": [orderId],
        "Transaction Type": "deposit_claim", "Direction": "In", "Gateway": gw,
        "Reference Number": snapshot.bookingId, "Amount": claim, "Currency": cur,
        "Reconciled": false, "Notes": `${snapshot.bookingId} damage claim retained. ${body.reason || ""}`.trim()
      });
      if (rows.length) await atCreate(tenant, "Transaction Ledger", rows);
      if (refundId) await atCreate(tenant, "Payments", [{
        "Order": [orderId], "Payment Method": gw, "Payment Type": "Refund",
        "Payment Amount": refundAmount, "Gateway Transaction ID": refundId,
        "Currency": cur, "Payment Status": "Completed", "Cleared for Payout": false,
        "Notes": `${snapshot.bookingId}-DEP refund after inspection`
      }]);
    }
  } catch (err) {
    console.error(`Deposit refund Airtable sync failed for ${snapshot.bookingId}:`, err.message);
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
