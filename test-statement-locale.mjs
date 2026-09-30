// A statement renders in the language its reader reads.
// Run: node test-statement-locale.mjs
//
// The labels landed in English (#90) on a product whose clients are in the
// Dominican Republic. Yari, 2026-09-30: the statement is the one artefact an
// owner opens alone, so English labels mean the document does not work for the
// person it was built for.
//
// The risk in a change like this is not a wrong translation -- that is visible
// and cheap to fix. It is a HALF-translated page (chrome in one language,
// labels in the other), an account that silently loses its English, or a
// number whose separators moved. Each case below is one of those.
import assert from "node:assert";

const {
  resolveLocale, entryLabel, categoryLabel, STATEMENT_LOCALES, LABELLED_ENTRY_TYPES,
  handleOwnerStatement, handleManagerStatement,
} = await import("./src/reports.js");

const urlFor = (qs) => new URL(`https://w.dev/x${qs}`);

// ---- 1. where the language comes from, in order ---------------------
{
  // ?lang= first, so one GHL merge tag can set it per send on an account whose
  // owners do not all read the same language.
  assert.strictEqual(resolveLocale(urlFor("?lang=es"), { statementLocale: "en" }), "es",
    "the query param beats the tenant, or a per-owner send cannot switch language");
  assert.strictEqual(resolveLocale(urlFor(""), { statementLocale: "es" }), "es");
  assert.strictEqual(resolveLocale(urlFor(""), {}), "en", "an account that says nothing keeps English");
  assert.strictEqual(resolveLocale(urlFor(""), null), "en", "and so does no tenant at all");
  console.log("1) Language comes from the link first, then the account, then English");
}

// ---- 2. the shapes a real registry entry and a real merge tag send ---
// tenant config is hand-edited JSON and the query param is rendered by GHL, so
// neither arrives normalised.
{
  for (const v of ["es", "ES", " es ", "es-DO", "es_DO", "Español", "espanol", "spanish"]) {
    assert.strictEqual(resolveLocale(urlFor(""), { statementLocale: v }), "es", `${JSON.stringify(v)} is Spanish`);
  }
  for (const v of ["en", "EN", "en-US", "English"]) {
    assert.strictEqual(resolveLocale(urlFor(""), { statementLocale: v }), "en", `${JSON.stringify(v)} is English`);
  }
  // The three aliases, because a registry entry might use any of them.
  assert.strictEqual(resolveLocale(urlFor(""), { locale: "es" }), "es");
  assert.strictEqual(resolveLocale(urlFor(""), { language: "es" }), "es");
  console.log("2) Every shape of the locale a registry entry or merge tag sends is read");
}

// ---- 3. a locale nobody implemented renders English, not nothing -----
// The failure this must not become: a merge tag GHL could not resolve arrives
// as its own literal text, and a typo arrives as a typo. Either one keying
// into an empty table would render a statement of blank headings and blank
// labels -- worse than one in the wrong language, because it looks broken
// rather than foreign.
{
  assert.strictEqual(resolveLocale(urlFor("?lang={{custom_values.wstatement_lang}}"), {}), "en",
    "an unresolved merge tag falls back rather than rendering empty");
  assert.strictEqual(resolveLocale(urlFor("?lang=fr"), {}), "en", "a locale nobody wrote falls back");
  assert.strictEqual(resolveLocale(urlFor("?lang=sp"), {}), "en", "and so does a near-miss typo");
  assert.strictEqual(entryLabel("rent_split_owner", "fr"), "Rent — owner share",
    "a label in an unknown locale is the English label, never blank");
  assert.strictEqual(categoryLabel("income", "fr"), "Income");
  console.log("3) An unknown locale renders English, rather than a page of blanks");
}

// ---- 4. English is unchanged when nobody asks for a language --------
// Every existing caller passes one argument. If that stopped meaning English
// this change would silently relabel every statement already in use.
{
  assert.strictEqual(entryLabel("rent_split_owner"), "Rent — owner share");
  assert.strictEqual(entryLabel("cancellation_rent_refund_manager"), "Rent refunded on cancellation — manager share");
  assert.strictEqual(categoryLabel("pass_through"), "Passed through");
  assert.strictEqual(entryLabel("some_future_type"), "Some future type", "and the slug fallback still works");
  assert.strictEqual(entryLabel("some_future_type", "es"), "Some future type", "in both languages");
  assert.strictEqual(entryLabel(""), "");
  console.log("4) Called the old way it still answers in English, so nothing already live shifts");
}

// ---- 5. every entry type is translated, not just the common ones -----
// A statement with two Spanish rows and one English one is the outcome worth
// guarding: the rare types are exactly the ones nobody would notice, and they
// are the refunds -- the rows an owner reads most carefully.
{
  for (const locale of STATEMENT_LOCALES) {
    const missing = [...LABELLED_ENTRY_TYPES].filter((type) => {
      const label = entryLabel(type, locale);
      return locale !== "en" && label === entryLabel(type, "en");
    });
    assert.deepStrictEqual(missing, [],
      `${locale} is missing a translation for these, so a statement would render half in English: ${missing.join(", ")}`);
  }
  for (const category of ["income", "pass_through", "liability", "shadow"]) {
    assert.notStrictEqual(categoryLabel(category, "es"), categoryLabel(category, "en"),
      `the ${category} category is untranslated`);
  }
  console.log(`5) All ${LABELLED_ENTRY_TYPES.size} entry types and 4 categories are translated in every locale`);
}

// ---- 6. the rendered page, which is the only thing an owner sees -----
// Cases 1-5 prove the tables. They do not prove the template reads them:
// reverting statementHtml to its English literals passes every one of them.
const rows = [
  { entry_type: "rent_split_owner", category: "income", currency: "USD", total_minor: 62900, entry_count: 1,
    booking_id: "BK-ES", amount_minor: 62900, description: null, created_at: "2026-09-30T02:00:00.000Z" },
  { entry_type: "cancellation_rent_refund_owner", category: "income", currency: "USD", total_minor: -62900, entry_count: 1,
    booking_id: "BK-ES", amount_minor: -62900, description: null, created_at: "2026-09-30T03:00:00.000Z" },
  { entry_type: "cancellation_charge_owner", category: "income", currency: "USD", total_minor: 15725, entry_count: 1,
    booking_id: "BK-ES", amount_minor: 15725, description: null, created_at: "2026-09-30T03:00:00.000Z" },
  { entry_type: "processing_fee", category: "pass_through", currency: "USD", total_minor: 4830, entry_count: 1,
    booking_id: "BK-ES", amount_minor: 4830, description: null, created_at: "2026-09-30T02:00:00.000Z" },
];
const envWith = (tenant) => ({
  TENANTS: { get: async () => ({ brandName: "Casa Bonita", currency: "USD", ownerReportToken: "tok", managerReportToken: "mtok", ...tenant }) },
  LEDGER_DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }) },
});
const render = async (qs, tenant = {}, handler = handleOwnerStatement, token = "tok") =>
  (await handler(new Request(`https://w.dev/reports/statement?locationId=L1&token=${token}${qs}`), envWith(tenant))).text();

{
  const html = await render("&lang=es");

  assert.match(html, /<html lang="es"/, "the document declares its language, for screen readers and translate prompts");
  assert.match(html, /Estado de cuenta del propietario/, "the heading");
  assert.match(html, /Total generado/, "the total card");
  assert.match(html, /Solo reservas directas/, "the scope note, which is the paragraph that prevents a wrong conclusion");
  assert.match(html, /Por concepto/, "the section headings");
  assert.match(html, /Detalle/);
  assert.match(html, /Concepto|Categoría|Monto|Fecha|Reserva/, "the column headers");
  assert.match(html, /Alquiler — parte del propietario/, "and the labels themselves");
  assert.match(html, /Alquiler reembolsado por cancelación — parte del propietario/);
  assert.match(html, /Cargo por cancelación — parte del propietario/);
  assert.match(html, /Tarifa de procesamiento de pago/);
  assert.match(html, /Transferido/, "including the category");
  console.log("6) A Spanish statement renders Spanish throughout -- headings, notes, columns and labels");
}

// ---- 7. nothing English survives on a Spanish page -----------------
// The half-translated failure, checked from the other direction. Matching the
// Spanish strings cannot catch an English heading that is still there too.
{
  const html = await render("&lang=es");
  for (const leak of [
    "Owner statement", "Total earned", "Direct bookings only", "By type", ">Detail<",
    "Entry type", "No entries in this period", "Rent — owner share", "Passed through",
  ]) {
    assert.ok(!html.includes(leak), `"${leak}" is still in English on a Spanish statement`);
  }
  // And the slugs stay out of reach in either language. The CSS class keeps the
  // raw category because it drives the colour, so this looks for cell text.
  assert.doesNotMatch(html, />rent_split_owner</);
  assert.doesNotMatch(html, />pass_through</);
  console.log("7) No English string and no slug survives anywhere on the Spanish page");
}

// ---- 8. the account's own setting is enough, with no link change ----
// Yari configures a client once. Nobody should have to remember to append
// ?lang=es to a statement link, because the link is pasted into GHL templates
// and the one that gets forgotten is the one a client opens.
{
  const html = await render("", { statementLocale: "es" });
  assert.match(html, /<html lang="es"/);
  assert.match(html, /Estado de cuenta del propietario/);
  assert.ok(!html.includes("Total earned"), "a Spanish account gets Spanish with no query param at all");

  const manager = await render("", { statementLocale: "es" }, handleManagerStatement, "mtok");
  assert.match(manager, /Estado de cuenta del administrador/, "the manager statement too, not just the owner one");
  console.log("8) An account configured Spanish renders Spanish from an unchanged link");
}

// ---- 9. the money does not move -------------------------------------
// The one thing a translation must not touch. Spanish convention swaps the
// separators, and 1.234,56 read as 1234.56 is an error of three orders of
// magnitude on a document whose whole purpose is a number. Both languages get
// the unambiguous form, and this asserts the figures are identical rather than
// merely present.
{
  const [en, es] = [await render("&lang=en"), await render("&lang=es")];
  const amounts = (html) => (html.match(/USD -?\d+\.\d{2}/g) || []).sort();

  assert.deepStrictEqual(amounts(es), amounts(en),
    "the same statement in two languages must report the same figures, formatted the same way");
  assert.ok(amounts(en).length >= 4, "and there were figures to compare in the first place");
  assert.ok(es.includes("USD 629.00") && es.includes("USD -629.00") && es.includes("USD 157.25"),
    "a point decimal separator and no thousands separator, in Spanish too");
  // The dates likewise: 03/10 is two different days either side of the Atlantic.
  assert.match(es, /2026-09-30/, "dates stay ISO in Spanish");
  console.log("9) Both languages report byte-identical figures and ISO dates");
}

console.log("\nPASS — a statement renders wholly in its reader's language, and the numbers are untouched by it.");
