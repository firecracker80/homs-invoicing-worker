// Maps raw GHL custom-object/contact records into flat shapes the frontend renders,
// and resolves each record's `relations` array (association records embedded inline
// by GHL's search-object-records response) into the linked record's display name.
//
// IMPORTANT: record.properties keys are the *short* field key (e.g. "property_name"),
// not the fully-qualified fieldKey from get-custom-fields-by-object-key
// (e.g. "custom_objects.properties.property_name"). Verified against live records.

function relatedId(record, objectKey) {
  const rel = (record.relations || []).find((r) => r.objectKey === objectKey);
  return rel ? rel.recordId : null;
}

function prop(record, key, fallback = null) {
  const v = record.properties ? record.properties[key] : undefined;
  return v === undefined || v === null || v === "" ? fallback : v;
}

// MONETORY fields are stored as {value, currency} objects -- verified live
// against the GHL API (currency is literally the string "default").
// The urls out of a FILE_UPLOAD field, whatever shape it arrives in.
//
// Deliberately permissive about the shape and strict about the result: every
// branch has to produce an http(s) url or nothing. A field this code has never
// seen populated is not the place to assume a shape, and the failure mode to
// avoid is rendering "[object Object]" as a link.
export function fileUrlsProp(record, key) {
  const v = record.properties ? record.properties[key] : undefined;
  if (v === null || v === undefined || v === "") return [];

  const urlOf = (x) => {
    if (typeof x === "string") return x.trim();
    if (x && typeof x === "object") return String(x.url || x.fileUrl || x.link || "").trim();
    return "";
  };
  const nameOf = (x, url) => {
    // meta.name is where GHL actually puts it. Confirmed 2026-10-08, the first
    // time a receipt was attached through the object's own widget:
    //   [{ url, meta: { name: "WhatsApp Image ... .jpeg", extension, size } }]
    // Without it the reader fell through to the url's last segment, which is a
    // uuid -- a correct link labelled with nothing a person could recognise.
    const named = x && typeof x === "object"
      ? String(x.meta?.name || x.name || x.filename || "").trim()
      : "";
    if (named) return named;
    // Fall back to the last path segment, minus any query string.
    try { return decodeURIComponent(new URL(url).pathname.split("/").pop()) || "receipt"; }
    catch { return "receipt"; }
  };

  // A single value, an array of them, or a comma/newline separated string.
  const items = Array.isArray(v) ? v
    : typeof v === "string" ? v.split(/[\n,]+/)
    : [v];

  const out = [];
  for (const item of items) {
    const url = urlOf(item);
    // http(s) only: this becomes an href, and a javascript: or data: value in a
    // CRM field must not become a link the reader can click.
    if (!/^https?:\/\//i.test(url)) continue;
    out.push({ url, name: nameOf(item, url), source: "ghl_field" });
  }
  return out;
}

function moneyProp(record, key) {
  const v = record.properties ? record.properties[key] : undefined;
  if (v && typeof v === "object" && typeof v.value === "number") return v.value;
  // A bare number (older records, hand-entered data) is still an amount.
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export const EXPENSE_CATEGORY_LABELS = {
  maintenance_repairs: "Maintenance & Repairs",
  cleaning_supplies: "Cleaning Supplies",
  utilities: "Utilities",
  pest_control: "Pest Control",
  landscaping: "Landscaping",
  insurance: "Insurance",
  property_tax: "Property Tax",
  management_fee: "Management Fee",
  miscellaneous: "Miscellaneous Expenses",
  other: "Other",
};

export const EXPENSE_REVIEW_STATUS_LABELS = {
  needs_review: "Needs Review",
  approved: "Approved",
};

export const INVENTORY_CATEGORY_LABELS = {
  furniture: "Furniture",
  appliances: "Appliances",
  linens_bedding: "Linens & Bedding",
  kitchenware: "Kitchenware",
  electronics: "Electronics",
  outdoor: "Outdoor",
  safety_security: "Safety & Security",
  supplies: "Supplies",
  decor: "Decor",
  other: "Other",
};

export const INVENTORY_CONDITION_LABELS = {
  new: "New",
  good: "Good",
  fair: "Fair",
  needs_replacement: "Needs Replacement",
  missing: "Missing",
};

export function normalizeProperty(record) {
  return {
    id: record.id,
    kind: "property",
    name: prop(record, "property_name", "(untitled property)"),
    status: prop(record, "status"),
    propertyType: prop(record, "property_type"),
    address: prop(record, "address"),
    bedrooms: prop(record, "bedrooms"),
    bathrooms: prop(record, "bathrooms"),
    maxOccupancy: prop(record, "max_occupancy"),
    baseNightlyRate: prop(record, "base_nightly_rate"),
    cleaningFee: prop(record, "cleaning_fee"),
    petFee: prop(record, "pet_fee"),
    ownerContactId: relatedId(record, "contact"),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function normalizeOtaChannel(record) {
  return {
    id: record.id,
    kind: "ota_channel",
    name: prop(record, "channel_name", "(untitled channel)"),
    externalListingId: prop(record, "external_listing_id"),
    listingUrl: prop(record, "listing_url"),
    icalLink: prop(record, "ical_link"),
    syncStatus: prop(record, "sync_status"),
    commissionRate: prop(record, "commission_rate"),
    lastSynced: prop(record, "last_synced"),
    propertyId: relatedId(record, "custom_objects.properties"),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function normalizeTransaction(record) {
  return {
    id: record.id,
    kind: "transaction",
    name: prop(record, "transaction_name", "(untitled transaction)"),
    guestName: prop(record, "guest_name"),
    checkinDate: prop(record, "checkin_date"),
    checkoutDate: prop(record, "checkout_date"),
    bookingReference: prop(record, "booking_reference"),
    bookingTotal: moneyProp(record, "booking_total"),
    platformFee: moneyProp(record, "platform_fee"),
    netPayout: moneyProp(record, "net_payout"),
    paymentStatus: prop(record, "payment_status"),
    // The booking's own lifecycle, as distinct from whether money arrived.
    //
    // The field does not exist on the Transactions object yet, so this reads
    // undefined everywhere today and the dashboard falls back to deriving a
    // status from the dates. Cancelled and rescheduled are the two states the
    // dates cannot express, and they are the reason the field is needed.
    bookingStatus: prop(record, "booking_status"),
    propertyId: relatedId(record, "custom_objects.properties"),
    otaChannelId: relatedId(record, "custom_objects.ota_channels"),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function normalizeChecklist(record) {
  return {
    id: record.id,
    kind: "checklist",
    name: prop(record, "job_name", "(untitled job)"),
    completionDate: prop(record, "completion_date"),
    cleanerNameService: prop(record, "cleaner_name__service"),
    turnoverType: prop(record, "turnover_type"),
    overallStatus: prop(record, "overall_status"),
    damageNotes: prop(record, "damage__issues_noted"),
    missingSupplies: prop(record, "missing__low_supplies"),
    guestItemsFound: prop(record, "guest_items_found"),
    propertyNameField: prop(record, "property_name"),
    bookingReferenceField: prop(record, "booking_reference"),
    propertyId: relatedId(record, "custom_objects.properties"),
    transactionId: relatedId(record, "custom_objects.transactions"),
    cleanerContactId: relatedId(record, "contact"),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

// The options on custom_objects.expenses.paid_by. Labelled for a reader rather
// than shown as the stored key, the way category already is.
const PAID_BY_LABELS = { owner: "Owner", manager: "Manager" };

export function normalizeExpense(record) {
  const categoryKey = prop(record, "category");
  const reviewStatusKey = prop(record, "review_status");
  return {
    id: record.id,
    kind: "expense",
    name: prop(record, "expense_name", "(untitled expense)"),
    paidOn: prop(record, "paid_on"),
    // Whose cost it is -- the single most consequential field on an expense,
    // and the dashboard has never read it. An owner-borne cost is deducted
    // from that owner's payout; a manager-borne one is the management
    // company's own. The Worker requires it on create and manager-pl.js nets
    // on it, so a record carrying it was being shown next to three dead
    // reimbursement fields that describe a process which does not exist.
    paidByKey: prop(record, "paid_by"),
    paidBy: PAID_BY_LABELS[prop(record, "paid_by")] || prop(record, "paid_by"),
    categoryKey,
    category: categoryKey ? EXPENSE_CATEGORY_LABELS[categoryKey] || categoryKey : null,
    lineItemDescription: prop(record, "line_item_description"),
    amount: moneyProp(record, "amount"),
    // Original currency as recorded (service costs arrive in DOP even in a USD
    // account); null means the account's own currency. Converted figures exist
    // only when the client opted to convert.
    currency: prop(record, "currency") ? String(prop(record, "currency")).toUpperCase() : null,
    convertedAmount: moneyProp(record, "converted_amount"),
    exchangeRate: prop(record, "exchange_rate"),
    rateDate: prop(record, "rate_date"),
    rateSource: prop(record, "rate_source"),
    // can_reimburse, already_reimbursed and reimbursing_now are NOT read.
    //
    // They describe a reimbursement cycle that does not exist: a stateside
    // manager collects the booking income, subtracts the owner's costs, and
    // sends the remainder -- an owner's cost is DEDUCTED FROM THEIR PAYOUT, it
    // is never invoiced to them and never reimbursed. Paid By is the whole
    // model. The fields are still on the object and three DEMO-HOMS records
    // still carry values, so they are left in place rather than deleted;
    // nothing reads them, here or in manager-pl.js.
    //
    // Receipts attached inside GHL, as opposed to through this dashboard.
    //
    // Two places a receipt can live, because only one of them is writable:
    // FILE_UPLOAD fields cannot be SET through the records API (probed
    // 2026-10-07, ten shapes, all 422), so the dashboard files its own uploads
    // in a media-library folder instead. This reads the other half so the
    // dashboard can show one list rather than half of one.
    //
    // UNVERIFIED on the way in: no expense record on any account has ever had a
    // receipt attached, so whether GHL returns a populated FILE_UPLOAD field at
    // all is unknown -- an empty one is simply omitted from `properties`. The
    // shapes below are the ones GHL uses elsewhere for files; if it returns
    // something else, this yields [] rather than throwing, and the folder half
    // keeps working. One receipt attached by hand in the GHL UI settles it.
    receiptPhotos: fileUrlsProp(record, "receipt_photo"),
    reviewStatusKey,
    reviewStatus: reviewStatusKey ? EXPENSE_REVIEW_STATUS_LABELS[reviewStatusKey] || reviewStatusKey : null,
    propertyId: relatedId(record, "custom_objects.properties"),
    ownerContactId: relatedId(record, "contact"),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function normalizeInventoryItem(record) {
  const categoryKey = prop(record, "category");
  const conditionKey = prop(record, "condition");
  return {
    id: record.id,
    kind: "inventory_item",
    name: prop(record, "item_name", "(untitled item)"),
    categoryKey,
    category: categoryKey ? INVENTORY_CATEGORY_LABELS[categoryKey] || categoryKey : null,
    quantity: prop(record, "quantity"),
    conditionKey,
    condition: conditionKey ? INVENTORY_CONDITION_LABELS[conditionKey] || conditionKey : null,
    locationInProperty: prop(record, "location_in_property"),
    purchaseDate: prop(record, "purchase_date"),
    purchaseCost: moneyProp(record, "purchase_cost"),
    lastVerifiedDate: prop(record, "last_verified_date"),
    notes: prop(record, "notes"),
    propertyId: relatedId(record, "custom_objects.properties"),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function normalizeContact(record) {
  const first = record.firstName || "";
  const last = record.lastName || "";
  return {
    id: record.id,
    kind: "contact",
    name: (record.contactName || `${first} ${last}`).trim() || "(no name)",
    email: record.email || null,
    phone: record.phone || null,
    tags: record.tags || [],
    createdAt: record.dateAdded,
  };
}

// Join propertyId/otaChannelId/transactionId/cleanerContactId into readable names,
// using id-indexed maps built from the already-fetched full lists.
export function resolveJoins({ properties, otaChannels, transactions, checklists, contacts, expenses = [], inventoryItems = [] }) {
  const propertyById = new Map(properties.map((p) => [p.id, p]));
  const otaById = new Map(otaChannels.map((o) => [o.id, o]));
  const transactionById = new Map(transactions.map((t) => [t.id, t]));
  const contactById = new Map(contacts.map((c) => [c.id, c]));

  for (const o of otaChannels) {
    o.propertyName = o.propertyId ? propertyById.get(o.propertyId)?.name || null : null;
  }
  for (const t of transactions) {
    t.propertyName = t.propertyId ? propertyById.get(t.propertyId)?.name || null : null;
    t.otaChannelName = t.otaChannelId ? otaById.get(t.otaChannelId)?.name || null : null;
  }
  for (const c of checklists) {
    c.propertyName = c.propertyId ? propertyById.get(c.propertyId)?.name || null : c.propertyNameField;
    c.transactionName = c.transactionId ? transactionById.get(c.transactionId)?.name || null : null;
    c.bookingReference = c.transactionId
      ? transactionById.get(c.transactionId)?.bookingReference || null
      : c.bookingReferenceField;
    c.cleanerContactName = c.cleanerContactId ? contactById.get(c.cleanerContactId)?.name || null : null;
  }

  for (const e of expenses) {
    e.propertyName = e.propertyId ? propertyById.get(e.propertyId)?.name || null : null;
    e.ownerContactName = e.ownerContactId ? contactById.get(e.ownerContactId)?.name || null : null;
  }

  // Reverse: which OTA channels list each property, which transactions/checklists belong to it.
  for (const p of properties) {
    p.otaChannelNames = otaChannels.filter((o) => o.propertyId === p.id).map((o) => o.name);
    p.transactionCount = transactions.filter((t) => t.propertyId === p.id).length;
    p.ownerContactName = p.ownerContactId ? contactById.get(p.ownerContactId)?.name || null : null;
  }

  // Expense owner falls back to the property's own owner when the expense
  // record itself isn't individually linked to a contact.
  for (const e of expenses) {
    if (!e.ownerContactName && e.propertyId) {
      e.ownerContactName = propertyById.get(e.propertyId)?.ownerContactName || null;
    }
  }

  for (const i of inventoryItems) {
    i.propertyName = i.propertyId ? propertyById.get(i.propertyId)?.name || null : null;
  }
}

// Every string field on a normalized record, lowercased, for universal search.
export function searchableText(record) {
  return Object.values(record)
    .filter((v) => typeof v === "string" || typeof v === "number")
    .join(" ␟ ")
    .toLowerCase();
}
