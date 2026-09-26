// configure-account.js -- the client-side configuration agent.
//
// Takes a reviewed intake (onboarding-intake.js) and configures the CLIENT's own
// sub-account from it. Three steps, one review gate:
//
//   1. account holder and settings -> Custom Values, via provision.js
//   2. the portfolio -> Property records, via portfolio-import.js
//   3. the rental calendars -> a work order, because no API can create one
//
// On step 3, re-verified 2026-09-25 against the live API: create-calendar's
// `calendarType` enum is round_robin | event | class_booking | collective |
// service_booking | personal -- no rental type -- and get-calendars returns []
// on DEMO-HOMS, which visibly has rental calendars with live bookings on them.
// They are invisible in both directions, so this emits everything a person (or
// a browser-driving agent) needs to create them by hand, and claims nothing it
// cannot do.
//
// PLAN FIRST. plan() writes nothing at all; apply() writes only what a reviewed
// plan contained. Same contract as every other importer here.
//
// The hardest requirement is the one that is easy to skip: this points a pile of
// one client's data at an account identified only by a 20-character id. Getting
// that id wrong writes Casa Bonita's portfolio into Luminara. Every refusal in
// `blockersFor` exists because of that.

import { provision } from "./provision.js";
import { BLUEPRINT } from "./blueprint.js";
import { importProperties, loadExistingPropertyNames, listingNameKey } from "./portfolio-import.js";
import { fetchCustomValues } from "./ghl.js";

const blank = (v) => v === null || v === undefined || String(v).trim() === "";

// ------------------------------------------------------- settings mapping --
//
// Where each blueprint `input` key can actually come from today. The workbook
// carries two account-level answers; the brand is asserted by the operator; the
// rest have no source yet and are reported as such rather than invented.
//
// A key with no source is NOT an error -- it means provisioning leaves whatever
// is already in the account alone. It is listed so nobody believes the account
// is fully configured when it is not.

export const SETTINGS_SOURCES = {
  wbrand_name: { source: "request", note: "the brand name you are configuring this account as" },
  wcurrency: { source: "workbook", note: "Currency column on the Properties sheet" },
  wcancellation_policy: { source: "workbook", note: "Cancellation Policy column on the Properties sheet" },
  wproperty_owner: { source: "quiz", note: "not wired yet -- the survey has no submissions" },
  wmanager: { source: "quiz", note: "not wired yet -- the survey has no submissions" },
  wlocale: { source: "quiz", note: "not wired yet -- the survey has no submissions" },
  wcleaning_fee: { source: "quiz", note: "the workbook's cleaning fee is per property, not the account default" },
  wowner_revenue_split: { source: "quiz", note: "not wired yet -- the survey has no submissions" },
  wowner_paypal_email: { source: "integration call", note: "collected on a call, never in the quiz" },
  wmgr_paypal_email: { source: "integration call", note: "collected on a call, never in the quiz" },
  wpaypal_client_id: { source: "integration call", note: "collected on a call, never in the quiz" },
  wpaypal_webhook: { source: "integration call", note: "collected on a call, never in the quiz" },
  wservice_cost_currency: { source: "request", note: "service marketplace pricing currency, if the client sells services" },
};

export function settingsFrom(intake, { brandName = null, extra = {} } = {}) {
  const account = intake?.portfolio?.accountSettings || {};
  const input = {};
  const filled = [];

  const take = (slug, value, from) => {
    if (blank(value)) return;
    input[slug] = String(value);
    filled.push({ slug, from });
  };

  take("wbrand_name", brandName, "request");
  take("wcurrency", account.currency, "workbook");
  // The expanded sentence, not the label: "Moderate" is for people, and the
  // Worker parses either, but storing the sentence keeps the account readable
  // without a lookup table.
  take("wcancellation_policy", account.cancellationPolicy, "workbook");

  // Anything the caller supplies by hand wins, and is recorded as hand-entered.
  for (const [slug, value] of Object.entries(extra)) {
    const entry = BLUEPRINT.find((e) => e.slug === slug);
    if (!entry) continue;
    // Never let a caller push a value into a key the reconciler must not write.
    // provision() would refuse anyway; refusing here makes it visible in the plan.
    if (entry.policy !== "input") continue;
    take(slug, value, "supplied");
  }

  const missing = BLUEPRINT
    .filter((e) => e.policy === "input" && !(e.slug in input))
    .map((e) => ({
      slug: e.slug, label: e.label,
      ...(SETTINGS_SOURCES[e.slug] || { source: "unknown", note: "no source recorded" }),
    }));

  const refused = Object.keys(extra).filter((slug) => {
    const entry = BLUEPRINT.find((e) => e.slug === slug);
    return entry && entry.policy !== "input";
  });

  return { input, filled, missing, refused };
}

// ----------------------------------------------------- properties mapping --
//
// The intake was parsed before this account was chosen, so "is this listing
// already here?" could not be answered then and deliberately was not guessed.
// This is where it gets answered, against the account actually being written to.

export function planProperties(rows, existingNames) {
  const known = new Set((existingNames || []).map(listingNameKey));
  const seen = new Set();
  const toCreate = [];
  const skipped = [];

  for (const row of rows || []) {
    const name = row?.properties?.property_name ?? row?.name ?? null;
    if (blank(name)) { skipped.push({ rowNumber: row?.rowNumber ?? null, name: null, reason: "no_listing_name" }); continue; }
    const key = listingNameKey(name);
    if (known.has(key)) { skipped.push({ rowNumber: row.rowNumber, name, reason: "already_in_account" }); continue; }
    if (seen.has(key)) { skipped.push({ rowNumber: row.rowNumber, name, reason: "duplicate_in_selection" }); continue; }
    seen.add(key);
    toCreate.push(row);
  }

  return { toCreate, skipped };
}

// ------------------------------------------------------------- refusals ----

// The checklist parsePortfolio already produced, narrowed to the listings this
// run actually creates. The sheet it was built from is not stored on the intake,
// so this filters rather than recomputing.
export function checklistFor(portfolio, rows) {
  const wanted = new Set((rows || []).map((r) => listingNameKey(r?.properties?.property_name ?? r?.name)));
  return (portfolio?.calendarChecklist || []).filter((c) => wanted.has(listingNameKey(c.listing)));
}

export function blockersFor(intake, { brandName, accountBrand, rows }) {
  const blockers = [];

  if (!intake) {
    blockers.push({ code: "no_intake", detail: "No reviewed intake for this contact." });
    return blockers;
  }
  if (intake.status !== "ready_for_review" && intake.status !== "approved") {
    blockers.push({ code: "intake_not_ready", detail: `The intake is "${intake.status}", not something a person has reviewed.` });
  }

  // The misaddressed-run guard. A blank brand means a fresh account, which is
  // the normal case; a DIFFERENT brand means this is somebody else's account and
  // the run stops before a single write is planned.
  if (blank(brandName)) {
    blockers.push({ code: "no_brand_name", detail: "brandName is required -- name the client you believe you are configuring." });
  } else if (!blank(accountBrand) && listingNameKey(accountBrand) !== listingNameKey(brandName)) {
    blockers.push({
      code: "wrong_account",
      detail: `This account's brand is "${accountBrand}", but you asked to configure "${brandName}". Refusing -- check the locationId.`,
    });
  }

  // A disagreement the reviewer never resolved must not be resolved by a robot.
  for (const c of intake.crossCheck?.conflicts || []) {
    blockers.push({ code: "unresolved_conflict", detail: `${c.label}: the quiz says ${c.fromQuiz}, the workbook says ${c.fromWorkbook}.` });
  }
  for (const d of intake.portfolio?.disagreements || []) {
    if (d.kind === "needs_review") {
      blockers.push({ code: "policy_needs_review", detail: `Cancellation policy "${d.value}" is not one of the presets and has to be set by hand.` });
    } else if (d.kind === "conflict") {
      blockers.push({ code: "setting_conflict", detail: `${d.column} is not the same on every row (using ${d.used}, rows ${d.rows?.join(", ")} differ).` });
    }
  }

  if (!(rows || []).length) {
    blockers.push({ code: "nothing_selected", detail: "No property rows were selected for import." });
  }

  return blockers;
}

// ------------------------------------------------------------ plan/apply ----

async function readAccount(pit, locationId) {
  const [existingNames, customValues] = await Promise.all([
    loadExistingPropertyNames(pit, locationId),
    // provision() reads these again on its own; reading once here is only so the
    // brand check can happen BEFORE anything is planned.
    fetchCustomValues(pit, locationId),
  ]);
  const brandEntry = customValues.find((cv) => /custom_values\.wbrand_name/i.test(cv.fieldKey || ""));
  return { existingNames, accountBrand: brandEntry?.value ?? "" };
}

export async function planConfiguration(pit, locationId, intake, { brandName = null, extra = {}, rows = null, overwrite = false } = {}) {
  const selected = rows || (intake?.portfolio?.rows || []).filter((r) => r.include && !r.blocked);
  const { existingNames, accountBrand } = await readAccount(pit, locationId);

  const blockers = blockersFor(intake, { brandName, accountBrand, rows: selected });
  const settings = settingsFrom(intake, { brandName, extra });
  const properties = planProperties(selected, existingNames);

  // A dry run uses the same code path a real run does, so the preview cannot
  // drift from the write. expectBrand is passed only when the account already
  // has one -- on a fresh account there is nothing to assert against.
  const settingsPlan = blockers.length ? null : await provision(pit, locationId, {
    input: settings.input, dryRun: true, overwrite,
    expectBrand: blank(accountBrand) ? null : brandName,
  });

  return {
    locationId, brandName, accountBrand,
    freshAccount: blank(accountBrand),
    blockers,
    settings: { ...settings, plan: settingsPlan },
    properties: {
      toCreate: properties.toCreate.map((r) => ({ rowNumber: r.rowNumber, name: r.properties?.property_name ?? r.name })),
      skipped: properties.skipped,
    },
    calendars: checklistFor(intake?.portfolio, properties.toCreate),
    plannedAt: new Date().toISOString(),
  };
}

export async function applyConfiguration(pit, locationId, intake, opts = {}) {
  const plan = await planConfiguration(pit, locationId, intake, opts);
  if (plan.blockers.length) {
    const err = new Error("Refusing to configure: " + plan.blockers.map((b) => b.detail).join(" "));
    err.status = 409;
    err.blockers = plan.blockers;
    throw err;
  }

  const selected = opts.rows || (intake?.portfolio?.rows || []).filter((r) => r.include && !r.blocked);
  const { existingNames, accountBrand } = await readAccount(pit, locationId);
  const { toCreate, skipped } = planProperties(selected, existingNames);

  // Settings first. If provisioning fails the properties are not created, which
  // leaves the account empty rather than half-configured -- an empty account is
  // obviously unfinished, a populated one with no settings looks done.
  const settings = settingsFrom(intake, { brandName: opts.brandName, extra: opts.extra || {} });
  const settingsResult = await provision(pit, locationId, {
    input: settings.input, dryRun: false, overwrite: Boolean(opts.overwrite),
    expectBrand: blank(accountBrand) ? null : opts.brandName,
  });

  const { created, failed } = await importProperties(pit, locationId, toCreate);
  const checklist = checklistFor(intake?.portfolio, toCreate);

  return {
    locationId, brandName: opts.brandName,
    settings: { ...settings, result: settingsResult },
    properties: { created, failed, skipped },
    calendars: checklist,
    // Said plainly, every time. The account is not finished when this returns.
    manualStepsRemaining: [
      ...(checklist.length
        ? [`Create ${checklist.length} rental calendar${checklist.length === 1 ? "" : "s"} by hand -- no API can do it.`] : []),
      ...settingsResult.needsAttention.map((slug) => `Fill ${slug} by hand (webhook or form URL).`),
      ...settings.missing.map((m) => `${m.label} has no source yet (${m.note}).`),
    ],
    appliedAt: new Date().toISOString(),
  };
}
