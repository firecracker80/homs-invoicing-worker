// portfolio-import.js -- the client's HOMS Portfolio Intake workbook, turned
// into Property records and the two account-level settings it carries.
//
// Same contract as the expense importer, for the same reason: parse returns
// rows and writes nothing; import writes only what the reviewer ticked. A
// portfolio workbook arrives once per client and sets the prices every future
// booking is calculated from, so it is the last place to guess.
//
// What it cannot do: create the rental calendars. GHL's calendar API has no
// rental type (calendarType is round_robin | event | class_booking | collective
// | service_booking | personal), and rental listings are invisible to it --
// get-calendars returns empty on an account with live listings. The listings
// stay a manual step, so this produces a checklist for them instead of
// pretending otherwise.

import { createObjectRecord, fetchAllObjectRecords } from "./ghl.js";
import { readWorkbook, rowsByHeader } from "./xlsx.js";

export const PROPERTY_OBJECT = "custom_objects.properties";
export const MAX_ROWS = 500;

// Workbook column -> the live Properties object's field key. Read from
// DEMO-HOMS 2026-09-25; the object has ten fields and the workbook has 26
// columns, so most of the sheet has nowhere to go yet -- reported, never
// dropped silently.
const FIELD_MAP = {
  "Listing Name": { key: "property_name" },
  "Status": { key: "status", option: { active: "active", seasonal: "seasonal", inactive: "inactive" } },
  "Property Type": { key: "property_type", option: { apartment: "apartment", villa: "villa", house: "house", room: "room", other: "other" } },
  "Full Address": { key: "address" },
  "Max Occupancy": { key: "max_occupancy", number: true },
  "Bedrooms / Bed Configuration": { key: "bedrooms", number: true, leadingNumber: true },
  "Bathrooms": { key: "bathrooms", number: true },
  "Base Price": { key: "base_nightly_rate", money: true },
  "Cleaning Fee": { key: "cleaning_fee", money: true },
  "Pet Fee": { key: "pet_fee", money: true },
};

// Columns that belong to the RENTAL LISTING, not to the Property object. The
// object is a lightweight index -- name, type, address, capacity, rates. The
// guest-facing detail lives on the listing in GHL, which no API can create, so
// these are gathered into the checklist a human works from. They are not a gap
// and must never be reported as one.
export const LISTING_COLUMNS = [
  "Neighborhood / Zone", "Square Footage / Meters (optional)", "Description",
  "Distinguishing Feature", "Target Guest", "Amenities (comma-separated)",
  "Booking Unit", "Security Deposit", "Check-in Time", "Check-out Time",
  "House Rules", "Calendar Platform(s)", "Calendar Export Links (.ics)", "Photos Folder Link",
];

// Carried by the workbook but account-level: one per client, not per listing.
export const ACCOUNT_COLUMNS = { currency: "Currency", cancellationPolicy: "Cancellation Policy" };

// Airbnb's five standard policies, in the sentence the Worker's
// parseCancellationPolicy reads, so a human-readable choice and a
// machine-readable policy stay the same thing. These are a copy of
// AIRBNB_POLICIES in homs-invoicing-worker/src/policy.js -- the two repos share
// no code, and that file is where the terms are documented and sourced. Change
// both together.
//
//   grace 24h/7d  full refund within 24h of booking, if check-in is 7+ days off
//   1n            keep one night, not a share of the rent
//   1n+50%        one night, plus half of the nights that go unused
export const CANCELLATION_PRESETS = {
  flexible: "grace 24h/7d, 24h 1n, check-in 100%",
  moderate: "grace 24h/7d, 5d 1n+50%, check-in 100%",
  limited:  "grace 24h/7d, 7d 100%, 14d 50%, check-in 100%",
  firm:     "grace 24h/7d, 7d 100%, 30d 50%, check-in 100%",
  strict:   "grace 24h/7d, 7d 100%, 3650d 50%, check-in 100%",
};

const norm = (s) => String(s ?? "").trim().toLowerCase();
const num = (v) => {
  const n = Number(String(v ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
};

// "1 bedroom, 1 king + 1 sofa bed" -> 1. The workbook asks for a description
// and the object stores a number, so take the count and keep the prose for the
// reviewer rather than inventing a field for it.
const leadingNumber = (v) => {
  const m = String(v ?? "").match(/\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};

// The shipped template's example row. It is the first data row and looks exactly
// like a real one, so it is detected and unticked rather than imported as a
// property called "Arpel 07" into every new client's account.
const PLACEHOLDER = /xxxx|e\.g\.|lorem/i;
function looksLikeExampleRow(values, isFirstDataRow) {
  const hasPlaceholder = Object.values(values).some((v) => PLACEHOLDER.test(String(v)));
  return hasPlaceholder && isFirstDataRow;
}

/** Pure: workbook sheets in, draft rows + account settings + warnings out. */
export function mapPropertiesSheet(sheet, { existingNames = [] } = {}) {
  const { headers, records } = rowsByHeader(sheet);
  const headerNames = Object.values(headers);
  if (!headerNames.includes("Listing Name")) {
    return { error: "no_listing_name_column", headers: headerNames };
  }

  const known = new Set(existingNames.map(norm));
  const seen = new Set();
  const truncated = records.length > MAX_ROWS;

  const rows = records.slice(0, MAX_ROWS).map((rec, i) => {
    const v = rec.values;
    const issues = [];
    const properties = {};
    const carried = {};

    for (const [column, rule] of Object.entries(FIELD_MAP)) {
      const raw = v[column];
      if (raw === undefined || raw === "") continue;
      let value;
      if (rule.option) {
        value = rule.option[norm(raw)];
        if (!value) { issues.push(`unknown_${rule.key}`); continue; }
      } else if (rule.leadingNumber) {
        value = leadingNumber(raw);
        // The bed configuration is the useful half and the object has no field
        // for it, so it is kept where a human will see it.
        if (String(raw).replace(/^\s*\d+(\.\d+)?\s*/, "").trim()) carried["bed configuration"] = raw;
      } else if (rule.number || rule.money) {
        value = num(raw);
      } else {
        value = raw;
      }
      if (value === null || value === undefined) { issues.push(`bad_${rule.key}`); continue; }
      properties[rule.key] = rule.money ? { value, currency: "default" } : value;
    }

    const name = properties.property_name;
    if (!name) issues.push("no_listing_name");
    if (properties.base_nightly_rate === undefined) issues.push("no_base_price");

    // Priced per week or month, but the object's field is a nightly rate.
    const unit = norm(v["Booking Unit"]);
    if (unit && unit !== "day") issues.push("not_priced_per_night");

    if (name && known.has(norm(name))) issues.push("already_in_account");
    if (name && seen.has(norm(name))) issues.push("duplicate_in_file");
    if (name) seen.add(norm(name));

    if (looksLikeExampleRow(v, i === 0)) issues.push("example_row");

    const blocked = issues.some((x) => ["no_listing_name"].includes(x));
    const flagged = issues.some((x) =>
      x === "example_row" || x === "already_in_account" || x === "duplicate_in_file" ||
      x === "no_base_price" || x === "not_priced_per_night" || x.startsWith("unknown_") || x.startsWith("bad_"));

    return {
      rowNumber: rec.rowNumber,
      name: name ?? null,
      properties,
      carried,
      // Anything that is neither an object field, an account setting, nor known
      // listing detail -- i.e. a column nobody has accounted for. Normally empty.
      unrecognised: Object.fromEntries(Object.entries(v).filter(([k]) =>
        !FIELD_MAP[k] && !Object.values(ACCOUNT_COLUMNS).includes(k) && !LISTING_COLUMNS.includes(k))),
      issues,
      include: !blocked && !flagged,
      blocked,
    };
  });

  return { rows, truncated, headers: headerNames };
}

/**
 * Currency and cancellation policy are one-per-account but live in a column.
 * Yari's rule (2026-09-25): take the first data row, and warn loudly about any
 * row that disagrees -- a mixed-currency workbook usually means the client
 * misread the question, and silently reconciling it would price every booking
 * in that account wrong.
 */
export function accountSettingsFrom(sheet, rows) {
  const { records } = rowsByHeader(sheet);
  const real = records.filter((r) => {
    const row = rows.find((x) => x.rowNumber === r.rowNumber);
    return !row?.issues.includes("example_row");
  });
  if (!real.length) return { settings: {}, disagreements: [] };

  const settings = {};
  const disagreements = [];

  for (const [field, column] of Object.entries(ACCOUNT_COLUMNS)) {
    const values = real.map((r) => ({ rowNumber: r.rowNumber, value: String(r.values[column] ?? "").trim() })).filter((x) => x.value);
    if (!values.length) { disagreements.push({ field, column, kind: "missing" }); continue; }
    const first = values[0];
    settings[field] = first.value;
    const differing = values.filter((x) => norm(x.value) !== norm(first.value));
    if (differing.length) {
      disagreements.push({
        field, column, kind: "conflict", used: first.value, fromRow: first.rowNumber,
        rows: differing.map((d) => d.rowNumber), alsoSeen: [...new Set(differing.map((d) => d.value))],
      });
    }
  }

  if (settings.currency) settings.currency = settings.currency.toUpperCase();
  if (settings.cancellationPolicy) {
    const preset = CANCELLATION_PRESETS[norm(settings.cancellationPolicy)];
    settings.cancellationPolicyLabel = settings.cancellationPolicy;
    // "Other" and anything unrecognised must never provision silently.
    if (preset) settings.cancellationPolicy = preset;
    else disagreements.push({ field: "cancellationPolicy", column: ACCOUNT_COLUMNS.cancellationPolicy, kind: "needs_review", value: settings.cancellationPolicyLabel });
  }
  return { settings, disagreements };
}

/**
 * Everything needed to create each rental listing by hand, since no API can.
 * Carries every listing-facing column the client filled in, so creating the
 * listing is transcription with nothing to look up and nothing to decide.
 */
export function calendarChecklist(sheet, rows) {
  const { records } = rowsByHeader(sheet);
  const wanted = new Set(rows.filter((r) => r.include).map((r) => r.rowNumber));
  return records.filter((r) => wanted.has(r.rowNumber)).map((r) => {
    const detail = {};
    for (const column of LISTING_COLUMNS) {
      const value = r.values[column];
      if (value !== undefined && value !== "") detail[column] = value;
    }
    return {
      listing: r.values["Listing Name"],
      basePrice: r.values["Base Price"] ?? null,
      currency: r.values[ACCOUNT_COLUMNS.currency] ?? null,
      detail,
    };
  });
}

export async function parsePortfolio(data, { existingNames = [] } = {}) {
  const wb = await readWorkbook(data);
  const properties = wb.sheets.find((s) => /propert/i.test(s.name));
  if (!properties) return { error: "no_properties_sheet", sheets: wb.sheets.map((s) => s.name) };

  const mapped = mapPropertiesSheet(properties, { existingNames });
  if (mapped.error) return mapped;

  const { settings, disagreements } = accountSettingsFrom(properties, mapped.rows);
  const unrecognisedColumns = [...new Set(mapped.rows.flatMap((r) => Object.keys(r.unrecognised)))];

  return {
    rows: mapped.rows,
    truncated: mapped.truncated,
    accountSettings: settings,
    disagreements,
    unrecognisedColumns,
    calendarChecklist: calendarChecklist(properties, mapped.rows),
    sheets: wb.sheets.map((s) => s.name),
    summary: {
      total: mapped.rows.length,
      ready: mapped.rows.filter((r) => r.include).length,
      needsReview: mapped.rows.filter((r) => !r.include).length,
    },
  };
}

export async function loadExistingPropertyNames(pit, locationId) {
  const records = await fetchAllObjectRecords(pit, locationId, PROPERTY_OBJECT);
  return records.map((r) => r.properties?.property_name).filter(Boolean);
}

/** Creates one Property record per row. Sequential: GHL rate-limits object writes. */
export async function importProperties(pit, locationId, rows) {
  const created = [];
  const failed = [];
  for (const row of rows) {
    if (!row?.properties?.property_name) {
      failed.push({ rowNumber: row?.rowNumber ?? null, name: row?.name ?? null, error: "a listing name is required" });
      continue;
    }
    try {
      const record = await createObjectRecord(pit, locationId, PROPERTY_OBJECT, row.properties);
      created.push({ rowNumber: row.rowNumber, id: record.id, name: row.properties.property_name });
    } catch (err) {
      failed.push({ rowNumber: row.rowNumber, name: row.properties.property_name, error: err.message || "create failed" });
    }
  }
  return { created, failed };
}
