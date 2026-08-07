#!/usr/bin/env node
// Differential fuzz: run generated inputs through two conformance drivers
// and report any output that disagrees.
//
//   node spec/harness/fuzz.mjs \
//     --ref  "node spec/driver/.build/node.js" \
//     --test "python -m restless._conformance" \
//     --iterations 20000
//
// This is the tool that finds what vectors cannot. The handwritten cases in
// spec/cases.ts cover what somebody thought to write down; the divergences
// that actually bite are the ones nobody anticipated:
//
//   - `\w` and `\d` are Unicode-aware in Python's `re` but ASCII in JS,
//     Go and Ruby, so any non-ASCII word character changes a fingerprint.
//   - `\s` is the reverse: Unicode in JS, ASCII elsewhere.
//   - Astral characters count as 1 code point, 2 UTF-16 units, 4 bytes.
//   - Lone surrogates, combining marks, and NBSP all behave differently
//     depending on how a language slices strings.
//
// The generators below deliberately oversample exactly those cases.
//
// Seeded and fully deterministic: the same --seed reproduces the same run,
// so a reported failure is always reproducible.

import { Driver, parseDriverArg, deepEqual } from "./driver-client.mjs";

const argv = process.argv.slice(2);
const refArgv = parseDriverArg(argv, "--ref");
const testArgv = parseDriverArg(argv, "--test");
const iterations = Number(argv[argv.indexOf("--iterations") + 1]) || 5000;
const seed0 = Number(argv[argv.indexOf("--seed") + 1]) || 0x5eed;
const maxReport = Number(argv[argv.indexOf("--max-report") + 1]) || 20;

if (!refArgv || !testArgv) {
  console.error('usage: fuzz.mjs --ref "<cmd>" --test "<cmd>" [--iterations N] [--seed N]');
  process.exit(2);
}

// ---- deterministic RNG ----
let seed = seed0 >>> 0;
function rnd() {
  // xorshift32
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >> 17;
  seed ^= seed << 5;  seed >>>= 0;
  return seed / 0x100000000;
}
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (n) => Math.floor(rnd() * n);

// ---- character pools, weighted toward the things that break ports ----
const CHARS = [
  ..."abcdefghijklmnopqrstuvwxyz",
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  ..."0123456789",
  ..."_-.:/@?&=+%#!,;'\"`()[]{}<>|\\*$^~",
  " ", "\t", "\n", "\r", "\v", "\f",
  " ", " ", " ", " ", " ", " ", " ",
  " ", " ", "　", "﻿",           // the rest of WS
  "é", "É", "ü", "ß", "İ", "ı", "Ç", "ñ",           // case-mapping traps
  "日", "本", "語", "中", "한", "ก",                  // non-ASCII word-ish
  "🙂", "🚀", "👨‍👩‍👧", "🇳🇱",                          // astral + ZWJ + flags
  "́", "̇", "ͯ",                     // combining marks
  "\ud83d", "\ude00",                               // lone surrogate halves
];

function randomString(maxLen = 24) {
  const n = int(maxLen);
  let s = "";
  for (let i = 0; i < n; i++) s += pick(CHARS);
  return s;
}

function randomToken() {
  return pick([
    randomString(12),
    "user_" + int(100000),
    "sk_live_" + int(100000),
    "550e8400-e29b-41d4-a716-44665544" + String(int(10000)).padStart(4, "0"),
    "deadbeefdeadbeef" + int(1000),
    String(int(1000000)),
    pick(["not_found", "card_declined", "AUTH_MISMATCH", "invalid.param", "a".repeat(int(70))]),
    pick(["password", "token", "apiKey", "api_key", "secret", "username", "id"]),
  ]);
}

function randomRoute() {
  const n = 1 + int(4);
  let r = rnd() < 0.85 ? "" : "x";
  for (let i = 0; i < n; i++) r += "/" + pick([randomToken(), "{id}", ":id", "users", "", randomString(6)]);
  if (rnd() < 0.15) r += "/";
  return r;
}

function randomMessage() {
  const n = 1 + int(8);
  const parts = [];
  for (let i = 0; i < n; i++) {
    parts.push(pick([
      randomToken(), randomString(10),
      "https://" + randomString(8) + ".com/" + randomString(5),
      randomString(5) + "@" + randomString(5) + "." + randomString(3),
      "'" + randomString(8) + "'", '"' + randomString(8) + '"',
      "failed", "cannot", "read", "property", "undefined", "connection",
    ]));
  }
  return parts.join(pick([" ", "  ", " ", ", ", " - ", "\t"]));
}

function randomJsonBody() {
  const keys = ["password", "token", "apiKey", "api_key", "API-Key", "secret", "ssn",
                "username", "id", "nested", "items", "cvv", "note"];
  const build = (depth) => {
    if (depth > 2) return pick([randomString(8), int(1000), null, true]);
    const kind = rnd();
    if (kind < 0.2) return Array.from({ length: int(3) }, () => build(depth + 1));
    if (kind < 0.85) {
      const o = {};
      for (let i = 0; i < 1 + int(4); i++) o[pick(keys)] = build(depth + 1);
      return o;
    }
    return pick([randomString(10), int(100000), 9007199254740993, 1.0, null, false]);
  };
  return JSON.stringify(build(0));
}

// ---- the op generators ----
const GENERATORS = {
  mask: () => ({ apiKey: pick([randomString(20), randomToken(), "", null]) }),
  redactValue: () => ({ value: randomString(20) }),
  redactUrl: () => ({
    url: pick([
      "https://api.example/" + randomString(6) + "?" + pick(["token", "api_key", "q", "secret"]) + "=" + randomString(10),
      "https://api.example:443/a?a=1&password=" + randomString(12),
      randomString(20),
    ]),
  }),
  redactHeaders: () => ({
    headers: {
      authorization: pick(["Bearer " + randomString(16), randomString(20), "Basic " + randomString(12)]),
      [pick(["cookie", "x-api-key", "content-type", "x-custom"])]: randomString(16),
    },
  }),
  redactBody: () => ({ body: randomJsonBody(), contentType: pick(["application/json", "application/json; charset=utf-8", "text/plain"]) }),
  truncateBody: () => ({ body: randomString(64), maxBytes: 1 + int(48) }),
  normalizeRoute: () => ({ route: randomRoute() }),
  normalizeMessage: () => ({ message: randomMessage() }),
  recoverySlug: () => ({ method: pick(["GET", "POST", "delete", "", null]), path: pick([randomRoute(), "", null]) }),
  stripRequestIdPrefix: () => ({ requestId: pick([randomString(12), "TST-550e8400-e29b-41d4-a716-446655440000", "550e8400-e29b-41d4-a716-446655440000"]) }),
  fingerprint: () => ({
    status: pick([400, 401, 402, 403, 404, 409, 422, 429, 500, 502, 503]),
    method: pick(["GET", "POST", "PUT", "DELETE", null]),
    route: pick([randomRoute(), null]),
    responseHeaders: rnd() < 0.4 ? { "x-restless-error-code": randomToken() } : {},
    responseBody: rnd() < 0.5
      ? { code: randomToken(), message: randomMessage() }
      : pick([{ error: { code: randomToken() } }, { message: randomMessage() }, randomMessage(), null]),
    stackTrace: rnd() < 0.3
      ? `Error: x\n    at ${randomString(6)} (/proj/src/${randomString(5)}.js:${int(99)}:1)`
      : null,
  }),
};

const OPS = Object.keys(GENERATORS);

// ---- run ----
const ref = new Driver(refArgv);
const test = new Driver(testArgv);

const diffs = [];
const errors = [];
const skippedOps = new Set();
const unsupportedInputs = new Map();
let compared = 0;

for (let i = 0; i < iterations; i++) {
  const op = OPS[i % OPS.length];
  if (skippedOps.has(op)) continue;
  const input = GENERATORS[op]();

  const [a, b] = await Promise.all([ref.send(op, input), test.send(op, input)]);

  if (a.error !== undefined) {
    errors.push({ side: "ref", op, input, error: a.error });
    if (errors.length > 50) break;
    continue;
  }
  if (b.error !== undefined) {
    // "unknown op" / "not implemented" is a property of the OP, so disable it
    // for the rest of the run. "unsupported" is a property of this INPUT (a
    // dialect limitation, e.g. an unpaired surrogate a UTF-8-native language
    // cannot represent), so skip only this iteration.
    //
    // Conflating the two silently destroys coverage: the Go driver rejects
    // any input containing a lone surrogate, and because the character pool
    // oversamples those, treating it as an op-level skip cut the run from
    // ~6000 comparisons to ~200 while still reporting "no divergence".
    if (/unknown op|not implemented/i.test(b.error)) {
      skippedOps.add(op);
      continue;
    }
    if (/unsupported/i.test(b.error)) {
      unsupportedInputs.set(op, (unsupportedInputs.get(op) ?? 0) + 1);
      continue;
    }
    diffs.push({ op, input, ref: a.result, test: `<error> ${b.error}` });
    continue;
  }

  compared++;
  if (!deepEqual(a.result, b.result)) {
    diffs.push({ op, input, ref: a.result, test: b.result });
  }
}

await ref.close();
await test.close();

// ---- report ----
const RED = "\x1b[31m", GREEN = "\x1b[32m", YELLOW = "\x1b[33m", DIM = "\x1b[2m", OFF = "\x1b[0m";
const c = (col, s) => (process.stdout.isTTY ? col + s + OFF : s);

console.log();
console.log(`  ref:      ${ref.command}`);
console.log(`  test:     ${testArgv.join(" ")}`);
console.log(`  seed:     ${seed0}   ${c(DIM, "(rerun with --seed " + seed0 + " to reproduce)")}`);
console.log(`  compared: ${compared}`);
console.log();

if (skippedOps.size) {
  console.log(`  ${c(YELLOW, "skipped ops")} (unimplemented in test driver): ${[...skippedOps].sort().join(", ")}`);
}
if (unsupportedInputs.size) {
  const summary = [...unsupportedInputs].sort().map(([op, n]) => `${op}=${n}`).join(" ");
  console.log(`  ${c(YELLOW, "inputs outside the test driver's dialect")}: ${summary}`);
}
if (skippedOps.size || unsupportedInputs.size) console.log();

for (const e of errors.slice(0, 5)) {
  console.log(`  ${c(RED, "REF ERROR")} ${e.op}: ${e.error}`);
  console.log(`     input: ${JSON.stringify(e.input)}`);
}

const byOp = new Map();
for (const d of diffs) byOp.set(d.op, (byOp.get(d.op) ?? 0) + 1);

for (const d of diffs.slice(0, maxReport)) {
  console.log(`  ${c(RED, "DIFF")} ${d.op}`);
  console.log(`     input: ${JSON.stringify(d.input)}`);
  console.log(`     ref:   ${JSON.stringify(d.ref)}`);
  console.log(`     test:  ${JSON.stringify(d.test)}`);
  console.log();
}
if (diffs.length > maxReport) console.log(`  ... and ${diffs.length - maxReport} more\n`);

if (diffs.length === 0 && errors.length === 0) {
  console.log(`  ${c(GREEN, "no divergence")} across ${compared} comparisons\n`);
} else {
  console.log(`  ${c(RED, diffs.length + " divergence(s)")} by op: ${[...byOp].map(([k, v]) => `${k}=${v}`).join(" ")}\n`);
}

process.exit(diffs.length > 0 || errors.length > 0 ? 1 : 0);
