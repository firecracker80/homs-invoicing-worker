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

    // An unmatched /api/* path must 404, not fall through to static assets --
    // otherwise a typo'd API route silently returns the dashboard HTML.
    if (url.pathname.startsWith("/api/")) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    return env.ASSETS.fetch(request);
  },
};
