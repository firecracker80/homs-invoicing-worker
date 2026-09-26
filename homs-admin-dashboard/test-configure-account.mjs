// Local mock tests for the client-side configuration agent. No network, no GHL.
// Run: node test-configure-account.mjs
//
// The thing under test points one client's whole portfolio at an account
// identified by a 20-character id. Most of these tests are about what it
// REFUSES to do.
import assert from "node:assert";

const {
  settingsFrom, planProperties, blockersFor, checklistFor,
  DEPLOYMENT_STEPS,
  planConfiguration, applyConfiguration, SETTINGS_SOURCES,
} = await import("./src/configure-account.js");
const { BLUEPRINT } = await import("./src/blueprint.js");

const CLIENT = "ZghxU8I60bEm39JUbtCm";

// GHL reads object records with POST /objects/<key>/records/search, so "method
// is not GET" does not mean "wrote something". Only these do.
const isWrite = (c) =>
  (c.url.includes("/customValues") && c.method !== "GET") ||
  (c.method === "POST" && c.url.split("?")[0].endsWith("/records"));
const writesIn = (calls) => calls.filter(isWrite);
const row = (name, rowNumber = 3) => ({
  rowNumber, name, include: true, blocked: false,
  properties: { property_name: name, base_nightly_rate: { value: 100, currency: "default" } },
});

const intakeFor = (overrides = {}) => ({
  contactId: "c1",
  status: "ready_for_review",
  crossCheck: { conflicts: [], unwired: [], unreadQuizAnswers: [] },
  portfolio: {
    rows: [row("Casa Uno", 3), row("Casa Dos", 4)],
    accountSettings: {
      currency: "USD",
      cancellationPolicy: "grace 24h/7d, 5d 1n+50%, check-in 100%",
      cancellationPolicyLabel: "Moderate",
    },
    disagreements: [],
    calendarChecklist: [
      { listing: "Casa Uno", basePrice: 100, currency: "USD", detail: { "Check-in Time": "15:00" } },
      { listing: "Casa Dos", basePrice: 110, currency: "USD", detail: {} },
    ],
    summary: { total: 2, ready: 2 },
  },
  ...overrides,
});

// ---- 1. settings come only from somewhere real ------------------------------
{
  const { input, filled, missing } = settingsFrom(intakeFor(), { brandName: "Casa Bonita" });
  assert.strictEqual(input.wcurrency, "USD");
  assert.strictEqual(input.wbrand_name, "Casa Bonita");
  assert.strictEqual(input.wcancellation_policy, "grace 24h/7d, 5d 1n+50%, check-in 100%",
    "the sentence the Worker parses, not the label a person reads");
  assert.deepStrictEqual(filled.map((f) => f.from).sort(), ["request", "workbook", "workbook"]);

  // Everything with no source is listed, with where it should come from. A key
  // that is quietly absent is how an account looks configured and is not.
  const missingSlugs = missing.map((m) => m.slug);
  assert.ok(missingSlugs.includes("wowner_revenue_split"), "the owner split has no source yet and says so");
  assert.ok(missingSlugs.includes("wlocale"));
  assert.ok(!missingSlugs.includes("wcurrency"));
  assert.ok(missing.every((m) => m.note), "every missing key explains where it should come from");
  console.log("1) Settings are filled only from the workbook or the caller; everything else is reported missing");
}

// ---- 2. the cancellation policy has somewhere to go -------------------------
// It did not until 2026-09-25: the blueprint was one survey out of date, so the
// client's answer would have been collected and then dropped.
{
  const entry = BLUEPRINT.find((e) => e.slug === "wcancellation_policy");
  assert.ok(entry, "wcancellation_policy must be in the blueprint");
  assert.strictEqual(entry.policy, "input");
  const { input } = settingsFrom(intakeFor(), { brandName: "X" });
  assert.ok(input.wcancellation_policy, "and it must actually be written");
  console.log("2) The cancellation policy the client picked reaches a real blueprint key");
}

// ---- 2b. operational notifications have a configurable home -----------------
// Before 2026-09-26 the notification address lived inside a workflow email
// action, which no API can read. A cloned account kept the template address and
// the real manager never heard about a cleaning submission -- an email that
// does not arrive raises nothing, so nobody found out.
{
  const entry = BLUEPRINT.find((e) => e.slug === "wmanager_notification_email");
  assert.ok(entry, "wmanager_notification_email must be in the blueprint");
  assert.strictEqual(entry.policy, "input", "it is configured per account, not derived or generated");

  // No source of its own yet, so it must appear in `missing` with a note
  // rather than being silently absent from the plan.
  const { input, missing } = settingsFrom(intakeFor(), { brandName: "Casa Bonita" });
  assert.strictEqual(input.wmanager_notification_email, undefined, "never invented");
  const m = missing.find((x) => x.slug === "wmanager_notification_email");
  assert.ok(m, "an unconfigured notification address is reported, not assumed inherited");
  assert.match(m.note, /account holder/);

  // And it writes when supplied, like any other account setting.
  const supplied = settingsFrom(intakeFor(), {
    brandName: "Casa Bonita", extra: { wmanager_notification_email: "rosa@casabonita.do" },
  });
  assert.strictEqual(supplied.input.wmanager_notification_email, "rosa@casabonita.do");
  assert.ok(!supplied.missing.some((x) => x.slug === "wmanager_notification_email"));
  console.log("2b) The manager notification address is a configurable key, reported when unset");
}

// ---- 3. a caller cannot push a value into a key that must stay manual -------
{
  const { input, refused } = settingsFrom(intakeFor(), {
    brandName: "X",
    extra: { wghl_cancelation_url: "https://evil/hook", wpaypal_secret_key: "sk_live_x", wlocale: "es-ES" },
  });
  assert.strictEqual(input.wghl_cancelation_url, undefined, "a webhook URL is never written from a payload");
  assert.strictEqual(input.wpaypal_secret_key, undefined, "nor is a credential");
  assert.strictEqual(input.wlocale, "es-ES", "an ordinary input key still works");
  assert.deepStrictEqual(refused.sort(), ["wghl_cancelation_url", "wpaypal_secret_key"],
    "and the refusal is visible in the plan, not silent");
  console.log("3) Manual-policy keys cannot be written through the payload, and refusals are reported");
}

// ---- 4. properties dedupe against the TARGET account ------------------------
// The intake was parsed before this account was chosen, so "already here?" could
// not be answered then. This is where it is answered.
{
  const rows = [row("Casa Uno", 3), row("Casa Dos", 4), row("casa uno", 5), row(null, 6)];
  const { toCreate, skipped } = planProperties(rows, ["Casa Dos"]);
  assert.deepStrictEqual(toCreate.map((r) => r.name), ["Casa Uno"]);
  assert.deepStrictEqual(
    skipped.map((s) => [s.name, s.reason]),
    [["Casa Dos", "already_in_account"], ["casa uno", "duplicate_in_selection"], [null, "no_listing_name"]]);
  console.log("4) Properties dedupe against the target account and within the selection, ignoring case");
}

// ---- 5. refusals ------------------------------------------------------------
{
  const ok = { brandName: "Casa Bonita", accountBrand: "", rows: [row("Casa Uno")] };
  assert.deepStrictEqual(blockersFor(intakeFor(), ok), [], "a fresh account with a named brand is fine");

  const codes = (intake, o) => blockersFor(intake, { ...ok, ...o }).map((b) => b.code);

  assert.deepStrictEqual(codes(null, {}), ["no_intake"]);
  assert.ok(codes(intakeFor({ status: "waiting" }), {}).includes("intake_not_ready"));
  assert.ok(codes(intakeFor(), { brandName: null }).includes("no_brand_name"));
  assert.ok(codes(intakeFor(), { rows: [] }).includes("nothing_selected"));

  // The one that matters most: pointed at somebody else's account.
  assert.ok(codes(intakeFor(), { accountBrand: "Luminara" }).includes("wrong_account"),
    "configuring Casa Bonita into Luminara must be refused");
  assert.deepStrictEqual(codes(intakeFor(), { accountBrand: "casa bonita" }), [],
    "the same brand differently cased is the same account");

  // A disagreement a person never resolved must not be resolved by a robot.
  assert.ok(codes(intakeFor({
    crossCheck: { conflicts: [{ label: "Currency", fromQuiz: "DOP", fromWorkbook: "USD" }] },
  }), {}).includes("unresolved_conflict"));
  assert.ok(codes(intakeFor({
    portfolio: { ...intakeFor().portfolio, disagreements: [{ kind: "needs_review", value: "Other" }] },
  }), {}).includes("policy_needs_review"));
  assert.ok(codes(intakeFor({
    portfolio: { ...intakeFor().portfolio, disagreements: [{ kind: "conflict", column: "Currency", used: "USD", rows: [4] }] },
  }), {}).includes("setting_conflict"));
  console.log("5) Refuses a wrong account, an unreviewed intake, and any disagreement nobody resolved");
}

// ---- 6. the calendar checklist covers exactly what gets created ------------
{
  const p = intakeFor().portfolio;
  assert.deepStrictEqual(checklistFor(p, [row("Casa Uno")]).map((c) => c.listing), ["Casa Uno"],
    "a listing that was skipped needs no calendar");
  assert.deepStrictEqual(checklistFor(p, []).length, 0);
  assert.deepStrictEqual(checklistFor(p, [row("Casa Uno"), row("Casa Dos")]).length, 2);
  console.log("6) The calendar checklist covers exactly the listings being created");
}

// ---- 7. plan writes nothing -------------------------------------------------
{
  const calls = [];
  globalThis.fetch = mockGhl(calls, { brand: "" });
  const plan = await planConfiguration("pit", CLIENT, intakeFor(), { brandName: "Casa Bonita" });

  assert.deepStrictEqual(plan.blockers, []);
  assert.strictEqual(plan.freshAccount, true);
  assert.deepStrictEqual(plan.properties.toCreate.map((p) => p.name), ["Casa Uno", "Casa Dos"]);
  assert.strictEqual(plan.calendars.length, 2);
  assert.ok(plan.settings.plan.dryRun, "the settings preview is a dry run");
  assert.ok(plan.settings.plan.results.some((r) => String(r.action).startsWith("would-")),
    "and it says what it WOULD do");
  assert.strictEqual(writesIn(calls).length, 0, "plan performs no writes at all");
  console.log("7) Plan performs no writes and previews the settings through the real code path");
}

// ---- 8. a blocked plan never reaches provisioning --------------------------
{
  const calls = [];
  globalThis.fetch = mockGhl(calls, { brand: "Luminara" });
  const plan = await planConfiguration("pit", CLIENT, intakeFor(), { brandName: "Casa Bonita" });
  assert.ok(plan.blockers.some((b) => b.code === "wrong_account"));
  assert.strictEqual(plan.settings.plan, null, "no settings plan is even built for a refused run");

  await assert.rejects(
    () => applyConfiguration("pit", CLIENT, intakeFor(), { brandName: "Casa Bonita" }),
    (err) => err.status === 409 && err.blockers.some((b) => b.code === "wrong_account"),
    "apply refuses with the blockers attached");
  assert.strictEqual(writesIn(calls).length, 0, "and wrote nothing on the way");
  console.log("8) A refused run builds no plan and writes nothing");
}

// ---- 9. apply writes settings before properties ----------------------------
// An empty account is obviously unfinished; a populated one with no settings
// looks done. So if provisioning fails, no properties are created.
{
  const calls = [];
  globalThis.fetch = mockGhl(calls, { brand: "" });
  const out = await applyConfiguration("pit", CLIENT, intakeFor(), { brandName: "Casa Bonita" });

  const writes = writesIn(calls);
  const firstRecord = writes.findIndex((c) => c.url.includes("/objects/"));
  const firstCustomValue = writes.findIndex((c) => c.url.includes("/customValues"));
  assert.ok(firstCustomValue >= 0 && firstCustomValue < firstRecord, "custom values are written before properties");
  assert.strictEqual(out.properties.created.length, 2);
  assert.ok(out.manualStepsRemaining.some((m) => /rental calendar/i.test(m)), "it always says the calendars are still to do");
  assert.ok(out.manualStepsRemaining.some((m) => /Owner revenue split/i.test(m)), "and what still has no source");
  console.log("9) Apply writes settings first, then properties, and states what is still manual");
}

// ---- 10. provisioning failure stops the properties -------------------------
{
  const calls = [];
  globalThis.fetch = mockGhl(calls, { brand: "", failCustomValueWrite: true });
  await assert.rejects(() => applyConfiguration("pit", CLIENT, intakeFor(), { brandName: "Casa Bonita" }));
  assert.strictEqual(writesIn(calls).filter((c) => c.url.includes("/objects/")).length, 0,
    "no property is created when the settings write failed");
  console.log("10) A settings failure leaves the account empty rather than half-configured");
}

// ---- 11. the routes ---------------------------------------------------------
{
  const calls = [];
  globalThis.fetch = mockGhl(calls, { brand: "" });
  const store = {
    [CLIENT]: { label: "DEMO-HOMS", ghlPitSecretName: "GHL_PIT_DEMO" },
    VENDOR: { label: "DTCS", kind: "vendor", ghlPitSecretName: "GHL_PIT_DEMO" },
    "onboarding:c1": intakeFor(),
  };
  const env = {
    ADMIN_KEY: "admin", PROVISION_KEY: "prov", GHL_PIT_DEMO: "pit",
    DASHBOARD_TENANTS: {
      put: async (k, v) => { store[k] = JSON.parse(v); },
      get: async (k, opt) => (store[k] == null ? null : (opt?.type === "json" ? store[k] : JSON.stringify(store[k]))),
    },
  };
  const { default: worker } = await import("./src/index.js");
  const post = (path, payload, key = "prov") => worker.fetch(new Request("https://d.dev" + path, {
    method: "POST", headers: { "Content-Type": "application/json", ...(key ? { Authorization: "Bearer " + key } : {}) },
    body: JSON.stringify(payload),
  }), env);

  const body = { locationId: CLIENT, contactId: "c1", brandName: "Casa Bonita" };
  assert.strictEqual((await post("/api/onboarding/configure/plan", body, null)).status, 401, "no key");
  assert.strictEqual((await post("/api/onboarding/configure/plan", body, "admin")).status, 401,
    "the dashboard cookie cannot reconfigure a client account");
  assert.strictEqual((await post("/api/onboarding/configure/plan", { locationId: CLIENT })).status, 400, "contactId required");
  assert.strictEqual((await post("/api/onboarding/configure/plan", { ...body, contactId: "nope" })).status, 404, "unknown intake");
  assert.strictEqual((await post("/api/onboarding/configure/plan", { ...body, locationId: "VENDOR" })).status, 400,
    "a vendor book has no properties to configure");

  const planned = await (await post("/api/onboarding/configure/plan", body)).json();
  assert.strictEqual(planned.properties.toCreate.length, 2);

  const applied = await (await post("/api/onboarding/configure/apply", body)).json();
  assert.strictEqual(applied.properties.created.length, 2);

  // Spent once applied, so a second run cannot quietly repeat into another account.
  assert.strictEqual(store["onboarding:c1"].status, "configured");
  assert.strictEqual(store["onboarding:c1"].configuredInto, CLIENT);
  const second = await post("/api/onboarding/configure/apply", body);
  assert.strictEqual(second.status, 409, "a configured intake will not apply again");
  assert.ok((await second.json()).blockers.some((b) => b.code === "intake_not_ready"));
  console.log("11) Routes gated by PROVISION_KEY, client accounts only, and an intake applies exactly once");
}

// ---- 12. per-account deployment work is stated, never remembered ----------
// A snapshot carries workflows, not users. Cleaning tasks assign dynamically so
// the notification follows the assignee, which means it travels -- but only
// once the crew exist as users in that account.
{
  assert.ok(DEPLOYMENT_STEPS.length, "there is always per-account work no API can do");
  assert.ok(DEPLOYMENT_STEPS.every((d) => d.key && d.step && d.why),
    "every step says what to do and why it cannot be automated");

  const keys = DEPLOYMENT_STEPS.map((d) => d.key);
  assert.ok(keys.includes("cleaning_crew_users"), "the crew have to be created as users");
  assert.ok(keys.includes("confirm_notification_lands"),
    "and somebody has to confirm a notification actually arrives -- no API can audit that");

  const calls = [];
  globalThis.fetch = mockGhl(calls, { brand: "" });

  // On the PLAN, so they are visible before committing rather than only after.
  const plan = await planConfiguration("pit", CLIENT, intakeFor(), { brandName: "Casa Bonita" });
  assert.deepStrictEqual(plan.deploymentSteps, DEPLOYMENT_STEPS);

  const out = await applyConfiguration("pit", CLIENT, intakeFor(), { brandName: "Casa Bonita" });
  assert.deepStrictEqual(out.deploymentSteps, DEPLOYMENT_STEPS);
  for (const d of DEPLOYMENT_STEPS) {
    assert.ok(out.manualStepsRemaining.includes(d.step), d.key + " must appear in what is left to do");
  }
  console.log("12) Per-account deployment work appears on both the plan and the result");
}

// ---- 13. the survey is a real source now ----------------------------------
{
  const quiz = {
    others: {
      organization: "Casa Bonita",
      dCYsnLlIfJqTXDwSvu32: "Property Manager",
      ot999AAZnO2FYCrOJ5du: "Carlos Mendoza",
      wHSnykvGLEgHYaEVWviH: "Spanish",
      "21jhueq2p7pNB9n06Y56": "80",
      bQlvozqUaDDo2DfGrP9m: "Airbnb",
    },
  };
  const withQuiz = { ...intakeFor(), quiz, quizContact: { firstName: "Rosa", lastName: "Jimenez" } };

  const s = settingsFrom(withQuiz, { brandName: "Casa Bonita" });
  assert.strictEqual(s.input.wlocale, "es-ES");
  assert.strictEqual(s.input.wowner_revenue_split, "80%");
  assert.strictEqual(s.input.wproperty_owner, "Carlos Mendoza");
  assert.strictEqual(s.input.wmanager, "Rosa Jimenez");
  // The workbook still owns what the workbook carries.
  assert.strictEqual(s.input.wcurrency, "USD");
  assert.ok(s.filled.some((f) => f.from === "quiz"), "and the source is recorded");
  // A calendar answer must never become a setting.
  assert.ok(!Object.values(s.input).includes("Airbnb"));
  // Five fewer things reported missing than before the quiz existed.
  const missingSlugs = s.missing.map((m) => m.slug);
  assert.ok(!missingSlugs.includes("wlocale"));
  assert.ok(!missingSlugs.includes("wowner_revenue_split"));

  // A brand the client did not agree to blocks the whole run.
  const mismatch = settingsFrom(withQuiz, { brandName: "Luminara" });
  assert.ok(mismatch.disagreements.some((d) => d.slug === "wbrand_name"));

  const calls = [];
  globalThis.fetch = mockGhl(calls, { brand: "" });
  const plan = await planConfiguration("pit", CLIENT, withQuiz, { brandName: "Luminara" });
  assert.ok(plan.blockers.some((b) => b.code === "brand_disagreement"),
    "configuring a client under a name they did not give is refused");
  assert.strictEqual(writesIn(calls).length, 0);
  console.log("13) Survey answers fill locale, split, owner and manager; a brand mismatch blocks");
}

// ---- 14. the plan hands GHL something a merge tag can actually read ------
// A workflow builds the review task and the internal notification from this
// response. Merge tags cannot walk into nested objects or arrays.
{
  const calls = [];
  globalThis.fetch = mockGhl(calls, { brand: "" });
  const plan = await planConfiguration("pit", CLIENT, intakeFor(), { brandName: "Casa Bonita" });

  assert.ok(plan.notice, "the plan carries a flat notice block");
  for (const [k, v] of Object.entries(plan.notice)) {
    assert.strictEqual(typeof v, "string", `notice.${k} must be a string for a merge tag`);
  }
  assert.strictEqual(plan.notice.brandName, "Casa Bonita");
  assert.strictEqual(plan.notice.clientLocationId, CLIENT);
  assert.strictEqual(plan.notice.propertiesToCreate, "2", "counts are strings, not numbers");
  assert.strictEqual(plan.notice.calendarsToCreate, "2");
  assert.strictEqual(plan.notice.readyToApply, "yes");
  assert.strictEqual(plan.notice.blockers, "", "blank when clear, so a workflow can branch on it");

  // A zero has to render as "0", not as an empty cell that reads like no data.
  const empty = await planConfiguration("pit", CLIENT, { ...intakeFor(), portfolio: { ...intakeFor().portfolio, rows: [] } }, { brandName: "Casa Bonita" });
  assert.strictEqual(empty.notice.propertiesToCreate, "0");

  // And a blocked plan says so in one readable line.
  globalThis.fetch = mockGhl(calls, { brand: "Luminara" });
  const blocked = await planConfiguration("pit", CLIENT, intakeFor(), { brandName: "Casa Bonita" });
  assert.strictEqual(blocked.notice.readyToApply, "no");
  assert.strictEqual(blocked.notice.blockerCount, "1");
  assert.match(blocked.notice.blockers, /Luminara/);
  console.log("14) The plan carries a flat, all-string notice a GHL task can be built from");
}

// A GHL stand-in: custom values, object records, and the writes both make.
function mockGhl(calls, { brand = "", failCustomValueWrite = false } = {}) {
  return async (url, init = {}) => {
    const u = String(url);
    const method = init.method || "GET";
    calls.push({ url: u, method });

    if (u.includes("/customValues") && method === "GET") {
      return ok({ customValues: [
        { id: "cv1", name: "WBrand Name", fieldKey: "{{ custom_values.wbrand_name }}", value: brand, parentId: null },
      ] });
    }
    if (u.includes("/customValues")) {
      if (failCustomValueWrite) return { ok: false, status: 500, text: async () => JSON.stringify({ message: "GHL is down" }) };
      return ok({ id: "cv-new" });
    }
    if (u.includes("/records/search")) return ok({ records: [], total: 0 });
    if (u.includes("/objects/") && method === "POST") return ok({ record: { id: "rec-" + calls.length } });
    if (u.includes("/objects/")) return ok({ records: [], total: 0 });
    return ok({});
  };
  function ok(body) {
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
  }
}

console.log("\nPASS — configuration agent: refuses the wrong account, writes nothing on a plan, and never claims the calendars are done.");
