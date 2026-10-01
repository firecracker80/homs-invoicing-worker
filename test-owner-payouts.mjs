// What the manager owes each owner this period.
// Run: node test-owner-payouts.mjs
//
// "What do I owe each owner" existed nowhere. The manager opened each owner's
// statement one at a time and added them up by hand. Yari asked for it beside
// the manager statement rather than as its own link, and that is the right
// place: it is the manager's payout run, and an owner must never see it --
// owner statements get their own links precisely so each owner sees only
// their own.
//
// Only possible since the recipient_name backfill of 2026-10-01. Before that,
// 52 owner rows carried no name and could not be attributed to anybody.
import assert from "node:assert";

const { queryOwnerPayouts } = await import("./src/manager-pl.js");

const db = (rows) => ({
  LEDGER_DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }) },
});
const row = (recipient_name, total_minor, n = 1, currency = "USD") => ({ recipient_name, currency, total_minor, n });
const run = (rows) => queryOwnerPayouts(db(rows), "LOC", "2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z");

// ---- 1. one line per owner, biggest first --------------------------
{
  const out = await run([row("Elena Marchetti", 15725, 3), row("Carlos Mendoza", 497208, 36)]);
  assert.deepStrictEqual(out.owners.map((o) => [o.name, o.owed, o.entries]), [
    ["Carlos Mendoza", 4972.08, 36],
    ["Elena Marchetti", 157.25, 3],
  ], "ordered by what is owed, because that is the order a payout run is worked in");
  assert.strictEqual(out.total, 5129.33);
  console.log("1) One line per owner, largest first, with a total the manager can pay against");
}

// ---- 2. refunds are already netted in ------------------------------
// Elena's three rows are 629 in, 629 straight back out, 157.25 retained. The
// ledger sums them; this must not add the gross.
{
  const out = await run([row("Elena Marchetti", 15725, 3)]);
  assert.strictEqual(out.owners[0].owed, 157.25,
    "what she is actually owed, not the 629.00 that passed through her property");
  console.log("2) A cancelled booking nets off, so an owner is not owed money that was refunded");
}

// ---- 3. a row with no owner name is reported, never dropped --------
// The failure that would go unnoticed until an owner complained: money earned
// for somebody, attributable to nobody, silently absent from the payout run.
{
  const out = await run([row("Carlos Mendoza", 10000, 2), row(null, 8800, 2)]);
  assert.strictEqual(out.owners.length, 1, "it is not invented as an owner");
  assert.deepStrictEqual(out.unattributed, { owed: 88, entries: 2 });
  assert.strictEqual(out.total, 100, "and it is NOT in the total, because nobody can be paid it");
  console.log("3) Money with no owner on it is reported separately and kept out of the total");
}

// ---- 4. an empty string is as nameless as a null -------------------
// recipient_name is written by several paths; one of them could write "".
{
  const out = await run([row("", 5000, 1)]);
  assert.strictEqual(out.owners.length, 0);
  assert.strictEqual(out.unattributed.owed, 50);
  console.log("4) An empty name is treated as no name, not as an owner called nothing");
}

// ---- 5. two currencies for one owner are not added -----------------
// Same refusal the rest of this module makes: a blended figure is a wrong
// number that looks right, and this one would be paid out.
{
  const out = await run([row("Carlos Mendoza", 10000, 1, "USD"), row("Carlos Mendoza", 300000, 1, "DOP")]);
  assert.strictEqual(out.owners.length, 1, "still one owner");
  assert.strictEqual(out.owners[0].entries, 2);
  assert.strictEqual(out.owners[0].mixedCurrency, true, "flagged, so the page can refuse to show a figure");
  assert.strictEqual(out.owners[0].currency, null);
  console.log("5) An owner with two currencies is flagged rather than given a blended total");
}

// ---- 6. a single currency is carried, so the page can label it -----
{
  const out = await run([row("Rosa", 10000, 1, "DOP")]);
  assert.strictEqual(out.owners[0].mixedCurrency, false);
  assert.strictEqual(out.owners[0].currency, "DOP");
  console.log("6) A single-currency owner carries that currency, so the amount is labelled correctly");
}

// ---- 7. a period with no owner income ------------------------------
{
  const out = await run([]);
  assert.deepStrictEqual(out, { owners: [], total: 0, unattributed: null });
  console.log("7) A period with nothing owed reports nothing owed, rather than failing");
}

// ---- 8. it reaches the rendered page -------------------------------
// Every case above proves the query. None proves the report shows it: deleting
// the whole block from the template passes all seven.
{
  const { handleManagerPL } = await import("./src/reports.js");
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ records: [] }) });

  const LEDGER_DB = {
    prepare: (sql) => ({
      bind: () => ({
        all: async () => ({
          results: sql.includes("recipient = 'owner'")
            ? [{ recipient_name: "Carlos Mendoza", currency: "USD", total_minor: 497208, n: 36 },
               { recipient_name: null, currency: "USD", total_minor: 8800, n: 2 }]
            : sql.includes("cleaning_fee")
              ? [{ total_minor: 0 }]
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
    new Request("https://w.dev/reports/manager-pl?locationId=l&token=t"), envFor(tenant))).text();

  const en = await render({});
  assert.match(en, /Owner payouts/, "the block is on the page");
  assert.ok(en.includes("Carlos Mendoza") && en.includes("USD 4972.08"));
  assert.match(en, /does not record whether a payout has been made/,
    "and says what it is NOT, so a manager does not pay twice");
  assert.match(en, /USD 88\.00 across 2 entr\(ies\) is not attributed/, "the unattributed money is called out");

  const es = await render({ statementLocale: "es" });
  assert.match(es, /Pagos a propietarios/);
  assert.match(es, /No registra si el pago ya se realizó/);
  assert.ok(es.includes("Carlos Mendoza"), "an owner's name is data and stays as it is");
  assert.ok(!es.includes("Owner payouts"), "and no English heading survives");
  console.log("8) The payout block renders on the page, in either language, and says what it is not");
}

console.log("\nPASS — the manager can see what every owner is owed, and what cannot be paid to anybody.");
