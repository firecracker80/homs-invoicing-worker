// The canonical HOMS client-account configuration surface.
//
// Verified 2026-09-10 against DEMO-HOMS (ZghxU8I60bEm39JUbtCm, all empty) and
// Luminara (wLGDbGcQ4QSG3nlT3Sis, fully populated). Both carry this exact
// 19-key set with identical names and fieldKeys. See homs-client-config-blueprint.md.
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

  // --- Group D: NEVER WRITTEN. See policy note above. ---
  { slug: "wghl_payment_confirmation_url", name: "WGHL Payment Confirmation URL", policy: "manual", label: "Payment confirmation webhook" },
  { slug: "wghl_deposit_url", name: "WGHL Deposit URL", policy: "manual", label: "Deposit webhook" },
  { slug: "wghl_cancelation_url", name: "WGHL Cancelation URL", policy: "manual", label: "Cancellation webhook" },
  { slug: "wghl_reschedule_url", name: "WGHL Reschedule URL", policy: "manual", label: "Reschedule webhook" },
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

export function derivedValue(slug, { locationId }) {
  if (slug === "wlocation_id") return locationId;
  return null;
}
