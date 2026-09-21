// index.js (v2) — Cloudflare Worker entry
// POST /booking-created ← GHL Webhook action (after Calcular Reserva)
import { composeBooking } from "./booking-composer.js";
import { createOrder } from "./paypal.js";
import { createCheckoutSession } from "./stripe.js";
import { handlePayPalReturn, handlePayPalWebhook, handleStripeReturn, handleStripeWebhook, handleGhlInvoicePaid } from "./payment.js";
import { handleCancel, handleDepositRefund } from "./cancellation.js";
import { handleReschedule } from "./reschedule.js";
import { resolveDraftInvoiceId, enrichAndSendInvoice, invoiceHasWorkerLines } from "./ghl-invoice.js";

// A "sending" claim younger than this belongs to a run that may still be
// working; an older one whose invoice GHL still shows as a draft died part-way.
const CLAIM_STALE_MS = 2 * 60 * 1000;
import { handleOwnerStatement, handleManagerStatement, handleReconcile } from "./reports.js";
import { handleProvisionTenant } from "./provision.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json" }
  });
}

// Normalize the GHL webhook body to the worker's internal shape.
// Accepts both the natural GHL flat form (firstName/lastName, stayTotal,
// contactId, propertyName) and the canonical nested form.
// "$1,420.00" → 1420 ; "420" → 420 ; garbage → NaN
function toMoney(v) {
  if (v == null || v === "") return NaN;
  if (typeof v === "number") return v;
  return Number(String(v).replace(/[^0-9.\-]/g, ""));
}

// Extract a clean YYYY-MM-DD from datetime strings in every format GHL emits:
// "2026-07-22 15:00:00", "2026-07-22T15:00:00-04:00", "07/22/2026 3:00 PM",
// "Wednesday, July 22, 2026 3:00 PM", "miércoles, 22 de julio de 2026"
const MONTHS = {
  january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,
  september:9,october:10,november:11,december:12,
  enero:1,febrero:2,marzo:3,abril:4,mayo:5,junio:6,julio:7,agosto:8,
  septiembre:9,octubre:10,noviembre:11,diciembre:12
};
function toDateOnly(v) {
  if (v == null) return v;
  const s = String(v).trim();
  const iso = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  // "July 22, 2026" (optionally prefixed "Wednesday, ")
  const en = s.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (en && MONTHS[en[1].toLowerCase()])
    return `${en[3]}-${String(MONTHS[en[1].toLowerCase()]).padStart(2, "0")}-${en[2].padStart(2, "0")}`;
  // "22 de julio de 2026"
  const es = s.match(/(\d{1,2})\s+de\s+([A-Za-zéí]+)\s+de\s+(\d{4})/i);
  if (es && MONTHS[es[2].toLowerCase()])
    return `${es[3]}-${String(MONTHS[es[2].toLowerCase()]).padStart(2, "0")}-${es[1].padStart(2, "0")}`;
  // Last resort: let the JS engine try, take UTC date parts
  const d = new Date(s);
  if (!isNaN(d)) return d.toISOString().slice(0, 10);
  return s; // let downstream validation catch anything unparseable
}

function normalizePayload(raw) {
  const p = { ...raw };
  for (const k of Object.keys(p)) if (typeof p[k] === "string" && isBlank(p[k])) p[k] = null;
  // money: GHL sends stayTotal (often formatted: "$420.00")
  if (p.bookingTotal == null && p.stayTotal != null) p.bookingTotal = toMoney(p.stayTotal);
  if (typeof p.bookingTotal === "string") p.bookingTotal = toMoney(p.bookingTotal);
  if (typeof p.nightlyRate === "string") p.nightlyRate = toMoney(p.nightlyRate);
  // dates: rentalBooking.start_time/end_time are datetimes → date-only
  if (p.checkIn) p.checkIn = toDateOnly(p.checkIn);
  if (p.checkOut) p.checkOut = toDateOnly(p.checkOut);
  // guest: flat firstName/lastName/email/phone → nested guest{}
  if (!p.guest) {
    const name = [p.firstName, p.lastName].filter(Boolean).join(" ").trim();
    p.guest = { name: name || p.name || "", email: p.email || "", phone: p.phone || "" };
  }
  // ids: GHL vocabulary → internal vocabulary
  if (!p.ghlContactId && p.contactId) p.ghlContactId = p.contactId;
  if (!p.propertyCode && p.propertyName) p.propertyCode = p.propertyName;
  if (!p.language && raw.language) p.language = raw.language;
  return p;
}

// Detects GHL's in-editor "Test" fires: the editor cannot resolve merge tags,
// so values arrive as literal "{{...}}" strings — impossible in a real run.
// GHL renders unresolvable merge tags in three known ways depending on context:
// literal "{{tag}}", empty string, or the literal STRING "null".
function isBlank(v) {
  if (v == null) return true;
  const s = String(v).trim().toLowerCase();
  return s === "" || s === "null" || s === "undefined";
}

function isEditorTest(raw) {
  const keys = ["bookingId", "checkIn", "checkOut", "stayTotal", "bookingTotal", "contactId"];
  // Literal unresolved tags → editor
  if (keys.some(k => typeof raw[k] === "string" && raw[k].includes("{{"))) return true;
  // No usable bookingId → no rentalBooking context → cannot be a real run.
  return isBlank(raw.bookingId);
}

async function handleBookingCreated(request, env) {
  const raw = await request.json();

  // Editor test: return a representative sample so GHL can register the
  // response shape and save the action. No order, no records, no side effects.
  if (isEditorTest(raw)) {
    return json({
      bookingId: "SAMPLE-EDITOR-TEST",
      approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=SAMPLE",
      mode: "paypal_url",
      invoiceId: "SAMPLE-INVOICE-ID",
      grandTotal: "1037.74",
      rentTotal: "420.00",
      cleaningFee: "0.00",
      processingFee: "58.74",
      depositTotal: "490.00",
      nights: 6,
      nightlyRate: "70.00",
      gateway: "paypal",
      gatewayRef: "SAMPLE",
      testMode: true
    });
  }

  const payload = normalizePayload(raw);
  // Headers take precedence over body values when present — lets GHL configs
  // carry routing/auth in HEADERS instead of the raw body.
  const headerLoc = request.headers?.get?.("X-Location-Id");
  if (headerLoc) payload.locationId = headerLoc.trim();
  const headerSecret = request.headers?.get?.("X-Webhook-Secret");
  if (headerSecret) payload.secret = headerSecret.trim();

  // Diagnostic echo: show exactly what arrived so GHL execution logs are
  // self-explanatory when a merge tag fails to resolve. (No secrets echoed.)
  const diag = {
    bookingId: payload.bookingId ?? null,
    locationId: payload.locationId ?? null,
    checkIn: payload.checkIn ?? null,
    checkOut: payload.checkOut ?? null,
    stayTotal: payload.stayTotal ?? null,
    bookingTotal: Number.isFinite(payload.bookingTotal) ? payload.bookingTotal : String(payload.bookingTotal ?? null),
    hasPets: payload.hasPets ?? null
  };
  const missing = ["bookingId", "locationId", "checkIn", "checkOut"].filter(k => !payload[k]);
  if (missing.length) {
    console.error("Validation reject (missing). Raw body:", JSON.stringify(raw));
    return json({ error: `Missing fields: ${missing.join(", ")}`, received: diag }, 400);
  }
  if (!Number.isFinite(payload.bookingTotal) || payload.bookingTotal <= 0) {
    if (!Number.isFinite(payload.nightlyRate) || payload.nightlyRate <= 0) {
      console.error("Validation reject (amount). Raw body:", JSON.stringify(raw));
      return json({ error: "Need a positive bookingTotal (stayTotal) or nightlyRate", received: diag }, 400);
    }
  }

  const tenant = await env.TENANTS.get(payload.locationId, { type: "json" });
  if (!tenant) return json({ error: `Unknown locationId: ${payload.locationId}` }, 404);
  // Shared-secret check: if the tenant config defines webhookSecret,
  // the payload must carry a matching "secret" field.
  if (tenant.webhookSecret && payload.secret !== tenant.webhookSecret)
    return json({ error: "Unauthorized" }, 401);
  if (tenant.bookingWorkerEnabled === false)
    return json({ error: "Booking worker disabled for this account" }, 403);

  // idempotency: existing snapshot → return existing link/invoice, no re-fire.
  // Re-sending a GHL invoice on a webhook retry would double-notify the
  // guest -- ghlInvoice.invoiceId counts as "already handled" exactly like
  // an existing PayPal/Stripe link does.
  const existing = await env.BOOKINGS.get(payload.bookingId, { type: "json" });
  const existingUrl = existing?.paypal?.approveUrl || existing?.stripe?.checkoutUrl;
  const existingInvoiceId = existing?.ghlInvoice?.invoiceId;

  // A claim left at "sending" by a run that died part-way is finished now.
  // The invoice itself decides: no Worker lines on it yet -> finish it; our
  // lines already there, it's paid/void, or it can't be read -> treat as
  // done, never resend. (Status alone can't tell: GHL creates the booking
  // invoice as "sent".)
  let resumeInvoiceId = null;
  const claim = existing?.ghlInvoice;
  if (claim?.status === "sending" && !existingUrl) {
    const age = Date.now() - (Date.parse(claim.claimedAt || "") || 0);
    if (age >= CLAIM_STALE_MS) {
      const done = await invoiceHasWorkerLines({ tenant, env, locationId: payload.locationId, invoiceId: claim.invoiceId }).catch(() => true);
      if (!done) resumeInvoiceId = claim.invoiceId;
    }
  }

  if ((existingUrl || existingInvoiceId) && !resumeInvoiceId) {
    // Return the FULL field set from the stored snapshot so downstream
    // mappings (SMS, contact updates) work identically on cached hits.
    return json({
      bookingId: existing.bookingId,
      approveUrl: existingUrl || null,
      mode: existingInvoiceId ? "enrich" : "paypal_url",
      invoiceId: existingInvoiceId || undefined,
      grandTotal: existing.charges.grandTotal.toFixed(2),
      rentTotal: existing.charges.rentTotal.toFixed(2),
      cleaningFee: existing.charges.cleaningFee.toFixed(2),
      processingFee: (existing.charges.processingFee ?? 0).toFixed(2),
      depositTotal: existing.securityDeposit.total.toFixed(2),
      nights: existing.stay.nights,
      nightlyRate: existing.stay.nightlyRate.toFixed(2),
      gateway: existing.gateway || "paypal",
      gatewayRef: existing.paypal?.orderId || existing.stripe?.sessionId || existingInvoiceId || "",
      idempotent: true
    });
  }

  const { snapshot, purchaseUnits } = composeBooking(payload, tenant);

  // Invoice strategy — additive path, tenant KV overrides env, default is
  // today's behavior. INVOICE_STRATEGY "enrich" targets the draft invoice
  // GHL's rental calendar already auto-created instead of generating a
  // PayPal/Stripe checkout link. Any failure here falls through to the
  // existing PayPal-URL flow below unmodified — nothing lost.
  const invoiceStrategy = tenant.invoiceStrategy ?? env.INVOICE_STRATEGY ?? "paypal_url";
  let approveUrl, gatewayRef, gateway;

  if (invoiceStrategy === "enrich") {
    try {
      const invoiceId = await resolveDraftInvoiceId({
        tenant, env,
        locationId: snapshot.locationId,
        contactId: snapshot.ghlContactId,
        bookingId: snapshot.bookingId,
        hintedInvoiceId: resumeInvoiceId || payload.invoiceId || payload.invoice?.id || null
      });
      // Claim the invoice before touching it. GHL retries a webhook that
      // times out while the first run is still working; the retry then finds
      // this and returns instead of appending the lines and sending twice.
      snapshot.ghlInvoice = { invoiceId, status: "sending", claimedAt: new Date().toISOString() };
      await env.BOOKINGS.put(snapshot.bookingId, JSON.stringify(snapshot));
      const { items, removedItems } = await enrichAndSendInvoice({
        tenant, env,
        locationId: snapshot.locationId,
        invoiceId,
        snapshot,
        contact: {
          id: snapshot.ghlContactId,
          name: snapshot.guest.name,
          email: snapshot.guest.email,
          phoneNo: snapshot.guest.phone
        },
        // {{user.id}} on the webhook, not tenant config -- who is sending
        // this invoice is a per-request fact, not a per-client one.
        userId: payload.userId,
        // Required Yes/No on the booking form; "No" drops GHL's Pet Fee line.
        hasPets: payload.hasPets
      });
      snapshot.ghlInvoice = { invoiceId, status: "sent", appendedItems: items.length, removedItems, sentAt: new Date().toISOString() };
      gateway = "ghl_invoice";
      gatewayRef = invoiceId;
      approveUrl = null; // guest pays via the invoice GHL just sent, not a link we generate
    } catch (err) {
      // No fallback link (retired 2026-09-21). The link was priced from the
      // webhook's stayTotal ({{rentalBooking.amount_due}}), which includes every
      // GHL fee before the pet check -- on a failure it would have charged a
      // $300 Pet Fee after a "No" and booked all of it as rent. GHL's invoice
      // is the only thing a guest is asked to pay. The booking workflow reads
      // mode "enrich_failed" from this response and alerts the manager; the
      // claim is released so a re-fire can try again.
      console.error(`GHL invoice enrich failed for ${snapshot.bookingId}:`, err.message);
      delete snapshot.ghlInvoice;
      snapshot.enrichFailed = { at: new Date().toISOString(), error: err.message };
      await env.BOOKINGS.put(snapshot.bookingId, JSON.stringify(snapshot));
      return json({
        bookingId: snapshot.bookingId,
        mode: "enrich_failed",
        invoiceId: null,
        approveUrl: null,
        error: err.message,
        checkIn: snapshot.stay.checkIn,
        checkOut: snapshot.stay.checkOut,
        guestName: snapshot.guest?.name || "",
        propertyName: snapshot.propertyCode || tenant.brandName || ""
      });
    }
  }

  // PayPal/Stripe link flow -- only for a tenant whose invoiceStrategy is not
  // "enrich". It is no longer a fallback for a failed enrich.
  if (!gateway) {
    gateway = (tenant.gateway || "paypal").toLowerCase();
    if (gateway === "stripe") {
      const { sessionId, checkoutUrl } = await createCheckoutSession(tenant, env, snapshot, env.WORKER_URL);
      snapshot.stripe = { sessionId, checkoutUrl };
      approveUrl = checkoutUrl;
      gatewayRef = sessionId;
    } else {
      const { orderId, approveUrl: ppUrl } = await createOrder(tenant, env, snapshot.bookingId, purchaseUnits, env.WORKER_URL);
      snapshot.paypal = { orderId, approveUrl: ppUrl };
      approveUrl = ppUrl;
      gatewayRef = orderId;
    }
  }
  snapshot.gateway = gateway;

  await env.BOOKINGS.put(snapshot.bookingId, JSON.stringify(snapshot));

  // No GHL/D1 write here -- nothing has been paid yet. The Transaction/Payment
  // records get created in payment.js's settle() (via ledger.js) once the
  // capture actually completes, so an abandoned checkout never shows up as a
  // real transaction.

  // Optional push notification: if the tenant config defines ghlPaymentLinkUrl
  // (a GHL Inbound Webhook trigger URL), POST the payment link + totals there.
  // Fire-and-forget: a failure here must never block the booking response.
  // Skipped in enrich mode — there is no separate link to push, GHL already
  // emailed/texted the invoice itself as part of send-invoice above.
  if (tenant.ghlPaymentLinkUrl && gateway !== "ghl_invoice") {
    try {
      await fetch(tenant.ghlPaymentLinkUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "payment_link_ready",
          bookingId: snapshot.bookingId,
          contactId: snapshot.ghlContactId || "",
          email: snapshot.guest.email || "",
          phone: snapshot.guest.phone || "",
          firstName: (snapshot.guest.name || "").split(" ")[0],
          approveUrl,
          grandTotal: snapshot.charges.grandTotal.toFixed(2),
          rentTotal: snapshot.charges.rentTotal.toFixed(2),
          cleaningFee: snapshot.charges.cleaningFee.toFixed(2),
          processingFee: snapshot.charges.processingFee.toFixed(2),
          depositTotal: snapshot.securityDeposit.total.toFixed(2),
          nights: snapshot.stay.nights,
          checkIn: snapshot.stay.checkIn,
          checkOut: snapshot.stay.checkOut,
          propertyName: snapshot.propertyCode || tenant.brandName
        })
      });
    } catch (err) {
      console.error(`GHL payment-link notify failed for ${snapshot.bookingId}:`, err.message);
    }
  }

  return json({
    bookingId: snapshot.bookingId,
    approveUrl,
    mode: gateway === "ghl_invoice" ? "enrich" : "paypal_url",
    invoiceId: snapshot.ghlInvoice?.invoiceId,
    grandTotal: snapshot.charges.grandTotal.toFixed(2),
    rentTotal: snapshot.charges.rentTotal.toFixed(2),
    cleaningFee: snapshot.charges.cleaningFee.toFixed(2),
    processingFee: snapshot.charges.processingFee.toFixed(2),
    depositTotal: snapshot.securityDeposit.total.toFixed(2),
    nights: snapshot.stay.nights,
    nightlyRate: snapshot.stay.nightlyRate.toFixed(2),
    gateway,
    gatewayRef
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/booking-created")
        return handleBookingCreated(request, env);
      if (request.method === "POST" && url.pathname === "/ghl-invoice-paid")
        return handleGhlInvoicePaid(request, env);
      if (url.pathname === "/paypal/return")
        return handlePayPalReturn(request, env);
      if (request.method === "POST" && url.pathname === "/paypal/webhook")
        return handlePayPalWebhook(request, env);
      if (url.pathname === "/stripe/return")
        return handleStripeReturn(request, env);
      if (request.method === "POST" && url.pathname === "/stripe/webhook")
        return handleStripeWebhook(request, env);
      if (request.method === "POST" && url.pathname === "/reschedule")
        return handleReschedule(request, env);
      if (request.method === "POST" && url.pathname === "/cancel")
        return handleCancel(request, env);
      if (request.method === "POST" && url.pathname === "/deposit/refund")
        return handleDepositRefund(request, env);
      if (url.pathname === "/reports/owner-statement")
        return handleOwnerStatement(request, env);
      if (url.pathname === "/reports/manager-statement")
        return handleManagerStatement(request, env);
      if (url.pathname === "/reports/reconcile")
        return handleReconcile(request, env);
      if (url.pathname === "/admin/provision-tenant" && (request.method === "GET" || request.method === "POST"))
        return handleProvisionTenant(request, env);
      if (url.pathname === "/paypal/cancel" || url.pathname === "/stripe/cancel")
        return json({ status: "cancelled", note: "guest cancelled checkout" });
      return json({ error: "Not found" }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: err.message }, 500);
    }
  }
};
