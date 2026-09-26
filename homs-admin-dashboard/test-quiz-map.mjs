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
  settingsFromQuiz, localeFrom, splitPercent, roleFrom, BRANCHES,
  CALENDAR_FIELDS, CONTEXT_FIELDS,
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

  // The owner branch is exercised against its own real submission below (13);
  // the manager submission cannot simply be relabelled, because each role reads
  // an entirely different set of field ids.
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
  assert.strictEqual(splitPercent("80"), 80);
  assert.strictEqual(splitPercent("80%"), 80);
  assert.strictEqual(splitPercent("85.5"), 85.5);
  assert.strictEqual(splitPercent(""), null);
  assert.strictEqual(splitPercent("most of it"), null, "prose is not a split");
  assert.strictEqual(splitPercent("0"), null, "0 is a typo, not an intent");
  assert.strictEqual(splitPercent("100"), null, "so is 100");
  assert.strictEqual(splitPercent("800"), null, "and a stray zero must not become 800%");

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

// ---- 10. the two branches are genuinely separate ----------------------
{
  const ids = (b) => [b.counterpartyName, b.counterpartyEmail, b.counterpartyPhone, b.language, b.split].filter(Boolean);
  const m = ids(BRANCHES.manager);
  const o = ids(BRANCHES.owner);
  assert.deepStrictEqual(m.filter((id) => o.includes(id)), [],
    "the branches share no field id -- an answer belongs to exactly one of them");

  // The polarity difference is the whole reason this is modelled as branches.
  assert.strictEqual(BRANCHES.manager.splitIsOwnerShare, true);
  assert.strictEqual(BRANCHES.owner.splitIsOwnerShare, false,
    "the owner branch reports the manager cut and must be inverted");
  assert.notStrictEqual(BRANCHES.manager.counterpartySlug, BRANCHES.owner.counterpartySlug);

  for (const id of [...m, ...o]) {
    assert.ok(!CALENDAR_FIELDS[id], id + " cannot be both a branch answer and a calendar answer");
    assert.ok(!CONTEXT_FIELDS[id], id + " cannot be both a branch answer and context");
  }
  console.log("10) The two branches share no field ids and record opposite split polarity");
}
// ---- 11. the second real submission: a self-managing owner ---------------
// Verbatim from submission 6ab7f633dda16ec7f4d38cf0, 2026-09-26. It broke the
// first version of this map: "Owner - Self Manage" read as plain "owner", so
// it looked for a counterparty the survey correctly never asked for and left
// the manager blank. One person is both sides here.
const SELF_MANAGE = {
  id: "6ab7f633dda16ec7f4d38cf0",
  contactId: "zGGIiZhwBNWnrVJPNFwi",
  surveyId: "4d3ykgx6DqasTydvt5zn",
  others: {
    organization: "Test Co",
    dCYsnLlIfJqTXDwSvu32: "Owner - Self Manage",
    phone: "+12295632945",
    email: "yari@yvelazquez.com",
    coJl5jBvIcf9qOrsE2OW: ["Stripe", "Manual/Transfer"],
    AMDFCDpHhblNGnAiHnx1: "Yes",
    h0UAbnJJPj6l8V4tIT33: "Yes",
    "8NRzmmlRanL7h7PDPzR6": "yari@dt-cs.com",
    X9UzaCzBdegJH6Os01is: "Yes, I have access",
    website: "https://dt-cs.com",
    ZtCaZ0VGjObwvPWAdi3W: "ghl",
    cQYdrTqFa0ekByWHTUWI: "squarespace",
    ZzxUsjxxOuZQWjByk26R: "2295632945",
    E7w0ab96j8ovFWWJUpNO: "Date selector ONLY",
    kga7cOUMVnxNPJhAeSAR: "1",
    ijTLyUAIN8Z8iUPGDE1J: "120",
    bQlvozqUaDDo2DfGrP9m: "Airbnb",
    formId: "4d3ykgx6DqasTydvt5zn",
    location_id: "dytwzgmOP5v0Jh7gop4y",
    contact_id: "c31576bc-07e0-4789-aec4-92711d07a5df",
    submissionId: "cfb01a7c-e4eb-4924-aef3-cd56be95d76c",
  },
};
{
  const out = settingsFromQuiz(SELF_MANAGE, { firstName: "Yari", lastName: "Velazquez" });
  assert.strictEqual(out.accountHolderRole, "self");
  assert.strictEqual(out.input.wproperty_owner, "Yari Velazquez");
  assert.strictEqual(out.input.wmanager, "Yari Velazquez",
    "a self-managing owner is the manager too -- this is what the first version got wrong");
  assert.strictEqual(out.input.wbrand_name, "Test Co");

  // No language and no split were asked, and neither absence is a problem.
  assert.strictEqual(out.input.wlocale, undefined);
  assert.strictEqual(out.input.wowner_revenue_split, "100%",
    "nothing is being split when one person is both sides");
  assert.deepStrictEqual(out.problems, [],
    "a question the branch never asked is not a problem to report");

  // The business-details branch is classified, not reported as unknown.
  assert.deepStrictEqual(out.unmapped, [], "the tax-ID branch fields are known");
  assert.strictEqual(out.context["Tax ID on file"], "Yes");
  assert.strictEqual(out.context["Website platform"], "ghl");
  console.log("11) The self-managing owner submission maps both sides to one person");
}

// ---- 12. one extra letter must not change who gets paid -----------------
{
  // All three real answers contain a manager word, so substring matching on
  // "manager" cannot tell them apart -- what the answer STARTS with can.
  assert.strictEqual(roleFrom("Property Manager"), "manager");
  assert.strictEqual(roleFrom("Owner - Self Manage"), "self");
  assert.strictEqual(roleFrom("Owner - Have Manager"), "owner",
    "the word manager appears here but the holder is the owner");
  assert.strictEqual(roleFrom("Owner - Self Manager"), "self", "a near-miss wording is still self");
  assert.strictEqual(roleFrom("owner-selfmanage"), "self");
  // Wordings the survey does not currently use return null, which is the safe
  // failure: neither name is written and the run reports why. Renaming an option
  // in the survey therefore stops provisioning rather than mis-assigning it.
  assert.strictEqual(roleFrom("Property Owner"), null, "not a real option today");
  assert.strictEqual(roleFrom("Co-host"), null);
  console.log("12) All three roles are told apart even though every answer contains a manager word");
}

// ---- 13. the third real submission: an owner who has a manager ----------
// Verbatim from 6ab7fc39dda16ec7f4d392f4. This is the branch that would have
// been silently wrong: it uses a completely different set of field ids from the
// manager branch, and it reports the MANAGER cut where the other reports the
// OWNER share. Read with the manager branch polarity, this owner would have
// been provisioned on 15% of their own rental income.
const OWNER_WITH_MANAGER = {
  id: "6ab7fc39dda16ec7f4d392f4",
  contactId: "zGGIiZhwBNWnrVJPNFwi",
  surveyId: "4d3ykgx6DqasTydvt5zn",
  others: {
    organization: "Test Co 2",
    dCYsnLlIfJqTXDwSvu32: "Owner - Have Manager",
    phone: "+18293679664",
    email: "yari@yvelazquez.com",
    DiUUoVQXYB2ICp5gyMDS: "Yari Test",
    TP9vSWRPZcln5jidXqXs: "2295632945",
    CRdAIfdRI5VNcmqClQlm: "Same above",
    LWpi09sPbE2c5CJKfUmk: "15",
    nGAANCuy0Gy7JHhgM7Ix: "English",
    dHYU1FXsj3a5uNxyfYC2: ["User"],
    coJl5jBvIcf9qOrsE2OW: ["Stripe"],
    AMDFCDpHhblNGnAiHnx1: "No",
    X9UzaCzBdegJH6Os01is: "I do not have a website",
    ZzxUsjxxOuZQWjByk26R: "8293679364",
    E7w0ab96j8ovFWWJUpNO: "Date selector ONLY",
    bQlvozqUaDDo2DfGrP9m: "Airbnb",
    formId: "4d3ykgx6DqasTydvt5zn",
    location_id: "dytwzgmOP5v0Jh7gop4y",
    contact_id: "c31576bc-07e0-4789-aec4-92711d07a5df",
    submissionId: "95bcd771-13ae-4f3f-90b7-0379897a927e",
  },
};
{
  const out = settingsFromQuiz(OWNER_WITH_MANAGER, { firstName: "Yari", lastName: "Velazquez" });
  assert.strictEqual(out.accountHolderRole, "owner");
  assert.strictEqual(out.input.wmanager, "Yari Test", "an owner names their manager");
  assert.strictEqual(out.input.wproperty_owner, "Yari Velazquez", "and is themselves the owner");
  assert.strictEqual(out.input.wbrand_name, "Test Co 2");

  // The inversion. 15 is what the manager charges, so the owner keeps 85.
  assert.strictEqual(out.input.wowner_revenue_split, "85%",
    "the owner branch reports the manager cut -- storing 15% here would be the bug");

  // Language comes from this branch's own field, not the manager branch's.
  assert.strictEqual(out.input.wlocale, "en-US");

  assert.deepStrictEqual(out.problems, []);
  assert.deepStrictEqual(out.unmapped, [], "every id in this branch is known");
  console.log("13) The owner-with-manager branch maps, and its split is inverted to the owner share");
}

// ---- 14. the same number means opposite things on the two branches ------
{
  const managerSide = settingsFromQuiz(
    { ...REAL, others: { ...REAL.others, "21jhueq2p7pNB9n06Y56": "15" } }, CONTACT);
  const ownerSide = settingsFromQuiz(OWNER_WITH_MANAGER, { firstName: "Y", lastName: "V" });
  assert.strictEqual(managerSide.input.wowner_revenue_split, "15%", "manager branch: 15 is the owner share");
  assert.strictEqual(ownerSide.input.wowner_revenue_split, "85%", "owner branch: 15 is the manager cut");
  console.log("14) An identical answer of 15 yields 15% on one branch and 85% on the other");
}


console.log("\nPASS — quiz map: real submission maps, the revenue-split conditional cannot silently invert, and unknown ids are reported.");
