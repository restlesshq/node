# Porting the Restless SDK

How to build a Restless SDK in another language, and how to prove an
existing one is correct.

The Node SDK (`restlesshq/node`) is the reference implementation. Every
other SDK implements the same contract. This skill covers both directions:
building a new port, and proving an existing one is correct.

## The one rule

**Do not audit conformance by reading code. Run the harness.**

There is a machine-checkable contract with generated test vectors and a
differential fuzzer. Anyone reading two implementations side by side will
confidently miss that Python's `\w` is Unicode-aware while JavaScript's is
ASCII, that `len()` on an emoji differs in every language, or that a header
name spelled with U+212A folds into a denylisted one. Every real divergence
found so far was found by the harness or by probing the contract, never by
review. Reading code is for explaining a failure the harness found, not for
deciding whether one exists.

If you cannot run the harness, say so and stop rather than substituting a
judgement call.

## Layout

Everything lives in the Node repo under `spec/`.

| path | what |
|---|---|
| `spec/CONTRACT.md` | The normative spec. Every requirement has a stable ID. |
| `spec/vectors/*.json` | Generated conformance cases. What ports test against. |
| `spec/driver/PROTOCOL.md` | The JSON Lines driver interface every SDK implements. |
| `spec/harness/run-vectors.mjs` | Replays vectors through any driver. |
| `spec/harness/fuzz.mjs` | Differential fuzz between two drivers. |
| `spec/schema/v1-request.schema.json` | JSON Schema for the ingest payload. |
| `spec/cases.ts` | Case *inputs*. Node-only; ports never read this. |

Ports consume `vectors/`, `CONTRACT.md`, `driver/PROTOCOL.md`, `harness/`
and `schema/`, pinned to a spec version.

## Auditing an existing port

1. Build the port's conformance driver (`spec/driver/PROTOCOL.md`).
2. Replay the vectors:

   ```sh
   node spec/harness/run-vectors.mjs --json report.json -- <driver command>
   ```

   Read the per-requirement rollup at the bottom. `non-conformant
   requirements` are bugs. `unverified requirements` are unimplemented ops,
   which may be legitimate for a Level 1 SDK (see CONTRACT.md 1.1).

3. Fuzz against the reference, which finds what the vectors do not:

   ```sh
   npm run spec:driver   # in the Node repo, builds the reference driver
   node spec/harness/fuzz.mjs \
     --ref  "node spec/driver/.build/node.js" \
     --test "<port driver command>" \
     --iterations 20000
   ```

   The seed is printed and the run is deterministic, so any divergence
   reproduces with `--seed N`.

4. Report by requirement ID, not by file. "REDACT-002 fails on 4 cases: the
   sentinel counts UTF-16 code units" is actionable. "the redaction looks
   slightly off" is not.

Level 2 behaviour (batching, caches, injection, safety) is not covered by
vectors. Verify it against CONTRACT.md sections 8 through 13 with the
port's own integration tests.

## Porting to a new language

Order matters. Do not start with adapters.

1. **Read `spec/CONTRACT.md` sections 2 through 7.** Section 2 is the one
   people skip and the one that causes every silent divergence. Internalise
   the character classes, the counting units, and the JSON rules before
   writing anything.

2. **Implement the pure functions** (sections 3 to 7): masking, redaction,
   fingerprinting, request ids, HAR. No I/O, no frameworks.

3. **Implement the driver** and get every vector green. Only then move on.

4. **Fuzz** against the Node reference until it is clean at 20k+ iterations.

5. **Implement Level 2**: the capture engine, uploader, batching, the two
   caches, injection. Verify against sections 8 to 13.

6. **Adapters last**, idiomatic to the language. CONTRACT.md section 14 is
   explicit that these are not standardised: do not port Node's duck-typed
   universal middleware, and do not copy its framework list.

### Language traps

Each of these has produced a silent divergence. Check them explicitly.

- **Python**: compile every contract regex with `re.ASCII`, or `\w`, `\d`
  and `\b` become Unicode-aware and fingerprints diverge on any non-ASCII
  message. `json.dumps` needs `separators=(",", ":")` and
  `ensure_ascii=False`. `datetime.isoformat()` is the wrong timestamp
  format (microseconds, `+00:00`) - see PRIM-040.
- **Go**: RE2 has no lookahead or backreferences, which is why
  `normalizeRoute` is specified segment-wise (FP-030). `encoding/json`
  sorts map keys, violating PRIM-031; use an order-preserving type.
  `len()` on a string is bytes, not code points - see PRIM-010.
- **Ruby**: `\w` is ASCII by default, which is correct here, but `\b` is
  NOT - Onigmo defines it against the Unicode word property, so `/\ba/`
  matches "ea" in JS and Python and does not in Ruby. Run that step against
  bytes. Watch `String#length` (characters) versus `bytesize` (PRIM-011).
- **PHP**: `strlen` is bytes; `mb_strlen` with an explicit UTF-8 encoding
  is what PRIM-010 wants. PCRE needs `/u` off for ASCII `\w` semantics.
- **Java/C#**: `String.length()` is UTF-16 code units, so it is wrong
  everywhere this contract says code points. Use code point counts.

## Changing the contract

A behaviour change in any SDK's contract surface is a **coordinated
change** (CONTRACT.md CHANGE-003). In the same change you need: the
requirement edited in `CONTRACT.md`, vectors regenerated
(`npm run spec:vectors`), and the spec version bumped.

Before changing anything in `fingerprint`, run the new implementation
differentially against the old one over a large corpus and confirm the diff
is zero or explicitly accounted for. A moved fingerprint key silently
orphans the Agent Recovery message attached to it in the dashboard, and
nobody notices for weeks (CHANGE-004).

Changes to `mask()`, the redaction sentinel, the fingerprint algorithm, or
the wire payload also require moving the ingest (`logs/`) and the dashboard
(`app/`) together. Stored fingerprints and masked keys in ClickHouse do not
migrate themselves.

## Where the reference lives

| concern | Node source |
|---|---|
| masking | `src/lib/mask.ts` |
| redaction | `src/lib/redact.ts` |
| fingerprints | `src/lib/fingerprint.ts` |
| HAR | `src/lib/har.ts` |
| request ids | `src/lib/requestId.ts` |
| wire payload, batching | `src/lib/uploader.ts` |
| capture engine, caches | `src/lib/capture.ts` |
| injection, slug | `src/adapters/_shared.ts` |

Server-side counterparts that must agree: `mask()` in
`logs/src/clickhouse/models/request.ts`, and `recoverySlug` in the app's
recovery route.
