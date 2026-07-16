// booking-composer.js (v2) — GHL payload + tenant profile → snapshot + PayPal purchase units.
// Deposit is passThrough — never in commission basis, never in payout split.
import { calcSecurityDeposit, round2 } from "./deposit-engine.js";

function nightsBetween(checkIn, checkOut) {
  return Math.round((new Date(checkOut) - new Date(checkIn)) / 86400000);
}

function composeBooking(payload, tenantProfile) {
  const nights = payload.nights ?? nightsBetween(payload.checkIn, payload.checkOut);
  const nightlyRate = payload.nightlyRate ?? round2(payload.bookingTotal / nights);
  const rentTotal = round2(nights * nightlyRate);
  const cleaningFee = payload.cleaningFee ?? tenantProfile.defaultCleaningFee ?? 0;
  const deposit = calcSecurityDeposit(nights, nightlyRate, tenantProfile.deposit || { rule: "tiered" }, cleaningFee);

  // Processing fee: guest-paid, default 6%, applied to rent + cleaning + deposit.
  // Collected inside the RENT purchase unit so the DEP unit stays pure —
  // deposit refunds return 100% of the deposit; the fee is never refunded.
  const feePct = tenantProfile.processingFeePct ?? 0.06;
  const processingFee = round2(feePct * (rentTotal + cleaningFee + deposit.totalDeposit));

  // Commission basis: rent only (gross — guest covers processing)
  const basis = rentTotal;
  const ownerAmt = round2(basis * tenantProfile.ownerPct);
  const managerAmt = round2(basis - ownerAmt);

  const rentUnit = {
    reference_id: `${payload.bookingId}-RENT`,
    invoice_id: `${payload.bookingId}-RENT`,
    amount: {
      currency_code: tenantProfile.currency || "USD",
      value: round2(rentTotal + cleaningFee + processingFee).toFixed(2),
      breakdown: { item_total: { currency_code: tenantProfile.currency || "USD", value: round2(rentTotal + cleaningFee + processingFee).toFixed(2) } }
    },
    items: [
      {
        name: `Estadía — ${nights} noche${nights === 1 ? "" : "s"}`,
        quantity: String(nights),
        unit_amount: { currency_code: tenantProfile.currency || "USD", value: nightlyRate.toFixed(2) }
      },
      ...(cleaningFee > 0 ? [{
        name: "Tarifa de limpieza",
        quantity: "1",
        unit_amount: { currency_code: tenantProfile.currency || "USD", value: cleaningFee.toFixed(2) }
      }] : []),
      ...(processingFee > 0 ? [{
        name: "Tarifa de procesamiento de pago",
        quantity: "1",
        unit_amount: { currency_code: tenantProfile.currency || "USD", value: processingFee.toFixed(2) }
      }] : [])
    ]
  };

  const depositUnit = deposit.totalDeposit > 0 ? {
    reference_id: `${payload.bookingId}-DEP`,
    invoice_id: `${payload.bookingId}-DEP`,
    amount: {
      currency_code: tenantProfile.currency || "USD",
      value: deposit.totalDeposit.toFixed(2),
      breakdown: { item_total: { currency_code: tenantProfile.currency || "USD", value: deposit.totalDeposit.toFixed(2) } }
    },
    items: deposit.blocks.map(b => ({
      name: `Depósito de seguridad (reembolsable) — bloque ${b.block}`,
      quantity: "1",
      unit_amount: { currency_code: tenantProfile.currency || "USD", value: b.amount.toFixed(2) }
    }))
  } : null;

  const snapshot = {
    bookingId: payload.bookingId,
    locationId: payload.locationId,
    parentBookingId: payload.parentBookingId || null,
    createdAt: new Date().toISOString(),
    // pass-throughs for Airtable mapping
    propertyCode: payload.propertyCode || null,
    ghlBookingId: payload.ghlBookingId || null,
    ghlContactId: payload.ghlContactId || null,
    bookingSource: payload.bookingSource || "Direct",
    guests: {
      adults: payload.adults ?? null,
      children: payload.children ?? null,
      pets: payload.pets ?? null
    },
    guest: { ...payload.guest, language: payload.language || null },
    stay: { checkIn: payload.checkIn, checkOut: payload.checkOut, nights, nightlyRate },
    charges: {
      rentTotal,
      cleaningFee,
      processingFee,
      feePct,
      grandTotal: round2(rentTotal + cleaningFee + processingFee + deposit.totalDeposit)
    },
    securityDeposit: {
      passThrough: true,
      total: deposit.totalDeposit,
      blocks: deposit.blocks,
      status: "pending_payment",
      refundedAmount: null,
      claimAmount: null,
      paypalCaptureId: null
    },
    payout: {
      basis,
      ownerPct: tenantProfile.ownerPct,
      owner: ownerAmt,
      manager: managerAmt,
      cleaningFeeTo: tenantProfile.cleaningFeeRecipient || "manager",
      status: "pending"
    }
  };

  return { snapshot, purchaseUnits: [rentUnit, ...(depositUnit ? [depositUnit] : [])] };
}

export { composeBooking, nightsBetween };
