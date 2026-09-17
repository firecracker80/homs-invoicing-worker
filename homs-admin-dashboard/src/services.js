// Services flow -- a vendor's Service Request, from quote to paid.
//
// The vendor (RL Santana first) owns the job in their own GHL account:
// custom_objects.service_requests, their estimates, their invoices, their
// payment processor. Their workflows call these endpoints at each stage:
//
//   POST /api/services/estimate  { vendorLocationId, serviceRequestId }
//     Build an estimate from the record's quoted price and send it.
//   POST /api/services/invoice   { vendorLocationId, serviceRequestId }
//     Invoice from the accepted estimate, plus one line for any additional
//     services added on site, then send it.
//   POST /api/services/accepted  { vendorLocationId, estimateId | contactId }
//     Estimate accepted: status aceptado, task to the vendor's dispatch user.
//   POST /api/services/declined  { vendorLocationId, estimateId | contactId }
//     Estimate declined: status rechazado, the declined estimate noted, and the
//     estimate link cleared so a corrected quote can be sent later. The client
//     conversation itself belongs in the GHL workflow, not here.
//   POST /api/services/paid      { vendorLocationId, invoiceId | contactId }
//     Invoice paid: status pagado.
//   POST /api/services/sync      { vendorLocationId, serviceRequestId }
//     For requests that came from a HOMS client: create or update the mirror
//     record in the client's own account, and add an Expense on their property
//     once the invoice is paid.
//
// Every stage also runs the client sync itself, so a workflow needs one webhook.
// Service Request-based workflows expose no record ID merge tag (checked in RL
// Santana 2026-09-15), so estimate and invoice also accept { pending: true }:
// process every request waiting at that stage, touched in the last
// vendor.sweepDays (default 14). Each request is still handled at most once.
// A stage can name its record by serviceRequestId, estimateId, invoiceId, or --
// when a trigger exposes none of those -- contactId, which picks that contact's
// newest request in the status the stage expects.
//
// Currency (decided 2026-09-15). A DR client books stays in USD/EUR but pays
// services in DOP, and their DR accountant reconciles both. So the original
// amount and currency are always kept exactly as invoiced. Conversion is the
// client's choice, read from their own custom value "WService Cost Currency":
// anything containing "convert" also stores the amount in the account currency
// (custom value "WCurrency") at the market rate for the day the invoice was paid,
// with the rate, its date and its source. Anything else keeps the original only.
//
// Vendor config is a DASHBOARD_TENANTS entry with kind "service_vendor":
//   { label, kind: "service_vendor", ghlPitSecretName, currency, dispatchUserId,
//     sendAction?, liveMode?, estimateTerms?, estimateValidDays? (default 7) }
//
// No tax is added. Not every client of the vendor wants a fiscal receipt
// (comprobante fiscal), so ITBIS stays off until a per-client rule exists.

import {
  getObjectRecord,
  updateObjectRecord,
  fetchRecordRelations,
  fetchAssociations,
  findAssociationId,
  getContact,
  getLocation,
  createEstimate,
  sendEstimate,
  createInvoiceFromEstimate,
  listContactInvoices,
  createContactTask,
  listEstimates,
  getInvoice,
  updateInvoice,
  sendInvoice,
  fetchAllObjectRecords,
  createObjectRecord,
  createRelation,
  fetchCustomValues,
} from "./ghl.js";
import { getTenant, resolvePit } from "./tenants.js";
import { slugFromFieldKey } from "./blueprint.js";

export const SERVICE_REQUEST_KEY = "custom_objects.service_requests";
const EXPENSE_KEY = "custom_objects.expenses";
const PROPERTY_KEY = "custom_objects.properties";

const DEFAULT_TERMS =
  "Precio fijo por el servicio seleccionado. Si al llegar el técnico encuentra un problema distinto " +
  "o trabajo adicional, se le explicará antes de continuar y se cobrará como costo adicional.";

// Vendor option keys (Spanish account) -> client option keys (English template).
export const STATUS_TO_CLIENT = {
  solicitado: "requested",
  cotizado: "requested",
  aceptado: "requested",
  programado: "scheduled",
  en_proceso: "scheduled",
  completado: "completed",
  facturado: "invoiced",
  pagado: "paid",
  rechazado: "cancelled",
  cancelado: "cancelled",
};

export const CATEGORY_TO_CLIENT = {
  aire_acondicionado: "air_conditioning",
  refrigeracion: "refrigeration",
  electrico: "electrical",
  plomeria: "plumbing",
  construccion_terminaciones: "construction_finishes",
  otro: "other",
};

// --- pure helpers ------------------------------------------------------------

export function prop(record, key) {
  const v = record?.properties?.[key];
  return v === undefined || v === "" ? null : v;
}

export function money(v) {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "object") return Number(v.value) || 0;
  return Number(v) || 0;
}

export function dateOnly(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// DR and US numbers are both NANP (+1). Never invents a code for anything else.
export function toE164(phone) {
  if (!phone) return phone;
  const digits = String(phone).replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

// The estimate's issue date must be "today" where the vendor is, not in UTC:
// GHL rejects a future issue date (live 400 "Issue date cannot be in the
// future" at 20:20 Santo Domingo, already the 16th in UTC).
export function todayInZone(timezone, now = new Date()) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function buildEstimateBody({ vendor, vendorLocationId, location, record, contact, today }) {
  const business = location?.business || {};
  const serviceItem = prop(record, "service_item");
  return {
    altId: vendorLocationId,
    altType: "location",
    // Neutral name: GHL copies it onto the invoice made from this estimate.
    name: `Servicio - ${serviceItem}`,
    title: "COTIZACIÓN",
    currency: vendor.currency,
    liveMode: vendor.liveMode ?? true,
    issueDate: today,
    // Required at runtime despite the schema marking it optional (live 422:
    // "expiryDate must be in YYYY-MM-DD format").
    expiryDate: addDays(today, vendor.estimateValidDays || 7),
    businessDetails: {
      name: business.name || location?.name,
      logoUrl: business.logoUrl || location?.logoUrl,
      phoneNo: toE164(location?.phone),
      website: business.website || location?.website,
      address: {
        addressLine1: business.address || location?.address,
        city: business.city || location?.city,
        state: business.state || location?.state,
        countryCode: business.country || location?.country,
        postalCode: business.postalCode || location?.postalCode,
      },
    },
    contactDetails: {
      id: contact.id,
      name: [contact.firstName, contact.lastName].filter(Boolean).join(" ") || contact.name || contact.phone,
      phoneNo: toE164(contact.phone),
      email: contact.email || "",
    },
    items: [
      {
        name: serviceItem,
        description: prop(record, "job_description") || "",
        currency: vendor.currency,
        amount: money(prop(record, "quoted_amount")),
        qty: 1,
        type: "one_time",
      },
    ],
    discount: { value: 0, type: "percentage" },
    termsNotes: vendor.estimateTerms || DEFAULT_TERMS,
    frequencySettings: { enabled: false, schedule: {} },
    meta: { serviceRequestId: record.id },
  };
}

// Echoes the invoice GHL generated from the estimate and adds one line for work
// added on site. update-invoice needs the full body; dates must be date-only and
// discount must be present (both verified live in homs-invoicing-worker).
export function buildInvoiceUpdateBody({ vendorLocationId, invoice, record, currency }) {
  const extra = money(prop(record, "additional_amount"));
  const items = [...(invoice.invoiceItems || [])];
  // Idempotent: a retry against an invoice that already carries the line must not add it twice.
  if (extra > 0 && !items.some((i) => i.name === "Servicios adicionales")) {
    items.push({
      name: "Servicios adicionales",
      description: prop(record, "additional_services") || "",
      currency,
      amount: extra,
      qty: 1,
    });
  }
  const contact = invoice.contactDetails || {};
  return {
    altId: vendorLocationId,
    altType: "location",
    name: invoice.name,
    title: invoice.title,
    currency: invoice.currency || currency,
    invoiceNumber: invoice.invoiceNumber,
    contactDetails: { ...contact, phoneNo: toE164(contact.phoneNo) },
    invoiceItems: items,
    issueDate: dateOnly(invoice.issueDate) || dateOnly(new Date().toISOString()),
    dueDate: dateOnly(invoice.dueDate) || dateOnly(invoice.issueDate) || dateOnly(new Date().toISOString()),
    discount: invoice.discount || { value: 0, type: "percentage" },
    businessDetails: invoice.businessDetails,
  };
}

// Best-effort: the vendor's job address against the client's property names and
// addresses. No match returns null -- the mirror is created unlinked, never guessed.
export function matchProperty(propertyRecords, jobAddress) {
  const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
  const job = norm(jobAddress);
  if (!job) return null;
  const hits = propertyRecords.filter((p) => {
    const name = norm(p.properties?.property_name);
    const addr = norm(p.properties?.address);
    return (name && (job.includes(name) || name.includes(job))) || (addr && (job.includes(addr) || addr.includes(job)));
  });
  return hits.length === 1 ? hits[0] : null;
}

const CURRENCY_OPTIONS = new Set(["dop", "usd", "eur"]);

// Option key for the client's Currency dropdown, or null for anything outside it.
export function currencyKey(code) {
  const k = String(code || "").trim().toLowerCase();
  return CURRENCY_OPTIONS.has(k) ? k : null;
}

export function readClientCurrencySettings(customValues) {
  const bySlug = {};
  for (const cv of customValues || []) {
    const slug = slugFromFieldKey(cv.fieldKey);
    if (slug) bySlug[slug] = cv.value;
  }
  const accountCurrency = String(bySlug.wcurrency || "").trim().toUpperCase() || null;
  const mode = /convert/i.test(String(bySlug.wservice_cost_currency || "")) ? "convert" : "original";
  return { accountCurrency, mode };
}

export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// Daily market rates, no key: fawazahmed0/currency-api, published per date on
// jsdelivr with a pages.dev mirror. Verified 2026-09-15 for DOP/USD/EUR back to
// January 2026. The Banco Central RD API needs registered credentials, so it
// isn't used; the record names its source so an accountant can check it.
const RATE_SOURCE = "fawazahmed0/currency-api (daily market rate)";
const rateUrls = (date, from) => [
  `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${date}/v1/currencies/${from}.json`,
  `https://${date}.currency-api.pages.dev/v1/currencies/${from}.json`,
];

function shiftDate(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Rate for 1 unit of `from` in `to` on `date`. A day's file may not be
// published yet, so it walks back up to 3 days and reports the date it used.
export async function fetchRate(from, to, date) {
  const f = from.toLowerCase();
  const t = to.toLowerCase();
  for (let back = 0; back <= 3; back++) {
    const day = shiftDate(date, -back);
    for (const url of rateUrls(day, f)) {
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        const j = await res.json();
        const rate = Number(j?.[f]?.[t]);
        if (rate > 0) return { rate, rateDate: day, source: RATE_SOURCE };
      } catch {
        // try the mirror, then the previous day
      }
    }
  }
  return null;
}

// Readable for an accountant, whichever way round the pair is: 1 USD = 59.08 DOP.
export function describeRate(from, to, rate, rateDate) {
  const [big, small, value] = rate >= 1 ? [from, to, rate] : [to, from, 1 / rate];
  return `1 ${big} = ${value.toFixed(4)} ${small} on ${rateDate} (${RATE_SOURCE})`;
}

export function buildClientProperties({ record, vendorLabel, currency, invoiceTotal }) {
  const out = {
    service_item: prop(record, "service_item"),
    vendor: vendorLabel,
    request_status: STATUS_TO_CLIENT[prop(record, "request_status")] || "requested",
    vendor_request_id: record.id,
  };
  const category = CATEGORY_TO_CLIENT[prop(record, "category")];
  if (category) out.category = category;
  const requestedOn = dateOnly(record.createdAt);
  if (requestedOn) out.requested_on = requestedOn;
  const scheduled = dateOnly(prop(record, "scheduled_date"));
  if (scheduled) out.scheduled_date = scheduled;
  const completed = dateOnly(prop(record, "completed_date"));
  if (completed) out.completed_date = completed;
  const description = prop(record, "job_description");
  if (description) out.request_notes = description;
  // Always the original amounts, tagged with their currency. GHL's money fields
  // display in the account's own symbol, so the Currency field is what says RD$.
  const curKey = currencyKey(currency);
  if (curKey) out.currency = curKey;
  const quoted = money(prop(record, "quoted_amount"));
  const extra = money(prop(record, "additional_amount"));
  if (quoted) out.quoted_amount = { value: quoted, currency: "default" };
  if (extra) out.additional_amount = { value: extra, currency: "default" };
  if (invoiceTotal) out.invoice_total = { value: invoiceTotal, currency: "default" };
  return out;
}

// --- config + request plumbing -----------------------------------------------

function fail(message, status = 400, extra = {}) {
  return Response.json({ ok: false, error: message, ...extra }, { status });
}

function errorResponse(err) {
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 502;
  return fail(err.message || "Unknown error", status, err.body ? { ghl: err.body } : {});
}

async function loadVendorContext(request, env, contactStatuses = null) {
  let body;
  try {
    body = await request.json();
  } catch {
    return { error: fail("Expected JSON body") };
  }
  const { vendorLocationId, serviceRequestId, taskId, estimateId, invoiceId, contactId } = body || {};
  const pending = body?.pending === true && !(serviceRequestId || taskId || estimateId || invoiceId || contactId);
  if (!vendorLocationId || !(serviceRequestId || taskId || estimateId || invoiceId || contactId || pending)) {
    return { error: fail("vendorLocationId and one of serviceRequestId, taskId, estimateId, invoiceId, contactId, pending are required") };
  }
  const vendor = await getTenant(env, vendorLocationId);
  if (!vendor || vendor.kind !== "service_vendor") {
    return { error: fail(`${vendorLocationId} is not a configured service vendor`, 404) };
  }
  const pit = resolvePit(env, vendor);
  if (!pit) return { error: fail(`Vendor ${vendorLocationId} has no usable ghlPitSecretName`, 500) };
  if (!vendor.currency) return { error: fail(`Vendor ${vendorLocationId} has no currency configured`, 500) };
  if (pending) return { vendor, vendorLocationId, pit, record: null, body, pending: true };
  const record = await resolveServiceRequest(pit, vendorLocationId, body, contactStatuses);
  if (!record) {
    const by = serviceRequestId ? `id ${serviceRequestId}` : taskId ? `task ${taskId}` : estimateId ? `estimate ${estimateId}` : invoiceId ? `invoice ${invoiceId}` : `contact ${contactId}`;
    return { error: fail(`No service request found for ${by}`, 404) };
  }
  return { vendor, vendorLocationId, pit, record, body };
}

// GHL's estimate/invoice merge tags hand over the NUMBER ("22", "000117"), not
// the id we stored (live 2026-09-15: "No service request found for estimate 22").
// So a value that doesn't match a stored id is looked up as a number, and a
// contactId in the same body is still used as a last resort.
async function resolveByNumber(pit, vendorLocationId, { estimateId, invoiceId }, records) {
  const wanted = String(estimateId || invoiceId).trim();
  if (!wanted) return null;
  const docs = estimateId
    ? await listEstimates(pit, vendorLocationId)
    : await listContactInvoices(pit, vendorLocationId, null).catch(() => []);
  const sameNumber = (n) => String(n ?? "").trim() === wanted || String(Number(n)) === String(Number(wanted));
  const doc = docs.find((d) => sameNumber(d.estimateNumber ?? d.invoiceNumber));
  if (!doc) return null;
  const id = doc._id || doc.id;
  const field = estimateId ? "estimate_id" : "invoice_id";
  return records.find((r) => prop(r, field) === id) || null;
}

// contactStatuses: which statuses a contact-only lookup may pick, newest first.
async function resolveServiceRequest(pit, vendorLocationId, { serviceRequestId, taskId, estimateId, invoiceId, contactId }, contactStatuses) {
  if (serviceRequestId) return getObjectRecord(pit, vendorLocationId, SERVICE_REQUEST_KEY, serviceRequestId);
  // A completed task names exactly one job (its id is stored as task_id), which
  // the contact fallback can't do when a customer has two jobs in progress.
  if (taskId) {
    const all = await fetchAllObjectRecords(pit, vendorLocationId, SERVICE_REQUEST_KEY);
    const byTask = all.find((r) => prop(r, "task_id") === taskId);
    if (byTask || !contactId) return byTask || null;
  }
  if (estimateId || invoiceId) {
    const all = await fetchAllObjectRecords(pit, vendorLocationId, SERVICE_REQUEST_KEY);
    const byId = all.find((r) => (estimateId && prop(r, "estimate_id") === estimateId) || (invoiceId && prop(r, "invoice_id") === invoiceId));
    if (byId) return byId;
    const byNumber = await resolveByNumber(pit, vendorLocationId, { estimateId, invoiceId }, all);
    if (byNumber || !contactId) return byNumber;
  }
  const [associations, relations] = await Promise.all([
    fetchAssociations(pit, vendorLocationId),
    fetchRecordRelations(pit, vendorLocationId, contactId),
  ]);
  const assoc = findAssociationId(associations, SERVICE_REQUEST_KEY, "contact");
  if (!assoc) return null;
  const ids = relations
    .filter((r) => r.associationId === assoc.id)
    .map((r) => (r.firstRecordId === contactId ? r.secondRecordId : r.firstRecordId));
  const records = (await Promise.all(ids.map((id) => getObjectRecord(pit, vendorLocationId, SERVICE_REQUEST_KEY, id).catch(() => null)))).filter(Boolean);
  const eligible = records
    .filter((r) => !contactStatuses || contactStatuses.includes(prop(r, "request_status")))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  return eligible[0] || null;
}

export const isAwaitingEstimate = (r) =>
  prop(r, "request_status") === "solicitado" && !prop(r, "estimate_id") && money(prop(r, "quoted_amount")) > 0;
export const isAwaitingInvoice = (r) =>
  prop(r, "request_status") === "completado" && prop(r, "estimate_id") && !prop(r, "invoice_id");

// GHL fires "Solicitud de Servicio Created" before the new record is searchable
// (live 2026-09-16: the sweep found nothing; the same sweep a minute later found
// it). An empty sweep therefore looks again a couple of times before giving up.
const SWEEP_RETRIES = 2;

async function sweep(env, ctx, isWaiting, one) {
  const days = Number(ctx.vendor.sweepDays) || 14;
  const since = Date.now() - days * 86400000;
  const retryDelay = ctx.vendor.sweepRetryDelayMs ?? 4000;
  let waiting = [];
  let attempts = 0;
  for (;;) {
    attempts++;
    const all = await fetchAllObjectRecords(ctx.pit, ctx.vendorLocationId, SERVICE_REQUEST_KEY);
    waiting = all.filter((r) => {
      const touched = Date.parse(r.updatedAt || r.createdAt || "");
      return isWaiting(r) && (Number.isNaN(touched) || touched >= since);
    });
    if (waiting.length || attempts > SWEEP_RETRIES) break;
    await new Promise((r) => setTimeout(r, retryDelay));
  }
  const results = [];
  for (const record of waiting) {
    const res = await one(env, { ...ctx, record, pending: false });
    results.push({ serviceRequestId: record.id, status: res.status, ...(await res.json()) });
  }
  return Response.json({ ok: results.every((r) => r.ok !== false), pending: true, processed: results.length, attempts, results });
}

async function withSync(env, ctx, stageBody) {
  const fresh = await getObjectRecord(ctx.pit, ctx.vendorLocationId, SERVICE_REQUEST_KEY, ctx.record.id);
  const res = await runSync(env, { ...ctx, record: fresh || ctx.record });
  return Response.json({ ...stageBody, serviceRequestId: ctx.record.id, sync: await res.json() });
}

async function customerContactId(pit, vendorLocationId, recordId) {
  const [associations, relations] = await Promise.all([
    fetchAssociations(pit, vendorLocationId),
    fetchRecordRelations(pit, vendorLocationId, recordId),
  ]);
  const assoc = findAssociationId(associations, SERVICE_REQUEST_KEY, "contact");
  if (!assoc) return null;
  const rel = relations.find((r) => r.associationId === assoc.id);
  if (!rel) return null;
  return rel.firstRecordId === recordId ? rel.secondRecordId : rel.firstRecordId;
}

// --- handlers ----------------------------------------------------------------

export async function handleServiceEstimate(request, env) {
  try {
    const ctx = await loadVendorContext(request, env, ["solicitado"]);
    if (ctx.error) return ctx.error;
    if (ctx.pending) return sweep(env, ctx, isAwaitingEstimate, estimateOne);
    return estimateOne(env, ctx);
  } catch (err) {
    return errorResponse(err);
  }
}

async function estimateOne(env, ctx) {
  try {
    const { vendor, vendorLocationId, pit, record } = ctx;

    const existing = prop(record, "estimate_id");
    if (existing) return Response.json({ ok: true, skipped: "estimate_already_created", estimateId: existing });

    if (!prop(record, "service_item")) return fail("Service request has no service_item");
    if (money(prop(record, "quoted_amount")) <= 0) return fail("Service request has no quoted_amount");
    if (!vendor.dispatchUserId) return fail("Vendor has no dispatchUserId (required to send)", 500);

    const contactId = await customerContactId(pit, vendorLocationId, record.id);
    if (!contactId) return fail("Service request is not linked to a customer contact", 422);
    const [contact, location] = await Promise.all([getContact(pit, contactId), getLocation(pit, vendorLocationId)]);
    if (!contact) return fail(`Contact ${contactId} not found`, 404);

    const body = buildEstimateBody({
      vendor,
      vendorLocationId,
      location,
      record,
      contact,
      today: todayInZone(vendor.timezone || location?.timezone),
    });
    const created = await createEstimate(pit, body);
    const estimateId = created._id || created.id;

    // Record the id before sending: a retry after a failed send must not
    // create a second estimate.
    await updateObjectRecord(pit, vendorLocationId, SERVICE_REQUEST_KEY, record.id, { estimate_id: estimateId });
    await sendEstimate(pit, vendorLocationId, estimateId, {
      userId: vendor.dispatchUserId,
      action: vendor.sendAction || "sms_and_email",
      liveMode: vendor.liveMode ?? true,
    });
    await updateObjectRecord(pit, vendorLocationId, SERVICE_REQUEST_KEY, record.id, { request_status: "cotizado" });

    return withSync(env, ctx, { ok: true, estimateId, total: money(prop(record, "quoted_amount")), currency: vendor.currency });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleServiceInvoice(request, env) {
  try {
    const ctx = await loadVendorContext(request, env, ["aceptado", "programado", "en_proceso", "completado"]);
    if (ctx.error) return ctx.error;
    if (ctx.pending) return sweep(env, ctx, isAwaitingInvoice, invoiceOne);
    return invoiceOne(env, ctx);
  } catch (err) {
    return errorResponse(err);
  }
}

async function invoiceOne(env, ctx) {
  try {
    const { vendor, vendorLocationId, pit, record } = ctx;

    const existing = prop(record, "invoice_id");
    if (existing) return Response.json({ ok: true, skipped: "invoice_already_created", invoiceId: existing });

    const estimateId = prop(record, "estimate_id");
    if (!estimateId) return fail("Service request has no estimate_id -- nothing to invoice from", 422);
    if (!vendor.dispatchUserId) return fail("Vendor has no dispatchUserId (required to send)", 500);

    // An estimate yields at most one invoice. Look for it first, so a retry after
    // a failure between creating and recording it never creates a second one.
    const contactId = await customerContactId(pit, vendorLocationId, record.id);
    if (!contactId) return fail("Service request is not linked to a customer contact", 422);
    const fromEstimate = (list) => list.find((i) => i.sourceId === estimateId && i.status !== "void");
    let invoice = fromEstimate(await listContactInvoices(pit, vendorLocationId, contactId));
    let reusedExisting = Boolean(invoice);
    if (!invoice) {
      const created = await createInvoiceFromEstimate(pit, vendorLocationId, estimateId);
      invoice = created?.invoice?._id ? created.invoice : null;
      if (!invoice) invoice = fromEstimate(await listContactInvoices(pit, vendorLocationId, contactId));
    }
    const invoiceId = invoice?._id || invoice?.id;
    if (!invoiceId) return fail("GHL did not return an invoice for this estimate", 502);
    await updateObjectRecord(pit, vendorLocationId, SERVICE_REQUEST_KEY, record.id, { invoice_id: invoiceId });

    let finalItems = invoice.invoiceItems || [];
    if (money(prop(record, "additional_amount")) > 0) {
      const full = await getInvoice(pit, vendorLocationId, invoiceId);
      const update = buildInvoiceUpdateBody({ vendorLocationId, invoice: full, record, currency: vendor.currency });
      if (update.invoiceItems.length !== (full.invoiceItems || []).length) await updateInvoice(pit, invoiceId, update);
      finalItems = update.invoiceItems;
    }

    await sendInvoice(pit, vendorLocationId, invoiceId, {
      userId: vendor.dispatchUserId,
      action: vendor.sendAction || "sms_and_email",
      liveMode: vendor.liveMode ?? true,
    });
    await updateObjectRecord(pit, vendorLocationId, SERVICE_REQUEST_KEY, record.id, { request_status: "facturado" });

    const total = finalItems.reduce((s, i) => s + money(i.amount) * (Number(i.qty) || 1), 0);
    return withSync(env, ctx, { ok: true, invoiceId, total, currency: vendor.currency, lines: finalItems.length, reusedExisting });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleServiceSync(request, env) {
  try {
    const ctx = await loadVendorContext(request, env);
    if (ctx.error) return ctx.error;
    return runSync(env, ctx);
  } catch (err) {
    return errorResponse(err);
  }
}

// --- accepted / paid stages ----------------------------------------------------

export async function handleServiceAccepted(request, env) {
  try {
    const ctx = await loadVendorContext(request, env, ["cotizado"]);
    if (ctx.error) return ctx.error;
    const { vendor, vendorLocationId, pit, record } = ctx;
    if (!prop(record, "estimate_id")) return fail("Service request has no estimate -- nothing was accepted", 422);
    // A late or repeated acceptance webhook must never pull a job that has moved on back to aceptado.
    const status = prop(record, "request_status");
    if (!["cotizado", "aceptado"].includes(status)) {
      return Response.json({ ok: true, skipped: "not_awaiting_acceptance", status, serviceRequestId: record.id });
    }

    const existingTask = prop(record, "task_id");
    if (existingTask) return withSync(env, ctx, { ok: true, skipped: "task_already_created", taskId: existingTask });
    if (!vendor.dispatchUserId) return fail("Vendor has no dispatchUserId (tasks can only go to a user)", 500);

    const contactId = await customerContactId(pit, vendorLocationId, record.id);
    if (!contactId) return fail("Service request is not linked to a customer contact", 422);

    const title = `Servicio: ${prop(record, "service_item")}`;
    const body = [
      prop(record, "job_address") && `Dirección: ${prop(record, "job_address")}`,
      prop(record, "urgency") && `Urgencia: ${prop(record, "urgency")}`,
      prop(record, "job_description"),
      `Solicitud ${record.id}`,
    ].filter(Boolean).join("\n");
    // Scheduled date if set, else next day; 13:00 UTC is 9:00 in Santo Domingo.
    const day = dateOnly(prop(record, "scheduled_date")) || addDays(dateOnly(new Date().toISOString()), 1);
    const task = await createContactTask(pit, contactId, { title, body, dueDate: `${day}T13:00:00Z`, assignedTo: vendor.dispatchUserId });
    const taskId = task?.id || task?._id;
    await updateObjectRecord(pit, vendorLocationId, SERVICE_REQUEST_KEY, record.id, {
      request_status: "aceptado",
      ...(taskId ? { task_id: taskId } : {}),
    });
    return withSync(env, ctx, { ok: true, taskId, dueDate: day });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleServiceDeclined(request, env) {
  try {
    const ctx = await loadVendorContext(request, env, ["cotizado"]);
    if (ctx.error) return ctx.error;
    const { vendorLocationId, pit, record } = ctx;

    const status = prop(record, "request_status");
    if (!["cotizado", "rechazado"].includes(status)) {
      return Response.json({ ok: true, skipped: "not_awaiting_a_decision", status, serviceRequestId: record.id });
    }
    if (status === "rechazado") {
      return Response.json({ ok: true, skipped: "already_declined", serviceRequestId: record.id });
    }

    const declinedEstimate = prop(record, "estimate_id");
    const note = [prop(record, "job_notes"), "Cotización rechazada por el cliente (" + dateOnly(new Date().toISOString()) + "). Estimate " + (declinedEstimate || "?") + "."]
      .filter(Boolean)
      .join("\n");
    // estimate_id is cleared on purpose: once the price is corrected and the
    // request goes back to Solicitado, the pending sweep can quote it again.
    await updateObjectRecord(pit, vendorLocationId, SERVICE_REQUEST_KEY, record.id, {
      request_status: "rechazado",
      estimate_id: "",
      job_notes: note,
    });
    return withSync(env, ctx, { ok: true, status: "rechazado", declinedEstimate });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleServicePaid(request, env) {
  try {
    const ctx = await loadVendorContext(request, env, ["facturado"]);
    if (ctx.error) return ctx.error;
    const { vendorLocationId, pit, record } = ctx;
    if (!prop(record, "invoice_id")) return fail("Service request has no invoice -- nothing was paid", 422);
    if (prop(record, "request_status") !== "pagado") {
      await updateObjectRecord(pit, vendorLocationId, SERVICE_REQUEST_KEY, record.id, { request_status: "pagado" });
    }
    return withSync(env, ctx, { ok: true, status: "pagado" });
  } catch (err) {
    return errorResponse(err);
  }
}

// The HOMS marketplace link carries the client:
//   ?utm_source=homs-marketplace&utm_campaign=<client locationId>
// GHL keeps those on the new contact's attribution. A request with no
// homs_client yet is tagged from its customer's attribution, but only when the
// source is the marketplace and the campaign is a HOMS client in
// DASHBOARD_TENANTS (never a vendor). Guest links (homs-guest) are not tagged:
// guest requests aren't mirrored.
export const MARKETPLACE_SOURCE = "homs-marketplace";

export function readMarketplaceTag(contact) {
  const found = [];
  for (const a of [contact?.attributionSource, contact?.lastAttributionSource]) {
    if (!a || typeof a !== "object") continue;
    const params = {};
    for (const u of [a.url, a.referrer]) {
      try { if (u) for (const [k, v] of new URL(u).searchParams) params[k.toLowerCase()] = v; } catch { /* not a URL */ }
    }
    const source = a.utmSource ?? a.utm_source ?? params.utm_source;
    const campaign = a.utmCampaign ?? a.utm_campaign ?? a.campaign ?? params.utm_campaign;
    if (String(source || "").trim().toLowerCase() === MARKETPLACE_SOURCE && campaign) found.push(String(campaign).trim());
  }
  return found;
}

async function tagFromAttribution(env, ctx, record) {
  if (prop(record, "homs_client")) return record;
  const contactId = await customerContactId(ctx.pit, ctx.vendorLocationId, record.id);
  if (!contactId) return record;
  const contact = await getContact(ctx.pit, contactId);
  for (const clientLocationId of readMarketplaceTag(contact)) {
    const tenant = await getTenant(env, clientLocationId);
    if (!tenant || tenant.kind === "service_vendor" || tenant.disabled) continue;
    const tag = { request_source: "cliente_homs", homs_client: clientLocationId };
    await updateObjectRecord(ctx.pit, ctx.vendorLocationId, SERVICE_REQUEST_KEY, record.id, tag);
    return { ...record, properties: { ...record.properties, ...tag } };
  }
  return record;
}

async function runSync(env, ctx) {
  try {
    const { vendor, vendorLocationId, pit } = ctx;
    const record = await tagFromAttribution(env, ctx, ctx.record);

    if (prop(record, "request_source") !== "cliente_homs") {
      return Response.json({ ok: true, skipped: "not_a_homs_client_request" });
    }
    const clientLocationId = prop(record, "homs_client");
    if (!clientLocationId) return fail("HOMS client request has no homs_client", 422);
    const client = await getTenant(env, clientLocationId);
    if (!client) return fail(`HOMS client ${clientLocationId} is not in DASHBOARD_TENANTS`, 404);
    const clientPit = resolvePit(env, client);
    if (!clientPit) return fail(`HOMS client ${clientLocationId} has no usable ghlPitSecretName`, 500);

    const vendorCurrency = String(vendor.currency).toUpperCase();
    const settings = readClientCurrencySettings(await fetchCustomValues(clientPit, clientLocationId));
    const accountCurrency = settings.accountCurrency || (client.currency ? String(client.currency).toUpperCase() : null);

    const invoiceId = prop(record, "invoice_id");
    let invoiceTotal = 0;
    let paidOn = null;
    if (invoiceId) {
      const inv = await getInvoice(pit, vendorLocationId, invoiceId);
      invoiceTotal = money(inv.total ?? inv.invoiceTotal);
      paidOn = dateOnly(inv.lastPaidAt);
    }

    const properties = buildClientProperties({ record, vendorLabel: vendor.label, currency: vendorCurrency, invoiceTotal });
    const mirrors = await fetchAllObjectRecords(clientPit, clientLocationId, SERVICE_REQUEST_KEY);
    const mirror = mirrors.find((m) => m.properties?.vendor_request_id === record.id);

    let mirrorId;
    const links = {};
    let propertyRecords = null;
    let matched = null;
    if (mirror) {
      mirrorId = mirror.id;
      await updateObjectRecord(clientPit, clientLocationId, SERVICE_REQUEST_KEY, mirrorId, properties);
    } else {
      const created = await createObjectRecord(clientPit, clientLocationId, SERVICE_REQUEST_KEY, properties);
      mirrorId = created.id;
      propertyRecords = await fetchAllObjectRecords(clientPit, clientLocationId, PROPERTY_KEY);
      matched = matchProperty(propertyRecords, prop(record, "job_address"));
      if (matched) {
        const associations = await fetchAssociations(clientPit, clientLocationId);
        const assoc = findAssociationId(associations, SERVICE_REQUEST_KEY, PROPERTY_KEY);
        if (assoc) {
          const first = assoc.firstObjectKey === SERVICE_REQUEST_KEY ? mirrorId : matched.id;
          const second = assoc.firstObjectKey === SERVICE_REQUEST_KEY ? matched.id : mirrorId;
          await createRelation(clientPit, clientLocationId, assoc.id, first, second);
          links.property = matched.id;
        }
      } else {
        links.property = null;
      }
    }

    // Expense and conversion happen once per paid request, so repeated
    // syncs never duplicate the Expense or re-rate it on a later day.
    let expense = { created: false };
    let conversion = { applied: false, mode: settings.mode };
    // Keyed on the Expense itself, not on a status change: a request whose
    // status bounces (paid -> requested -> paid) must still never get two.
    let existingExpense = null;
    if (properties.request_status === "paid") {
      const expenses = await fetchAllObjectRecords(clientPit, clientLocationId, EXPENSE_KEY);
      existingExpense = expenses.find((e) => e.properties?.line_item_description === `Service request ${record.id}`) || null;
      if (existingExpense) expense = { created: false, reason: "already recorded", id: existingExpense.id };
    }
    if (properties.request_status === "paid" && !existingExpense) {
      const paidDate = paidOn || dateOnly(new Date().toISOString());
      let converted = null;
      if (settings.mode === "convert") {
        if (!accountCurrency) {
          conversion.reason = "client account currency (WCurrency) is not set";
        } else if (accountCurrency === vendorCurrency) {
          conversion.reason = "same currency, nothing to convert";
        } else if (!invoiceTotal) {
          conversion.reason = "no invoice total";
        } else {
          const fx = await fetchRate(vendorCurrency, accountCurrency, paidDate);
          if (!fx) {
            conversion.reason = `no ${vendorCurrency}->${accountCurrency} rate found for ${paidDate}`;
          } else {
            converted = {
              value: round2(invoiceTotal * fx.rate),
              rate: fx.rate,
              rateDate: fx.rateDate,
              source: describeRate(vendorCurrency, accountCurrency, fx.rate, fx.rateDate),
            };
            conversion = { applied: true, mode: settings.mode, from: vendorCurrency, to: accountCurrency, ...converted };
            await updateObjectRecord(clientPit, clientLocationId, SERVICE_REQUEST_KEY, mirrorId, {
              converted_total: { value: converted.value, currency: "default" },
              exchange_rate: converted.rate,
              rate_date: converted.rateDate,
              rate_source: converted.source,
            });
          }
        }
      }

      if (!invoiceTotal) {
        expense = { created: false, reason: "no invoice total" };
      } else {
        const expenseProps = {
          expense_name: `${vendor.label}: ${properties.service_item}`,
          category: "maintenance_repairs",
          amount: { value: invoiceTotal, currency: "default" },
          paid_on: paidDate,
          review_status: "needs_review",
          line_item_description: `Service request ${record.id}`,
        };
        const curKey = currencyKey(vendorCurrency);
        if (curKey) expenseProps.currency = curKey;
        if (converted) {
          expenseProps.converted_amount = { value: converted.value, currency: "default" };
          expenseProps.exchange_rate = converted.rate;
          expenseProps.rate_date = converted.rateDate;
          expenseProps.rate_source = converted.source;
        }
        const exp = await createObjectRecord(clientPit, clientLocationId, EXPENSE_KEY, expenseProps);
        expense = { created: true, id: exp.id, amount: invoiceTotal, currency: vendorCurrency };
        const propertyId = links.property || (await linkedPropertyId(clientPit, clientLocationId, mirrorId));
        if (propertyId) {
          const associations = await fetchAssociations(clientPit, clientLocationId);
          const assoc = findAssociationId(associations, EXPENSE_KEY, PROPERTY_KEY);
          if (assoc) {
            const first = assoc.firstObjectKey === EXPENSE_KEY ? exp.id : propertyId;
            const second = assoc.firstObjectKey === EXPENSE_KEY ? propertyId : exp.id;
            await createRelation(clientPit, clientLocationId, assoc.id, first, second);
            expense.property = propertyId;
          }
        }
      }
    }

    return Response.json({
      ok: true,
      clientLocationId,
      mirrorId,
      action: mirror ? "updated" : "created",
      status: properties.request_status,
      currency: vendorCurrency,
      accountCurrency,
      links,
      expense,
      conversion,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

async function linkedPropertyId(pit, locationId, mirrorId) {
  const [associations, relations] = await Promise.all([
    fetchAssociations(pit, locationId),
    fetchRecordRelations(pit, locationId, mirrorId),
  ]);
  const assoc = findAssociationId(associations, SERVICE_REQUEST_KEY, PROPERTY_KEY);
  if (!assoc) return null;
  const rel = relations.find((r) => r.associationId === assoc.id);
  if (!rel) return null;
  return rel.firstRecordId === mirrorId ? rel.secondRecordId : rel.firstRecordId;
}
