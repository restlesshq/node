#!/usr/bin/env node
// Replay every case in spec/vectors/*.json through a conformance driver
// and report per-requirement results.
//
//   node spec/harness/run-vectors.mjs -- node spec/driver/.build/node.js
//   node spec/harness/run-vectors.mjs -- python -m restless._conformance
//
// Flags:
//   --json <path>   also write a machine-readable conformance report
//   --verbose       print every case, not just failures
//   --only <substr> run only cases whose id or requirement contains substr
//
// Exit code is 0 when nothing FAILED. Unimplemented ops are SKIPPED, not
// failed, so a port in progress gets a useful report from day one instead
// of a wall of red.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Driver, parseDriverArg, compareResult } from "./driver-client.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const VECTOR_DIR = join(HERE, "..", "vectors");

const argv = process.argv.slice(2);
const driverArgv = parseDriverArg(argv);
if (!driverArgv || driverArgv.length === 0) {
  console.error("usage: run-vectors.mjs [--json out.json] [--verbose] [--only substr] -- <driver command>");
  process.exit(2);
}

const jsonOut = argv.includes("--json") ? argv[argv.indexOf("--json") + 1] : null;
const verbose = argv.includes("--verbose");
const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null;

const files = readdirSync(VECTOR_DIR).filter((f) => f.endsWith(".json")).sort();
if (files.length === 0) {
  console.error(`no vector files in ${VECTOR_DIR} - run \`npm run spec:vectors\``);
  process.exit(2);
}

const GREEN = "\x1b[32m", RED = "\x1b[31m", YELLOW = "\x1b[33m", DIM = "\x1b[2m", OFF = "\x1b[0m";
const isTTY = process.stdout.isTTY;
const c = (color, s) => (isTTY ? color + s + OFF : s);

const driver = new Driver(driverArgv);
const results = [];
let specVersion = null;

for (const file of files) {
  const doc = JSON.parse(readFileSync(join(VECTOR_DIR, file), "utf8"));
  specVersion ??= doc.specVersion;

  for (const kase of doc.cases) {
    if (only && !kase.id.includes(only) && !kase.requirement.includes(only)) continue;

    const response = await driver.send(kase.op, kase.input);

    let status, detail;
    if (response.error !== undefined) {
      // "unknown op" / "not implemented" = a port under construction.
      // "unsupported" = a case outside this implementation's dialect,
      // e.g. a v8-shaped stack fed to a Python traceback parser (FP-046).
      // Both are legitimately skippable; anything else is a real failure.
      const skippable = /unknown op|not implemented|unsupported/i.test(response.error);
      status = skippable ? "skipped" : "failed";
      detail = response.error;
    } else if (compareResult(kase.compare, response.result, kase.expected)) {
      status = "passed";
    } else {
      status = "failed";
      detail = { expected: kase.expected, actual: response.result };
    }

    results.push({ file, id: kase.id, requirement: kase.requirement, op: kase.op, status, detail, note: kase.note });
  }
}

await driver.close();

// ---- report ----

const passed = results.filter((r) => r.status === "passed");
const failed = results.filter((r) => r.status === "failed");
const skipped = results.filter((r) => r.status === "skipped");

console.log();
console.log(`  driver:  ${driver.command}`);
console.log(`  spec:    ${specVersion}`);
console.log(`  cases:   ${results.length}`);
console.log();

if (verbose) {
  for (const r of results) {
    const mark = r.status === "passed" ? c(GREEN, "PASS") : r.status === "failed" ? c(RED, "FAIL") : c(YELLOW, "SKIP");
    console.log(`  ${mark}  ${r.id}  ${c(DIM, r.requirement)}`);
  }
  console.log();
}

for (const r of failed) {
  console.log(`  ${c(RED, "FAIL")}  ${r.id}  ${c(DIM, r.requirement + " / " + r.op)}`);
  if (r.note) console.log(`        ${c(DIM, r.note)}`);
  if (typeof r.detail === "string") {
    console.log(`        driver error: ${r.detail}`);
  } else {
    console.log(`        expected: ${JSON.stringify(r.detail.expected)}`);
    console.log(`        actual:   ${JSON.stringify(r.detail.actual)}`);
  }
  console.log();
}

// Per-requirement rollup. This is the number that answers "how conformant
// is this SDK" without anyone reading code.
const byRequirement = new Map();
for (const r of results) {
  const entry = byRequirement.get(r.requirement) ?? { passed: 0, failed: 0, skipped: 0 };
  entry[r.status]++;
  byRequirement.set(r.requirement, entry);
}
const reqFailed = [...byRequirement.entries()].filter(([, v]) => v.failed > 0);
// "Unverified" means NO case proved it, not merely that some case was
// skipped. FP-042 for instance is skipped by the v8-dialect stack cases in
// a Python SDK but still fully proved by the projectRelative cases, so
// listing it here would be a false alarm.
const reqSkipped = [...byRequirement.entries()].filter(
  ([, v]) => v.failed === 0 && v.passed === 0 && v.skipped > 0,
);

if (skipped.length) {
  // Distinguish "this op does not exist yet" from "this case is outside
  // the implementation's dialect" (FP-046). Both skip, for different
  // reasons, and conflating them makes a finished SDK look unfinished.
  const unimplemented = [...new Set(skipped.filter((r) => /unknown op|not implemented/i.test(String(r.detail))).map((r) => r.op))].sort();
  const dialect = [...new Set(skipped.filter((r) => /unsupported/i.test(String(r.detail))).map((r) => r.op))].sort();
  if (unimplemented.length) console.log(`  ${c(YELLOW, "skipped")} - unimplemented ops: ${unimplemented.join(", ")}`);
  if (dialect.length) console.log(`  ${c(YELLOW, "skipped")} - cases outside this implementation's dialect: ${dialect.join(", ")}`);
}
if (reqFailed.length) {
  console.log(`  ${c(RED, "non-conformant requirements")}: ${reqFailed.map(([k]) => k).sort().join(", ")}`);
}
if (reqSkipped.length) {
  console.log(`  ${c(YELLOW, "unverified requirements")}:    ${reqSkipped.map(([k]) => k).sort().join(", ")}`);
}

console.log();
console.log(
  `  ${c(GREEN, passed.length + " passed")}  ${failed.length ? c(RED, failed.length + " failed") : "0 failed"}  ${skipped.length ? c(YELLOW, skipped.length + " skipped") : "0 skipped"}`,
);
console.log();

if (jsonOut) {
  writeFileSync(
    jsonOut,
    JSON.stringify(
      {
        driver: driver.command,
        specVersion,
        generatedBy: "spec/harness/run-vectors.mjs",
        totals: { passed: passed.length, failed: failed.length, skipped: skipped.length },
        requirements: Object.fromEntries([...byRequirement].sort(([a], [b]) => a.localeCompare(b))),
        cases: results,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`  report written to ${jsonOut}`);
  console.log();
}

process.exit(failed.length > 0 ? 1 : 0);
