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

console.log("\nPASS — the property comes from the invoice line that is not a fee, and nothing is guessed when that is unclear.");
