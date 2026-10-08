// Capture one account's object layer, or compare two captures.
//
//   node tools-schema.mjs capture <locationId> [out.json]     # needs a PIT
//   node tools-schema.mjs fetch <locationId> [out.json]       # via the Worker
//   node tools-schema.mjs diff   <expected.json> <actual.json>
//   node tools-schema.mjs repair <locationId> [--apply]       # via the Worker
//
// `repair` is the whole loop in one command: fetch the account, diff it against
// the committed contract, show what would change, optionally write it, then
// re-fetch and re-diff so the result is proved rather than assumed. Without
// --apply it writes nothing.
//
// `fetch` is the one to use for a client account: the Worker already holds that
// tenant's PIT as a secret, so nothing has to be exported to run the check.
// `capture` remains for an account whose PIT you legitimately hold, DEMO-HOMS
// being the one that matters -- it is how the committed contract is made.
//
// The PIT comes from GHL_PIT, or from --pit-file <tenant.json> (the ghlPit field
// of a tenant record). Never passed on the command line, where it would land in
// shell history.
//
// Capture and diff are separate because a PIT is scoped to ONE location: the
// account being checked and the account being compared against generally cannot
// be read with the same token. Capturing to a file also makes the expected
// schema a versioned artifact -- schema/demo-homs.schema.json is the contract a
// newly provisioned account is held to.
import fs from "node:fs/promises";
import { fingerprint, diffSchemas, formatDiff, repairsFor } from "./src/schema-fingerprint.js";

const BASE = "https://services.leadconnectorhq.com";
const [, , cmd, ...rest] = process.argv;

const args = rest.filter((a) => !a.startsWith("--"));
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? null : rest[i + 1];
};

async function resolvePit() {
  if (process.env.GHL_PIT) return process.env.GHL_PIT;
  const file = flag("pit-file");
  if (file) {
    const t = JSON.parse(await fs.readFile(file, "utf8"));
    if (t.ghlPit) return t.ghlPit;
    throw new Error(`${file} has no ghlPit`);
  }
  throw new Error("no PIT: set GHL_PIT or pass --pit-file <tenant.json>");
}

async function capture(locationId) {
  const pit = await resolvePit();
  const H = { Authorization: `Bearer ${pit}`, Version: "2021-07-28", "Content-Type": "application/json" };
  const get = async (path) => {
    const res = await fetch(BASE + path, { headers: H });
    const text = await res.text();
    if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${text.slice(0, 160)}`);
    return JSON.parse(text);
  };

  const { objects = [] } = await get(`/objects/?locationId=${encodeURIComponent(locationId)}`);
  const userDefined = objects.filter((o) => o.type === "USER_DEFINED");

  const fieldsByObject = {};
  for (const o of userDefined) {
    // An object with no custom fields is a real state, not an error.
    try {
      fieldsByObject[o.key] = await get(
        `/custom-fields/object-key/${encodeURIComponent(o.key)}?locationId=${encodeURIComponent(locationId)}`);
    } catch (err) {
      console.error(`  ! ${o.key}: ${err.message}`);
      fieldsByObject[o.key] = { fields: [] };
    }
  }
  return fingerprint({ locationId, objects, fieldsByObject });
}

// Shared by `fetch` and `repair`.
const workerBase = () => flag("worker") || process.env.DASHBOARD_URL ||
  "https://homs-admin-dashboard.yari-058.workers.dev";

async function workerFetch(path, init = {}) {
  const key = process.env.PROVISION_KEY;
  if (!key) throw new Error("set PROVISION_KEY to call the Worker");
  const res = await fetch(workerBase() + path, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

const fingerprintOf = (locationId) =>
  workerFetch(`/api/schema/fingerprint?locationId=${encodeURIComponent(locationId)}`);

if (cmd === "repair") {
  const [locationId] = args;
  const willApply = rest.includes("--apply");
  if (!locationId) throw new Error("usage: repair <locationId> [--apply]");

  const expected = JSON.parse(await fs.readFile(
    flag("contract") || new URL("./schema/demo-homs.schema.json", import.meta.url), "utf8"));

  const before = await fingerprintOf(locationId);
  if (before.unreadable) {
    // Repairing against a half-read account would "fix" fields by writing the
    // contract's values over whatever could not be read.
    throw new Error(`cannot repair: ${before.unreadable.length} object(s) unreadable — ` +
      before.unreadable.map((u) => `${u.objectKey} (${u.error})`).join("; "));
  }

  const repairs = repairsFor(expected, before);
  if (!repairs.length) {
    console.log("Nothing to repair — every FILE_UPLOAD constraint already matches the contract.");
    console.log(formatDiff(diffSchemas(expected, before), { actualLabel: locationId }));
    process.exit(0);
  }

  console.log(`${repairs.length} field(s) to repair on ${locationId}:\n`);
  for (const r of repairs) {
    console.log(`  ${r.fieldKey}`);
    console.log(`    formats  ${JSON.stringify(r.was.acceptedFormats)}  ->  ${JSON.stringify(r.acceptedFormats)}`);
    console.log(`    maxFiles ${JSON.stringify(r.was.maxFileLimit)}  ->  ${JSON.stringify(r.maxFileLimit)}`);
  }

  if (!willApply) {
    console.log("\n(dry run — pass --apply to write)");
    process.exit(0);
  }

  const out = await workerFetch("/api/schema/repair", {
    method: "POST",
    body: JSON.stringify({ locationId, repairs, apply: true }),
  });
  console.log(`\napplied ${out.applied.length}, skipped ${out.skipped.length}, failed ${out.failed.length}`);
  for (const s of out.skipped) console.log(`  skipped ${s.fieldKey}: ${s.reason}`);
  for (const f of out.failed) console.log(`  FAILED  ${f.fieldKey}: ${f.error}`);

  // Proved, not assumed: GHL accepting a write is not evidence it stored it,
  // which is exactly how the receipt_photo probe went wrong in October.
  console.log("\nre-reading the account…\n");
  const after = await fingerprintOf(locationId);
  const result = diffSchemas(expected, after);
  console.log(formatDiff(result, { expectedLabel: "contract", actualLabel: locationId }));
  process.exit(result.ok ? 0 : 1);
} else if (cmd === "fetch") {
  const [locationId, out] = args;
  if (!locationId) throw new Error("usage: fetch <locationId> [out.json]");
  const fp = await fingerprintOf(locationId);
  if (fp.unreadable) console.error(`  ! ${fp.unreadable.length} object(s) unreadable: ` +
    fp.unreadable.map((u) => u.objectKey).join(", "));

  const json = JSON.stringify(fp, null, 2) + "\n";
  if (out) {
    await fs.writeFile(out, json);
    const objs = Object.keys(fp.objects);
    console.log(`${out}: ${objs.length} objects, ` +
      `${objs.reduce((n, k) => n + Object.keys(fp.objects[k].fields).length, 0)} fields`);
  } else {
    process.stdout.write(json);
  }
} else if (cmd === "capture") {
  const [locationId, out] = args;
  if (!locationId) throw new Error("usage: capture <locationId> [out.json]");
  const fp = await capture(locationId);
  const json = JSON.stringify(fp, null, 2) + "\n";
  if (out) {
    await fs.writeFile(out, json);
    const objs = Object.keys(fp.objects);
    const fields = objs.reduce((n, k) => n + Object.keys(fp.objects[k].fields).length, 0);
    console.log(`${out}: ${objs.length} objects, ${fields} fields`);
    for (const k of objs) console.log(`  ${k}  (${Object.keys(fp.objects[k].fields).length} fields)`);
  } else {
    process.stdout.write(json);
  }
} else if (cmd === "diff") {
  const [expectedPath, actualPath] = args;
  if (!expectedPath || !actualPath) throw new Error("usage: diff <expected.json> <actual.json>");
  const expected = JSON.parse(await fs.readFile(expectedPath, "utf8"));
  const actual = JSON.parse(await fs.readFile(actualPath, "utf8"));
  const result = diffSchemas(expected, actual);
  console.log(formatDiff(result, { expectedLabel: expectedPath, actualLabel: actualPath }));
  // Non-zero only on integrity failures, so this can gate a provisioning step.
  process.exit(result.ok ? 0 : 1);
} else {
  console.log([
    "usage:",
    "  node tools-schema.mjs fetch   <locationId> [out.json]   # via the Worker, needs PROVISION_KEY",
    "  node tools-schema.mjs capture <locationId> [out.json] [--pit-file t.json]",
    "  node tools-schema.mjs diff    <expected.json> <actual.json>",
    "  node tools-schema.mjs repair  <locationId> [--apply]   # fetch, diff, fix, re-verify",
  ].join("\n"));
  process.exit(2);
}
