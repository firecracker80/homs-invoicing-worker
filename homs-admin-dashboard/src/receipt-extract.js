// receipt-extract.js -- reading a receipt photo or PDF into draft expense rows.
//
// The CSV path (expenses-import.js) covers anything that arrives as a table.
// This covers what doesn't: a photo of a paper receipt, or a PDF whose amount
// lives only in the attachment -- FableForge's REC10076.pdf is the case that
// proved parsing the email body alone was never going to be enough.
//
// It produces exactly the same draft rows as the CSV path and goes through the
// same import endpoint, so the review step, the duplicate check and the
// hold-back rules are identical. Only the reading differs.
//
// Raw fetch rather than the Anthropic SDK: this Worker has no dependencies at
// all (GHL is raw fetch too), and adding node_modules to the Cloudflare build
// for one call would put every deploy at risk of an install failure.

import { CATEGORIES, CURRENCIES, RECURRENCES, decideInclude, dupKeyOf, keysOf } from "./expenses-import.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-opus-5";

export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
export const FILE_TYPES = [...IMAGE_TYPES, "application/pdf"];
// Anthropic accepts far more; this is a sanity bound on what a phone photo or a
// vendor PDF should ever be, and base64 inflates it by a third on the way out.
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

const SCHEMA = {
  type: "object",
  properties: {
    is_expense_document: {
      type: "boolean",
      description: "True only if this is a receipt, invoice, bill or payment confirmation. False for anything else.",
    },
    document_note: {
      type: ["string", "null"],
      description: "If it is not an expense document, one short sentence saying what it appears to be.",
    },
    expenses: {
      type: "array",
      description: "One entry per distinct charge. A single receipt yields one; a statement or multi-page PDF may yield several.",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "What was bought, in a few words. Never the vendor name alone." },
          vendor: { type: ["string", "null"], description: "Who was paid, as printed." },
          amount: { type: ["number", "null"], description: "The total actually charged, after tax and tip. Null if not legible." },
          currency: { type: ["string", "null"], enum: [...CURRENCIES, null], description: "usd or dop. Null if not stated." },
          paid_on: { type: ["string", "null"], description: "Date of the charge as YYYY-MM-DD. Null if not legible." },
          category: { type: "string", enum: CATEGORIES },
          recurrence: { type: "string", enum: RECURRENCES, description: "monthly or annual only when the document itself says so (a subscription period, 'renews', 'monthly plan')." },
          billing_period: { type: ["string", "null"], description: "The period the charge covers, e.g. 2026-09, if stated." },
          notes: { type: ["string", "null"], description: "Anything a human would need to place this charge. Null if nothing." },
          confidence: { type: "string", enum: ["high", "medium", "low"], description: "low if the amount or date had to be guessed at all." },
        },
        required: ["name", "vendor", "amount", "currency", "paid_on", "category", "recurrence", "billing_period", "notes", "confidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["is_expense_document", "document_note", "expenses"],
  additionalProperties: false,
};

// Naming the book's own categories matters more than any general instruction:
// without them every cloud bill lands in "software" and the P&L stops separating
// the platform spend that is the whole point of tracking it.
const PROMPT = `Read this document and record the business expenses on it.

It belongs to a small software and consulting business in the Dominican Republic. Documents arrive in Spanish and English, and amounts in Dominican pesos (RD$, DOP) or US dollars (US$, USD).

Rules:
- Record the amount actually charged: the total after tax, tip and discounts. Not a subtotal, not a balance, not an amount due later.
- Dates: use the date of the charge, formatted YYYY-MM-DD. Dominican documents usually write day first (25/09/2026 is 25 September). If the year is missing or the date is unreadable, use null -- never guess a date.
- If a figure is not legible, use null rather than a best guess, and set confidence to "low".
- Categories: platform (GoHighLevel and its usage), infrastructure (hosting, domains, Cloudflare), software (other subscriptions), telecom (phone, WhatsApp, A2P), office (rent, internet, utilities), contractors (professional services, accounting, legal), marketing (ads), payment_fees (processing fees), other.
- recurrence is one_off unless the document itself states a subscription or billing period.
- A refund or credit note is not an expense: leave it out and say so in document_note.
- If this is not a receipt, invoice, bill or payment confirmation, set is_expense_document to false and return an empty expenses array.`;

/** The content blocks for one file. Images and PDFs take different block types. */
export function contentBlocksFor({ mediaType, data }) {
  const block = mediaType === "application/pdf"
    ? { type: "document", source: { type: "base64", media_type: mediaType, data } }
    : { type: "image", source: { type: "base64", media_type: mediaType, data } };
  // The file goes first: the model reads better when the document precedes the ask.
  return [block, { type: "text", text: PROMPT }];
}

export function requestBodyFor(file, model = DEFAULT_MODEL) {
  return {
    model,
    max_tokens: 8000,
    // Extraction, not reasoning. Low effort keeps the cost near a cent a receipt.
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content: contentBlocksFor(file) }],
  };
}

export class ExtractError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

/** Calls Claude and returns the parsed object. No GHL, no KV -- testable alone. */
export async function extractFromFile(apiKey, file, { model = DEFAULT_MODEL } = {}) {
  if (!apiKey) throw new ExtractError("Reading receipts is not configured: the ANTHROPIC_API_KEY secret is not set on this Worker.", 503);
  if (!FILE_TYPES.includes(file.mediaType)) throw new ExtractError(`Unsupported file type ${file.mediaType}. Use a JPEG, PNG, GIF, WebP or PDF.`, 400);
  if (!file.data) throw new ExtractError("Empty file", 400);

  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": API_VERSION },
    body: JSON.stringify(requestBodyFor(file, model)),
  });
  const text = await res.text();
  if (!res.ok) {
    // The key itself is never echoed back to the browser, only what went wrong.
    let detail = text.slice(0, 300);
    try { detail = JSON.parse(text).error?.message || detail; } catch {}
    throw new ExtractError(`Could not read the file (${res.status}): ${detail}`, res.status === 401 || res.status === 403 ? 503 : 502);
  }

  const body = JSON.parse(text);
  if (body.stop_reason === "refusal") throw new ExtractError("The file could not be read.", 422);
  // Thinking blocks come first when adaptive thinking runs; the JSON is the text block.
  const out = (body.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  if (!out.trim()) throw new ExtractError("Nothing was read from the file.", 502);
  try {
    return { ...JSON.parse(out), usage: body.usage || null };
  } catch {
    throw new ExtractError("The file was read but the result could not be understood.", 502);
  }
}

const clean = (v) => {
  const s = typeof v === "string" ? v.trim() : v;
  return s === "" || s === undefined ? null : s;
};

/**
 * Turns an extraction into the same draft rows the CSV path produces, so both
 * go through one review step and one import endpoint. `line` is the entry's
 * position in the file, which is what the reviewer sees when a row fails.
 */
export function rowsFromExtraction(extracted, { filename = "", existing = [], defaultCurrency = "USD" } = {}) {
  const source = filename ? `Read from ${filename}` : "Read from an uploaded file";

  if (!extracted?.is_expense_document || !Array.isArray(extracted.expenses) || extracted.expenses.length === 0) {
    const why = clean(extracted?.document_note) || "This does not look like a receipt, invoice or bill.";
    return {
      rows: [],
      error: "not_an_expense_document",
      message: why,
      summary: { total: 0, ready: 0, needsReview: 0, duplicates: 0 },
    };
  }

  const existingKeys = keysOf(existing);
  const seen = new Set();

  const rows = extracted.expenses.map((e, i) => {
    const issues = [];
    const amount = Number.isFinite(Number(e.amount)) && e.amount !== null ? Math.abs(Number(e.amount)) : null;
    const name = clean(e.name);
    const paidOn = /^\d{4}-\d{2}-\d{2}$/.test(String(e.paid_on ?? "")) ? e.paid_on : null;

    if (amount === null) issues.push("no_amount");
    else if (amount === 0) issues.push("zero_amount");
    if (!paidOn) issues.push("no_date");
    if (!name) issues.push("no_name");
    // "Read it back before you trust it" -- a low-confidence read is exactly the
    // row that must not slip into the book unlooked at.
    if (e.confidence === "low") issues.push("low_confidence");

    const draft = {
      line: i + 1,
      name,
      vendor: clean(e.vendor),
      amount,
      currency: (CURRENCIES.includes(String(e.currency).toLowerCase()) ? String(e.currency) : defaultCurrency).toLowerCase(),
      paidOn,
      category: CATEGORIES.includes(e.category) ? e.category : "other",
      recurrence: RECURRENCES.includes(e.recurrence) ? e.recurrence : "one_off",
      billingPeriod: clean(e.billing_period),
      notes: [clean(e.notes), source].filter(Boolean).join(" · "),
      confidence: e.confidence || null,
    };

    if (amount !== null && paidOn) {
      const k = dupKeyOf(draft);
      if (existingKeys.has(k)) issues.push("duplicate_of_existing");
      else if (seen.has(k)) issues.push("duplicate_in_file");
      seen.add(k);
    }

    return { ...draft, issues, ...decideInclude(issues) };
  });

  return {
    rows,
    summary: {
      total: rows.length,
      ready: rows.filter((r) => r.include).length,
      needsReview: rows.filter((r) => !r.include).length,
      duplicates: rows.filter((r) => r.issues.some((x) => x.startsWith("duplicate"))).length,
    },
  };
}
