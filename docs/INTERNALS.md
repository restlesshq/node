# Internals

Details that don't belong in the main README. Useful if you're debugging, self-hosting, or extending the SDK.

> **Building a Restless SDK in another language?** Read [`spec/CONTRACT.md`](../spec/CONTRACT.md) instead of this file. This document explains how the Node SDK works; the contract states what every SDK must do, with stable requirement IDs, generated test vectors, and a harness that runs them against any implementation. See [`spec/README.md`](../spec/README.md).

## Settings resolution

On construction, `restless()` walks up from the current working directory looking for `.restless/settings.json`. The file is owned by the `restless` CLI (`npx restless init`) and looks like:

```json
{
  "version": 1,
  "apis": [
    {
      "id": "<api uuid>",
      "name": "Test API",
      "requestIdPrefix": "TST",
      "rootDir": ".",
      "projectId": "<restless project uuid>",
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

(Other fields like `id`, `name`, `projectId` and `oasFile` are used by the `restless` CLI during setup, not the SDK at runtime. `projectId` is per-API and lives on the entry; there is no top-level `projectId`.)

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

### Upload headers

| header | value |
|---|---|
| `Content-Type` | `application/json` |
| `Authorization` | `Bearer <project API key>` |
| `X-Restless-Spec-Version` | the contract version this SDK implements, from `src/lib/version.ts` |

The spec-version header exists so the ingest can attribute an off-contract payload to a specific SDK and spec version instead of guessing (spec/CONTRACT.md META-002); the ingest currently ignores it. The value is a hardcoded constant in `src/lib/version.ts`, re-exported as `SPEC_VERSION` - bump it in the same change that bumps the version at the top of `CONTRACT.md`. It is NOT `__SDK_VERSION__`, which is the npm package version baked in at build time and shipped as the HAR `creator`.

## Request body capture (Express / http)

Frameworks that hand the adapter an already-parsed body (Fastify `req.body`, Koa `ctx.request.body`) are easy. Express and bare http are not: the body is a stream, and the handler owns it.

The Express middleware patches `req.push` - the single funnel every chunk passes through on its way into the readable buffer - and copies each chunk as it goes by. It does NOT subscribe to `'data'`: attaching a listener switches the stream into flowing mode and steals the body from a handler that meant to read it itself.

This used to patch `req.on` and wrap only `'data'` listeners, which silently captured nothing from a handler that read the body any other way. Node's async iterator (`for await (const chunk of req)`) uses `'readable'`/`read()`, so those requests logged with no `postData` at all and no indication anything was missing.

Two ordering details:

- The patch is installed **before** the first `await` in the middleware. An async setup callback (DB lookup, JWT verification) is enough of a window for chunks to arrive, and anything pushed before the patch is invisible.
- A blocked request restores the original `push` and drops what it buffered - nothing downstream will read that body.

If `req.push` isn't a function (an exotic runtime shim), body capture is skipped rather than forced; the log still ships, bodyless.

## Redaction

Runs at `CaptureEngine.record()`: the single choke point before anything enters the uploader queue. No adapter bypasses this path.

### Sentinel format (stable contract)

```
<REDACTED:<length>>                 // when length < 8
<REDACTED:<length>:<last-4-chars>>  // when length ≥ 8
```

This format is a contract with the dashboard. The frontend pattern-matches on `<REDACTED:(\d+)(?::(.{4}))?>` to render the length and tail as UI chrome. **Do not change the format without coordinating with the dashboard team.** Adding new prefixes (e.g. `<REDACTED:N:tail:reason>`) is fine if it's backward-compatible with the current regex.

Length and tail are counted in **Unicode code points**, not UTF-16 code units. `"🙂🙂🙂🙂🙂🙂🙂🙂"` redacts to `<REDACTED:8:🙂🙂🙂🙂>`, not `<REDACTED:16:🙂🙂>`. JS `.length` would say 16, Python would say 8, Go's `len()` would say 32 - so a code-unit count makes the same secret produce a different sentinel in every SDK, and a naive `slice(-4)` can split a surrogate pair and emit an ill-formed tail. Same rule applies to `mask()`'s `?last4`. See spec/CONTRACT.md REDACT-002 and MASK-006.

### What gets redacted

- **Headers:** `authorization`, `cookie`, `set-cookie`, `proxy-authorization`, `x-api-key`, `x-auth-token` (case-insensitive).
- **JSON body keys:** `password`, `pass`, `pwd`, `token`, `secret`, `apikey`, `accesstoken`, `refreshtoken`, `idtoken`, `sessionid`, `ssn`, `creditcard`, `ccnumber`, `cvv`, `cvc`. Comparison normalizes to lowercase AND strips `-` / `_` (so `api_key` / `apiKey` / `API-Key` all match).
- **Query string params:** same list as body keys.

Extensions come from two sources, both additive on top of the defaults:

1. **`.restless/settings.json` → `apis[].redact`**: populated by the `restless` setup CLI (it scans the OpenAPI spec + code for custom auth mechanisms). Useful when every deploy of this API needs the same custom redaction.
2. **`opts.redact` passed to `restless()`**: per-process extensions. Useful when the same SDK package is used across multiple services with different secrets.

Both extensions merge with the built-in defaults. Defaults are always applied.

### Bodies with nothing to redact are passed through untouched

`redactBody` parses the body to look for denylisted keys. If it finds none, it returns **the caller's original string, byte for byte** rather than a re-serialized copy.

This matters more than it looks. A `JSON.parse` / `JSON.stringify` round trip is lossy: JS silently truncates integers above 2^53 (an int64 id like `9007199254740993` comes back as `...992`) and renders `1.0` as `1`. We were corrupting customer payloads on the way to the dashboard for no benefit. It's also the main place SDKs disagree with each other - key ordering, separator style, and number rendering all differ by language - so skipping it for the overwhelming majority of bodies removes the divergence instead of trying to specify it away.

Bodies that *do* contain a secret still get re-serialized; there's no way to rewrite a value without doing so. For those, the output is compact-separated with key order preserved. See spec/CONTRACT.md REDACT-020.

### What gets truncated

Request and response bodies are capped at **256 KB** (`MAX_BODY_BYTES` in `src/lib/capture.ts`). Larger bodies are truncated with a `[...TRUNCATED: original N bytes]` suffix, where N is the original UTF-8 byte length.

The cut is made at the byte limit and then backed off to the nearest character boundary, so the kept prefix is always a complete sequence of Unicode scalar values. Truncating `"🚀🚀🚀🚀"` at 6 bytes yields one rocket, not one-and-a-half. (This used to compare byte length but slice UTF-16 code units, which cut at a different point in every language and could emit a lone surrogate.) See spec/CONTRACT.md REDACT-031.

### Queue cap

The uploader queue is hard-capped at **1000 entries**. When full, the oldest entry is dropped on the next push. Under `DEBUG=restless` you'll see a warning. This prevents OOM during a metrics-server outage.

## Enrichment

The setup callback's `enrich` function lets users do expensive lookups (DB, JWT verification, external HTTP) lazily. The engine caches per-masked-key whether fresh enrichment has been sent to the server, so repeated requests from the same user skip `enrich` entirely.

### Cache behavior

- Keyed by `owner.id` when provided (so multiple end-users from the same owner share a cache slot), falling back to the masked `apiKey` when no owner is set.
- Entries are marked fresh after `enrich()` resolves successfully.
- A 1-hour TTL backstops the cache (`DEFAULT_TTL_MS` in `src/lib/enrichCache.ts`).
- `enrich` failures are swallowed and NOT cached. The next request will retry.
- A setup result carrying `block` skips `enrich` outright, cache read included. A blocked request never reaches the handler and is logged only by Fastify (whose `onSend` still fires), so the lookup would be pure waste - and the waste is unbounded: an abusive tenant would otherwise buy one lookup per owner id every time the cache expired. The blocked log keeps `owner.id`, which is the dashboard's grouping key; it loses the enriched label / emails.

### Server-driven invalidation

On every successful upload, the uploader parses the server's JSON response and passes it to `CaptureEngine.handleServerResponse`. If the body contains:

```json
{ "needsEnrichment": ["sha512-xxx?1234", "sha512-yyy?5678"] }
```

the engine calls `enrichCache.invalidate()` for each key. The next request from those users will re-run `enrich`.

### What ships on cached requests

When a user is cached-fresh, the upload payload contains just the masked `apiKey` (and any other cheap fields returned from the setup callback). The server uses its own stored copy of the enrichment. This keeps the payload minimal and avoids re-sending identical metadata.

## Masking

`mask()` produces `sha512-<base64-digest>?<last4>`. This format is the SDK's wire contract with the metrics server's lookup code. Changing the format requires a coordinated server update; don't do it in isolation. The digest is over the key's UTF-8 bytes, standard base64 (not base64url, padding included), and `last4` is the last four **code points** of the plaintext.

Falsy input returns `undefined` rather than hashing a placeholder. When neither `apiKey` nor `owner.id` is provided, the log is tagged as anonymous.

## Error fingerprints

`fingerprint()` (in `src/lib/fingerprint.ts`) produces a stable identifier for an HTTP error response. The SDK computes one at capture time and ships it with the log. The metrics server stores it. The site groups by it. Customers attach a "next steps" message to a group, and the SDK looks the message up at runtime to inject it into matching responses.

**This is a cross-SDK contract**, the same way `mask()` is. If the algorithm changes here, every other SDK port (Python, Ruby, PHP, ...) and any stored fingerprints have to move with it. Don't change it in isolation.

Strategies are tried in priority order; the first that yields a key wins. 404 is handled up front (step 0) because it's resource-oriented, not code-oriented — see below.

| # | strategy        | when it fires                                                       | key shape                            |
|---|-----------------|---------------------------------------------------------------------|--------------------------------------|
| 0a | `resource`     | `status == 404` AND the route has a path parameter (`:id`/`{id}`)   | `404:resource` (constant)            |
| 0b | `endpoint`     | `status == 404` with no path parameter (paramless route or no match)| `404:endpoint` (constant)            |
| 1 | `header`        | response has `x-restless-error-code` header (case-insensitive)      | `{status}:{code}`                    |
| 2 | `body-code`     | response body has `code`, `error_code`, `errorCode`, `type`, or nested `error.code`/`error.type`/`error.error_code` that looks like an identifier (`/^[A-Za-z][\w.\-]*$/`, ≤64 chars) | `{status}:{code}`                    |
| 3 | `stack`         | `status >= 500` and the adapter caught the exception behind the response; uses the topmost frame that isn't `node_modules`, `node:internal`, or `@restlessai/sdk` | `{status}:{file}:{fn}`               |
| 4 | `message`       | response body has an extractable `message` (top-level, `error.message`, or string `error`) | `{status}:{method}:{route}:{normalized message}` |
| 5 | `route-only`    | nothing usable                                                       | `{status}:{method}:{route}`          |

**Why 404 is special (steps 0a/0b).** A generic `not_found` code (header or body) is the same on every route, so grouping all 404s by code is useless for recovery. There are exactly two kinds of 404, and they need opposite advice: a 404 on a route **with a path parameter** (`/car/{id}`) means the route is fine but the addressed resource is missing (fix: verify the id, list the parent collection); a 404 **without a path parameter** (a paramless route, or a path that matched no route at all) means the path/endpoint itself didn't resolve (fix: call a real endpoint). We key these to two **constant** strings (`404:resource`, `404:endpoint`), NOT per-route — the agent that receives the hint already knows the concrete path it called, so one general hint per kind is actionable, and a human authors only two 404 hints total instead of one per route. The signal is whether the normalized route contains a `:`/`{` template segment (`normalizeRoute` rewrites concrete ids to `:id` first; `route` is absent when nothing matched, which falls into `endpoint`). 404 is intercepted before the code-based strategies, so an `x-restless-error-code` on a 404 does not re-collapse it.

Stability rules:

- **Portable by construction.** The algorithms avoid lookahead (RE2, and therefore any Go port, has none) and spell out `\w` / `\s` / `\d` as explicit character classes, because those shorthands mean different things in different regex engines: `\w` is ASCII in JS, Go and Ruby but Unicode-aware in Python; `\s` is the reverse. `normalizeRoute` is a split-on-`/` whole-segment test rather than a scan with `(?=\/|$)` for the same reason. Both rewrites were verified equivalent to the originals over 500k differential inputs, so no stored fingerprint moved. See spec/CONTRACT.md FP-030 and FP-040.
- **No line numbers in stack keys.** The frame is `file:fn`, never `file:line`. Adding a comment above a throw shouldn't ungroup events.
- **Project-relative file paths.** Everything before the LAST `/src/`, `/lib/`, `/app/`, `/api/`, `/routes/`, `/controllers/` or `/handlers/` segment is stripped, so `/Users/dev/proj/src/db/users.js`, `/app/src/db/users.js` (Docker, Heroku) and `/opt/render/project/src/db/users.js` all produce `src/db/users.js`. Last rather than first, because a deploy root named `/app` is itself the first match and would survive into the key, making production disagree with a laptop.
- **Templated routes.** Concrete IDs in the path are replaced before the key is built: numeric segments → `/:id`, RFC 4122 UUIDs → `/:id`, 16+ char hex segments → `/:id`. If the customer already passed a templated route, this is a no-op.
- **Aggressive message normalization.** The fallback message strategy lowercases, strips URLs / emails / quoted strings, then strips *whole words* containing any digit (so `user_abc123`, `sk_live_4242`, UUID fragments all vanish), then drops residual punctuation and takes the first 6 remaining words joined by `-`. Stripping just digits isn't enough: `abc123` would become `abc` and still influence the key.

The site never re-derives the fingerprint. It reads what the SDK shipped. This avoids the algorithm drifting between two implementations.

### Where the stack comes from

The `stack` strategy only fires if something hands `fingerprint()` a stack, so every adapter catches the exception its framework lets it see and attaches it to `CapturedRequest.stackTrace`. That field is local-only: it feeds the fingerprint and is never uploaded - only the resolved `file:fn` frame inside the key leaves the process.

| adapter | how it sees the exception |
|---|---|
| Koa, Hono | `try/catch` around `await next()`, then re-throw. Hono additionally reads `c.error`, because Hono's `compose` catches downstream throws itself, routes them to `app.onError` and resolves `next()` normally. |
| Fastify | the `onError` hook stashes it on `req._restless`; `onSend` (which still runs for the error response) picks it up. |
| Next.js | `try/catch` around the wrapped handler, then re-throw. Next's control-flow throws (`redirect()`, `notFound()`, `forbidden()` - anything carrying a `digest` that starts with `NEXT_`) are re-thrown WITHOUT being recorded: they are normal outcomes, and logging them would invent 500s that never happened. The `digest` prefix is the only available signal, since importing `next` at runtime would pull in an optional peer dep. |
| Express | the exported `errorHandler` middleware, which the USER registers after their routes. Express matches error middleware by 4-arity signature and position, so the capture middleware has already returned by the time an error is routed - there is nothing to hook from inside it. `errorHandler` only stashes onto the per-request state and calls `next(err)`; the log is still written by the `res.end` that Express's error handling triggers. |
| http | `try/catch` around the handler. There is no error-handling layer to end the response, so this path records the log itself and then re-throws (leaving the same unhandled rejection as before). |

Two invariants across all of them:

- **The exception is re-thrown unchanged** (spec/CONTRACT.md SAFETY-001). Framework error handling must behave exactly as it would without the SDK installed.
- **Exactly one log per request.** Per-request state carries a `recorded` flag, so a handler that throws after partially responding, or one that calls `res.end` twice, still produces one log.

The per-request state hangs off `req` under `Symbol.for("@restlessai/sdk.captureState")`. `Symbol.for` rather than a module-private symbol because the package ships both ESM and CJS builds and a process can load both - a unique symbol would make the error middleware from one build invisible to the middleware from the other.

A crash with a 4xx status (`http-errors`-style `err.status`) does not use the stack strategy: the ladder reserves it for `status >= 500`. Non-`Error` throws (strings, plain objects) carry no stack and fall through to the message / route-only strategies.

### Where the route pattern comes from

Three keys in the ladder are built from the route (`message`, `route-only`, and the 404 split), and the templated route also ships as `routePattern` on the log, where the dashboard folds traffic onto OpenAPI operations, and feeds `recoverySlug` (the dig-in URL's `<method>-<route>.md` tail). Each adapter sources it from its own router:

| adapter | where the pattern comes from |
|---|---|
| Express | `req.route.path`, with `:id` rewritten to `{id}` |
| Fastify | `req.routeOptions.url`, same rewrite |
| Koa | `ctx._matchedRoute` (koa-router), passed through as-is |
| Hono | `c.req.routePath`, passed through as-is |
| Next.js | rebuilt from `context.params` - see below |
| http | none. Bare `http` has no router, so there is no pattern to read |

**Next.js is the odd one out.** The App Router hands a handler no matched-route string: the pattern IS the file path, and neither the request nor the context carries it. What the context does carry is `params`, the concrete values Next pulled out of this URL, so the adapter substitutes them back out of the pathname: `/api/pets/42` plus `{ id: "42" }` gives `/api/pets/{id}`. Details that matter:

- **Matching is by decoded value, left to right, one consumption per param.** Params arrive keyed in route order, so two params carrying the same value still template in the right order. A segment is compared as `decodeURIComponent` would leave it, because Next hands over decoded values.
- **A value equal to another literal segment in the same path is ambiguous, and leftmost wins.**
  `params` carries values but no positions, so `/api/pets/pets` with `{ id: "pets" }` could be
  `/api/pets/{id}` (route `app/api/pets/[id]`) or `/api/{id}/pets` (route `app/api/[id]/pets`) and
  nothing available at runtime separates them. Leftmost is not a better guess than rightmost, it is a
  *deterministic* one: leftmost is wrong when the value equals an EARLIER literal, rightmost is wrong
  when it equals a LATER one, and the two collision shapes (an id equal to its collection noun, an id
  equal to a sub-resource noun) are about equally likely. The blast radius is small and bounded: the
  404 split only tests for the PRESENCE of `{`, so it is correct either way, and a mis-positioned
  template compiles to a shape no spec path matches, folding as "unknown endpoint" exactly as it did
  before any pattern was reported. The one genuinely bad case needs an API declaring both colliding
  shapes (`/api/pets/{id}` AND `/api/{org}/pets`), where the wrong shape can match the other real
  operation. Pinned by test, not fixed: the only exact fix is build-time, since the loader knows the
  route's file path (`wrapRouteHandler` already reserves a parameter for it), and that would cover
  auto-wrapped routes only.
- **A catch-all collapses to one template.** `[...slug]` matching three segments yields a single `{slug}`, not three. The point is to mark the part that varies; a multi-segment value can't line up with an OpenAPI path either way.
- **"No params" is an answer; "unreadable" is not, and the `params` KEY is what separates them.** Next hands a paramless route handler `{ params: undefined }` - measured on 16.2, the key is present and the value is not - so the presence of the key means "this is a route-handler context" whatever the value, and the concrete path IS the pattern. A context WITHOUT the key is something else (a bare call through the universal middleware, a Pages Router `(req, res)` pair), and so is a `params` that throws: both report no pattern at all, the pre-existing behavior, rather than passing a concrete path off as a template.
- **Reading it costs one await, and adds no failure mode.** `params` is a promise on Next 15+ (a plain object before that, which `await` passes through). Every handler on a parameterized route already awaits the same promise to read its ids, so one that never settled would hang the route with or without the SDK. It is resolved before the handler runs, so the throw path gets it too.

Why it earns the trouble: without a pattern, `normalizeRoute` turns every Next route into `/`, which has no `:`/`{` in it, so **every** 404 the app returns lands in `404:endpoint` - including a handler's own "no such pet" on a live parameterized endpoint, which belongs in `404:resource` and needs the opposite advice. `404:resource` was unreachable on Next entirely, and every dig-in URL slugged to `unknown`.

The pattern is recovered identically on all three Next entry points (the explicit `@restlessai/sdk/next` wrap, `withRestless`'s generated `wrapRouteHandler` call, and the universal middleware, which forwards the context through to the same wrapper).

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
- Exactly ONE id header per response, always carrying our own fresh id:
  - `x-request-id` by default. This is what a caller who sent no request id gets back.
  - `x-restless-id` instead, when the incoming request already carried an `x-request-id`. We don't stomp an existing request-id chain.
  - With no API key resolved the value is the literal `missing-key` rather than a UUID, which is how the CLI's `verify` tells "server up, key never loaded" apart from "request dropped".
- Incoming `x-request-id` values are **never reused** as our ID. We always mint a fresh one so the log lookup is unambiguous.

On **every** response we also add:

- `x-log-url`: deep link to the captured log
- `x-debug`: the `npx api debug <id>` CLI invocation

An agent that got a 200 it didn't expect has the same question as one that got a 500, and the header is the only place it can find the answer. On 4xx/5xx **only**, we additionally merge a `debug` object into JSON response bodies with the same links plus a recovery hint — a successful response body is the caller's data, not ours to reshape.

Both URLs are built on the project's **portal origin**, learned from the server: every `/v1/request` upload response carries `docsUrl` (origin only, e.g. `https://docs.customer.com` or `https://<slug>.restlessdocs.com`), which the engine caches in-process and the adapters read when building the injection. The SDK never derives it.

There is deliberately **no fallback**. `RESTLESS_BASE_URL` is an upload target: it serves the ingest API, so `<baseUrl>/logs/<id>` 404s. Until the first upload round-trips — a cold start, at most one batch — the SDK emits `x-debug` alone, with no `x-log-url`, no `debug` object and no dig-in line. A caller cannot tell a broken URL from a missing one, and one fetched 404 is enough to teach an agent to stop following the link at all. The same one-batch staleness window applies after a portal-origin change.

## Blocking

Return `block: true | { status?, message? }` from the setup callback to reject a request with a 4xx response. The handler never runs, and `owner.enrich` is not called (see Enrichment above).

For fleet-wide blocking (e.g. revoked keys across a cluster), the `Blocklist` class in `src/lib/blocklist.ts` exposes `has()` / `replace()` and is wired through the engine. The periodic-fetch piece lands when the metrics server exposes an endpoint. The intent is to avoid requiring Redis by serving a small signed snapshot and keeping it in-process.

## Next.js auto-wrap (withRestless)

Three cooperating pieces (`src/adapters/next-plugin.ts`, `next-loader.ts`, and `wrapRouteHandler` in `next.ts`):

1. **`withRestless(nextConfig)`** runs at next.config evaluation. It discovers `restless.config.*` at the project root, detects the active bundler (`TURBOPACK` env → CLI flags → version default; Turbopack is the Next 16 default), and injects the wrapping loader into exactly one of `module.rules` (webpack, `enforce: 'pre'`) or `turbopack.rules` (glob `**/app/**/route.{exts}`, `condition: { not: 'foreign' }` on Next 16+). Only one is patched because Next warns about stray webpack config under Turbopack. Loader options must survive Turbopack's strict serialization — plain values only, no undefined-valued keys.

2. **The loader** replaces each route module's source with a generated facade — the on-disk file is untouched, which is what keeps Next's route type-checking and segment-config static analysis (both read the original file) working. The facade imports the original module through a `?__restless_original__` query-suffixed self-import (same file, distinct module identity; the query doubles as the recursion guard), imports `restless.config` relative to the route file, re-exports detected segment-config exports **concretely** (Next can't handle `export * from` in route modules, and dev mode errors on unexpected `default` exports — so neither is ever emitted), and shadows each detected HTTP-method export with `__restless_wrap(orig.METHOD, config, "METHOD")`. Detection is regex over comment/string-stripped source against the closed legal export surface of a route file. Files the loader can't safely transform (`export *` re-exports) are passed through with a build warning; edge-runtime routes are skipped in v1 because the SDK's settings/env loading is fs-backed.

3. **`wrapRouteHandler`** memoizes one client per config object (the config module evaluates once per server process, so all routes share one uploader queue) and delegates to the same wrap factory as the manual API. The factory marks its output with a non-enumerable `__restlessWrapped` and passes already-marked handlers through, so manual and auto wrapping compose without double capture. It also passes straight through when `NEXT_PHASE === 'phase-production-build'` — build-time prerendering of static routes must not be captured or get headers baked into cached output — and skips body buffering for `text/event-stream` and >1 MB bodies (headers still stamped, log recorded bodyless).

The fixture app in `test/fixtures/next-app` exercises the whole chain against a mock ingress under both bundlers: `npm run test:e2e:next`.

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
- **Non-serializable request body:** the adapters that read an already-parsed body (Fastify `req.body`, Koa `ctx.request.body`) serialize it defensively. `multipart/form-data` bodies are skipped (a stringified parsed multipart body is meaningless), and any body that `JSON.stringify` can't handle - e.g. the circular structures `@fastify/multipart`'s `attachFieldsToBody` produces - is dropped to no recorded body rather than throwing. The Express/Hono/Next/http adapters capture the raw request stream, so they're unaffected.
- **Handler throws:** logged, fingerprinted by throw site, and re-thrown unchanged. See "Where the stack comes from" above; on Express this needs `app.use(restless.errorHandler)`.

The overriding principle: observability never takes down the request path.
