// The cleaning fee is revenue; the cleaner is a cost against it.
// Run: node test-cleaning-margin.mjs
//
// Yari, 2026-10-01: the cleaner is paid out of the retained cleaning fee. Until
// that day nothing anywhere subtracted them, so the manager's "income" included
// 1,125.00 of cleaning fees on DEMO-HOMS, most of which belonged to somebody
// else. A statement that confidently overstates a person's own income is worse
// than no statement, because that person is the one who knows it is wrong.
//
// The cost lives on the cleaning job rather than in Expenses: the job already
// knows the property, the booking, the date, the cleaner and the turnover type,
// and deep cleans cost more than standard turnovers.
import assert from "node:assert";

const {
  buildCleaningSummary, cleaningJobOf, buildManagerPL, fetchCleaningJobs,
} = await import("./src/manager-pl.js");

const job = (p) => ({ id: p.id || "j", properties: p });
const WINDOW = { from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" };

// ---- 1. the margin is fee minus cleaner, not the fee -----------------
{
  const s = buildCleaningSummary({
    ...WINDOW,
    collected: 325,
    jobs: [
      job({ cleaner_cost: { value: 40 }, cleaner_paid_on: "2026-09-10" }),
      job({ cleaner_cost: { value: 45 }, cleaner_paid_on: "2026-09-18" }),
      job({ cleaner_cost: { value: 40 }, cleaner_paid_on: "2026-09-29" }),
    ],
  });
  assert.strictEqual(s.collected, 325);
  assert.strictEqual(s.paidToCleaners, 125);
  assert.strictEqual(s.margin, 200, "what the manager actually keeps, not the 325 they collected");
  assert.strictEqual(s.jobsCounted, 3);
  console.log("1) Cleaning margin is the fee less what the cleaners were paid");
}

// ---- 2. a clean with no cost recorded is named, not absorbed ---------
// The failure this exists to prevent. A missing cost does not read as zero
// anywhere; it inflates the margin by an unknown amount, so the page has to say
// how many it is relying on.
{
  const s = buildCleaningSummary({
    ...WINDOW,
    collected: 325,
    jobs: [
      job({ id: "a", cleaner_cost: { value: 40 }, cleaner_paid_on: "2026-09-10" }),
      job({ id: "b", completion_date: "2026-09-15", property_name: "Vila Verde", cleaner_name__service: "Rosa" }),
      job({ id: "c", completion_date: "2026-09-20", property_name: "Villa Azul" }),
    ],
  });
  assert.strictEqual(s.paidToCleaners, 40);
  assert.strictEqual(s.jobsWithoutCost.length, 2, "both uncosted cleans are reported");
  assert.deepStrictEqual(s.jobsWithoutCost.map((j) => j.propertyName), ["Vila Verde", "Villa Azul"],
    "named by property, so somebody can go and fix the record");
  assert.strictEqual(s.jobsWithoutCost[0].cleaner, "Rosa");
  // And the margin is NOT silently corrected -- it still reads 285, which is
  // why the count beside it matters.
  assert.strictEqual(s.margin, 285);
  console.log("2) A clean with no cost recorded is named and counted, so the margin is not quietly trusted");
}

// ---- 3. cash basis: paid, not merely done ---------------------------
// The rest of this module counts an expense in the period it was paid. A clean
// done in September and paid in October is an October cost, or the two reports
// disagree about the same money.
{
  const s = buildCleaningSummary({
    ...WINDOW,
    collected: 200,
    jobs: [
      job({ cleaner_cost: { value: 40 }, completion_date: "2026-09-28", cleaner_paid_on: "2026-10-03" }),
      job({ cleaner_cost: { value: 50 }, completion_date: "2026-08-30", cleaner_paid_on: "2026-09-02" }),
    ],
  });
  assert.strictEqual(s.paidToCleaners, 50, "paid in September counts; paid in October does not, whatever the clean date");
  assert.strictEqual(s.jobsCounted, 1);
  console.log("3) A clean counts in the period the cleaner was paid, matching how expenses are counted");
}

// ---- 4. work done and not yet paid is a liability, not a cost -------
{
  const s = buildCleaningSummary({
    ...WINDOW,
    collected: 200,
    jobs: [
      job({ cleaner_cost: { value: 40 }, cleaner_paid_on: "2026-09-10" }),
      job({ cleaner_cost: { value: 35 }, completion_date: "2026-09-20" }),
      job({ cleaner_cost: { value: 35 }, completion_date: "2026-09-25" }),
    ],
  });
  assert.strictEqual(s.paidToCleaners, 40, "an unpaid cleaner is not yet a cost on a cash basis");
  assert.strictEqual(s.unpaidCleaners, 70, "but the manager owes it, so it is stated");
  assert.strictEqual(s.unpaidCleanerJobs, 2);
  assert.strictEqual(s.jobsWithoutCost.length, 0, "and these are not 'missing a cost' -- the cost is known");
  console.log("4) Work done and not yet paid is reported as owed, separately from costs incurred");
}

// ---- 5. split by turnover type, because the rates differ ------------
{
  const s = buildCleaningSummary({
    ...WINDOW,
    collected: 400,
    jobs: [
      job({ cleaner_cost: { value: 40 }, cleaner_paid_on: "2026-09-05", turnover_type: "standard_turnover" }),
      job({ cleaner_cost: { value: 40 }, cleaner_paid_on: "2026-09-12", turnover_type: "standard_turnover" }),
      job({ cleaner_cost: { value: 90 }, cleaner_paid_on: "2026-09-19", turnover_type: "deep_clean" }),
    ],
  });
  assert.deepStrictEqual(
    s.byTurnover.map((t) => [t.label, t.total, t.count]),
    [["Deep Clean", 90, 1], ["Standard Turnover", 80, 2]],
    "ordered by spend, labelled for a reader"
  );
  console.log("5) Cleaner spend splits by turnover type, where the rate difference lives");
}

// ---- 6. a refunded cleaning fee nets off --------------------------
// `collected` comes from the ledger, where a cancellation writes a negative
// cleaning row. If a booking is cancelled and the fee returned, the manager
// kept nothing -- and may be out of pocket if the cleaner already went.
{
  const s = buildCleaningSummary({ ...WINDOW, collected: 0, jobs: [job({ cleaner_cost: { value: 40 }, cleaner_paid_on: "2026-09-10" })] });
  assert.strictEqual(s.margin, -40, "a fee refunded after the cleaner was paid is a real loss, shown as one");
  console.log("6) A cleaning fee refunded on cancellation nets off, and can go negative");
}

// ---- 7. it reaches the bottom line, not just its own box -----------
// The mistake that would make the page disagree with itself: reporting the
// cleaner cost in the cleaning block while leaving it out of net.
{
  const pl = buildManagerPL({
    income: { total: 1000, byCurrency: [], mixedCurrency: false },
    records: [], from: WINDOW.from, to: WINDOW.to, reportCurrency: "USD",
    cleaningCollected: 300,
    jobs: [
      job({ cleaner_cost: { value: 40 }, cleaner_paid_on: "2026-09-10" }),
      job({ cleaner_cost: { value: 60 }, cleaner_paid_on: "2026-09-20" }),
    ],
  });
  assert.strictEqual(pl.expensesBeforeCleaners, 0, "there were no ordinary expenses");
  assert.strictEqual(pl.expenses, 100, "the cleaners are an expense");
  assert.strictEqual(pl.net, 900, "and they come off the bottom line: 1000 income less 100 paid out");
  assert.strictEqual(pl.cleaning.margin, 200);
  console.log("7) Cleaner cost reaches expenses and net, not only the cleaning block");
}

// ---- 8. an account with none of this is unchanged -------------------
// Every account today. No jobs, no cleaner costs, nothing recorded -- the P&L
// must read exactly as it did before this existed.
{
  const pl = buildManagerPL({
    income: { total: 500, byCurrency: [], mixedCurrency: false },
    records: [], from: WINDOW.from, to: WINDOW.to, reportCurrency: "USD",
  });
  assert.strictEqual(pl.net, 500);
  assert.strictEqual(pl.expenses, 0);
  assert.strictEqual(pl.cleaning.paidToCleaners, 0);
  assert.strictEqual(pl.cleaning.jobsWithoutCost.length, 0);
  assert.strictEqual(pl.cleaning.collected, 0);
  console.log("8) An account with no cleaning data recorded reports exactly what it did before");
}

// ---- 9. the money field in every shape GHL returns -----------------
{
  assert.strictEqual(cleaningJobOf(job({ cleaner_cost: { value: 40, currency: "default" } })).cost, 40);
  assert.strictEqual(cleaningJobOf(job({ cleaner_cost: 40 })).cost, 40, "a bare number, from an older write path");
  assert.strictEqual(cleaningJobOf(job({ cleaner_cost: "40" })).cost, 40);
  // The one that matters: an empty field must not read as a real zero, or an
  // unfilled form would count as "the cleaner was free".
  assert.strictEqual(cleaningJobOf(job({ cleaner_cost: "" })).cost, null);
  assert.strictEqual(cleaningJobOf(job({ cleaner_cost: null })).cost, null);
  assert.strictEqual(cleaningJobOf(job({})).cost, null);
  assert.strictEqual(cleaningJobOf(job({ cleaner_cost: { value: 0 } })).cost, 0, "but a real zero is a real zero");
  console.log("9) An empty cleaner cost reads as missing, never as a free clean");
}

// ---- 10. an account without the object at all ----------------------
// jobs_tmpl is part of the HOMS snapshot, so an account provisioned before it
// existed has no such object. GHL answers that with a 404, which must not take
// the whole P&L down -- the same guard the dashboard already has.
{
  const realFetch = global.fetch;
  global.fetch = async () => ({
    ok: false, status: 404,
    text: async () => JSON.stringify({ message: "Custom Object (custom_objects.jobs_tmpl) not found" }),
  });
  assert.deepStrictEqual(await fetchCleaningJobs("pit", "loc"), [], "no object means no cleans, not an outage");

  global.fetch = async () => ({ ok: false, status: 401, text: async () => "{}" });
  await assert.rejects(() => fetchCleaningJobs("pit", "loc"), (e) => e.status === 401,
    "but a dead token still fails loudly");
  global.fetch = realFetch;
  console.log("10) An account without the cleaning object reports no cleans; a dead token still errors");
}

// ---- 11. the page, which is the only thing anyone reads -------------
// Cases 1-10 prove the arithmetic. None of them prove the page shows it:
// deleting the whole cleaning block from the template passes every one. This
// renders the real handler and reads what a manager would see -- in both
// languages, because a Spanish account is the one that will open it.
{
  const { handleManagerPL } = await import("./src/reports.js");

  // Expenses and cleaning jobs are both fetched from /records/search, so the
  // mock has to tell them apart or every expense is read as a clean too.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    const isJobs = String(url).includes("jobs_tmpl");
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({
        records: isJobs && body.page === 1 ? [
          job({ id: "p1", cleaner_cost: { value: 40 }, cleaner_paid_on: "2026-09-10" }),
          job({ id: "p2", cleaner_cost: { value: 60 }, cleaner_paid_on: "2026-09-20" }),
          job({ id: "owed", cleaner_cost: { value: 35 }, completion_date: "2026-09-22" }),
          job({ id: "nocost", completion_date: "2026-09-25", property_name: "Vila Verde" }),
        ] : [],
      }),
    };
  };

  // Manager income 1,000 of which 300 is cleaning. The two queries are told
  // apart by their SQL, so the cleaning figure is its own number rather than
  // the whole income repeated.
  const LEDGER_DB = {
    prepare: (sql) => ({
      bind: () => ({
        all: async () => ({
          results: sql.includes("cleaning_fee")
            ? [{ total_minor: 30000 }]
            : [{ currency: "USD", total_minor: 100000, n: 4 }],
        }),
      }),
    }),
  };
  const envFor = (tenant) => ({
    TENANTS: { get: async () => ({ brandName: "Casa Bonita", currency: "USD", managerReportToken: "t", ghlPit: "pit", ...tenant }) },
    LEDGER_DB,
  });
  const render = async (tenant) => (await handleManagerPL(
    new Request("https://w.dev/reports/manager-pl?locationId=l&token=t&from=2026-09-01&to=2026-09-30"),
    envFor(tenant))).text();

  const en = await render({});
  assert.match(en, /Cleaning fees collected/, "the cleaning block is on the page at all");
  assert.ok(en.includes("USD 300.00"), "the fee collected");
  assert.ok(en.includes("USD -100.00"), "what went to cleaners, shown as money leaving");
  assert.ok(en.includes("USD 200.00"), "and what was kept");
  assert.match(en, /1 clean\(s\) in this period have no cleaner cost recorded/,
    "the uncosted clean is called out where the reader cannot miss it");
  assert.match(en, /USD 35\.00 is owed to cleaners/, "and so is the cleaner still waiting to be paid");
  assert.ok(en.includes("USD 900.00"), "net is income less the cleaners, not income alone");

  const es = await render({ statementLocale: "es" });
  assert.match(es, /Tarifas de limpieza cobradas/);
  assert.match(es, /Pagado a los limpiadores/);
  assert.match(es, /Retenido por limpieza/);
  assert.match(es, /no tienen costo de limpiador registrado/, "the warning translates too");
  assert.match(es, /Se deben USD 35\.00 a los limpiadores/);
  for (const leak of ["Cleaning fees collected", "Paid to cleaners", "is owed to cleaners"]) {
    assert.ok(!es.includes(leak), `"${leak}" is still English on a Spanish P&L`);
  }
  globalThis.fetch = realFetch;
  console.log("11) The rendered P&L shows the cleaning block and both warnings, in either language");
}

// ---- 12. three states, because "unknown" is not "zero" ---------------
// Yari, 2026-10-05, on how the cleaner cost gets captured: "that will depend on
// what the client is paying his employee or cleaning service. we can't set
// that." HOMS provides the field; the number is the client's, and plenty of
// accounts will leave it empty.
//
// So an empty field is the normal case, not a defect to warn about and move on
// from. The margin is fee MINUS cleaner: with no cleaner figure, "collected
// - 0" is not a margin earned at no cost, it is an unknown printed as profit.
{
  const costed = (id, on) => job({ id, cleaner_cost: { value: 50 }, cleaner_paid_on: on });
  const uncosted = (id) => job({ id, completion_date: "2026-09-25" });

  const exact = buildCleaningSummary({ ...WINDOW, collected: 300, jobs: [costed("a", "2026-09-10")] });
  assert.strictEqual(exact.marginKnown, true);
  assert.strictEqual(exact.marginIsCeiling, false, "nothing is missing, so the figure is the figure");
  assert.strictEqual(exact.margin, 250);

  const ceiling = buildCleaningSummary({ ...WINDOW, collected: 300, jobs: [costed("a", "2026-09-10"), uncosted("b")] });
  assert.strictEqual(ceiling.marginKnown, true, "some cost is known, so a figure can still be given");
  assert.strictEqual(ceiling.marginIsCeiling, true, "but only as an upper bound");
  assert.strictEqual(ceiling.costMissing, 1);
  assert.strictEqual(ceiling.margin, 250, "the arithmetic is unchanged -- only what it is called");

  const unknown = buildCleaningSummary({ ...WINDOW, collected: 300, jobs: [uncosted("b"), uncosted("c")] });
  assert.strictEqual(unknown.marginKnown, false, "no cost anywhere means there is no margin to state");
  assert.strictEqual(unknown.marginIsCeiling, false, "and it is not a ceiling either -- it is nothing");
  assert.strictEqual(unknown.costMissing, 2);

  // An account that records no cleaning jobs at all is not the same as one that
  // records them and leaves the cost blank. Nothing is missing, so nothing is
  // doubtful -- this is the ordinary case for every account before cleaning is
  // set up, and it must not sprout warnings.
  const none = buildCleaningSummary({ ...WINDOW, collected: 300, jobs: [] });
  assert.strictEqual(none.marginKnown, true);
  assert.strictEqual(none.marginIsCeiling, false);
  assert.strictEqual(none.costMissing, 0);
  console.log("12) Margin is exact, a ceiling, or unknown -- and an empty cost is never read as a free clean");
}

// ---- 13. the page refuses to invent the figure ----------------------
// Case 12 proves the flags. It does not prove the page honours them: leaving
// the template alone passes all of it, and the template is the only thing
// anybody reads. This renders the real handler with every clean uncosted and
// asserts the fabricated number is GONE, in both languages.
{
  const { handleManagerPL } = await import("./src/reports.js");
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    const isJobs = String(url).includes("jobs_tmpl");
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({
        records: isJobs && body.page === 1
          ? [job({ id: "n1", completion_date: "2026-09-12", property_name: "Vila Verde" }),
             job({ id: "n2", completion_date: "2026-09-20", property_name: "Casa Azul" })]
          : [],
      }),
    };
  };
  const env = {
    TENANTS: { get: async (k, o) => ({ brandName: "Casa Bonita", currency: "USD", managerReportToken: "t", ghlPit: "pit" }) },
    LEDGER_DB: {
      prepare: (sql) => ({
        bind: () => ({
          all: async () => ({
            results: sql.includes("cleaning_fee") ? [{ total_minor: 30000 }]
                                                  : [{ currency: "USD", total_minor: 100000, n: 4 }],
          }),
        }),
      }),
    },
  };
  const page = await (await handleManagerPL(
    new Request("https://w.dev/reports/manager-pl?locationId=l&token=t&from=2026-09-01&to=2026-09-30"), env)).text();

  assert.ok(page.includes("USD 300.00"), "the fee collected is known and still shown");

  // Scoped to the cleaning block. "USD 0.00" appears legitimately above it --
  // expenses really are zero here -- so checking the whole page would fail on
  // a true figure and prove nothing about the false one.
  const start = page.indexOf("Cleaning fees collected");
  const block = page.slice(start, page.indexOf("</table>", start));
  assert.ok(!block.includes("USD 0.00"),
    "nothing in the cleaning block claims zero was paid to cleaners -- the fabrication this fixes");
  assert.strictEqual((block.match(/USD 300\.00/g) || []).length, 1,
    "the fee appears once, as collected, and is not restated as what the manager kept");
  assert.match(page, /cannot be worked out/, "the page says why it is blank instead of leaving a gap");

  // The bottom line was overstated by the same missing cost, so it is marked too.
  assert.match(page, /Net \(at most\)/, "the net says it is an upper bound");

  const es = await (await handleManagerPL(
    new Request("https://w.dev/reports/manager-pl?locationId=l&token=t&from=2026-09-01&to=2026-09-30"),
    { ...env, TENANTS: { get: async () => ({ brandName: "Casa Bonita", currency: "USD", managerReportToken: "t", ghlPit: "pit", statementLocale: "es" }) } })).text();
  // \s+ because the source string wraps across lines, as the English one does.
  assert.match(es, /no\s+se puede calcular/, "the explanation translates");
  assert.match(es, /Neto \(como máximo\)/, "and so does the bound on the net");
  assert.ok(!es.includes("cannot be worked out"), "with no English left behind");
  assert.ok(!es.includes("Net (at most)"));

  globalThis.fetch = realFetch;
  console.log("13) With no cleaner cost recorded, the page shows no margin and says why, in either language");
}

// ---- 14. a partial record is labelled, not silently averaged --------
// The commonest real state: a client fills some jobs in and not others. The
// figure is still useful -- it is the most the manager can have kept -- but
// printing it unqualified is the same overstatement in a smaller size.
{
  const { handleManagerPL } = await import("./src/reports.js");
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({
        records: String(url).includes("jobs_tmpl") && body.page === 1
          ? [job({ id: "c", cleaner_cost: { value: 100 }, cleaner_paid_on: "2026-09-10" }),
             job({ id: "n", completion_date: "2026-09-25" })]
          : [],
      }),
    };
  };
  const page = await (await handleManagerPL(
    new Request("https://w.dev/reports/manager-pl?locationId=l&token=t&from=2026-09-01&to=2026-09-30"),
    {
      TENANTS: { get: async () => ({ brandName: "B", currency: "USD", managerReportToken: "t", ghlPit: "pit" }) },
      LEDGER_DB: { prepare: (sql) => ({ bind: () => ({ all: async () => ({
        results: sql.includes("cleaning_fee") ? [{ total_minor: 30000 }] : [{ currency: "USD", total_minor: 100000, n: 4 }],
      }) }) }) },
    })).text();

  assert.match(page, /Kept on cleaning \(at most\)/, "the figure is given, and bounded");
  assert.ok(page.includes("USD 200.00"), "with the arithmetic unchanged");
  assert.match(page, /the real\s+figure is lower/, "and the reason stated once, near the figure");
  assert.match(page, /Net \(at most\)/, "and the bottom line carries the same bound");

  // The other half of the same claim: a period where every clean IS costed must
  // come out completely unqualified. Without this, marking everything "at most"
  // unconditionally passes -- which is its own kind of wrong, because a hedge
  // on every figure teaches the reader to ignore it on the ones that mean it.
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({
        records: String(url).includes("jobs_tmpl") && body.page === 1
          ? [job({ id: "c1", cleaner_cost: { value: 60 }, cleaner_paid_on: "2026-09-10" }),
             job({ id: "c2", cleaner_cost: { value: 40 }, cleaner_paid_on: "2026-09-25" })]
          : [],
      }),
    };
  };
  const complete = await (await handleManagerPL(
    new Request("https://w.dev/reports/manager-pl?locationId=l&token=t&from=2026-09-01&to=2026-09-30"),
    {
      TENANTS: { get: async () => ({ brandName: "B", currency: "USD", managerReportToken: "t", ghlPit: "pit" }) },
      LEDGER_DB: { prepare: (sql) => ({ bind: () => ({ all: async () => ({
        results: sql.includes("cleaning_fee") ? [{ total_minor: 30000 }] : [{ currency: "USD", total_minor: 100000, n: 4 }],
      }) }) }) },
    })).text();

  assert.ok(!complete.includes("(at most)"), "a fully-costed period is stated flatly, with no hedging");
  assert.ok(!complete.includes("figure is lower"), "and carries no bounding note");
  assert.ok(complete.includes("USD 200.00"), "while still giving the figure");
  globalThis.fetch = realFetch;
  console.log("14) A partly-recorded period is bounded; a fully-recorded one is stated flatly");
}

console.log("\nPASS — the cleaning fee is revenue, the cleaner is a cost, an unrecorded cost is never a free clean, and an unknown margin is never printed as one.");
