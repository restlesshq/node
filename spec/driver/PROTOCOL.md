# Conformance driver protocol

Every Restless SDK ships a **conformance driver**: a small, dev-only
executable that exposes the SDK's contract-governed functions over stdin
and stdout. It is not published to the language's package registry and no
customer ever runs it.

It exists so the conformance tooling can be written **once** and pointed at
any language. Three things ride on this one interface:

1. **Vector replay** - `spec/harness/run-vectors.mjs` feeds every case in
   `spec/vectors/*.json` through the driver and diffs the results.
2. **Differential fuzzing** - `spec/harness/fuzz.mjs` generates inputs no
   human would think to write and runs them through two drivers at once,
   comparing outputs. This is what catches regex-dialect and Unicode
   divergences; handwritten vectors do not include a lone surrogate or a
   Turkish dotted I unless somebody thought to add one.
3. **Coverage reporting** - which requirement IDs a given SDK actually
   exercises.

## Transport

JSON Lines over stdio. One JSON object per line, no pretty-printing, `\n`
terminated, UTF-8.

**Request** (harness to driver, on stdin):

```json
{"id":"7","op":"mask","input":{"apiKey":"abc123wxyz"}}
```

**Response** (driver to harness, on stdout):

```json
{"id":"7","result":"sha512-...?wxyz"}
```

**Failure** (the operation raised):

```json
{"id":"7","error":"unknown op: mazk"}
```

Rules:

- `id` MUST be echoed back verbatim. It correlates request to response.
- Responses MAY be emitted out of order; the harness correlates on `id`.
- Exactly one response per request.
- `result` MUST be present on success, `error` on failure. Never both.
- The driver MUST NOT write anything else to stdout. Diagnostics go to
  stderr.
- The driver MUST exit 0 when stdin closes.
- JSON `null` represents absence. A language with a distinct "no value"
  (`undefined`, `None`, a zero value) MUST map it to `null` on the way out,
  and MUST accept `null` as absence on the way in.

## Operations

Input field names are shared across languages; a port MAY accept its own
idiomatic casing in its public API but MUST accept these names here.

### Masking

| op | input | result |
|---|---|---|
| `mask` | `{apiKey: string\|null}` | `string\|null` |

### Redaction

| op | input | result |
|---|---|---|
| `redactValue` | `{value: string}` | `string` |
| `redactHeaders` | `{headers: object, extra?: string[]}` | `object` |
| `redactUrl` | `{url: string, extra?: string[]}` | `string` |
| `redactBody` | `{body: string\|null, contentType: string\|null, extra?: string[]}` | `string\|null` |
| `truncateBody` | `{body: string\|null, maxBytes: number}` | `string\|null` |

### Fingerprinting

| op | input | result |
|---|---|---|
| `fingerprint` | `{status: number, method?: string, route?: string, responseHeaders?: object, responseBody?: any, stackTrace?: string\|string[]}` | `{strategy: string, key: string}` |
| `normalizeRoute` | `{route: string\|null}` | `string` |
| `normalizeMessage` | `{message: string}` | `string` |
| `projectRelative` | `{file: string}` | `string` |
| `fallbackKey` | `{status: number, method?: string, route?: string, responseBody?: any}` | `string` |

`fingerprint` returns **only** `strategy` and `key`. The `reason` field is
human-facing prose and is explicitly not contract surface (CONTRACT.md
FP-003), so drivers MUST NOT include it.

### Request IDs

| op | input | result |
|---|---|---|
| `formatRequestId` | `{rawId: string, prefix?: string}` | `string` |
| `stripRequestIdPrefix` | `{requestId: string}` | `string` |
| `requestIdHeaders` | `{ourId: string, incomingHeaders: object, prefix?: string, hasApiKey: boolean}` | `object` |

There is deliberately no op for *generating* a request id: the output is
random, so there is nothing to compare. REQID-001 and REQID-002 are
verified by each SDK's own unit tests, not by vectors.

### Injection

| op | input | result |
|---|---|---|
| `recoverySlug` | `{method?: string, path?: string}` | `string` |

### HAR

| op | input | result |
|---|---|---|
| `harEntry` | `{captured: CapturedRequest}` | `HarEntry` |

`CapturedRequest` is `{requestId, startedAt, duration, routePattern?,
request: {method, url, headers, body?}, response: {status, headers, body?}}`.

## Implementing a driver

The driver should be a thin shell over the SDK's real internals. If it
reimplements anything, it is testing itself rather than the SDK.

The reference driver is `spec/driver/node.ts`; its whole body is a loop
around `spec/ops.ts`, which is the same table the vector generator uses.
That sharing is deliberate: it makes it impossible for the Node vectors to
describe behaviour the Node driver does not exhibit.

## Running the harness against a driver

```sh
# Node (build first, the driver runs against compiled output)
npm run spec:driver
node spec/harness/run-vectors.mjs -- node spec/driver/.build/node.js

# any other SDK
node spec/harness/run-vectors.mjs -- python -m restless._conformance
node spec/harness/run-vectors.mjs -- go run ./cmd/conformance

# differential fuzz: reference on the left, port under test on the right
node spec/harness/fuzz.mjs \
  --ref  "node spec/driver/.build/node.js" \
  --test "python -m restless._conformance" \
  --iterations 20000
```

## Skips

Two different things skip, and they are reported separately because they
mean different things.

**`unknown op` / `not implemented`** is a property of the OPERATION: the port
has not built it yet. The harness records the case as skipped, and the
fuzzer stops generating for that op entirely.

**`unsupported`** is a property of the INPUT: the case falls outside what
this implementation's language can represent or parse. Two exist today:

- a v8-shaped stack trace fed to a driver that parses another dialect
  (FP-046)
- an unpaired surrogate reaching a UTF-8-native language, which its JSON
  decoder replaces with U+FFFD before any SDK code runs (PRIM-035). A Go or
  Rust driver MUST report `unsupported` for the entire line rather than
  process a value that has already been mangled.

The fuzzer skips only that ITERATION, not the op. Conflating the two is a
silent-coverage bug rather than a cosmetic one: because the character pool
deliberately oversamples surrogates, treating an input-level skip as an
op-level one cut a Go fuzz run from ~5,200 comparisons to ~200 while still
printing "no divergence".

Unimplemented operations are reported as skipped, not failed, so a partial
port gets a useful report from day one rather than a wall of red.
