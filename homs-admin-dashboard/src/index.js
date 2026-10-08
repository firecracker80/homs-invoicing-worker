import { fetchAllObjectRecords, fetchContacts, createObjectRecord, fetchAssociations, createRelation, fetchCustomValues,
  ensureReceiptsFolder, uploadReceipt, listReceipts } from "./ghl.js";
// readClientCurrencySettings is already imported with the service handlers below.
import { currencyKey, fetchRate, describeRate, round2 } from "./services.js";
import {
  normalizeProperty,
  normalizeOtaChannel,
  normalizeTransaction,
  normalizeChecklist,
  normalizeExpense,
  normalizeInventoryItem,
  normalizeContact,
  resolveJoins,
} from "./normalize.js";
import { getTenant, resolvePit } from "./tenants.js";
import { requireAdmin, requireProvision, requireServices, handleLogin, handleLogout } from "./auth.js";
import { invoicingFetch } from "./invoicing.js";
import { provision } from "./provision.js";
import { handleVendorData } from "./vendor.js";
import { mapCsvRows, loadExistingExpenses, importRows } from "./expenses-import.js";
import {
  extractFromFile, rowsFromExtraction, expenseFromExtraction, estimateCost,
  resolveModel, resolveProfile, MODELS, MAX_FILE_BYTES, FILE_TYPES,
} from "./receipt-extract.js";
import { parsePortfolio, loadExistingPropertyNames, importProperties } from "./portfolio-import.js";
import { listContactEmails, findWorkbookReply, downloadWorkbook, crossCheck, saveIntake, loadIntake, mergeIntake, fetchLatestSubmission } from "./onboarding-intake.js";
import { getContact } from "./ghl.js";
import { planConfiguration, applyConfiguration } from "./configure-account.js";
import { handleServiceEstimate, handleServiceInvoice, handleServiceSync, handleServiceAccepted, handleServiceDeclined, handleServicePaid, readClientCurrencySettings } from "./services.js";

// Yari's own default accent color -- used whenever a tenant's KV entry has no
// `branding.primary` set. Sampled directly from the HOMS logo's keyhole ("O"),
// locationPhotos/da2d9bc8-ae85-482e-b850-be4010bdd287.png on the HOMS location
// (dytwzgmOP5v0Jh7gop4y) -- dominant pixel color, ~127k/128k sampled pixels.
const DEFAULT_BRANDING = { primary: "#028476" };

async function handleData(pit, locationId) {
  const [propertyRecords, otaRecords, transactionRecords, checklistRecords, expenseRecords, inventoryRecords, contactRecords, customValues] =
    await Promise.all([
      fetchAllObjectRecords(pit, locationId, "custom_objects.properties"),
      fetchAllObjectRecords(pit, locationId, "custom_objects.ota_channels"),
      fetchAllObjectRecords(pit, locationId, "custom_objects.transactions"),
      fetchAllObjectRecords(pit, locationId, "custom_objects.jobs_tmpl"),
      fetchAllObjectRecords(pit, locationId, "custom_objects.expenses"),
      fetchAllObjectRecords(pit, locationId, "custom_objects.property_inventory"),
      fetchContacts(pit, locationId),
      // Only for WCurrency. A read failure must not take the dashboard down.
      fetchCustomValues(pit, locationId).catch(() => []),
    ]);

  const properties = propertyRecords.map(normalizeProperty);
  const otaChannels = otaRecords.map(normalizeOtaChannel);
  const transactions = transactionRecords.map(normalizeTransaction);
  const checklists = checklistRecords.map(normalizeChecklist);
  const expenses = expenseRecords.map(normalizeExpense);
  const inventoryItems = inventoryRecords.map(normalizeInventoryItem);
  const contacts = contactRecords.map(normalizeContact);

  resolveJoins({ properties, otaChannels, transactions, checklists, expenses, inventoryItems, contacts });

  return {
    fetchedAt: new Date().toISOString(),
    locationId,
    // Expenses can carry another currency (DOP service costs in a USD account);
    // the UI only nets amounts that are in this currency or converted into it.
    accountCurrency: readClientCurrencySettings(customValues).accountCurrency,
    properties,
    otaChannels,
    transactions,
    checklists,
    expenses,
    inventoryItems,
    contacts,
  };
}

// Resolves {tenant, pit} for a locationId, or a Response to return early on failure.
async function resolveTenantPit(env, locationId) {
  if (!locationId) {
    return { error: Response.json({ error: "Missing locationId" }, { status: 400 }) };
  }
  const tenant = await getTenant(env, locationId);
  if (!tenant) {
    // "Unknown" reads as "that account does not exist", which sends you looking
    // in GHL, where it plainly does. What is missing is the registry entry --
    // and nothing creates one as a side effect of anything else, so the fix is
    // worth stating rather than knowing.
    return {
      error: Response.json(
        {
          error: `No dashboard registry entry for locationId ${locationId}`,
          fix: "Add a DASHBOARD_TENANTS entry keyed by this locationId holding { label, ghlPitSecretName }, and set that named PIT as a Worker secret. The account existing in GHL is not enough -- every route here resolves its PIT through that entry.",
        },
        { status: 404 }
      ),
    };
  }
  const pit = resolvePit(env, tenant);
  if (!pit) {
    return {
      error: Response.json(
        { error: `Tenant ${locationId} has no ghlPitSecretName configured, or the named secret is missing` },
        { status: 500 }
      ),
    };
  }
  return { tenant, pit };
}

// Links a newly-created record to an existing one via whichever association
// connects the two object keys -- resolved live per request, never hardcoded,
// so this works for any tenant's own association IDs, not just DEMO-HOMS's.
async function linkIfPossible(pit, locationId, associations, objectKeyA, recordIdA, objectKeyB, recordIdB) {
  const assoc = associations.find(
    (a) =>
      (a.firstObjectKey === objectKeyA && a.secondObjectKey === objectKeyB) ||
      (a.firstObjectKey === objectKeyB && a.secondObjectKey === objectKeyA)
  );
  if (!assoc) return { linked: false, reason: `No association between ${objectKeyA} and ${objectKeyB}` };
  const firstRecordId = assoc.firstObjectKey === objectKeyA ? recordIdA : recordIdB;
  const secondRecordId = assoc.firstObjectKey === objectKeyA ? recordIdB : recordIdA;
  await createRelation(pit, locationId, assoc.id, firstRecordId, secondRecordId);
  return { linked: true };
}

// A GHL locationId is an opaque alphanumeric id. Anything else is not one, and
// refusing it keeps whatever it is out of start_url -- the one field here that
// a browser will later navigate to.
const SAFE_LOCATION_ID = /^[A-Za-z0-9_-]{1,64}$/;

function buildManifest(locationId) {
  const scoped = locationId && SAFE_LOCATION_ID.test(locationId);
  return {
    name: "HOMS Admin Dashboard",
    short_name: "HOMS",
    description: "Properties, bookings, cleaning and statements for your account.",
    start_url: scoped ? `/?locationId=${locationId}` : "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: "#f6f7f9",
    theme_color: "#028476",
    icons: [
      // "any", not "maskable". The artwork is a disc with its own margin, not a
      // full-bleed design -- declaring it maskable tells Android it may crop
      // into the outer edge, which on a disc eats the disc. Android puts an
      // "any" icon on its own plate instead, which is what this wants.
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  };
}

// ---- Receipts ---------------------------------------------------------------
// Three routes, and the division between them is the point: reading a receipt
// stores nothing, and storing one reads nothing. Either is useful without the
// other -- a receipt can be read to fill a form that is then corrected by hand,
// and one can be attached to an expense recorded weeks ago.

// Read a receipt into the fields of ONE expense, for prefilling a form. Nothing
// is written anywhere. The property chart of accounts, not the operations one:
// a plumbing invoice has nowhere to go in "platform / infrastructure / telecom".
async function handleReadReceipt(request, env) {
  const body = await request.json();
  const { locationId, filename, mediaType, data } = body;

  const { tenant, error } = await resolveTenantPit(env, locationId);
  if (error) return error;

  if (typeof data !== "string" || !data) {
    return Response.json({ error: "data (base64) is required" }, { status: 400 });
  }
  if (!FILE_TYPES.includes(mediaType)) {
    return Response.json({ error: `Unsupported file type ${mediaType || "(none)"}. Use a JPEG, PNG, WebP or PDF.` }, { status: 400 });
  }
  // Base64 carries 3 bytes per 4 characters; checked before it goes anywhere.
  if (Math.floor((data.length * 3) / 4) > MAX_FILE_BYTES) {
    return Response.json({ error: "That file is too large (5 MB max). Photograph the receipt again at a lower resolution." }, { status: 413 });
  }

  try {
    const model = resolveModel(body.model, resolveModel(tenant.receiptModel));
    const extracted = await extractFromFile(env.ANTHROPIC_API_KEY, { mediaType, data }, {
      model,
      profile: "property",
      ...(env.ANTHROPIC_WORKSPACE_ID ? { workspaceId: env.ANTHROPIC_WORKSPACE_ID } : {}),
    });
    const out = expenseFromExtraction(extracted, { profile: "property" });
    const cost = estimateCost(model, extracted.usage);

    // Not a receipt: 422 with the reason, so the form can say what it was
    // looking at instead of silently filling nothing in.
    if (!out.ok) return Response.json({ ...out, filename, model, cost }, { status: 422 });
    return Response.json({ ...out, filename, model, cost });
  } catch (err) {
    return Response.json({ error: err.message || "Unknown error" },
      { status: err.status && err.status >= 400 && err.status < 600 ? err.status : 502 });
  }
}

// Attach files to an expense that already exists. Separate from creating one so
// the create path keeps its contract, and so a receipt can be added later.
async function handleUploadReceipt(request, env) {
  const body = await request.json();
  const { locationId, recordId, files } = body;

  const { pit, error } = await resolveTenantPit(env, locationId);
  if (error) return error;

  // The record id becomes the filename prefix and therefore the whole join, so
  // it is checked for shape rather than trusted: a name with a separator or a
  // slash in it would split wrong on the way back out.
  if (!recordId || !/^[A-Za-z0-9]{6,64}$/.test(String(recordId))) {
    return Response.json({ error: "recordId is required and must be a GHL record id" }, { status: 400 });
  }
  if (!Array.isArray(files) || files.length === 0) {
    return Response.json({ error: "files is required" }, { status: 400 });
  }
  // The native field's own limit, kept here so both paths behave the same.
  if (files.length > 5) {
    return Response.json({ error: "Five receipts per expense is the limit." }, { status: 400 });
  }
  for (const f of files) {
    if (!FILE_TYPES.includes(f?.mediaType)) {
      return Response.json({ error: `Unsupported file type ${f?.mediaType || "(none)"}. Use a JPEG, PNG, WebP or PDF.` }, { status: 400 });
    }
    if (typeof f.data !== "string" || !f.data) {
      return Response.json({ error: "Every file needs data (base64)" }, { status: 400 });
    }
    if (Math.floor((f.data.length * 3) / 4) > MAX_FILE_BYTES) {
      return Response.json({ error: `${f.filename || "That file"} is too large (5 MB max).` }, { status: 413 });
    }
  }

  try {
    const parentId = await ensureReceiptsFolder(pit, locationId);
    const uploaded = [];
    const failed = [];
    for (const f of files) {
      try {
        uploaded.push(await uploadReceipt(pit, locationId, {
          recordId, filename: f.filename, bytes: base64ToBytes(f.data),
          contentType: f.mediaType, parentId,
        }));
      } catch (err) {
        // One bad file out of five must not lose the other four, and the
        // expense itself is already saved by this point.
        failed.push({ filename: f.filename || null, error: err.message || "upload failed" });
      }
    }
    return Response.json({ uploaded, failed }, { status: failed.length && !uploaded.length ? 502 : 200 });
  } catch (err) {
    return Response.json({ error: err.message || "Unknown error" },
      { status: err.status && err.status >= 400 && err.status < 600 ? err.status : 502 });
  }
}

// Every receipt on the account, keyed by the expense it belongs to.
async function handleListReceipts(request, env) {
  const locationId = new URL(request.url).searchParams.get("locationId");
  const { pit, error } = await resolveTenantPit(env, locationId);
  if (error) return error;
  try {
    const parentId = await ensureReceiptsFolder(pit, locationId);
    return Response.json({ receipts: await listReceipts(pit, locationId, parentId) });
  } catch (err) {
    // An account that has never filed a receipt is not a failure; it has none.
    return Response.json({ receipts: {}, note: err.message || "could not read the media library" });
  }
}

// atob gives one character per byte; Uint8Array.from reads the code units back
// out. Done here rather than in ghl.js so the GHL client keeps taking bytes.
function base64ToBytes(b64) {
  const bin = atob(String(b64).includes(",") ? String(b64).split(",").pop() : b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function handleCreateExpense(request, env) {
  const body = await request.json();
  const { locationId, propertyId, ownerContactId, name, paidOn, categoryKey, lineItemDescription, amount, paidBy, currency } = body;

  const { tenant, pit, error } = await resolveTenantPit(env, locationId);
  if (error) return error;

  if (!name || !categoryKey || amount === undefined || amount === null || amount === "") {
    return Response.json({ error: "name, categoryKey, and amount are required" }, { status: 400 });
  }

  // Required, with no default. An expense that does not say whose cost it is
  // counts against nobody and arrives on the statement flagged -- and this is
  // the one path where a person is already looking at a form, so it is the
  // cheapest possible moment to ask. Defaulting it would mean a rushed entry
  // silently charging an owner.
  const whose = String(paidBy || "").toLowerCase();
  if (whose !== "owner" && whose !== "manager") {
    return Response.json(
      { error: "paidBy is required and must be \"owner\" or \"manager\"" }, { status: 400 });
  }

  const properties = {
    expense_name: name,
    category: categoryKey,
    amount: { value: Number(amount), currency: "default" },
    review_status: "needs_review",
    paid_by: whose,
  };
  if (paidOn) properties.paid_on = paidOn;
  if (lineItemDescription) properties.line_item_description = lineItemDescription;

  // The currency, and the conversion that has to come with it.
  //
  // Nothing wrote this field before, so every expense entered here landed
  // untagged -- and an untagged amount is read as the ACCOUNT's currency by
  // both the dashboard and manager-pl.js. A 16,246.63 peso bar tab recorded on
  // a USD account was therefore counted as $16,246.63, about 59 times its real
  // cost. Yari hit exactly that on 2026-10-08.
  //
  // Converted here rather than left for a workflow, because manager-pl.js
  // refuses a foreign record that carries no rate (correctly -- adding pesos to
  // dollars produces a number nobody can tell is wrong) and would silently drop
  // the expense from the statement instead.
  //
  // Same helpers as services.js, which already does this for vendor invoices,
  // so a hand-entered expense and a service-generated one carry identical
  // conversion fields.
  const currencyOpt = currencyKey(currency);
  const conversion = { applied: false };
  if (currencyOpt) {
    properties.currency = currencyOpt;

    const settings = readClientCurrencySettings(await fetchCustomValues(pit, locationId).catch(() => []));
    const accountCurrency = settings.accountCurrency || String(tenant.currency || "").toUpperCase() || null;
    const from = currencyOpt.toUpperCase();

    if (accountCurrency && from !== accountCurrency) {
      // The rate for the day the money moved, not today's -- an expense from
      // March must not be revalued every time a statement is run.
      const on = paidOn || new Date().toISOString().slice(0, 10);
      const fx = await fetchRate(from, accountCurrency, on).catch(() => null);
      if (fx) {
        properties.converted_amount = { value: round2(Number(amount) * fx.rate), currency: "default" };
        properties.exchange_rate = fx.rate;
        properties.rate_date = fx.rateDate;
        properties.rate_source = describeRate(from, accountCurrency, fx.rate, fx.rateDate);
        Object.assign(conversion, { applied: true, from, to: accountCurrency, rate: fx.rate, rateDate: fx.rateDate });
      } else {
        // Recorded in its own currency with no rate. The expense is still
        // saved -- losing it would be worse -- but it will show on a statement
        // as unconverted rather than being netted, so the caller is told.
        conversion.reason = `no ${from}->${accountCurrency} rate found for ${on}`;
      }
    }
  }

  try {
    const record = await createObjectRecord(pit, locationId, "custom_objects.expenses", properties);
    const newId = record.id;

    const associations = await fetchAssociations(pit, locationId);
    const links = {};
    if (propertyId) {
      links.property = await linkIfPossible(pit, locationId, associations, "custom_objects.expenses", newId, "custom_objects.properties", propertyId);
    }
    if (ownerContactId) {
      links.owner = await linkIfPossible(pit, locationId, associations, "custom_objects.expenses", newId, "contact", ownerContactId);
    }

    return Response.json({ success: true, id: newId, links, conversion });
  } catch (err) {
    return Response.json(
      { error: err.message || "Unknown error" },
      { status: err.status && err.status >= 400 && err.status < 600 ? err.status : 502 }
    );
  }
}

// A vendor book (HOMS, DTCS) keeps its own expense shape -- vendor, currency,
// recurrence, source, receipt -- and no client dimension at all. Writing a
// client-shaped expense into it, or a vendor-shaped one into a client account,
// would corrupt the P&L silently, so both import routes refuse anything else.
async function resolveVendorBook(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return { error: Response.json({ error: "Invalid JSON body" }, { status: 400 }) };
  }
  const { tenant, pit, error } = await resolveTenantPit(env, body.locationId);
  if (error) return { error };
  if (tenant.kind !== "vendor") {
    return { error: Response.json({ error: "Not a vendor book -- expense import is for HOMS/DTCS only" }, { status: 400 }) };
  }
  return { body, tenant, pit, locationId: body.locationId };
}

// Parse writes nothing. It returns draft rows for review, with every problem the
// parser could see already attached to the row that has it.
async function handleExpenseParse(request, env) {
  const { body, tenant, pit, locationId, error } = await resolveVendorBook(request, env);
  if (error) return error;

  if (typeof body.csv !== "string" || !body.csv.trim()) {
    return Response.json({ error: "csv (text) is required" }, { status: 400 });
  }
  try {
    const existing = await loadExistingExpenses(pit, locationId);
    const result = mapCsvRows(body.csv, { existing, defaultCurrency: tenant.currency || "USD" });
    if (result.error) return Response.json(result, { status: 400 });
    return Response.json(result);
  } catch (err) {
    return Response.json(
      { error: err.message || "Unknown error" },
      { status: err.status && err.status >= 400 && err.status < 600 ? err.status : 502 }
    );
  }
}

// Same contract as /parse, for a receipt photo or a PDF: draft rows out, nothing
// written. The reading is done by Claude; everything after it -- the review, the
// duplicate check, the hold-back rules, the import -- is the CSV path exactly.
async function handleReceiptParse(request, env) {
  const { body, tenant, pit, locationId, error } = await resolveVendorBook(request, env);
  if (error) return error;

  const { filename, mediaType, data } = body;
  if (typeof data !== "string" || !data) {
    return Response.json({ error: "data (base64) is required" }, { status: 400 });
  }
  // Base64 carries 3 bytes per 4 characters; check before sending it anywhere.
  if (Math.floor((data.length * 3) / 4) > MAX_FILE_BYTES) {
    return Response.json({ error: "That file is too large (5 MB max). Photograph the receipt again at a lower resolution." }, { status: 413 });
  }

  try {
    // The reader can be switched per request so the same receipt can be compared
    // across models; the tenant's own setting is the default, and anything the
    // browser sends that is not on the allowlist falls back rather than reaching
    // the API.
    const model = resolveModel(body.model, resolveModel(tenant.receiptModel));
    const [extracted, existing] = await Promise.all([
      extractFromFile(env.ANTHROPIC_API_KEY, { mediaType, data }, {
        model,
        ...(env.ANTHROPIC_WORKSPACE_ID ? { workspaceId: env.ANTHROPIC_WORKSPACE_ID } : {}),
      }),
      loadExistingExpenses(pit, locationId),
    ]);
    const out = rowsFromExtraction(extracted, { filename, existing, defaultCurrency: tenant.currency || "USD" });
    // What the read cost, so spend is visible as it happens rather than
    // reconciled out of the Console later.
    const cost = estimateCost(model, extracted.usage);
    // Not a receipt at all: a 422 with the reason, so the dashboard can say what
    // it was looking at instead of showing an empty table.
    if (out.error) return Response.json({ ...out, model, cost }, { status: 422 });
    return Response.json({ ...out, source: "receipt_upload", model, cost });
  } catch (err) {
    return Response.json(
      { error: err.message || "Unknown error" },
      { status: err.status && err.status >= 400 && err.status < 600 ? err.status : 502 }
    );
  }
}

// Import writes exactly the rows it is handed -- never what parse produced, which
// the reviewer may have edited or unticked in between.
async function handleExpenseImport(request, env) {
  const { body, pit, locationId, error } = await resolveVendorBook(request, env);
  if (error) return error;

  const rows = body.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    return Response.json({ error: "rows (array) is required" }, { status: 400 });
  }
  if (rows.length > 300) {
    return Response.json({ error: "Too many rows in one import (max 300)" }, { status: 400 });
  }
  const source = body.source === "receipt_upload" || body.source === "manual" ? body.source : "csv_import";

  try {
    const { created, failed } = await importRows(pit, locationId, rows, { source });
    return Response.json({ ok: failed.length === 0, imported: created.length, created, failed });
  } catch (err) {
    return Response.json(
      { error: err.message || "Unknown error" },
      { status: err.status && err.status >= 400 && err.status < 600 ? err.status : 502 }
    );
  }
}

// The portfolio intake is the mirror of the expense import: properties live in a
// CLIENT account, never in a vendor book, so the guard runs the other way.
const PORTFOLIO_MAX_BYTES = 10 * 1024 * 1024;

async function resolveClientAccount(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return { error: Response.json({ error: "Invalid JSON body" }, { status: 400 }) };
  }
  const { tenant, pit, error } = await resolveTenantPit(env, body.locationId);
  if (error) return { error };
  if (tenant.kind === "vendor") {
    return { error: Response.json({ error: "Not a client account -- the portfolio intake creates properties, which a vendor book has none of" }, { status: 400 }) };
  }
  return { body, tenant, pit, locationId: body.locationId };
}

function decodeBase64(data) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// Reads the client's intake workbook and returns draft rows. Writes nothing.
async function handlePortfolioParse(request, env) {
  const { body, pit, locationId, error } = await resolveClientAccount(request, env);
  if (error) return error;

  if (typeof body.data !== "string" || !body.data) {
    return Response.json({ error: "data (base64 .xlsx) is required" }, { status: 400 });
  }
  if (Math.floor((body.data.length * 3) / 4) > PORTFOLIO_MAX_BYTES) {
    return Response.json({ error: "That workbook is too large (10 MB max)" }, { status: 413 });
  }

  try {
    const [existingNames, buffer] = await Promise.all([
      loadExistingPropertyNames(pit, locationId),
      Promise.resolve(decodeBase64(body.data)),
    ]);
    const out = await parsePortfolio(buffer, { existingNames });
    if (out.error) return Response.json(out, { status: 400 });
    return Response.json(out);
  } catch (err) {
    return Response.json(
      { error: err.message || "Unknown error" },
      { status: err.status && err.status >= 400 && err.status < 600 ? err.status : 502 }
    );
  }
}

// Creates the Property records for the rows the reviewer ticked. The rental
// listings themselves stay manual -- GHL's calendar API has no rental type.
async function handlePortfolioImport(request, env) {
  const { body, pit, locationId, error } = await resolveClientAccount(request, env);
  if (error) return error;

  const rows = body.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    return Response.json({ error: "rows (array) is required" }, { status: 400 });
  }
  if (rows.length > 500) {
    return Response.json({ error: "Too many rows in one import (max 500)" }, { status: 400 });
  }

  try {
    const { created, failed } = await importProperties(pit, locationId, rows);
    return Response.json({ ok: failed.length === 0, imported: created.length, created, failed });
  } catch (err) {
    return Response.json(
      { error: err.message || "Unknown error" },
      { status: err.status && err.status >= 400 && err.status < 600 ? err.status : 502 }
    );
  }
}


// ===================================================== onboarding intake ====
// Stage 1: the client replies to the workbook email with it filled in. This
// collects that reply and parks it for review. It reads the HOMS account and
// writes only to the intake record -- never to a client sub-account, which at
// this point usually does not exist yet.
//
// Triggered by a GHL "Customer Replied" workflow on HOMS, so the caller is a
// webhook, not the dashboard UI: it authenticates with PROVISION_KEY.
async function handleOnboardingIntake(request, env) {
  const denied = await requireProvision(request, env);
  if (denied) return denied;

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const contactId = body.contactId;
  if (!contactId) return Response.json({ error: "contactId is required" }, { status: 400 });

  // locationId here is the account the CONVERSATION lives in (HOMS), not the
  // client sub-account. Guarding it as a client account would be wrong.
  const { pit, error } = await resolveTenantPit(env, body.locationId);
  if (error) return error;

  const existing = await loadIntake(env.DASHBOARD_TENANTS, contactId);

  try {
    const messages = await listContactEmails(pit, contactId);
    const reply = findWorkbookReply(messages);

    if (!reply.found) {
      const record = {
        contactId, locationId: body.locationId, status: "waiting",
        reason: reply.reason, checkedAt: new Date().toISOString(),
      };
      await saveIntake(env.DASHBOARD_TENANTS, contactId, mergeIntake(existing, record));
      return Response.json(mergeIntake(existing, record), { status: 202 });
    }

    const buffer = await downloadWorkbook(reply.found.url, pit);
    // No existing-name list: there is no client account to compare against yet,
    // so "already in this account" cannot be judged here and is not pretended.
    const portfolio = await parsePortfolio(buffer, { existingNames: [] });
    if (portfolio.error) {
      const record = {
        contactId, locationId: body.locationId, status: "unreadable",
        reply: reply.found, error: portfolio.error, sheets: portfolio.sheets || [],
        checkedAt: new Date().toISOString(),
      };
      await saveIntake(env.DASHBOARD_TENANTS, contactId, mergeIntake(existing, record));
      return Response.json(mergeIntake(existing, record), { status: 422 });
    }

    // The quiz arrives FIRST and is already on the record. A body.quiz is still
    // honoured so a caller can supply one, but it never has to.
    const quiz = (body.quiz && typeof body.quiz === "object" ? body.quiz : null) || existing?.quiz || null;
    const record = {
      contactId, locationId: body.locationId, status: "ready_for_review",
      reply: reply.found, superseded: reply.superseded,
      quiz, crossCheck: crossCheck(quiz, portfolio),
      portfolio, checkedAt: new Date().toISOString(),
    };
    const saved = mergeIntake(existing, record);
    await saveIntake(env.DASHBOARD_TENANTS, contactId, saved);

    // The full portfolio is large and already stored; the webhook caller only
    // needs to know it landed and whether a human has to look.
    return Response.json({
      contactId, status: record.status, reply: reply.found,
      summary: portfolio.summary, conflicts: record.crossCheck.conflicts,
      supersededCount: reply.superseded.length,
    });
  } catch (err) {
    return Response.json(
      { error: err.message || "Unknown error" },
      { status: err.status && err.status >= 400 && err.status < 600 ? err.status : 502 }
    );
  }
}

// Called by a GHL workflow when the onboarding survey is submitted. This is the
// FIRST step of onboarding -- the workbook comes back days later and merges
// into whatever this leaves behind.
//
// It takes only contactId and reads the submission back from GHL itself. The
// alternative, mapping twenty answers into a Custom Webhook body by hand, is
// the exact failure mode that has cost days here: a merge tag that silently
// resolves to nothing looks identical to a field the client left blank.
async function handleOnboardingQuiz(request, env) {
  const denied = await requireProvision(request, env);
  if (denied) return denied;

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const contactId = body.contactId;
  if (!contactId) return Response.json({ error: "contactId is required" }, { status: 400 });

  const surveyId = body.surveyId || env.ONBOARDING_SURVEY_ID;
  if (!surveyId) {
    return Response.json(
      { error: "surveyId is required (pass it, or set ONBOARDING_SURVEY_ID)" },
      { status: 400 }
    );
  }

  // locationId is the account the SURVEY lives in (HOMS), not the client's
  // sub-account -- which does not exist yet at this point in onboarding.
  const { pit, error } = await resolveTenantPit(env, body.locationId);
  if (error) return error;

  try {
    const submission = await fetchLatestSubmission(pit, body.locationId, surveyId, contactId);
    if (!submission) {
      return Response.json(
        { error: `No submission on survey ${surveyId} for contact ${contactId}` },
        { status: 404 }
      );
    }

    // The account holder's own name is not in the survey -- it only asks about
    // the other party -- so it comes off the contact. Failing to read it is not
    // fatal: the quiz map leaves the holder's name unset and says so, which is
    // better than losing the whole submission over a contact fetch.
    let quizContact = null;
    try {
      quizContact = await getContact(pit, contactId);
    } catch (err) {
      console.error(`Could not read contact ${contactId} for the quiz:`, err.message);
    }

    const existing = await loadIntake(env.DASHBOARD_TENANTS, contactId);
    const record = mergeIntake(existing, {
      contactId,
      locationId: body.locationId,
      status: existing?.portfolio ? existing.status : "awaiting_workbook",
      quiz: submission,
      quizContact: quizContact ? { firstName: quizContact.firstName, lastName: quizContact.lastName, name: quizContact.name } : null,
      quizAt: new Date().toISOString(),
      quizSubmissionId: submission.id ?? null,
    });
    await saveIntake(env.DASHBOARD_TENANTS, contactId, record);

    // The answers themselves are not echoed -- a survey carries names, emails
    // and phone numbers, and this response lands in a GHL execution log.
    return Response.json({
      contactId,
      status: record.status,
      quizSubmissionId: record.quizSubmissionId,
      quizAt: record.quizAt,
      answersCaptured: Object.keys(submission.others || {}).length,
      hasWorkbook: Boolean(existing?.portfolio),
    });
  } catch (err) {
    return Response.json(
      { error: err.message || "Unknown error" },
      { status: err.status && err.status >= 400 && err.status < 600 ? err.status : 502 }
    );
  }
}

// The parked intake, for the review screen. Dashboard cookie, not PROVISION_KEY.
async function handleOnboardingGet(request, env, contactId) {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;
  const record = await loadIntake(env.DASHBOARD_TENANTS, contactId);
  if (!record) return Response.json({ error: `No intake recorded for contact ${contactId}` }, { status: 404 });
  return Response.json(record);
}


// ================================================= client configuration ====
// Configures a CLIENT sub-account from its reviewed intake. Two calls, always:
// plan writes nothing, apply writes only what a plan would have contained.
//
// Gated by PROVISION_KEY, not the dashboard cookie, for the same reason
// /api/provision is: this rewrites a client account's configuration, and a
// browser session must not be able to drive it.
async function handleConfigure(request, env, { apply }) {
  const denied = await requireProvision(request, env);
  if (denied) return denied;

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.contactId) return Response.json({ error: "contactId is required" }, { status: 400 });

  const { tenant, pit, error } = await resolveTenantPit(env, body.locationId);
  if (error) return error;
  if (tenant.kind === "vendor") {
    return Response.json({ error: "Not a client account -- a vendor book has no properties to configure" }, { status: 400 });
  }

  const intake = await loadIntake(env.DASHBOARD_TENANTS, body.contactId);
  if (!intake) return Response.json({ error: `No intake recorded for contact ${body.contactId}` }, { status: 404 });

  const opts = {
    brandName: body.brandName ?? null,
    // Ride along with the PIT handoff: send-invoice needs a userId and a rental
    // booking has no user in context for {{user.id}} to resolve.
    invoiceSenderUserId: body.invoiceSenderUserId ?? null,
    paypalSecretName: body.paypalSecretName ?? null,
    extra: body.extra && typeof body.extra === "object" ? body.extra : {},
    overwrite: Boolean(body.overwrite),
    rows: Array.isArray(body.rows) ? body.rows : null,
  };

  try {
    if (!apply) return Response.json(await planConfiguration(pit, body.locationId, intake, opts));
    const result = await applyConfiguration(pit, body.locationId, intake, opts, env);
    // The intake is spent once it has been applied, so a second apply cannot
    // quietly run again against another account.
    await saveIntake(env.DASHBOARD_TENANTS, body.contactId, {
      ...intake, status: "configured",
      configuredInto: body.locationId, configuredAt: result.appliedAt,
    });
    return Response.json(result);
  } catch (err) {
    return Response.json(
      { error: err.message || "Unknown error", blockers: err.blockers || undefined },
      { status: err.status && err.status >= 400 && err.status < 600 ? err.status : 502 }
    );
  }
}

// Reconciles a tenant's custom values against the blueprint. Requires PROVISION_KEY,
// never the dashboard cookie -- this endpoint rewrites configuration and mints secrets.
async function handleProvision(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected JSON body" }, { status: 400 });
  }
  const { locationId, input = {}, dryRun = false, overwrite = false, expectBrand = null } = body;

  const { pit, error } = await resolveTenantPit(env, locationId);
  if (error) return error;

  try {
    const result = await provision(pit, locationId, {
      input,
      dryRun: Boolean(dryRun),
      overwrite: Boolean(overwrite),
      expectBrand,
    });
    return Response.json(result);
  } catch (err) {
    return Response.json(
      { error: err.message || "Provisioning failed", status: err.status || 500 },
      { status: err.status && err.status >= 400 && err.status < 600 ? err.status : 502 }
    );
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Public: liveness only. Reveals nothing about any tenant.
    if (url.pathname === "/api/health") {
      return Response.json({ ok: true });
    }

    // The manifest is generated rather than served from public/, because
    // start_url has to name the account.
    //
    // A static start_url opens the installed app with no locationId, and the
    // fallback that would save it -- the id kept in localStorage from the first
    // visit -- is exactly what an installed app on iOS may not share with the
    // browser it was installed from. The reader would tap their own icon and be
    // told no location was specified.
    //
    // Public on purpose: a manifest is fetched by the browser before anyone has
    // logged in, and it reveals nothing that the link they were sent does not.
    if (url.pathname === "/manifest.webmanifest") {
      return Response.json(buildManifest(url.searchParams.get("locationId")), {
        headers: {
          "Content-Type": "application/manifest+json; charset=utf-8",
          "Cache-Control": "public, max-age=300",
        },
      });
    }

    if (url.pathname === "/api/login" && request.method === "POST") {
      return handleLogin(request, env);
    }

    if (url.pathname === "/api/logout" && request.method === "POST") {
      return handleLogout();
    }

    // Provisioning is gated separately and more strictly than everything else.
    if (url.pathname === "/api/provision" && request.method === "POST") {
      const denied = await requireProvision(request, env);
      if (denied) return denied;
      return handleProvision(request, env);
    }

    // Called by a "Customer Replied" workflow on HOMS when the client emails the
    // filled-in workbook back. Gated by PROVISION_KEY inside the handler, and
    // placed above the dashboard gate below because a webhook has no cookie.
    // Step one of onboarding: the survey is submitted before the workbook comes
    // back, so this usually creates the record the workbook later merges into.
    if (url.pathname === "/api/onboarding/quiz" && request.method === "POST") {
      return handleOnboardingQuiz(request, env);
    }

    if (url.pathname === "/api/onboarding/intake" && request.method === "POST") {
      return handleOnboardingIntake(request, env);
    }

    // Both gated by PROVISION_KEY inside the handler, and placed above the
    // dashboard gate below for the same reason as the intake webhook.
    if (url.pathname === "/api/onboarding/configure/plan" && request.method === "POST") {
      return handleConfigure(request, env, { apply: false });
    }

    if (url.pathname === "/api/onboarding/configure/apply" && request.method === "POST") {
      return handleConfigure(request, env, { apply: true });
    }

    // Services flow: called by a vendor's GHL workflows, gated by SERVICES_WEBHOOK_KEY.
    const serviceRoutes = {
      "/api/services/estimate": handleServiceEstimate,
      "/api/services/accepted": handleServiceAccepted,
      "/api/services/declined": handleServiceDeclined,
      "/api/services/invoice": handleServiceInvoice,
      "/api/services/paid": handleServicePaid,
      "/api/services/sync": handleServiceSync,
    };
    if (serviceRoutes[url.pathname] && request.method === "POST") {
      const denied = await requireServices(request, env);
      if (denied) return denied;
      return serviceRoutes[url.pathname](request, env);
    }

    // Every remaining /api/* route requires dashboard auth. Default-deny: a new
    // route added below this line is protected unless it is deliberately moved above.
    if (url.pathname.startsWith("/api/")) {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
    }

    // The manager statement comes from the invoicing Worker, not from here.
    //
    // It cannot be computed from this Worker's data: the transactions object
    // carries booking_total, platform_fee and net_payout and nothing else --
    // no cleaning fee, no commission split. The manager's own economics exist
    // only in the Worker's ledger (Yari, 2026-10-01, scoping the panel). So
    // this proxies rather than recomputes, and there is one definition of the
    // manager's money instead of two that drift.
    //
    // Authenticated with the admin secret the dashboard already holds for
    // provisioning, so no per-tenant report token has to be copied into this
    // Worker's KV and kept in step.
    // Already behind the default-deny gate above; a second requireAdmin here
    // would imply that gate is not trusted, which is worse than terse.
    if (url.pathname === "/api/manager-pl") {
      const locationId = url.searchParams.get("locationId");
      if (!locationId) return Response.json({ error: "locationId is required" }, { status: 400 });
      const query = { locationId, format: "json" };
      // An allow-list, and every name the page can send has to be in it. It
      // dropped `period` silently once (2026-10-05): the page asked for all
      // time, the Worker understood all time, and this route in between threw
      // the word away, so the panel kept showing 30 days under an All time
      // label. Nothing failed -- a dropped param just reverts to a default.
      // test-manager-statement.mjs now reads the page's own code and fails if
      // it sends a name missing from this list.
      for (const k of ["from", "to", "period", "recipientName", "currency", "lang"]) {
        const v = url.searchParams.get(k);
        if (v) query[k] = v;
      }

      try {
        const res = await invoicingFetch(env, "/reports/manager-pl", { query });
        const text = await res.text();

        // Never pass an upstream 401 through as a 401. apiFetch() in the page
        // treats ANY 401 as "this person's session expired" and opens the admin
        // key prompt -- so the reader is asked to re-enter a key that cannot
        // help, and told they are unauthorized when their session is fine. What
        // actually failed is this Worker's own credential against the invoicing
        // Worker, which is a configuration problem and nothing the reader holds.
        if (res.status === 401 || res.status === 403) {
          return Response.json({
            error: "The invoicing Worker rejected this dashboard's credential",
            detail: "Your session is fine -- this is not your login. INVOICING_ADMIN_SECRET on the dashboard must match the invoicing Worker's ADMIN_SECRET, or that tenant's own adminSecret.",
          }, { status: 502 });
        }
        // Pass the Worker's own status and body through. A 404 for an unknown
        // locationId or a 500 for a missing PIT says more than anything this
        // route could invent on its behalf.
        return new Response(text, {
          status: res.status,
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        // A configuration gap is the dashboard's fault and fixable; an
        // unreachable Worker is not. They are different problems and get
        // different statuses.
        const misconfigured = err.reason === "no_admin_secret" || err.reason === "no_invoicing_worker_url";
        return Response.json({
          error: misconfigured ? "Manager statement unavailable" : "Could not reach the invoicing Worker",
          detail: err.message || String(err),
        }, { status: misconfigured ? 503 : 502 });
      }
    }

    if (url.pathname === "/api/data") {
      const locationId = url.searchParams.get("locationId");
      const { tenant, pit, error } = await resolveTenantPit(env, locationId);
      if (error) return error;
      try {
        // A vendor tenant (HOMS itself) is a different data shape, not a variant
        // of a client account -- its own P&L, no properties or bookings. Branch on
        // the tenant record rather than sniffing the account.
        const data = tenant.kind === "vendor"
          ? await handleVendorData(pit, locationId)
          : await handleData(pit, locationId);
        data.tenantLabel = tenant.label || locationId;
        // OTA Channels are hidden unless a client has asked for them (Yari,
        // 2026-09-29). The object and its records stay exactly where they are
        // -- each listing holds the iCal links for the platforms it is on, and
        // deleting that would cost real configuration -- but nothing about it
        // is shown. Turning it back on for one account is one field in KV.
        //
        // Off by default rather than on, because nobody has asked. An account
        // that had it visible yesterday loses a tab it was not using; an
        // account that wants it gets it back without a deploy.
        data.showOtaChannels = tenant.showOtaChannels === true;
        // Same field the statement reads, so one account setting cannot give a
        // Spanish statement and an English dashboard.
        data.statementLocale = tenant.statementLocale || tenant.locale || tenant.language || null;
        data.branding = tenant.branding?.primary ? tenant.branding : DEFAULT_BRANDING;
        return Response.json(data);
      } catch (err) {
        return Response.json(
          { error: err.message || "Unknown error", status: err.status || 500 },
          { status: err.status && err.status >= 400 && err.status < 600 ? err.status : 502 }
        );
      }
    }

    if (url.pathname === "/api/expenses" && request.method === "POST") {
      return handleCreateExpense(request, env);
    }

    if (url.pathname === "/api/expenses/parse" && request.method === "POST") {
      return handleExpenseParse(request, env);
    }

    if (url.pathname === "/api/expenses/models" && request.method === "GET") {
      return Response.json({ models: Object.entries(MODELS).map(([id, m]) => ({ id, label: m.label })) });
    }

    if (url.pathname === "/api/portfolio/parse" && request.method === "POST") {
      return handlePortfolioParse(request, env);
    }

    if (url.pathname === "/api/portfolio/import" && request.method === "POST") {
      return handlePortfolioImport(request, env);
    }

    if (url.pathname.startsWith("/api/onboarding/") && request.method === "GET") {
      const contactId = url.pathname.slice("/api/onboarding/".length);
      if (contactId && !contactId.includes("/")) {
        return handleOnboardingGet(request, env, decodeURIComponent(contactId));
      }
    }

    if (url.pathname === "/api/expenses/parse-file" && request.method === "POST") {
      return handleReceiptParse(request, env);
    }

    if (url.pathname === "/api/expenses/read-receipt" && request.method === "POST") {
      return handleReadReceipt(request, env);
    }

    if (url.pathname === "/api/expenses/receipt" && request.method === "POST") {
      return handleUploadReceipt(request, env);
    }

    if (url.pathname === "/api/expenses/receipts" && request.method === "GET") {
      return handleListReceipts(request, env);
    }

    if (url.pathname === "/api/expenses/import" && request.method === "POST") {
      return handleExpenseImport(request, env);
    }

    // An unmatched /api/* path must 404, not fall through to static assets --
    // otherwise a typo'd API route silently returns the dashboard HTML.
    if (url.pathname.startsWith("/api/")) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    return env.ASSETS.fetch(request);
  },
};
