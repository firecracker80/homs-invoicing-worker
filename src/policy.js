// policy.js -- guest-facing money policy per tenant (decided 2026-09-16).
//
// Default is guest-friendly: GHL's native Security Deposit collects the
// deposit (the Worker adds none), and cancellation keeps only what the
// tenant's own cancellationPolicy says -- nothing if it has none.
//
// Luminara's graduated model (deposit sized up to a full stay's rent, rent
// retained on cancellation by notice period) is kept, but only for a tenant
// that explicitly carries depositPolicy: "tiered_legacy". It is the exception
// a client asks for, never the default for new ones.
//
// Native cancellationPolicy (tenant KV), all fractions of rent:
//   { tiers: [{ underHours: 24, chargePct: 0.5 }, { underHours: 120, chargePct: 0.2 }],
//     checkedInChargePct: 1 }
// A cancellation `underHours` before check-in is charged at the first tier it
// falls under; outside every tier it is a full rent refund.

export const LEGACY_POLICY = "tiered_legacy";

export function isLegacyPolicy(tenant) {
  return tenant?.depositPolicy === LEGACY_POLICY;
}

export function depositConfigFor(tenant) {
  return isLegacyPolicy(tenant) ? (tenant.deposit || { rule: "tiered" }) : { rule: "disabled" };
}

function pct(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 1 ? Math.min(n / 100, 1) : n; // "50" and 0.5 both mean half
}

export function nativeCancellationPolicy(tenant) {
  const p = tenant?.cancellationPolicy || {};
  const tiers = (Array.isArray(p.tiers) ? p.tiers : [])
    .map(t => ({ underHours: Number(t?.underHours), chargePct: pct(t?.chargePct) }))
    .filter(t => Number.isFinite(t.underHours) && t.underHours > 0)
    .sort((a, b) => a.underHours - b.underHours);
  return { tiers, checkedInChargePct: pct(p.checkedInChargePct) };
}

// GHL form answers arrive as human text. true = yes, false = no, null = unknown.
export function yesNo(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (["yes", "y", "si", "sí", "true", "1", "on"].includes(s)) return true;
  if (["no", "n", "false", "0", "off"].includes(s)) return false;
  return null;
}
