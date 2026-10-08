// Capture one account's object layer, or compare two captures.
//
//   node tools-schema.mjs capture <locationId> [out.json]     # needs a PIT
//   node tools-schema.mjs fetch <locationId> [out.json]       # via the Worker
//   node tools-schema.mjs diff <expected.json> <actual.json>
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
import { fingerprint, diffSchemas, formatDiff } from "./src/schema-fingerprint.js";

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

if (cmd === "fetch") {
  const [locationId, out] = args;
  if (!locationId) throw new Error("usage: fetch <locationId> [out.json]");
  const base = flag("worker") || process.env.DASHBOARD_URL ||
    "https://homs-admin-dashboard.yari-058.workers.dev";
  const key = process.env.PROVISION_KEY;
  if (!key) throw new Error("set PROVISION_KEY to call the Worker");

  const res = await fetch(`${base}/api/schema/fingerprint?locationId=${encodeURIComponent(locationId)}`,
    { headers: { Authorization: `Bearer ${key}` } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 300)}`);
  const fp = JSON.parse(text);
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
  ].join("\n"));
  process.exit(2);
}
