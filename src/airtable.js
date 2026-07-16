// airtable.js (v2) — mapped to the REAL base schema (2026-07-14)
// Writes: Orders, Order Items, Payments (stubs).
// Snapshot in KV remains source of truth; Airtable is the reporting mirror.
//
// MAPPING DECISIONS (confirm these — see notes in chat):
//   Orders."Reservation Total"  = rent + cleaning (deposit EXCLUDED —
//                                 "Deposit Required" carries the deposit)
//   Orders."Remaining Balance"  = Reservation Total + Deposit Required (nothing paid yet)
//   Payments."Payment Type"     = "Rent" | "Security Deposit" (distinguishes purchase units;
//                                 refunds later become new rows with type "Refund")
//   Payments."Payment #"        = `${reservationNumber}-RENT` / `-DEP` (matches
//                                 PayPal purchase-unit reference_id → easy reconciliation)
//   Order Items."Line Item"     = description; deposit tier & block encoded in Notes
//                                 (add "Deposit Tier"/"Deposit Block" fields later if you
//                                 want them filterable)

const API = "https://api.airtable.com/v0";

async function atCreate(tenant, table, records) {
  const res = await fetch(`${API}/${tenant.airtableBaseId}/${encodeURIComponent(table)}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${tenant.airtableToken}`,
      "Content-Type": "application/json"
    },
    // typecast:true lets Airtable auto-create select options (e.g. new Order Status)
    body: JSON.stringify({ records: records.map(fields => ({ fields })), typecast: true })
  });
  if (!res.ok) throw new Error(`Airtable ${table} failed: ${res.status} ${await res.text()}`);
  return (await res.json()).records;
}

async function createBookingRecords(tenant, snapshot, gatewayRef) {
  const isStripe = snapshot.gateway === "stripe";
  const methodName = isStripe ? "Stripe" : "PayPal";
  const s = snapshot;
  const reservationTotal = round2(s.charges.rentTotal + s.charges.cleaningFee + s.charges.processingFee);
  const depositRequired = s.securityDeposit.total;

  // Property link: resolved from tenant KV config (propertyCode → record ID),
  // falling back to the tenant's default property for single-property accounts.
  const propertyRecId =
    tenant.properties?.[s.propertyCode] || tenant.defaultPropertyRecId || null;

  // ---- 1. Orders ----
  const orderFields = {
    "Reservation Number": s.bookingId,
    "Guest Name": s.guest.name,
    "Guest Email": s.guest.email,
    "Language": s.guest.language || tenant.defaultLanguage || "es",
    "Booking Source": s.bookingSource || "Direct",
    "GHL Booking ID": s.ghlBookingId || s.bookingId,
    "GHL Contact ID": s.ghlContactId || "",
    "Check-in Date": s.stay.checkIn,
    "Check-out Date": s.stay.checkOut,
    "Nights": s.stay.nights,
    "Adults": s.guests?.adults ?? null,
    "Children": s.guests?.children ?? null,
    "Pets": s.guests?.pets ?? null,
    "Reservation Total": reservationTotal, // rent + cleaning + processing fee
    "Processing Fee": s.charges.processingFee,
    "Currency": tenant.currency || "USD",
    "Deposit Required": depositRequired,
    "Deposit Paid": 0,
    "Total Paid": 0,
    "Remaining Balance": round2(reservationTotal + depositRequired),
    "Balance Due": reservationTotal, // due by Payment Due Date (deposit excluded)
    "Deposit Status": "Pending Payment",
    "Order Status": "Awaiting Payment",
    "Payment Due Date": dueDate(tenant.invoiceDueHours ?? 24),
    "Notes": s.parentBookingId
      ? `Extension of ${s.parentBookingId}. ${methodName} ref: ${gatewayRef}`
      : `${methodName} ref: ${gatewayRef}`
  };
  if (propertyRecId) orderFields["Property"] = [propertyRecId];
  const [order] = await atCreate(tenant, "Orders", [orderFields]);

  // ---- 2. Order Items ----
  const items = [
    {
      "Line Item": `Estadía — ${s.stay.nights} noche${s.stay.nights === 1 ? "" : "s"}`,
      "Order": [order.id],
      "Item Type": "Rent",
      "Quantity": s.stay.nights,
      "Unit Price": s.stay.nightlyRate,
      "Total Price": s.charges.rentTotal,
      "Status": "Pending"
    }
  ];
  if (s.charges.cleaningFee > 0) {
    items.push({
      "Line Item": "Tarifa de limpieza",
      "Order": [order.id],
      "Item Type": "Cleaning Fee",
      "Quantity": 1,
      "Unit Price": s.charges.cleaningFee,
      "Total Price": s.charges.cleaningFee,
      "Status": "Pending"
    });
  }
  if (s.charges.processingFee > 0) {
    items.push({
      "Line Item": "Tarifa de procesamiento de pago",
      "Order": [order.id],
      "Item Type": "Processing Fee",
      "Quantity": 1,
      "Unit Price": s.charges.processingFee,
      "Total Price": s.charges.processingFee,
      "Status": "Pending",
      "Notes": `${(s.charges.feePct * 100).toFixed(1)}% of rent + cleaning + deposit`
    });
  }
  for (const b of s.securityDeposit.blocks) {
    items.push({
      "Line Item": `Depósito de seguridad (reembolsable) — bloque ${b.block}`,
      "Order": [order.id],
      "Item Type": "Security Deposit",
      "Quantity": 1,
      "Unit Price": b.amount,
      "Total Price": b.amount,
      "Status": "Pending",
      "Notes": `Block ${b.block}: ${b.nights} nights, tier ${b.tier}`
    });
  }
  const orderItems = await atCreate(tenant, "Order Items", items);

  // ---- 3. Payments stubs (one per PayPal purchase unit) ----
  const paymentStubs = [
    {
      "Payment #": `${s.bookingId}-RENT`,
      "Order": [order.id],
      "Payment Method": methodName,
      "Payment Type": "Rent",
      ...(isStripe ? { "Gateway Transaction ID": gatewayRef } : { "PayPal Order ID": gatewayRef }),
      "Payment Amount": reservationTotal,
      "Currency": tenant.currency || "USD",
      "Payment Status": "Pending",
      "Cleared for Payout": false
    }
  ];
  if (depositRequired > 0) {
    paymentStubs.push({
      "Payment #": `${s.bookingId}-DEP`,
      "Order": [order.id],
      "Payment Method": methodName,
      "Payment Type": "Security Deposit",
      ...(isStripe ? { "Gateway Transaction ID": gatewayRef } : { "PayPal Order ID": gatewayRef }),
      "Payment Amount": depositRequired,
      "Currency": tenant.currency || "USD",
      "Payment Status": "Pending",
      "Cleared for Payout": false // deposits NEVER clear for payout
    });
  }
  const payments = await atCreate(tenant, "Payments", paymentStubs);

  return { orderRecordId: order.id, itemCount: orderItems.length, paymentCount: payments.length };
}

function dueDate(hours) {
  return new Date(Date.now() + hours * 3600000).toISOString();
}
function round2(n) { return Math.round(n * 100) / 100; }

export { createBookingRecords, atCreate };
