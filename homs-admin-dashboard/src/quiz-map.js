// quiz-map.js -- the Onboarding Survey's answers -> account settings.
//
// The last missing link in automated onboarding. Everything either side of it
// already worked: the survey collects the answers, and /admin/provision-tenant
// builds the KV tenant record from Custom Values. This is the middle.
//
// THE FRAGILITY, stated first because it is the thing that will break:
// GHL identifies survey answers by opaque per-field ids, not by question text,
// and the API exposes no question labels at all (get-surveys returns id, name
// and locationId; the public survey page 403s). So this map was built by reading
// three real submissions and confirming each id with Yari on 2026-09-26.
//
// That means: EDITING OR CLONING THE SURVEY CHANGES THE IDS. A cloned survey in
// another account has entirely different ids and this map matches nothing. So
// nothing here is best-effort -- an id that is not recognised is REPORTED, and
// an expected setting with no answer is reported too. Silently mapping four of
// six fields and calling it done is how an account gets provisioned half
// configured, which is worse than not running at all.
//
// Source: survey 4d3ykgx6DqasTydvt5zn in HOMS (dytwzgmOP5v0Jh7gop4y).
// Submissions 6ab7ef56dd61828fd1588ff1, 6ab7f633dda16ec7f4d38cf0,
// 6ab7fc39dda16ec7f4d392f4 -- one per account-holder role.

const blank = (v) => v === null || v === undefined || String(v).trim() === "";
const firstOf = (v) => (Array.isArray(v) ? v[0] : v);
const text = (v) => (blank(firstOf(v)) ? null : String(firstOf(v)).trim());

// The survey asks the account holder only about the OTHER party, and it does so
// through TWO PARALLEL BRANCHES WITH COMPLETELY DIFFERENT FIELD IDS. A manager
// answers one set of questions about their owner; an owner answers a different
// set about their manager. Nothing in the payload marks which branch an answer
// came from -- only the role does.
//
// The branches are NOT mirror images, and the difference is the dangerous part:
//
//   manager branch asks "what share does the OWNER keep" -> 80 means owner 80%
//   owner branch   asks "what does your MANAGER charge"  -> 15 means owner 85%
//
// Both feed the same wowner_revenue_split. Reading the second with the first's
// polarity would provision an owner on 15% of their own rental income and look
// entirely plausible doing it. Confirmed with Yari 2026-09-26.
export const BRANCHES = {
  // Holder is the manager. They describe the owner.
  manager: {
    counterpartyName: "ot999AAZnO2FYCrOJ5du",
    counterpartyEmail: "nKnr8OaFXltScfaqzCZs",
    counterpartyPhone: "ywGS0udVz8wXO4gpUuTf",
    language: "wHSnykvGLEgHYaEVWviH",
    split: "21jhueq2p7pNB9n06Y56",
    splitIsOwnerShare: true,
    counterpartySlug: "wproperty_owner",
    holderSlug: "wmanager",
  },
  // Holder is the owner and has a manager. They describe the manager.
  owner: {
    counterpartyName: "DiUUoVQXYB2ICp5gyMDS",
    counterpartyPhone: "TP9vSWRPZcln5jidXqXs",
    language: "nGAANCuy0Gy7JHhgM7Ix",
    split: "LWpi09sPbE2c5CJKfUmk",
    splitIsOwnerShare: false, // the manager's cut -- invert it
    counterpartySlug: "wmanager",
    holderSlug: "wproperty_owner",
  },
};

// Asked of everyone, outside either branch.
export const COMMON_FIELDS = {
  organization: "wbrand_name",
  dCYsnLlIfJqTXDwSvu32: null, // account holder role; decides the branch
};

// Answers that belong to the rental calendars, which no API can create. Carried
// to the checklist rather than dropped -- the client answered them, so whoever
// builds the calendar by hand should see them. Confirmed calendar-specific by
// Yari 2026-09-26.
export const CALENDAR_FIELDS = {
  E7w0ab96j8ovFWWJUpNO: "Rental booking selector",
  "8cI4AeBOnrrmqBo6mT5u": "Service booking selector",
  bm1mV5GVTfxs8qF6nQlr: "Experience booking selector",
  kga7cOUMVnxNPJhAeSAR: "Calendar setting (minimum)",
  ijTLyUAIN8Z8iUPGDE1J: "Calendar setting (booking window)",
  "9epRyc7zD5EKvMn77bek": "Calendar setting",
  kOR25t9CC6eOpcDaojg5: "Calendar setting",
  CbfpMgFhbc5IuT8KbYJy: "Calendar setting",
  zX7BGlUTtwjPuJplq8Nc: "Calendar setting",
  bQlvozqUaDDo2DfGrP9m: "Calendar platform",
  MZKVDgjJbSAQujTeUlRv: "Calendar export link (.ics)",
  UHV9X55PYOMYFBBJghk9: "Calendar setting",       // manager branch
  dHYU1FXsj3a5uNxyfYC2: "Calendar setting",       // owner branch
};

// Captured for context, with no account setting of their own.
export const CONTEXT_FIELDS = {
  coJl5jBvIcf9qOrsE2OW: "Payment methods accepted",
  X9UzaCzBdegJH6Os01is: "Website access",
  ZzxUsjxxOuZQWjByk26R: "WhatsApp number",
  "1XZhh7q5tlrlV36UgsCd": "WhatsApp same as phone",     // manager branch
  CRdAIfdRI5VNcmqClQlm: "WhatsApp same as phone",       // owner branch
  "7JfmFI1djHiruNELyQT6": "Branch question (manager)",
  Op2aUsEnYCkkVggn8D1V: "Branch question (owner)",
  // The business-details branch, opened by answering yes to a registered business.
  AMDFCDpHhblNGnAiHnx1: "Registered business",
  h0UAbnJJPj6l8V4tIT33: "Tax ID on file",
  bpNePKduq1FQw0765wHC: "Tax ID document",
  "8NRzmmlRanL7h7PDPzR6": "Business email",
  website: "Website",
  ZtCaZ0VGjObwvPWAdi3W: "Website platform",
  cQYdrTqFa0ekByWHTUWI: "Booking site platform",
  phone: "Phone",
  email: "Email",
};

// GHL's own bookkeeping. Not answers, and reporting them as unmapped would bury
// the ids that actually matter.
const PLUMBING = new Set([
  "formId", "location_id", "contact_id", "eventData", "sessionFingerprint",
  "Timezone", "fieldsOriSequance", "submissionId", "signatureHash", "ip", "name",
]);

export function localeFrom(answer) {
  const s = String(answer ?? "").trim().toLowerCase();
  if (/^(spanish|espa)/.test(s)) return "es-ES";
  if (/^english/.test(s)) return "en-US";
  return null;
}

// Returns a number 1..99 or null. Anything outside that is refused rather than
// normalised -- 0, 100 and a stray-zero 800 are far likelier typos than intent,
// and this decides how every payout is divided.
export function splitPercent(answer) {
  if (blank(answer)) return null;
  const n = Number(String(answer).replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n) || n <= 0 || n >= 100) return null;
  return n;
}

// Three roles, and ALL THREE REAL ANSWERS CONTAIN A MANAGER WORD:
//
//   "Property Manager"     -> the holder is the manager
//   "Owner - Self Manage"  -> the holder is the owner, and their own manager
//   "Owner - Have Manager" -> the holder is the owner, with a separate manager
//
// So no amount of substring ordering works: an earlier version matched
// "manager" anywhere and read "Owner - Have Manager" as the manager, which
// swaps both names AND reads the split off the wrong branch with the wrong
// polarity. Two compounding errors from one word.
//
// The answers are distinguished by what they START with, which is the only part
// that actually identifies the holder.
export function roleFrom(answer) {
  const s = String(answer ?? "").trim().toLowerCase();
  if (/^owner/.test(s)) return /self[\s-]*manage/.test(s) ? "self" : "owner";
  if (/manager/.test(s)) return "manager";
  return null;
}

// The account holder's OWN name is not in the survey -- the conditional logic
// asks them only about the other party. It comes from the GHL contact instead.
const contactName = (contact) =>
  [contact?.firstName, contact?.lastName].filter(Boolean).join(" ").trim() ||
  (contact?.name ? String(contact.name).trim() : "") || null;

export function settingsFromQuiz(submission, contact = null) {
  const answers = submission?.others || {};
  const input = {};
  const filled = [];
  const problems = [];
  const calendarAnswers = {};
  const context = {};
  const unmapped = [];

  const take = (slug, value, from) => {
    if (blank(value)) return;
    input[slug] = String(value);
    filled.push({ slug, from });
  };

  const role = roleFrom(text(answers.dCYsnLlIfJqTXDwSvu32));
  const branch = role === "manager" || role === "owner" ? BRANCHES[role] : null;

  // Every id this run is allowed to consume, so anything else is genuinely
  // unrecognised rather than just belonging to the branch not taken.
  const branchIds = new Set(
    Object.values(BRANCHES).flatMap((b) =>
      [b.counterpartyName, b.counterpartyEmail, b.counterpartyPhone, b.language, b.split].filter(Boolean))
  );

  for (const [key, value] of Object.entries(answers)) {
    if (PLUMBING.has(key)) continue;
    if (CALENDAR_FIELDS[key]) { if (!blank(value)) calendarAnswers[CALENDAR_FIELDS[key]] = firstOf(value); continue; }
    if (CONTEXT_FIELDS[key]) { if (!blank(value)) context[CONTEXT_FIELDS[key]] = firstOf(value); continue; }
    if (key in COMMON_FIELDS || branchIds.has(key)) continue;
    // A question added to the survey since this map was written, or a different
    // survey entirely. Either way, somebody has to look.
    unmapped.push({ field: key, answer: firstOf(value) });
  }

  take("wbrand_name", text(answers.organization), "quiz");

  if (!role) {
    problems.push({
      field: "wproperty_owner/wmanager",
      answer: text(answers.dCYsnLlIfJqTXDwSvu32),
      reason: "account holder role not recognised, so neither name is written -- assigning them the wrong way round swaps the revenue split",
    });
  } else if (role === "self") {
    // One person on both sides. The survey asks for no counterparty, no
    // language and no split, because there is nothing to split.
    const holder = contactName(contact);
    take("wproperty_owner", holder, "contact");
    take("wmanager", holder, "contact");
    take("wowner_revenue_split", "100%", "self-manage");
  } else {
    take(branch.counterpartySlug, text(answers[branch.counterpartyName]), "quiz");
    take(branch.holderSlug, contactName(contact), "contact");

    const rawLanguage = text(answers[branch.language]);
    const locale = localeFrom(rawLanguage);
    if (locale) take("wlocale", locale, "quiz");
    else if (rawLanguage) {
      problems.push({ field: "wlocale", answer: rawLanguage, reason: "language not recognised" });
    }

    const rawSplit = text(answers[branch.split]);
    const pct = splitPercent(rawSplit);
    if (pct !== null) {
      // The owner branch reports the MANAGER's cut, so it is inverted to reach
      // the owner's share. Both branches write the same setting.
      const ownerShare = branch.splitIsOwnerShare ? pct : 100 - pct;
      take("wowner_revenue_split", `${ownerShare}%`, "quiz");
    } else if (rawSplit) {
      problems.push({
        field: "wowner_revenue_split",
        answer: rawSplit,
        reason: "not a usable percentage between 1 and 99",
      });
    }
  }

  return {
    input, filled, problems, calendarAnswers, context, unmapped,
    accountHolderRole: role,
    contactId: submission?.contactId ?? null,
    submissionId: submission?.id ?? null,
  };
}
