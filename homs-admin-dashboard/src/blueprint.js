// The canonical HOMS client-account configuration surface.
//
// Verified 2026-09-10 against DEMO-HOMS (ZghxU8I60bEm39JUbtCm) and Luminara
// (wLGDbGcQ4QSG3nlT3Sis), which both carried the same 19 keys.
// See homs-client-config-blueprint.md.
//
// Re-checked 2026-09-25: DEMO-HOMS now carries four more (Group E below), added
// since. Luminara still has only the original 19, which is correct -- it is the
// legacy tenant whose cancellation policy lives in KV, not in a custom value.
// The gap mattered: without wcancellation_policy here, the reconciler had
// nowhere to put the policy the client picks in the intake workbook, so the
// answer would have been collected and then quietly dropped.
//
// `policy` decides what the reconciler is allowed to do with each key:
//
//   input     - value comes from the caller (onboarding quiz / integration call).
//               Absent from the payload means "leave alone", never "blank it".
//   derived   - computed from the account itself. No input accepted.
//   generated - a secret. Minted with real entropy ONLY when currently blank.
//               Never regenerated over an existing value.
//   manual    - the reconciler MUST NOT write this. These hold live GHL Inbound
//               Webhook trigger URLs whose UUIDs are minted per-account when a
//               snapshot loads, are unreadable through any API (verified: the
//               workflows endpoint returns no trigger data), and severing them
//               silently breaks payments in a live account.

export const BLUEPRINT = [
  // --- Group A: client identity, from the onboarding quiz ---
  { slug: "wbrand_name", name: "WBrand Name", policy: "input", label: "Brand name" },
  { slug: "wproperty_owner", name: "WProperty Owner", policy: "input", label: "Property owner" },
  { slug: "wmanager", name: "WManager", policy: "input", label: "Manager" },
  { slug: "wlocale", name: "WLocale", policy: "input", label: "Locale (es-ES / en-US)" },
  { slug: "wcurrency", name: "WCurrency", policy: "input", label: "Currency" },
  { slug: "wcleaning_fee", name: "WCleaning Fee", policy: "input", label: "Cleaning fee" },
  { slug: "wowner_revenue_split", name: "WOwner Revenue Split", policy: "input", label: "Owner revenue split" },

  // --- Group B: payment configuration, from the integration call ---
  { slug: "wowner_paypal_email", name: "WOwner PayPal Email", policy: "input", label: "Owner PayPal email" },
  { slug: "wmgr_paypal_email", name: "WMgr PayPal Email", policy: "input", label: "Manager PayPal email" },
  // Client ID is not a secret (PayPal exposes it publicly in the OAuth flow), so
  // provisioning may fill it. The other two are secrets and the reconciler must
  // never write them: homs-invoicing-worker resolves PayPal credentials from
  // tenant.paypalSecretName -> Worker secret (src/paypal.js), NOT from these
  // custom values. Writing them here would push a plaintext copy into a CRM that
  // any sub-account user, and any integration with customValues read scope, can
  // read - for no functional benefit.
  { slug: "wpaypal_client_id", name: "WPayPal Client ID", policy: "input", label: "PayPal client ID" },
  { slug: "wpaypal_webhook", name: "WPaypal Webhook ID", policy: "input", label: "PayPal webhook ID" },
  // The one credential GHL never transmits. Decided 2026-09-11: a secret GHL has
  // to send belongs in custom values (wwebhook_secret, wadmin_secret both ride in
  // webhook payloads and stay); a secret only the Worker uses does not. The Worker
  // mints its PayPal token server-side, so this sits in the CRM readable by any
  // sub-account user and any read-scoped token for no functional reason.
  // It is handed to the invoicing worker's /admin/provision-tenant as a parameter
  // instead, the same way ghlPit already is and for the same stated reason.
  { slug: "wpaypal_secret_key", name: "WPayPal Secret Key", policy: "manual", label: "PayPal secret key", sensitive: true },

  // --- Group C: system wiring ---
  { slug: "wlocation_id", name: "WLocation ID", policy: "derived", label: "Location ID" },
  { slug: "wadmin_secret", name: "WAdmin Secret", policy: "generated", label: "Admin secret", sensitive: true },
  { slug: "wwebhook_secret", name: "WWebhook Secret", policy: "generated", label: "Webhook secret", sensitive: true },
  // Per-recipient tokens for the owner and manager statements. They belong in
  // custom values for the same reason wadmin_secret does: the statement is
  // opened from a GHL custom menu link, and that link has to carry the token.
  //
  // Deliberately NOT adminSecret, which also gates /cancel and /reschedule. A
  // statement URL sits in an iframe src, browser history and possibly a
  // referrer header -- leaking a report token exposes one recipient view;
  // leaking adminSecret would let anyone cancel a booking.
  //
  // Separate per recipient so an owner link cannot be used to read the
  // manager numbers, or the reverse. Without these, a client cannot open their
  // own statement at all -- DEMO-HOMS had neither, found 2026-09-26.
  { slug: "wowner_report_token", name: "WOwner Report Token", policy: "generated", label: "Owner statement token", sensitive: true },
  { slug: "wmanager_report_token", name: "WManager Report Token", policy: "generated", label: "Manager statement token", sensitive: true },

  // Gates the manager executing a cancellation or reschedule from the guest
  // request form. Until now it was the literal "12345", compared inside a
  // workflow If/Else -- the same five digits on every account, written down in
  // a test note. Minted per account here so the workflow can compare against
  // {{ custom_values.wauthorization_pin }} instead of a number in its own
  // config, which also means rotating it is editing one field rather than
  // hunting through workflow steps.
  //
  // format "pin" because a person types this one. See generatePin.
  { slug: "wauthorization_pin", name: "WAuthorization PIN", policy: "generated", format: "pin", label: "Manager authorization PIN", sensitive: true },

  // --- Group D: NEVER WRITTEN. See policy note above. ---
  { slug: "wghl_payment_confirmation_url", name: "WGHL Payment Confirmation URL", policy: "manual", label: "Payment confirmation webhook" },
  { slug: "wghl_deposit_url", name: "WGHL Deposit URL", policy: "manual", label: "Deposit webhook" },
  { slug: "wghl_cancelation_url", name: "WGHL Cancelation URL", policy: "manual", label: "Cancellation webhook" },
  { slug: "wghl_reschedule_url", name: "WGHL Reschedule URL", policy: "manual", label: "Reschedule webhook" },

  // --- Group E: added after the original survey, confirmed on DEMO-HOMS 2026-09-25 ---
  // The client's choice from the intake workbook, stored as the sentence
  // parseCancellationPolicy reads. This decides real refunds, so it is written
  // only from a reviewed answer and never guessed.
  { slug: "wcancellation_policy", name: "WCancellation Policy", policy: "input", label: "Cancellation policy" },
  { slug: "wservice_cost_currency", name: "WService Cost Currency", policy: "input", label: "Service cost currency" },
  // Who operational notifications go to -- cleaning submissions, guest
  // requests. Decided 2026-09-26: the account holder, or whoever the account
  // holder names, settled per account during configuration.
  //
  // It has to live here rather than in the workflow. The address was written
  // straight into a workflow email action, where no API can read it, so a
  // cloned account kept the template address in silence and the real manager
  // never heard about a cleaning submission. An email that does not arrive
  // raises nothing. The workflow action points at this merge tag instead.
  { slug: "wmanager_notification_email", name: "WManager Notification Email", policy: "input", label: "Manager notification email" },
  // Per-account GHL form URLs, minted when the snapshot loads. Same reasoning as
  // Group D: not readable or mintable through any API, and severing one breaks a
  // live flow silently.
  { slug: "wghl_solicitud_del_huesped_url", name: "WGHL Solicitud del Huesped URL", policy: "manual", label: "Guest request form" },
  { slug: "wghl_inspeccion_url", name: "WGHL Inspeccion URL", policy: "manual", label: "Inspection form" },
];

// GHL returns fieldKey as "{{ custom_values.wbrand_name }}". Match on the slug
// rather than the display name, which a client can rename in the UI.
export function slugFromFieldKey(fieldKey) {
  if (!fieldKey) return null;
  const m = String(fieldKey).match(/custom_values\.([a-z0-9_]+)/i);
  return m ? m[1].toLowerCase() : null;
}

// 32 bytes, base64url. Replaces the human-patterned secrets found in the wild
// (Luminara's was shaped W{Brand}@{Year}#{n}, i.e. derivable from the brand name).
export function generateSecret() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// A secret a person types, so it cannot be the 43-character base64 above.
//
// Eight characters rather than the four or six a "PIN" suggests: the form that
// asks for it is publicly reachable, so this is not a phone keypad protected by
// three attempts and a lockout. Four digits is ten thousand guesses. Eight of
// this alphabet is about three trillion, and is still one short line to type.
//
// I, l, 1, O and 0 are excluded -- a manager reading this off a screen and
// typing it into a form should not have to guess which character it is.
const PIN_ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generatePin(length = 8) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  // Modulo bias is negligible at this alphabet size and irrelevant at this
  // threat model; uniformity here is not what this is defending.
  return Array.from(bytes, (b) => PIN_ALPHABET[b % PIN_ALPHABET.length]).join("");
}

export function derivedValue(slug, { locationId }) {
  if (slug === "wlocation_id") return locationId;
  return null;
}
