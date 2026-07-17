// deposit-engine.js (v3) — rule-driven, matching Financial Profiles."Deposit Rule"
// Rules:
//   "disabled"     → no deposit
//   "fixed"        → flat amount (Deposit Amount)
//   "per_night"    → Deposit Amount × nights
//   "percent"      → Deposit Amount % of rent (or rent+cleaning if appliedToTotal)
//   "tiered"       → Option B tiers (default; the JT1 pilot rule):
//                      1–3 nights full rent | 4–16 → 1wk | 17–23 → 3wks | 24–30 → 50%
//                      30-night blocks for long stays, tails ≤3 nights absorbed

const BLOCK = 30;
const TAIL_ABSORB = 3;

function round2(n) { return Math.round(n * 100) / 100; }

function tierLabel(nights) {
  if (nights <= 3)  return "full_rent";
  if (nights <= 16) return "1_week";
  if (nights <= 23) return "3_weeks";
  return "50_percent";
}

function depositForBlock(nights, nightlyRate) {
  if (nights <= 0) return 0;
  switch (tierLabel(nights)) {
    case "full_rent":  return round2(nights * nightlyRate);
    case "1_week":     return round2(7 * nightlyRate);
    case "3_weeks":    return round2(21 * nightlyRate);
    case "50_percent": return round2(0.5 * nights * nightlyRate);
  }
}

function calcTiered(totalNights, nightlyRate) {
  const blocks = [];
  let remaining = totalNights, index = 1;
  while (remaining > 0) {
    let n = Math.min(remaining, BLOCK);
    if (remaining - n > 0 && remaining - n <= TAIL_ABSORB) n = remaining;
    blocks.push({ block: index, nights: n, tier: tierLabel(n), amount: depositForBlock(n, nightlyRate) });
    remaining -= n; index++;
  }
  return { blocks, totalDeposit: round2(blocks.reduce((s, b) => s + b.amount, 0)) };
}

// Main entry. depositConfig mirrors the Financial Profile:
//   { rule: "tiered"|"fixed"|"per_night"|"percent"|"disabled",
//     amount: number,           // Fixed: flat $ | Per Night: $/night | Percent: % (e.g. 20)
//     appliedToTotal: boolean } // Percent only: base includes cleaning fee
function calcSecurityDeposit(totalNights, nightlyRate, depositConfig = {}, cleaningFee = 0) {
  const rule = (depositConfig.rule || "tiered").toLowerCase().replace(/[\s%]+/g, "_");
  const amt = depositConfig.amount ?? 0;

  switch (rule) {
    case "disabled":
      return { rule, blocks: [], totalDeposit: 0 };
    case "fixed":
    case "fixed_amount": {
      const total = round2(amt);
      return { rule: "fixed", blocks: total > 0 ? [{ block: 1, nights: totalNights, tier: "fixed", amount: total }] : [], totalDeposit: total };
    }
    case "per_night": {
      const total = round2(amt * totalNights);
      return { rule, blocks: total > 0 ? [{ block: 1, nights: totalNights, tier: "per_night", amount: total }] : [], totalDeposit: total };
    }
    case "percent":
    case "_of_stay":
    case "percent_of_stay": {
      const base = round2(totalNights * nightlyRate + (depositConfig.appliedToTotal ? cleaningFee : 0));
      const total = round2((amt / 100) * base);
      return { rule: "percent", blocks: total > 0 ? [{ block: 1, nights: totalNights, tier: `percent_${amt}`, amount: total }] : [], totalDeposit: total };
    }
    case "tiered":
    default: {
      const r = calcTiered(totalNights, nightlyRate);
      return { rule: "tiered", ...r };
    }
  }
}

export { calcSecurityDeposit, depositForBlock, tierLabel, round2 };
