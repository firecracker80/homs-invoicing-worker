// Tests for the Onboarding Survey -> account settings map.
// Run: node test-quiz-map.mjs
//
// The main fixture is the REAL first submission, copied verbatim from
// get-surveys-submissions on 2026-09-26 (survey 4d3ykgx6DqasTydvt5zn,
// submission 6ab7ef56dd61828fd1588ff1). A fabricated one would have agreed with
// whatever the map happened to do; this one is the actual shape GHL sends,
// including its plumbing keys and its array-wrapped answers.
import assert from "node:assert";

const {
  settingsFromQuiz, localeFrom, splitFrom, roleFrom,
  QUIZ_FIELDS, CALENDAR_FIELDS,
} = await import("./src/quiz-map.js");

// Rogelio's submission, verbatim. Trimmed only of signatureHash and eventData,
// which are plumbing and megabytes of it.
const REAL = {
  id: "6ab7ef56dd61828fd1588ff1",
  contactId: "zGGIiZhwBNWnrVJPNFwi",
  surveyId: "4d3ykgx6DqasTydvt5zn",
  others: {
    organization: "YV Guest Properties",
    dCYsnLlIfJqTXDwSvu32: "Property Manager",
    phone: "+18293679364",
    ot999AAZnO2FYCrOJ5du: "Rogelio Santana",
    nKnr8OaFXltScfaqzCZs: "rogeliojunorl@gmail.com",
    ywGS0udVz8wXO4gpUuTf: "8298779475",
    "1XZhh7q5tlrlV36UgsCd": "Same above",
    wHSnykvGLEgHYaEVWviH: "Spanish",
    "21jhueq2p7pNB9n06Y56": "80",
    UHV9X55PYOMYFBBJghk9: ["User"],
    coJl5jBvIcf9qOrsE2OW: ["PayPal", "Stripe", "Manual/Transfer"],
    AMDFCDpHhblNGnAiHnx1: "No",
    X9UzaCzBdegJH6Os01is: "I do not have a website",
    email: "yari@yvelazquez.com",
    ZzxUsjxxOuZQWjByk26R: "8293679364",
    E7w0ab96j8ovFWWJUpNO: "Date selector ONLY",
    "8cI4AeBOnrrmqBo6mT5u": "Date & Time",
    bm1mV5GVTfxs8qF6nQlr: "Date & Time",
    kga7cOUMVnxNPJhAeSAR: "3",
    ijTLyUAIN8Z8iUPGDE1J: "90",
    "9epRyc7zD5EKvMn77bek": "4",
    kOR25t9CC6eOpcDaojg5: "4",
    CbfpMgFhbc5IuT8KbYJy: "1",
    zX7BGlUTtwjPuJplq8Nc: "90",
    bQlvozqUaDDo2DfGrP9m: "Airbnb",
    MZKVDgjJbSAQujTeUlRv: "https://www.airbnb.com/calendar/ical/1485761253199489437.ics?t=987535097f9e479089f0f7b57c4f6796",
    formId: "4d3ykgx6DqasTydvt5zn",
    location_id: "dytwzgmOP5v0Jh7gop4y",
    Timezone: "America/New_York (GMT-04:00)",
    fieldsOriSequance: ["organization", "dCYsnLlIfJqTXDwSvu32", "header"],
    submissionId: "32e73d06-043d-4383-bef6-bb3db20352cb",
    ip: "2001:1308:28c9:e900::",
  },
  createdAt: "2026-09-26T16:14:14.721Z",
};

const CONTACT = { firstName: "Yari", lastName: "Velazquez" };

// ---- 1. the real submission maps ------------------------------------------
{
  const out = settingsFromQuiz(REAL, CONTACT);
  assert.strictEqual(out.input.wbrand_name, "YV Guest Properties");
  assert.strictEqual(out.input.wlocale, "es-ES", "Spanish means es-ES, the first three clients are Dominican");
  assert.strictEqual(out.input.wowner_revenue_split, "80%");
  assert.deepStrictEqual(out.problems, [], "the real submission should raise nothing");
  console.log("1) The real first submission maps cleanly");
}

// ---- 2. the conditional logic, which decides who gets paid ----------------
// The holder answers about the OTHER party, so a manager names the owner. Get
// this backwards and 80% of every booking goes to the wrong person.
{
  const asManager = settingsFromQuiz(REAL, CONTACT);
  assert.strictEqual(asManager.accountHolderRole, "manager");
  assert.strictEqual(asManager.input.wproperty_owner, "Rogelio Santana", "the counterparty is the owner");
  assert.strictEqual(asManager.input.wmanager, "Yari Velazquez", "and the holder is the manager, from the contact");

  const asOwner = settingsFromQuiz(
    { ...REAL, others: { ...REAL.others, dCYsnLlIfJqTXDwSvu32: "Property Owner" } }, CONTACT);
  assert.strictEqual(asOwner.accountHolderRole, "owner");
  assert.strictEqual(asOwner.input.wmanager, "Rogelio Santana", "an owner names the manager");
  assert.strictEqual(asOwner.input.wproperty_owner, "Yari Velazquez");
  console.log("2) Conditional logic assigns owner and manager by the holder's role, both directions");
}

// ---- 3. an unrecognised role writes NEITHER name -------------------------
{
  const out = settingsFromQuiz(
    { ...REAL, others: { ...REAL.others, dCYsnLlIfJqTXDwSvu32: "Co-host" } }, CONTACT);
  assert.strictEqual(out.accountHolderRole, null);
  assert.strictEqual(out.input.wproperty_owner, undefined);
  assert.strictEqual(out.input.wmanager, undefined);
  const p = out.problems.find((x) => x.field === "wproperty_owner/wmanager");
  assert.ok(p, "and it says so");
  assert.match(p.reason, /swaps the revenue split/);
  console.log("3) A role nobody anticipated writes neither name rather than guessing a side");
}

// ---- 4. the revenue split refuses anything unusable ---------------------
{
  assert.strictEqual(splitFrom("80"), "80%");
  assert.strictEqual(splitFrom("80%"), "80%");
  assert.strictEqual(splitFrom("85.5"), "85.5%");
  assert.strictEqual(splitFrom(""), null);
  assert.strictEqual(splitFrom("most of it"), null, "prose is not a split");
  assert.strictEqual(splitFrom("0"), null, "0 is a typo, not an intent");
  assert.strictEqual(splitFrom("100"), null, "so is 100");
  assert.strictEqual(splitFrom("800"), null, "and a stray zero must not become 800%");

  const out = settingsFromQuiz(
    { ...REAL, others: { ...REAL.others, "21jhueq2p7pNB9n06Y56": "800" } }, CONTACT);
  assert.strictEqual(out.input.wowner_revenue_split, undefined);
  assert.ok(out.problems.some((p) => p.field === "wowner_revenue_split"));
  console.log("4) An unusable revenue split is refused and reported, never normalised");
}

// ---- 5. language ---------------------------------------------------------
{
  assert.strictEqual(localeFrom("Spanish"), "es-ES");
  assert.strictEqual(localeFrom("español"), "es-ES");
  assert.strictEqual(localeFrom("English"), "en-US");
  assert.strictEqual(localeFrom("French"), null);
  assert.strictEqual(localeFrom(""), null);

  const out = settingsFromQuiz(
    { ...REAL, others: { ...REAL.others, wHSnykvGLEgHYaEVWviH: "French" } }, CONTACT);
  assert.strictEqual(out.input.wlocale, undefined);
  assert.ok(out.problems.some((p) => p.field === "wlocale"));
  console.log("5) An unsupported language is reported rather than defaulted to English");
}

// ---- 6. calendar answers are carried, not discarded --------------------
// They cannot be written anywhere -- no API creates a rental calendar -- but the
// client answered them, so whoever builds the calendar by hand should see them.
{
  const out = settingsFromQuiz(REAL, CONTACT);
  assert.strictEqual(out.calendarAnswers["Calendar platform"], "Airbnb");
  assert.match(out.calendarAnswers["Calendar export link (.ics)"], /airbnb\.com\/calendar\/ical/);
  assert.strictEqual(out.calendarAnswers["Rental booking selector"], "Date selector ONLY");
  // And none of them leaked into account settings.
  for (const label of Object.values(CALENDAR_FIELDS)) {
    assert.ok(!Object.values(out.input).includes(label), label + " must not become a setting");
  }
  assert.strictEqual(Object.keys(out.input).length, 5,
    "exactly brand, locale, split, owner, manager -- nothing else");
  console.log("6) Calendar answers reach the checklist and never the account settings");
}

// ---- 7. an answer the map does not know about is reported -------------
// The ids are per-survey. Editing or cloning the survey changes them, and the
// symptom of that is answers silently going nowhere.
{
  const out = settingsFromQuiz(
    { ...REAL, others: { ...REAL.others, brandNewQuestionId: "some answer" } }, CONTACT);
  assert.deepStrictEqual(out.unmapped, [{ field: "brandNewQuestionId", answer: "some answer" }]);

  // GHL's own bookkeeping must not be reported as unmapped, or the ids that
  // matter get buried in noise.
  const clean = settingsFromQuiz(REAL, CONTACT);
  assert.deepStrictEqual(clean.unmapped, [], "plumbing keys are not answers");
  console.log("7) An unrecognised field id is reported; GHL plumbing is not");
}

// ---- 8. a submission from a different survey maps almost nothing ------
// The honest failure mode: different ids, so the map matches nothing and says so
// rather than provisioning an account from two lucky hits.
{
  const foreign = {
    id: "x", contactId: "c", surveyId: "some-other-survey",
    others: { aaaaaaaaaaaaaaaaaaaa: "Acme Rentals", bbbbbbbbbbbbbbbbbbbb: "English", formId: "other" },
  };
  const out = settingsFromQuiz(foreign, CONTACT);
  assert.strictEqual(Object.keys(out.input).length, 0, "nothing is written from unknown ids");
  assert.strictEqual(out.unmapped.length, 2, "and both answers are reported");
  console.log("8) A submission from a different survey writes nothing and reports every answer");
}

// ---- 9. a missing contact does not fabricate the holder's name --------
{
  const out = settingsFromQuiz(REAL, null);
  assert.strictEqual(out.input.wproperty_owner, "Rogelio Santana");
  assert.strictEqual(out.input.wmanager, undefined,
    "the holder's own name lives on the contact; with no contact it is left unset, not invented");
  console.log("9) With no contact record the holder's name is left unset rather than guessed");
}

// ---- 10. the map itself is coherent ----------------------------------
{
  const slugs = Object.values(QUIZ_FIELDS).map((f) => f.slug).filter(Boolean);
  assert.deepStrictEqual([...new Set(slugs)], slugs, "no two quiz fields target the same setting");
  const overlap = Object.keys(QUIZ_FIELDS).filter((k) => CALENDAR_FIELDS[k]);
  assert.deepStrictEqual(overlap, [], "a field is a setting or a calendar answer, never both");
  console.log("10) No field targets two settings, and none is both a setting and a calendar answer");
}

console.log("\nPASS — quiz map: real submission maps, the revenue-split conditional cannot silently invert, and unknown ids are reported.");
