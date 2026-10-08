// --- Spanish -------------------------------------------------------------
//
// Yari, 2026-09-30, the night before the conference: the dashboard is on
// display and it is a key feature. Its audience is Dominican, and every string
// in it was English.
//
// This translates the RENDERED PAGE rather than the ~95 call sites that build
// it. A dictionary keyed by the exact English text, applied to text nodes and
// to the two attributes a user can read, after each render. The reason is risk:
// touching 95 template literals the night before a demo is 95 chances to break
// a layout, and this is one function that cannot change any markup, any number
// or any logic. If it is wrong, the page is still the page.
//
// English is untouched: localize() returns immediately unless a Spanish locale
// was resolved, so the default path does not even walk the DOM.
const I18N = {
  es: {
    // Shell and navigation
    "HOMS Admin Dashboard": "Panel de Administración HOMS",
    "Admin Dashboard": "Panel de Administración",
    "Overview": "Resumen",
    "Properties": "Propiedades",
    "OTA Channels": "Canales OTA",
    "Transactions": "Transacciones",
    "Cleaning Checklists": "Listas de Limpieza",
    "Expenses": "Gastos",
    "Property Inventory": "Inventario de Propiedades",
    "Reports": "Informes",
    "Owner Statement": "Estado de Cuenta del Propietario",
    // The manager statement panel. Every one of these is a whole text node in
    // the rendered page, which is what lets the walker swap it.
    "Manager Statement": "Estado de Cuenta del Administrador",
    "Owed to owners": "Adeudado a propietarios",
    "Owner": "Propietario",
    "Total owed": "Total adeudado",
    "What this period earned for each owner, for you to pay through your own payout method. This page does not move money and does not record whether you have paid.":
      "Lo que este período generó para cada propietario, para que usted lo pague por su propio método. Esta página no transfiere dinero ni registra si ya pagó.",
    "is not attributed to any owner, and cannot be paid to anybody until those rows carry a name.":
      "no está atribuido a ningún propietario, y no se le puede pagar a nadie hasta que esos registros lleven un nombre.",
    "Income from bookings": "Ingresos por reservas",
    "Count": "Cantidad",
    "All time": "Histórico",
    "Net": "Neto",
    "Recoverable from owners": "Recuperable de los propietarios",
    "Expenses count only the share the manager cannot recover, plus what was paid to cleaners. Money recoverable from owners is listed but not treated as a cost.":
      "Los gastos cuentan solo la parte que el administrador no puede recuperar, más lo pagado a los limpiadores. El monto recuperable de los propietarios se indica, pero no se trata como costo.",
    "Cleaning": "Limpieza",
    "Part of the income above, not additional to it.": "Forma parte de los ingresos de arriba, no se suma a ellos.",
    "Cleaning fees collected": "Tarifas de limpieza cobradas",
    "Kept on cleaning (at most)": "Retenido por limpieza (como máximo)",
    "Paid By": "Pagado Por",
    "Owner": "Propietario",
    "Manager": "Administrador",
    "Recoverable from owners cannot be totalled — the expense(s) below carry another currency with no exchange rate, and a guessed conversion would be a wrong number that looks right.":
      "No se puede totalizar lo recuperable de los propietarios: el o los gastos indicados tienen otra moneda sin tasa de cambio, y una conversión estimada daría una cifra incorrecta con apariencia de correcta.",
    "Net (at most)": "Neto (como máximo)",
    "At most: cleans with no cleaner cost recorded are missing from this, so the real figure is lower.":
      "Como máximo: las limpiezas sin costo de limpiador registrado no están incluidas, así que la cifra real es menor.",
    "No cleaner cost is recorded for any clean in this period, so what was kept on cleaning cannot be worked out. The fee collected is shown; the rest is left blank because there is nothing to base it on.":
      "No hay costo de limpiador registrado para ninguna limpieza de este período, así que no se puede calcular lo retenido por limpieza. Se muestra la tarifa cobrada; el resto queda en blanco porque no hay con qué calcularlo.",
    "Paid to cleaners": "Pagado a los limpiadores",
    "Kept on cleaning": "Retenido por limpieza",
    "Turnover Type": "Tipo de Limpieza",
    "The ledger holds more than one currency for this manager, so income is not totalled.":
      "El libro contable tiene más de una moneda para este administrador, así que los ingresos no se suman.",
    "clean(s) here have no cleaner cost recorded, so the cleaning figure below is too high.":
      "limpieza(s) aquí no tienen costo de limpiador registrado, así que la cifra de limpieza de abajo es más alta de lo real.",
    "is owed to cleaners for completed cleans with no payment date.":
      "se deben a los limpiadores por limpiezas completadas sin fecha de pago.",
    "expense(s) are left out of the total.": "gasto(s) quedan fuera del total.",
    'expense(s) still say "Needs Review" and are not in the total yet:':
      'gasto(s) siguen marcados como "Needs Review" y todavía no están en el total:',
    "expense(s) are in another currency with no converted amount, and converting them by guesswork would be a wrong number that looks right:":
      "gasto(s) están en otra moneda sin monto convertido, y convertirlos por estimación daría una cifra incorrecta con apariencia de correcta:",
    "expense(s) have no amount, so there is nothing to count:":
      "gasto(s) no tienen monto, así que no hay nada que contar:",
    "expense(s) do not say who pays for them, so they are counted against nobody. Set Paid By to Owner or Manager on:":
      "gasto(s) no indican quién los paga, así que no se cuentan a nadie. Configure Paid By como Owner o Manager en:",
    "expense(s) come off the owners' payouts rather than counting here.":
      "gasto(s) se descuentan del pago a los propietarios en vez de contarse aquí.",
    "Deducted from owner payouts": "Descontado del pago a propietarios",
    "Expenses are what the manager pays for themselves, plus what was paid to cleaners. An owner's costs come off that owner's payout instead and are shown separately.":
      "Los gastos son lo que el administrador paga de su propio bolsillo, más lo pagado a los limpiadores. Los costos del propietario se descuentan de su pago y se muestran aparte.",
    "expense(s) have no Paid On date, so they fall into no period at all.":
      "gasto(s) no tienen fecha de pago, así que no caen en ningún período.",
    "Refresh": "Actualizar",
    "Updated": "Actualizado",
    "Search by name, property, booking ID, cleaner, transaction, OTA channel...":
      "Buscar por nombre, propiedad, ID de reserva, limpiador, transacción, canal OTA...",
    "Search by name, property, booking ID, cleaner, transaction...":
      "Buscar por nombre, propiedad, ID de reserva, limpiador, transacción...",
    "Loading live data from GHL…": "Cargando datos en vivo desde GHL…",

    // Access
    "Admin key required": "Se requiere clave de administrador",
    "Admin key": "Clave de administrador",
    "Unlock": "Desbloquear",
    "Cancel": "Cancelar",

    // Expense entry
    "+ Add Expense": "+ Agregar Gasto",
    "Add Expense": "Agregar Gasto",
    "Submit Expense": "Enviar Gasto",
    "Property": "Propiedad",
    "Paid On": "Fecha de Pago",
    "Paid on": "Fecha de pago",
    "Category": "Categoría",
    "Description": "Descripción",
    "Amount": "Monto",
    "Note": "Nota",
    "Notes": "Notas",
    "Vendor": "Proveedor",
    "Status": "Estado",
    "Type": "Tipo",
    "Recurrence": "Recurrencia",
    "Currency:": "Moneda:",
    "Cancellation:": "Cancelación:",
    "— None —": "— Ninguno —",
    "New expenses are flagged \"Needs Review\" until confirmed.":
      "Los gastos nuevos quedan marcados como “Requiere Revisión” hasta confirmarse.",

    // Filters and export
    "Year": "Año",
    "Year: All": "Año: Todos",
    "Month: All": "Mes: Todos",
    "Clear filters": "Limpiar filtros",
    "All expenses": "Todos los gastos",
    "Export CSV": "Exportar CSV",
    "Download CSV": "Descargar CSV",
    "Print / Save as PDF": "Imprimir / Guardar como PDF",

    // Reports and P&L
    "Profit & Loss": "Estado de Resultados",
    "— cash basis": "— base de efectivo",
    "Revenue": "Ingresos",
    "Gross revenue": "Ingresos brutos",
    "Less platform fees": "Menos comisiones de plataforma",
    "Net revenue": "Ingresos netos",
    "Recorded revenue": "Ingresos registrados",
    "Operating expenses": "Gastos operativos",
    "Total operating expenses": "Total de gastos operativos",
    "Expenses by category": "Gastos por categoría",
    "Month by month": "Mes a mes",
    "Net revenue in, expenses out, by the month money actually moved.":
      "Ingresos netos y gastos, según el mes en que el dinero realmente se movió.",
    "Revenue by property": "Ingresos por propiedad",
    "Revenue — all time": "Ingresos — histórico",
    "GHL payments collected": "Pagos cobrados en GHL",
    "MRR (GHL subscriptions)": "MRR (suscripciones GHL)",
    "Fixed monthly burn": "Gasto fijo mensual",
    "By source": "Por origen",
    "By payer": "Por pagador",
    "Year-end P&L statement": "Estado de resultados de fin de año",

    // Overview cards
    "Bookings by OTA channel": "Reservas por canal OTA",
    "Cleaning checklists by status": "Listas de limpieza por estado",
    "Transactions by payment status": "Transacciones por estado de pago",
    "Checklists needing follow-up or failed": "Listas con seguimiento pendiente o fallidas",
    "Inventory needing replacement / missing": "Inventario por reponer / faltante",
    "OTA channels disconnected / erroring": "Canales OTA desconectados / con error",
    "Transactions missing links / failed payment": "Transacciones sin enlace / pago fallido",
    "Needs attention": "Requiere atención",
    "Contacts": "Contactos",
    "Inventory Items": "Artículos de Inventario",
    "Listing name": "Nombre del listado",
    "Nightly rate": "Tarifa por noche",

    // Empty states
    "No checklists yet": "Aún no hay listas",
    "No transactions yet": "Aún no hay transacciones",

    // Status badges. These come from the data, but they are a fixed vocabulary
    // the account writes, not free text, so they translate safely.
    "Connected": "Conectado",
    "Approved": "Aprobado",
    // Transactions table headers. These were English on every Spanish account
    // until now -- the table was built before the locale pass and nobody went
    // back for it. Found by the completeness check in test-reservation-status.
    "Guest": "Huésped",
    "Stay Dates": "Fechas de Estancia",
    "Payment": "Pago",
    "OTA Channel": "Canal OTA",
    "Booking Ref": "Ref. de Reserva",
    // Same word in Spanish. Present rather than omitted, so the check that
    // every header has an entry cannot be passed by leaving one out.
    "Total": "Total",

    // Reservation lifecycle. Feminine: the noun behind them is "la reserva".
    "New": "Nueva",
    "Active": "Activa",
    "Departing": "Saliendo",
    "Past": "Pasada",
    "Cancelled": "Cancelada",
    "Rescheduled": "Reprogramada",
    "Paid": "Pagado",
    "Pending": "Pendiente",
    "Needs Review": "Requiere Revisión",
    "Needs Follow-up": "Requiere Seguimiento",
    "Failed Inspection": "Inspección Fallida",
    "Pass — Guest Ready": "Aprobado — Listo para Huéspedes",
    "adjustment": "ajuste",
    "incomplete": "incompleto",

    // Import screens
    "Import expenses": "Importar gastos",
    "Import the portfolio workbook": "Importar el libro de portafolio",
    "Read receipts with": "Leer recibos con",
    "Using": "Usando",
    "Line": "Línea",
    "Row": "Fila",
    "Line number within its own file — hover a row for the file name":
      "Número de línea dentro de su archivo — pase el cursor sobre una fila para ver el nombre",
    "It will have to be set on the account by hand.":
      "Habrá que configurarlo manualmente en la cuenta.",
  },
};

let LOCALE = "en";

// The viewer's own pick, remembered per browser. Someone who has said they want
// English on a Spanish account should not have to say it again every visit, and
// an account default should not talk over a person who has stated a preference.
const LANG_STORAGE_KEY = "homs_lang";
const storedLocale = () => {
  try { return localStorage.getItem(LANG_STORAGE_KEY) || ""; } catch { return ""; }
};

// Anything unrecognised comes back as "" rather than "en", so an unknown value
// in one source falls through to the next instead of pinning the page to
// English. The caller supplies the final default.
function normalizeLocale(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "";
  const base = s.split(/[-_]/)[0];
  if (base === "en") return "en";
  if (I18N[base]) return base;
  if (/^(espa|spanish)/.test(s)) return "es";
  return "";
}

// Same rules as the Worker's statement resolver, so one account setting cannot
// give a Spanish statement and an English dashboard.
//
// ?lang= first: a link is an explicit instruction for this view, and it is how
// a statement gets sent to one owner in their language. Then the viewer's own
// stored pick, then the account's setting, then English.
function resolveLocale(fromTenant) {
  const fromLink = normalizeLocale(new URLSearchParams(location.search).get("lang"));
  return fromLink || normalizeLocale(storedLocale()) || normalizeLocale(fromTenant) || "en";
}

// Walks the rendered page and swaps exact matches. Only whole-string matches,
// so a partial sentence is never half-replaced; anything not in the dictionary
// is left exactly as it was.
//
// Reversible, which the first version was not: it swapped English for Spanish in
// place and kept no way back, so switching an account to English left the tabs,
// header and search box Spanish until a full page reload (Yari, 2026-10-05).
// With a toggle on the page that is not an edge case, it is the second click.
//
// So the ENGLISH ORIGINAL of every node this touches is recorded the first time
// it is touched, and each pass restores from that record before applying the
// target language. Going back is exact rather than a reverse lookup -- a reverse
// dictionary would happily turn a client's own Spanish data into English, and
// would need rewriting the day a third language arrives.
//
// WeakMaps on purpose: a re-rendered panel throws its old nodes away and they
// drop out of here on their own.
const ORIGINAL_TEXT = new WeakMap();
const ORIGINAL_ATTRS = new WeakMap();

function localize(root) {
  const node = root || document.body;
  const dict = I18N[LOCALE] || null;

  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  const pending = [];
  while (walker.nextNode()) {
    const n = walker.currentNode;
    // What this node said before anything translated it. For a node nothing has
    // touched, that is simply what it says now.
    const english = ORIGINAL_TEXT.has(n) ? ORIGINAL_TEXT.get(n) : n.nodeValue;
    const hit = dict ? dict[english.trim()] : null;
    pending.push([n, english, hit]);
  }
  // Collected first, then written -- mutating during a walk skips nodes.
  //
  // Every write here is guarded by a comparison, and that guard is the whole
  // reason this function terminates. It runs from a MutationObserver, and
  // assigning a text node the value it already holds STILL fires a
  // characterData record (measured in Chrome: three assignments, three
  // records, two of them no-ops). So an unconditional rewrite feeds the
  // observer, which calls this again, which rewrites again -- forever, with no
  // frame ever painted. That froze the whole dashboard on 2026-10-05.
  //
  // The version before the toggle was accidentally safe: it matched on each
  // node's CURRENT text, which stopped matching the dictionary once
  // translated, so its second pass found nothing. Keying off the stored
  // English original removed that accident -- the original always matches --
  // and the guard is what puts it back deliberately.
  //
  // The guard on the TRANSLATE branch is the load-bearing one, and is the one
  // the test exercises. The restore branch below cannot loop on its own
  // whatever it does, because it deletes the node's record, so the next pass
  // skips the node entirely; its guard is there to avoid one pointless write,
  // and no test can distinguish it. Said plainly so nobody later reads the
  // symmetry as proof that both are covered.
  for (const [n, english, hit] of pending) {
    if (hit) {
      if (!ORIGINAL_TEXT.has(n)) ORIGINAL_TEXT.set(n, english);
      const next = english.replace(english.trim(), hit);
      if (n.nodeValue !== next) n.nodeValue = next;
    } else if (ORIGINAL_TEXT.has(n)) {
      if (n.nodeValue !== english) n.nodeValue = english;
      ORIGINAL_TEXT.delete(n);
    }
  }

  for (const el of node.querySelectorAll("[placeholder],[title]")) {
    const saved = ORIGINAL_ATTRS.get(el) || {};
    for (const attr of ["placeholder", "title"]) {
      if (el.getAttribute(attr) === null) continue;
      const english = attr in saved ? saved[attr] : el.getAttribute(attr);
      const hit = dict ? dict[String(english).trim()] : null;
      // Guarded for the same reason as the text nodes above. Attributes are not
      // in this observer's filter today, so this one cannot loop on its own --
      // it is written this way so that adding attributes to the filter later
      // cannot reintroduce the freeze.
      if (hit) {
        if (!(attr in saved)) { saved[attr] = english; ORIGINAL_ATTRS.set(el, saved); }
        if (el.getAttribute(attr) !== hit) el.setAttribute(attr, hit);
      } else if (attr in saved) {
        if (el.getAttribute(attr) !== saved[attr]) el.setAttribute(attr, saved[attr]);
        delete saved[attr];
      }
    }
  }
  document.documentElement.lang = LOCALE;
}

// Switching language from the page. Everything the dashboard shows is either
// static markup, which localize() restores from its record, or re-rendered
// HTML built through tr(), which has to be rebuilt -- a Spanish string that tr()
// produced is not a dictionary key, so no DOM pass can turn it back.
function setLocale(next) {
  const want = normalizeLocale(next) || "en";
  if (want === LOCALE) return;
  LOCALE = want;
  try { localStorage.setItem(LANG_STORAGE_KEY, want); } catch { /* private window */ }
  // The owner statement keeps its own language on purpose: it is printed FOR an
  // owner, who may not read what the manager reads. Left alone here.
  //
  // No refetch -- the manager figures are already in managerPl, and making
  // every click wait on the invoicing Worker to change a label would be slow
  // for no gain.
  if (DATA) renderAll({ refetch: false });
  localize();
  paintLangToggle();
}

// Driven off LOCALE rather than the click, so the buttons cannot show a language
// the page is not in.
function paintLangToggle() {
  for (const b of document.querySelectorAll(".ui-lang-btn")) {
    b.classList.toggle("active", b.dataset.lang === LOCALE);
  }
}

// Dynamic strings, built by concatenation, so the DOM walker cannot match them.
const tr = (s) => (I18N[LOCALE] && I18N[LOCALE][s]) || s;

// One observer instead of ninety call sites: every render, overlay and filter
// redraw passes through the DOM, so watching it catches all of them. The guard
// stops localize()'s own writes from re-entering; the pass it queues finds
// nothing left to change and settles.
let localizing = false;
let localizeObserver = null;
function startLocalizeObserver() {
  // Started unconditionally, where this used to bail out on an English page.
  // An English page can now be switched to Spanish at any moment, and once
  // switched its re-renders need the same watching as any other. Attached once:
  // Refresh runs loadData again, and a second observer would double every pass.
  if (localizeObserver) return localize();
  localizeObserver = new MutationObserver(() => {
    if (localizing) return;
    localizing = true;
    try { localize(); } finally { localizing = false; }
  });
  localizeObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  localize();
}

let DATA = null;
let activeTab = "overview";

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Anything that is not a finite number (a malformed amount from a broken sync) shows as a dash, never "$NaN".
const money = (n) => {
  const v = n === null || n === undefined || n === "" ? NaN : Number(n);
  return Number.isFinite(v) ? `$${v.toFixed(2)}` : "—";
};
const CURRENCY_SYMBOLS = { DOP: "RD$", USD: "US$", EUR: "€" };
// An amount in a stated currency. No currency = the account's own, shown as before.
// The amount of an expense in the account's own currency, or null when it is in
// another currency and was not converted -- those are listed, never netted.
const inAccountCurrency = (x) => {
  // Untagged expenses predate currency tracking and are in the account's currency.
  // A tagged one is only netted when WCurrency confirms it matches -- an unknown
  // account currency never lets RD$ be subtracted from dollars.
  if (!x.currency || x.currency === DATA.accountCurrency) return Number(x.amount) || 0;
  return x.convertedAmount ? Number(x.convertedAmount) : null;
};
const moneyIn = (n, cur) => {
  if (!cur) return money(n);
  const v = n === null || n === undefined || n === "" ? NaN : Number(n);
  return Number.isFinite(v) ? `${CURRENCY_SYMBOLS[cur] || cur + " "}${v.toFixed(2)}` : "—";
};
const dash = (v) => (v === null || v === undefined || v === "" ? "—" : esc(v));
const dateFmt = (v) => (v ? new Date(v).toLocaleDateString() : "—");

// --- Reservation status -----------------------------------------------------
// What a manager opens this for is which bookings need them today, and the
// Transactions tab could not answer it: it showed a payment status and left the
// reader to read two dates and work the rest out.
//
// Derived rather than stored, because it changes with the calendar and not with
// the record. A booking that was "new" yesterday is "active" today, and nothing
// wrote to it in between -- so a stored value would be stale by exactly the
// amount nobody was watching.
//
// Compared as YYYY-MM-DD strings, never as Date objects. A date-only value
// parses as UTC midnight, so in the DR (UTC-4) `new Date("2026-10-07")` is the
// evening of the 6th locally: every status would be a day early for precisely
// the people who use this.
const dateOnly = (v) => /^(\d{4}-\d{2}-\d{2})/.exec(String(v ?? ""))?.[1] || null;

// The reader's own day, not UTC's. A manager in Santo Domingo at 9pm is still
// working on the 7th while UTC has already moved to the 8th.
function todayISO(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

// Cancelled and rescheduled are not derivable -- nothing in the data records
// either. They come from booking_status, which the Worker writes on cancel and
// on reschedule once that field exists on the Transactions object. Until then
// this list is the vocabulary and the dates supply the rest.
const STAY_STATUSES = ["new", "active", "departing", "past", "cancelled", "rescheduled"];
const STAY_LABELS = {
  new: "New", active: "Active", departing: "Departing",
  past: "Past", cancelled: "Cancelled", rescheduled: "Rescheduled",
};
const STAY_TONES = {
  new: "neutral", active: "good", departing: "warn",
  past: "neutral", cancelled: "bad", rescheduled: "warn",
};

function stayStatus(t, today = todayISO()) {
  // A written status outranks the dates: a cancelled booking still has a
  // check-in next week, and the dates would call it "new".
  const stored = String(t.bookingStatus || "").toLowerCase();
  if (STAY_STATUSES.includes(stored)) return stored;

  const inD = dateOnly(t.checkinDate), outD = dateOnly(t.checkoutDate);

  // Departing comes first because a checkout today is also inside the stay,
  // and "somebody leaves today" is the part that needs doing.
  if (outD && outD === today) return "departing";
  if (outD && outD < today) return "past";
  if (inD && inD > today) return "new";
  // Reached only when the checkout exists and is later than today, and the
  // check-in exists and is not later -- i.e. in-house. No further comparison
  // is needed, and adding one would be a clause no input can falsify.
  if (inD && outD) return "active";
  return null; // one date missing: nothing honest to say
}

const stayBadge = (s) => (s ? badge(STAY_LABELS[s], STAY_TONES[s]) : badge("", "neutral"));

// Lifecycle order, not alphabetical: distinct() would offer Active, Departing,
// New, Past, which is no order at all to a reader scanning for today's work.
// Only statuses actually present are offered, so no filter can select nothing.
function stayStatusOptions(list) {
  const seen = new Set(list.map((t) => t.stayStatus).filter(Boolean));
  return STAY_STATUSES.filter((s) => seen.has(s)).map((s) => ({ value: s, label: STAY_LABELS[s] }));
}

// Per-tenant color theming: each client's KV entry can set branding.primary;
// tenants without one get the platform default (set server-side). Deriving a
// light "weak" tint from the single primary color keeps client setup to one
// hex value -- matches the "colors only" scope, no logo/font system.
function hexToRgb(hex) {
  const clean = (hex || "").replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const n = parseInt(full, 16);
  if (Number.isNaN(n) || full.length !== 6) return [2, 132, 118]; // fallback: HOMS default teal
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function applyBranding(branding) {
  const primary = (branding && branding.primary) || "#028476";
  const [r, g, b] = hexToRgb(primary);
  document.documentElement.style.setProperty("--accent", primary);
  document.documentElement.style.setProperty("--accent-weak", `rgba(${r}, ${g}, ${b}, 0.10)`);
}

function badge(text, tone) {
  if (!text) return `<span class="badge neutral">—</span>`;
  return `<span class="badge ${tone}">${esc(text)}</span>`;
}

function paymentBadge(status) {
  if (status === "paid") return badge("Paid", "good");
  if (status === "pending") return badge("Pending", "warn");
  if (status === "failed" || status === "refunded") return badge(status, "bad");
  return badge(status, "neutral");
}

function syncBadge(status) {
  if (status === "connected") return badge("Connected", "good");
  if (status === "disconnected" || status === "error") return badge(status, "bad");
  return badge(status, "neutral");
}

function checklistBadge(status) {
  if (status === "pass__guest_ready") return badge("Pass — Guest Ready", "good");
  if (status === "needs_followup") return badge("Needs Follow-up", "warn");
  if (status === "failed_inspection") return badge("Failed Inspection", "bad");
  return badge(status, "neutral");
}

// ---------- Filters (multi-condition, per tab) ----------
const filterState = { properties: {}, ota: {}, transactions: {}, checklists: {}, expenses: {}, inventory: {} };

function distinct(list, key) {
  const seen = new Map();
  list.forEach((r) => {
    const v = r[key];
    if (v !== null && v !== undefined && v !== "") seen.set(String(v), v);
  });
  return [...seen.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
}

function distinctPairs(list, idKey, nameKey) {
  const seen = new Map();
  list.forEach((r) => {
    const id = r[idKey];
    if (id) seen.set(id, r[nameKey] || id);
  });
  return [...seen.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
}

function matchesFilters(record, tabKey, dateField) {
  const f = filterState[tabKey];
  for (const [key, val] of Object.entries(f)) {
    if (!val) continue;
    if (key === "__year") {
      if (!record[dateField] || record[dateField].slice(0, 4) !== val) return false;
      continue;
    }
    if (key === "__month") {
      if (!record[dateField] || record[dateField].slice(5, 7) !== val) return false;
      continue;
    }
    if (String(record[key] ?? "") !== String(val)) return false;
  }
  return true;
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function renderFilterBar(tabKey, defs, dateField, list) {
  const state = filterState[tabKey];
  const hasActive = Object.values(state).some(Boolean);
  let html = '<div class="filter-bar">';
  for (const def of defs) {
    html += `<select class="filter-select" data-tab="${tabKey}" data-field="${def.key}">
      <option value="">${esc(def.label)}: All</option>
      ${def.options.map((o) => `<option value="${esc(o.value)}" ${String(state[def.key] ?? "") === String(o.value) ? "selected" : ""}>${esc(o.label)}</option>`).join("")}
    </select>`;
  }
  if (dateField) {
    const years = [...new Set(list.map((r) => r[dateField]).filter(Boolean).map((v) => v.slice(0, 4)))].sort().reverse();
    html += `<select class="filter-select" data-tab="${tabKey}" data-field="__year">
      <option value="">Year: All</option>
      ${years.map((y) => `<option value="${y}" ${state.__year === y ? "selected" : ""}>${y}</option>`).join("")}
    </select>`;
    html += `<select class="filter-select" data-tab="${tabKey}" data-field="__month">
      <option value="">Month: All</option>
      ${MONTH_NAMES.map((name, i) => {
        const val = String(i + 1).padStart(2, "0");
        return `<option value="${val}" ${state.__month === val ? "selected" : ""}>${name}</option>`;
      }).join("")}
    </select>`;
  }
  if (hasActive) html += `<button class="btn filter-clear" data-tab="${tabKey}">Clear filters</button>`;
  html += "</div>";
  return html;
}

function renderFilterableTab({ tabKey, panelId, list, filterDefs, dateField, headers, rowFn, colspan, emptyLabel, extraToolbarHtml = "" }) {
  const filtered = list.filter((r) => matchesFilters(r, tabKey, dateField));
  const rowsHtml = filtered.map(rowFn).join("") ||
    emptyRow(colspan, list.length > 0 ? `No ${emptyLabel} match these filters` : `No ${emptyLabel} yet`);
  $(panelId).innerHTML = extraToolbarHtml + renderFilterBar(tabKey, filterDefs, dateField, list) + table(headers, rowsHtml, filtered.length);
}

// Point the manifest at this account, so an installed icon reopens it rather
// than a page saying no location was specified.
function pointManifestAtAccount() {
  const link = document.getElementById("manifestLink");
  const id = getLocationId();
  if (link && id) link.href = `/manifest.webmanifest?locationId=${encodeURIComponent(id)}`;
}

function getLocationId() {
  const fromUrl = new URLSearchParams(location.search).get("locationId");
  if (fromUrl) {
    localStorage.setItem("homs_admin_locationId", fromUrl);
    return fromUrl;
  }
  return localStorage.getItem("homs_admin_locationId");
}

// --- Auth -------------------------------------------------------------------
// Every /api route now requires an admin key. The key is exchanged once for an
// HttpOnly cookie via POST /api/login, so it never lives in JS, in localStorage,
// or in a URL. credentials:"include" is required on every call because GHL frames
// this dashboard cross-origin.
//
// The key is collected with an inline form rather than window.prompt(), which
// browsers block inside cross-origin iframes -- i.e. exactly where this runs.

function promptForKey() {
  return new Promise((resolve) => {
    const host = $("#error");
    host.hidden = false;
    host.innerHTML =
      '<div class="auth-gate">' +
      "<p><strong>Admin key required</strong></p>" +
      '<input id="adminKeyInput" type="password" placeholder="Admin key" autocomplete="current-password" />' +
      '<button id="adminKeySubmit" class="btn">Unlock</button>' +
      '<span id="adminKeyMsg" class="auth-msg"></span>' +
      "</div>";

    const submit = async () => {
      const key = $("#adminKeyInput").value;
      if (!key) return;
      const msg = $("#adminKeyMsg");
      msg.textContent = "Checking…";
      try {
        const r = await fetch("/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          // The account being opened. The operator's key ignores it; a client's
          // key is only meaningful against their own account.
          body: JSON.stringify({ key, locationId: getLocationId() }),
        });
        if (r.ok) {
          host.hidden = true;
          host.innerHTML = "";
          resolve(true);
          return;
        }
        msg.textContent = "Not accepted.";
      } catch {
        msg.textContent = "Couldn't reach the server.";
      }
    };

    $("#adminKeySubmit").addEventListener("click", submit);
    $("#adminKeyInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
    $("#adminKeyInput").focus();
  });
}

async function apiFetch(url, opts = {}, allowPrompt = true) {
  const res = await fetch(url, { ...opts, credentials: "include" });
  if (res.status !== 401 || !allowPrompt) return res;
  await promptForKey();
  return apiFetch(url, opts, false);
}

// Whether this account shows OTA Channels at all. The records are always
// fetched -- the reports and the transaction joins read them for property and
// commission names either way -- this only decides what is put on screen.
const showOta = () => DATA?.showOtaChannels === true;

async function loadData() {
  $("#loading").hidden = false;
  $("#error").hidden = true;

  const locationId = getLocationId();
  if (!locationId) {
    $("#loading").hidden = true;
    $("#error").hidden = false;
    $("#error").innerHTML =
      "No location specified. Open this dashboard via its GHL Custom Menu Link " +
      "(URL should end in <code>?locationId={{location.id}}</code>), or append " +
      "<code>?locationId=YOUR_LOCATION_ID</code> manually for testing.";
    return;
  }

  try {
    const res = await apiFetch("/api/data?locationId=" + encodeURIComponent(locationId));
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || tr("Failed to load data"));
    DATA = json;
    LOCALE = resolveLocale(json.statementLocale);
    // The statement panel keeps its own language state so a viewer can switch
    // one statement without re-rendering the dashboard. It starts where the
    // account is, rather than always at English.
    statementState.lang = LOCALE;
    applyBranding(json.branding);
    // Hidden rather than removed, so turning the flag on needs no deploy.
    const otaTab = document.querySelector('.tab[data-tab="ota"]');
    if (otaTab) otaTab.hidden = !showOta();
    const otaPanel = $("#panel-ota");
    if (otaPanel && !showOta()) otaPanel.hidden = true;
    const search = $("#search");
    if (search && !showOta()) {
      search.placeholder = search.placeholder.replace(/,\s*OTA channel/i, "");
    }
    $("#fetchedAt").textContent = tr("Updated") + " " + new Date(json.fetchedAt).toLocaleTimeString();
    // The header used to carry a hardcoded "DEMO" pill from when this only ran
    // against DEMO-HOMS -- it showed on every tenant regardless of account.
    const label = $("#tenantLabel");
    if (label) label.textContent = json.tenantLabel || "Admin Dashboard";
    renderAll();
    paintLangToggle();
    pointManifestAtAccount();
    startLocalizeObserver();
  } catch (err) {
    $("#error").hidden = false;
    $("#error").textContent = tr("Couldn't load data:") + " " + err.message;
  } finally {
    $("#loading").hidden = true;
  }
}

function renderTab(tabKey) {
  const fn = { properties: renderProperties, ota: renderOta, transactions: renderTransactions, checklists: renderChecklists, expenses: renderExpenses, inventory: renderInventory }[tabKey];
  if (fn) fn();
}

// --- manager statement ------------------------------------------------------
//
// Rendered from the invoicing Worker's figures, never recomputed here. This
// Worker's transactions object carries booking_total, platform_fee and
// net_payout and nothing else -- no cleaning fee, no commission split -- so the
// manager's own economics simply do not exist in this dataset. Proxied through
// /api/manager-pl so there is one definition of the manager's money.
//
// Yari, 2026-09-30, on the manager statement that already existed: "what we
// have is great but they already have that in the transactions tab under
// payments." The payments tab lists what GUESTS paid. This answers what the
// MANAGER earned, which is a different number and was visible nowhere.
//
// Labels are emitted in English on purpose: localize() walks the rendered DOM
// and swaps them, so Spanish comes from the same dictionary as the rest of the
// page rather than a second one that drifts. That walker matches whole text
// nodes, so every number is kept OUT of its sentence -- a figure interpolated
// mid-sentence makes that sentence match nothing and silently stay English.
let managerPl = { month: null, data: null, error: null, loading: false };

async function loadManagerPl() {
  const locationId = getLocationId();
  if (!locationId) return;
  managerPl.loading = true;
  managerPl.error = null;
  renderManagerStatement();

  const params = new URLSearchParams({ locationId });
  // No month selected is the "All time" entry in the dropdown, and it has to
  // say so. Sending nothing got the Worker's 30-day default, so the panel
  // claimed All time while hiding every record older than a month.
  if (!managerPl.month) params.set("period", "all");
  if (managerPl.month) {
    const [y, m] = managerPl.month.split("-").map(Number);
    params.set("from", `${managerPl.month}-01`);
    // The Worker's window treats `to` as inclusive of that whole day, so the
    // last day of the month is the right end, not the first of the next.
    params.set("to", new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10));
  }
  try {
    const res = await apiFetch("/api/manager-pl?" + params.toString());
    const json = await res.json();
    if (!res.ok) throw new Error(json.detail || json.error || `HTTP ${res.status}`);
    managerPl.data = json;
  } catch (err) {
    managerPl.data = null;
    managerPl.error = err.message || String(err);
  } finally {
    managerPl.loading = false;
    renderManagerStatement();
  }
}

function managerMonths() {
  const months = new Set();
  (DATA?.transactions || []).forEach((x) => x.checkinDate && months.add(x.checkinDate.slice(0, 7)));
  (DATA?.expenses || []).forEach((x) => x.paidOn && months.add(x.paidOn.slice(0, 7)));
  return [...months].sort().reverse();
}

// Number outside the sentence, so the sentence can be translated.
// `detail` is kept in its own element rather than concatenated into `phrase`.
// localize() only swaps WHOLE text nodes, so "…not in the total yet: Carpet
// Wash, Pest Control" would match no dictionary key and stay English forever --
// the exact trap case 9 of the locale suite exists to catch. It is also right
// on its own terms: the phrase is a label and the detail is the client's data,
// which must never be translated.
const warnLine = (figure, phrase, detail) =>
  `<p class="warn"><strong>${esc(String(figure))}</strong> <span>${phrase}</span>${
    detail ? ` <span class="warn-detail">${esc(detail)}</span>` : ""}</p>`;

function renderManagerStatement() {
  const panel = $("#panel-managerstmt");
  if (!panel) return;

  const months = managerMonths();
  const monthOptions = [`<option value="">All time</option>`]
    .concat(months.map((m) => `<option value="${m}"${m === managerPl.month ? " selected" : ""}>${esc(monthLabel(m))}</option>`))
    .join("");

  const toolbar = `
    <div class="panel-toolbar">
      <select id="mgrMonth" class="filter-select">${monthOptions}</select>
      <button class="btn" id="mgrPrint">Print / Save as PDF</button>
    </div>`;

  if (managerPl.loading) {
    panel.innerHTML = toolbar + `<div class="state-msg">Loading live data from GHL…</div>`;
    return;
  }
  if (managerPl.error) {
    panel.innerHTML = toolbar + `<div class="state-msg error">${esc(managerPl.error)}</div>`;
    return;
  }
  const pl = managerPl.data;
  if (!pl) {
    panel.innerHTML = toolbar + `<div class="state-msg">No entries in this period.</div>`;
    return;
  }

  const cur = pl.currency || "USD";
  const m = (n) => moneyIn(n, cur);
  const c = pl.cleaning || {};

  // Anything left out of a total is shown as loudly as the total. A manager
  // statement that quietly omits a cost is the problem this was built to fix.
  const warn = [];
  if (pl.mixedIncomeCurrency) {
    warn.push(warnLine("!", "The ledger holds more than one currency for this manager, so income is not totalled."));
  }
  if (c.jobsWithoutCost?.length) {
    warn.push(warnLine(c.jobsWithoutCost.length, "clean(s) here have no cleaner cost recorded, so the cleaning figure below is too high."));
  }
  if (c.unpaidCleanerJobs) {
    warn.push(warnLine(m(c.unpaidCleaners), "is owed to cleaners for completed cleans with no payment date."));
  }
  const payouts = pl.ownerPayouts || {};
  if (payouts.unattributed) {
    warn.push(warnLine(m(payouts.unattributed.owed),
      "is not attributed to any owner, and cannot be paid to anybody until those rows carry a name."));
  }
  // Grouped by WHY, and the records named.
  //
  // This used to be one number -- "3 expense(s) are left out of the total" --
  // and Yari, 2026-10-05, had to ask what it meant: "is it safe to assume that
  // any expense in dop will be left out of the total? that doesn't make sense
  // if we are converting to usd." A fair reading of a count that explains
  // nothing, and the wrong one: they were unapproved, not foreign. The Worker's
  // own HTML page had said so all along; this panel, which is the thing anybody
  // actually opens, threw the reason away. The payload carried it the whole
  // time.
  const EXCLUSION_REASONS = [
    ["not_approved", 'expense(s) still say "Needs Review" and are not in the total yet:'],
    ["unconverted_currency", "expense(s) are in another currency with no converted amount, and converting them by guesswork would be a wrong number that looks right:"],
    ["no_amount", "expense(s) have no amount, so there is nothing to count:"],
    ["not_attributed", "expense(s) do not say who pays for them, so they are counted against nobody. Set Paid By to Owner or Manager on:"],
  ];
  for (const [issue, phrase] of EXCLUSION_REASONS) {
    const hit = (pl.excluded || []).filter((e) => (e.issues || []).includes(issue));
    if (hit.length) warn.push(warnLine(hit.length, phrase, hit.map((e) => e.name || e.id).join(", ")));
  }
  // A reason this build does not know about must still be reported, or a new
  // exclusion added to the Worker would silently stop appearing here.
  const named = new Set(EXCLUSION_REASONS.map(([i]) => i));
  const other = (pl.excluded || []).filter((e) => !(e.issues || []).some((i) => named.has(i)));
  if (other.length) {
    warn.push(warnLine(other.length, "expense(s) are left out of the total."));
  }
  if (pl.undated?.length) {
    warn.push(warnLine(pl.undated.length, "expense(s) have no Paid On date, so they fall into no period at all."));
  }

  const catRows = (pl.byCategory || [])
    .map((x) => `<tr><td>${esc(x.label || x.category)}</td><td class="n">${x.count}</td><td class="n">${m(x.total)}</td></tr>`)
    .join("") || emptyRow(3, "No approved expenses in this period.");

  const turnRows = (c.byTurnover || [])
    .map((x) => `<tr><td>${esc(x.label)}</td><td class="n">${x.count}</td><td class="n">${m(x.total)}</td></tr>`)
    .join("");

  panel.innerHTML = toolbar + `
    <div class="statement-sheet" id="managerSheet">
      <h2>Manager Statement</h2>
      <p class="statement-period">${managerPl.month ? esc(monthLabel(managerPl.month)) : "All time"}</p>
      ${warn.join("")}

      <table class="statement-summary">
        <tbody>
          <tr><td>Income from bookings</td><td>${pl.mixedIncomeCurrency ? "—" : m(pl.income)}</td></tr>
          <tr><td>Expenses</td><td>(${m(pl.expenses)})</td></tr>
          <tr class="statement-net"><td>${pl.netIsCeiling ? "Net (at most)" : "Net"}</td><td>${m(pl.net)}</td></tr>
          <tr><td>Deducted from owner payouts</td><td>${m(pl.ownerBorneTotal)}</td></tr>
        </tbody>
      </table>
      ${pl.netIsCeiling ? `<p class="note">At most: cleans with no cleaner cost recorded are missing from this, so the real figure is lower.</p>` : ""}
      ${(pl.ownerBorneByCurrency || []).some((c) => c.currency !== cur)
        ? `<p class="note">Deducted from owner payouts was recorded as ${pl.ownerBorneByCurrency.map((c) => esc(moneyIn(c.total, c.currency))).join(", ")}, converted at the rate stored on each expense.</p>`
        : ""}
      <p class="note">Expenses are what the manager pays for themselves, plus what was paid to cleaners. An owner's costs come off that owner's payout instead and are shown separately.</p>
      ${pl.ownerBorneCount
        ? `<p class="note"><strong>${pl.ownerBorneCount}</strong> <span>expense(s) come off the owners' payouts rather than counting here.</span> <span class="warn-detail">${esc(m(pl.ownerBorneTotal))}</span></p>`
        : ""}

      ${c.collected || c.paidToCleaners ? `
      <h3>Cleaning</h3>
      <p class="note">Part of the income above, not additional to it.</p>
      <table class="statement-summary">
        <tbody>
          <tr><td>Cleaning fees collected</td><td>${m(c.collected)}</td></tr>
          <tr><td>Paid to cleaners</td><td>${c.marginKnown === false ? "—" : `(${m(c.paidToCleaners)})`}</td></tr>
          <tr class="statement-net"><td>${c.marginIsCeiling ? "Kept on cleaning (at most)" : "Kept on cleaning"}</td><td>${c.marginKnown === false ? "—" : m(c.margin)}</td></tr>
        </tbody>
      </table>
      ${c.marginKnown === false ? `<p class="note">No cleaner cost is recorded for any clean in this period, so what was kept on cleaning cannot be worked out. The fee collected is shown; the rest is left blank because there is nothing to base it on.</p>` : ""}
      ${c.marginIsCeiling ? `<p class="note">At most: cleans with no cleaner cost recorded are missing from this, so the real figure is lower.</p>` : ""}
      ${turnRows ? `<table><tr><th>Turnover Type</th><th class="n">Count</th><th class="n">Amount</th></tr>${turnRows}</table>` : ""}` : ""}

      ${payouts.owners?.length ? `
      <h3>Owed to owners</h3>
      <p class="note">What this period earned for each owner, for you to pay through your own payout method. This page does not move money and does not record whether you have paid.</p>
      <table>
        <tr><th>Owner</th><th class="n">Count</th><th class="n">Amount</th></tr>
        ${payouts.owners.map((o) => `<tr><td>${esc(o.name)}</td><td class="n">${o.entries}</td><td class="n">${o.mixedCurrency ? "—" : moneyIn(o.owed, o.currency || cur)}</td></tr>`).join("")}
        <tr class="statement-net"><td>Total owed</td><td class="n"></td><td class="n">${m(payouts.total)}</td></tr>
      </table>` : ""}

      <h3>Expenses by category</h3>
      <table><tr><th>Category</th><th class="n">Count</th><th class="n">Amount</th></tr>${catRows}</table>
    </div>`;
}

function renderAll({ refetch = true } = {}) {
  // A vendor tenant (HOMS itself) is its own book, not a client account. Nothing
  // below applies to it -- no properties, no bookings, no guests.
  if (DATA.kind === "vendor") return renderVendor();
  renderOverview();
  renderProperties();
  renderOta();
  renderTransactions();
  renderChecklists();
  renderExpenses();
  renderInventory();
  renderReports();
  renderStatement();
  renderManagerStatement();
  // Fetched rather than computed, so it arrives after the first paint. Not
  // awaited: the rest of the dashboard must not wait on the invoicing Worker.
  if (refetch) loadManagerPl();
}

// ---------- Vendor P&L (own book) ----------
// Separate render path, not a variant of the client dashboard. Serves both HOMS
// (the product) and DTCS (the entity); which one is loaded is stated on the page.
//
// Revenue has two sources and they are always shown separately: what GHL
// processed, and what was recorded from outside GHL (Upwork, partner earnings).
// Reading GHL alone reported $0 for a year that actually earned ~$20k.

const CATEGORY_LABELS = {
  platform: "Platform",
  infrastructure: "Infrastructure",
  office: "Office",
  telecom: "Telecom",
  contractors: "Contractors & professional",
  marketing: "Marketing",
  payment_fees: "Payment fees",
  software: "Software",
  other: "Other",
};

const RECURRENCE_LABELS = { one_off: "One-off", monthly: "Monthly", annual: "Annual" };

const SOURCE_LABELS = {
  upwork: "Upwork",
  fableforge: "FableForge (partner)",
  ghl: "GHL payments",
  direct: "Direct / bank transfer",
  other: "Other",
};

// money() prints "$-76.06"; financial statements want "-$76.06".
function usd(n) {
  const v = Number(n) || 0;
  return `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(2)}`;
}

function signedMoney(n) {
  const v = Number(n) || 0;
  const cls = v < 0 ? "bad" : v > 0 ? "good" : "neutral";
  return `<span class="badge ${cls}">${usd(v)}</span>`;
}

const GHL_COLLECTED = (t) => t.liveMode && /succeeded|paid|completed/i.test(t.status || "");

// Income statement for one calendar year. Pure: reads DATA, returns numbers.
// Cash basis -- an expense counts in the year it was PAID, revenue in the year it
// was RECEIVED. Anything without a date can't be placed in a year and is reported
// as excluded rather than quietly dropped into the wrong one.
//
// Platform fees are shown as a deduction from gross revenue (gross -> net), not
// buried in operating expenses: they are the cost of the channel, and Yari chose
// gross-with-fees-broken-out specifically so this line stays visible.
function plStatementFor(year) {
  const y = String(year);
  const inYear = (d) => d && String(d).slice(0, 4) === y;

  const expensesInYear = (DATA.expenses || []).filter((e) => inYear(e.paidOn));
  const ghlInYear = (DATA.transactions || []).filter((t) => GHL_COLLECTED(t) && inYear(t.paidAt));
  const recordedInYear = (DATA.revenue || []).filter((r) => inYear(r.receivedOn));

  const bySource = {};
  for (const r of recordedInYear) {
    if (!bySource[r.source]) bySource[r.source] = { gross: 0, fees: 0, net: 0, count: 0 };
    bySource[r.source].gross += r.gross;
    bySource[r.source].fees += r.fees;
    bySource[r.source].net += r.net;
    bySource[r.source].count += 1;
  }
  const ghlTotal = ghlInYear.reduce((s, t) => s + t.amount, 0);
  if (ghlTotal) bySource.ghl = { gross: ghlTotal, fees: 0, net: ghlTotal, count: ghlInYear.length };

  const grossRevenue = Object.values(bySource).reduce((s, v) => s + v.gross, 0);
  const platformFees = Object.values(bySource).reduce((s, v) => s + v.fees, 0);
  const netRevenue = grossRevenue - platformFees;

  const byCategory = {};
  for (const e of expensesInYear) byCategory[e.category] = (byCategory[e.category] || 0) + e.amount;
  const totalExpense = expensesInYear.reduce((s, e) => s + e.amount, 0);

  return {
    year: y,
    bySource,
    grossRevenue,
    platformFees,
    netRevenue,
    byCategory,
    totalExpense,
    net: netRevenue - totalExpense,
    expenseCount: expensesInYear.length,
    revenueCount: recordedInYear.length + ghlInYear.length,
    excludedExpenses: (DATA.expenses || []).filter((e) => !e.paidOn || !e.amount),
    undatedRevenue: (DATA.revenue || []).filter((r) => !r.receivedOn),
  };
}

function statementYears() {
  const ys = new Set();
  for (const e of DATA.expenses || []) if (e.paidOn) ys.add(String(e.paidOn).slice(0, 4));
  for (const t of DATA.transactions || []) if (t.paidAt && GHL_COLLECTED(t)) ys.add(String(t.paidAt).slice(0, 4));
  for (const r of DATA.revenue || []) if (r.receivedOn) ys.add(String(r.receivedOn).slice(0, 4));
  ys.add(String(new Date().getFullYear()));
  return [...ys].sort().reverse();
}

function statementCsv(st) {
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const n = (v) => (Number(v) || 0).toFixed(2);
  const rows = [
    [q(DATA.tenantLabel || "Account"), "", ""],
    [q("Profit & Loss - cash basis"), "", ""],
    [q(`For the year ended December 31, ${st.year}`), "", ""],
    [q(`Prepared ${new Date().toISOString().slice(0, 10)}`), "", ""],
    [],
    [q("REVENUE"), "", ""],
    ...Object.entries(st.bySource)
      .sort((a, b) => b[1].gross - a[1].gross)
      .map(([k, v]) => [q(SOURCE_LABELS[k] || k), n(v.gross), q(`${v.count} entr${v.count === 1 ? "y" : "ies"}`)]),
    [q("Gross revenue"), n(st.grossRevenue), ""],
    [q("Less platform fees"), n(-st.platformFees), ""],
    [q("Net revenue"), n(st.netRevenue), ""],
    [],
    [q("OPERATING EXPENSES"), "", ""],
    ...Object.entries(st.byCategory)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => [q(CATEGORY_LABELS[k] || k), n(v), ""]),
    [q("Total operating expenses"), n(st.totalExpense), q(`${st.expenseCount} record(s)`)],
    [],
    [q(st.net < 0 ? "NET LOSS" : "NET INCOME"), n(st.net), ""],
  ];
  if (st.excludedExpenses.length || st.undatedRevenue.length) {
    rows.push([], [q("EXCLUDED - no date, so not counted in any year"), "", ""]);
    for (const e of st.excludedExpenses) rows.push([q(`Expense: ${e.name}`), n(e.amount), q("no paid date")]);
    for (const r of st.undatedRevenue) rows.push([q(`Revenue: ${r.name}`), n(r.net), q("no received date")]);
  }
  return rows.map((r) => r.join(",")).join("\r\n");
}

function downloadCsvText(filename, csv) {
  // BOM so Excel opens UTF-8 correctly rather than mangling it.
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function renderStatementSection(year) {
  const st = plStatementFor(year);
  const years = statementYears();

  const sourceRows =
    Object.entries(st.bySource)
      .sort((a, b) => b[1].gross - a[1].gross)
      .map(([k, v]) => `<tr><td>${esc(SOURCE_LABELS[k] || k)}</td><td>${usd(v.gross)}</td></tr>`)
      .join("") || `<tr><td colspan="2" class="muted">No revenue dated in ${esc(st.year)}</td></tr>`;

  const catRows =
    Object.entries(st.byCategory)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `<tr><td>${esc(CATEGORY_LABELS[k] || k)}</td><td>${usd(v)}</td></tr>`)
      .join("") || `<tr><td colspan="2" class="muted">No expenses dated in ${esc(st.year)}</td></tr>`;

  const excludedCount = st.excludedExpenses.length + st.undatedRevenue.length;
  const excludedNote = excludedCount
    ? `<p class="note error"><strong>${excludedCount} record${excludedCount === 1 ? "" : "s"} excluded</strong> — no date, so ${
        excludedCount === 1 ? "it belongs" : "they belong"
      } to no year: ${[...st.excludedExpenses, ...st.undatedRevenue].map((e) => esc(e.name)).join(", ")}</p>`
    : "";

  return `
    <div class="stmt-controls">
      <label>Year
        <select id="stmtYear" class="filter-select">
          ${years.map((y) => `<option value="${y}" ${y === st.year ? "selected" : ""}>${y}</option>`).join("")}
        </select>
      </label>
      <button id="stmtCsv" class="btn">Download CSV</button>
      <button id="stmtPrint" class="btn">Print / Save as PDF</button>
    </div>
    <div id="stmtDoc" class="stmt-doc">
      <h2>${esc(DATA.tenantLabel || "Account")}</h2>
      <p><strong>Profit &amp; Loss</strong> — cash basis<br>
         For the year ended December 31, ${esc(st.year)}<br>
         <small class="muted">Prepared ${new Date().toLocaleDateString()}</small></p>
      <h4>Revenue</h4>
      <table><tbody>
        ${sourceRows}
        <tr class="stmt-total"><td>Gross revenue</td><td>${usd(st.grossRevenue)}</td></tr>
        <tr><td>Less platform fees</td><td>${usd(-st.platformFees)}</td></tr>
        <tr class="stmt-total"><td><strong>Net revenue</strong></td><td><strong>${usd(st.netRevenue)}</strong></td></tr>
      </tbody></table>
      <h4>Operating expenses</h4>
      <table><tbody>
        ${catRows}
        <tr class="stmt-total"><td><strong>Total operating expenses</strong></td><td><strong>${usd(st.totalExpense)}</strong></td></tr>
      </tbody></table>
      <table><tbody>
        <tr class="stmt-net"><td><strong>${st.net < 0 ? "Net loss" : "Net income"}</strong></td><td><strong>${signedMoney(st.net)}</strong></td></tr>
      </tbody></table>
      ${excludedNote}
      <p class="note"><small>Cash basis: an expense counts in the year it was paid, revenue in the year it was received. Platform fees are deducted from gross revenue rather than listed as an operating expense.</small></p>
    </div>`;
}

function wireStatement() {
  const yearSel = $("#stmtYear");
  if (!yearSel) return;
  const host = $("#stmtSection");
  yearSel.addEventListener("change", (e) => {
    host.innerHTML = renderStatementSection(e.target.value);
    wireStatement();
  });
  $("#stmtCsv").addEventListener("click", () => {
    const y = $("#stmtYear").value;
    const who = (DATA.tenantLabel || "Account").replace(/[^A-Za-z0-9]+/g, "-");
    downloadCsvText(`${who}-P&L-${y}.csv`, statementCsv(plStatementFor(y)));
  });
  $("#stmtPrint").addEventListener("click", () => window.print());
}

function renderVendor() {
  const { pl, expenses, transactions, subscriptions, warnings = [] } = DATA;
  const revenue = DATA.revenue || [];

  // Remove the client tab buttons outright rather than hiding them. Hidden
  // buttons are still in the DOM and their click handler calls showTab(), which
  // un-hides client panels on an account that has no client data.
  const tabs = $("#tabs");
  if (tabs) {
    tabs.innerHTML = "";
    tabs.hidden = true;
  }
  document.querySelectorAll(".panel").forEach((p) => (p.hidden = true));
  $("#searchResults").hidden = true;
  const search = $("#search");
  if (search) search.placeholder = "Search expenses and revenue by name, vendor, payer or category…";
  const host = $("#panel-overview");
  host.hidden = false;

  // Current-year figures lead. All-time totals mix years and hide trend; the
  // statement section below covers any other year.
  const thisYear = String(new Date().getFullYear());
  const fy = plStatementFor(thisYear);

  // Which account this is, stated on the page. getLocationId() falls back to
  // localStorage, so a bare URL silently shows whichever account was opened last.
  const whoami = `<p class="note banner"><strong>${esc(DATA.tenantLabel || "Account")}</strong> — own book.
    Location <code>${esc(DATA.locationId)}</code>.
    ${DATA.revenueTracked === false ? "Revenue here comes from GHL payments only." : "Revenue combines GHL payments with recorded entries (Upwork, partner earnings)."}</p>`;

  // "Unavailable" and "zero" must not look the same. A failed read is stated.
  const warnHtml = warnings.length
    ? warnings
        .map((w) => `<p class="note error"><strong>${esc(w.source)}</strong> could not be read (${esc(String(w.status))}). ${esc(w.impact)}</p>`)
        .join("")
    : "";

  const kpis = `
    <div class="card-grid">
      <div class="stat-card"><div class="num">${usd(fy.netRevenue)}</div><div class="label">Net revenue ${thisYear}</div></div>
      <div class="stat-card"><div class="num">${usd(fy.totalExpense)}</div><div class="label">Expenses ${thisYear}</div></div>
      <div class="stat-card"><div class="num">${usd(fy.net)}</div><div class="label">${fy.net < 0 ? "Net loss" : "Net income"} ${thisYear}</div></div>
      <div class="stat-card"><div class="num">${usd(pl.cost.monthlyBurn)}</div><div class="label">Fixed monthly burn</div></div>
      <div class="stat-card"><div class="num">${usd(pl.revenue.mrr)}</div><div class="label">MRR (GHL subscriptions)</div></div>
    </div>`;

  const incompleteNote = pl.incompleteRecords.length
    ? `<p class="note error"><strong>${pl.incompleteRecords.length} expense${
        pl.incompleteRecords.length === 1 ? "" : "s"
      } missing an amount or paid date</strong> — excluded from monthly figures: ${pl.incompleteRecords.map((r) => esc(r.name)).join(", ")}</p>`
    : "";

  // ---- Revenue ----
  const R = pl.revenue;
  const payerRows =
    Object.entries(R.byPayer || {})
      .sort((a, b) => b[1].net - a[1].net)
      .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v.count}</td><td>${usd(v.gross)}</td><td>${usd(v.net)}</td></tr>`)
      .join("") || emptyRow(4, "No recorded revenue");

  const sourceEntries = Object.entries(R.bySource || {});
  const sourceRows =
    sourceEntries
      .sort((a, b) => b[1].gross - a[1].gross)
      .map(([k, v]) => `<tr><td>${esc(SOURCE_LABELS[k] || k)}</td><td>${usd(v.gross)}</td><td>${usd(-v.fees)}</td><td>${usd(v.net)}</td></tr>`)
      .join("") || emptyRow(4, "No revenue yet");

  const revenueSection = `
    <h3>Revenue — all time</h3>
    <p class="note">Gross ${usd(R.grossRevenue)} · platform fees ${usd(-R.recordedFees)} · net ${usd(R.netRevenue)}.
      GHL-processed ${usd(R.totalCollected)}, recorded outside GHL ${usd(R.recordedGross)} gross.</p>
    <div class="rev-split">
      <div>
        <h4>By source</h4>
        ${table(["Source", "Gross", "Fees", "Net"], sourceRows, sourceEntries.length)}
      </div>
      <div>
        <h4>By payer</h4>
        ${table(["Payer", "Entries", "Gross", "Net"], payerRows, Object.keys(R.byPayer || {}).length)}
      </div>
    </div>`;

  const monthRows =
    pl.timeline
      .slice()
      .reverse()
      .map((m) => `<tr><td>${esc(m.month)}</td><td>${usd(m.revenue)}</td><td>${usd(m.expense)}</td><td>${signedMoney(m.net)}</td></tr>`)
      .join("") || emptyRow(4, "No dated activity yet");

  const burnRows =
    pl.cost.burnLines
      .map(
        (l) => `<tr>
          <td>${esc(l.name)}</td><td>${dash(l.vendor)}</td>
          <td>${esc(CATEGORY_LABELS[l.category] || l.category)}</td>
          <td>${esc(RECURRENCE_LABELS[l.recurrence] || l.recurrence)}</td>
          <td>${dateFmt(l.asOf)}</td><td>${usd(l.monthly)}</td>
        </tr>`
      )
      .join("") || emptyRow(6, "No recurring costs recorded");

  const catRows =
    Object.entries(pl.byCategory)
      .sort((a, b) => b[1].total - a[1].total)
      .map(([k, v]) => `<tr><td>${esc(CATEGORY_LABELS[k] || k)}</td><td>${v.count}</td><td>${usd(v.monthly)}</td><td>${usd(v.total)}</td></tr>`)
      .join("") || emptyRow(4, "No expenses recorded");

  const revenueRows =
    revenue
      .slice()
      .sort((a, b) => String(b.receivedOn || "").localeCompare(String(a.receivedOn || "")))
      .map(
        (r) => `<tr>
          <td>${esc(r.name)}${r.entryType === "adjustment" ? ' <span class="badge bad">adjustment</span>' : ""}</td>
          <td>${dash(r.payer)}</td>
          <td>${esc(SOURCE_LABELS[r.source] || r.source)}</td>
          <td>${dateFmt(r.receivedOn)}</td>
          <td>${usd(r.gross)}</td><td>${usd(r.net)}</td>
        </tr>`
      )
      .join("") || emptyRow(6, "No recorded revenue");

  const expenseRows =
    expenses
      .slice()
      .sort((a, b) => String(b.paidOn || "").localeCompare(String(a.paidOn || "")))
      .map(
        (e) => `<tr>
          <td>${esc(e.name)}${e.incomplete ? ' <span class="badge warn">incomplete</span>' : ""}</td>
          <td>${dash(e.vendor)}</td>
          <td>${esc(CATEGORY_LABELS[e.category] || e.category)}</td>
          <td>${esc(RECURRENCE_LABELS[e.recurrence] || e.recurrence)}</td>
          <td>${dateFmt(e.paidOn)}</td><td>${usd(e.amount)}</td>
        </tr>`
      )
      .join("") || emptyRow(6, "No expenses yet");

  const ghlRows =
    transactions
      .filter(GHL_COLLECTED)
      .map((t) => `<tr><td>${dash(t.contactName)}</td><td>${dash(t.source)}</td><td>${dateFmt(t.paidAt)}</td><td>${usd(t.amount)}</td></tr>`)
      .join("") || emptyRow(4, "No collected GHL payments");

  host.innerHTML = `
    ${whoami}
    ${warnHtml}
    ${kpis}
    ${incompleteNote}
    ${revenueSection}
    <h3>Month by month</h3>
    <p class="note">Net revenue in, expenses out, by the month money actually moved.</p>
    ${table(["Month", "Revenue", "Expense", "Net"], monthRows, pl.timeline.length)}
    <h3>Fixed monthly burn</h3>
    <p class="note">One line per subscription, valued at its most recent charge — not the sum of every recorded month.</p>
    ${table(["Line", "Vendor", "Category", "Recurrence", "As of", "Per month"], burnRows, pl.cost.burnLines.length)}
    <h3>Expenses by category</h3>
    ${table(["Category", "Records", "Per month", "Total recorded"], catRows, Object.keys(pl.byCategory).length)}
    <h3>Year-end P&amp;L statement</h3>
    <div id="stmtSection">${renderStatementSection(thisYear)}</div>
    <h3>Recorded revenue</h3>
    ${table(["Entry", "Payer", "Source", "Received", "Gross", "Net"], revenueRows, revenue.length)}
    <h3>GHL payments collected</h3>
    ${table(["Contact", "Source", "Date", "Amount"], ghlRows, transactions.filter(GHL_COLLECTED).length)}
    <h3>All expenses</h3>
    ${table(["Expense", "Vendor", "Category", "Recurrence", "Paid on", "Amount"], expenseRows, expenses.length)}
    ${importSection()}
  `;

  wireStatement();
  wireImport();
  renderImportPreview();
}

// ---------- Expense import (vendor books only) ----------
//
// Two steps on purpose. The server parses and returns rows; nothing is written
// until the reviewer has seen them and pressed Import. Every row stays editable
// here, because a bank export gets the vendor right and the category wrong far
// more often than the other way round.

let IMPORT_ROWS = [];
// One review can hold several files at once -- a CSV and a handful of receipts --
// so provenance lives on each row rather than on the batch.

const RECEIPT_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf"];

// Which model reads receipts. Kept per browser so a comparison run survives a
// reload, and sent per request so the same receipt can be tried both ways.
const READER_MODELS = [
  ["claude-opus-5", "Opus 5 — most accurate"],
  ["claude-sonnet-5", "Sonnet 5 — middle"],
  ["claude-haiku-4-5", "Haiku 4.5 — cheapest"],
];
function readerModel() {
  try { return localStorage.getItem("receiptModel") || READER_MODELS[0][0]; } catch { return READER_MODELS[0][0]; }
}
// Sub-cent reads are the normal case on the cheaper models, and "$0.00" reads as
// free rather than cheap. Under a cent shows in cents.
const usd4 = (n) => (n < 0.01 ? `${(n * 100).toFixed(2)}¢` : "$" + n.toFixed(2));

const IMPORT_CATEGORIES = [
  ["platform", "Platform"], ["infrastructure", "Infrastructure"], ["office", "Office"],
  ["telecom", "Telecom"], ["contractors", "Contractors"], ["marketing", "Marketing"],
  ["payment_fees", "Payment fees"], ["software", "Software"], ["other", "Other"],
];
const IMPORT_RECURRENCES = [["one_off", "One-off"], ["monthly", "Monthly"], ["annual", "Annual"]];

// Plain language, because the reviewer is deciding from this text alone.
const ISSUE_LABELS = {
  no_amount: "no amount",
  zero_amount: "amount is zero",
  no_date: "no date",
  no_name: "no description",
  negative_in_source: "a credit, not a cost",
  ambiguous_date: "day/month order unclear",
  duplicate_of_existing: "already in this book",
  duplicate_in_file: "repeated in this file",
  category_guessed: "category guessed",
  category_unknown: "category not recognised",
  low_confidence: "read was unclear - check it",
  duplicate_in_queue: "same as another file in this batch",
};

function importSection() {
  return `
    <h3>Import expenses</h3>
    <p class="note">A CSV from a bank, card or vendor export, or a photo or PDF of a receipt or invoice.
      CSV columns are matched by name in English or Spanish, in any order; receipts are read for you.
      Nothing is written to the book until you review the rows and press Import.</p>
    <div class="toolbar">
      <input type="file" id="importFile" multiple accept=".csv,text/csv,text/plain,image/jpeg,image/png,image/gif,image/webp,application/pdf" />
      <label class="reader-pick">Read receipts with
        <select id="importModel">${READER_MODELS.map(([id, label]) =>
          `<option value="${id}"${id === readerModel() ? " selected" : ""}>${esc(label)}</option>`).join("")}</select>
      </label>
      <span id="importStatus" class="count"></span>
    </div>
    <div id="importPreview"></div>`;
}

function issueBadges(issues) {
  if (!issues?.length) return "";
  return issues.map((i) => `<span class="badge">${esc(ISSUE_LABELS[i] || i)}</span>`).join(" ");
}

function renderImportPreview() {
  const host = $("#importPreview");
  if (!host) return;
  if (!IMPORT_ROWS.length) { host.innerHTML = ""; return; }

  const select = (name, idx, options, value) =>
    `<select data-import="${name}" data-row="${idx}">${options
      .map(([v, label]) => `<option value="${v}"${v === value ? " selected" : ""}>${esc(label)}</option>`)
      .join("")}</select>`;

  const rows = IMPORT_ROWS.map((r, i) => `
    <tr class="${r.include ? "" : "row-muted"}">
      <td><input type="checkbox" data-import="include" data-row="${i}"${r.include ? " checked" : ""} /></td>
      <td title="${esc(r.fromFile ?? "")}">${r.line ?? ""}</td>
      <td><input type="text" data-import="name" data-row="${i}" value="${esc(r.name ?? "")}" /></td>
      <td><input type="text" data-import="vendor" data-row="${i}" value="${esc(r.vendor ?? "")}" /></td>
      <td><input type="date" data-import="paidOn" data-row="${i}" value="${esc(r.paidOn ?? "")}" /></td>
      <td><input type="number" step="0.01" min="0" data-import="amount" data-row="${i}" value="${r.amount ?? ""}" /></td>
      <td>${select("category", i, IMPORT_CATEGORIES, r.category)}</td>
      <td>${select("recurrence", i, IMPORT_RECURRENCES, r.recurrence)}</td>
      <td>${issueBadges(r.issues)}</td>
    </tr>`).join("");

  const ticked = IMPORT_ROWS.filter((r) => r.include).length;
  host.innerHTML = `
    <div class="toolbar">
      <div class="count">${ticked} of ${IMPORT_ROWS.length} row${IMPORT_ROWS.length === 1 ? "" : "s"} selected</div>
      <button id="importConfirm"${ticked ? "" : " disabled"}>Import ${ticked} expense${ticked === 1 ? "" : "s"}</button>
      <button id="importCancel" class="secondary">Cancel</button>
    </div>
    <table>
      <thead><tr>
        <th></th><th title="Line number within its own file — hover a row for the file name">Line</th><th>Description</th><th>Vendor</th><th>Paid on</th>
        <th>Amount</th><th>Category</th><th>Recurrence</th><th>Notes</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  $("#importConfirm")?.addEventListener("click", runImport);
  $("#importCancel")?.addEventListener("click", () => {
    IMPORT_ROWS = [];
    const file = $("#importFile");
    if (file) file.value = "";
    $("#importStatus").textContent = "";
    renderImportPreview();
  });
}

// FileReader rather than arrayBuffer + btoa: a large receipt overflows the call
// stack when spread into String.fromCharCode, and this is the path phones use.
function base64Of(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(new Error("Could not read that file"));
    reader.readAsDataURL(file);
  });
}

function wireImport() {
  const file = $("#importFile");
  if (!file) return;

  $("#importModel")?.addEventListener("change", (e) => {
    try { localStorage.setItem("receiptModel", e.target.value); } catch { /* private window */ }
  });

  file.addEventListener("change", async () => {
    const files = Array.from(file.files || []);
    if (!files.length) return;
    const status = $("#importStatus");

    // Sequential, not parallel: each receipt is its own read, and firing a dozen
    // at once would hammer both APIs for no gain the reviewer can see. Rows
    // accumulate into one table so the whole batch gets reviewed in one pass.
    const problems = [];
    let spent = 0;
    let read = 0;
    for (const [i, f] of files.entries()) {
      const isReceipt = RECEIPT_TYPES.includes(f.type) || /\.(jpe?g|png|gif|webp|pdf)$/i.test(f.name);
      status.textContent = files.length > 1
        ? `Reading ${i + 1} of ${files.length}: ${f.name}…`
        : `Reading ${f.name}${isReceipt ? "… this takes a few seconds" : "…"}`;
      try {
        const res = isReceipt
          ? await apiFetch("/api/expenses/parse-file", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ locationId: getLocationId(), filename: f.name, mediaType: f.type || "application/pdf", data: await base64Of(f), model: readerModel() }),
            })
          : await apiFetch("/api/expenses/parse", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ locationId: getLocationId(), csv: await f.text() }),
            });
        const out = await res.json();
        // A file that isn't a receipt comes back saying what it looked like instead.
        if (!res.ok) {
          const e = new Error(out.message || ISSUE_LABELS[out.error] || out.error || "could not be read");
          e.cost = out.cost || null;
          throw e;
        }
        const source = out.source === "receipt_upload" ? "receipt_upload" : "csv_import";
        if (out.cost) { spent += out.cost.usd; read++; }
        for (const row of out.rows) IMPORT_ROWS.push({ ...row, source, fromFile: f.name, readBy: out.model });
        if (out.truncated) problems.push(`${f.name}: only the first 300 rows were read`);
      } catch (err) {
        // One unreadable file must not throw away the ones already read. A file
        // that was read and rejected still cost something, so it still counts.
        if (err.cost) { spent += err.cost.usd; read++; }
        problems.push(`${f.name}: ${err.message}`);
      }
    }

    markQueueDuplicates();
    const ready = IMPORT_ROWS.filter((r) => r.include).length;
    const needsReview = IMPORT_ROWS.length - ready;
    status.textContent =
      `${files.length} file${files.length === 1 ? "" : "s"} read · ${IMPORT_ROWS.length} row${IMPORT_ROWS.length === 1 ? "" : "s"}, ${ready} ready` +
      (needsReview ? `, ${needsReview} needing a look` : "") +
      (read ? ` · ${read} read with ${readerModel().replace("claude-", "")}, about ${usd4(spent)}` : "") +
      (problems.length ? ` · ${problems.join(" · ")}` : "");
    file.value = "";   // so the same file can be picked again after a fix
    renderImportPreview();
  });

  // One delegated listener for the whole preview: the table is re-rendered on
  // every change, so per-input listeners would go stale.
  $("#importPreview").addEventListener("input", (e) => {
    const field = e.target.dataset?.import;
    if (!field) return;
    const row = IMPORT_ROWS[Number(e.target.dataset.row)];
    if (!row) return;
    if (field === "include") { row.include = e.target.checked; renderImportPreview(); return; }
    row[field] = field === "amount" ? (e.target.value === "" ? null : Number(e.target.value)) : (e.target.value || null);
    if (field === "amount" || field === "paidOn" || field === "name") {
      const ticked = IMPORT_ROWS.filter((r) => r.include).length;
      const btn = $("#importConfirm");
      if (btn) btn.textContent = `Import ${ticked} expense${ticked === 1 ? "" : "s"}`;
    }
  });
}

// The server dedupes each file against the book and against itself, but it never
// sees the other files in the queue. Two photos of one receipt, or a receipt that
// is also a line on the statement, would otherwise both go in.
function markQueueDuplicates() {
  const seen = new Set();
  for (const row of IMPORT_ROWS) {
    if (row.amount === null || row.amount === undefined || !row.paidOn) continue;
    const key = `${String(row.vendor || row.name || "").trim().toLowerCase()}|${Number(row.amount).toFixed(2)}|${row.paidOn}`;
    if (seen.has(key)) {
      if (!row.issues.some((x) => x.startsWith("duplicate"))) row.issues = [...row.issues, "duplicate_in_queue"];
      row.include = false;
    } else {
      seen.add(key);
    }
  }
}

async function runImport() {
  const rows = IMPORT_ROWS.filter((r) => r.include);
  if (!rows.length) return;
  const btn = $("#importConfirm");
  const status = $("#importStatus");
  if (btn) { btn.disabled = true; btn.textContent = "Importing…"; }

  try {
    const res = await apiFetch("/api/expenses/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locationId: getLocationId(), rows }),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || "Import failed");

    // Anything rejected stays on screen with the reason. Clearing the table on a
    // partial failure would hide which rows never made it into the book.
    const failedLines = new Set(out.failed.map((f) => f.line));
    IMPORT_ROWS = IMPORT_ROWS.filter((r) => failedLines.has(r.line));

    // Reload first: it re-renders the whole vendor view, which would otherwise
    // wipe the message and the rows that still need attention.
    await loadData();
    $("#importStatus").textContent = `Imported ${out.imported}.` +
      (out.failed.length ? ` ${out.failed.length} could not be saved: ${out.failed.map((f) => `line ${f.line} (${f.error})`).join("; ")}` : "");
    renderImportPreview();
  } catch (err) {
    status.textContent = err.message;
    if (btn) { btn.disabled = false; btn.textContent = "Import"; }
  }
}

// ---------- Portfolio intake (client accounts) ----------
//
// The client returns one workbook; this reads it into reviewable rows and
// creates the Property records for the ones that are ticked. The rental
// listings themselves cannot be created by any API, so what comes back with
// the rows is a checklist to work from by hand.

let PORTFOLIO_ROWS = [];
let PORTFOLIO_META = null;

const PORTFOLIO_ISSUES = {
  example_row: "the template's example row",
  already_in_account: "already in this account",
  duplicate_in_file: "repeated in this workbook",
  no_listing_name: "no listing name",
  no_base_price: "no base price",
  not_priced_per_night: "priced per week/month, not per night",
  unknown_status: "status not recognised",
  unknown_property_type: "property type not recognised",
};
const portfolioIssue = (i) => PORTFOLIO_ISSUES[i] || i.replace(/^bad_/, "could not read ").replace(/_/g, " ");

function portfolioSection() {
  return `
    <h3>Import the portfolio workbook</h3>
    <p class="note">The HOMS Portfolio Intake the client filled in (.xlsx). Properties are created from it;
      rental listings still have to be created by hand, and you get a checklist for those.
      Nothing is written until you review the rows and press Import.</p>
    <div class="toolbar">
      <input type="file" id="portfolioFile" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" />
      <span id="portfolioStatus" class="count"></span>
    </div>
    <div id="portfolioPreview"></div>`;
}

function portfolioSettingsHtml() {
  if (!PORTFOLIO_META) return "";
  const { accountSettings: a = {}, disagreements = [] } = PORTFOLIO_META;
  const bits = [];
  if (a.currency) bits.push(`<strong>Currency:</strong> ${esc(a.currency)}`);
  if (a.cancellationPolicyLabel) {
    const parsed = a.cancellationPolicy !== a.cancellationPolicyLabel
      ? ` <span class="muted">(${esc(a.cancellationPolicy)})</span>` : "";
    bits.push(`<strong>Cancellation:</strong> ${esc(a.cancellationPolicyLabel)}${parsed}`);
  }
  const settings = bits.length
    ? `<p class="note banner">Account settings read from this workbook — ${bits.join(" &nbsp;·&nbsp; ")}</p>`
    : "";

  // A disagreement is the reason this screen exists. Loud, and above the table.
  const warnings = disagreements.map((d) => {
    if (d.kind === "conflict") {
      const what = d.field === "currency" ? "currency" : "cancellation policy";
      return `<p class="note error"><strong>${esc(d.column)} is not the same on every row.</strong>
        Using <strong>${esc(d.used)}</strong> from row ${d.fromRow}. Row${d.rows.length === 1 ? "" : "s"}
        ${d.rows.join(", ")} say ${esc(d.alsoSeen.join(", "))}. Check with the client before importing —
        an account can only have one ${what}.</p>`;
    }
    if (d.kind === "needs_review") {
      return `<p class="note error"><strong>Cancellation policy "${esc(d.value)}" is not one of the presets.</strong>
        It has been left exactly as written and needs setting by hand — it is never guessed.</p>`;
    }
    return `<p class="note error"><strong>${esc(d.column)} is missing from this workbook.</strong>
      It will have to be set on the account by hand.</p>`;
  }).join("");

  return settings + warnings;
}

function portfolioChecklistHtml() {
  const list = PORTFOLIO_META?.calendarChecklist || [];
  const ticked = new Set(PORTFOLIO_ROWS.filter((r) => r.include).map((r) => r.name));
  const shown = list.filter((c) => ticked.has(c.listing));
  if (!shown.length) return "";

  const items = shown.map((c) => {
    const detail = Object.entries(c.detail || {})
      .map(([k, v]) => `<div class="chk-line"><span class="muted">${esc(k)}</span> ${esc(v)}</div>`).join("");
    return `<div class="chk-item">
      <div class="chk-head">${esc(c.listing)} — ${esc(c.currency || "")} ${esc(c.basePrice ?? "")}</div>
      ${detail}
    </div>`;
  }).join("");

  return `
    <details id="portfolioChecklist" open>
      <summary>${shown.length} rental listing${shown.length === 1 ? "" : "s"} to create by hand</summary>
      <p class="note">GHL has no API for rental listings, so these are made in the Calendars screen.
        Every answer the client gave is below, so there is nothing to look up.</p>
      <div class="chk-list">${items}</div>
    </details>`;
}

function renderPortfolioPreview() {
  const host = $("#portfolioPreview");
  if (!host) return;
  if (!PORTFOLIO_ROWS.length) { host.innerHTML = ""; return; }

  const rows = PORTFOLIO_ROWS.map((r, i) => {
    const p = r.properties || {};
    const rate = p.base_nightly_rate?.value;
    const carried = Object.entries(r.carried || {})
      .map(([k, v]) => `<div class="muted">${esc(k)}: ${esc(v)}</div>`).join("");
    const issues = (r.issues || []).map((x) => `<span class="badge">${esc(portfolioIssue(x))}</span>`).join(" ");
    return `
      <tr class="${r.include ? "" : "row-muted"}">
        <td><input type="checkbox" data-portfolio="include" data-row="${i}"${r.include ? " checked" : ""}${r.blocked ? " disabled" : ""} /></td>
        <td>${r.rowNumber}</td>
        <td><input type="text" data-portfolio="property_name" data-row="${i}" value="${esc(p.property_name ?? "")}" /></td>
        <td>${esc(p.property_type ?? "—")}</td>
        <td>${esc(p.status ?? "—")}</td>
        <td><input type="number" step="0.01" min="0" data-portfolio="base_nightly_rate" data-row="${i}" value="${rate ?? ""}" /></td>
        <td>${issues}${carried}</td>
      </tr>`;
  }).join("");

  const ticked = PORTFOLIO_ROWS.filter((r) => r.include).length;
  host.innerHTML = portfolioSettingsHtml() + `
    <div class="toolbar">
      <div class="count">${ticked} of ${PORTFOLIO_ROWS.length} selected</div>
      <button id="portfolioConfirm"${ticked ? "" : " disabled"}>Import ${ticked} propert${ticked === 1 ? "y" : "ies"}</button>
      <button id="portfolioCancel" class="secondary">Cancel</button>
    </div>
    <table>
      <thead><tr><th></th><th>Row</th><th>Listing name</th><th>Type</th><th>Status</th><th>Nightly rate</th><th>Notes</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>` + portfolioChecklistHtml();

  $("#portfolioConfirm")?.addEventListener("click", runPortfolioImport);
  $("#portfolioCancel")?.addEventListener("click", () => {
    PORTFOLIO_ROWS = []; PORTFOLIO_META = null;
    const f = $("#portfolioFile"); if (f) f.value = "";
    $("#portfolioStatus").textContent = "";
    renderPortfolioPreview();
  });
}

function wirePortfolio() {
  const file = $("#portfolioFile");
  if (!file) return;

  file.addEventListener("change", async () => {
    const f = file.files?.[0];
    if (!f) return;
    const status = $("#portfolioStatus");
    status.textContent = `Reading ${f.name}…`;
    try {
      const res = await apiFetch("/api/portfolio/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locationId: getLocationId(), data: await base64Of(f) }),
      });
      const out = await res.json();
      if (!res.ok) {
        throw new Error(out.error === "no_properties_sheet"
          ? `No Properties sheet in that workbook (found: ${(out.sheets || []).join(", ")})`
          : out.error || "Could not read that workbook");
      }

      PORTFOLIO_ROWS = out.rows;
      PORTFOLIO_META = out;
      const s = out.summary;
      status.textContent = `${f.name}: ${s.total} propert${s.total === 1 ? "y" : "ies"}, ${s.ready} ready` +
        (s.needsReview ? `, ${s.needsReview} needing a look` : "") +
        (out.truncated ? " (only the first 500 rows were read)" : "") +
        (out.unrecognisedColumns?.length ? ` · unrecognised columns: ${out.unrecognisedColumns.join(", ")}` : "");
      renderPortfolioPreview();
    } catch (err) {
      status.textContent = err.message;
      PORTFOLIO_ROWS = []; PORTFOLIO_META = null;
      renderPortfolioPreview();
    }
    file.value = "";
  });

  $("#portfolioPreview").addEventListener("input", (e) => {
    const field = e.target.dataset?.portfolio;
    if (!field) return;
    const row = PORTFOLIO_ROWS[Number(e.target.dataset.row)];
    if (!row) return;
    if (field === "include") { row.include = e.target.checked; renderPortfolioPreview(); return; }
    row.properties = row.properties || {};
    if (field === "base_nightly_rate") {
      const n = e.target.value === "" ? null : Number(e.target.value);
      if (n === null) delete row.properties.base_nightly_rate;
      else row.properties.base_nightly_rate = { value: n, currency: "default" };
    } else if (e.target.value) {
      row.properties[field] = e.target.value;
      row.name = field === "property_name" ? e.target.value : row.name;
    }
  });
}

async function runPortfolioImport() {
  const rows = PORTFOLIO_ROWS.filter((r) => r.include);
  if (!rows.length) return;
  const btn = $("#portfolioConfirm");
  const status = $("#portfolioStatus");
  if (btn) { btn.disabled = true; btn.textContent = "Importing…"; }

  try {
    const res = await apiFetch("/api/portfolio/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locationId: getLocationId(), rows }),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || "Import failed");

    // The checklist is the next thing to act on, so it stays on screen. Rows
    // that failed stay too, with their reason; rows that went in are cleared.
    const failedRows = new Set(out.failed.map((f) => f.rowNumber));
    const keptChecklist = PORTFOLIO_META;
    PORTFOLIO_ROWS = PORTFOLIO_ROWS.filter((r) => failedRows.has(r.rowNumber) || !r.include);
    await loadData();
    PORTFOLIO_META = keptChecklist;
    $("#portfolioStatus").textContent = `Imported ${out.imported}.` +
      (out.failed.length ? ` ${out.failed.length} could not be saved: ${out.failed.map((f) => `row ${f.rowNumber} (${f.error})`).join("; ")}` : "") +
      ((keptChecklist?.calendarChecklist || []).length ? " The rental listings still need creating by hand — see the checklist." : "");
    renderPortfolioPreview();
  } catch (err) {
    status.textContent = err.message;
    if (btn) { btn.disabled = false; btn.textContent = "Import"; }
  }
}

// ---------- Overview ----------
function renderOverview() {
  const { properties, otaChannels, transactions, checklists, inventoryItems, contacts } = DATA;
  const flaggedTx = transactions.filter((t) => !t.propertyId || !t.otaChannelId || t.paymentStatus === "failed");
  const flaggedChecklists = checklists.filter((c) => c.overallStatus === "needs_followup" || c.overallStatus === "failed_inspection");
  const flaggedOta = otaChannels.filter((o) => o.syncStatus === "disconnected" || o.syncStatus === "error");
  const flaggedInventory = inventoryItems.filter((i) => i.conditionKey === "needs_replacement" || i.conditionKey === "missing");

  $("#panel-overview").innerHTML = `
    <div class="card-grid">
      <div class="stat-card"><div class="num">${properties.length}</div><div class="label">Properties</div></div>
      ${showOta() ? `<div class="stat-card"><div class="num">${otaChannels.length}</div><div class="label">OTA Channels</div></div>` : ""}
      <div class="stat-card"><div class="num">${transactions.length}</div><div class="label">Transactions</div></div>
      <div class="stat-card"><div class="num">${checklists.length}</div><div class="label">Cleaning Checklists</div></div>
      <div class="stat-card"><div class="num">${inventoryItems.length}</div><div class="label">Inventory Items</div></div>
      <div class="stat-card"><div class="num">${contacts.length}</div><div class="label">Contacts</div></div>
    </div>
    <div class="section-title">Needs attention</div>
    <div class="card-grid">
      <div class="stat-card"><div class="num">${flaggedTx.length}</div><div class="label">Transactions missing links / failed payment</div></div>
      <div class="stat-card"><div class="num">${flaggedChecklists.length}</div><div class="label">Checklists needing follow-up or failed</div></div>
      <div class="stat-card"><div class="num">${flaggedOta.length}</div><div class="label">OTA channels disconnected / erroring</div></div>
      <div class="stat-card"><div class="num">${flaggedInventory.length}</div><div class="label">Inventory needing replacement / missing</div></div>
    </div>
    ${DATA.transactions.length === 0 && DATA.properties.length <= 1 ? `
      <div class="section-title">Note</div>
      <p style="color:var(--muted); font-size:13px; max-width:640px;">
        This demo location currently has minimal seed data (schema and associations are wired and confirmed working —
        this dashboard reads them live). Add more Property / OTA Channel / Transaction / Cleaning Checklist records
        to see the full search, audit, and report views populated.
      </p>` : ""}
  `;
}

// ---------- Properties ----------
function renderProperties() {
  renderFilterableTab({
    tabKey: "properties", panelId: "#panel-properties", list: DATA.properties,
    filterDefs: [
      { key: "status", label: "Status", options: distinct(DATA.properties, "status") },
      { key: "propertyType", label: "Type", options: distinct(DATA.properties, "propertyType") },
      { key: "ownerContactName", label: "Owner", options: distinct(DATA.properties, "ownerContactName") },
    ],
    dateField: null,
    headers: ["Name", "Owner", "Status", "Type", "Address", "Bed/Bath", "Nightly Rate", "OTA Channels", "Bookings"],
    colspan: 9, emptyLabel: "properties",
    rowFn: (p) => `
    <tr data-kind="property" data-id="${p.id}">
      <td>${dash(p.name)}</td>
      <td>${dash(p.ownerContactName)}</td>
      <td>${badge(p.status, p.status === "active" ? "good" : p.status === "inactive" ? "bad" : "neutral")}</td>
      <td>${dash(p.propertyType)}</td>
      <td>${dash(p.address)}</td>
      <td>${p.bedrooms ?? "—"} / ${p.bathrooms ?? "—"}</td>
      <td>${money(p.baseNightlyRate)}</td>
      <td>${p.otaChannelNames.length ? esc(p.otaChannelNames.join(", ")) : "—"}</td>
      <td>${p.transactionCount}</td>
    </tr>`,
  });

  $("#panel-properties").insertAdjacentHTML("beforeend", portfolioSection());
  wirePortfolio();
  renderPortfolioPreview();
}

// ---------- OTA Channels ----------
function renderOta() {
  if (!showOta()) return;
  renderFilterableTab({
    tabKey: "ota", panelId: "#panel-ota", list: DATA.otaChannels,
    filterDefs: [
      { key: "propertyId", label: "Property", options: distinctPairs(DATA.otaChannels, "propertyId", "propertyName") },
      { key: "syncStatus", label: "Sync Status", options: distinct(DATA.otaChannels, "syncStatus") },
    ],
    dateField: "lastSynced",
    headers: ["Channel", "Property", "Listing ID", "Sync Status", "Commission", "Last Synced"],
    colspan: 6, emptyLabel: "OTA channels",
    rowFn: (o) => `
    <tr data-kind="ota_channel" data-id="${o.id}">
      <td>${dash(o.name)}</td>
      <td>${dash(o.propertyName)}</td>
      <td>${dash(o.externalListingId)}</td>
      <td>${syncBadge(o.syncStatus)}</td>
      <td>${o.commissionRate !== null ? o.commissionRate + "%" : "—"}</td>
      <td>${dateFmt(o.lastSynced)}</td>
    </tr>`,
  });
}

// ---------- Transactions ----------
function renderTransactions() {
  // Stamped onto the records because matchesFilters() and the filter bar both
  // read fields off the record, and because one `today` for the whole pass
  // keeps a render that straddles midnight internally consistent.
  const today = todayISO();
  DATA.transactions.forEach((t) => { t.stayStatus = stayStatus(t, today); });

  renderFilterableTab({
    tabKey: "transactions", panelId: "#panel-transactions", list: DATA.transactions,
    filterDefs: [
      { key: "propertyId", label: "Property", options: distinctPairs(DATA.transactions, "propertyId", "propertyName") },
      { key: "stayStatus", label: "Status", options: stayStatusOptions(DATA.transactions) },
      { key: "otaChannelId", label: "OTA Channel", options: distinctPairs(DATA.transactions, "otaChannelId", "otaChannelName") },
      { key: "paymentStatus", label: "Payment", options: distinct(DATA.transactions, "paymentStatus") },
    ],
    dateField: "checkinDate",
    // Guest, property, dates and status lead, in that order. The old first
    // column was transaction_name, which the Worker builds as
    // "<guest> — <check-in>" -- it repeated the next column and the one after
    // it, so the widest column on the row carried nothing of its own.
    headers: ["Guest", "Property", "Stay Dates", "Status", "Total", "Payment", "OTA Channel", "Booking Ref"],
    colspan: 8, emptyLabel: "transactions",
    rowFn: (t) => `
    <tr data-kind="transaction" data-id="${t.id}">
      <td>${dash(t.guestName)}</td>
      <td>${dash(t.propertyName)}</td>
      <td>${dateFmt(t.checkinDate)} → ${dateFmt(t.checkoutDate)}</td>
      <td>${stayBadge(t.stayStatus)}</td>
      <td>${money(t.bookingTotal)}</td>
      <td>${paymentBadge(t.paymentStatus)}</td>
      <td>${dash(t.otaChannelName)}</td>
      <td>${dash(t.bookingReference)}</td>
    </tr>`,
  });
}

// ---------- Checklists ----------
function renderChecklists() {
  renderFilterableTab({
    tabKey: "checklists", panelId: "#panel-checklists", list: DATA.checklists,
    filterDefs: [
      { key: "propertyId", label: "Property", options: distinctPairs(DATA.checklists, "propertyId", "propertyName") },
      { key: "turnoverType", label: "Turnover Type", options: distinct(DATA.checklists, "turnoverType") },
      { key: "overallStatus", label: "Status", options: distinct(DATA.checklists, "overallStatus") },
      { key: "cleanerContactId", label: "Cleaner", options: distinctPairs(DATA.checklists, "cleanerContactId", "cleanerContactName") },
    ],
    dateField: "completionDate",
    headers: ["Job", "Property", "Booking Ref", "Cleaner", "Turnover Type", "Date Cleaned", "Status"],
    colspan: 7, emptyLabel: "cleaning checklists",
    rowFn: (c) => `
    <tr data-kind="checklist" data-id="${c.id}">
      <td>${dash(c.name)}</td>
      <td>${dash(c.propertyName)}</td>
      <td>${dash(c.bookingReference)}</td>
      <td>${dash(c.cleanerContactName || c.cleanerNameService)}</td>
      <td>${dash(c.turnoverType)}</td>
      <td>${dateFmt(c.completionDate)}</td>
      <td>${checklistBadge(c.overallStatus)}</td>
    </tr>`,
  });
}

// ---------- Expenses ----------
function reviewBadge(status) {
  if (status === "Approved") return badge("Approved", "good");
  if (status === "Needs Review") return badge("Needs Review", "warn");
  return badge(status, "neutral");
}

// Mirrors src/normalize.js EXPENSE_CATEGORY_LABELS -- kept in sync manually,
// same duplication pattern as the Owner Statement's i18n category map.
const EXPENSE_CATEGORY_OPTIONS = [
  ["maintenance_repairs", "Maintenance & Repairs"],
  ["cleaning_supplies", "Cleaning Supplies"],
  ["utilities", "Utilities"],
  ["pest_control", "Pest Control"],
  ["landscaping", "Landscaping"],
  ["insurance", "Insurance"],
  ["property_tax", "Property Tax"],
  ["management_fee", "Management Fee"],
  ["miscellaneous", "Miscellaneous Expenses"],
  ["other", "Other"],
];

function openAddExpenseModal() {
  const propSelect = $("#aeProperty");
  propSelect.innerHTML =
    `<option value="">— None —</option>` +
    DATA.properties.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");

  const catSelect = $("#aeCategory");
  catSelect.innerHTML = EXPENSE_CATEGORY_OPTIONS.map(([key, label]) => `<option value="${key}">${esc(label)}</option>`).join("");

  $("#addExpenseForm").reset();
  $("#aePaidOn").value = new Date().toISOString().slice(0, 10);
  $("#aeError").hidden = true;
  $("#aeError").textContent = "";
  $("#aeSubmit").disabled = false;
  $("#aeSubmit").textContent = "Submit Expense";
  $("#addExpenseOverlay").hidden = false;
}

async function submitAddExpense(e) {
  e.preventDefault();
  const propertyId = $("#aeProperty").value || null;
  const property = propertyId ? DATA.properties.find((p) => p.id === propertyId) : null;

  const payload = {
    locationId: getLocationId(),
    propertyId,
    ownerContactId: property?.ownerContactId || null,
    name: EXPENSE_CATEGORY_OPTIONS.find(([key]) => key === $("#aeCategory").value)?.[1] || "Expense",
    paidOn: $("#aePaidOn").value || null,
    categoryKey: $("#aeCategory").value,
    paidBy: $("#aePaidBy").value,
    lineItemDescription: $("#aeDescription").value.trim(),
    amount: $("#aeAmount").value,
  };

  const errBox = $("#aeError");
  errBox.hidden = true;
  const submitBtn = $("#aeSubmit");
  submitBtn.disabled = true;
  submitBtn.textContent = "Submitting…";

  try {
    const res = await apiFetch("/api/expenses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Failed to create expense");

    $("#addExpenseOverlay").hidden = true;
    await loadData();
    showTab("expenses");
  } catch (err) {
    errBox.textContent = "Couldn't save expense: " + err.message;
    errBox.hidden = false;
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Submit Expense";
  }
}

function renderExpenses() {
  renderFilterableTab({
    tabKey: "expenses", panelId: "#panel-expenses", list: DATA.expenses,
    filterDefs: [
      { key: "propertyId", label: "Property", options: distinctPairs(DATA.expenses, "propertyId", "propertyName") },
      { key: "category", label: "Category", options: distinct(DATA.expenses, "category") },
      { key: "reviewStatus", label: "Review Status", options: distinct(DATA.expenses, "reviewStatus") },
      { key: "ownerContactId", label: "Owner", options: distinctPairs(DATA.expenses, "ownerContactId", "ownerContactName") },
    ],
    dateField: "paidOn",
    headers: ["Expense", "Paid On", "Category", "Property", "Owner", "Amount", "Converted", "Review Status"],
    colspan: 8, emptyLabel: "expenses",
    extraToolbarHtml: `<div class="toolbar" style="margin-bottom:12px"><button class="btn btn-primary" id="openAddExpense">+ Add Expense</button></div>`,
    rowFn: (e) => `
    <tr data-kind="expense" data-id="${e.id}">
      <td>${dash(e.name)}</td>
      <td>${dateFmt(e.paidOn)}</td>
      <td>${dash(e.category)}</td>
      <td>${dash(e.propertyName)}</td>
      <td>${dash(e.ownerContactName)}</td>
      <td>${moneyIn(e.amount, e.currency)}</td>
      <td${e.rateSource ? ` title="${esc(e.rateSource)}"` : ""}>${e.convertedAmount ? money(e.convertedAmount) : "—"}</td>
      <td>${reviewBadge(e.reviewStatus)}</td>
    </tr>`,
  });
}

// ---------- Property Inventory ----------
function conditionBadge(condition) {
  if (condition === "New" || condition === "Good") return badge(condition, "good");
  if (condition === "Fair") return badge(condition, "warn");
  if (condition === "Needs Replacement" || condition === "Missing") return badge(condition, "bad");
  return badge(condition, "neutral");
}

function renderInventory() {
  renderFilterableTab({
    tabKey: "inventory", panelId: "#panel-inventory", list: DATA.inventoryItems,
    filterDefs: [
      { key: "propertyId", label: "Property", options: distinctPairs(DATA.inventoryItems, "propertyId", "propertyName") },
      { key: "category", label: "Category", options: distinct(DATA.inventoryItems, "category") },
      { key: "condition", label: "Condition", options: distinct(DATA.inventoryItems, "condition") },
    ],
    dateField: "lastVerifiedDate",
    headers: ["Item", "Property", "Category", "Qty", "Condition", "Location", "Last Verified"],
    colspan: 7, emptyLabel: "inventory items",
    rowFn: (i) => `
    <tr data-kind="inventory_item" data-id="${i.id}">
      <td>${dash(i.name)}</td>
      <td>${dash(i.propertyName)}</td>
      <td>${dash(i.category)}</td>
      <td>${i.quantity ?? "—"}</td>
      <td>${conditionBadge(i.condition)}</td>
      <td>${dash(i.locationInProperty)}</td>
      <td>${dateFmt(i.lastVerifiedDate)}</td>
    </tr>`,
  });
}

// ---------- Reports ----------
function renderReports() {
  const { properties, otaChannels, transactions, checklists } = DATA;

  const revenueByProperty = properties.map((p) => {
    const txs = transactions.filter((t) => t.propertyId === p.id);
    const total = txs.reduce((sum, t) => sum + (Number(t.bookingTotal) || 0), 0);
    const payout = txs.reduce((sum, t) => sum + (Number(t.netPayout) || 0), 0);
    return { name: p.name, bookings: txs.length, total, payout };
  }).sort((a, b) => b.total - a.total);

  const byPaymentStatus = {};
  for (const t of transactions) {
    const k = t.paymentStatus || "unset";
    byPaymentStatus[k] = (byPaymentStatus[k] || 0) + 1;
  }

  const byOta = !showOta() ? [] : otaChannels.map((o) => {
    const txs = transactions.filter((t) => t.otaChannelId === o.id);
    const total = txs.reduce((sum, t) => sum + (Number(t.bookingTotal) || 0), 0);
    return { name: o.name, bookings: txs.length, total, commissionRate: o.commissionRate };
  }).sort((a, b) => b.bookings - a.bookings);

  const byChecklistStatus = {};
  for (const c of checklists) {
    const k = c.overallStatus || "unset";
    byChecklistStatus[k] = (byChecklistStatus[k] || 0) + 1;
  }

  $("#panel-reports").innerHTML = `
    <div class="toolbar"><div class="section-title" style="margin:0">Revenue by property</div>
      <button class="btn export-btn" data-export="revenue-by-property">Export CSV</button></div>
    ${table(["Property", "Bookings", "Booking Total", "Net Payout"],
      revenueByProperty.map((r) => `<tr><td>${dash(r.name)}</td><td>${r.bookings}</td><td>${money(r.total)}</td><td>${money(r.payout)}</td></tr>`).join("") || emptyRow(4, "No data"),
      null)}

    ${!showOta() ? "" : `
    <div class="toolbar"><div class="section-title" style="margin:0">Bookings by OTA channel</div>
      <button class="btn export-btn" data-export="bookings-by-ota">Export CSV</button></div>
    ${table(["Channel", "Bookings", "Booking Total", "Commission Rate"],
      byOta.map((r) => `<tr><td>${dash(r.name)}</td><td>${r.bookings}</td><td>${money(r.total)}</td><td>${r.commissionRate ?? "—"}${r.commissionRate !== null ? "%" : ""}</td></tr>`).join("") || emptyRow(4, "No data"),
      null)}`}

    <div class="section-title">Transactions by payment status</div>
    <div class="card-grid">
      ${Object.entries(byPaymentStatus).map(([k, v]) => `<div class="stat-card"><div class="num">${v}</div><div class="label">${esc(k)}</div></div>`).join("") || "<p style='color:var(--muted)'>No transactions yet</p>"}
    </div>

    <div class="section-title">Cleaning checklists by status</div>
    <div class="card-grid">
      ${Object.entries(byChecklistStatus).map(([k, v]) => `<div class="stat-card"><div class="num">${v}</div><div class="label">${esc(k)}</div></div>`).join("") || "<p style='color:var(--muted)'>No checklists yet</p>"}
    </div>
  `;

  $("#panel-reports").dataset.revenueByProperty = JSON.stringify(revenueByProperty);
  $("#panel-reports").dataset.bookingsByOta = JSON.stringify(byOta);
}

// ---------- Owner Statement ----------
const STATEMENT_I18N = {
  en: {
    selectProperty: "Select property", selectMonth: "Select month",
    statementFor: "Statement for", owner: "Owner", noOwnerOnFile: "(no owner on file)",
    grossIncome: "Gross Income", managementCommission: "Management Commission",
    otherExpenses: "Other Owner Expenses", netIncome: "Net Income",
    notNetted: "Paid in another currency, not included in the totals above",
    reservations: "Reservations", resName: "Reservation", guest: "Guest",
    checkIn: "Check-in", checkOut: "Check-out", nights: "Nights", grossRent: "Gross Rent",
    total: "Total", expensesTitle: "Owner Expenses", paidOn: "Paid On", category: "Category",
    description: "Description", amount: "Amount", noReservations: "No reservations in this period",
    noExpenses: "No expenses in this period", print: "Print / Save as PDF", exportCsv: "Export CSV",
    language: "Language", noData: "No properties yet — add one to generate a statement.",
  },
  es: {
    selectProperty: "Seleccionar propiedad", selectMonth: "Seleccionar mes",
    statementFor: "Estado de cuenta de", owner: "Propietario", noOwnerOnFile: "(sin propietario registrado)",
    grossIncome: "Ingreso Bruto", managementCommission: "Comisión de Administración",
    otherExpenses: "Otros Gastos del Propietario", netIncome: "Ingreso Neto",
    notNetted: "Pagado en otra moneda, no incluido en los totales anteriores",
    reservations: "Reservaciones", resName: "Reservación", guest: "Huésped",
    checkIn: "Entrada", checkOut: "Salida", nights: "Noches", grossRent: "Renta Bruta",
    total: "Total", expensesTitle: "Gastos del Propietario", paidOn: "Fecha de Pago", category: "Categoría",
    description: "Descripción", amount: "Monto", noReservations: "Sin reservaciones en este período",
    noExpenses: "Sin gastos en este período", print: "Imprimir / Guardar como PDF", exportCsv: "Exportar CSV",
    language: "Idioma", noData: "Aún no hay propiedades — agregue una para generar un estado de cuenta.",
  },
};

const EXPENSE_CATEGORY_ES = {
  maintenance_repairs: "Mantenimiento y Reparaciones",
  cleaning_supplies: "Insumos de Limpieza",
  utilities: "Servicios Públicos",
  pest_control: "Control de Plagas",
  landscaping: "Jardinería",
  insurance: "Seguro",
  property_tax: "Impuesto a la Propiedad",
  management_fee: "Comisión de Administración",
  miscellaneous: "Gastos Varios",
  other: "Otro",
};

let statementState = { propertyId: null, month: null, lang: "en" };

function t(key) {
  return STATEMENT_I18N[statementState.lang][key] || STATEMENT_I18N.en[key] || key;
}

function categoryLabel(categoryKey, fallbackLabel) {
  if (statementState.lang === "es" && categoryKey && EXPENSE_CATEGORY_ES[categoryKey]) {
    return EXPENSE_CATEGORY_ES[categoryKey];
  }
  return fallbackLabel;
}

function monthLabel(ym) {
  const [y, m] = ym.split("-");
  const d = new Date(Number(y), Number(m) - 1, 1);
  return d.toLocaleDateString(statementState.lang === "es" ? "es-ES" : "en-US", { month: "long", year: "numeric" });
}

function renderStatement() {
  const panel = $("#panel-statement");
  const { properties } = DATA;

  if (!properties.length) {
    panel.innerHTML = `<div class="state-msg">${t("noData")}</div>`;
    return;
  }

  if (!statementState.propertyId || !properties.some((p) => p.id === statementState.propertyId)) {
    statementState.propertyId = properties[0].id;
  }
  const property = properties.find((p) => p.id === statementState.propertyId);

  const propTx = DATA.transactions.filter((x) => x.propertyId === property.id);
  const propEx = DATA.expenses.filter((x) => x.propertyId === property.id);

  const months = new Set();
  propTx.forEach((x) => x.checkinDate && months.add(x.checkinDate.slice(0, 7)));
  propEx.forEach((x) => x.paidOn && months.add(x.paidOn.slice(0, 7)));
  const sortedMonths = [...months].sort().reverse();
  if (!statementState.month || !sortedMonths.includes(statementState.month)) {
    statementState.month = sortedMonths[0] || null;
  }

  const monthTx = statementState.month
    ? propTx.filter((x) => (x.checkinDate || "").slice(0, 7) === statementState.month)
    : [];
  const monthEx = statementState.month
    ? propEx.filter((x) => (x.paidOn || "").slice(0, 7) === statementState.month)
    : [];

  const grossIncome = monthTx.reduce((sum, x) => sum + (Number(x.bookingTotal) || 0), 0);
  const managementEx = monthEx.filter((x) => x.categoryKey === "management_fee");
  const otherEx = monthEx.filter((x) => x.categoryKey !== "management_fee");
  const managementCommission = managementEx.reduce((sum, x) => sum + (inAccountCurrency(x) || 0), 0);
  const otherExpensesTotal = otherEx.reduce((sum, x) => sum + (inAccountCurrency(x) || 0), 0);
  // Per-currency subtotals of what could not be netted (e.g. RD$ costs, no conversion).
  const notNetted = {};
  for (const x of monthEx) {
    if (inAccountCurrency(x) === null) notNetted[x.currency] = (notNetted[x.currency] || 0) + (Number(x.amount) || 0);
  }
  const netIncome = grossIncome - managementCommission - otherExpensesTotal;

  const nightsBetween = (a, b) => {
    if (!a || !b) return "—";
    const n = Math.round((new Date(b) - new Date(a)) / 86400000);
    return Number.isFinite(n) ? n : "—";
  };

  const ownerName = (() => {
    if (property.ownerContactName) return property.ownerContactName;
    const withOwner = monthEx.find((x) => x.ownerContactName) || propEx.find((x) => x.ownerContactName);
    return withOwner ? withOwner.ownerContactName : null;
  })();

  panel.innerHTML = `
    <div class="statement-controls">
      <select id="stmtProperty">
        ${properties.map((p) => `<option value="${p.id}" ${p.id === property.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}
      </select>
      <select id="stmtMonth" ${sortedMonths.length ? "" : "disabled"}>
        ${sortedMonths.length
          ? sortedMonths.map((m) => `<option value="${m}" ${m === statementState.month ? "selected" : ""}>${esc(monthLabel(m))}</option>`).join("")
          : `<option>${esc(t("selectMonth"))}</option>`}
      </select>
      <span class="lang-toggle">
        <button class="btn lang-btn ${statementState.lang === "en" ? "active" : ""}" data-lang="en">EN</button>
        <button class="btn lang-btn ${statementState.lang === "es" ? "active" : ""}" data-lang="es">ES</button>
      </span>
      <button class="btn" id="stmtPrint">${t("print")}</button>
      <button class="btn" id="stmtExport">${t("exportCsv")}</button>
    </div>

    <div class="statement-sheet" id="statementSheet">
      <h2>${esc(t("statementFor"))} ${esc(property.name)}</h2>
      <p class="statement-period">${statementState.month ? esc(monthLabel(statementState.month)) : "—"}</p>
      <p class="statement-owner">${esc(t("owner"))}: ${ownerName ? esc(ownerName) : t("noOwnerOnFile")}</p>

      <table class="statement-summary">
        <tbody>
          <tr><td>${esc(t("grossIncome"))}</td><td>${money(grossIncome)}</td></tr>
          <tr><td>${esc(t("managementCommission"))}</td><td>(${money(managementCommission)})</td></tr>
          <tr><td>${esc(t("otherExpenses"))}</td><td>(${money(otherExpensesTotal)})</td></tr>
          <tr class="statement-net"><td>${esc(t("netIncome"))}</td><td>${money(netIncome)}</td></tr>
        </tbody>
      </table>
      ${Object.keys(notNetted).length
        ? `<p class="note">${esc(t("notNetted"))}: ${Object.entries(notNetted).map(([c, v]) => esc(moneyIn(v, c))).join(" · ")}</p>`
        : ""}

      <h3>${esc(t("reservations"))}</h3>
      ${table(
        [t("resName"), t("guest"), t("checkIn"), t("checkOut"), t("nights"), t("grossRent")],
        monthTx.map((x) => `<tr><td>${dash(x.name)}</td><td>${dash(x.guestName)}</td><td>${dateFmt(x.checkinDate)}</td><td>${dateFmt(x.checkoutDate)}</td><td>${nightsBetween(x.checkinDate, x.checkoutDate)}</td><td>${money(x.bookingTotal)}</td></tr>`).join("")
          || emptyRow(6, t("noReservations")),
        null
      )}

      <h3>${esc(t("expensesTitle"))}</h3>
      ${table(
        [t("paidOn"), t("category"), t("description"), t("amount")],
        monthEx.map((x) => `<tr><td>${dateFmt(x.paidOn)}</td><td>${dash(categoryLabel(x.categoryKey, x.category))}</td><td>${dash(x.lineItemDescription)}</td><td>(${moneyIn(x.amount, x.currency)}${x.convertedAmount && x.currency !== DATA.accountCurrency ? ` = ${money(x.convertedAmount)}` : ""})</td></tr>`).join("")
          || emptyRow(4, t("noExpenses")),
        null
      )}
    </div>
  `;

  panel.dataset.exportRows = JSON.stringify(
    monthTx.map((x) => ({ type: "reservation", name: x.name, guest: x.guestName, checkIn: x.checkinDate, checkOut: x.checkoutDate, grossRent: x.bookingTotal }))
      .concat(monthEx.map((x) => ({ type: "expense", paidOn: x.paidOn, category: categoryLabel(x.categoryKey, x.category), description: x.lineItemDescription, amount: x.amount, currency: x.currency || DATA.accountCurrency || "", convertedAmount: x.convertedAmount ?? "", exchangeRate: x.exchangeRate ?? "", rateDate: x.rateDate ?? "" })))
  );
}

// On a phone the header row is off-screen, so each cell carries its own label
// and the stylesheet turns the row into a card. Measured at 375px before this:
// a Properties row showed 36% of itself and the rest was behind a sideways
// scroll nobody discovers.
//
// Done here rather than in the twelve row builders, which would have meant
// twelve chances to forget and a thirteenth the next time somebody adds a
// column. The labels come from the headers that are already passed in, so they
// cannot drift out of step with them either.
const labelCells = (rowsHtml, headers) =>
  String(rowsHtml).replace(/<tr\b[^>]*>[\s\S]*?<\/tr>/g, (row) => {
    // An empty-state row spans every column and has no column of its own.
    if (/colspan=/i.test(row)) return row;
    let i = 0;
    return row.replace(/<td\b/g, () => {
      const header = String(headers[i++] ?? "").replace(/<[^>]*>/g, "").trim();
      return header ? `<td data-label="${esc(header)}"` : "<td";
    });
  });

function table(headers, rowsHtml, count) {
  return `
    ${count !== null && count !== undefined ? `<div class="toolbar"><div class="count">${count} record${count === 1 ? "" : "s"}</div></div>` : ""}
    <table>
      <thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
      <tbody>${labelCells(rowsHtml, headers)}</tbody>
    </table>`;
}

function emptyRow(colspan, msg) {
  return `<tr class="empty-row"><td colspan="${colspan}">${esc(msg)}</td></tr>`;
}

// ---------- Universal search ----------
function searchableText(obj) {
  return Object.values(obj)
    .filter((v) => typeof v === "string" || typeof v === "number")
    .join(" ␟ ")
    .toLowerCase();
}

function runSearch(query) {
  const q = query.trim().toLowerCase();
  if (!q) {
    $("#searchResults").hidden = true;
    showTab(activeTab);
    return;
  }
  document.querySelectorAll(".panel").forEach((p) => (p.hidden = true));
  $("#searchResults").hidden = false;

  // A vendor tenant has none of the client collections below -- searching them
  // would throw on undefined. Search what it actually has.
  if (DATA.kind === "vendor") {
    const expHits = (DATA.expenses || []).filter((e) =>
      [e.name, e.vendor, e.category, e.notes].filter(Boolean).join(" ").toLowerCase().includes(q)
    );
    const revHits = (DATA.revenue || []).filter((r) =>
      [r.name, r.payer, r.source, r.period, r.notes].filter(Boolean).join(" ").toLowerCase().includes(q)
    );
    const revNet = revHits.reduce((s, r) => s + r.net, 0);
    const expTotal = expHits.reduce((s, e) => s + e.amount, 0);

    $("#searchResults").innerHTML =
      expHits.length || revHits.length
        ? (revHits.length
            ? `<h3>Revenue (${revHits.length}) — net ${usd(revNet)}</h3>` +
              table(
                ["Entry", "Payer", "Received", "Gross", "Net"],
                revHits
                  .map((r) => `<tr><td>${esc(r.name)}</td><td>${dash(r.payer)}</td><td>${dateFmt(r.receivedOn)}</td><td>${usd(r.gross)}</td><td>${usd(r.net)}</td></tr>`)
                  .join(""),
                revHits.length
              )
            : "") +
          (expHits.length
            ? `<h3>Expenses (${expHits.length}) — ${usd(expTotal)}</h3>` +
              table(
                ["Expense", "Vendor", "Category", "Paid on", "Amount"],
                expHits
                  .map((e) => `<tr><td>${esc(e.name)}</td><td>${dash(e.vendor)}</td><td>${esc(CATEGORY_LABELS[e.category] || e.category)}</td><td>${dateFmt(e.paidOn)}</td><td>${usd(e.amount)}</td></tr>`)
                  .join(""),
                expHits.length
              )
            : "")
        : `<p class="note">Nothing matches "${esc(query)}".</p>`;
    return;
  }

  const groups = [
    ["Properties", DATA.properties, (p) => `${dash(p.name)} — ${dash(p.address)}`],
    ...(showOta() ? [["OTA Channels", DATA.otaChannels, (o) => `${dash(o.name)} — ${dash(o.propertyName)}`]] : []),
    ["Transactions", DATA.transactions, (t) => `${dash(t.name)} — ${dash(t.guestName)} — ${dash(t.bookingReference)}`],
    ["Cleaning Checklists", DATA.checklists, (c) => `${dash(c.name)} — ${dash(c.propertyName)} — cleaner ${dash(c.cleanerContactName || c.cleanerNameService)}`],
    ["Expenses", DATA.expenses, (e) => `${dash(e.name)} — ${dash(e.propertyName)} — ${dash(e.category)}`],
    ["Property Inventory", DATA.inventoryItems, (i) => `${dash(i.name)} — ${dash(i.propertyName)} — ${dash(i.category)}`],
    ["Contacts", DATA.contacts, (c) => `${dash(c.name)} — ${dash(c.email)}`],
  ];

  let totalMatches = 0;
  let html = "";
  for (const [label, list, render] of groups) {
    const matches = list.filter((item) => searchableText(item).includes(q));
    if (!matches.length) continue;
    totalMatches += matches.length;
    html += `<div class="result-group"><h3>${label} (${matches.length})</h3>
      <table><tbody>
        ${matches.map((m) => `<tr data-kind="${m.kind}" data-id="${m.id}"><td>${render(m)}</td></tr>`).join("")}
      </tbody></table>
    </div>`;
  }
  $("#searchResults").innerHTML = totalMatches
    ? html
    : `<div class="state-msg">No matches for "${esc(query)}"</div>`;
}

// ---------- Detail overlay ----------
function findRecord(kind, id) {
  const map = {
    property: DATA.properties, ota_channel: DATA.otaChannels, transaction: DATA.transactions,
    checklist: DATA.checklists, expense: DATA.expenses, inventory_item: DATA.inventoryItems, contact: DATA.contacts,
  };
  return (map[kind] || []).find((r) => r.id === id);
}

function openDetail(kind, id) {
  const record = findRecord(kind, id);
  if (!record) return;
  let title = record.name;
  let rows = [];

  if (kind === "property") {
    rows = [
      ["Owner", record.ownerContactName], ["Status", record.status], ["Type", record.propertyType], ["Address", record.address],
      ["Bedrooms", record.bedrooms], ["Bathrooms", record.bathrooms], ["Max Occupancy", record.maxOccupancy],
      ["Nightly Rate", money(record.baseNightlyRate)], ["Cleaning Fee", money(record.cleaningFee)],
      ["Pet Fee", money(record.petFee)], ["OTA Channels", record.otaChannelNames.join(", ") || "—"],
      ["Bookings", record.transactionCount],
    ];
  } else if (kind === "ota_channel") {
    rows = [
      ["Property", record.propertyName], ["External Listing ID", record.externalListingId],
      ["Listing URL", record.listingUrl], ["iCal Link", record.icalLink],
      ["Sync Status", record.syncStatus], ["Commission Rate", record.commissionRate],
      ["Last Synced", dateFmt(record.lastSynced)],
    ];
  } else if (kind === "transaction") {
    title = record.name;
    rows = [
      ["Guest", record.guestName], ["Property", record.propertyName],
      ["Status", STAY_LABELS[stayStatus(record)] || ""], ["OTA Channel", record.otaChannelName],
      ["Booking Reference", record.bookingReference], ["Check-in", dateFmt(record.checkinDate)],
      ["Check-out", dateFmt(record.checkoutDate)], ["Booking Total", money(record.bookingTotal)],
      ["Platform Fee", money(record.platformFee)], ["Net Payout", money(record.netPayout)],
      ["Payment Status", record.paymentStatus],
    ];
  } else if (kind === "checklist") {
    rows = [
      ["Property", record.propertyName], ["Booking Reference", record.bookingReference],
      ["Cleaner", record.cleanerContactName || record.cleanerNameService],
      ["Turnover Type", record.turnoverType], ["Date Cleaned", dateFmt(record.completionDate)],
      ["Overall Status", record.overallStatus], ["Damage / Issues", record.damageNotes],
      ["Missing Supplies", record.missingSupplies], ["Guest Items Found", record.guestItemsFound],
    ];
  } else if (kind === "expense") {
    rows = [
      ["Property", record.propertyName], ["Owner", record.ownerContactName],
      ["Paid On", dateFmt(record.paidOn)], ["Category", record.category],
      ["Description", record.lineItemDescription], ["Amount", moneyIn(record.amount, record.currency)],
      ["Converted", record.convertedAmount ? money(record.convertedAmount) : null], ["Exchange Rate", record.rateSource],
      ["Can Reimburse", money(record.canReimburse)], ["Already Reimbursed", money(record.alreadyReimbursed)],
      ["Reimbursing Now", money(record.reimbursingNow)], ["Review Status", record.reviewStatus],
    ];
  } else if (kind === "inventory_item") {
    rows = [
      ["Property", record.propertyName], ["Category", record.category], ["Quantity", record.quantity],
      ["Condition", record.condition], ["Location in Property", record.locationInProperty],
      ["Purchase Date", dateFmt(record.purchaseDate)], ["Purchase Cost", money(record.purchaseCost)],
      ["Last Verified", dateFmt(record.lastVerifiedDate)], ["Notes", record.notes],
    ];
  } else if (kind === "contact") {
    rows = [
      ["Email", record.email], ["Phone", record.phone], ["Tags", record.tags.join(", ") || "—"],
    ];
  }

  $("#detailBody").innerHTML = `
    <h2>${esc(title)}</h2>
    <dl class="detail-grid">
      ${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${dash(v)}</dd>`).join("")}
    </dl>`;
  $("#detailOverlay").hidden = false;
}

// ---------- CSV export ----------
function toCsv(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const escCsv = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [headers.join(","), ...rows.map((r) => headers.map((h) => escCsv(r[h])).join(","))].join("\n");
}

function downloadCsv(filename, rows) {
  const csv = toCsv(rows);
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------- Tabs ----------
function showTab(tab) {
  // A vendor tenant has no client panels. Without this guard, any tab click or a
  // cleared search box re-shows Properties/OTA/Checklists/Inventory on an account
  // that has none of those things.
  if (DATA && DATA.kind === "vendor") return renderVendor();
  activeTab = tab;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));

  // Ten tabs are 1206px wide and a phone shows 375 of them, so the strip
  // scrolls -- which is no use if the tab you just picked is the one off-screen.
  //
  // Arithmetic on the strip rather than scrollIntoView. scrollIntoView also
  // scrolls ANCESTORS, so it can move the page under the reader to satisfy a
  // request about a row of tabs; and measured here, its smooth behaviour had
  // not settled 400ms later while a direct scroll landed immediately. This
  // moves one element, by a known amount, or does nothing.
  const strip = document.querySelector(".tabs");
  const active = strip?.querySelector(".tab.active");
  if (strip && active && strip.scrollWidth > strip.clientWidth) {
    // Instant, not smooth. Measured on a 375px viewport: a smooth scroll on this
    // strip is cancelled outright by its own scroll-snapping and settles back at
    // 0, while the same call with behavior "auto" lands exactly on target. An
    // animation that sometimes does nothing is worse than no animation.
    const centred = active.offsetLeft - (strip.clientWidth - active.offsetWidth) / 2;
    strip.scrollTo({ left: Math.max(0, centred), behavior: "auto" });
  }
  document.querySelectorAll(".panel").forEach((p) => (p.hidden = true));
  $("#searchResults").hidden = true;
  const target = $("#panel-" + tab);
  if (target) target.hidden = false;
}

// ---------- Wiring ----------
document.addEventListener("DOMContentLoaded", () => {
  loadData();

  $("#refresh").addEventListener("click", loadData);

  $("#tabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".tab");
    if (!btn) return;
    $("#search").value = "";
    showTab(btn.dataset.tab);
  });

  let debounce;
  $("#search").addEventListener("input", (e) => {
    clearTimeout(debounce);
    const value = e.target.value;
    debounce = setTimeout(() => runSearch(value), 120);
  });

  document.addEventListener("click", (e) => {
    const row = e.target.closest("tr[data-kind]");
    if (row) openDetail(row.dataset.kind, row.dataset.id);

    const exportBtn = e.target.closest("[data-export]");
    if (exportBtn) {
      const which = exportBtn.dataset.export;
      const panel = $("#panel-reports");
      if (which === "revenue-by-property") downloadCsv("revenue-by-property.csv", JSON.parse(panel.dataset.revenueByProperty));
      if (which === "bookings-by-ota") downloadCsv("bookings-by-ota.csv", JSON.parse(panel.dataset.bookingsByOta));
    }

    const uiLangBtn = e.target.closest(".ui-lang-btn");
    if (uiLangBtn) setLocale(uiLangBtn.dataset.lang);

    const langBtn = e.target.closest(".lang-btn");
    if (langBtn) {
      statementState.lang = langBtn.dataset.lang;
      renderStatement();
    }

    if (e.target.id === "openAddExpense") openAddExpenseModal();

    if (e.target.id === "stmtPrint") window.print();
    if (e.target.id === "stmtExport") {
      const panel = $("#panel-statement");
      downloadCsv("owner-statement.csv", JSON.parse(panel.dataset.exportRows || "[]"));
    }

    const clearBtn = e.target.closest(".filter-clear");
    if (clearBtn) {
      filterState[clearBtn.dataset.tab] = {};
      renderTab(clearBtn.dataset.tab);
    }
  });

  document.addEventListener("change", (e) => {
    if (e.target.id === "stmtProperty") {
      statementState.propertyId = e.target.value;
      statementState.month = null;
      renderStatement();
    }
    if (e.target.id === "mgrMonth") {
      managerPl.month = e.target.value || null;
      loadManagerPl();
      return;
    }
    if (e.target.id === "stmtMonth") {
      statementState.month = e.target.value;
      renderStatement();
    }

    const filterSelect = e.target.closest(".filter-select");
    if (filterSelect) {
      const { tab, field } = filterSelect.dataset;
      if (filterSelect.value) filterState[tab][field] = filterSelect.value;
      else delete filterState[tab][field];
      renderTab(tab);
    }
  });

  document.addEventListener("click", (e) => {
    if (e.target.id === "mgrPrint") window.print();
  });

  $("#detailClose").addEventListener("click", () => ($("#detailOverlay").hidden = true));
  $("#detailOverlay").addEventListener("click", (e) => {
    if (e.target.id === "detailOverlay") $("#detailOverlay").hidden = true;
  });

  $("#addExpenseClose").addEventListener("click", () => ($("#addExpenseOverlay").hidden = true));
  $("#addExpenseOverlay").addEventListener("click", (e) => {
    if (e.target.id === "addExpenseOverlay") $("#addExpenseOverlay").hidden = true;
  });
  $("#addExpenseForm").addEventListener("submit", submitAddExpense);
});
