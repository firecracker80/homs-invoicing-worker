// Transaction money fields are GHL MONETORY objects ({ value, currency }).
// Reading them raw made Number(obj) = NaN in the table and 0 in every total.
import assert from "node:assert";
import { normalizeTransaction } from "./src/normalize.js";

const rec = (props) => ({ id: "t1", properties: props, relations: [] });
const t = normalizeTransaction(rec({
  booking_total: { currency: "default", value: 275 },
  platform_fee: { currency: "default", value: 0 },
  net_payout: { currency: "default", value: 275 },
}));
assert.equal(t.bookingTotal, 275);

// platform_fee and net_payout are not read, as of 2026-10-16. The Worker
// stopped writing them -- GHL marketplace fields HOMS never computed, where
// net_payout was only ever a copy of booking_total -- and old records still
// carry the stale values, so the record above deliberately still has both.
// Asserted as absent rather than simply deleted: mapping them again would
// put a number nothing produced back in front of a client.
assert.ok(!("platformFee" in t), "platform_fee must not be read back onto the record");
assert.ok(!("netPayout" in t), "nor net_payout, which was never a payout");

const plain = normalizeTransaction(rec({ booking_total: 120 }));
assert.equal(plain.bookingTotal, 120, "a bare number still counts");
assert.equal(normalizeTransaction(rec({})).bookingTotal, null);
console.log("PASS — transaction amounts unwrap { value, currency }; bare numbers still read");
