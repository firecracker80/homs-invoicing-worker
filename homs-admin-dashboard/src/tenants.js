// Multi-tenant lookup, mirroring homs-invoicing-worker's TENANTS KV convention
// (keyed by GHL locationId), but in a separate DASHBOARD_TENANTS namespace so
// this Worker never reads or writes the production invoicing worker's KV.
//
// DASHBOARD_TENANTS entry shape (per locationId key):
//   { "label": "DEMO-HOMS", "ghlPitSecretName": "GHL_PIT_DEMO_HOMS" }
//
// The PIT itself is never stored in KV -- only the name of the Worker secret
// that holds it, resolved dynamically via env[tenant.ghlPitSecretName].

export async function getTenant(env, locationId) {
  if (!locationId) return null;
  return env.DASHBOARD_TENANTS.get(locationId, { type: "json" });
}

export function resolvePit(env, tenant) {
  if (!tenant?.ghlPitSecretName) return null;
  return env[tenant.ghlPitSecretName] || null;
}
