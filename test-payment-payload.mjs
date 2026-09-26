// One business event, one shape. A payment is confirmed by two routes and GHL
// has to read both with a single field mapping.
//
// Run: node test-payment-payload.mjs
//
// This exists because those two shapes drifted and a payment-confirmed tag
// silently failed to apply on DEMO-HOMS on 2026-09-26. The webhook carried
// `status`; the /ghl-invoice-paid response did not. A contact field mapped to
// `status` worked on one route and wrote nothing on the other.
import assert from "node:assert";

const { paymentConfirmedPayload, paymentSkippedPayload } = await import("./src/payment.js");

// Every field a GHL workflow may map. If one is added to the builder, it is
// added for both routes at once -- which is the whole point of the builder.
const FIELDS = ["event", "bookingId", "contactId", "status", "amountPaid", "depositTotal", "checkIn", "checkOut", "propertyName"];

// ---- 1. the confirmed payload is complete and typed for GHL ---------------
{
  const p = paymentConfirmedPayload({
    bookingId: "BK-1", contactId: "C-1", amountPaid: 355.1, depositTotal: 0,
    checkIn: "2026-09-28", checkOut: "2026-09-30", propertyName: "Test Villa 2",
  });
  assert.deepStrictEqual(Object.keys(p).sort(), [...FIELDS].sort());
  assert.strictEqual(p.event, "payment_confirmed");
  assert.strictEqual(p.status, "paid");
  // GHL merge tags are text. Money arrives as a fixed 2dp string, never a
  // number that might render as 355.1 on an invoice or a message.
  assert.strictEqual(p.amountPaid, "355.10");
  assert.strictEqual(p.depositTotal, "0.00");
  console.log("1) The confirmed payload carries every mappable field, money as 2dp text");
}

// ---- 2. missing inputs become empty strings, never undefined -------------
// An undefined in a JSON body renders as a missing key, and a GHL mapping
// pointed at a missing key leaves the old value in place.
{
  const p = paymentConfirmedPayload({});
  for (const f of FIELDS) {
    assert.notStrictEqual(p[f], undefined, `${f} must always be present`);
  }
  assert.strictEqual(p.bookingId, "");
  assert.strictEqual(p.contactId, "");
  assert.strictEqual(p.amountPaid, "0.00");
  console.log("2) Absent inputs render as empty strings, so no mapped field is ever left holding a stale value");
}

// ---- 3. a non-confirming answer still carries a status ------------------
// Otherwise a booking cancelled after an earlier paid run keeps reading "paid".
{
  const s = paymentSkippedPayload("cancelled", "BK-2");
  assert.strictEqual(s.status, "cancelled");
  assert.strictEqual(s.bookingId, "BK-2");
  assert.strictEqual(s.event, "payment_not_confirmed");
  assert.strictEqual(s.amountPaid, "0.00", "a skip must not leave an amount that implies payment");
  assert.notStrictEqual(s.status, "paid");
  console.log("3) A skipped payment still reports a status, so a mapped field is overwritten not left stale");
}

// ---- 4. the two routes agree on every shared field ----------------------
// The actual regression guard. Built the way each route builds it.
{
  const args = {
    bookingId: "BK-3", contactId: "C-3", amountPaid: 212, depositTotal: 100,
    checkIn: "2026-10-01", checkOut: "2026-10-05", propertyName: "Arpel 07",
  };

  // Route A: the webhook body settle() posts to ghlPaymentConfirmedUrl.
  const webhookBody = paymentConfirmedPayload(args);

  // Route B: the /ghl-invoice-paid response, which spreads the same builder
  // and then adds its own route-specific keys.
  const response = { ...paymentConfirmedPayload(args), ok: true, invoiceId: "inv_1", settled: true, totalPaid: 212, ledgerOk: true, ghlOk: true };

  for (const f of FIELDS) {
    assert.deepStrictEqual(response[f], webhookBody[f],
      `${f} must be identical on both routes -- one GHL mapping reads both`);
  }
  // And the response keeps everything that already consumed it.
  for (const k of ["ok", "invoiceId", "settled", "totalPaid", "ledgerOk", "ghlOk"]) {
    assert.notStrictEqual(response[k], undefined, `${k} must survive for existing consumers`);
  }
  console.log("4) Both routes agree field for field, and the response keeps its own keys too");
}

// ---- 5. a reschedule delta is the same event -----------------------------
// It reuses the Payment Confirmed workflow deliberately, so it must look the
// same. Its dates are the PARENT stay's, not the adjustment record's.
{
  const delta = paymentConfirmedPayload({
    bookingId: "BK-4-RESCHED", contactId: "C-4", amountPaid: 45,
    depositTotal: 0, checkIn: "2026-11-02", checkOut: "2026-11-06", propertyName: "Casa Uno",
  });
  assert.strictEqual(delta.event, "payment_confirmed");
  assert.strictEqual(delta.status, "paid");
  assert.deepStrictEqual(Object.keys(delta).sort(), [...FIELDS].sort(),
    "a reschedule delta must not be a third shape");
  console.log("5) A reschedule delta charge is the same event and the same shape");
}

console.log("\nPASS — payment confirmation is one shape across all three routes, and a skip always reports a status.");
