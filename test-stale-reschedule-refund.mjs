// The stale-reschedule-refund detector.
//
// Imported, not transcribed. The first version of this test sliced the function
// out of the source by brace-matching and tested the copy -- which would have
// kept passing after the real function changed. It also got the slice wrong,
// which is the only reason the mistake was visible at all.
//
// Each case names what a BROKEN detector would do, so the suite cannot pass by
// being silent:
//   - one ignoring netRentDelta would fire on case 2 (a genuine debt)
//   - one firing on any pending refund would fire on case 1 (single shortening)
//   - one summing wrongly would miss case 6 (two shortenings then an extension)
//   - one requiring exactly 0 net would miss case 4 (net LONGER)
import { staleRescheduleRefund } from "./src/reports.js";

const shorten = (rentDelta, refund) => ({
  rentDelta,
  settlement: { parts: [{ type: "rent_refund_needed_manual", amount: refund }] },
});
const extend = (rentDelta) => ({ rentDelta, settlement: { type: "invoice_balance_due" } });

let failed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

console.log("stale reschedule refund\n");

check("1. one shortening alone -> NOT stale, the refund is genuinely owed",
  staleRescheduleRefund({ reschedules: [shorten(-400, 400)] }), null);

check("2. shorten then partially extend, net still shorter -> NOT stale",
  staleRescheduleRefund({ reschedules: [shorten(-400, 400), extend(200)] }), null);

check("3. shorten then extend back exactly -> STALE (the live case)",
  staleRescheduleRefund({ reschedules: [shorten(-400, 400), extend(400)] }),
  { pending: 400, netRentDelta: 0, reschedules: 2 });

check("4. shorten then extend BEYOND the original -> stale",
  staleRescheduleRefund({ reschedules: [shorten(-400, 400), extend(600)] }),
  { pending: 400, netRentDelta: 200, reschedules: 2 });

check("5. two shortenings, net shorter -> NOT stale",
  staleRescheduleRefund({ reschedules: [shorten(-200, 200), shorten(-200, 200)] }), null);

check("6. two shortenings then a big extension -> stale, refunds SUMMED",
  staleRescheduleRefund({ reschedules: [shorten(-200, 200), shorten(-200, 200), extend(400)] }),
  { pending: 400, netRentDelta: 0, reschedules: 3 });

check("7. extensions only, no refund booked -> nothing to flag",
  staleRescheduleRefund({ reschedules: [extend(200), extend(200)] }), null);

check("8. no reschedules at all -> null, not a crash",
  staleRescheduleRefund({ reschedules: [] }), null);
check("   missing snapshot -> null, not a crash",
  staleRescheduleRefund(null), null);
check("   settlement with no parts -> null",
  staleRescheduleRefund({ reschedules: [{ rentDelta: -400 }, extend(400)] }), null);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
