/**
 * src/ghl-calendar.js
 *
 * Pushes new dates onto a GHL rental booking. Called from handleReschedule()
 * in index.js, which already has the snapshot, tenant, and new dates.
 *
 * GHL has no public API for rental bookings. These are the undocumented
 * endpoints its own UI uses:
 *   GET /calendars/bookings/details/{id}   — read the booking
 *   PUT /calendars/bookings/manage/{id}    — full replacement, dates included
 *
 * A Private Integration token works here (server-side). The same token is
 * rejected from a browser, where only a session JWT is accepted.
 *
 * SETUP: add "ghlPit": "pit-…" to the tenant record in the TENANTS KV
 *        (key = locationId), or set a global GHL_PIT secret.
 */

const GHL_API = "https://backend.leadconnectorhq.com";
const GHL_VERSION = "2021-04-15";

/**
 * The PUT accepts only these keys inside selectedSlotInfo.services[].
 * The GET also returns serviceId, staffId, resourceId, availableProviders,
 * availableResources, startTime, endTime — echo any back and it 422s with
 * "property X should not exist". Whitelisting keeps future GHL fields safe.
 */
const SERVICE_FIELDS = [
  "id", "position", "skipSchedulingNotice", "startDate", "endDate",
  "quantity", "overrideAvailability", "skipLookBusy", "securityDeposit",
  "securityDepositRefundable", "status", "price", "unitPrice",
  "masterListingId", "name", "variantName", "bookingPeriodType",
  "productId", "isVariantsEnabled", "deleted",
];

/** "2026-08-29" | "08/29/2026" | ISO → "2026-08-29" */
function toISODate(input) {
  if (!input) return null;
  const s = String(input).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** → "2026-08-29T15:00:00-04:00" */
function stamp(dateStr, hour, tzOffsetHours) {
  const sign = tzOffsetHours <= 0 ? "-" : "+";
  const abs = Math.abs(tzOffsetHours);
  const hh = String(Math.floor(abs)).padStart(2, "0");
  const mm = String(Math.round((abs % 1) * 60)).padStart(2, "0");
  return `${dateStr}T${String(hour).padStart(2, "0")}:00:00${sign}${hh}:${mm}`;
}

/**
 * Never throws. A failed calendar write must not roll back a completed
 * reschedule — the caller reports the reason instead.
 *
 * @returns {Promise<{ok: boolean, [key: string]: any}>}
 */
export async function updateGhlBookingDates(env, tenant, snapshot, newCheckIn, newCheckOut) {
  const bookingId = snapshot.ghlBookingId || snapshot.bookingId;
  const locationId = snapshot.locationId;

  const pit = tenant.ghlPit || env.GHL_PIT;
  if (!pit) return { ok: false, reason: "no_token", detail: "Set tenant.ghlPit or GHL_PIT" };
  if (!bookingId) return { ok: false, reason: "no_booking_id" };

  const checkIn = toISODate(newCheckIn);
  const checkOut = toISODate(newCheckOut);
  if (!checkIn || !checkOut) {
    return { ok: false, reason: "bad_dates", received: { newCheckIn, newCheckOut } };
  }

  const headers = {
    Authorization: `Bearer ${pit}`,
    Version: GHL_VERSION,
    "Content-Type": "application/json",
  };

  try {
    // 1. read the live booking — yields a self-consistent
    //    id / masterListingId / productId / name set for any listing
    const getRes = await fetch(`${GHL_API}/calendars/bookings/details/${bookingId}`, { headers });
    const getText = await getRes.text();
    if (!getRes.ok) {
      console.error("GHL details failed", getRes.status, getText.slice(0, 300));
      return { ok: false, reason: "fetch_failed", status: getRes.status, detail: getText.slice(0, 300) };
    }

    const sb = JSON.parse(getText)?.serviceBooking;
    if (!sb?.services?.length) return { ok: false, reason: "no_listings" };
    if (sb.deleted) return { ok: false, reason: "booking_deleted" };

    // 2. rebuild the services array with the new dates
    const checkInHour = tenant.checkInHour ?? 15;
    const checkOutHour = tenant.checkOutHour ?? 11;
    const tz = tenant.tzOffsetHours ?? -4;
    const startDate = stamp(checkIn, checkInHour, tz);
    const endDate = stamp(checkOut, checkOutHour, tz);

    const services = sb.services.map((svc, i) => {
      const out = {};
      for (const k of SERVICE_FIELDS) if (svc[k] !== undefined) out[k] = svc[k];
      out.position = svc.position ?? i;
      out.startDate = startDate;
      out.endDate = endDate;
      out.overrideAvailability = true; // admin move: bypass buffer/notice rules
      return out;
    });

    // 3. write it back
    const putBody = {
      locationId,
      contactId: sb.contactId,
      source: "calendar_page",
      selectedSlotInfo: { services },
      slotIntervalMinutes: 15,
      appointmentTitle: sb.appointmentTitle,
      industryType: "rental",
    };

    const putRes = await fetch(`${GHL_API}/calendars/bookings/manage/${bookingId}`, {
      method: "PUT",
      headers,
      body: JSON.stringify(putBody),
    });
    const putText = await putRes.text();

    if (!putRes.ok) {
      console.error("GHL manage failed", putRes.status, putText.slice(0, 300), JSON.stringify(putBody));
      return { ok: false, reason: "update_rejected", status: putRes.status, detail: putText.slice(0, 300) };
    }

    return {
      ok: true,
      bookingId,
      listings: services.map((s) => s.name),
      newDates: { start: startDate, end: endDate },
    };
  } catch (err) {
    console.error("GHL calendar update threw:", err.message);
    return { ok: false, reason: "exception", detail: err.message };
  }
}
