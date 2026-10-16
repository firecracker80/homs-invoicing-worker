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
import { depositConfigFor, processingFeePctFor } from "./policy.js";
import { writeAndSyncRows, bookingTotalOf } from "./ledger.js";
import { updateObjectRecord } from "./ghl.js";
import { adminAuthorized, notifyAndRecord, cancellationTier, MANUAL_REFUND_REF, MANUAL_SUFFIX } from "./cancellation.js";
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

// Both reschedule paths post here, and until 2026-10-13 they posted DIFFERENT
// key sets: the unpaid path omitted balanceDue, invoiceNumber,
// manualRefundRequired, manualRefundTotal and refundFailed. GHL captures a
// webhook's field schema from the first payload it ever receives, so whichever
// path fired first decided which fields the workflow could reference at all --
// and on an account seeded by the unpaid path, a shortened paid stay owing the
// guest money had nowhere to say so.
//
// One builder, one key set, always complete. Additive by construction: a
// workflow that ignores a field behaves exactly as before, and every field is
// now there to be mapped. webhook-seed.js calls this to seed the real schema.
export function rescheduleNotifyPayload({
  bookingId, contactId, email, guestName,
  oldCheckIn, oldCheckOut, newCheckIn, newCheckOut, newNights,
  rentTotal, depositTotal, processingFee, totalDelta,
  settlementType, approveUrl, balanceDue, invoiceNumber,
  adminFeeRetained, cancellationTier,
  manualRefundTotal = 0, refundFailed = false,
  propertyName, calendarUpdateRequired,
}) {
  const manual = Number(manualRefundTotal) || 0;
  return {
    event: "booking_rescheduled",
    bookingId: bookingId || "",
    contactId: contactId || "",
    email: email || "",
    firstName: String(guestName || "").split(" ")[0],
    oldCheckIn: oldCheckIn || "",
    oldCheckOut: oldCheckOut || "",
    newCheckIn: newCheckIn || "",
    newCheckOut: newCheckOut || "",
    newNights,
    rentTotal: Number(rentTotal || 0).toFixed(2),
    depositTotal: Number(depositTotal || 0).toFixed(2),
    processingFee: Number(processingFee || 0).toFixed(2),
    totalDelta: Number(totalDelta || 0).toFixed(2),
    settlementType: settlementType || "",
    approveUrl: approveUrl || "",
    // Balance now owed on the guest's existing invoice, when the difference
    // went there instead of onto a new payment link.
    balanceDue: balanceDue != null ? Number(balanceDue).toFixed(2) : "",
    invoiceNumber: invoiceNumber || "",
    adminFeeRetained: Number(adminFeeRetained || 0).toFixed(2),
    cancellationTier: cancellationTier || "",
    // What somebody has to DO, not just what happened -- the same pair /cancel
    // grew on 2026-09-26 and for the same reason. On the ghl_invoice gateway
    // every refund is issued by hand, so a shortened stay left money owed to a
    // guest with nothing anywhere saying so: the ledger now reverses the income
    // either way, and this is how a person finds out there is a payment to make.
    manualRefundRequired: manual > 0 ? "yes" : "no",
    manualRefundTotal: manual.toFixed(2),
    // Separate on purpose: a refund the gateway REFUSED is a fault, not a task,
    // and a manager reading one as the other would either pay twice or not at all.
    refundFailed: refundFailed ? "yes" : "no",
    propertyName: propertyName || "",
    calendarUpdateRequired: calendarUpdateRequired ? "true" : "false",
  };
}

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
    const feePct0 = processingFeePctFor(tenant, snapshot);
    const newProcessingFee = round2(feePct0 * (newRent + snapshot.charges.cleaningFee + newDeposit));

    // A move that changes no money needs no invoice and no repricing: the
    // dates shift and every figure stays where it was. This is the whole of a
    // bundled reschedule -- those are pure shifts by construction, the span is
    // refused if it changes -- and a child of one never carries an invoice
    // anyway, because the reservation-level facts live on the parent
    // (multi-listing.js: "the children are stays, not sales").
    //
    // Checked before the invoice is required, or a bundled shift is refused for
    // lacking something it has no reason to have.
    // Compared as numbers with a zero default: an account with no deposit
    // leaves securityDeposit.total undefined, and undefined === 0 is false, so
    // a strict comparison refuses a shift that changes nothing.
    const moneyUnchanged = round2(newRent) === round2(snapshot.charges.rentTotal ?? 0)
      && round2(newDeposit) === round2(snapshot.securityDeposit?.total ?? 0);
    if (moneyUnchanged) {
      const oldStayS = { ...snapshot.stay };
      snapshot.stay = { ...snapshot.stay, checkIn: newCheckIn, checkOut: newCheckOut, nights: newNights };
      snapshot.reschedules = [...(snapshot.reschedules || []), {
        at: new Date().toISOString(), from: oldStayS,
        to: { checkIn: newCheckIn, checkOut: newCheckOut, nights: newNights },
        unpaid: true, unchangedTotals: true, reason: body.reason || ""
      }];
      await env.BOOKINGS.put(snapshot.bookingId, JSON.stringify(snapshot));

      if (snapshot.parentBookingId) {
        const parentS = await env.BOOKINGS.get(snapshot.parentBookingId, { type: "json" });
        if (parentS && parentS.childBookingIds) await refreshParentFromChildren(env, parentS);
      }

      const calendarS = await updateGhlBookingDates(env, tenant, snapshot, newCheckIn, newCheckOut);

      await notifyAndRecord(env, snapshot, tenant.ghlRescheduleUrl, rescheduleNotifyPayload({
        bookingId: snapshot.bookingId,
        contactId: snapshot.ghlContactId,
        email: snapshot.guest?.email,
        guestName: snapshot.guest?.name,
        oldCheckIn: oldStayS.checkIn, oldCheckOut: oldStayS.checkOut,
        newCheckIn, newCheckOut, newNights,
        rentTotal: newRent,
        depositTotal: newDeposit,
        processingFee: snapshot.charges.processingFee ?? 0,
        totalDelta: 0,
        settlementType: "unpaid_dates_moved",
        approveUrl: "",
        balanceDue: null,
        invoiceNumber: "",
        adminFeeRetained: 0,
        cancellationTier: "",
        propertyName: snapshot.propertyCode || tenant.brandName,
        calendarUpdateRequired: !calendarS.ok
      }));

      return json({
        bookingId: snapshot.bookingId,
        oldDates: oldStayS,
        newDates: { checkIn: newCheckIn, checkOut: newCheckOut, nights: newNights },
        settlement: { type: "unpaid_dates_moved", amount: 0 },
        calendarUpdateRequired: !calendarS.ok, calendar: calendarS
      });
    }

    // An unpaid booking on the GHL-invoice path already has an invoice the
    // guest is looking at. Reprice THAT, rather than issuing a second way to
    // pay for the same stay.
    //
    // Until 2026-10-15 this branch did not exist: the unpaid path called
    // createOrder unconditionally while only the settled path below checked
    // for an invoice. On an account with PayPal credentials that produced a
    // real PayPal order beside the guest's existing GHL invoice -- two live
    // payment routes for one booking -- and on an account without them it
    // threw. Every live account is on the invoice path, so every unpaid
    // reschedule took it.
    const unpaidInvoiceId = snapshot.ghlInvoice?.invoiceId;
    if (unpaidInvoiceId) {
      // Captured here rather than reusing oldStay0, which the PayPal branch
      // below declares after this point.
      const oldStayU = { ...snapshot.stay };
      let repriced;
      try {
        repriced = await updateInvoiceForReschedule({
          tenant, env, locationId: snapshot.locationId,
          invoiceId: unpaidInvoiceId, snapshot: {
            ...snapshot,
            stay: { ...snapshot.stay, checkIn: newCheckIn, checkOut: newCheckOut, nights: newNights },
            charges: { ...snapshot.charges, rentTotal: newRent },
            securityDeposit: { ...snapshot.securityDeposit, total: newDeposit },
          },
          previousNights: oldStayU.nights,
        });
      } catch (err) {
        // The dates are not moved if the money could not be. A snapshot that
        // says one thing while the guest's invoice says another is the drift
        // this file spends most of its length preventing.
        console.error(`Reschedule reprice failed for ${snapshot.bookingId}: ${err.message}`);
        return json({ error: "Could not reprice the invoice for the new dates", detail: err.message }, 502);
      }
      if (!repriced.ok) {
        console.error(`Reschedule reprice refused for ${snapshot.bookingId}: ${repriced.reason}`);
        return json({ error: "Could not reprice the invoice for the new dates", ...repriced }, 502);
      }

      // The invoice's own recomputed fee wins over the one derived above: it is
      // what the guest will actually be asked for.
      const feeCharged = repriced.processingFee != null ? repriced.processingFee : newProcessingFee;
      const grandTotal = round2(newRent + snapshot.charges.cleaningFee + feeCharged + newDeposit);

      snapshot.stay = { ...snapshot.stay, checkIn: newCheckIn, checkOut: newCheckOut, nights: newNights };
      snapshot.charges.rentTotal = newRent;
      snapshot.charges.processingFee = feeCharged;
      snapshot.charges.grandTotal = grandTotal;
      snapshot.securityDeposit.total = newDeposit;
      snapshot.securityDeposit.blocks = newDepositCalc.blocks;
      snapshot.reschedules = [...(snapshot.reschedules || []), {
        at: new Date().toISOString(), from: oldStayU,
        to: { checkIn: newCheckIn, checkOut: newCheckOut, nights: newNights },
        unpaid: true, invoiceId: unpaidInvoiceId, reason: body.reason || ""
      }];
      await env.BOOKINGS.put(snapshot.bookingId, JSON.stringify(snapshot));

      if (snapshot.parentBookingId) {
        const parentU = await env.BOOKINGS.get(snapshot.parentBookingId, { type: "json" });
        if (parentU && parentU.childBookingIds) await refreshParentFromChildren(env, parentU);
      }

      const calendarU = await updateGhlBookingDates(env, tenant, snapshot, newCheckIn, newCheckOut);

      await notifyAndRecord(env, snapshot, tenant.ghlRescheduleUrl, rescheduleNotifyPayload({
        bookingId: snapshot.bookingId,
        contactId: snapshot.ghlContactId,
        email: snapshot.guest?.email,
        guestName: snapshot.guest?.name,
        oldCheckIn: oldStayU.checkIn, oldCheckOut: oldStayU.checkOut,
        newCheckIn, newCheckOut, newNights,
        rentTotal: newRent,
        depositTotal: newDeposit,
        processingFee: feeCharged,
        totalDelta: grandTotal,
        settlementType: "unpaid_invoice_repriced",
        // No new link: the guest pays the invoice they already hold.
        approveUrl: "",
        balanceDue: repriced.amountDue != null ? repriced.amountDue : grandTotal,
        invoiceNumber: repriced.invoiceNumber || "",
        adminFeeRetained: 0,
        cancellationTier: "",
        propertyName: snapshot.propertyCode || tenant.brandName,
        calendarUpdateRequired: !calendarU.ok
      }));

      return json({
        bookingId: snapshot.bookingId,
        oldDates: oldStayU,
        newDates: { checkIn: newCheckIn, checkOut: newCheckOut, nights: newNights },
        settlement: { type: "unpaid_invoice_repriced", invoiceId: unpaidInvoiceId, grandTotal },
        calendarUpdateRequired: !calendarU.ok, calendar: calendarU
      });
    }

    // A leg of a bundled reservation, changing length. The invoice lives on
    // the parent and covers every listing on it, while
    // updateInvoiceForReschedule reprices a single stay line -- so there is no
    // honest way to reprice one leg of it here.
    //
    // The old code raised a separate PayPal order per child instead, which on
    // an enrich account meant a second way to pay beside the reservation's own
    // invoice. Refusing is not a regression on that; it is the same gap, said
    // out loud.
    if (snapshot.parentBookingId) {
      console.error(`Reschedule refused for ${snapshot.bookingId}: a bundled leg cannot be repriced on its own`);
      return json({
        error: "A listing on a bundled reservation cannot be repriced on its own",
        detail: "The guest pays one invoice for the whole reservation, so changing one leg's length changes a total this endpoint cannot safely rewrite. Move the whole reservation by its own id, or adjust the invoice by hand.",
        bookingId: snapshot.bookingId,
        parentBookingId: snapshot.parentBookingId,
      }, 422);
    }

    // No invoice on an unpaid booking means its enrich failed -- the branch
    // above handles every booking that has one. There is nothing to reprice
    // and, since the Worker's own checkout was retired on 2026-10-16, no
    // other way to ask the guest for money. Refuse rather than move the dates
    // and leave the charge unreconciled.
    console.error(`Reschedule refused for ${snapshot.bookingId}: unpaid booking has no GHL invoice`);
    return json({
      error: "This booking has no invoice to reprice",
      detail: snapshot.enrichFailed
        ? "Its invoice was never created: " + (snapshot.enrichFailed.error || "enrich failed")
        : "An unpaid booking is rescheduled by repricing the invoice the guest already holds.",
      bookingId: snapshot.bookingId,
    }, 409);
  }

  const rentDelta = round2(newRent - oldRent);
  const depositDelta = round2(newDeposit - oldDeposit);
  const feePct = processingFeePctFor(tenant, snapshot);
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

    if (settleVia === "ghl_invoice" && rescheduleInvoiceId) {
      // Nothing to create: the guest already has an invoice. It is repriced
      // further down, once the snapshot carries the new totals, and GHL turns
      // the difference into a balance due on the link they already hold.
      settlement = { type: "invoice_balance_due", amount: chargeAmount, invoiceId: rescheduleInvoiceId };
    } else {
      // No invoice on this reservation, and no checkout since 2026-10-16. The
      // adjustment is recorded as owed rather than silently dropped or charged
      // through a route that no longer exists.
      settlement = { type: "additional_charge_needed_manual", amount: chargeAmount, childId };
    }

    // A child "reschedule_adjustment" snapshot used to be written here, so
    // /paypal/return could find and settle the delta-charge order when the
    // guest paid it. There is no such order since 2026-10-16: an extra charge
    // is either a balance on the guest's existing invoice, or it is recorded
    // as owed for somebody to collect. Writing a child order nothing can ever
    // settle would leave an adjustment stranded, which is the failure the old
    // comment here was guarding against.

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

    // Worked out and recorded, never issued -- see the note on refunds in
    // cancellation.js. Shortening a paid stay owes the guest money, and this is
    // how a person finds out there is a payment to make.
    if (rentRefundAmt > 0) {
      parts.push({ type: "rent_refund_needed_manual", amount: rentRefundAmt });
    }

    if (depositRefundAmt > 0) {
      parts.push({ type: "deposit_refund_needed_manual", amount: depositRefundAmt });
    }

    // Every part is manual now -- nothing is issued, so there is no "issued"
    // outcome left to distinguish.
    settlement = {
      type: "refund_partial_manual",
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

    // Rent income reversed for the nights that are no longer being stayed.
    //
    // This used to run only when the gateway had ISSUED the refund, which meant
    // it almost never ran at all: on the ghl_invoice gateway there is no
    // capture to refund against, so the part is rent_refund_needed_manual and
    // no reversal was written -- while the admin-fee income rows above were
    // written every time. A shortened invoice-paid stay therefore charged a fee
    // for dropping the nights AND went on crediting the owner for hosting them.
    // The statement gained income on both sides of the same change.
    //
    // The nights are dropped whether or not the cash has moved back yet, so the
    // income reverses on the terms /cancel has always used: referenced by the
    // gateway refund id when there is one, and by MANUAL_REFUND_REF when a
    // person still has to issue it, with the description saying which.
    const rentRefundPart = settlement.parts?.find(p => p.type.startsWith("rent_refund_"));
    if (rentRefundPart) {
      const manualRent = !rentRefundPart.refundId;
      const refundRef = rentRefundPart.refundId || MANUAL_REFUND_REF;
      const ownerShare = round2(rentRefundPart.amount * ownerPct);
      rows.push({
        recipient: "owner", category: "income", entry_type: "reschedule_refund_owner",
        amount: -ownerShare, reference: refundRef, source: "reschedule",
        description: `Rent refund reversal — reschedule shortened stay${manualRent ? MANUAL_SUFFIX : ""}`
      });
      rows.push({
        recipient: "manager", category: "income", entry_type: "reschedule_refund_manager",
        amount: -round2(rentRefundPart.amount - ownerShare), reference: refundRef, source: "reschedule",
        description: `Rent refund reversal (manager share) — reschedule shortened stay${manualRent ? MANUAL_SUFFIX : ""}`
      });
    }
    // Deliberately still gated on "issued", unlike the rent above. The rent row
    // records income that is no longer earned, which is true the moment the
    // nights are dropped. This row records the guest's own money going back to
    // them -- until it actually has, the liability is still outstanding, and
    // writing it early would say a deposit had been returned when it had not.
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
        // A reschedule overwrote the dates in place and left no trace, so
        // nothing downstream could tell a booking that had been moved from one
        // booked for those dates in the first place.
        //
        // Not a terminal state: the booking is still live, and the dashboard
        // keeps deriving new/active/departing from the NEW dates. This only
        // records that it moved.
        booking_status: "rescheduled",
      });
    }
  } catch (err) {
    console.error(`Reschedule ledger sync failed for ${snapshot.bookingId}:`, err.message);
    ledgerOk = false;
    ghlOk = false;
  }

  const calendar = await updateGhlBookingDates(env, tenant, snapshot, newCheckIn, newCheckOut);

  // Money owed back to the guest that no gateway is going to move: either there
  // was no capture to refund against (the ghl_invoice gateway, by design) or a
  // refund was attempted and refused.
  const manualRefundTotal = round2((settlement.parts || [])
    .filter(p => p.type.endsWith("_needed_manual") || p.type.endsWith("_failed"))
    .reduce((s, p) => s + (Number(p.amount) || 0), 0));

  await notifyAndRecord(env, snapshot, tenant.ghlRescheduleUrl, rescheduleNotifyPayload({
    bookingId: snapshot.bookingId,
    contactId: snapshot.ghlContactId,
    email: snapshot.guest?.email,
    guestName: snapshot.guest?.name,
    oldCheckIn: oldStay.checkIn,
    oldCheckOut: oldStay.checkOut,
    newCheckIn, newCheckOut, newNights,
    rentTotal: newRent,
    depositTotal: newDeposit,
    processingFee: deltaFeeForDisplay,
    totalDelta,
    settlementType: settlement.type,
    approveUrl: settlement.approveUrl || "",
    balanceDue: settlement.amountDue,
    invoiceNumber: settlement.invoiceNumber,
    adminFeeRetained: cancellationInfo?.adminFee ?? 0,
    cancellationTier: cancellationInfo?.tier,
    manualRefundTotal,
    refundFailed: (settlement.parts || []).some(p => p.type.endsWith("_failed")),
    propertyName: snapshot.propertyCode || tenant.brandName,
    calendarUpdateRequired: !calendar.ok
  }));

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
  // uses `parent`, the real reservation
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
