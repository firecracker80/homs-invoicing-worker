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
function moneyProp(record, key) {
  const v = record.properties ? record.properties[key] : undefined;
  if (v && typeof v === "object" && typeof v.value === "number") return v.value;
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
    bookingTotal: prop(record, "booking_total"),
    platformFee: prop(record, "platform_fee"),
    netPayout: prop(record, "net_payout"),
    paymentStatus: prop(record, "payment_status"),
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

export function normalizeExpense(record) {
  const categoryKey = prop(record, "category");
  const reviewStatusKey = prop(record, "review_status");
  return {
    id: record.id,
    kind: "expense",
    name: prop(record, "expense_name", "(untitled expense)"),
    paidOn: prop(record, "paid_on"),
    categoryKey,
    category: categoryKey ? EXPENSE_CATEGORY_LABELS[categoryKey] || categoryKey : null,
    lineItemDescription: prop(record, "line_item_description"),
    amount: moneyProp(record, "amount"),
    canReimburse: moneyProp(record, "can_reimburse"),
    alreadyReimbursed: moneyProp(record, "already_reimbursed"),
    reimbursingNow: moneyProp(record, "reimbursing_now"),
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
