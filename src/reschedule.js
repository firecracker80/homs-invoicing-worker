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
import { writeAndSyncRows, bookingTotalOf } from "./ledger.js";
import { updateObjectRecord } from "./ghl.js";
import { adminAuthorized, notifyAndRecord, cancellationTier } from "./cancellation.js";
import { paymentConfirmedPayload } from "./payment.js";
import { updateGhlBookingDates } from "./ghl-calendar.js";
import { updateInvoiceForReschedule } from "./ghl-invoice.js";
import { isMultiListingParent } from "./multi-listing.js";

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

const DAY_MS = 86400000;
const dayOnly = (s) => String(s || "").slice(0, 10);
const addDays = (isoDate, days) =>
  new Date(Date.parse(`${dayOnly(isoDate)}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
const daysBetweenDates = (a, b) =>
  Math.round((Date.parse(`${dayOnly(b)}T00:00:00.000Z`) - Date.parse(`${dayOnly(a)}T00:00:00.000Z`)) / DAY_MS);

// Move a whole bundled reservation.
//
// Only a SHIFT is accepted: every listing moves by the same number of days and
// keeps its own length, which is what "we are coming a week later" means for a
// trip with several legs. The listings stay chained in the order they were
// booked and nobody has to decide anything.
//
// A parent whose span also CHANGES length is refused, on purpose. "Two nights
// longer" on a two-leg trip does not say which leg grew, and the two answers
// bill different properties and pay different owners. Guessing the last listing
// would be a coin flip dressed up as a default -- the same reasoning that makes
// propertyNameFromInvoice refuse two candidates and listingsFrom refuse a shape
// it cannot price. The refusal names the child ids so the caller can say which.
async function handleRescheduleMultiListing(request, env, parent, body) {
  const oldCheckIn = parent.stayRange?.checkIn;
  const oldCheckOut = parent.stayRange?.checkOut;
  const newCheckIn = dayOnly(body.newCheckIn);
  const newCheckOut = dayOnly(body.newCheckOut);

  if (!oldCheckIn || !oldCheckOut) {
    return json({ error: "This reservation has no recorded date range to move.", bookingId: parent.bookingId }, 422);
  }
  if (!newCheckIn || !newCheckOut) {
    return json({ error: "newCheckIn and newCheckOut are both required." }, 400);
  }

  const shiftDays = daysBetweenDates(oldCheckIn, newCheckIn);
  const oldSpan = daysBetweenDates(oldCheckIn, oldCheckOut);
  const newSpan = daysBetweenDates(newCheckIn, newCheckOut);

  if (newSpan !== oldSpan) {
    return json({
      error:
        "A bundled reservation can only be moved as a whole, not lengthened or shortened. " +
        "Its span would change from " + oldSpan + " nights to " + newSpan + ", and that does not say which " +
        "listing changed -- different answers bill different properties and pay different owners. " +
        "Reschedule the listing itself instead.",
      bookingId: parent.bookingId,
      listings: (parent.childBookingIds || []).map((id) => ({ bookingId: id })),
    }, 422);
  }

  if (shiftDays === 0) {
    return json({ error: "These are the dates the reservation already has.", bookingId: parent.bookingId }, 400);
  }

  const results = [];
  for (const childId of parent.childBookingIds || []) {
    try {
      const child = await env.BOOKINGS.get(childId, { type: "json" });
      if (!child) {
        results.push({ bookingId: childId, status: 404, error: "Unknown bookingId" });
        continue;
      }
      const childRequest = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        json: async () => ({
          ...body,
          bookingId: childId,
          newCheckIn: addDays(child.stay.checkIn, shiftDays),
          newCheckOut: addDays(child.stay.checkOut, shiftDays),
        }),
      };
      const res = await handleReschedule(childRequest, env);
      const outcome = await res.json();
      results.push({ bookingId: childId, status: res.status, ...outcome });
    } catch (err) {
      console.error(`Multi-listing reschedule failed for ${childId}: ${err.message}`);
      results.push({ bookingId: childId, status: 500, error: err.message });
    }
  }

  await refreshParentFromChildren(env, parent);

  const failed = results.filter((r) => r.status >= 400);
  return json({
    rescheduled: true,
    multiListing: true,
    shiftDays,
    listingCount: results.length,
    stayRange: parent.stayRange,
    listings: results.map((r) => ({
      bookingId: r.bookingId, status: r.status,
      newDates: r.newDates ?? null,
      settlementType: r.settlement?.type ?? null,
    })),
    failedListings: failed.map((r) => ({ bookingId: r.bookingId, status: r.status, error: r.error || null })),
  }, failed.length ? 207 : 200);
}

// Re-read the children and rebuild the parent's span and totals from them.
//
// Called after any child moves, including a child rescheduled directly by its
// own id -- which is the supported way to change one leg. Without this the
// parent keeps the dates and money of a reservation that no longer exists,
// which is the same drift #61 closed between the snapshot and the Transaction
// record and #64 closed between the snapshot and the invoice.
export async function refreshParentFromChildren(env, parent) {
  const children = [];
  for (const id of parent.childBookingIds || []) {
    const child = await env.BOOKINGS.get(id, { type: "json" });
    if (child) children.push(child);
  }
  if (!children.length) return parent;

  const sum = (xs) => Math.round(xs.reduce((s, n) => s + (Number(n) || 0), 0) * 100) / 100;
  parent.charges = {
    rentTotal: sum(children.map((c) => c.charges?.rentTotal)),
    cleaningFee: sum(children.map((c) => c.charges?.cleaningFee)),
    processingFee: sum(children.map((c) => c.charges?.processingFee)),
  };
  parent.securityDeposit = { total: sum(children.map((c) => c.securityDeposit?.total ?? 0)) };
  parent.stayRange = {
    checkIn: children.map((c) => c.stay.checkIn).sort()[0],
    checkOut: children.map((c) => c.stay.checkOut).sort().at(-1),
  };
  await env.BOOKINGS.put(parent.bookingId, JSON.stringify(parent));
  return parent;
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

  // Rescheduling a bundled reservation is not the same problem as cancelling
  // one. Cancelling is unambiguous -- GHL cancels every listing together, and
  // each child prices against its own check-in. Moving dates is not: a parent
  // has no stay of its own, so one new check-in and check-out could mean the
  // whole trip shifts, or one leg got longer, and those pay different owners.
  if (isMultiListingParent(snapshot)) {
    return handleRescheduleMultiListing(request, env, snapshot, body);
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

    // Same reason as on the paid path below: a listing that belongs to a bundled
    // reservation has moved, so the reservation has to follow. It matters MORE
    // here -- bundled bookings have no invoice or payment wired yet, so their
    // children are all unsettled and every one of them takes this branch.
    if (snapshot.parentBookingId) {
      const parent0 = await env.BOOKINGS.get(snapshot.parentBookingId, { type: "json" });
      if (parent0 && parent0.childBookingIds) await refreshParentFromChildren(env, parent0);
    }

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

    // Which gateway settles the difference is a fact about THIS booking, not
    // about the account. snapshot.gateway records how the guest actually paid;
    // tenant.gateway is only what the account is configured with today. Reading
    // the tenant here handed a GHL-invoice guest a PayPal sandbox order for two
    // extra nights -- real intent, instrument they have no relationship with,
    // and no workflow surfacing the link. DEMO-HOMS, 2026-09-28.
    const settleVia = snapshot.gateway || tenant.gateway || "paypal";
    const rescheduleInvoiceId = snapshot.ghlInvoice?.invoiceId;

    let approveUrl, gatewayRef;
    if (settleVia === "ghl_invoice" && rescheduleInvoiceId) {
      // Nothing to create: the guest already has an invoice. It is repriced
      // further down, once the snapshot carries the new totals, and GHL turns
      // the difference into a balance due on the link they already hold.
      settlement = { type: "invoice_balance_due", amount: chargeAmount, invoiceId: rescheduleInvoiceId };
    } else if ((tenant.gateway || "paypal") === "stripe") {
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

    // Only the gateway paths raise a separate charge to be settled later. The
    // invoice path has already decided what it is doing and has no child order
    // to track -- writing one would leave an adjustment nobody can ever settle.
    if (settlement.type !== "invoice_balance_due") {
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
    }

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
  // Reprice the guest's invoice now that the snapshot holds the new totals --
  // buildAppendItems reads them, so this cannot run back in the settlement
  // branch where the charges are still the old stay's.
  //
  // A failure here does not fail the reschedule: the dates have moved, the
  // ledger is about to be written, and an invoice that could not be repriced is
  // one call to recover. Throwing would leave the caller unsure which half
  // happened, which is the same trap provisionTenantRecord avoids.
  if (settlement.type === "invoice_balance_due") {
    try {
      const result = await updateInvoiceForReschedule({
        tenant, env, locationId: snapshot.locationId,
        invoiceId: settlement.invoiceId, snapshot, previousNights: oldStay.nights,
      });
      settlement = { ...settlement, ...result };
      // The guest is now billed a larger fee, so the booking has to say so --
      // the invoice and the snapshot disagreeing about what was charged is the
      // same class of drift #61 closed on the Transaction record.
      if (result.ok && result.processingFee != null) {
        snapshot.charges.processingFee = result.processingFee;
        snapshot.charges.grandTotal = round2(
          newRent + snapshot.charges.cleaningFee + result.processingFee + newDeposit
        );
      }
    } catch (err) {
      console.error(`Reschedule invoice reprice failed for ${snapshot.bookingId}: ${err.message}`);
      settlement = { ...settlement, ok: false, reason: "invoice_update_failed", detail: err.message };
    }
  }

  snapshot.reschedules = [...(snapshot.reschedules || []), {
    at: new Date().toISOString(),
    from: oldStay,
    to: { checkIn: newCheckIn, checkOut: newCheckOut, nights: newNights },
    rentDelta, netRentDelta, depositDelta, totalDelta, settlement, cancellationInfo,
    reason: body.reason || ""
  }];
  await env.BOOKINGS.put(snapshot.bookingId, JSON.stringify(snapshot));

  // A listing that belongs to a bundled reservation has just changed its dates
  // and its rent, so the reservation it belongs to is now describing a trip that
  // no longer exists. Rebuild it from its children.
  //
  // This runs for a leg rescheduled directly by its own id -- the supported way
  // to change one listing -- as well as for each child of a parent-level shift.
  // Doing it twice on a shift is harmless: it reads the children and recomputes.
  if (snapshot.parentBookingId) {
    const parent = await env.BOOKINGS.get(snapshot.parentBookingId, { type: "json" });
    if (parent && parent.childBookingIds) await refreshParentFromChildren(env, parent);
  }

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
      // The money moves with the dates. A stay extended by two nights was
      // writing its new checkout to the Transaction and leaving booking_total
      // at the original three nights, so the CRM under-reported the booking for
      // as long as anyone cared to look -- found on DEMO-HOMS 2026-09-27.
      //
      // platform_fee is not written: it is 0 at creation and nothing about a
      // date change earns a platform its own cut.
      const bookingTotal = bookingTotalOf(snapshot);
      if (pit) await updateObjectRecord(pit, snapshot.locationId, "custom_objects.transactions", transactionId, {
        checkin_date: newCheckIn,
        checkout_date: newCheckOut,
        booking_total: { value: bookingTotal, currency: "default" },
        net_payout: { value: bookingTotal, currency: "default" },
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
    // Balance now owed on the guest's existing invoice, when the difference
    // went there instead of onto a new payment link.
    balanceDue: settlement.amountDue != null ? Number(settlement.amountDue).toFixed(2) : "",
    invoiceNumber: settlement.invoiceNumber || "",
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
        if (pit) await updateObjectRecord(pit, parent.locationId, "custom_objects.transactions", transactionId, { payment_status: "paid" });
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
