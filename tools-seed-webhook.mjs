// Seed ONE regenerated inbound-webhook trigger and repoint KV at it.
//
//   node tools-seed-webhook.mjs <locationId> <tenantField> <url-file>
//
// Use it when a single trigger has been regenerated in GHL and has a new URL.
// /admin/seed-webhooks seeds all four at once and is the right thing after a
// fresh snapshot load; this is for the one-at-a-time case, and it also writes
// the new URL back to KV, which that endpoint does not do.
//
// The URL comes from a FILE, never the command line, so it stays out of shell
// history. Put the URL GHL shows on the trigger into a file on its own and pass
// the path; the file is deleted once the write is verified.
//
// Seed while the workflow is still a DRAFT. A published inbound webhook runs
// the whole workflow on receipt.
//
// Sends the same bytes /admin/seed-webhooks would, by calling the Worker's own
// payload builder rather than restating it: a seed that drifts from production
// teaches GHL a field schema production never sends.
//
// Prints no URL and no secret, only the last six characters of a trigger id so
// it can be matched against the screen. The id is a bearer credential -- anyone
// holding it can fire the workflow.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SEED_PAYLOADS } from "./src/webhook-seed.js";

const [LOC, field, urlFile] = process.argv.slice(2);
// No default locationId on purpose. One baked in here would quietly aim a seed
// at whichever account it named, and the URL check below would then refuse with
// a message about the wrong sub-account.
if (!LOC || !field || !urlFile) {
  console.error("usage: node tools-seed-webhook.mjs <locationId> <tenantField> <url-file>");
  console.error(`  tenantField: ${Object.keys(SEED_PAYLOADS).join(" | ")}`);
  process.exit(2);
}
if (!SEED_PAYLOADS[field]) {
  console.error(`unknown field "${field}". one of: ${Object.keys(SEED_PAYLOADS).join(", ")}`);
  process.exit(2);
}

const url = fs.readFileSync(urlFile, "utf8").trim();
if (!/^https:\/\/services\.leadconnectorhq\.com\/hooks\//.test(url)) throw new Error("not a GHL inbound webhook URL");
// A URL for another account would seed somebody else's workflow.
if (!url.includes(`/hooks/${LOC}/`)) throw new Error("that webhook URL belongs to a different sub-account");
console.log(`${SEED_PAYLOADS[field].label}: trigger id ends ...${url.split("/").pop().slice(-6)}`);

const wrangler = (args) =>
  execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", shell: true, maxBuffer: 32e6 });
const readTenant = () => {
  const raw = wrangler(["kv", "key", "get", LOC, "--binding", "TENANTS", "--remote"]);
  return JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
};

const before = readTenant();
console.log(before[field] === url ? "note  same URL KV already holds" : "note  regenerated -- KV will be repointed");

const payload = SEED_PAYLOADS[field].payload();
const keys = Object.keys(payload);
console.log(`sending ${keys.length} keys (${SEED_PAYLOADS[field].events.join(" + ")})`);

const res = await fetch(url, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
});
const body = (await res.text()).slice(0, 200);
console.log(`${res.ok ? "PASS" : "FAIL"}  POST -> ${res.status}${res.ok ? "" : ` ${body}`}`);
if (!res.ok) { console.log("KV not touched."); process.exit(1); }

// Without this the Worker still notifies the regenerated-away URL, and a real
// event fires nothing at all.
// Written, read back, and retried -- a KV put has reported success and not
// stuck three times in this session (processingFeePct on YV, then this very
// field). The read-back is the only thing that knows, so it drives the loop.
let stored = false;
let verify = before;
for (let attempt = 1; attempt <= 3 && !stored; attempt++) {
  const current = readTenant();
  if (current[field] === url) { stored = true; verify = current; break; }
  const tmp = path.join(process.cwd(), `.seed-${field}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ ...current, [field]: url }));
  try {
    wrangler(["kv", "key", "put", LOC, `--path=${tmp}`, "--binding", "TENANTS", "--remote"]);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  await new Promise((r) => setTimeout(r, 2500));
  verify = readTenant();
  stored = verify[field] === url;
  console.log(`${stored ? "PASS" : "retry"}  KV write attempt ${attempt}`);
}
console.log(`${stored ? "PASS" : "FAIL"}  KV now points at this trigger`);
const moved = [...new Set([...Object.keys(before), ...Object.keys(verify)])]
  .filter((k) => k !== field && JSON.stringify(before[k]) !== JSON.stringify(verify[k]));
console.log(moved.length === 0 ? "PASS  no other field changed" : `FAIL  also changed: ${moved.join(", ")}`);

if (stored && !moved.length) {
  fs.rmSync(urlFile, { force: true });
  console.log("PASS  handover file deleted");
}

console.log("\nA 200 means GHL accepted the request, NOT that it captured the schema.");
console.log("Confirm the trigger's field list shows these before publishing:");
console.log("  " + keys.join(", "));
