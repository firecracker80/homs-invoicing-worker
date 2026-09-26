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
// one real submission and confirming each id with Yari on 2026-09-26.
//
// That means: EDITING OR CLONING THE SURVEY CHANGES THE IDS. A cloned survey in
// another account has entirely different ids and this map matches nothing. So
// nothing here is best-effort -- an id that is not recognised is REPORTED, and
// an expected setting with no answer is reported too. Silently mapping four of
// six fields and calling it done is how an account gets provisioned half
// configured, which is worse than not running at all.
//
// Source: survey 4d3ykgx6DqasTydvt5zn in HOMS (dytwzgmOP5v0Jh7gop4y),
// submission 6ab7ef56dd61828fd1588ff1.

const blank = (v) => v === null || v === undefined || String(v).trim() === "";
const first = (v) => (Array.isArray(v) ? v[0] : v);
const text = (v) => (blank(first(v)) ? null : String(first(v)).trim());

// Answers that become account settings.
export const QUIZ_FIELDS = {
  organization: { meaning: "brand_name", slug: "wbrand_name" },
  wHSnykvGLEgHYaEVWviH: { meaning: "language", slug: "wlocale" },
  "21jhueq2p7pNB9n06Y56": { meaning: "owner_revenue_split", slug: "wowner_revenue_split" },
  // Decides which side the counterparty name belongs to. Not a setting itself.
  dCYsnLlIfJqTXDwSvu32: { meaning: "account_holder_role", slug: null },
  // The OTHER party. The survey has conditional logic: an owner fills in the
  // manager's details and a manager fills in the owner's, so which slug this
  // lands in depends on the role above.
  ot999AAZnO2FYCrOJ5du: { meaning: "counterparty_name", slug: null },
  nKnr8OaFXltScfaqzCZs: { meaning: "counterparty_email", slug: null },
  ywGS0udVz8wXO4gpUuTf: { meaning: "counterparty_phone", slug: null },
};

// Answers that are real but belong to the rental calendars, which no API can
// create. They are carried to the checklist rather than dropped -- the client
// answered them, so somebody should see them while building the calendar by
// hand. Confirmed calendar-specific by Yari 2026-09-26.
export const CALENDAR_FIELDS = {
  E7w0ab96j8ovFWWJUpNO: "Rental booking selector",
  "8cI4AeBOnrrmqBo6mT5u": "Service booking selector",
  bm1mV5GVTfxs8qF6nQlr: "Experience booking selector",
  kga7cOUMVnxNPJhAeSAR: "Calendar setting (3)",
  ijTLyUAIN8Z8iUPGDE1J: "Calendar setting (90)",
  "9epRyc7zD5EKvMn77bek": "Calendar setting (4)",
  kOR25t9CC6eOpcDaojg5: "Calendar setting (4)",
  CbfpMgFhbc5IuT8KbYJy: "Calendar setting (1)",
  zX7BGlUTtwjPuJplq8Nc: "Calendar setting (90)",
  bQlvozqUaDDo2DfGrP9m: "Calendar platform",
  MZKVDgjJbSAQujTeUlRv: "Calendar export link (.ics)",
  UHV9X55PYOMYFBBJghk9: "Calendar setting",
  AMDFCDpHhblNGnAiHnx1: "Calendar setting",
};

// Answers captured for context but with no account setting of their own.
export const CONTEXT_FIELDS = {
  coJl5jBvIcf9qOrsE2OW: "Payment methods accepted",
  X9UzaCzBdegJH6Os01is: "Website",
  ZzxUsjxxOuZQWjByk26R: "WhatsApp number",
  "1XZhh7q5tlrlV36UgsCd": "WhatsApp same as phone",
  phone: "Phone",
  email: "Email",
};

// GHL adds its own bookkeeping to every submission. Not answers, and reporting
// them as unmapped would bury the ids that actually matter.
const PLUMBING = new Set([
  "formId", "location_id", "eventData", "sessionFingerprint", "Timezone",
  "fieldsOriSequance", "submissionId", "signatureHash", "ip", "name",
]);

export function localeFrom(answer) {
  const s = String(answer ?? "").trim().toLowerCase();
  if (/^(spanish|espa)/.test(s)) return "es-ES";
  if (/^english/.test(s)) return "en-US";
  return null;
}

// "80" and "80%" both mean 80%. Anything outside 1..99 is refused rather than
// normalised -- a split of 0 or 100 is far more likely a typo than an intent,
// and it decides how every payout is divided.
export function splitFrom(answer) {
  if (blank(answer)) return null;
  const n = Number(String(answer).replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n) || n <= 0 || n >= 100) return null;
  return `${n}%`;
}

export function roleFrom(answer) {
  const s = String(answer ?? "").trim().toLowerCase();
  if (s.includes("manager")) return "manager";
  if (s.includes("owner")) return "owner";
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

  for (const [key, value] of Object.entries(answers)) {
    if (PLUMBING.has(key)) continue;
    if (CALENDAR_FIELDS[key]) { if (!blank(value)) calendarAnswers[CALENDAR_FIELDS[key]] = first(value); continue; }
    if (CONTEXT_FIELDS[key]) { if (!blank(value)) context[CONTEXT_FIELDS[key]] = first(value); continue; }
    if (!QUIZ_FIELDS[key]) {
      // A question added to the survey since this map was written, or a
      // different survey entirely. Either way, somebody has to look.
      unmapped.push({ field: key, answer: first(value) });
    }
  }

  take("wbrand_name", text(answers.organization), "quiz");

  const locale = localeFrom(text(answers.wHSnykvGLEgHYaEVWviH));
  if (locale) take("wlocale", locale, "quiz");
  else if (!blank(answers.wHSnykvGLEgHYaEVWviH)) {
    problems.push({ field: "wlocale", answer: text(answers.wHSnykvGLEgHYaEVWviH), reason: "language not recognised" });
  }

  const split = splitFrom(text(answers["21jhueq2p7pNB9n06Y56"]));
  if (split) take("wowner_revenue_split", split, "quiz");
  else if (!blank(answers["21jhueq2p7pNB9n06Y56"])) {
    problems.push({
      field: "wowner_revenue_split",
      answer: text(answers["21jhueq2p7pNB9n06Y56"]),
      reason: "not a usable percentage between 1 and 99",
    });
  }

  // The conditional logic. Getting this backwards swaps who receives 80% of
  // every booking, so an unrecognised role writes neither name.
  const role = roleFrom(text(answers.dCYsnLlIfJqTXDwSvu32));
  const counterparty = text(answers.ot999AAZnO2FYCrOJ5du);
  const holder = contactName(contact);

  if (!role) {
    problems.push({
      field: "wproperty_owner/wmanager",
      answer: text(answers.dCYsnLlIfJqTXDwSvu32),
      reason: "account holder role not recognised, so neither name is written -- assigning them the wrong way round swaps the revenue split",
    });
  } else if (role === "manager") {
    take("wproperty_owner", counterparty, "quiz");
    take("wmanager", holder, "contact");
  } else {
    take("wmanager", counterparty, "quiz");
    take("wproperty_owner", holder, "contact");
  }

  return {
    input, filled, problems, calendarAnswers, context, unmapped,
    accountHolderRole: role,
    contactId: submission?.contactId ?? null,
    submissionId: submission?.id ?? null,
  };
}
