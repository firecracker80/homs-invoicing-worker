// Run the whole test suite. `npm test` points here.
// Run: node run-tests.mjs            (invoicing Worker only)
//      node run-tests.mjs --all      (plus homs-admin-dashboard)
//
// WHY THIS EXISTS. There is no CI in this repo -- no .github directory at all --
// and `npm test` used to be `node test-worker.js`, a single file. The 42
// `test-*.mjs` suites were run by hand or not at all, so a branch could break
// every one of them and nothing would say so. The only automated check on a PR
// is the Cloudflare Workers build, which uploads a version and executes no
// tests; a PR reading `mergeStateStatus: CLEAN` means it has no merge
// conflicts, NOT that the suite passes. Those two were being read as one thing.
//
// Found 2026-11-06 by the session auditing the pre-#166 invoices, while
// checking a claim of mine. It was right to check it.
//
// Node's own glob is not used: `test-*.mjs` expansion differs between shells
// and does not expand at all in cmd.exe, and this has to be one command a
// person can trust on Windows before a merge.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const DASHBOARD = "homs-admin-dashboard";
const all = process.argv.includes("--all");

const suitesIn = (dir) =>
  readdirSync(dir)
    .filter((f) => /^test-.*\.mjs$/.test(f) || f === "test-worker.js")
    .sort()
    .map((f) => ({ dir, file: f }));

const targets = [...suitesIn("."), ...(all ? suitesIn(join(".", DASHBOARD)) : [])];

let passed = 0;
const failed = [];

for (const { dir, file } of targets) {
  const res = spawnSync(process.execPath, [file], {
    cwd: dir,
    encoding: "utf8",
    // Several suites print expected console.error lines (a dead webhook, a
    // missing D1 binding). Output is captured and only shown for a FAILURE, so
    // a green run is quiet and a red one is readable.
    stdio: ["ignore", "pipe", "pipe"],
  });
  const label = dir === "." ? file : `${dir}/${file}`;
  if (res.status === 0) {
    passed++;
    process.stdout.write(".");
  } else {
    failed.push({ label, out: `${res.stdout || ""}${res.stderr || ""}`.trim() });
    process.stdout.write("F");
  }
}

process.stdout.write("\n\n");

for (const f of failed) {
  console.log(`--- FAILED: ${f.label}`);
  // The assertion message is what identifies the defect, so show the tail
  // rather than the first lines of a stack.
  console.log(f.out.split("\n").slice(-14).join("\n"));
  console.log("");
}

console.log(`${passed} passing, ${failed.length} failing` +
  (all ? "" : `   (run with --all to include ${DASHBOARD})`));
if (failed.length) {
  console.log("FAILED: " + failed.map((f) => f.label).join(", "));
  process.exit(1);
}
