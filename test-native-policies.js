// Native-first policies (2026-09-16): guest-friendly defaults, Luminara's
// graduated model only behind depositPolicy "tiered_legacy", cleaning fee no
// longer charged by the Worker, Pet Fee dropped when the guest has no pet.
import assert from "node:assert";
import { composeBooking } from "./src/booking-composer.js";
import { cancellationTier, calcCancellation } from "./src/cancellation.js";
import { enrichAndSendInvoice } from "./src/ghl-invoice.js";
import { yesNo, depositConfigFor } from "./src/policy.js";

const base = { currency: "USD", ownerPct: 0.85, processingFeePct: 0.06, ghlPit: "pit", defaultCleaningFee: 69, deposit: { rule: "tiered" } };
const native = { ...base };
const legacy = { ...base, depositPolicy: "tiered_legacy" };
const payload = { bookingId: "BK-1", locationId: "L1", checkIn: "2026-10-01", checkOut: "2026-10-03", bookingTotal: 200, cleaningFee: 50, guest: { name: "G" } };

// ---- 1. deposit + cleaning in the composer ----
{
  const n = composeBooking(payload, native);
  assert.equal(n.snapshot.securityDeposit.total, 0, "native: GHL collects the deposit, the Worker adds none");
  assert.equal(n.purchaseUnits.length, 1, "native: no DEP purchase unit");
  assert.equal(n.snapshot.charges.cleaningFee, 0, "cleaning is never charged by the Worker, even with payload/tenant amounts");
  assert.ok(!n.purchaseUnits[0].items.some(i => /limpieza/i.test(i.name)), "no cleaning line on the PayPal order");
  assert.equal(n.snapshot.charges.processingFee, 12, "fee on rent only: 6% of 200");

  const l = composeBooking(payload, legacy);
  assert.equal(l.snapshot.securityDeposit.total, 200, "legacy: tiered deposit, 2 nights = full rent (unchanged)");
  assert.equal(l.purchaseUnits.length, 2);
  assert.equal(l.snapshot.charges.cleaningFee, 0, "cleaning retired for legacy too");

  assert.deepEqual(depositConfigFor({ deposit: { rule: "fixed", amount: 300 } }), { rule: "disabled" }, "a stray deposit config does not switch native tenants back on");
  assert.deepEqual(depositConfigFor({ depositPolicy: "tiered_legacy", deposit: { rule: "fixed", amount: 300 } }), { rule: "fixed", amount: 300 });
  console.log("1) native: no Worker deposit; legacy: tiered deposit kept; cleaning never charged");
}

// ---- 2. cancellation policy ----
{
  const checkIn = "2026-10-10";
  const anchor = Date.parse(`${checkIn}T00:00:00Z`) + (15 + 4) * 3600000; // 3 PM AST
  const at = h => anchor - h * 3600000;

  for (const h of [200, 50, 10, -5]) {
    const t = cancellationTier(checkIn, at(h), native);
    assert.equal(t.chargePct, 0, `native default keeps nothing (${h}h)`);
  }
  assert.equal(cancellationTier(checkIn, at(200), native).tier, "full_refund");

  const custom = { ...base, cancellationPolicy: { tiers: [{ underHours: 120, chargePct: 20 }, { underHours: 24, chargePct: 0.5 }], checkedInChargePct: 1 } };
  assert.equal(cancellationTier(checkIn, at(200), custom).chargePct, 0);
  assert.equal(cancellationTier(checkIn, at(50), custom).chargePct, 0.2, "percent written as 20 means 0.2");
  assert.equal(cancellationTier(checkIn, at(10), custom).chargePct, 0.5, "tiers are sorted; the tightest one wins");
  assert.equal(cancellationTier(checkIn, at(10), custom).tier, "under_24h");
  assert.equal(cancellationTier(checkIn, at(-5), custom).chargePct, 1);
  assert.equal(cancellationTier(checkIn, at(10), custom, "Sí").chargePct, 0, "exception still overrides");

  const ladder = [[200, 0.2, "over_5d"], [50, 0.3, "24h_to_5d"], [10, 0.5, "under_24h"], [-5, 1, "already_checked_in"]];
  for (const [h, pct, tier] of ladder) {
    const t = cancellationTier(checkIn, at(h), { ...legacy, cancellationPolicy: { tiers: [] } });
    assert.equal(t.chargePct, pct, `legacy ladder unchanged at ${h}h`);
    assert.equal(t.tier, tier);
  }
  assert.equal(cancellationTier(checkIn, at(10), legacy, "full_refund").chargePct, 0);

  const snap = { stay: { checkIn }, charges: { rentTotal: 1000, cleaningFee: 0, processingFee: 60 }, securityDeposit: { total: 0 }, payout: { ownerPct: 0.85 } };
  assert.equal(calcCancellation(snap, at(10), native).totalRefund, 1000, "native default: all rent back, fee retained");
  assert.equal(calcCancellation(snap, at(10), legacy).totalRefund, 500);
  console.log("2) cancellation: native default full refund, per-tenant tiers honoured, legacy ladder unchanged");
}

// ---- 3. pet fee + native cleaning on the GHL invoice ----
async function enrich(hasPets, items) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || "GET", body: opts.body ? JSON.parse(opts.body) : null });
    const body = /\/send$/.test(url) ? {} : (opts.method === "PUT" ? { _id: "inv1" } : {
      _id: "inv1", name: "Reserva", currency: "USD", invoiceNumber: "000020",
      issueDate: "2026-09-16T04:00:00.000Z", dueDate: "2026-09-17T04:00:00.000Z", invoiceItems: items
    });
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const snapshot = { bookingId: "BK-1", charges: { rentTotal: 200, cleaningFee: 0, processingFee: 12 }, securityDeposit: { total: 0 } };
  const out = await enrichAndSendInvoice({ tenant: native, env: {}, locationId: "L1", invoiceId: "inv1", snapshot, contact: { id: "c1", phoneNo: "8090000000" }, userId: "u1", hasPets }, fetchImpl);
  const put = calls.find(c => c.method === "PUT");
  return { names: put.body.invoiceItems.map(i => i.name), out, snapshot };
}
{
  const ghlItems = [
    { name: "Estadía", amount: 100, qty: 2, currency: "USD" },
    { name: "Cleaning Fee", amount: 45, qty: 1, currency: "USD" },
    { name: "Pet Fee", amount: 25, qty: 1, currency: "USD" }
  ];
  const no = await enrich("No", ghlItems);
  assert.deepEqual(no.names, ["Estadía", "Cleaning Fee", "Cargo por procesamiento / Processing fee"], "No -> Pet Fee dropped; nothing else touched, no cleaning appended");
  assert.equal(no.out.removedItems, 1);
  assert.equal(no.snapshot.charges.cleaningFee, 45, "GHL's own cleaning line is recorded for the owner/manager split");
  assert.equal(no.snapshot.charges.cleaningFeeSource, "ghl_native");

  for (const ans of ["Sí", "yes", "", null, "{{contact.pets}}"]) {
    const r = await enrich(ans, ghlItems);
    assert.ok(r.names.includes("Pet Fee"), `"${ans}" keeps the Pet Fee`);
    assert.equal(r.out.removedItems, 0);
  }
  const renamed = await enrich("no", [{ name: "Estadía", amount: 100, qty: 2 }, { name: "Pet cleaning", amount: 25, qty: 1 }]);
  assert.ok(renamed.names.includes("Pet cleaning"), "only the exact 'Pet Fee' name is dropped");

  assert.equal(yesNo("NO"), false);
  assert.equal(yesNo(" Si "), true);
  assert.equal(yesNo("maybe"), null);
  console.log("3) invoice: Pet Fee dropped only on a clear No; native cleaning recorded, never appended");
}

console.log("\nPASS — native-first policies.");
