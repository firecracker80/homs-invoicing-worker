// reschedule.js -- move an existing PAID booking to new dates.
//   POST /reschedule { bookingId, newCheckIn, newCheckOut, reason? }
//   header: X-Admin-Secret (human-triggered, same as /cancel and /extend)
//
// Money + records here; the actual GHL calendar appointment is moved via
// ghl-calendar.js's undocumented-endpoint call (updateGhlBookingDates).
// That call never throws -- calendarUpdateRequired in the response/GHL
// notify reflects whether it succeeded, so a failed calendar write never
// rolls back a completed reschedule; it just flags the manual follow-up.

import { calcSecurityDeposit, round2 } from "./deposit-engine.js";
import { depositConfigFor } from "./policy.js";
import { createOrder, getAccessToken } from "./paypal.js";
import { createCheckoutSession } from "./stripe.js";
import { writeAndSyncRows } from "./ledger.js";
import { updateObjectRecord } from "./ghl.js";
import { adminAuthorized, notifyAndRecord, cancellationTier } from "./cancellation.js";
import { paymentConfirmedPayload } from "./payment.js";
import { updateGhlBookingDates } from "./ghl-calendar.js";

function resolveSecret(tenant, env, nameKey, inlineKey) {
  if (tenant[nameKey] && env[tenant[nameKey]]) return env[tenant[nameKey]];
  return tenant[inlineKey];
}

// The Transaction record only exists once a booking has actually settled.
function resolveTransactionId(snapshot) {
  return snapshot.ghl?.transactionId || null;
}

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
      calendarUpdateRequired: true, testMode: true
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
    newNights, rate, depositConfigFor(tenant), snapshot.charges.cleaningFee
  );
  const newDeposit = newDepositCalc.totalDeposit;

  // UNPAID booking: nothing was ever captured, so there's no delta to charge
  // or refund -- just re-price the new dates and issue a fresh payment link
  // for the full new total. The old (unpaid) link is left to expire on its own.
  if (!snapshot.settled) {
    const cur0 = tenant.currency || "USD";
    const feePct0 = snapshot.charges.feePct ?? tenant.processingFeePct ?? 0.06;
    const newProcessingFee = round2(feePct0 * (newRent + snapshot.charges.cleaningFee + newDeposit));
    const newGrandTotal = round2(newRent + snapshot.charges.cleaningFee + newProcessingFee + newDeposit);

    const purchaseUnits = [{
      reference_id: `${snapshot.bookingId}-RENT`,
      invoice_id: `${snapshot.bookingId}-RENT`,
      amount: {
        currency_code: cur0,
        value: round2(newRent + snapshot.charges.cleaningFee + newProcessingFee).toFixed(2),
        breakdown: { item_total: { currency_code: cur0, value: round2(newRent + snapshot.charges.cleaningFee + newProcessingFee).toFixed(2) } }
      },
      items: [
        { name: `Estadía — ${newNights} noche${newNights === 1 ? "" : "s"}`, quantity: String(newNights),
          unit_amount: { currency_code: cur0, value: rate.toFixed(2) } },
        ...(snapshot.charges.cleaningFee > 0 ? [{ name: "Tarifa de limpieza", quantity: "1",
          unit_amount: { currency_code: cur0, value: snapshot.charges.cleaningFee.toFixed(2) } }] : []),
        { name: "Tarifa de procesamiento de pago", quantity: "1",
          unit_amount: { currency_code: cur0, value: newProcessingFee.toFixed(2) } }
      ]
    }];
    if (newDeposit > 0) purchaseUnits.push({
      reference_id: `${snapshot.bookingId}-DEP`,
      invoice_id: `${snapshot.bookingId}-DEP`,
      amount: { currency_code: cur0, value: newDeposit.toFixed(2),
        breakdown: { item_total: { currency_code: cur0, value: newDeposit.toFixed(2) } } },
      items: newDepositCalc.blocks.map(b => ({
        name: newDepositCalc.blocks.length > 1
          ? `Depósito de seguridad (reembolsable) — bloque ${b.block}`
          : "Depósito de seguridad (reembolsable)",
        quantity: "1", unit_amount: { currency_code: cur0, value: b.amount.toFixed(2) }
      }))
    });

    // A second createOrder/createCheckoutSession call against the SAME
    // bookingId needs its own idempotency key -- reusing the bare bookingId
    // would collide with the original (still-open) unpaid order/session and
    // either return stale pricing or get rejected outright for a body
    // mismatch under the same key.
    const repriceKey = `${snapshot.bookingId}-RESCHED-${Date.now()}`;
    let approveUrl, gatewayRef;
    if ((tenant.gateway || "paypal") === "stripe") {
      const fakeSnap = {
        bookingId: snapshot.bookingId, locationId: snapshot.locationId, gateway: "stripe",
        stay: { nights: newNights, nightlyRate: rate },
        charges: { rentTotal: newRent, cleaningFee: snapshot.charges.cleaningFee, processingFee: newProcessingFee, grandTotal: newGrandTotal },
        securityDeposit: { blocks: newDepositCalc.blocks, total: newDeposit }
      };
      const { sessionId, checkoutUrl } = await createCheckoutSession(tenant, env, fakeSnap, env.WORKER_URL, repriceKey);
      approveUrl = checkoutUrl; gatewayRef = sessionId;
    } else {
      const { orderId, approveUrl: url } = await createOrder(tenant, env, snapshot.bookingId, purchaseUnits, env.WORKER_URL, repriceKey);
      approveUrl = url; gatewayRef = orderId;
    }

    const oldStay0 = { ...snapshot.stay };
    snapshot.stay = { ...snapshot.stay, checkIn: newCheckIn, checkOut: newCheckOut, nights: newNights };
    snapshot.charges.rentTotal = newRent;
    snapshot.charges.processingFee = newProcessingFee;
    snapshot.charges.grandTotal = newGrandTotal;
    snapshot.securityDeposit.total = newDeposit;
    snapshot.securityDeposit.blocks = newDepositCalc.blocks;
    if ((tenant.gateway || "paypal") === "stripe") snapshot.stripe = { sessionId: gatewayRef, checkoutUrl: approveUrl };
    else snapshot.paypal = { orderId: gatewayRef, approveUrl };
    snapshot.reschedules = [...(snapshot.reschedules || []), {
      at: new Date().toISOString(), from: oldStay0,
      to: { checkIn: newCheckIn, checkOut: newCheckOut, nights: newNights },
      unpaid: true, reason: body.reason || ""
    }];
    await env.BOOKINGS.put(snapshot.bookingId, JSON.stringify(snapshot));

    // No Transaction record exists yet for an unpaid booking, and no money
    // moved -- nothing to write to D1 or GHL here.

    const calendar0 = await updateGhlBookingDates(env, tenant, snapshot, newCheckIn, newCheckOut);

    await notifyAndRecord(env, snapshot, tenant.ghlRescheduleUrl, {
      event: "booking_rescheduled",
      bookingId: snapshot.bookingId,
      contactId: snapshot.ghlContactId || "",
      email: snapshot.guest?.email || "",
      firstName: (snapshot.guest?.name || "").split(" ")[0],
      oldCheckIn: oldStay0.checkIn, oldCheckOut: oldStay0.checkOut,
      newCheckIn, newCheckOut, newNights,
      rentTotal: newRent.toFixed(2),
      depositTotal: newDeposit.toFixed(2),
      processingFee: newProcessingFee.toFixed(2),
      totalDelta: newGrandTotal.toFixed(2),
      settlementType: "unpaid_new_link",
      approveUrl,
      adminFeeRetained: "0.00",
      cancellationTier: "",
      propertyName: snapshot.propertyCode || tenant.brandName,
      calendarUpdateRequired: calendar0.ok ? "false" : "true"
    });

    return json({
      bookingId: snapshot.bookingId,
      oldDates: oldStay0,
      newDates: { checkIn: newCheckIn, checkOut: newCheckOut, nights: newNights },
      settlement: { type: "unpaid_new_link", approveUrl, grandTotal: newGrandTotal },
      calendarUpdateRequired: !calendar0.ok, calendar: calendar0
    });
  }

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
    // The dropped nights ARE the basis here, not the whole stay. A policy that
    // keeps "one night plus 50% of the rest" therefore keeps one of the dropped
    // nights -- the nights being kept are still being paid for in full.
    const lostRent = round2(-rentDelta);
    const droppedNights = Math.max((snapshot.stay?.nights ?? 0) - newNights, 0);
    const { tier, chargePct, hoursUntil } = cancellationTier(snapshot.stay.checkIn, Date.now(), tenant, body.override, {
      nights: droppedNights,
      nightlyRate: snapshot.stay?.nightlyRate,
      rentBasis: lostRent,
      bookedAtMs: Date.parse(snapshot.createdAt ?? ""),
    });
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

  // ---- D1 + GHL ledger ----
  // Admin fee retained (shortened stay): new income, split by ownerPct, same
  // as /cancel's charge. Rent/deposit refunds actually issued (from
  // settlement.parts): the rent portion reverses owner/manager income
  // proportionally; the deposit portion is a liability, never counted as
  // income, tracked for audit only.
  let ledgerOk = true;
  let ghlOk = true;
  try {
    const transactionId = resolveTransactionId(snapshot);
    const eventRef = `resched-${newCheckOut}`;
    const ownerPct = snapshot.payout?.ownerPct ?? tenant.ownerPct ?? 0.85;
    const rows = [];

    if (cancellationInfo?.adminFee > 0) {
      const ownerAmt = round2(cancellationInfo.adminFee * ownerPct);
      rows.push({
        recipient: "owner", category: "income", entry_type: "reschedule_admin_fee_owner",
        amount: ownerAmt, reference: eventRef, source: "reschedule",
        description: `Reschedule admin fee, ${Math.round(cancellationInfo.chargePct * 100)}% of $${cancellationInfo.lostRent.toFixed(2)} dropped rent (tier ${cancellationInfo.tier})`
      });
      rows.push({
        recipient: "manager", category: "income", entry_type: "reschedule_admin_fee_manager",
        amount: round2(cancellationInfo.adminFee - ownerAmt), reference: eventRef, source: "reschedule",
        description: `Reschedule admin fee (manager share), tier ${cancellationInfo.tier}`
      });
    }

    const rentRefundPart = settlement.parts?.find(p => p.type === "rent_refund_issued");
    if (rentRefundPart) {
      const ownerShare = round2(rentRefundPart.amount * ownerPct);
      rows.push({
        recipient: "owner", category: "income", entry_type: "reschedule_refund_owner",
        amount: -ownerShare, reference: rentRefundPart.refundId, source: "reschedule",
        description: "Rent refund reversal — reschedule shortened stay"
      });
      rows.push({
        recipient: "manager", category: "income", entry_type: "reschedule_refund_manager",
        amount: -round2(rentRefundPart.amount - ownerShare), reference: rentRefundPart.refundId, source: "reschedule",
        description: "Rent refund reversal (manager share) — reschedule shortened stay"
      });
    }
    const depositRefundPart = settlement.parts?.find(p => p.type === "deposit_refund_issued");
    if (depositRefundPart) {
      rows.push({
        recipient: "guest", category: "liability", entry_type: "other",
        amount: depositRefundPart.amount, reference: depositRefundPart.refundId, source: "reschedule",
        description: "Deposit adjustment refund — reschedule shortened stay"
      });
    }

    if (rows.length) {
      const result = await writeAndSyncRows(env, tenant, snapshot, rows);
      if (!result.d1.ok) { console.error(`Reschedule D1 write failed for ${snapshot.bookingId}: ${result.d1.reason} ${result.d1.error || ""}`); ledgerOk = false; }
      if (!result.ghl.ok) { console.error(`Reschedule GHL sync failed for ${snapshot.bookingId}: ${result.ghl.reason} ${result.ghl.error || ""}`); ghlOk = false; }
    }

    if (transactionId) {
      const pit = resolveSecret(tenant, env, "ghlPitSecretName", "ghlPit");
      if (pit) await updateObjectRecord(pit, "custom_objects.transactions", transactionId, {
        checkin_date: newCheckIn, checkout_date: newCheckOut,
      });
    }
  } catch (err) {
    console.error(`Reschedule ledger sync failed for ${snapshot.bookingId}:`, err.message);
    ledgerOk = false;
    ghlOk = false;
  }

  const calendar = await updateGhlBookingDates(env, tenant, snapshot, newCheckIn, newCheckOut);

  await notifyAndRecord(env, snapshot, tenant.ghlRescheduleUrl, {
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
    calendarUpdateRequired: calendar.ok ? "false" : "true"
  });

  return json({
    bookingId: snapshot.bookingId,
    oldDates: oldStay,
    newDates: { checkIn: newCheckIn, checkOut: newCheckOut, nights: newNights },
    rentDelta, netRentDelta, depositDelta, totalDelta, settlement, cancellationInfo,
    ledgerSync: ledgerOk ? "ok" : "failed", ghlSync: ghlOk ? "ok" : "failed",
    calendarUpdateRequired: !calendar.ok, calendar
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
  let ledgerOk = true;
  let ghlOk = true;

  // This function runs against the CHILD delta-charge booking (a synthetic
  // snapshot with no .stay/.ghl of its own) -- every ledger/GHL write below
  // uses `parent`, the real reservation, same as the original Airtable code
  // always updated the PARENT's Order record, never the child's.
  try {
    if (parent) {
      // Payout: split ONLY the rent-delta portion (real rent revenue). Deposit-
      // delta is pass-through (held); the processing fee is retained -- neither
      // is income, so neither gets a ledger row.
      const rows = [];
      if (snapshot.rentDelta > 0) {
        const ownerPct = parent.payout?.ownerPct ?? tenant.ownerPct ?? 0.85;
        const ownerAmt = round2(snapshot.rentDelta * ownerPct);
        rows.push({
          recipient: "owner", category: "income", entry_type: "reschedule_charge_owner",
          amount: ownerAmt, reference: capture.captureId, source: "reschedule",
          description: `Reschedule adjustment, owner share (rent ${snapshot.rentDelta}, deposit ${snapshot.depositDelta}, fee ${snapshot.deltaFee})`
        });
        rows.push({
          recipient: "manager", category: "income", entry_type: "reschedule_charge_manager",
          amount: round2(snapshot.rentDelta - ownerAmt), reference: capture.captureId, source: "reschedule",
          description: `Reschedule adjustment, manager share (rent ${snapshot.rentDelta}, deposit ${snapshot.depositDelta}, fee ${snapshot.deltaFee})`
        });
      }

      if (rows.length) {
        const result = await writeAndSyncRows(env, tenant, parent, rows);
        if (!result.d1.ok) { console.error(`Reschedule adjustment D1 write failed for ${snapshot.bookingId}: ${result.d1.reason} ${result.d1.error || ""}`); ledgerOk = false; }
        if (!result.ghl.ok) { console.error(`Reschedule adjustment GHL sync failed for ${snapshot.bookingId}: ${result.ghl.reason} ${result.ghl.error || ""}`); ghlOk = false; }
      }

      const transactionId = parent.ghl?.transactionId;
      if (transactionId) {
        const pit = resolveSecret(tenant, env, "ghlPitSecretName", "ghlPit");
        if (pit) await updateObjectRecord(pit, "custom_objects.transactions", transactionId, { payment_status: "paid" });
      }
    }
  } catch (err) {
    console.error(`Reschedule adjustment ledger sync failed for ${snapshot.bookingId}:`, err.message);
    ledgerOk = false;
    ghlOk = false;
  }

  // Reuse the EXISTING "Payment Confirmed" workflow -- no new GHL build needed.
  await notifyAndRecord(env, snapshot, tenant.ghlPaymentConfirmedUrl, paymentConfirmedPayload({
    bookingId: snapshot.bookingId,
    contactId: snapshot.ghlContactId,
    amountPaid: capture.gross,
    depositTotal: snapshot.depositDelta > 0 ? snapshot.depositDelta : 0,
    // The PARENT booking dates -- this is a delta charge on an existing stay,
    // and the workflow cares which stay, not which adjustment record.
    checkIn: parent?.stay?.checkIn,
    checkOut: parent?.stay?.checkOut,
    propertyName: snapshot.propertyCode || tenant.brandName,
  }));

  return { settled: true, ledgerOk, ghlOk };
}
