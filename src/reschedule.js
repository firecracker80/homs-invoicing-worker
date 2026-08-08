// reschedule.js -- move an existing PAID booking to new dates.
//   POST /reschedule { bookingId, newCheckIn, newCheckOut, reason? }
//   header: X-Admin-Secret (human-triggered, same as /cancel and /extend)
//
// LIMITATION (by design, not a bug): GHL's rental calendar has no reschedule
// webhook/API we can drive reliably. This endpoint handles money + records
// only. The human must still move the appointment in the GHL calendar UI --
// the worker pushes a reminder flag so that step isn't forgotten.

import { calcSecurityDeposit, round2 } from "./deposit-engine.js";
import { createOrder, getAccessToken } from "./paypal.js";
import { createCheckoutSession } from "./stripe.js";
import { atUpdate } from "./airtable.js";
import { adminAuthorized, notifyGHL, cancellationTier } from "./cancellation.js";
import { atCreate } from "./airtable.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

async function refundPayPalPartial(tenant, env, captureId, amount, note) {
  const token = await getAccessToken(tenant, env);
  const res = await fetch(`${tenant.paypalApi}/v2/payments/captures/${captureId}/refund`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
      "PayPal-Request-Id": `reschedule-refund-${captureId}-${amount.toFixed(2)}`
    },
    body: JSON.stringify({
      amount: { value: amount.toFixed(2), currency_code: tenant.currency || "USD" },
      note_to_payer: note
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`PayPal refund failed: ${res.status} ${JSON.stringify(data)}`);
  return data.id;
}

// GHL renders unresolved merge tags three ways depending on context:
// literal "{{tag}}", empty string, or the literal STRING "null".
function isBlank(v) {
  if (v == null) return true;
  const s = String(v).trim().toLowerCase();
  return s === "" || s === "null" || s === "undefined";
}

export async function handleReschedule(request, env) {
  const body = await request.json();

  // Definitive editor-test signal: no usable bookingId. A real rentalBooking
  // context always carries one; without it nothing downstream is processable.
  const looksLikeEditorTest = isBlank(body.bookingId) || String(body.bookingId).includes("{{");
  if (looksLikeEditorTest) {
    return json({
      bookingId: "SAMPLE-EDITOR-TEST",
      oldDates: { checkIn: "2026-08-01", checkOut: "2026-08-04", nights: 3 },
      newDates: { checkIn: "2026-08-05", checkOut: "2026-08-09", nights: 4 },
      rentDelta: "70.00", depositDelta: "0.00", totalDelta: "70.00",
      settlement: { type: "additional_charge_pending", amount: 74.20, approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=SAMPLE" },
      airtableSync: "ok", calendarUpdateRequired: true, testMode: true
    });
  }

  const snapshot = await env.BOOKINGS.get(body.bookingId, { type: "json" });
  if (!snapshot) {
    console.error("Reschedule reject: Unknown bookingId. Raw body:", JSON.stringify(body));
    return json({ error: "Unknown bookingId", receivedBookingId: body.bookingId ?? null }, 404);
  }

  const tenant = await env.TENANTS.get(snapshot.locationId, { type: "json" });
  if (!tenant) return json({ error: "Unknown tenant" }, 404);
  if (!adminAuthorized(request, env, tenant)) return json({ error: "Unauthorized" }, 401);
  if (snapshot.cancelled) {
    console.error(`Reschedule reject (already cancelled) for ${snapshot.bookingId}`);
    return json({ error: "Booking is cancelled", bookingId: snapshot.bookingId }, 400);
  }
  if (!snapshot.settled) {
    console.error(`Reschedule reject (not settled) for ${snapshot.bookingId}. settled=${snapshot.settled}`);
    return json({ error: "Booking is not paid -- reschedule after settlement", bookingId: snapshot.bookingId, settled: !!snapshot.settled }, 400);
  }

  // Treat "null"/"undefined"/empty (GHL's unresolved-tag renderings) as missing.
  const newCheckIn = isBlank(body.newCheckIn) ? null : body.newCheckIn;
  const newCheckOut = isBlank(body.newCheckOut) ? null : body.newCheckOut;
  if (!newCheckIn || !newCheckOut) {
    console.error(`Reschedule reject (missing dates) for ${snapshot.bookingId}. Raw body:`, JSON.stringify(body));
    return json({ error: "Provide newCheckIn and newCheckOut", received: { newCheckIn: body.newCheckIn ?? null, newCheckOut: body.newCheckOut ?? null } }, 400);
  }

  const newNights = Math.round((new Date(newCheckOut) - new Date(newCheckIn)) / 86400000);
  if (!Number.isFinite(newNights) || newNights <= 0) {
    console.error(`Reschedule reject (bad date range) for ${snapshot.bookingId}: ${newCheckIn} -> ${newCheckOut}`);
    return json({ error: `Invalid date range: ${newCheckIn} -> ${newCheckOut}`, received: { newCheckIn, newCheckOut } }, 400);
  }

  const rate = snapshot.stay.nightlyRate;
  const oldRent = snapshot.charges.rentTotal;
  const oldDeposit = snapshot.securityDeposit.total;
  const newRent = round2(newNights * rate);
  const newDepositCalc = calcSecurityDeposit(
    newNights, rate, tenant.deposit || { rule: "tiered" }, snapshot.charges.cleaningFee
  );
  const newDeposit = newDepositCalc.totalDeposit;

  const rentDelta = round2(newRent - oldRent);
  const depositDelta = round2(newDeposit - oldDeposit);
  const feePct = snapshot.charges.feePct ?? tenant.processingFeePct ?? 0.06;
  const cur = tenant.currency || "USD";

  let settlement = { type: "none", amount: 0 };
  let deltaFeeForDisplay = 0; // processing fee shown when NEW money is charged (extensions only)

  // Shortening (fewer nights) gives back rent the guest already paid for --
  // treat it as a partial cancellation of the dropped nights, at the same
  // tiered rate a full /cancel would charge at this notice period (including
  // the 100% "already checked in" tier). Deposit delta is NEVER fee-adjusted:
  // the standing rule is deposit is always refunded/charged in full, so only
  // the rent portion absorbs an admin fee. Extending a stay (rentDelta >= 0)
  // is not a cancellation -- no admin fee applies there.
  let netRentDelta = rentDelta;
  let cancellationInfo = null;
  if (rentDelta < 0) {
    const { tier, chargePct, hoursUntil } = cancellationTier(snapshot.stay.checkIn, Date.now(), tenant, body.override);
    const lostRent = round2(-rentDelta);
    const adminFee = round2(lostRent * chargePct);
    netRentDelta = round2(-(lostRent - adminFee)); // always <= 0, since chargePct maxes at 1.00
    cancellationInfo = { tier, chargePct, hoursUntil, lostRent, adminFee };
  }

  const totalDelta = round2(netRentDelta + depositDelta);

  if (totalDelta > 0) {
    const deltaFee = round2(totalDelta * feePct);
    deltaFeeForDisplay = deltaFee;
    const chargeAmount = round2(totalDelta + deltaFee);
    const childId = `${snapshot.bookingId}-RESCHED-${newCheckOut}`;

    // PayPal requires item_total to equal the exact sum of the line items
    // (ITEM_TOTAL_MISMATCH otherwise). netRentDelta and depositDelta can move
    // in opposite directions (e.g. a non-tiered deposit rule that isn't
    // monotonic in nights) while totalDelta is still positive -- itemizing
    // only the positive component would overstate the visible line items
    // relative to chargeAmount, which nets in the negative one. Only itemize
    // separately when both are >= 0; otherwise collapse to a single net line.
    const canItemizeSeparately = netRentDelta >= 0 && depositDelta >= 0;
    const adjustmentItems = canItemizeSeparately
      ? [
          ...(netRentDelta > 0 ? [{
            name: "Ajuste de tarifa por cambio de fechas",
            quantity: "1",
            unit_amount: { currency_code: cur, value: netRentDelta.toFixed(2) }
          }] : []),
          ...(depositDelta > 0 ? [{
            name: "Ajuste de deposito por cambio de fechas",
            quantity: "1",
            unit_amount: { currency_code: cur, value: depositDelta.toFixed(2) }
          }] : [])
        ]
      : [{
          name: "Ajuste neto por cambio de fechas",
          quantity: "1",
          unit_amount: { currency_code: cur, value: totalDelta.toFixed(2) }
        }];
    adjustmentItems.push({
      name: "Tarifa de procesamiento (ajuste)",
      quantity: "1",
      unit_amount: { currency_code: cur, value: deltaFee.toFixed(2) }
    });

    const purchaseUnits = [{
      reference_id: `${childId}-ADJ`,
      invoice_id: `${childId}-ADJ`,
      amount: {
        currency_code: cur,
        value: chargeAmount.toFixed(2),
        breakdown: { item_total: { currency_code: cur, value: chargeAmount.toFixed(2) } }
      },
      items: adjustmentItems
    }];

    let approveUrl, gatewayRef;
    if ((tenant.gateway || "paypal") === "stripe") {
      const fakeSnap = {
        bookingId: childId, locationId: snapshot.locationId, gateway: "stripe",
        stay: { nights: newNights, nightlyRate: rate },
        charges: { rentTotal: 0, cleaningFee: 0, processingFee: deltaFee, grandTotal: chargeAmount },
        securityDeposit: { blocks: [], total: 0 }
      };
      const { sessionId, checkoutUrl } = await createCheckoutSession(tenant, env, fakeSnap, env.WORKER_URL);
      approveUrl = checkoutUrl;
      gatewayRef = sessionId;
    } else {
      const { orderId, approveUrl: url } = await createOrder(tenant, env, childId, purchaseUnits, env.WORKER_URL);
      approveUrl = url;
      gatewayRef = orderId;
    }

    settlement = { type: "additional_charge_pending", amount: chargeAmount, approveUrl, gatewayRef, childId };

    // Store a lightweight snapshot so /paypal/return or the webhook can find
    // and settle THIS delta-charge order when the guest pays it. Without this,
    // the payment vanishes: real money, zero record.
    await env.BOOKINGS.put(childId, JSON.stringify({
      type: "reschedule_adjustment",
      bookingId: childId,
      parentBookingId: snapshot.bookingId,
      locationId: snapshot.locationId,
      gateway: tenant.gateway || "paypal",
      paypal: (tenant.gateway || "paypal") !== "stripe" ? { orderId: gatewayRef, approveUrl } : undefined,
      stripe: (tenant.gateway || "paypal") === "stripe" ? { sessionId: gatewayRef, checkoutUrl: approveUrl } : undefined,
      amount: chargeAmount,
      rentDelta: netRentDelta, depositDelta, deltaFee,
      guest: snapshot.guest,
      ghlContactId: snapshot.ghlContactId,
      propertyCode: snapshot.propertyCode,
      settled: false
    }));

  } else if (totalDelta < 0) {
    // Refund rent-portion and deposit-portion SEPARATELY, against the capture
    // each actually came from -- combining them into one refund against the
    // rent capture can exceed that capture's available balance (e.g. a big
    // deposit-tier drop bundled with a small rent change) and PayPal rejects
    // the whole request. A failure here must never crash the endpoint --
    // report it cleanly so the admin can finish it manually in PayPal.
    // rentRefundAmt already has the cancellation-tier admin fee netted out
    // (via netRentDelta above) when the reschedule dropped nights.
    const rentRefundAmt = netRentDelta < 0 ? round2(-netRentDelta) : 0;
    const depositRefundAmt = depositDelta < 0 ? round2(-depositDelta) : 0;
    const rentCaptureId = snapshot.captures?.RENT?.captureId;
    const depCaptureId = snapshot.captures?.DEP?.captureId;
    const parts = [];

    if (rentRefundAmt > 0) {
      if (!rentCaptureId) {
        parts.push({ type: "rent_refund_needed_manual", amount: rentRefundAmt });
      } else {
        try {
          const feeNote = cancellationInfo?.adminFee > 0
            ? ` (admin fee $${cancellationInfo.adminFee.toFixed(2)} retained, tier ${cancellationInfo.tier})`
            : "";
          const refundId = await refundPayPalPartial(
            tenant, env, rentCaptureId, rentRefundAmt,
            `Reschedule ${snapshot.bookingId}: ajuste de tarifa por cambio de fechas${feeNote}`
          );
          parts.push({ type: "rent_refund_issued", amount: rentRefundAmt, refundId });
        } catch (err) {
          console.error(`Reschedule rent refund failed for ${snapshot.bookingId}: ${err.message}`);
          parts.push({ type: "rent_refund_failed", amount: rentRefundAmt, error: err.message });
        }
      }
    }

    if (depositRefundAmt > 0) {
      if (!depCaptureId) {
        parts.push({ type: "deposit_refund_needed_manual", amount: depositRefundAmt });
      } else {
        try {
          const refundId = await refundPayPalPartial(
            tenant, env, depCaptureId, depositRefundAmt,
            `Reschedule ${snapshot.bookingId}: ajuste de depósito por cambio de fechas`
          );
          parts.push({ type: "deposit_refund_issued", amount: depositRefundAmt, refundId });
        } catch (err) {
          console.error(`Reschedule deposit refund failed for ${snapshot.bookingId}: ${err.message}`);
          parts.push({ type: "deposit_refund_failed", amount: depositRefundAmt, error: err.message });
        }
      }
    }

    const anyFailed = parts.some(p => p.type.includes("failed") || p.type.includes("manual"));
    settlement = {
      type: anyFailed ? "refund_partial_manual" : "refund_issued",
      amount: round2(rentRefundAmt + depositRefundAmt),
      parts
    };
  } else if (cancellationInfo?.adminFee > 0) {
    // Rare: the admin fee happened to exactly offset the rest of the delta
    // (net $0 money movement) -- no gateway call needed, but the fee was
    // still earned and gets recorded in the ledger below.
    settlement = { type: "admin_fee_only", amount: 0 };
  }

  const oldStay = { ...snapshot.stay };
  snapshot.stay = { ...snapshot.stay, checkIn: newCheckIn, checkOut: newCheckOut, nights: newNights };
  snapshot.charges.rentTotal = newRent;
  snapshot.securityDeposit.total = newDeposit;
  snapshot.securityDeposit.blocks = newDepositCalc.blocks;
  snapshot.charges.grandTotal = round2(
    newRent + snapshot.charges.cleaningFee + snapshot.charges.processingFee + newDeposit
  );
  snapshot.reschedules = [...(snapshot.reschedules || []), {
    at: new Date().toISOString(),
    from: oldStay,
    to: { checkIn: newCheckIn, checkOut: newCheckOut, nights: newNights },
    rentDelta, netRentDelta, depositDelta, totalDelta, settlement, cancellationInfo,
    reason: body.reason || ""
  }];
  await env.BOOKINGS.put(snapshot.bookingId, JSON.stringify(snapshot));

  let airtableOk = true;
  try {
    const orderId = snapshot.airtable?.orderRecordId;
    if (orderId) {
      const feeNote = cancellationInfo?.adminFee > 0
        ? ` Admin fee $${cancellationInfo.adminFee.toFixed(2)} retained (tier ${cancellationInfo.tier}, ${Math.round(cancellationInfo.chargePct * 100)}%).`
        : "";
      await atUpdate(tenant, "Orders", orderId, {
        "Check-in Date": newCheckIn,
        "Check-out Date": newCheckOut,
        "Nights": newNights,
        "Reservation Total": round2(newRent + snapshot.charges.cleaningFee + snapshot.charges.processingFee),
        "Deposit Required": newDeposit,
        "Notes": `Reschedule: ${oldStay.checkIn}->${oldStay.checkOut} (${oldStay.nights}n) to ${newCheckIn}->${newCheckOut} (${newNights}n). Delta $${totalDelta.toFixed(2)} (${settlement.type}).${feeNote} ${body.reason || ""}`.trim()
      });

      // Record the retained admin fee the same way /cancel does: an income
      // ledger row + an owner/manager payout split, so a reschedule that
      // shortens a stay accounts for itself identically to a cancellation.
      if (cancellationInfo?.adminFee > 0) {
        const now8601 = new Date().toISOString();
        const gw = snapshot.gateway === "stripe" ? "Stripe" : "PayPal";
        await atCreate(tenant, "Transaction Ledger", [{
          "Entry Date": now8601, "Related Order": [orderId], "Transaction Type": "cancellation_charge",
          "Direction": "In", "Gateway": gw, "Reference Number": snapshot.bookingId,
          "Amount": cancellationInfo.adminFee, "Currency": cur, "Reconciled": false,
          "Notes": `${snapshot.bookingId} reschedule admin fee, ${Math.round(cancellationInfo.chargePct * 100)}% of $${cancellationInfo.lostRent.toFixed(2)} dropped rent (tier ${cancellationInfo.tier})`
        }]);
        const ownerPct = snapshot.payout?.ownerPct ?? tenant.ownerPct ?? 0.85;
        const ownerAmt = round2(cancellationInfo.adminFee * ownerPct);
        const managerAmt = round2(cancellationInfo.adminFee - ownerAmt);
        await atCreate(tenant, "Payout Ledger", [
          { "Recipient": "Owner", "Payout Method": "Manual Transfer",
            "Reason": `Reschedule admin fee ${Math.round(ownerPct * 100)}% — ${snapshot.bookingId}`,
            "Payout Amount": ownerAmt, "Currency": cur, "Scheduled Date": now8601.slice(0, 10),
            "Payout Status": "Pending", "Order": [orderId] },
          { "Recipient": "Manager", "Payout Method": "Manual Transfer",
            "Reason": `Reschedule admin fee (manager share) — ${snapshot.bookingId}`,
            "Payout Amount": managerAmt, "Currency": cur, "Scheduled Date": now8601.slice(0, 10),
            "Payout Status": "Pending", "Order": [orderId] }
        ]);
      }
    }
  } catch (err) {
    console.error(`Reschedule Airtable sync failed for ${snapshot.bookingId}:`, err.message);
    airtableOk = false;
  }

  await notifyGHL(tenant.ghlRescheduleUrl, {
    event: "booking_rescheduled",
    bookingId: snapshot.bookingId,
    contactId: snapshot.ghlContactId || "",
    email: snapshot.guest?.email || "",
    firstName: (snapshot.guest?.name || "").split(" ")[0],
    oldCheckIn: oldStay.checkIn,
    oldCheckOut: oldStay.checkOut,
    newCheckIn, newCheckOut, newNights,
    rentTotal: newRent.toFixed(2),
    depositTotal: newDeposit.toFixed(2),
    processingFee: deltaFeeForDisplay.toFixed(2),
    totalDelta: totalDelta.toFixed(2),
    settlementType: settlement.type,
    approveUrl: settlement.approveUrl || "",
    adminFeeRetained: (cancellationInfo?.adminFee ?? 0).toFixed(2),
    cancellationTier: cancellationInfo?.tier || "",
    propertyName: snapshot.propertyCode || tenant.brandName,
    calendarUpdateRequired: "true"
  });

  return json({
    bookingId: snapshot.bookingId,
    oldDates: oldStay,
    newDates: { checkIn: newCheckIn, checkOut: newCheckOut, nights: newNights },
    rentDelta, netRentDelta, depositDelta, totalDelta, settlement, cancellationInfo,
    airtableSync: airtableOk ? "ok" : "failed",
    calendarUpdateRequired: true
  });
}

// ============================================================= settlement ====
// Called by payment.js when a reschedule delta-charge order's PayPal
// capture (or Stripe session) completes. Reuses the existing "Payment
// Confirmed" GHL workflow -- no new workflow needed on the GHL side.
export async function settleRescheduleAdjustment(env, tenant, snapshot, capture) {
  if (snapshot.settled) return { alreadySettled: true };

  const now = new Date().toISOString();
  snapshot.settled = true;
  snapshot.capture = capture;
  snapshot.settledAt = now;
  await env.BOOKINGS.put(snapshot.bookingId, JSON.stringify(snapshot));

  const parent = await env.BOOKINGS.get(snapshot.parentBookingId, { type: "json" });
  const cur = tenant.currency || "USD";
  let airtableOk = true;

  try {
    const orderId = parent?.airtable?.orderRecordId;
    if (orderId) {
      // Reconcile the paid-amount fields, which "Deposit Required" alone
      // doesn't cover -- without this, Airtable shows the NEW required
      // amount but the OLD paid amount, looking like the guest never paid.
      const originalRentGross = parent?.captures?.RENT?.gross || 0;
      const originalDepositGross = parent?.captures?.DEP?.gross || 0;
      const newDepositPaid = round2(originalDepositGross + (snapshot.depositDelta > 0 ? snapshot.depositDelta : 0));
      const newTotalPaid = round2(originalRentGross + originalDepositGross + capture.gross);

      await atUpdate(tenant, "Orders", orderId, {
        "Deposit Paid": newDepositPaid,
        "Total Paid": newTotalPaid,
        "Remaining Balance": 0,
        "Balance Due": 0,
        "Deposit Status": "Held",
        "Notes": `Reschedule adjustment paid: $${capture.gross.toFixed(2)} (capture ${capture.captureId}).`
      });

      await atCreate(tenant, "Payments", [{
        "Order": [orderId], "Payment Method": snapshot.gateway === "stripe" ? "Stripe" : "PayPal",
        "Payment Type": "Reschedule Adjustment",
        "Gateway Transaction ID": capture.captureId,
        "Payment Amount": capture.gross, "Gateway Fee": capture.fee, "Net Received": capture.net,
        "Currency": cur, "Payment Status": "Completed", "Received Date": now,
        "PayPal Payer ID": capture.payerId || "", "PayPal Email": capture.payerEmail || "",
        "Cleared for Payout": true
      }]);

      await atCreate(tenant, "Transaction Ledger", [{
        "Entry Date": now, "Related Order": [orderId], "Transaction Type": "reschedule_charge",
        "Direction": "In", "Gateway": snapshot.gateway === "stripe" ? "Stripe" : "PayPal",
        "Reference Number": capture.captureId, "Amount": capture.gross, "Currency": cur,
        "Reconciled": false,
        "Notes": `${snapshot.bookingId} reschedule adjustment (rent ${snapshot.rentDelta}, deposit ${snapshot.depositDelta}, fee ${snapshot.deltaFee})`
      }]);

      // Payout Ledger: split ONLY the rent-delta portion (real rent revenue).
      // Deposit-delta is pass-through (held); the processing fee is retained.
      if (snapshot.rentDelta > 0 && parent) {
        const ownerPct = parent.payout?.ownerPct ?? tenant.ownerPct ?? 0.85;
        const ownerAmt = round2(snapshot.rentDelta * ownerPct);
        const managerAmt = round2(snapshot.rentDelta - ownerAmt);
        const sched = parent.stay?.checkIn || now.slice(0, 10);
        await atCreate(tenant, "Payout Ledger", [
          { "Recipient": "Owner", "Payout Method": "Manual Transfer",
            "Reason": `Reschedule rent adjustment ${Math.round(ownerPct * 100)}% — ${snapshot.bookingId}`,
            "Payout Amount": ownerAmt, "Currency": cur, "Scheduled Date": sched,
            "Payout Status": "Pending", "Order": [orderId] },
          { "Recipient": "Manager", "Payout Method": "Manual Transfer",
            "Reason": `Reschedule rent adjustment (manager share) — ${snapshot.bookingId}`,
            "Payout Amount": managerAmt, "Currency": cur, "Scheduled Date": sched,
            "Payout Status": "Pending", "Order": [orderId] }
        ]);
      }
    }
  } catch (err) {
    console.error(`Reschedule adjustment Airtable sync failed for ${snapshot.bookingId}:`, err.message);
    airtableOk = false;
  }

  // Reuse the EXISTING "Payment Confirmed" workflow -- no new GHL build needed.
  await notifyGHL(tenant.ghlPaymentConfirmedUrl, {
    event: "payment_confirmed",
    bookingId: snapshot.bookingId,
    contactId: snapshot.ghlContactId || "",
    status: "paid",
    amountPaid: capture.gross.toFixed(2),
    depositTotal: (snapshot.depositDelta > 0 ? snapshot.depositDelta : 0).toFixed(2),
    checkIn: parent?.stay?.checkIn || "",
    checkOut: parent?.stay?.checkOut || "",
    propertyName: snapshot.propertyCode || tenant.brandName
  });

  return { settled: true, airtableOk };
}
