// Verify all five Deposit Rule behaviors — 12 nights @ $95, cleaning $60
import { calcSecurityDeposit } from "./deposit-engine.js";
const cases = [
  ["Tiered (default)",        { rule: "tiered" }],
  ["Disabled",                { rule: "disabled" }],
  ["Fixed Amount $500",       { rule: "fixed", amount: 500 }],
  ["Per Night $25",           { rule: "per_night", amount: 25 }],
  ["% of Stay 20% rent-only", { rule: "percent", amount: 20 }],
  ["% of Stay 20% + cleaning",{ rule: "percent", amount: 20, appliedToTotal: true }],
];
for (const [label, cfg] of cases) {
  const r = calcSecurityDeposit(12, 95, cfg, 60);
  console.log(label.padEnd(28), "→ $" + r.totalDeposit.toFixed(2).padStart(8), ` (${r.rule})`);
}
// tiered long-stay regression: tail absorption still intact
const t = calcSecurityDeposit(61, 95, { rule: "tiered" }, 0);
console.log("Tiered 61 nights regression  → $" + t.totalDeposit.toFixed(2), t.blocks.map(b=>`${b.nights}n/${b.tier}`).join("+"));
