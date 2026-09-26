// offerings-import.js -- the workbook's Services and Experiences sheets.
//
// These become GHL PRODUCTS with prices, not a custom object. An offering the
// manager sells -- stocking a fridge, an airport shuttle, a day pass -- is a
// priced sellable thing, and GHL already models that in a way invoices and
// payment links can reference. DEMO-HOMS already carries Fridge Stock, Airport
// Shuttle and the Boca Chica day passes exactly this way. This fills in what a
// new client names and prices it.
//
// Three things confirmed against the live API on 2026-09-26, each of which
// would otherwise have been a silent money bug:
//
//   Price `amount` is in MAJOR units. "Cleaning Fee @ 65" is a real $65, and
//   create-price's own example is 99.99. Writing cents would divide every
//   price by 100 and nothing would complain.
//
//   The product list's `hasPrices` flag LIES. It reported false for Fridge
//   Stock, which has a price. Branching on it would add a second price to the
//   same product on every run, and GHL would happily keep them all.
//
//   productType stays DIGITAL, matching every product already in these
//   accounts. A SERVICE type exists in the enum and is arguably more correct,
//   but if anything downstream filters on DIGITAL -- the booking flow, the
//   marketplace -- a new offering would simply never appear, with no error.
//   Matching what already works beats being semantically right.
//
// The sheets have NO currency column; only the Properties sheet does. So a
// price takes the account's currency, and where that is unknown NO PRICE IS
// WRITTEN. Defaulting to USD is precisely how DEMO-HOMS ended up with a fridge
// stocking priced at $2,000.

import { rowsByHeader } from "./xlsx.js";

const norm = (s) => String(s ?? "").trim().toLowerCase();
const blank = (v) => v === null || v === undefined || String(v).trim() === "";

const num = (v) => {
  if (blank(v)) return null;
  // Accept "1,200.50" and "1.200,50"; the workbook is filled by hand in two
  // regions. A bare thousands separator with no decimals is ambiguous, so any
  // value that does not resolve cleanly is reported rather than guessed.
  const raw = String(v).replace(/[^0-9.,-]/g, "");
  if (!raw) return null;
  const lastComma = raw.lastIndexOf(",");
  const lastDot = raw.lastIndexOf(".");
  let cleaned;
  if (lastComma > lastDot) cleaned = raw.replace(/\./g, "").replace(",", ".");
  else cleaned = raw.replace(/,/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
};

export const SERVICE_COLUMNS = {
  name: "Service Name",
  status: "Status",
  category: "Category",
  description: "Description",
  duration: "Duration",
  price: "Price",
  priceUnit: "Price Unit",
  addOns: "Add-Ons (optional, comma-separated)",
  provider: "Provider / Staff Assigned",
  location: "Location",
  appliesTo: 'Applies To (Property Names or "All")',
  notice: "Booking Notice Required",
  photos: "Photos Folder Link",
};

export const EXPERIENCE_COLUMNS = {
  name: "Experience Name",
  status: "Status",
  description: "Description",
  duration: "Duration",
  maxCapacity: "Max Capacity",
  minParticipants: "Min Participants",
  price: "Price",
  priceUnit: "Price Unit",
  addOns: "Add-Ons (optional, comma-separated)",
  difficulty: "Difficulty",
  season: "Season / Availability Window",
  meetingPoint: "Meeting Point / Pickup Location",
  included: "What's Included",
  appliesTo: 'Applies To (Property Names or "N/A")',
  photos: "Photos Folder Link",
};

// Columns a guest would want to read. They have no product field of their own,
// so they are folded into the description rather than becoming new fields --
// the same call Yari made about the calendar-only columns.
const DESCRIPTION_PARTS = [
  ["description", null],
  ["duration", "Duration"],
  ["included", "Includes"],
  ["addOns", "Add-ons"],
  ["meetingPoint", "Meeting point"],
  ["difficulty", "Difficulty"],
  ["season", "Availability"],
  ["maxCapacity", "Maximum participants"],
  ["minParticipants", "Minimum participants"],
];

// Columns somebody has to act on, which no product field holds either. These
// come back as a checklist instead of being dropped.
const CHECKLIST_PARTS = [
  ["provider", "Provider / staff assigned"],
  ["appliesTo", "Applies to"],
  ["notice", "Booking notice required"],
  ["location", "Location"],
  ["photos", "Photos folder"],
];

export function descriptionFrom(values, columns) {
  const parts = [];
  for (const [key, label] of DESCRIPTION_PARTS) {
    const column = columns[key];
    if (!column) continue;
    const value = values[column];
    if (blank(value)) continue;
    parts.push(label ? `${label}: ${String(value).trim()}` : String(value).trim());
  }
  return parts.join("\n\n");
}

export function checklistFrom(values, columns) {
  const detail = {};
  for (const [key, label] of CHECKLIST_PARTS) {
    const column = columns[key];
    if (!column) continue;
    const value = values[column];
    if (!blank(value)) detail[label] = String(value).trim();
  }
  return detail;
}

// The shipped template's example row: the first data row, with placeholder
// giveaways. Same rule as the Properties sheet -- flagged, never auto-imported.
export function looksLikeExampleRow(values, isFirstRow) {
  if (!isFirstRow) return false;
  const joined = Object.values(values).map((v) => String(v ?? "")).join(" ").toLowerCase();
  return /\bxxxx\b|\be\.g\.|\bejemplo\b|\bexample\b/.test(joined);
}

// "Per person" and the like have no GHL field. They go in the price NAME, which
// is what an invoice line shows and how "Cleaning Fee @ 65" already reads.
export function priceNameFor(name, amount, priceUnit) {
  const unit = blank(priceUnit) ? "" : ` ${String(priceUnit).trim().toLowerCase()}`;
  return `${name} @ ${amount}${unit}`;
}

export function mapOfferingsSheet(sheet, kind, { existingProducts = [], currency = null } = {}) {
  const columns = kind === "experience" ? EXPERIENCE_COLUMNS : SERVICE_COLUMNS;
  const { records } = rowsByHeader(sheet);
  const known = new Map((existingProducts || []).map((p) => [norm(p.name), p]));
  const seen = new Set();

  const rows = records.map((rec, i) => {
    const v = rec.values;
    const issues = [];
    const name = blank(v[columns.name]) ? null : String(v[columns.name]).trim();

    if (!name) issues.push("no_name");
    if (looksLikeExampleRow(v, i === 0)) issues.push("example_row");

    const status = norm(v[columns.status]);
    if (status && status !== "active") issues.push("not_active");

    const rawPrice = v[columns.price];
    const amount = num(rawPrice);
    if (blank(rawPrice)) issues.push("no_price");
    else if (amount === null) issues.push("bad_price");
    else if (amount < 0) issues.push("negative_price");

    // No account currency means no price. Guessing one is how a DOP figure
    // becomes a dollar figure, and the number looks perfectly reasonable.
    if (amount !== null && !currency) issues.push("no_account_currency");

    const existing = name ? known.get(norm(name)) : null;
    if (existing) issues.push("already_a_product");
    if (name && seen.has(norm(name))) issues.push("duplicate_in_file");
    if (name) seen.add(norm(name));

    const blocked = issues.includes("no_name");
    const flagged = issues.some((x) => x !== "already_a_product") || Boolean(existing);

    return {
      rowNumber: rec.rowNumber,
      kind,
      name,
      status: status || null,
      category: kind === "service" && !blank(v[columns.category]) ? String(v[columns.category]).trim() : null,
      product: name ? { name, description: descriptionFrom(v, columns), productType: "DIGITAL" } : null,
      price: amount !== null && currency
        ? { name: priceNameFor(name ?? "", amount, v[columns.priceUnit]), type: "one_time", currency, amount }
        : null,
      existingProductId: existing?._id ?? existing?.id ?? null,
      checklist: checklistFrom(v, columns),
      issues,
      blocked,
      include: !blocked && !flagged,
    };
  });

  return { rows };
}

export function parseOfferings(workbook, { existingProducts = [], currency = null } = {}) {
  const sheets = workbook?.sheets || [];
  const find = (re) => sheets.find((s) => re.test(s.name));
  const servicesSheet = find(/servic/i);
  const experiencesSheet = find(/experien/i);

  const rows = [];
  if (servicesSheet) rows.push(...mapOfferingsSheet(servicesSheet, "service", { existingProducts, currency }).rows);
  if (experiencesSheet) rows.push(...mapOfferingsSheet(experiencesSheet, "experience", { existingProducts, currency }).rows);

  return {
    rows,
    sheetsFound: {
      services: Boolean(servicesSheet),
      experiences: Boolean(experiencesSheet),
    },
    currency,
    summary: {
      total: rows.length,
      ready: rows.filter((r) => r.include).length,
      needsReview: rows.filter((r) => !r.include && !r.blocked).length,
      blocked: rows.filter((r) => r.blocked).length,
    },
  };
}
