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
assert.equal(t.platformFee, 0);
assert.equal(t.netPayout, 275);

const plain = normalizeTransaction(rec({ booking_total: 120, net_payout: "99.5" }));
assert.equal(plain.bookingTotal, 120, "a bare number still counts");
assert.equal(plain.netPayout, 99.5);
assert.equal(normalizeTransaction(rec({})).bookingTotal, null);
console.log("PASS — transaction amounts unwrap { value, currency }; bare numbers still read");
