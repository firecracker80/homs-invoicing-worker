import { fetchAllObjectRecords, fetchContacts, createObjectRecord, fetchAssociations, createRelation, fetchCustomValues } from "./ghl.js";
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
import { provision } from "./provision.js";
import { handleVendorData } from "./vendor.js";
import { mapCsvRows, loadExistingExpenses, importRows } from "./expenses-import.js";
import { extractFromFile, rowsFromExtraction, estimateCost, resolveModel, MODELS, MAX_FILE_BYTES } from "./receipt-extract.js";
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
    return { error: Response.json({ error: `Unknown locationId: ${locationId}` }, { status: 404 }) };
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

async function handleCreateExpense(request, env) {
  const body = await request.json();
  const { locationId, propertyId, ownerContactId, name, paidOn, categoryKey, lineItemDescription, amount } = body;

  const { tenant, pit, error } = await resolveTenantPit(env, locationId);
  if (error) return error;

  if (!name || !categoryKey || amount === undefined || amount === null || amount === "") {
    return Response.json({ error: "name, categoryKey, and amount are required" }, { status: 400 });
  }

  const properties = {
    expense_name: name,
    category: categoryKey,
    amount: { value: Number(amount), currency: "default" },
    review_status: "needs_review",
  };
  if (paidOn) properties.paid_on = paidOn;
  if (lineItemDescription) properties.line_item_description = lineItemDescription;

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

    return Response.json({ success: true, id: newId, links });
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
    const submission = await fetchLatestSubmission(pit, surveyId, contactId);
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
