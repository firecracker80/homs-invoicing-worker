// Native-first policies (2026-09-16): guest-friendly defaults, Luminara's
// graduated model only behind depositPolicy "tiered_legacy", cleaning fee no
// longer charged by the Worker, Pet Fee dropped when the guest has no pet.
import assert from "node:assert";
import { composeBooking } from "./src/booking-composer.js";
import { cancellationTier, calcCancellation } from "./src/cancellation.js";
import { enrichAndSendInvoice } from "./src/ghl-invoice.js";
import { yesNo, depositConfigFor, parseCancellationPolicy, isPetFeeName } from "./src/policy.js";

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
async function enrich(hasPets, items, tenant = native) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || "GET", body: opts.body ? JSON.parse(opts.body) : null });
    const body = /\/send$/.test(url) ? {} : (opts.method === "PUT" ? { _id: "inv1" } : {
      _id: "inv1", name: "Reserva", currency: "USD", invoiceNumber: "000020",
      issueDate: "2026-09-16T04:00:00.000Z", dueDate: "2026-09-17T04:00:00.000Z", invoiceItems: items
    });
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const snapshot = { bookingId: "BK-1", stay: { nights: 1, nightlyRate: 500 }, charges: { rentTotal: 500, cleaningFee: 0, processingFee: 30, feePct: 0.06, grandTotal: 530 }, securityDeposit: { total: 0 }, payout: { ownerPct: 0.85, basis: 500, owner: 425, manager: 75 } };
  const out = await enrichAndSendInvoice({ tenant, env: {}, locationId: "L1", invoiceId: "inv1", snapshot, contact: { id: "c1", phoneNo: "8090000000" }, userId: "u1", hasPets }, fetchImpl);
  const put = calls.find(c => c.method === "PUT");
  return { names: put.body.invoiceItems.map(i => i.name), items: put.body.invoiceItems, out, snapshot };
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
  assert.ok(renamed.names.includes("Pet cleaning"), "a different fee that mentions pets is kept");

  const spanish = await enrich("No", [{ name: "Estadía", amount: 100, qty: 2 }, { name: "Tarifa por Mascota", amount: 25, qty: 1 }]);
  assert.deepEqual(spanish.names, ["Estadía", "Cargo por procesamiento / Processing fee"], "Spanish pet fee dropped on No");

  for (const n of ["Pet Fee", " PET FEE ", "Tarifa por mascota", "Cargo por Mascotas", "Mascota", "Pet Fee / Tarifa por mascota", "Cargo de mascota - Pet fee", "Tarifa de mascóta"])
    assert.ok(isPetFeeName(n), `"${n}" is the pet fee`);
  for (const n of ["Limpieza de mascota", "Pet cleaning", "Limpieza / Cleaning fee", "Estadía", "", null, "Depósito por mascota"])
    assert.ok(!isPetFeeName(n), `"${n}" is not the pet fee`);
  assert.ok(isPetFeeName("Depósito por mascota", { petFeeName: "Deposito por mascota" }), "tenant petFeeName adds a client's own wording");
  assert.ok(isPetFeeName("Animal fee", { petFeeName: ["x", "animal fee"] }), "petFeeName may be a list");

  // INV-000005 replayed: webhook stayTotal said 500, GHL billed the stay at 135.
  const inv5 = await enrich("No", [
    { name: "Arpel 07", amount: 135, qty: 1 }, { name: "Cleaning Fee", amount: 65, qty: 1 }, { name: "Pet Fee", amount: 25, qty: 1 }
  ]);
  assert.equal(inv5.snapshot.charges.rentTotal, 135, "rent comes from GHL's stay line, not stayTotal");
  assert.equal(inv5.snapshot.charges.processingFee, 12, "6% of the whole invoice after the pet check: 6% of 200");
  assert.equal(inv5.items.find(i => /Processing fee/.test(i.name)).amount, 12, "the appended fee line carries the repriced fee");
  assert.equal(inv5.snapshot.charges.grandTotal, 212);
  assert.deepEqual([inv5.snapshot.payout.basis, inv5.snapshot.payout.owner, inv5.snapshot.payout.manager], [135, 114.75, 20.25], "split follows the real rent");
  assert.equal(inv5.snapshot.stay.nightlyRate, 135);
  const withPet = await enrich("Sí", [
    { name: "Arpel 07", amount: 135, qty: 1 }, { name: "Cleaning Fee", amount: 65, qty: 1 }, { name: "Pet Fee", amount: 25, qty: 1 }
  ]);
  assert.equal(withPet.snapshot.charges.processingFee, 13.5, "a kept pet fee is part of the fee basis: 6% of 225");
  const leg = await enrich("No", [{ name: "Arpel 07", amount: 135, qty: 2 }], legacy);
  assert.equal(leg.snapshot.securityDeposit.total, 270, "legacy deposit is sized from the real stay line (1 night = full rent, 270)");
  assert.equal(leg.snapshot.charges.processingFee, 32.4, "fee also covers the legacy deposit: 6% of 270 + 270");
  console.log("   Amounts from GHL's invoice: INV-000005 replay -> rent 135, fee 12 (was 500 / 30)");

  assert.equal(yesNo("NO"), false);
  assert.equal(yesNo(" Si "), true);
  assert.equal(yesNo("Sí"), true);
  assert.equal(yesNo(["No"]), false, "a checkbox field comes through as a list");
  assert.equal(yesNo('["No"]'), false, "or as that list rendered to JSON text");
  assert.equal(yesNo('["Sí"]'), true);
  assert.equal(yesNo(["No", "Sí"]), null, "two answers are unknown -- the fee stays");
  assert.equal(yesNo([]), null);
  assert.equal(yesNo("NO."), null, "punctuation makes it unknown -- the fee stays");
  assert.equal(yesNo("maybe"), null);
  console.log("3) invoice: Pet Fee dropped only on a clear No; native cleaning recorded, never appended");
}

// ---- 4. WCancellation Policy text ----
{
  assert.deepEqual(parseCancellationPolicy(""), { tiers: [], checkedInChargePct: 0, unparsed: [] });
  assert.deepEqual(parseCancellationPolicy("none").tiers, []);
  const p = parseCancellationPolicy("5d 20%; 24 horas 50%\nllegada 100%");
  assert.deepEqual(p.tiers, [{ underHours: 24, chargePct: 0.5 }, { underHours: 120, chargePct: 0.2 }]);
  assert.equal(p.checkedInChargePct, 1);
  assert.deepEqual(parseCancellationPolicy("48h, 10%").unparsed, ["48h", "10%"], "a rule needs both a window and a share");
  const tenant = { cancellationPolicy: parseCancellationPolicy("24h 50%, 5d 20%") };
  const anchor = Date.parse("2026-10-10T00:00:00Z") + 19 * 3600000;
  assert.equal(cancellationTier("2026-10-10", anchor - 50 * 3600000, tenant).chargePct, 0.2, "parsed policy drives the cancellation");
  console.log("4) WCancellation Policy text parses (English/Spanish, h/d), bad rules reported");
}

console.log("\nPASS — native-first policies.");
