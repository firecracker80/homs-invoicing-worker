// Per-owner revenue split: the owner's own contact overrides the account value.
//
// What each case must be able to FAIL for, stated so the suite cannot quietly
// become a tautology:
//  - a resolver that ignored the contact entirely would fail cases 1 and 7
//  - a resolver that treated "unset" as 0% would fail case 2 and pass case 3
//  - a resolver that coerced garbage with Number() would fail cases 4 and 5
//  - a resolver that read the PERCENT as a fraction would fail case 1 (0.70 vs 70)
import { fetchContactPayout } from "./src/ghl.js";

const FIELD_ID = "s8wc4LKKg2bvWGHaDpW7";
const LOC = "ZghxU8I60bEm39JUbtCm";

function stub(splitValue, { fieldMissing = false, contactThrows = false } = {}) {
  globalThis.fetch = async (url) => {
    if (contactThrows) throw new Error("network");
    // ghlRequest reads res.text() and JSON.parses it -- a stub exposing only
    // .json() returns undefined for everything, which makes every assertion
    // "null" and the whole suite pass vacuously. It did exactly that once.
    const body = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o) });
    if (String(url).includes("/customFields")) {
      return body({ customFields: fieldMissing ? [] : [{ id: FIELD_ID, fieldKey: "contact.revenue_split_owner_" }] });
    }
    const customFields = splitValue === "ABSENT" ? [] : [{ id: FIELD_ID, value: splitValue }];
    return body({ contact: { firstName: "Carlos", lastName: "Mendoza", customFields } });
  };
}

let failed = 0;
const check = (name, got, want) => {
  const ok = Object.is(got, want);
  if (!ok) failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

console.log("per-owner revenue split\n");

stub(70);
let r = await fetchContactPayout("pit", LOC, "c1");
check("1. 70 on the contact becomes the FRACTION 0.70", r.ownerPct, 0.7);
check("   name still resolved from the same response", r.name, "Carlos Mendoza");

stub("ABSENT");
r = await fetchContactPayout("pit", LOC, "c1");
check("2. unset -> null, so the caller falls back to the account", r.ownerPct, null);
// Unset is the NORMAL case. A warning here would fire for every owner who
// has no split set, and a warning that cries wolf is worse than none --
// the only thing it guards is a garbled percentage moving real money.
check("   ...and stays SILENT, because unset is not a fault", r.note, null);

stub(0);
r = await fetchContactPayout("pit", LOC, "c1");
check("3. a deliberate 0 is HONOURED, not treated as unset", r.ownerPct, 0);

stub("eighty-five");
r = await fetchContactPayout("pit", LOC, "c1");
check("4. garbage -> null, not NaN and not 0", r.ownerPct, null);
check("   and it says so rather than failing silently", typeof r.note, "string");

stub(140);
r = await fetchContactPayout("pit", LOC, "c1");
check("5. out of range (140) refused", r.ownerPct, null);
stub(-5);
r = await fetchContactPayout("pit", LOC, "c1");
check("   out of range (-5) refused", r.ownerPct, null);

stub(70, { fieldMissing: true });
r = await fetchContactPayout("pit", LOC, "c1");
check("6. field not defined on the location -> null, no throw", r.ownerPct, null);

stub(70, { contactThrows: true });
r = await fetchContactPayout("pit", LOC, "c1");
check("7. a failed lookup never breaks settlement", r.ownerPct, null);

stub(70);
r = await fetchContactPayout("pit", null, "c1");
check("8. no locationId -> name only, no split guess", r.ownerPct, null);

// The arithmetic the ledger applies, checked independently of the fetch layer.
const round2 = (n) => Math.round(n * 100) / 100;
const basis = 1000;
for (const [pct, owner, mgr] of [[0.7, 700, 300], [0.85, 850, 150], [0, 0, 1000], [1, 1000, 0]]) {
  const o = round2(basis * pct);
  check(`9. split ${pct * 100}% -> owner ${owner}, manager ${mgr}, sums to basis`,
        `${o}/${round2(basis - o)}`, `${owner}/${mgr}`);
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
