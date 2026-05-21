# Internals

Details that don't belong in the main README. Useful if you're debugging, self-hosting, or extending the SDK.

## Settings resolution

On construction, `restless()` walks up from the current working directory looking for `.restless/settings.json`. The file is owned by the `api/` CLI and looks like:

```json
{
  "version": 1,
  "projectId": "<team uuid>",
  "apis": [
    {
      "id": "<api uuid>",
      "name": "Test API",
      "requestIdPrefix": "TST",
      "rootDir": ".",
      "oasFile": ".restless/openapi.yaml",
      "framework": "Fastify",
      "language": "javascript",
      "baseUrl": "…",
      "internal": false,
      "lastSyncedAt": "…"
    }
  ]
}
```

The SDK reads:

- `apis[].requestIdPrefix` → prepended to the UUID in response headers
- `apis[].redact` → merged with the built-in redaction denylists

(Other fields like `id`, `name`, `oasFile` are used by the `api` CLI during setup, not the SDK at runtime.)

If the file defines exactly one API, it's used automatically. If it defines more than one, you must pass `{ api: "<name>" }` or the constructor throws.

The file is read once per process and cached.

## Batching

- **Queue size:** 10 requests. Flushed when reached.
- **Flush interval:** 5000 ms. Flushed when a queued request is older than this.
- **Localhost short-circuit:** when `baseUrl` is `localhost` or `127.0.0.1`, every push flushes immediately. Keeps dev-loop latency low.
- **Explicit flush:** `client.flush()`. Call before process exit if you care about in-flight captures.

These values are currently hardcoded. If a real use case needs them tuneable, add a field to `EngineConfig` in `src/lib/capture.ts`.

## Wire format

Each batched `POST /v1/request` payload is an array of HAR-wrapped logs. The SDK ships:

- a per-request `apiKey` (the masked end-user identifier)
- a per-request `projectId` (the wire-format name for the user-supplied `owner.id`: customer / org grouping key)
- enriched owner metadata (label, contact emails, any extra fields) when the SDK decides the server needs fresh enrichment
- the HAR 1.2 envelope containing the request / response pair

Server-facing details (the exact wire JSON, auxiliary grouping blocks the server indexes on) live in `src/lib/uploader.ts`. If you need to change them, coordinate with the metrics server's ingest path.

## Redaction

Runs at `CaptureEngine.record()`: the single choke point before anything enters the uploader queue. No adapter bypasses this path.

### Sentinel format (stable contract)

```
<REDACTED:<length>>                 // when length < 8
<REDACTED:<length>:<last-4-chars>>  // when length ≥ 8
```

This format is a contract with the dashboard. The frontend pattern-matches on `<REDACTED:(\d+)(?::(.{4}))?>` to render the length and tail as UI chrome. **Do not change the format without coordinating with the dashboard team.** Adding new prefixes (e.g. `<REDACTED:N:tail:reason>`) is fine if it's backward-compatible with the current regex.

### What gets redacted

- **Headers:** `authorization`, `cookie`, `set-cookie`, `proxy-authorization`, `x-api-key`, `x-auth-token` (case-insensitive).
- **JSON body keys:** `password`, `pass`, `pwd`, `token`, `secret`, `apikey`, `accesstoken`, `refreshtoken`, `idtoken`, `sessionid`, `ssn`, `creditcard`, `ccnumber`, `cvv`, `cvc`. Comparison normalizes to lowercase AND strips `-` / `_` (so `api_key` / `apiKey` / `API-Key` all match).
- **Query string params:** same list as body keys.

Extensions come from two sources, both additive on top of the defaults:

1. **`.restless/settings.json` → `apis[].redact`**: populated by the `api` setup CLI (it scans the OpenAPI spec + code for custom auth mechanisms). Useful when every deploy of this API needs the same custom redaction.
2. **`opts.redact` passed to `restless()`**: per-process extensions. Useful when the same SDK package is used across multiple services with different secrets.

Both extensions merge with the built-in defaults. Defaults are always applied.

### What gets truncated

Request and response bodies are capped at **256 KB** (`MAX_BODY_BYTES` in `src/lib/capture.ts`). Larger bodies are truncated with a `[...TRUNCATED: original N bytes]` suffix. UTF-8 boundaries are not guaranteed; the slice is on code units.

### Queue cap

The uploader queue is hard-capped at **1000 entries**. When full, the oldest entry is dropped on the next push. Under `DEBUG=restless` you'll see a warning. This prevents OOM during a metrics-server outage.

## Enrichment

The setup callback's `enrich` function lets users do expensive lookups (DB, JWT verification, external HTTP) lazily. The engine caches per-masked-key whether fresh enrichment has been sent to the server, so repeated requests from the same user skip `enrich` entirely.

### Cache behavior

- Keyed by `owner.id` when provided (so multiple end-users from the same owner share a cache slot), falling back to the masked `apiKey` when no owner is set.
- Entries are marked fresh after `enrich()` resolves successfully.
- A 1-hour TTL backstops the cache (`DEFAULT_TTL_MS` in `src/lib/enrichCache.ts`).
- `enrich` failures are swallowed and NOT cached. The next request will retry.

### Server-driven invalidation

On every successful upload, the uploader parses the server's JSON response and passes it to `CaptureEngine.handleServerResponse`. If the body contains:

```json
{ "needsEnrichment": ["sha512-xxx?1234", "sha512-yyy?5678"] }
```

the engine calls `enrichCache.invalidate()` for each key. The next request from those users will re-run `enrich`.

### What ships on cached requests

When a user is cached-fresh, the upload payload contains just the masked `apiKey` (and any other cheap fields returned from the setup callback). The server uses its own stored copy of the enrichment. This keeps the payload minimal and avoids re-sending identical metadata.

## Masking

`mask()` produces `sha512-<base64-digest>?<last4>`. This format is the SDK's wire contract with the metrics server's lookup code. Changing the format requires a coordinated server update; don't do it in isolation.

Falsy input returns `undefined` rather than hashing a placeholder. When neither `apiKey` nor `owner.id` is provided, the log is tagged as anonymous.

## Error fingerprints

`fingerprint()` (in `src/lib/fingerprint.ts`) produces a stable identifier for an HTTP error response. The SDK computes one at capture time and ships it with the log. The metrics server stores it. The site groups by it. Customers attach a "next steps" message to a group, and the SDK looks the message up at runtime to inject it into matching responses.

**This is a cross-SDK contract**, the same way `mask()` is. If the algorithm changes here, every other SDK port (Python, Ruby, PHP, ...) and any stored fingerprints have to move with it. Don't change it in isolation.

Five strategies are tried in priority order; the first that yields a key wins:

| # | strategy     | when it fires                                                       | key shape                            |
|---|--------------|---------------------------------------------------------------------|--------------------------------------|
| 1 | `header`     | response has `x-restless-error-code` header (case-insensitive)      | `{status}:{code}`                    |
| 2 | `body-code`  | response body has `code`, `error_code`, `errorCode`, `type`, or nested `error.code`/`error.type`/`error.error_code` that looks like an identifier (`/^[A-Za-z][\w.\-]*$/`, ≤64 chars) | `{status}:{code}`                    |
| 3 | `stack`      | `status >= 500` and a stack trace is available; uses the topmost frame that isn't `node_modules`, `node:internal`, or `@restlessai/sdk` | `{status}:{file}:{fn}`               |
| 4 | `message`    | response body has an extractable `message` (top-level, `error.message`, or string `error`) | `{status}:{method}:{route}:{normalized message}` |
| 5 | `route-only` | nothing usable                                                       | `{status}:{method}:{route}`          |

Stability rules:

- **No line numbers in stack keys.** The frame is `file:fn`, never `file:line`. Adding a comment above a throw shouldn't ungroup events.
- **Project-relative file paths.** Anything before `/src/`, `/lib/`, `/app/`, `/api/`, `/routes/`, `/controllers/`, or `/handlers/` is stripped, so `/Users/dev/proj/src/db/users.js` and `/srv/app/src/db/users.js` produce the same key.
- **Templated routes.** Concrete IDs in the path are replaced before the key is built: numeric segments → `/:id`, RFC 4122 UUIDs → `/:id`, 16+ char hex segments → `/:id`. If the customer already passed a templated route, this is a no-op.
- **Aggressive message normalization.** The fallback message strategy lowercases, strips URLs / emails / quoted strings, then strips *whole words* containing any digit (so `user_abc123`, `sk_live_4242`, UUID fragments all vanish), then drops residual punctuation and takes the first 6 remaining words joined by `-`. Stripping just digits isn't enough: `abc123` would become `abc` and still influence the key.

The site never re-derives the fingerprint. It reads what the SDK shipped. This avoids the algorithm drifting between two implementations.

## Agent Recovery messages

A customer can attach a "next steps" message to a fingerprint group via the dashboard's Agent Recovery page (the `/errors` view). When the SDK sees an error whose fingerprint has a saved message, it injects the message into the response body's `debug.recovery` field so the calling agent has actionable guidance without an extra round-trip.

The lookup is on the hot path of every 4xx/5xx, so the design is sync and cache-first:

- `RecoveryCache` (in `src/lib/recoveryCache.ts`) is an in-process TTL'd map of `fingerprintKey → message | null`.
- Adapters call `engine.lookupRecovery(key)` synchronously when an error is about to ship. The lookup never waits on the network; a cold miss simply means no message is injected this time.
- Messages are seeded by piggybacking on the existing `/v1/request` upload response, exactly like enrich invalidation. The server returns `recoveryMessages: { [fingerprintKey]: string }` for any keys it has guidance for. The engine then negative-caches every uploaded fingerprint the server didn't return a message for, so subsequent occurrences hit the cache (positive or negative) without re-asking.
- Two TTLs: positive entries last 1h, negative entries 5m. The shorter negative TTL means freshly-attached messages start working within a few minutes of being saved in the dashboard.

The first occurrence of any given fingerprint after a process boot won't get a message injected. That's the deliberate trade-off: never block a user response on a network fetch.

Adapters compute the fingerprint once, pre-response, so the same value can be (a) used for the recovery lookup and (b) attached to `CapturedRequest.errorFingerprint` for the upload — no redundant work on the path.

## Request IDs

- Always RFC 4122 v4 UUIDs from `crypto.randomUUID()` (CSPRNG).
- Deliberately NOT time-based. IDs appear in URLs and logs; we don't want them leaking ordering.
- Two response headers:
  - `x-restless-id`: always set. This is ours.
  - `x-request-id`: set only if the incoming request didn't already have one. We don't stomp an existing request-id chain.
- Incoming `x-request-id` values are **never reused** as our ID. We always mint a fresh one so the log lookup is unambiguous.

On 4xx/5xx responses we also add:

- `x-log-url`: deep link to the captured log
- `x-debug`: the `npx api debug <id>` CLI invocation
- A `debug` object injected into JSON response bodies with the same links plus a hint

## Blocking

Return `block: true | { status?, message? }` from the setup callback to reject a request with a 4xx response. The handler never runs.

For fleet-wide blocking (e.g. revoked keys across a cluster), the `Blocklist` class in `src/lib/blocklist.ts` exposes `has()` / `replace()` and is wired through the engine. The periodic-fetch piece lands when the metrics server exposes an endpoint. The intent is to avoid requiring Redis by serving a small signed snapshot and keeping it in-process.

## Environment variables

| variable             | effect                                                            |
|----------------------|-------------------------------------------------------------------|
| `RESTLESS_KEY`       | Fallback API key when `restless()` is called without one          |
| `README_API_KEY`     | Secondary fallback (checked after `RESTLESS_KEY`)                 |
| `RESTLESS_BASE_URL`  | Override the metrics server URL. **Plain HTTP to a non-localhost host triggers a one-shot warning on stderr**. Your API key ships in the clear. |
| `DEBUG=restless`     | Print upload errors and diagnostics on stderr                     |

### `.env` auto-load

If `RESTLESS_KEY` (and `README_API_KEY`) are both unset when `restless()` is called, the SDK walks up from `process.cwd()` looking for a `.env` file and loads it. Uses `process.loadEnvFile()` on Node 20.6+ and a minimal built-in parser on Node 18. Never overwrites vars already set in `process.env`, so `dotenv`, `--env-file`, and shell exports all win against the auto-loader.

**Monorepo caveat:** the walk starts from `cwd`, not from the caller's source file location. `cd packages/api && node index.js` picks up `packages/api/.env` as expected. Running `node packages/api/index.js` from the repo root picks up the repo-root `.env` instead, because that's what `cwd` points at. This matches how `dotenv` and `--env-file` behave. If you want per-package env in a monorepo, launch from inside the package or pass the key explicitly to `restless(key)`.

## Failure modes

- **Missing API key:** the batch is dropped silently. With `DEBUG=restless` you'll see a warning.
- **Upload failures:** swallowed. `DEBUG=restless` logs the status + body.
- **Setup callback throws:** caught, falls back to the `.restless/settings.json` defaults for the request.
- **Malformed `.restless/settings.json`:** returns `null` from the loader → no auto-config, no crash.

The overriding principle: observability never takes down the request path.
