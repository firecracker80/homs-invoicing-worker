// reports.js — owner/manager statements + D1-vs-GHL reconciliation.
// Routes (wired in index.js):
//   GET /reports/owner-statement    ?locationId&from&to&format=json|html&token=...&recipientName=...&brandName=...
//   GET /reports/manager-statement  ?locationId&from&to&format=json|html&token=...&recipientName=...&brandName=...
//   GET /reports/reconcile          ?locationId&from&to
//
// recipientName is optional -- only needed for a tenant with more than one
// owner or manager (see ledger.js's per-property name resolution). A tenant
// with just one of each can omit it; recipient alone already scopes the
// whole location's owner/manager rows.
//
// /reconcile is admin-gated (X-Admin-Secret) only, same model as /cancel and
// /reschedule -- it's an internal diagnostic tool, never iframed.
//
// The two statement routes accept EITHER the admin header OR a per-recipient
// ?token=, so they can be embedded as an iframe (e.g. a GHL Custom Menu Link)
// where no custom header can be sent. See statementAuthorized() below for why
// that token is intentionally its own thing, not adminSecret.
//
// Statements are a plain GROUP BY + detail list over ledger_entries, which
// is already the materialized split (see ledger.js) -- no split logic gets
// recomputed here.

import {
  queryManagerIncome, fetchExpenseRecords, buildManagerPL,
  fetchCleaningJobs, queryManagerCleaningIncome, queryOwnerPayouts,
} from "./manager-pl.js";

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
function html(body, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
function fromMinor(n) { return round2((n || 0) / 100); }
function round2(n) { return Math.round(n * 100) / 100; }

function adminAuthorized(request, tenant, env) {
  const given = request.headers?.get?.("X-Admin-Secret") || "";
  if (!given) return false;
  // EITHER the tenant's own secret or the operator's global one.
  //
  // This used to be `tenant?.adminSecret || env.ADMIN_SECRET`, so a tenant that
  // had its own secret REPLACED the global rather than adding to it -- and the
  // admin dashboard, which holds exactly one secret, was then locked out of
  // precisely those accounts. DEMO-HOMS has one, which is why its manager
  // statement 401'd while every other account would have worked (Yari,
  // 2026-10-01).
  //
  // It grants nothing new. env.ADMIN_SECRET already provisions and reconfigures
  // any account, and already worked for every tenant without an override -- and
  // for new tenants, where there is no record to carry one. The old rule was an
  // inconsistency, not a boundary.
  return [tenant?.adminSecret, env.ADMIN_SECRET].some((expected) => expected && given === expected);
}

// Owner/manager statements are meant to be iframed (GHL Custom Menu Link),
// which can't send the X-Admin-Secret header -- so these two routes also
// accept a ?token= query param, checked against a token scoped to just this
// recipient (tenant.ownerReportToken / tenant.managerReportToken). Deliberately
// NOT the same value as adminSecret: adminSecret also gates /cancel and
// /reschedule, and this token ends up sitting in an iframe src (browser
// history, possibly referrer headers) -- a leak of the report token only
// exposes one recipient's statement, not the ability to cancel a booking.
// Scoped per recipient (not one shared report token) so the owner's link
// can't be used to view the manager's numbers, or vice versa.
function statementAuthorized(request, tenant, env, url, tokenField) {
  if (adminAuthorized(request, tenant, env)) return true;
  const expected = tenant?.[tokenField];
  const given = url.searchParams.get("token") || "";
  return Boolean(expected) && given === expected;
}

// Default window: last 30 days, if the caller didn't specify one.
function resolveWindow(url) {
  const now = new Date();

  // period=all means every dated record, which the caller has to ask for.
  //
  // The dashboard's dropdown said "All time" while sending no range at all, so
  // it got the 30-day default and silently hid everything older -- Yari,
  // 2026-10-05: "the all-time is not reflecting the 215 dop from july". The
  // label was not wrong about what she wanted, it was wrong about what it did.
  //
  // Open at both ends rather than "up to today": an expense dated forward, or a
  // booking paid in advance, is still a record of this account and "all" is not
  // a word that should quietly stop at this morning.
  if ((url.searchParams.get("period") || "").toLowerCase() === "all") {
    return {
      from: "0001-01-01T00:00:00.000Z",
      to: "9999-12-31T00:00:00.000Z",
      fromLabel: null, toLabel: null, allTime: true,
    };
  }

  const to = url.searchParams.get("to") || now.toISOString().slice(0, 10);
  const fromDefault = new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10);
  const from = url.searchParams.get("from") || fromDefault;
  // Half-open range [from 00:00:00, to+1day 00:00:00) so "to" is inclusive
  // of that whole day, matching how a human reads a date-range statement.
  const toExclusive = new Date(`${to}T00:00:00.000Z`);
  toExclusive.setUTCDate(toExclusive.getUTCDate() + 1);
  return {
    from: `${from}T00:00:00.000Z`, to: toExclusive.toISOString(),
    fromLabel: from, toLabel: to, allTime: false,
  };
}

// What a client reads, rather than what the database calls it -- in the
// language that client reads it in.
//
// The summary table printed entry_type and category raw -- "rent_split_owner",
// "cancellation_rent_refund_manager", "pass_through". We know what those mean;
// an owner opening their statement does not, and a statement that needs
// explaining is one the manager has to explain (Yari, 2026-09-30).
//
// Those labels then landed in English on a product whose clients are in the
// Dominican Republic, which made the statement readable to us and not to them
// (Yari, 2026-09-30). A statement is the one artefact an owner opens alone,
// with nobody beside them to translate it, so its language is not a polish
// item -- it decides whether the document works at all.
//
// Every type the code can write is here, in every locale. An unrecognised type
// falls back to English and then to its slug with the underscores knocked out,
// so a type added later reads as something rather than as nothing, and none of
// this is ever load-bearing for correctness -- only for how it reads.
const ENTRY_LABELS = {
  en: {
    rent_split_owner: "Rent — owner share",
    rent_split_manager: "Rent — manager share",
    cleaning_fee: "Cleaning fee",
    processing_fee: "Payment processing fee",
    deposit_held: "Security deposit held",

    cancellation_charge_owner: "Cancellation charge — owner share",
    cancellation_charge_manager: "Cancellation charge — manager share",
    cancellation_rent_refund_owner: "Rent refunded on cancellation — owner share",
    cancellation_rent_refund_manager: "Rent refunded on cancellation — manager share",
    cancellation_cleaning_refund: "Cleaning fee refunded on cancellation",
    cancellation_deposit_refund: "Security deposit returned",

    reschedule_admin_fee_owner: "Date-change fee — owner share",
    reschedule_admin_fee_manager: "Date-change fee — manager share",
    reschedule_charge_owner: "Additional rent from date change — owner share",
    reschedule_charge_manager: "Additional rent from date change — manager share",
    reschedule_refund_owner: "Rent refunded on date change — owner share",
    reschedule_refund_manager: "Rent refunded on date change — manager share",

    deposit_refund_inspection: "Security deposit returned after inspection",
    deposit_claim_retained: "Security deposit retained for damages",
    shadow_ota_commission: "Booking platform commission — informational",
    other: "Other",
  },
  // Formal (usted) throughout, and matching the words the Spanish guest-side
  // GHL templates already use -- "Limpieza", "Depósito", "Tarifa de
  // Procesamiento" -- so an owner who reads both does not meet two different
  // names for one charge.
  es: {
    rent_split_owner: "Alquiler — parte del propietario",
    rent_split_manager: "Alquiler — parte del administrador",
    cleaning_fee: "Tarifa de limpieza",
    processing_fee: "Tarifa de procesamiento de pago",
    deposit_held: "Depósito de garantía retenido",

    cancellation_charge_owner: "Cargo por cancelación — parte del propietario",
    cancellation_charge_manager: "Cargo por cancelación — parte del administrador",
    cancellation_rent_refund_owner: "Alquiler reembolsado por cancelación — parte del propietario",
    cancellation_rent_refund_manager: "Alquiler reembolsado por cancelación — parte del administrador",
    cancellation_cleaning_refund: "Tarifa de limpieza reembolsada por cancelación",
    cancellation_deposit_refund: "Depósito de garantía devuelto",

    reschedule_admin_fee_owner: "Cargo por cambio de fechas — parte del propietario",
    reschedule_admin_fee_manager: "Cargo por cambio de fechas — parte del administrador",
    reschedule_charge_owner: "Alquiler adicional por cambio de fechas — parte del propietario",
    reschedule_charge_manager: "Alquiler adicional por cambio de fechas — parte del administrador",
    reschedule_refund_owner: "Alquiler reembolsado por cambio de fechas — parte del propietario",
    reschedule_refund_manager: "Alquiler reembolsado por cambio de fechas — parte del administrador",

    deposit_refund_inspection: "Depósito de garantía devuelto tras la inspección",
    deposit_claim_retained: "Depósito de garantía retenido por daños",
    shadow_ota_commission: "Comisión de plataforma de reservas — informativo",
    other: "Otro",
  },
};

// "liability" is the guest's own money sitting with the client, and "shadow" is
// a number recorded for reference and deliberately excluded from the totals.
// Neither word means that to anybody outside this codebase.
const CATEGORY_LABELS = {
  en: { income: "Income", pass_through: "Passed through", liability: "Held", shadow: "Informational" },
  es: { income: "Ingreso", pass_through: "Transferido", liability: "Retenido", shadow: "Informativo" },
};

// The statement's own chrome -- headings, column headers, and the notes that
// say what is and is not counted. Left in English these would leave a Spanish
// statement half translated, which reads worse than either language alone.
const UI = {
  en: {
    statementHeading: { owner: "Owner statement", manager: "Manager statement" },
    directOnly: "Direct bookings only. Reservations made through a booking platform are paid out by that platform and do not appear here.",
    totalEarned: "Total earned",
    otaNote: (cur, amt) => `A comparable OTA commission on this period&rsquo;s bookings would have been ${cur} ${amt}.`,
    byType: "By type",
    detail: "Detail",
    thEntryType: "Entry type",
    thCategory: "Category",
    thTotal: "Total",
    thCount: "Count",
    thDate: "Date",
    thBooking: "Booking",
    thDescription: "Description",
    thAmount: "Amount",
    noEntries: "No entries in this period.",
    // A reversal carries category "income" with a negative amount, because that
    // is what it is in the ledger: income taken back out. Printing it under
    // "Income" is still wrong to read -- Yari, 2026-10-01: "if there is a
    // refund, shouldn't that be marked something else not income... it's a loss
    // of income." The category is unchanged in the database and every total
    // still nets the same; only the word the client reads changes.
    refund: "Refund",

    plTitle: "Manager P&amp;L",
    plPeriod: (from, to) => `${from} to ${to}`,
    plPeriodAllTime: "All time",
    plIncome: "Income from bookings",
    plExpenses: "Expenses",
    plNet: "Net",
    plNote: (amt) => `Expenses count only the share the manager cannot recover (amount less Can Reimburse).
      ${amt} is recoverable from owners and is not treated as a cost here.`,
    plByCategory: "Expenses by category",
    plNoExpenses: "No approved expenses in this period.",
    plOwnerPayouts: "Owed to owners",
    plOwnerPayoutsNote: "What this period earned for each owner, for you to pay through your own payout method. This page does not move money and does not record whether you have paid.",
    plOwnerPayoutsTotal: "Total owed",
    thOwner: "Owner",
    warnUnattributedPayout: (amt, n) => `<strong>${amt} across ${n} entr(ies) is not attributed to any owner.</strong>
      It cannot be paid to anybody until those rows carry a name, and it is not in the total below.`,
    plCleaning: "Cleaning",
    plCleaningCollected: "Cleaning fees collected",
    plCleaningPaid: "Paid to cleaners",
    plCleaningMargin: "Kept on cleaning",
    plCleaningMarginCeiling: "Kept on cleaning (at most)",
    plNetCeiling: "Net (at most)",
    warnUnattributed: (n) => `<strong>${n} expense(s) do not say who pays for them</strong>
      and are counted against nobody until they do. Set Paid By on each one to Owner or Manager.`,
    plOwnerBorneNote: (n, amt) =>
      `${n} expense(s) totalling ${amt} are the owner's cost, not the manager's, so they are not counted above.`,
    plReimbursableRecorded: (list) =>
      `Recorded as ${list}, converted at the rate stored on each expense.`,
    warnReimbursableUnconvertible: (names) =>
      `<strong>Recoverable from owners cannot be totalled.</strong> These carry an amount in another
      currency with no exchange rate, and converting them by guesswork would be a wrong number that
      looks right: ${names}.`,
    plCleaningNote: (n) => `Across ${n} clean(s) paid for in this period.`,
    plCleaningUnknownNote: (n) =>
      `None of the ${n} clean(s) in this period has a cleaner cost recorded, so what was kept on cleaning
      cannot be worked out. The fee collected is shown; the rest is left blank because there is nothing
      to base it on.`,
    plCeilingNote: `At most: cleans with no cleaner cost recorded are missing from this, so the real
      figure is lower.`,
    warnNoCleanerCost: (n) => `<strong>${n} clean(s) in this period have no cleaner cost recorded.</strong>
      Each one makes the cleaning figure above too high, by an amount nobody can see. Add the cost on the
      cleaning job to correct it.`,
    warnUnpaidCleaners: (amt, n) => `<strong>${amt} is owed to cleaners</strong> across ${n} completed clean(s)
      with no payment date. Not counted as a cost this period, because it has not been paid yet.`,
    warnMixedCurrency: (seen) => `<strong>The ledger holds more than one currency for this manager.</strong>
      Income is not totalled, because adding them would give a number that cannot be right: ${seen}.`,
    warnUnconverted: (n) => `<strong>${n} expense(s) are in another currency with no converted amount</strong>
      and are left out of the total. Converting them by guesswork would be a wrong number that looks right.`,
    warnUnapproved: (n) => `<strong>${n} expense(s) still say &ldquo;Needs Review&rdquo;</strong>
      and are not in the total yet.`,
    warnNoAmount: (n) => `<strong>${n} expense(s) have no amount</strong> and cannot be counted.`,
    warnUndated: (n) => `<strong>${n} expense(s) have no Paid On date</strong>, so they fall
      into no period at all and will appear on no statement until one is set.`,
  },
  es: {
    statementHeading: { owner: "Estado de cuenta del propietario", manager: "Estado de cuenta del administrador" },
    directOnly: "Solo reservas directas. Las reservas hechas a través de una plataforma las paga esa plataforma y no aparecen aquí.",
    totalEarned: "Total generado",
    otaNote: (cur, amt) => `La comisión equivalente de una plataforma sobre las reservas de este período habría sido ${cur} ${amt}.`,
    byType: "Por concepto",
    detail: "Detalle",
    thEntryType: "Concepto",
    thCategory: "Categoría",
    thTotal: "Total",
    thCount: "Cantidad",
    thDate: "Fecha",
    thBooking: "Reserva",
    thDescription: "Descripción",
    thAmount: "Monto",
    noEntries: "No hay movimientos en este período.",
    refund: "Reembolso",

    plTitle: "Estado de resultados del administrador",
    plPeriod: (from, to) => `del ${from} al ${to}`,
    plPeriodAllTime: "Todo el período",
    plIncome: "Ingresos por reservas",
    plExpenses: "Gastos",
    plNet: "Neto",
    plNote: (amt) => `Los gastos cuentan solo la parte que el administrador no puede recuperar (monto menos Reembolsable).
      ${amt} es recuperable de los propietarios y no se trata como costo aquí.`,
    plByCategory: "Gastos por categoría",
    plNoExpenses: "No hay gastos aprobados en este período.",
    plOwnerPayouts: "Adeudado a propietarios",
    plOwnerPayoutsNote: "Lo que este período generó para cada propietario, para que usted lo pague por su propio método. Esta página no transfiere dinero ni registra si ya pagó.",
    plOwnerPayoutsTotal: "Total adeudado",
    thOwner: "Propietario",
    warnUnattributedPayout: (amt, n) => `<strong>${amt} en ${n} registro(s) no está atribuido a ningún propietario.</strong>
      No se le puede pagar a nadie hasta que esos registros lleven un nombre, y no está incluido en el total de abajo.`,
    plCleaning: "Limpieza",
    plCleaningCollected: "Tarifas de limpieza cobradas",
    plCleaningPaid: "Pagado a los limpiadores",
    plCleaningMargin: "Retenido por limpieza",
    plCleaningMarginCeiling: "Retenido por limpieza (como máximo)",
    plNetCeiling: "Neto (como máximo)",
    warnUnattributed: (n) => `<strong>${n} gasto(s) no indican quién los paga</strong>
      y no se cuentan a nadie hasta que lo indiquen. Configure Paid By en cada uno como Owner o Manager.`,
    plOwnerBorneNote: (n, amt) =>
      `${n} gasto(s) por un total de ${amt} son costo del propietario, no del administrador, así que no se cuentan arriba.`,
    plReimbursableRecorded: (list) =>
      `Registrado como ${list}, convertido a la tasa guardada en cada gasto.`,
    warnReimbursableUnconvertible: (names) =>
      `<strong>No se puede totalizar lo recuperable de los propietarios.</strong> Estos tienen un monto en
      otra moneda sin tasa de cambio, y convertirlos por estimación daría una cifra incorrecta con
      apariencia de correcta: ${names}.`,
    plCleaningNote: (n) => `Sobre ${n} limpieza(s) pagada(s) en este período.`,
    plCleaningUnknownNote: (n) =>
      `Ninguna de las ${n} limpieza(s) de este período tiene un costo de limpiador registrado, así que no
      se puede calcular lo retenido por limpieza. Se muestra la tarifa cobrada; el resto queda en blanco
      porque no hay con qué calcularlo.`,
    plCeilingNote: `Como máximo: las limpiezas sin costo de limpiador registrado no están incluidas, así
      que la cifra real es menor.`,
    warnNoCleanerCost: (n) => `<strong>${n} limpieza(s) de este período no tienen costo de limpiador registrado.</strong>
      Cada una hace que la cifra de limpieza de arriba sea más alta de lo real, por un monto que nadie puede ver.
      Agregue el costo en el registro de limpieza para corregirlo.`,
    warnUnpaidCleaners: (amt, n) => `<strong>Se deben ${amt} a los limpiadores</strong> por ${n} limpieza(s)
      completada(s) sin fecha de pago. No se cuenta como costo de este período porque aún no se ha pagado.`,
    warnMixedCurrency: (seen) => `<strong>El libro contable tiene más de una moneda para este administrador.</strong>
      Los ingresos no se suman, porque sumarlos daría una cifra que no puede ser correcta: ${seen}.`,
    warnUnconverted: (n) => `<strong>${n} gasto(s) están en otra moneda sin monto convertido</strong>
      y quedan fuera del total. Convertirlos por estimación daría una cifra incorrecta con apariencia de correcta.`,
    warnUnapproved: (n) => `<strong>${n} gasto(s) siguen marcados como &ldquo;Needs Review&rdquo;</strong>
      y todavía no están en el total.`,
    warnNoAmount: (n) => `<strong>${n} gasto(s) no tienen monto</strong> y no pueden contarse.`,
    warnUndated: (n) => `<strong>${n} gasto(s) no tienen fecha de pago</strong>, así que no caen
      en ningún período y no aparecerán en ningún estado de cuenta hasta que se les asigne una.`,
  },
};

export const STATEMENT_LOCALES = Object.keys(UI);

// Amounts keep the same "USD 1234.56" shape in every locale, deliberately.
// Spanish convention swaps the separators, and a point where the reader expects
// a comma turns 1.234,56 into 1234.56 or the reverse -- a misread of three
// orders of magnitude, on a document whose entire job is a number. An
// unambiguous format in both languages beats an idiomatic one in each. Dates
// stay ISO for the same reason: 03/10 is two different days either side of the
// Atlantic.

const titleCase = (slug) => {
  const s = String(slug || "").replace(/_/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : "";
};

// ?lang= wins, so a GHL merge tag can set the language per send on an account
// with owners who read in different ones; then the tenant's own setting; then
// English. A merge tag GHL failed to resolve arrives as the literal "{{...}}",
// and an unknown locale is a typo in a hand-edited registry entry -- both land
// on English rather than on a half-rendered page.
export function resolveLocale(url, tenant) {
  const raw = String(
    url?.searchParams?.get("lang") || tenant?.statementLocale || tenant?.locale || tenant?.language || ""
  ).trim().toLowerCase();
  if (!raw) return "en";
  const base = raw.split(/[-_]/)[0];
  if (STATEMENT_LOCALES.includes(base)) return base;
  if (/^(espa|spanish)/.test(raw)) return "es";
  return "en";
}

const strings = (locale) => UI[locale] || UI.en;

export const entryLabel = (entryType, locale = "en") =>
  ENTRY_LABELS[locale]?.[entryType] || ENTRY_LABELS.en[entryType] || titleCase(entryType);
// Exported so a test can assert this list keeps pace with the entry types the
// code writes, rather than inferring coverage from the label's text -- which
// gives a false alarm on any label that happens to match its own slug
// ("cleaning_fee" -> "Cleaning fee").
export const LABELLED_ENTRY_TYPES = new Set(Object.keys(ENTRY_LABELS.en));
export const categoryLabel = (category, locale = "en") =>
  CATEGORY_LABELS[locale]?.[category] || CATEGORY_LABELS.en[category] || titleCase(category);

// Negative income is money going back out. It nets correctly either way -- this
// is what the row is CALLED, not how it is counted.
export const isRefund = (category, amount) => category === "income" && Number(amount) < 0;
export const categoryLabelFor = (category, amount, locale = "en") =>
  isRefund(category, amount) ? strings(locale).refund : categoryLabel(category, locale);
// Drives the colour. Refunds get their own, so a reversal is visible at a
// glance rather than reading as ordinary income with a minus sign.
export const categoryClassFor = (category, amount) => (isRefund(category, amount) ? "refund" : category);

// A row's stored description is written in English when the booking settles and
// carries detail no label can ("Cancellation charge 20% (under_336h), owner
// share"). On an English statement that detail is worth more than the label. On
// a Spanish one it is a paragraph of English in the middle of a Spanish page --
// which is what Yari saw on 2026-10-01: "the bottom half of the manager
// statement is english". Every row in D1 has a description, so this cell never
// fell back to the label and the labels never reached the detail table at all.
export const describeEntry = (row, locale = "en") =>
  locale === "en"
    ? row.description || entryLabel(row.entryType, locale)
    : entryLabel(row.entryType, locale);

async function queryStatement(env, locationId, recipient, from, to, recipientName) {
  // recipientName is optional -- a tenant with one owner and one manager
  // total never needs it (recipient alone already scopes the whole
  // location's owner/manager rows). A tenant with several owners or
  // managers across different properties passes it to narrow further,
  // matching ledger.js's per-property name resolution.
  const nameClause = recipientName ? " AND recipient_name = ?5" : "";
  const params = recipientName ? [locationId, recipient, from, to, recipientName] : [locationId, recipient, from, to];

  const summaryRes = await env.LEDGER_DB.prepare(
    `SELECT entry_type, category, currency, SUM(amount_minor) AS total_minor, COUNT(*) AS entry_count
     FROM ledger_entries
     WHERE location_id = ?1 AND recipient = ?2 AND created_at >= ?3 AND created_at < ?4${nameClause}
     GROUP BY entry_type, category, currency
     ORDER BY entry_type`
  ).bind(...params).all();

  const detailRes = await env.LEDGER_DB.prepare(
    `SELECT booking_id, invoice_number, invoice_id, entry_type, category, amount_minor, currency, description, created_at
     FROM ledger_entries
     WHERE location_id = ?1 AND recipient = ?2 AND created_at >= ?3 AND created_at < ?4${nameClause}
     ORDER BY created_at DESC`
  ).bind(...params).all();

  const summary = (summaryRes.results || []).map(r => ({
    entryType: r.entry_type, category: r.category, currency: r.currency,
    total: fromMinor(r.total_minor), count: r.entry_count
  }));
  const detail = (detailRes.results || []).map(r => ({
    bookingId: r.booking_id, invoiceNumber: r.invoice_number, invoiceId: r.invoice_id,
    entryType: r.entry_type, category: r.category,
    amount: fromMinor(r.amount_minor), currency: r.currency,
    description: r.description, createdAt: r.created_at
  }));

  // Income total excludes shadow (informational) and pass_through/liability
  // (never this recipient's earnings) -- "what did they actually earn".
  const incomeTotal = round2(summary.filter(s => s.category === "income").reduce((s, r) => s + r.total, 0));
  const shadowTotal = round2(summary.filter(s => s.category === "shadow").reduce((s, r) => s + r.total, 0));

  return { summary, detail, incomeTotal, shadowTotal, currency: detail[0]?.currency || summary[0]?.currency || "USD" };
}

function statementHtml({ brandName, heading, recipientName, fromLabel, toLabel, allTime = false, stmt, locale = "en" }) {
  const t = strings(locale);
  const rows = stmt.detail.map(d => `
    <tr>
      <td>${d.createdAt.slice(0, 10)}</td>
      <td>${escapeHtml(d.bookingId)}</td>
      <td>${escapeHtml(describeEntry(d, locale))}</td>
      <td class="cat cat-${categoryClassFor(d.category, d.amount)}">${categoryLabelFor(d.category, d.amount, locale)}</td>
      <td class="amt">${d.currency} ${d.amount.toFixed(2)}</td>
    </tr>`).join("");

  const summaryRows = stmt.summary.map(s => `
    <tr>
      <td>${escapeHtml(entryLabel(s.entryType, locale))}</td>
      <td class="cat cat-${categoryClassFor(s.category, s.total)}">${categoryLabelFor(s.category, s.total, locale)}</td>
      <td class="amt">${s.currency} ${s.total.toFixed(2)}</td>
      <td class="amt muted">${s.count}</td>
    </tr>`).join("");

  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(heading)} — ${escapeHtml(brandName)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Manrope:wght@400;600&display=swap" rel="stylesheet">
<style>
  :root { --teal:#1D9E75; --coral:#FF5A3C; --ink:#1A1D1F; --muted:#6B7280; --line:#E5E7EB; --bg:#F9FAFB; }
  * { box-sizing: border-box; }
  body { font-family:'Manrope',system-ui,sans-serif; color:var(--ink); background:var(--bg); margin:0; padding:32px 20px; }
  .wrap { max-width:820px; margin:0 auto; background:#fff; border-radius:16px; padding:36px; box-shadow:0 1px 3px rgba(0,0,0,.06); }
  h1 { font-family:'Space Grotesk',sans-serif; font-weight:700; font-size:1.6rem; margin:0 0 4px; }
  h2 { font-family:'Space Grotesk',sans-serif; font-weight:500; font-size:1.05rem; margin:28px 0 10px; color:var(--ink); }
  .sub { color:var(--muted); font-size:.9rem; margin-bottom:6px; }
  /* Quieter than the heading and louder than a footnote: a reader should take
     it in before the total, not discover it afterwards. */
  .scope-note { color:var(--muted); font-size:.82rem; margin-bottom:24px; }
  .total-card { background:var(--bg); border:1px solid var(--line); border-radius:12px; padding:18px 20px; margin-bottom:8px; }
  .total-card .label { font-size:.8rem; color:var(--muted); text-transform:uppercase; letter-spacing:.03em; }
  .total-card .value { font-family:'Space Grotesk',sans-serif; font-weight:700; font-size:1.8rem; color:var(--teal); }
  .shadow-note { font-size:.82rem; color:var(--muted); margin-top:4px; }
  table { width:100%; border-collapse:collapse; font-size:.88rem; }
  th { text-align:left; font-weight:600; color:var(--muted); font-size:.75rem; text-transform:uppercase; letter-spacing:.03em; padding:8px 10px; border-bottom:1px solid var(--line); }
  td { padding:10px; border-bottom:1px solid var(--line); vertical-align:top; }
  td.amt { text-align:right; font-variant-numeric:tabular-nums; }
  td.muted { color:var(--muted); }
  .cat { font-size:.72rem; padding:2px 8px; border-radius:999px; display:inline-block; }
  .cat-income { background:#E6F6EF; color:var(--teal); }
  .cat-liability, .cat-pass_through { background:#F3F4F6; color:var(--muted); }
  .cat-shadow { background:#FFF1EC; color:var(--coral); }
  .cat-refund { background:#FFF1EC; color:var(--coral); font-weight:600; }
  a { color:var(--coral); }
</style></head>
<body><div class="wrap">
  <h1>${escapeHtml(brandName)}</h1>
  <div class="sub">${escapeHtml(heading)}${recipientName ? ` · ${escapeHtml(recipientName)}` : ""} · ${
    allTime ? strings(locale).plPeriodAllTime : `${fromLabel} – ${toLabel}`}</div>
  <!--
    Money from a booking platform goes to the client directly and never passes
    through GHL, so an OTA booking produces no invoice, no payment and no ledger
    entry. Every booking on this statement is therefore a direct one.

    Said out loud because an owner with Airbnb income as well is looking at a
    partial picture with nothing to say so -- and the better HOMS gets at winning
    direct bookings, the more that gap would read as a decline somewhere else.
  -->
  <div class="scope-note">${t.directOnly}</div>

  <div class="total-card">
    <div class="label">${t.totalEarned}</div>
    <div class="value">${stmt.currency} ${stmt.incomeTotal.toFixed(2)}</div>
    ${stmt.shadowTotal > 0 ? `<div class="shadow-note">${t.otaNote(stmt.currency, stmt.shadowTotal.toFixed(2))}</div>` : ""}
  </div>

  <h2>${t.byType}</h2>
  <table><thead><tr><th>${t.thEntryType}</th><th>${t.thCategory}</th><th>${t.thTotal}</th><th>${t.thCount}</th></tr></thead>
  <tbody>${summaryRows || `<tr><td colspan="4" class="muted">${t.noEntries}</td></tr>`}</tbody></table>

  <h2>${t.detail}</h2>
  <table><thead><tr><th>${t.thDate}</th><th>${t.thBooking}</th><th>${t.thDescription}</th><th>${t.thCategory}</th><th>${t.thAmount}</th></tr></thead>
  <tbody>${rows || `<tr><td colspan="5" class="muted">${t.noEntries}</td></tr>`}</tbody></table>
</div></body></html>`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function handleStatement(request, env, recipient, tokenField) {
  const url = new URL(request.url);
  const locationId = url.searchParams.get("locationId");
  if (!locationId) return json({ error: "locationId is required" }, 400);

  const tenant = await env.TENANTS.get(locationId, { type: "json" });
  if (!tenant) return json({ error: `Unknown locationId: ${locationId}` }, 404);
  if (!statementAuthorized(request, tenant, env, url, tokenField)) return json({ error: "Unauthorized" }, 401);
  if (!env.LEDGER_DB) return json({ error: "Ledger not configured (LEDGER_DB binding missing)" }, 500);

  const { from, to, fromLabel, toLabel, allTime } = resolveWindow(url);
  const locale = resolveLocale(url, tenant);
  const recipientName = url.searchParams.get("recipientName") || null;
  const stmt = await queryStatement(env, locationId, recipient, from, to, recipientName);
  const heading = strings(locale).statementHeading[recipient];

  // brandName can come from the URL (a GHL merge tag like
  // {{custom_values.wbrand_name}} resolves there, since that field is
  // rendered by GHL itself before the iframe loads -- unlike tenant.brandName
  // in KV, which GHL never sees). Falls back to KV, then locationId.
  const brandName = url.searchParams.get("brandName") || tenant.brandName || locationId;

  if ((url.searchParams.get("format") || "html") === "json") {
    return json({ locationId, recipient, recipientName, locale, from: fromLabel, to: toLabel, ...stmt });
  }
  return html(statementHtml({ brandName, heading, recipientName, fromLabel, toLabel, allTime, stmt, locale }));
}

export async function handleOwnerStatement(request, env) {
  return handleStatement(request, env, "owner", "ownerReportToken");
}
export async function handleManagerStatement(request, env) {
  return handleStatement(request, env, "manager", "managerReportToken");
}

// --- manager P&L -----------------------------------------------------------
// Reuses the manager statement's own token: this is the same recipient seeing a
// fuller view of the same numbers, not a new audience.
export async function handleManagerPL(request, env) {
  const url = new URL(request.url);
  const locationId = url.searchParams.get("locationId");
  if (!locationId) return json({ error: "locationId is required" }, 400);

  const tenant = await env.TENANTS.get(locationId, { type: "json" });
  if (!tenant) return json({ error: `Unknown locationId: ${locationId}` }, 404);
  if (!statementAuthorized(request, tenant, env, url, "managerReportToken")) return json({ error: "Unauthorized" }, 401);
  if (!env.LEDGER_DB) return json({ error: "Ledger not configured (LEDGER_DB binding missing)" }, 500);

  const pit = tenant.ghlPit || (tenant.ghlPitSecretName && env[tenant.ghlPitSecretName]);
  if (!pit) return json({ error: "No GHL PIT configured for this tenant -- expenses cannot be read" }, 500);

  const { from, to, fromLabel, toLabel, allTime } = resolveWindow(url);
  const locale = resolveLocale(url, tenant);
  const recipientName = url.searchParams.get("recipientName") || null;
  const reportCurrency = (url.searchParams.get("currency") || tenant.currency || "USD").toUpperCase();

  try {
    const [income, records, jobs, cleaningCollected, ownerPayouts] = await Promise.all([
      queryManagerIncome(env, locationId, from, to, recipientName),
      fetchExpenseRecords(pit, locationId),
      fetchCleaningJobs(pit, locationId),
      queryManagerCleaningIncome(env, locationId, from, to, recipientName),
      // Deliberately NOT scoped by recipientName: that names the MANAGER, and
      // scoping owners by it would return nothing on every account.
      queryOwnerPayouts(env, locationId, from, to),
    ]);
    const pl = { ...buildManagerPL({ income, records, from, to, reportCurrency, jobs, cleaningCollected }), ownerPayouts };
    const brandName = url.searchParams.get("brandName") || tenant.brandName || locationId;

    if ((url.searchParams.get("format") || "html") === "json") {
      return json({ locationId, from: fromLabel, to: toLabel, allTime, recipientName, locale, ...pl });
    }
    return html(managerPlHtml({ brandName, fromLabel, toLabel, allTime, pl, locale }));
  } catch (err) {
    return json({ error: err.message || "Unknown error" }, err.status && err.status >= 400 && err.status < 600 ? err.status : 502);
  }
}

const money = (n, cur) => `${cur} ${n < 0 ? "-" : ""}${Math.abs(n).toFixed(2)}`;

function managerPlHtml({ brandName, fromLabel, toLabel, allTime = false, pl, locale = "en" }) {
  const t = strings(locale);
  const cur = pl.currency;
  const rows = pl.byCategory.map((c) =>
    `<tr><td>${escapeHtml(c.label)}</td><td class="n">${c.count}</td><td class="n">${money(c.total, cur)}</td></tr>`).join("");

  // Anything left out of the total is shown as loudly as the total itself. A
  // P&L that quietly omits costs is worse than no P&L.
  const warn = [];
  if (pl.mixedIncomeCurrency) {
    const seen = pl.incomeByCurrency.map((c) => `${c.currency} ${c.total.toFixed(2)}`).join(", ");
    warn.push(`<p class="warn">${t.warnMixedCurrency(escapeHtml(seen))}</p>`);
  }
  const unconverted = pl.excluded.filter((e) => e.issues.includes("unconverted_currency"));
  const unapproved = pl.excluded.filter((e) => e.issues.includes("not_approved"));
  const noAmount = pl.excluded.filter((e) => e.issues.includes("no_amount"));
  const unattributed = pl.excluded.filter((e) => e.issues.includes("not_attributed"));
  if (unconverted.length) {
    warn.push(`<p class="warn">${t.warnUnconverted(unconverted.length)}</p>`);
  }
  if (unapproved.length) {
    warn.push(`<p class="warn">${t.warnUnapproved(unapproved.length)}</p>`);
  }
  if (noAmount.length) {
    warn.push(`<p class="warn">${t.warnNoAmount(noAmount.length)}</p>`);
  }
  if (unattributed.length) {
    warn.push(`<p class="warn">${t.warnUnattributed(unattributed.length)}</p>`);
  }
  // The cleaning figure is only as honest as the costs behind it, so a clean
  // with no cost recorded is reported as loudly as a mixed currency.
  if (pl.cleaning?.jobsWithoutCost?.length) {
    warn.push(`<p class="warn">${t.warnNoCleanerCost(pl.cleaning.jobsWithoutCost.length)}</p>`);
  }
  if (pl.cleaning?.unpaidCleanerJobs) {
    warn.push(`<p class="warn">${t.warnUnpaidCleaners(money(pl.cleaning.unpaidCleaners, cur), pl.cleaning.unpaidCleanerJobs)}</p>`);
  }
  if (pl.undated.length) {
    warn.push(`<p class="warn">${t.warnUndated(pl.undated.length)}</p>`);
  }

  if (pl.reimbursableUnconvertible?.length) {
    warn.push(`<p class="warn">${t.warnReimbursableUnconvertible(
      pl.reimbursableUnconvertible.map((e) => escapeHtml(e.name || e.id)).join(", "))}</p>`);
  }

  const netClass = pl.net < 0 ? "neg" : "pos";
  const dash = pl.mixedIncomeCurrency ? "&mdash;" : null;
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${escapeHtml(brandName)} &mdash; ${t.plTitle}</title><style>
    :root{--ink:#111;--muted:#666;--line:#e5e5e5;--pos:#0a7d55;--neg:#b3261e;--warnbg:#fff8e1;--warnline:#e6c860}
    body{font:15px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink);margin:0;padding:24px;max-width:760px}
    h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 8px}
    .period{color:var(--muted);margin:0 0 20px}
    table{width:100%;border-collapse:collapse;margin:0 0 8px}
    th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line)}
    th{font-weight:600;color:var(--muted);font-size:13px}
    .n{text-align:right;font-variant-numeric:tabular-nums}
    .tot td{font-weight:600;border-top:2px solid var(--ink);border-bottom:none}
    .pos{color:var(--pos)}.neg{color:var(--neg)}
    .warn{background:var(--warnbg);border-left:3px solid var(--warnline);padding:10px 12px;margin:8px 0}
    .note{color:var(--muted);font-size:13px}
    </style></head><body>
    <h1>${escapeHtml(brandName)} &mdash; ${t.plTitle}</h1>
    <p class="period">${allTime ? t.plPeriodAllTime : t.plPeriod(escapeHtml(fromLabel), escapeHtml(toLabel))}</p>
    ${warn.join("")}
    <table>
      <tr><td>${t.plIncome}</td><td class="n">${dash || money(pl.income, cur)}</td></tr>
      <tr><td>${t.plExpenses}</td><td class="n">${money(-pl.expenses, cur)}</td></tr>
      <tr class="tot"><td>${pl.netIsCeiling ? t.plNetCeiling : t.plNet}</td><td class="n ${netClass}">${dash || money(pl.net, cur)}</td></tr>
    </table>
    ${pl.netIsCeiling ? `<p class="note">${t.plCeilingNote}</p>` : ""}
    <p class="note">${t.plNote(pl.reimbursableOutstanding === null ? "&mdash;" : money(pl.reimbursableOutstanding, cur))}</p>
    ${pl.ownerBorneCount
      ? `<p class="note">${t.plOwnerBorneNote(pl.ownerBorneCount, money(pl.ownerBorneTotal, cur))}</p>`
      : ""}
    ${(pl.reimbursableByCurrency || []).some((c) => c.currency !== cur)
      ? `<p class="note">${t.plReimbursableRecorded(
          pl.reimbursableByCurrency.map((c) => money(c.total, c.currency)).join(", "))}</p>`
      : ""}
    ${pl.cleaning && (pl.cleaning.collected || pl.cleaning.paidToCleaners) ? `
    <h2>${t.plCleaning}</h2>
    <table>
      <tr><td>${t.plCleaningCollected}</td><td class="n">${money(pl.cleaning.collected, cur)}</td></tr>
      <tr><td>${t.plCleaningPaid}</td><td class="n">${pl.cleaning.marginKnown ? money(-pl.cleaning.paidToCleaners, cur) : "&mdash;"}</td></tr>
      <tr class="tot"><td>${pl.cleaning.marginIsCeiling ? t.plCleaningMarginCeiling : t.plCleaningMargin}</td><td class="n ${pl.cleaning.marginKnown ? (pl.cleaning.margin < 0 ? "neg" : "pos") : ""}">${pl.cleaning.marginKnown ? money(pl.cleaning.margin, cur) : "&mdash;"}</td></tr>
    </table>
    <p class="note">${pl.cleaning.marginKnown ? t.plCleaningNote(pl.cleaning.jobsCounted) : t.plCleaningUnknownNote(pl.cleaning.costMissing)}</p>
    ${pl.cleaning.marginIsCeiling ? `<p class="note">${t.plCeilingNote}</p>` : ""}` : ""}

    ${pl.ownerPayouts?.owners?.length ? `
    <h2>${t.plOwnerPayouts}</h2>
    <p class="note">${t.plOwnerPayoutsNote}</p>
    ${pl.ownerPayouts.unattributed ? `<p class="warn">${t.warnUnattributedPayout(money(pl.ownerPayouts.unattributed.owed, cur), pl.ownerPayouts.unattributed.entries)}</p>` : ""}
    <table>
      <tr><th>${t.thOwner}</th><th class="n">${t.thCount}</th><th class="n">${t.thAmount}</th></tr>
      ${pl.ownerPayouts.owners.map((o) => `<tr><td>${escapeHtml(o.name)}</td><td class="n">${o.entries}</td><td class="n">${o.mixedCurrency ? "&mdash;" : money(o.owed, o.currency || cur)}</td></tr>`).join("")}
      <tr class="tot"><td>${t.plOwnerPayoutsTotal}</td><td class="n"></td><td class="n">${money(pl.ownerPayouts.total, cur)}</td></tr>
    </table>` : ""}

    <h2>${t.plByCategory}</h2>
    ${rows
      ? `<table><tr><th>${t.thCategory}</th><th class="n">${t.thCount}</th><th class="n">${t.thAmount}</th></tr>${rows}</table>`
      : `<p class="note">${t.plNoExpenses}</p>`}
    </body></html>`;
}

// --- reconciliation ---------------------------------------------------------
// Only meaningful for enrich-mode bookings (invoiceStrategy: "enrich") --
// paypal_url bookings pay PayPal/Stripe directly, never touching GHL's own
// transactions ledger, so there's nothing on GHL's side to compare those
// against. Diffs D1's income-bearing bookings for the period against GHL's
// list-transactions for the same window; a booking with an income row in D1
// but no matching GHL transaction is flagged for manual review -- catches a
// payment that got recorded directly in GHL (e.g. manually marked paid)
// without ever hitting this Worker's settle() path.
//
// list-transactions schema (2026-08-29, not yet exercised against real
// settled data -- verify against a live account with real enrich-mode
// transactions before trusting this in production): GET /payments/transactions
// ?altType=location&locationId=...&startAt&endAt, response { data: [...] }
// with entityId/entitySourceType per transaction. Unlike invoices, this
// endpoint's own schema lists locationId as the scoping param, not altId --
// don't assume it needs altId too just because invoices did.
async function ghlFetchTransactions(tenant, env, locationId, fromLabel, toLabel) {
  const pit = tenant.ghlPit || (tenant.ghlPitSecretName && env[tenant.ghlPitSecretName]);
  if (!pit) throw new Error("No GHL PIT configured for this tenant (ghlPit / ghlPitSecretName)");
  const q = new URLSearchParams({ altType: "location", locationId, startAt: fromLabel, endAt: toLabel, limit: "100", offset: "0" });
  const res = await fetch(`${GHL_BASE}/payments/transactions?${q}`, {
    headers: { Authorization: `Bearer ${pit}`, Version: GHL_VERSION, Accept: "application/json" }
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) { const err = new Error(`GHL GET /payments/transactions -> ${res.status} ${JSON.stringify(data).slice(0, 500)}`); err.status = res.status; throw err; }
  return data.data || [];
}

export async function handleReconcile(request, env) {
  const url = new URL(request.url);
  const locationId = url.searchParams.get("locationId");
  if (!locationId) return json({ error: "locationId is required" }, 400);

  const tenant = await env.TENANTS.get(locationId, { type: "json" });
  if (!tenant) return json({ error: `Unknown locationId: ${locationId}` }, 404);
  if (!adminAuthorized(request, tenant, env)) return json({ error: "Unauthorized" }, 401);
  if (!env.LEDGER_DB) return json({ error: "Ledger not configured (LEDGER_DB binding missing)" }, 500);

  const { from, to, fromLabel, toLabel } = resolveWindow(url);

  const ledgerRes = await env.LEDGER_DB.prepare(
    `SELECT DISTINCT booking_id, invoice_id, invoice_number
     FROM ledger_entries
     WHERE location_id = ?1 AND category = 'income' AND created_at >= ?2 AND created_at < ?3`
  ).bind(locationId, from, to).all();
  const ledgerBookings = ledgerRes.results || [];

  let transactions = [];
  let ghlError = null;
  try {
    transactions = await ghlFetchTransactions(tenant, env, locationId, fromLabel, toLabel);
  } catch (err) {
    ghlError = err.message;
  }

  const ghlEntityIds = new Set(transactions.map(t => t.entityId).filter(Boolean));
  const unmatched = ledgerBookings.filter(b => b.invoice_id && !ghlEntityIds.has(b.invoice_id));

  return json({
    locationId, from: fromLabel, to: toLabel,
    ledgerBookingCount: ledgerBookings.length,
    ghlTransactionCount: transactions.length,
    ghlFetchError: ghlError,
    unmatched: unmatched.map(b => ({ bookingId: b.booking_id, invoiceId: b.invoice_id, invoiceNumber: b.invoice_number })),
    note: "Only meaningful for invoiceStrategy:'enrich' bookings -- paypal_url bookings never touch GHL's transactions ledger, so they'll always show as unmatched here (that's expected, not a desync)."
  });
}
