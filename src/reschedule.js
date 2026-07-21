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
import { adminAuthorized, notifyGHL } from "./cancellation.js";

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
  const totalDelta = round2(rentDelta + depositDelta);
  const feePct = snapshot.charges.feePct ?? tenant.processingFeePct ?? 0.06;
  const cur = tenant.currency || "USD";

  let settlement = { type: "none", amount: 0 };

  if (totalDelta > 0) {
    const deltaFee = round2(totalDelta * feePct);
    const chargeAmount = round2(totalDelta + deltaFee);
    const childId = `${snapshot.bookingId}-RESCHED-${newCheckOut}`;

    const purchaseUnits = [{
      reference_id: `${childId}-ADJ`,
      invoice_id: `${childId}-ADJ`,
      amount: {
        currency_code: cur,
        value: chargeAmount.toFixed(2),
        breakdown: { item_total: { currency_code: cur, value: chargeAmount.toFixed(2) } }
      },
      items: [
        ...(rentDelta > 0 ? [{
          name: "Ajuste de tarifa por cambio de fechas",
          quantity: "1",
          unit_amount: { currency_code: cur, value: rentDelta.toFixed(2) }
        }] : []),
        ...(depositDelta > 0 ? [{
          name: "Ajuste de deposito por cambio de fechas",
          quantity: "1",
          unit_amount: { currency_code: cur, value: depositDelta.toFixed(2) }
        }] : []),
        {
          name: "Tarifa de procesamiento (ajuste)",
          quantity: "1",
          unit_amount: { currency_code: cur, value: deltaFee.toFixed(2) }
        }
      ]
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

  } else if (totalDelta < 0) {
    const refundAmount = round2(-totalDelta);
    const rentCaptureId = snapshot.captures?.RENT?.captureId;

    if (rentCaptureId) {
      const refundId = await refundPayPalPartial(
        tenant, env, rentCaptureId, refundAmount,
        `Reschedule ${snapshot.bookingId}: reembolso por cambio de fechas`
      );
      settlement = { type: "refund_issued", amount: refundAmount, refundId };
    } else {
      settlement = { type: "refund_needed_manual", amount: refundAmount };
    }
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
    rentDelta, depositDelta, totalDelta, settlement,
    reason: body.reason || ""
  }];
  await env.BOOKINGS.put(snapshot.bookingId, JSON.stringify(snapshot));

  let airtableOk = true;
  try {
    const orderId = snapshot.airtable?.orderRecordId;
    if (orderId) {
      await atUpdate(tenant, "Orders", orderId, {
        "Check-in Date": newCheckIn,
        "Check-out Date": newCheckOut,
        "Nights": newNights,
        "Reservation Total": round2(newRent + snapshot.charges.cleaningFee + snapshot.charges.processingFee),
        "Deposit Required": newDeposit,
        "Notes": `Reschedule: ${oldStay.checkIn}->${oldStay.checkOut} (${oldStay.nights}n) to ${newCheckIn}->${newCheckOut} (${newNights}n). Delta $${totalDelta.toFixed(2)} (${settlement.type}). ${body.reason || ""}`.trim()
      });
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
    totalDelta: totalDelta.toFixed(2),
    settlementType: settlement.type,
    approveUrl: settlement.approveUrl || "",
    propertyName: snapshot.propertyCode || tenant.brandName,
    calendarUpdateRequired: "true"
  });

  return json({
    bookingId: snapshot.bookingId,
    oldDates: oldStay,
    newDates: { checkIn: newCheckIn, checkOut: newCheckOut, nights: newNights },
    rentDelta, depositDelta, totalDelta, settlement,
    airtableSync: airtableOk ? "ok" : "failed",
    calendarUpdateRequired: true
  });
}
