// The property name, taken from what the guest is being charged for.
// Run: node test-property-from-invoice.mjs
//
// The booking webhook cannot supply it -- the inbound payload carries the
// guest's name in that field and no merge tag fixes it. The invoice already
// names the listing beside the fees, so that is where it comes from instead.
import assert from "node:assert";

const { propertyNameFromInvoice, isFeeLine } = await import("./src/ghl-invoice.js");

const TENANT = { currency: "USD" };
const line = (name, amount = 100) => ({ name, amount, qty: 1 });

// ---- 1. the real invoice shape ------------------------------------------
// Exactly what GHL built for invoice #000008 on DEMO-HOMS.
{
  const { name, reason } = propertyNameFromInvoice([
    line("Test Villa 2", 270), line("Cleaning Fee", 65), line("Pet Fee", 300),
  ], TENANT);
  assert.strictEqual(name, "Test Villa 2");
  assert.strictEqual(reason, null);
  console.log("1) The listing is picked out of a real invoice, past the cleaning and pet fees");
}

// ---- 2. fees are recognised in both languages ---------------------------
// Clients start in the DR, so an invoice may be entirely in Spanish.
{
  for (const fee of [
    "Cleaning Fee", "Limpieza", "Pet Fee", "Tarifa por mascota", "Security Deposit",
    "Depósito de garantía", "Cargo por procesamiento / Processing fee", "ITBIS",
  ]) {
    assert.strictEqual(isFeeLine(line(fee), TENANT), true, `${fee} is a fee, not a property`);
  }
  assert.strictEqual(isFeeLine(line("Test Villa 2"), TENANT), false);
  assert.strictEqual(isFeeLine(line("Residencial Vivas I"), TENANT), false);
  console.log("2) Fee lines are recognised in English and Spanish; listings are not");
}

// ---- 3. it refuses to choose between two candidates ---------------------
// A booking with an add-on has two non-fee lines. Picking the first would
// attribute revenue by whatever order GHL happened to return -- and a wrong
// property keys the wrong owner, so a statement goes to someone with no claim
// on the money. Worse than having none.
{
  const { name, reason } = propertyNameFromInvoice([
    line("Test Villa 2", 270), line("Fridge Stock", 40), line("Cleaning Fee", 65),
  ], TENANT);
  assert.strictEqual(name, null, "two candidates is not a decision to make by guessing");
  assert.match(reason, /ambiguous_2/);
  console.log("3) Two non-fee lines resolve to nothing, and say how many there were");
}

// ---- 4. an invoice of nothing but fees ---------------------------------
{
  const { name, reason } = propertyNameFromInvoice([line("Cleaning Fee", 65), line("Pet Fee", 300)], TENANT);
  assert.strictEqual(name, null);
  assert.strictEqual(reason, "no_non_fee_line_on_invoice");
  assert.strictEqual(propertyNameFromInvoice([], TENANT).reason, "no_non_fee_line_on_invoice");
  console.log("4) An invoice with no listing line resolves to nothing, distinctly from ambiguity");
}

// ---- 5. a blank line name is a fee, not a property ---------------------
// An unnamed line must never become the property name.
{
  assert.strictEqual(isFeeLine(line(""), TENANT), true);
  assert.strictEqual(isFeeLine({}, TENANT), true);
  const { name } = propertyNameFromInvoice([line(""), line("Arpel 07", 135)], TENANT);
  assert.strictEqual(name, "Arpel 07", "a blank line does not make it ambiguous either");
  console.log("5) An unnamed line is treated as a fee, never as the property");
}

// ---- 6. a tenant's own pet-fee wording is honoured ---------------------
// policy.js lets a client name their pet fee whatever they like.
{
  const custom = { currency: "USD", petFeeName: "Cargo por perro" };
  assert.strictEqual(isFeeLine(line("Cargo por perro"), custom), true);
  const { name } = propertyNameFromInvoice([line("Villa Sol", 200), line("Cargo por perro", 50)], custom);
  assert.strictEqual(name, "Villa Sol", "a custom pet-fee name does not become a second candidate");
  console.log("6) A client's own pet-fee wording is recognised as a fee");
}

// ---- the catalog, when the invoice cannot choose --------------------
// Reading the property off the invoice works by elimination: the line that is
// not a fee. That stops working the moment an account sells something the fee
// patterns have never heard of. DEMO-HOMS added Early Check-in and Late
// Check-out, and booking mRHVdjX72Ip49jQckB6W came out with three candidate
// property lines and no property at all -- its owner then fell back to the
// account default rather than the one keyed to Test Villa 3. Invisible on an
// account with one owner; the wrong person credited on an account with several.
{
  const { propertyFromBooking } = await import("./src/ghl-invoice.js");
  const tenant = { ghlPit: "pit" };
  const CATALOG = { s1: "Test Villa 3", s2: "Test Villa 2" };

  const serving = (bookings) => async (url) => {
    const u = String(url);
    const ok = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o) });
    if (u.includes("/calendars/services/bookings/")) return ok(bookings);
    if (u.includes("/calendars/services/catalog/")) {
      const id = u.split("/").pop();
      return CATALOG[id] ? ok({ service: { id, name: CATALOG[id] } })
                         : { ok: false, status: 404, text: async () => "{}" };
    }
    return ok({});
  };
  const resolve = (bookingId, fetchImpl) => propertyFromBooking({ tenant, env: {}, bookingId }, fetchImpl);

  // One booked service: the catalog names it outright.
  assert.strictEqual(
    await resolve("b1", serving({ services: [{ id: "s1" }] })), "Test Villa 3",
    "the booked service's own name, which is the listing");

  // Two is a bundled reservation and has no single property. Picking one would
  // key a per-property owner name to the wrong person -- the same refusal
  // propertyNameFromInvoice already makes, for the same reason.
  assert.strictEqual(
    await resolve("b2", serving({ services: [{ id: "s1" }, { id: "s2" }] })), null,
    "a bundled reservation names no single property");

  // Every way this can fail leaves the caller exactly where it was.
  assert.strictEqual(await resolve("", serving({})), null, "no booking id");
  assert.strictEqual(await resolve("b3", serving({ services: [] })), null, "no booked services");
  assert.strictEqual(await resolve("b4", serving({ services: [{ id: "gone" }] })), null,
    "a catalog entry that cannot be read is not a property name");
  assert.strictEqual(await resolve("b5", async () => { throw new Error("network"); }), null,
    "and neither is a throw");

  // A catalog that answers cleanly with no name. Distinct from the 404 above:
  // this one succeeds, so nothing here refuses on its behalf, and a blank must
  // not become a property that no listing is called.
  assert.strictEqual(
    await resolve("b6", async (url) => ({
      ok: true, status: 200,
      text: async () => JSON.stringify(
        String(url).includes("/catalog/") ? { service: { id: "s1", name: "   " } } : { services: [{ id: "s1" }] }
      ),
    })), null,
    "a nameless catalog entry is not a property");

  console.log("7) The catalog names the listing when the invoice cannot, and refuses when it should");
}

console.log("\nPASS — the property comes from the invoice line that is not a fee, and nothing is guessed when that is unclear.");
