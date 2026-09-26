// The quiz is submitted FIRST, the workbook comes back days later.
// Run: node test-quiz-first.mjs
//
// An earlier version had this backwards: the workbook handler rebuilt the
// intake record from scratch, so a quiz already on file was silently discarded
// -- and with it the brand name, locale, revenue split and both party names.
// Nothing would have errored. The account would simply have been provisioned
// with five settings missing.
import assert from "node:assert";
import { book, EXAMPLE } from "./test-workbook.mjs";

const { mergeIntake, fetchLatestSubmission } = await import("./src/onboarding-intake.js");

const HOMS = "dytwzgmOP5v0Jh7gop4y";
const CONTACT = "zGGIiZhwBNWnrVJPNFwi";
const SURVEY = "4d3ykgx6DqasTydvt5zn";

const submission = (over = {}) => ({
  id: "sub-1", contactId: CONTACT, surveyId: SURVEY,
  createdAt: "2026-09-26T16:14:14.721Z",
  others: { organization: "Test Co", dCYsnLlIfJqTXDwSvu32: "Property Manager" },
  ...over,
});

// ---- 1. a patch never blanks the quiz by omission ------------------------
{
  const withQuiz = { contactId: CONTACT, quiz: submission(), quizContact: { firstName: "Yari" }, quizAt: "t0" };
  const merged = mergeIntake(withQuiz, { status: "ready_for_review", portfolio: { rows: [] } });
  assert.deepStrictEqual(merged.quiz, withQuiz.quiz, "the quiz survives a workbook arriving later");
  assert.deepStrictEqual(merged.quizContact, withQuiz.quizContact);
  assert.strictEqual(merged.quizAt, "t0");
  assert.strictEqual(merged.status, "ready_for_review", "and the patch still applies");

  // The case the preservation loop actually guards. A spread already keeps a key
  // the patch omits -- what it does NOT survive is a patch that carries the key
  // set to undefined, which is what happens when a handler builds its record
  // from a variable that resolved to nothing.
  const blanking = mergeIntake(withQuiz, { status: "ready_for_review", quiz: undefined, quizContact: undefined });
  assert.deepStrictEqual(blanking.quiz, withQuiz.quiz, "an explicit undefined must not blank the quiz");
  assert.deepStrictEqual(blanking.quizContact, withQuiz.quizContact);
  assert.strictEqual(blanking.status, "ready_for_review");
  console.log("1) A workbook patch preserves the quiz rather than replacing the record");
}

// ---- 2. a patch MAY deliberately update the quiz ------------------------
// Preserved does not mean frozen -- a client who resubmits the survey means it.
{
  const merged = mergeIntake({ quiz: submission({ id: "old" }) }, { quiz: submission({ id: "new" }) });
  assert.strictEqual(merged.quiz.id, "new");
  console.log("2) A resubmitted survey still overwrites the old one");
}

// ---- 3. merging onto nothing works -------------------------------------
{
  const merged = mergeIntake(null, { contactId: CONTACT, quiz: submission() });
  assert.strictEqual(merged.contactId, CONTACT);
  assert.ok(merged.quiz);
  console.log("3) The first write creates the record");
}

// ---- 4. the newest submission wins, and only this contact's -------------
{
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ submissions: [
      submission({ id: "old", createdAt: "2026-09-20T10:00:00Z" }),
      submission({ id: "someone-else", contactId: "OTHER", createdAt: "2026-09-26T23:00:00Z" }),
      submission({ id: "newest", createdAt: "2026-09-26T16:14:14Z" }),
    ] }),
  });
  const got = await fetchLatestSubmission("pit", SURVEY, CONTACT);
  assert.strictEqual(got.id, "newest", "newest for THIS contact, not newest overall");

  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ submissions: [] }) });
  assert.strictEqual(await fetchLatestSubmission("pit", SURVEY, CONTACT), null);

  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ message: "bad token" }) });
  await assert.rejects(() => fetchLatestSubmission("pit", SURVEY, CONTACT), /bad token/);
  console.log("4) Fetching picks this contact's newest submission and surfaces errors");
}

// ---- 5. the route: quiz first, then workbook, nothing lost --------------
{
  const store = { [HOMS]: { label: "HOMS", kind: "vendor", ghlPitSecretName: "GHL_PIT_HOMS" } };
  const env = {
    ADMIN_KEY: "admin", PROVISION_KEY: "prov", GHL_PIT_HOMS: "pit", ONBOARDING_SURVEY_ID: SURVEY,
    DASHBOARD_TENANTS: {
      put: async (k, v) => { store[k] = JSON.parse(v); },
      get: async (k, opt) => (store[k] == null ? null : (opt?.type === "json" ? store[k] : JSON.stringify(store[k]))),
    },
  };
  const workbook = book([EXAMPLE, { A: "Casa Uno", B: "Active", C: "Villa", O: 100, N: "USD", W: "Moderate" }]);

  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/surveys/submissions")) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ submissions: [submission()] }) };
    }
    if (u.includes("/contacts/")) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ contact: { firstName: "Yari", lastName: "Velazquez" } }) };
    }
    if (u.includes("/conversations/messages/export")) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ messages: [
        { id: "in1", direction: "inbound", messageType: "TYPE_EMAIL", dateAdded: "2026-09-28T10:00:00Z", files: ["https://x/filled.xlsx"] },
      ] }) };
    }
    if (u === "https://x/filled.xlsx") {
      return { ok: true, status: 200, headers: new Headers(), arrayBuffer: async () => workbook };
    }
    return { ok: true, status: 200, text: async () => "{}" };
  };

  const { default: worker } = await import("./src/index.js");
  const post = (path, payload, key = "prov") => worker.fetch(new Request("https://d.dev" + path, {
    method: "POST", headers: { "Content-Type": "application/json", ...(key ? { Authorization: "Bearer " + key } : {}) },
    body: JSON.stringify(payload),
  }), env);

  assert.strictEqual((await post("/api/onboarding/quiz", { locationId: HOMS, contactId: CONTACT }, null)).status, 401);
  assert.strictEqual((await post("/api/onboarding/quiz", { locationId: HOMS })).status, 400, "contactId required");

  // Step one: the survey.
  const quizRes = await post("/api/onboarding/quiz", { locationId: HOMS, contactId: CONTACT });
  const quizBody = await quizRes.json();
  assert.strictEqual(quizRes.status, 200);
  assert.strictEqual(quizBody.status, "awaiting_workbook");
  assert.strictEqual(quizBody.hasWorkbook, false);
  assert.strictEqual(quizBody.answersCaptured, 2);
  // The answers themselves are not echoed -- this response lands in a GHL log.
  assert.strictEqual(quizBody.quiz, undefined, "a survey carries names, emails and phones");

  const afterQuiz = store[`onboarding:${CONTACT}`];
  assert.ok(afterQuiz.quiz, "the submission is stored");
  assert.strictEqual(afterQuiz.quizContact.firstName, "Yari", "and the holder's own name off the contact");

  // Step two, days later: the workbook.
  const wbRes = await post("/api/onboarding/intake", { locationId: HOMS, contactId: CONTACT });
  assert.strictEqual(wbRes.status, 200, JSON.stringify(await wbRes.clone().json()));

  const afterWorkbook = store[`onboarding:${CONTACT}`];
  assert.ok(afterWorkbook.portfolio, "the workbook is on record");
  assert.ok(afterWorkbook.quiz, "AND THE QUIZ IS STILL THERE -- this is the regression");
  assert.strictEqual(afterWorkbook.quizContact.firstName, "Yari");
  assert.strictEqual(afterWorkbook.quiz.id, "sub-1");
  assert.strictEqual(afterWorkbook.status, "ready_for_review");
  console.log("5) Quiz then workbook: both end up on one record, neither overwrites the other");
}

console.log("\nPASS — the quiz arrives first and survives the workbook; submissions are read from GHL, not mapped by hand.");
