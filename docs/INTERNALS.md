# Internals

Details that don't belong in the main README. Useful if you're debugging, self-hosting, or extending the SDK.

## Settings resolution

On construction, `restless()` walks up from the current working directory looking for `.api/settings.json`. The file is owned by the `api/` CLI and looks like:

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
      "oasFile": ".api/openapi.yaml",
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

- `apis[].id` → `project.id` in every captured log
- `apis[].name` → `project.name` + `group.label` on the wire
- `apis[].requestIdPrefix` → prepended to the UUID in response headers

If the file defines exactly one API, it's used automatically. If it defines more than one, you must pass `{ api: "<name>" }` or the constructor throws.

The file is read once per process and cached.

## Batching

- **Queue size:** 10 requests. Flushed when reached.
- **Flush interval:** 5000 ms. Flushed when a queued request is older than this.
- **Localhost short-circuit:** when `baseUrl` is `localhost` or `127.0.0.1`, every push flushes immediately. Keeps dev-loop latency low.
- **Explicit flush:** `client.flush()` — call before process exit if you care about in-flight captures.

These values are currently hardcoded. If a real use case needs them tuneable, add a field to `EngineConfig` in `src/lib/capture.ts`.

## Wire format

Each batched `POST /v1/request` payload is an array of:

```ts
{
  _id: string,               // request UUID
  routePattern?: string,     // OAS-style, e.g. "/pets/{id}"
  group: {
    id: string,              // masked apiKey OR email OR "anonymous"
    label: string,           // project.name
    email: string,
  },
  project?: { id, name },    // duplicated here so the server can index on it
  clientIPAddress: string,
  development: boolean,
  request: {
    log: {                   // HAR 1.2 envelope containing ONE entry
      version: "1.2",
      creator: { name, version },
      entries: [HarEntry],
    },
  },
}
```

Both `group` and `project` are sent on every payload. Servers can index on either.

## Redaction

Runs at `CaptureEngine.record()` — the single choke point before anything enters the uploader queue. No adapter bypasses this path.

### Sentinel format (stable contract)

```
<REDACTED:<length>>                 // when length < 8
<REDACTED:<length>:<last-4-chars>>  // when length ≥ 8
```

This format is a contract with the dashboard. The frontend pattern-matches on `<REDACTED:(\d+)(?::(.{4}))?>` to render the length and tail as UI chrome. **Do not change the format without coordinating with the dashboard team.** Adding new prefixes (e.g. `<REDACTED:N:tail:reason>`) is fine if it's backward-compatible with the current regex.

### What gets redacted

- **Headers** — `authorization`, `cookie`, `set-cookie`, `proxy-authorization`, `x-api-key`, `x-auth-token` (case-insensitive).
- **JSON body keys** — `password`, `pass`, `pwd`, `token`, `secret`, `apikey`, `accesstoken`, `refreshtoken`, `idtoken`, `sessionid`, `ssn`, `creditcard`, `ccnumber`, `cvv`, `cvc`. Comparison normalizes to lowercase AND strips `-` / `_` (so `api_key` / `apiKey` / `API-Key` all match).
- **Query string params** — same list as body keys.

Extensions come from two sources, both additive on top of the defaults:

1. **`.api/settings.json` → `apis[].redact`** — populated by the `api` setup CLI (it scans the OpenAPI spec + code for custom auth mechanisms). Useful when every deploy of this API needs the same custom redaction.
2. **`opts.redact` passed to `restless()`** — per-process extensions. Useful when the same SDK package is used across multiple services with different secrets.

Both extensions merge with the built-in defaults. Defaults are always applied.

### What gets truncated

Request and response bodies are capped at **256 KB** (`MAX_BODY_BYTES` in `src/lib/capture.ts`). Larger bodies are truncated with a `[...TRUNCATED: original N bytes]` suffix. UTF-8 boundaries are not guaranteed — the slice is on code units.

### Queue cap

The uploader queue is hard-capped at **1000 entries**. When full, the oldest entry is dropped on the next push. Under `DEBUG=restless` you'll see a warning. This prevents OOM during a metrics-server outage.

## Enrichment

The setup callback's `enrich` function lets users do expensive lookups (DB, JWT verification, external HTTP) lazily. The engine caches per-masked-key whether fresh enrichment has been sent to the server, so repeated requests from the same user skip `enrich` entirely.

### Cache behavior

- Keyed by the masked API key (the same `sha512-<base64>?<last4>` string that goes on the wire as `group.id`).
- Entries are marked fresh after `enrich()` resolves successfully.
- A 1-hour TTL backstops the cache (`DEFAULT_TTL_MS` in `src/lib/enrichCache.ts`).
- `enrich` failures are swallowed and NOT cached — the next request will retry.

### Server-driven invalidation

On every successful upload, the uploader parses the server's JSON response and passes it to `CaptureEngine.handleServerResponse`. If the body contains:

```json
{ "needsEnrichment": ["sha512-xxx?1234", "sha512-yyy?5678"] }
```

the engine calls `enrichCache.invalidate()` for each key. The next request from those users will re-run `enrich`.

### What ships on cached requests

When a user is cached-fresh, the upload payload contains just the masked `apiKey` (and any other cheap fields returned from the setup callback). The server uses its own stored copy of the enrichment. This keeps the payload minimal and avoids re-sending identical metadata.

## Masking

`mask()` produces `sha512-<base64-digest>?<last4>`. This format is the SDK's wire contract with the metrics server's lookup code. Changing the format requires a coordinated server update — don't do it in isolation.

Falsy input returns `undefined` rather than hashing a placeholder. The uploader falls back to `"anonymous"` for `group.id` when no mask is provided.

## Request IDs

- Always RFC 4122 v4 UUIDs from `crypto.randomUUID()` (CSPRNG).
- Deliberately NOT time-based — IDs appear in URLs and logs; we don't want them leaking ordering.
- Two response headers:
  - `x-restless-id` — always set. This is ours.
  - `x-request-id` — set only if the incoming request didn't already have one. We don't stomp an existing request-id chain.
- Incoming `x-request-id` values are **never reused** as our ID. We always mint a fresh one so the log lookup is unambiguous.

On 4xx/5xx responses we also add:

- `x-log-url` — deep link to the captured log
- `x-debug` — the `npx api debug <id>` CLI invocation
- A `debug` object injected into JSON response bodies with the same links plus a hint

## Blocking

Return `block: true | { status?, message? }` from the setup callback to reject a request with a 4xx response. The handler never runs.

For fleet-wide blocking (e.g. revoked keys across a cluster), the `Blocklist` class in `src/lib/blocklist.ts` exposes `has()` / `replace()` and is wired through the engine. The periodic-fetch piece lands when the metrics server exposes an endpoint. The intent is to avoid requiring Redis by serving a small signed snapshot and keeping it in-process.

## Environment variables

| variable             | effect                                                            |
|----------------------|-------------------------------------------------------------------|
| `RESTLESS_KEY`       | Fallback API key when `restless()` is called without one          |
| `README_API_KEY`     | Secondary fallback (checked after `RESTLESS_KEY`)                 |
| `RESTLESS_BASE_URL`  | Override the metrics server URL. **Plain HTTP to a non-localhost host triggers a one-shot warning on stderr** — your API key ships in the clear. |
| `DEBUG=restless`     | Print upload errors and diagnostics on stderr                     |

## Failure modes

- **Missing API key:** the batch is dropped silently. With `DEBUG=restless` you'll see a warning.
- **Upload failures:** swallowed. `DEBUG=restless` logs the status + body.
- **Setup callback throws:** caught, falls back to the `.api/settings.json` defaults for the request.
- **Malformed `.api/settings.json`:** returns `null` from the loader → no auto-config, no crash.

The overriding principle: observability never takes down the request path.
