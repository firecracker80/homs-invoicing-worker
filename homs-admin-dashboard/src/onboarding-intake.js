// onboarding-intake.js -- stage 1 of automated onboarding.
//
// The client is emailed the portfolio workbook and told to REPLY with it filled
// in. This picks that reply up, reads the workbook, cross-checks it against the
// quiz answers, and parks the result for review. It writes nothing anywhere.
//
// Why email and not a form upload: decided 2026-09-25. A reply keeps the
// workbook on the contact's own conversation, so there is nothing to match up
// by hand later.
//
// The shape this relies on, confirmed against the live HOMS account 2026-09-25:
//   GET /conversations/messages/export?channel=Email&contactId=...
//   -> { messages: [{ id, direction, messageType, files: [url], threadId,
//                     subject, dateAdded, contactId, conversationId }] }
// `files` is an array of direct URLs, not attachment ids, so the workbook can be
// fetched straight from it.
//
// TWO TRAPS, both load-bearing:
//   1. HOMS sends the BLANK workbook on the same thread. Picking the newest
//      message with an .xlsx would find the template we sent, parse it, and
//      report the client filled in nothing. Only `direction === "inbound"`
//      counts.
//   2. A client may reply more than once, correcting the first attempt. The
//      newest inbound one wins, and the earlier ones are reported rather than
//      silently dropped, so nobody imports a superseded workbook.

const BASE = "https://services.leadconnectorhq.com";
const VERSION = "2021-07-28";

// GHL rejects a limit under 10 on this endpoint (422 "limit must not be less
// than 10"), so it is a floor, not a preference.
const MIN_EXPORT_LIMIT = 10;

export const MAX_WORKBOOK_BYTES = 10 * 1024 * 1024;

const isWorkbookUrl = (u) => /\.xlsx?(?:$|[?#])/i.test(String(u ?? ""));

// ---------------------------------------------------------------- reading --

export async function listContactEmails(pit, contactId, { limit = 20 } = {}) {
  const params = new URLSearchParams({
    channel: "Email",
    contactId,
    limit: String(Math.max(limit, MIN_EXPORT_LIMIT)),
  });
  const res = await fetch(`${BASE}/conversations/messages/export?${params}`, {
    headers: { Authorization: `Bearer ${pit}`, Version: VERSION, Accept: "application/json" },
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(json.message || `Could not read this contact's email (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return Array.isArray(json.messages) ? json.messages : [];
}

// Newest inbound email carrying a workbook. Returns the pick plus anything it
// passed over, so the reviewer can see there were earlier attempts.
export function findWorkbookReply(messages) {
  const candidates = (messages || [])
    .filter((m) => m?.direction === "inbound")
    .map((m) => ({ message: m, url: (m.files || []).find(isWorkbookUrl) }))
    .filter((c) => c.url)
    .sort((a, b) => Date.parse(b.message.dateAdded ?? 0) - Date.parse(a.message.dateAdded ?? 0));

  if (!candidates.length) {
    const inboundAny = (messages || []).some((m) => m?.direction === "inbound");
    return {
      found: null,
      superseded: [],
      // These two cases look identical on a dashboard and need different
      // actions: chase the client, or go and look at what they actually sent.
      reason: inboundAny ? "replied_without_workbook" : "no_reply_yet",
    };
  }

  const [newest, ...rest] = candidates;
  return {
    found: {
      url: newest.url,
      messageId: newest.message.id,
      threadId: newest.message.threadId ?? null,
      conversationId: newest.message.conversationId ?? null,
      subject: newest.message.subject ?? "",
      receivedAt: newest.message.dateAdded ?? null,
    },
    superseded: rest.map((c) => ({ messageId: c.message.id, receivedAt: c.message.dateAdded ?? null })),
    reason: null,
  };
}

// GHL serves some attachment URLs publicly and others only to an authorised
// caller. Try it clean first so a public URL never carries the PIT, then fall
// back. Anything else is a real failure and is reported as one.
export async function downloadWorkbook(url, pit, { maxBytes = MAX_WORKBOOK_BYTES } = {}) {
  let res = await fetch(url);
  if (res.status === 401 || res.status === 403) {
    res = await fetch(url, { headers: { Authorization: `Bearer ${pit}`, Version: VERSION } });
  }
  if (!res.ok) {
    const err = new Error(`Could not download the workbook (${res.status})`);
    err.status = res.status;
    throw err;
  }

  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    const err = new Error("That workbook is too large (10 MB max)");
    err.status = 413;
    throw err;
  }
  const buffer = await res.arrayBuffer();
  // Content-length is advisory; a chunked response has none, so check for real.
  if (buffer.byteLength > maxBytes) {
    const err = new Error("That workbook is too large (10 MB max)");
    err.status = 413;
    throw err;
  }
  return buffer;
}

// ------------------------------------------------------------ cross-check --
//
// The quiz and the workbook both carry some of the same facts, and the client
// fills them in days apart. Where they disagree, somebody has to choose -- this
// never picks for them. Provisioning on a currency the client contradicted a
// week later is the failure this exists to prevent.
//
// Each entry says where the same fact lives on both sides. The quiz keys are
// filled in once the survey has a real submission to read them from: it has
// none yet, so a quiz key left null means "not wired", which is reported as
// such and is NOT the same as "the client did not answer".

export const CROSS_CHECKS = [
  {
    field: "currency",
    label: "Currency",
    quizKey: null,
    fromPortfolio: (p) => p.accountSettings?.currency ?? null,
  },
  {
    field: "cancellationPolicy",
    label: "Cancellation policy",
    quizKey: null,
    fromPortfolio: (p) => p.accountSettings?.cancellationPolicyLabel ?? null,
  },
  {
    field: "propertyCount",
    label: "Number of properties",
    quizKey: null,
    fromPortfolio: (p) => (Array.isArray(p.rows) ? p.rows.filter((r) => !r.blocked).length : null),
    // "8" and 8 are the same answer to "how many properties".
    normalise: (v) => (v === null || v === "" ? null : Number(v)),
  },
];

const sameAnswer = (a, b) => {
  if (a === null || b === null) return true;         // nothing to disagree about
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
};

export function crossCheck(quiz, portfolio) {
  const answers = quiz || {};
  const conflicts = [];
  const unwired = [];
  const checked = [];

  for (const check of CROSS_CHECKS) {
    if (!check.quizKey) { unwired.push(check.field); continue; }
    const norm = check.normalise || ((v) => (v === "" || v === undefined ? null : v));
    const fromQuiz = norm(answers[check.quizKey] ?? null);
    const fromWorkbook = norm(check.fromPortfolio(portfolio) ?? null);

    checked.push({ field: check.field, fromQuiz, fromWorkbook });
    if (!sameAnswer(fromQuiz, fromWorkbook)) {
      conflicts.push({
        field: check.field, label: check.label, fromQuiz, fromWorkbook,
        note: `The quiz says ${fromQuiz}, the workbook says ${fromWorkbook}. Ask the client which is right -- neither is assumed.`,
      });
    }
  }

  // An answer nobody reads is worse than a missing one: it looks captured.
  const known = new Set(CROSS_CHECKS.map((c) => c.quizKey).filter(Boolean));
  const unreadQuizAnswers = Object.keys(answers).filter((k) => !known.has(k));

  return { conflicts, checked, unwired, unreadQuizAnswers };
}

// ------------------------------------------------------------- the record --
//
// Keyed by the HOMS contact, because that is the only id that exists at this
// point -- the client's sub-account has not been created yet.

export const intakeKey = (contactId) => `onboarding:${contactId}`;

// The quiz is submitted FIRST, the workbook comes back days later (Yari,
// 2026-09-26). So the workbook must MERGE into whatever is already on record,
// never replace it -- an earlier version rebuilt the record from scratch on
// every workbook arrival, which silently discarded the quiz answers and with
// them the brand name, locale, revenue split and both party names.
//
// Explicit field list rather than a blind spread: a merge that keeps unknown
// keys forever accumulates the debris of every past shape, and one that
// overwrites with undefined is the bug this exists to prevent.
const PRESERVED = ["quiz", "quizContact", "quizAt", "quizSubmissionId"];

export function mergeIntake(existing, patch) {
  const base = existing && typeof existing === "object" ? existing : {};
  const merged = { ...base, ...patch };
  for (const key of PRESERVED) {
    // A patch may legitimately update these; it may never blank them by omission.
    if (patch[key] === undefined && base[key] !== undefined) merged[key] = base[key];
  }
  return merged;
}

// Survey submissions are fetched from GHL rather than posted in by a workflow.
// A Custom Webhook would need every answer mapped by hand into its body, and a
// mapping that silently resolves to nothing is the single most common failure
// in this system -- it has cost days this week alone. Reading the submission
// back makes GHL the source of truth and removes the mapping entirely.
export async function fetchLatestSubmission(pit, surveyId, contactId, { limit = 50 } = {}) {
  const params = new URLSearchParams({ surveyId, limit: String(limit) });
  const res = await fetch(`${BASE}/surveys/submissions?${params}`, {
    headers: { Authorization: `Bearer ${pit}`, Version: VERSION, Accept: "application/json" },
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
  if (!res.ok) {
    const err = new Error(json.message || `Could not read survey submissions (${res.status})`);
    err.status = res.status;
    throw err;
  }
  const mine = (json.submissions || []).filter((sub) => sub.contactId === contactId);
  if (!mine.length) return null;
  // Newest wins: a client who fills the survey twice meant the second one.
  mine.sort((a, b) => Date.parse(b.createdAt ?? 0) - Date.parse(a.createdAt ?? 0));
  return mine[0];
}

export async function saveIntake(kv, contactId, record) {
  await kv.put(intakeKey(contactId), JSON.stringify(record));
  return record;
}

export async function loadIntake(kv, contactId) {
  return kv.get(intakeKey(contactId), { type: "json" });
}
