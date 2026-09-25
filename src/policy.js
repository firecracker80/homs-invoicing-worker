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
    .map(t => {
      const tier = { underHours: Number(t?.underHours), chargePct: pct(t?.chargePct) };
      // A nights tier keeps whole nights, not a share of the rent. Both shapes
      // live in the same list; whichever fields are present decide the maths.
      const nights = Number(t?.nights);
      if (Number.isFinite(nights) && nights > 0) {
        tier.nights = nights;
        tier.remainderPct = pct(t?.remainderPct);
        delete tier.chargePct;
      }
      return tier;
    })
    .filter(t => Number.isFinite(t.underHours) && t.underHours > 0)
    .sort((a, b) => a.underHours - b.underHours);
  return { tiers, checkedInChargePct: pct(p.checkedInChargePct), grace: graceOf(p.grace) };
}

// A grace window only counts if both halves are real numbers -- a half-written
// one would hand back a full refund on a booking that should be charged.
function graceOf(g) {
  const within = Number(g?.withinHoursOfBooking);
  const lead = Number(g?.minHoursBeforeCheckIn);
  if (!Number.isFinite(within) || within <= 0) return null;
  return { withinHoursOfBooking: within, minHoursBeforeCheckIn: Number.isFinite(lead) && lead > 0 ? lead : 0 };
}

// GHL form answers arrive as human text. true = yes, false = no, null = unknown.
// A checkbox/radio field can also come through as a list: ["No"], or the
// JSON text '["No"]' when a merge tag renders it. One answer is read as that
// answer; more than one is unknown.
export function yesNo(v) {
  let x = v;
  if (typeof x === "string" && /^\s*\[/.test(x)) { try { x = JSON.parse(x); } catch { /* leave as text */ } }
  if (Array.isArray(x)) { if (x.length !== 1) return null; x = x[0]; }
  const s = String(x ?? "").trim().toLowerCase();
  if (["yes", "y", "si", "sí", "true", "1", "on"].includes(s)) return true;
  if (["no", "n", "false", "0", "off"].includes(s)) return false;
  return null;
}

// GHL custom value "WCancellation Policy" -> cancellationPolicy.
// Plain text, one rule per comma: how close to check-in, then the share of
// rent kept. Blank or "none" = full refund.
//   "24h 50%, 5d 20%, check-in 100%"
//   = under 24 hours keep 50%, under 5 days keep 20%, after check-in keep 100%
// Spanish works too: "24h 50%, 5 dias 20%, llegada 100%".
// Airbnb's five standard policies, written in this format. Yari's clients list
// on Airbnb and their guests already understand these terms, so HOMS matches
// them rather than approximating one.
//
// Source: airbnb.com/help/article/475, read 2026-09-25. These decide real
// refunds, so re-read it before changing a number here.
//   Flexible  full refund up to 24h before check-in; after that the host keeps
//             the nights spent plus one more.
//   Moderate  full refund up to 5 days before; after that, nights spent plus
//             one more, plus 50% of the nights that go unused.
//   Limited   full refund up to 14 days before; 50% from 7 to 14 days; nothing
//             inside 7 days. (Airbnb: bookings from 1 Oct 2025 onward.)
//   Firm      as Limited, but the full-refund window is 30 days.
//   Strict    no full-refund window at all: 50% until 7 days before, nothing
//             inside 7. Invitation-only on Airbnb, offered here to any client.
//   Grace     every standard policy: full refund within 24h of BOOKING, as long
//             as check-in is still 7+ days away.
//
// Two deliberate departures from Airbnb, both pre-dating this table:
//   - after check-in HOMS keeps 100%, where Airbnb pro-rates the nights left.
//     That is the existing HOMS rule (checkedInChargePct) and every client so
//     far has wanted it; changing it is a client decision, not a policy one.
//   - Strict here carries the same 24h/7d grace as the others, because Airbnb
//     does not publish a separate one for an invitation-only policy.
//
// A night is not a percentage: one night of a ten-night stay is 10%, of a
// one-night stay it is 100%. That is why the format had to grow -- writing
// Flexible as "keep 100% inside 24h" would take seven times too much from a
// week-long booking.
export const AIRBNB_POLICIES = {
  flexible: "grace 24h/7d, 24h 1n, check-in 100%",
  moderate: "grace 24h/7d, 5d 1n+50%, check-in 100%",
  limited:  "grace 24h/7d, 7d 100%, 14d 50%, check-in 100%",
  firm:     "grace 24h/7d, 7d 100%, 30d 50%, check-in 100%",
  strict:   "grace 24h/7d, 7d 100%, 3650d 50%, check-in 100%",
};

const hoursOf = (n, unit) => (/^h/i.test(unit) ? Number(n) : Number(n) * 24);

// The client picks a name in the workbook, not a formula. Spanish names count
// because the first clients are in the DR. Anything else is read as a written
// rule, and if that fails it lands in unparsed rather than being guessed at.
const POLICY_ALIASES = {
  flexible: "flexible", flexibles: "flexible",
  moderate: "moderate", moderada: "moderate", moderado: "moderate",
  limited: "limited", limitada: "limited", limitado: "limited",
  firm: "firm", firme: "firm",
  strict: "strict", estricta: "strict", estricto: "strict",
};

export function airbnbPolicyKey(text) {
  // "Moderada (5 días)" and "moderate" are the same answer. Anything in
  // brackets is the client's own note, so it is dropped before matching.
  const k = normName(String(text ?? "").split("(")[0]);
  return POLICY_ALIASES[k] || null;
}

export function parseCancellationPolicy(text) {
  const tiers = [];
  let checkedInChargePct = 0;
  let grace = null;
  const unparsed = [];
  let raw = String(text ?? "").trim();
  if (!raw || /^(none|ninguna|no)$/i.test(raw)) return { tiers, checkedInChargePct, grace, unparsed };
  const named = airbnbPolicyKey(raw);
  if (named) raw = AIRBNB_POLICIES[named];
  for (const part of raw.split(/[,;\n]+/).map(p => p.trim()).filter(Boolean)) {
    // "grace 24h/7d" -- full refund within 24h of booking, as long as check-in
    // is still 7+ days away. Only ever one, and it beats every tier.
    const g = part.match(/^grace\s+(\d+(?:\.\d+)?)\s*([a-z]+)\s*\/\s*(\d+(?:\.\d+)?)\s*([a-z]+)$/i);
    if (g) {
      grace = { withinHoursOfBooking: hoursOf(g[1], g[2]), minHoursBeforeCheckIn: hoursOf(g[3], g[4]) };
      continue;
    }
    const share = part.match(/(\d+(?:\.\d+)?)\s*%/);
    const nights = part.match(/(\d+)\s*(?:n|nights?|noches?)\b/i);
    const window = part.match(/(\d+(?:\.\d+)?)\s*(h|hr|hrs|hora|horas|hour|hours|d|dia|dias|día|días|day|days)\b/i);
    if (share && /check.?in|llegada|entrada/i.test(part) && !window) {
      checkedInChargePct = pct(share[1]);
    } else if (nights && window) {
      // "1n" = keep one night. "1n+50%" = one night plus half of what is left.
      tiers.push({
        underHours: hoursOf(window[1], window[2]),
        nights: Number(nights[1]),
        remainderPct: share ? pct(share[1]) : 0,
      });
    } else if (share && window) {
      const n = Number(window[1]);
      tiers.push({ underHours: /^h/i.test(window[2]) ? n : n * 24, chargePct: pct(share[1]) });
    } else {
      unparsed.push(part);
    }
  }
  tiers.sort((a, b) => a.underHours - b.underHours);
  return { tiers, checkedInChargePct, grace, unparsed };
}

// The Pet Fee line GHL adds, by name. Clients start in the DR, so Spanish
// names count too. A bilingual name ("Pet Fee / Tarifa por mascota") matches
// on either half. A client with its own wording sets tenant.petFeeName.
// Deliberately exact (after trimming case and accents): "Limpieza de mascota"
// or "Pet cleaning" are not the pet fee and are never removed.
const PET_FEE_NAMES = new Set([
  "pet fee", "pet fees", "pet", "pets",
  "mascota", "mascotas",
  "tarifa por mascota", "tarifa de mascota", "tarifa mascota", "tarifa por mascotas", "tarifa de mascotas",
  "cargo por mascota", "cargo de mascota", "cargo mascota", "cargo por mascotas", "cargo de mascotas",
  "cuota por mascota", "cuota de mascota", "fee de mascota", "fee por mascota"
]);

const normName = s => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .toLowerCase().replace(/\s+/g, " ").trim();

export function isPetFeeName(name, tenant) {
  const names = new Set(PET_FEE_NAMES);
  for (const extra of [].concat(tenant?.petFeeName || [])) names.add(normName(extra));
  return String(name ?? "").split(/\s*[\/|]\s*|\s+-\s+/).some(part => names.has(normName(part)));
}
