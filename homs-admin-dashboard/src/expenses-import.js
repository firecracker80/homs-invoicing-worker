// expenses-import.js -- getting expenses INTO a vendor book (HOMS, DTCS).
//
// The book already computes a P&L (vendor.js) and renders it, but nothing could
// add a row from the dashboard: POST /api/expenses is the client-side shape
// (property/owner links, reimbursement) and is wrong here, where the fields that
// matter are vendor, currency, recurrence, source and the receipt.
//
// Two steps, always, and never one: parse returns rows and writes nothing;
// import writes only the rows handed back to it. A CSV from a bank or a card
// statement is messy enough that a straight-to-GHL import would quietly plant
// bad records in the book -- and a P&L that lies is worse than one that is empty.
//
// The parsing here is pure and I/O-free so it can be tested against real-world
// CSV shapes without GHL.

import { createObjectRecord, fetchAllObjectRecords } from "./ghl.js";
import { normalizeVendorExpense } from "./vendor.js";

export const EXPENSE_OBJECT = "custom_objects.expenses";

// Matches the SINGLE_OPTIONS options built on the live object (2026-09-11).
export const CATEGORIES = [
  "platform", "infrastructure", "office", "telecom",
  "contractors", "marketing", "payment_fees", "software", "other",
];
export const RECURRENCES = ["one_off", "monthly", "annual"];
export const CURRENCIES = ["usd", "dop"];

const MAX_ROWS = 300;

// ---- CSV ---------------------------------------------------------------------

// Which character separates the columns. A DR-side export writes amounts as
// "1.500,00", so the comma is already taken and the file uses semicolons instead
// -- splitting it on commas turns every amount into two columns and the money
// reads 1.5 instead of 1500. Sniff the header rather than assume.
export function detectDelimiter(text) {
  const firstLine = String(text ?? "").replace(/^﻿/, "").split(/\r?\n/).find((l) => l.trim() !== "") || "";
  const outsideQuotes = firstLine.replace(/"[^"]*"/g, "");
  const counts = [",", ";", "\t"].map((d) => [d, outsideQuotes.split(d).length - 1]);
  const [best, n] = counts.sort((a, b) => b[1] - a[1])[0];
  return n > 0 ? best : ",";
}

// RFC4180 enough for what banks and SaaS vendors actually export: quoted fields,
// doubled quotes inside them, embedded separators and newlines, CRLF, and a BOM
// (Excel writes one, and it silently corrupts the first header name without this).
export function parseCsv(text, delimiter = detectDelimiter(text)) {
  const s = String(text ?? "").replace(/^﻿/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let i = 0;
  let any = false;

  const endField = () => { row.push(field); field = ""; any = true; };
  const endRow = () => { endField(); rows.push(row); row = []; any = false; };

  while (i < s.length) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"' && field === "") { quoted = true; any = true; i++; continue; }
    if (c === delimiter) { endField(); i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { endRow(); i++; continue; }
    field += c; i++;
  }
  if (field !== "" || any || row.length) endRow();

  // Trailing blank lines are normal in exports and are not empty records.
  return rows.filter((r) => r.some((v) => String(v).trim() !== ""));
}

// ---- column mapping ----------------------------------------------------------

const norm = (s) => String(s ?? "")
  .normalize("NFD").replace(/[̀-ͯ]/g, "")   // categoría -> categoria
  .toLowerCase().replace(/[^a-z0-9]/g, "");

// Spanish and English, because the DR-side exports (Banreservas) come in Spanish
// and the SaaS ones in English, and Yari imports both into the same book.
const ALIASES = {
  paidOn: ["date", "paidon", "paiddate", "fecha", "fechadepago", "transactiondate", "postingdate", "postdate", "fechatransaccion"],
  vendor: ["vendor", "merchant", "payee", "proveedor", "supplier", "comercio", "beneficiario"],
  name: ["name", "expensename", "description", "descripcion", "concepto", "memo", "details", "detalle", "item", "reference", "referencia"],
  amount: ["amount", "monto", "total", "importe", "charge", "debit", "debito", "value", "valor", "price", "precio", "cargo"],
  currency: ["currency", "moneda", "ccy", "curr"],
  category: ["category", "categoria", "type", "tipo"],
  recurrence: ["recurrence", "recurrencia", "frequency", "frecuencia"],
  billingPeriod: ["billingperiod", "period", "periodo", "billingcycle"],
  notes: ["notes", "note", "notas", "comentarios", "comment"],
};

export function mapHeader(header) {
  const cols = {};
  header.forEach((raw, idx) => {
    const key = norm(raw);
    if (!key) return;
    for (const [field, names] of Object.entries(ALIASES)) {
      if (cols[field] === undefined && names.includes(key)) { cols[field] = idx; return; }
    }
  });
  return cols;
}

// ---- values ------------------------------------------------------------------

const SYMBOL_CURRENCY = [
  [/rd\$|\bdop\b|\brd\b/i, "DOP"],
  [/us\$|\busd\b/i, "USD"],
];

// "1,234.56", "1.234,56", "$1,234.56", "(45.00)" and "45.00-" all appear in real
// exports. The last separator present is the decimal one; anything else is
// thousands. Parentheses and a trailing minus are accounting notation for a debit.
export function parseAmount(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return { amount: null };
  let currency = null;
  for (const [re, ccy] of SYMBOL_CURRENCY) if (re.test(s)) { currency = ccy; break; }

  const negative = /^\(.*\)$/.test(s) || /-\s*$/.test(s) || /^\s*-/.test(s);
  const digits = s.replace(/[^0-9.,]/g, "");
  if (!digits) return { amount: null, currency };

  const lastComma = digits.lastIndexOf(",");
  const lastDot = digits.lastIndexOf(".");
  let cleaned;
  if (lastComma === -1 && lastDot === -1) {
    cleaned = digits;
  } else if (lastComma > lastDot) {
    cleaned = digits.replace(/\./g, "").replace(",", ".");
  } else {
    cleaned = digits.replace(/,/g, "");
  }
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return { amount: null, currency };
  return { amount: Math.abs(n), currency, negative };
}

const MONTHS = {
  jan: 1, ene: 1, feb: 2, mar: 3, apr: 4, abr: 4, may: 5, jun: 6, jul: 7,
  aug: 8, ago: 8, sep: 9, set: 9, oct: 10, nov: 11, dec: 12, dic: 12,
};

const iso = (y, m, d) => {
  if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
  const yyyy = y < 100 ? 2000 + y : y;
  const dt = new Date(Date.UTC(yyyy, m - 1, d));
  // Rejects 31 Feb rather than letting JS roll it into March.
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${yyyy}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
};

// Returns { date } when the value is unambiguous, or { a, b } -- the two readings
// of a d/m vs m/d date -- so the caller can settle the whole file at once. A CSV
// is written by one system in one order; guessing per row is how 03/04 becomes
// March in one line and April in the next.
export function parseDateParts(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return {};

  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return { date: iso(+m[1], +m[2], +m[3]) };

  m = s.match(/^(\d{1,2})[\s-]*([a-zA-Z]{3,})[\s-]*(\d{2,4})$/);
  if (m) { const mo = MONTHS[norm(m[2]).slice(0, 3)]; return { date: mo ? iso(+m[3], mo, +m[1]) : null }; }

  m = s.match(/^([a-zA-Z]{3,})\s+(\d{1,2}),?\s*(\d{2,4})$/);
  if (m) { const mo = MONTHS[norm(m[1]).slice(0, 3)]; return { date: mo ? iso(+m[3], mo, +m[2]) : null }; }

  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m) {
    const [, p1, p2, y] = m;
    const monthFirst = iso(+y, +p1, +p2);
    const dayFirst = iso(+y, +p2, +p1);
    if (monthFirst && !dayFirst) return { date: monthFirst, order: "mdy" };
    if (dayFirst && !monthFirst) return { date: dayFirst, order: "dmy" };
    if (monthFirst && dayFirst && monthFirst === dayFirst) return { date: monthFirst };
    return { mdy: monthFirst, dmy: dayFirst };
  }
  return { date: null };
}

// Vendor names are the only reliable signal in a bank export, and a wrong
// category is easy to see and fix in the preview -- a wrong amount is not.
const CATEGORY_HINTS = [
  [/gohighlevel|highlevel|ghl/i, "platform"],
  [/cloudflare|namecheap|godaddy|vercel|aws|hosting|domain/i, "infrastructure"],
  [/anthropic|claude|openai|github|google workspace|zoom|canva|adobe|pricelabs|notion/i, "software"],
  [/whatsapp|twilio|altiu|claro|viva|t-?mobile|telecom|a2p/i, "telecom"],
  [/stripe|paypal|payment fee|comision|processing/i, "payment_fees"],
  [/meta|facebook ads|google ads|mailchimp|ads/i, "marketing"],
  [/upwork|arm accounting|accounting|legal|abogad|contador|consult/i, "contractors"],
  [/rent|alquiler|edesur|edeeste|electric|internet|utilit|agua|luz/i, "office"],
];

export function guessCategory(vendor, name) {
  const hay = `${vendor || ""} ${name || ""}`;
  for (const [re, cat] of CATEGORY_HINTS) if (re.test(hay)) return cat;
  return null;
}

const pickOption = (raw, allowed) => {
  const v = norm(raw);
  if (!v) return null;
  return allowed.find((o) => norm(o) === v) || null;
};

// ---- rows --------------------------------------------------------------------

const dupKey = (r) => `${norm(r.vendor || r.name)}|${Number(r.amount).toFixed(2)}|${r.paidOn || ""}`;

/**
 * Turns CSV text into draft rows. Pure: no GHL, no clock beyond what's passed in.
 * `existing` is the book's current expenses (normalized) so re-importing the same
 * statement twice is caught before it doubles a burn line -- the exact failure
 * that inflated fixed burn by $20/month once already.
 */
export function mapCsvRows(text, { existing = [], defaultCurrency = "USD" } = {}) {
  const table = parseCsv(text);
  if (!table.length) return { rows: [], error: "empty_csv" };

  const cols = mapHeader(table[0]);
  if (cols.amount === undefined) return { rows: [], error: "no_amount_column", header: table[0] };
  if (cols.name === undefined && cols.vendor === undefined) {
    return { rows: [], error: "no_name_or_vendor_column", header: table[0] };
  }

  const body = table.slice(1, MAX_ROWS + 1);
  const truncated = table.length - 1 > MAX_ROWS;
  const at = (row, key) => (cols[key] === undefined ? "" : (row[cols[key]] ?? "").trim());

  // Pass 1: parse everything, and let any unambiguous date settle the file's order.
  const parsed = body.map((row) => ({ row, date: parseDateParts(at(row, "paidOn")) }));
  const votes = parsed.reduce((acc, p) => {
    if (p.date.order) acc[p.date.order] = (acc[p.date.order] || 0) + 1;
    return acc;
  }, {});
  const fileOrder = (votes.dmy || 0) > (votes.mdy || 0) ? "dmy" : (votes.mdy ? "mdy" : null);

  const seenInFile = new Set();
  const existingKeys = new Set(
    existing.filter((e) => e.paidOn && e.amount).map((e) => dupKey({ vendor: e.vendor, name: e.name, amount: e.amount, paidOn: e.paidOn }))
  );

  const rows = parsed.map(({ row, date }, i) => {
    const issues = [];
    const vendor = at(row, "vendor") || null;
    const name = at(row, "name") || vendor;

    const { amount, currency: symbolCurrency, negative } = parseAmount(at(row, "amount"));
    if (amount === null) issues.push("no_amount");
    else if (amount === 0) issues.push("zero_amount");
    // A credit or refund in a statement -- real, but not an expense. Flagged, not dropped.
    if (negative) issues.push("negative_in_source");

    let paidOn = date.date ?? null;
    if (!paidOn && (date.mdy || date.dmy)) {
      if (fileOrder) paidOn = fileOrder === "dmy" ? date.dmy : date.mdy;
      else { paidOn = date.mdy; issues.push("ambiguous_date"); }
    }
    if (!paidOn) issues.push("no_date");

    const csvCategory = pickOption(at(row, "category"), CATEGORIES);
    const category = csvCategory || guessCategory(vendor, name) || "other";
    if (!csvCategory) issues.push(category === "other" ? "category_unknown" : "category_guessed");

    const csvCurrency = pickOption(at(row, "currency"), CURRENCIES);
    const currency = (csvCurrency || symbolCurrency || defaultCurrency).toLowerCase();

    const draft = {
      line: i + 2,                                  // the row number in the file, header included
      name: name || null,
      vendor,
      amount,
      currency,
      paidOn,
      category,
      recurrence: pickOption(at(row, "recurrence"), RECURRENCES) || "one_off",
      billingPeriod: at(row, "billingPeriod") || null,
      notes: at(row, "notes") || null,
    };
    if (!draft.name) issues.push("no_name");

    if (amount !== null && paidOn) {
      const k = dupKey(draft);
      if (existingKeys.has(k)) issues.push("duplicate_of_existing");
      else if (seenInFile.has(k)) issues.push("duplicate_in_file");
      seenInFile.add(k);
    }

    // Anything that can't be placed in time or money can't go in a P&L, so it is
    // held back by default. The reviewer can still tick it after fixing the row.
    const blocked = issues.some((x) => ["no_amount", "no_date", "no_name", "zero_amount"].includes(x));
    const flagged = issues.some((x) => x.startsWith("duplicate") || x === "negative_in_source");
    return { ...draft, issues, include: !blocked && !flagged, blocked };
  });

  return {
    rows,
    truncated,
    columns: cols,
    summary: {
      total: rows.length,
      ready: rows.filter((r) => r.include).length,
      needsReview: rows.filter((r) => !r.include).length,
      duplicates: rows.filter((r) => r.issues.some((x) => x.startsWith("duplicate"))).length,
    },
  };
}

// ---- writes ------------------------------------------------------------------

export function toRecordProperties(row, { source = "csv_import" } = {}) {
  const properties = {
    expense_name: row.name,
    amount: { value: Number(row.amount), currency: "default" },
    category: CATEGORIES.includes(row.category) ? row.category : "other",
    currency: CURRENCIES.includes(String(row.currency).toLowerCase()) ? String(row.currency).toLowerCase() : "usd",
    recurrence: RECURRENCES.includes(row.recurrence) ? row.recurrence : "one_off",
    source,
  };
  if (row.paidOn) properties.paid_on = row.paidOn;
  if (row.vendor) properties.vendor = row.vendor;
  if (row.billingPeriod) properties.billing_period = row.billingPeriod;
  if (row.notes) properties.notes = row.notes;
  return properties;
}

export async function loadExistingExpenses(pit, locationId) {
  const records = await fetchAllObjectRecords(pit, locationId, EXPENSE_OBJECT);
  return records.map(normalizeVendorExpense);
}

/** Creates one record per row. Sequential on purpose: GHL rate-limits object
 *  writes, and a half-imported statement is easier to finish than to unpick. */
export async function importRows(pit, locationId, rows, { source = "csv_import" } = {}) {
  const created = [];
  const failed = [];
  for (const row of rows) {
    if (!row?.name || row.amount === null || row.amount === undefined || !row.paidOn) {
      failed.push({ line: row?.line ?? null, name: row?.name ?? null, error: "name, amount and paidOn are required" });
      continue;
    }
    try {
      const record = await createObjectRecord(pit, locationId, EXPENSE_OBJECT, toRecordProperties(row, { source }));
      created.push({ line: row.line ?? null, id: record.id, name: row.name, amount: row.amount });
    } catch (err) {
      failed.push({ line: row.line ?? null, name: row.name, error: err.message || "create failed" });
    }
  }
  return { created, failed };
}
