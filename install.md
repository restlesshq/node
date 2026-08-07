# install.md: LLM installation reference for @restlessai/sdk

This file is the single source of truth for LLM agents installing or configuring the Restless SDK. Humans should read `README.md` instead.

The document is ordered so an agent can stop as soon as enough context has been loaded: package basics → setup call → framework adapter → redaction → settings file → common mistakes.

---

## 1. What this package is

`@restlessai/sdk` captures HTTP request/response pairs and ships them in batches to the Restless metrics server for dashboard display.

- **Runtime:** Node 18+, Bun, Deno (the Hono adapter works on Cloudflare Workers too).
- **Shape:** ESM-first with CJS output; both `require()` and `import` work.
- **Frameworks supported (as subpath entry points):** `express`, `fastify`, `koa`, `hono`, `next`, `http`.
- **Zero required framework deps:** the peer deps are optional and only loaded if you use that adapter.

## 2. Install

```sh
npm install @restlessai/sdk
```

(`bun add` / `pnpm add` equivalents work too.) No other packages are required.

## 3. The one-line setup

For every supported framework, the entry point is a **factory that returns a client**:

```js
const restless = require('@restlessai/sdk/express')(process.env.RESTLESS_KEY);
```

The client exposes four things:

| field            | purpose                                                         |
|------------------|-----------------------------------------------------------------|
| `setup(cb)`      | Register per-request callback. Returns framework-ready middleware. |
| `mask(key)`      | Hash an end-user API key for safe logging.                      |
| `flush()`        | Force-upload the current batch (e.g. before `process.exit`).    |
| `client`         | Underlying low-level client (advanced use).                     |

The import is the same for every framework — `@restlessai/sdk` auto-detects the framework at runtime from the call signature. Only the registration pattern differs.

```js
const restless = require('@restlessai/sdk')(process.env.RESTLESS_KEY);
```

All examples below use `req.user.workspaceId` as a placeholder for the customer's stable, immutable internal id. Replace it with whatever your auth middleware attaches: a workspace uuid, tenant id, or user pk. See [§4.1](#the-owner-block) for how to pick.

Owner metadata (display label, contact emails, anything else) flows through `owner.enrich` — that is the only channel for it, and it is required whenever you set an owner. To keep the per-framework snippets short, they share this resolver:

```js
// Runs once per owner id, then caches. Reuse your project's own data access.
const enrichOwner = async (id) => {
  const workspace = await db.workspaces.findById(id);
  return { label: workspace.name, email: workspace.adminEmails };  // string or string[]
};
```

### Express

```js
app.use(restless.setup((req) => ({
  apiKey: restless.mask(req.headers.authorization),
  owner: { id: req.user.workspaceId, enrich: enrichOwner },
})));

// ...your routes...

app.use(restless.errorHandler);   // AFTER routes; see below
```

**Placement:** register the capture middleware BEFORE route handlers, and `restless.errorHandler` AFTER them.

**Why Express needs the second line and no other framework does:** Express routes a downstream `next(err)` to the next ERROR-handling middleware, which is matched by 4-arity signature and by position. The capture middleware has already returned by then, so it cannot see the exception from where it sits. `restless.errorHandler` stashes the error and passes it straight on with `next(err)` - your own error handlers, and Express's built-in one, behave exactly as they did without it. Register it last, after every route and before (or after) your own error handler; it does not send a response.

Skipping it is not fatal: crashes are still logged. They just group by the normalized text of your error response rather than by throw site, so one bug can fan out into several dashboard groups.

### Fastify

```js
await fastify.register(restless.setup((req) => ({
  apiKey: restless.mask(req.headers.authorization),
  owner: req.user ? { id: req.user.workspaceId, enrich: enrichOwner } : undefined,
})));
```

The SDK plugin uses two Fastify hooks: `onRequest` (mints request ID, sets response headers) and `preHandler` (runs the setup callback, handles blocking). Because the setup callback fires in `preHandler`, it runs AFTER every `onRequest` hook, so `req.user` and anything else other `onRequest` hooks attached is visible regardless of whether the SDK plugin is registered before or after auth. If your auth lives in `preHandler` instead of `onRequest`, register it BEFORE the SDK plugin so it runs first.

### Koa

```js
app.use(restless.setup((ctx) => ({
  apiKey: restless.mask(ctx.request.headers.authorization),
  owner: { id: ctx.state.user.workspaceId, enrich: enrichOwner },
})));
```

### Hono

```js
app.use(restless.setup((c) => ({
  apiKey: restless.mask(c.req.header('authorization')),
  owner: { id: c.get('user').workspaceId, enrich: enrichOwner },
})));
```

### Next.js (App Router) — single config, zero route changes

Two files. Route files are NOT touched.

```ts
// next.config.ts (works from .mjs / .js, and object / function / async forms)
import { withRestless } from '@restlessai/sdk/next';

const nextConfig = { /* your existing config */ };
export default withRestless(nextConfig);
```

```ts
// restless.config.ts — project root, next to next.config
import { defineConfig, mask } from '@restlessai/sdk/next';

export default defineConfig({
  setup: async (req) => ({
    apiKey: mask(req.headers.get('authorization')),
    owner: { id: (await getSessionUser(req)).workspaceId },
  }),
});
```

**How it works:** `withRestless` injects a build-time loader (webpack AND Turbopack; the active bundler is detected automatically) that wraps every `app/**/route.ts` HTTP-method export with the capture pipeline. The on-disk files are untouched, so route types, segment config (`dynamic`, `revalidate`, ...) and static analysis all behave exactly as without the SDK. `restless.config.ts` is discovered at the project root (`restless.config.{ts,mts,cts,js,mjs,cjs}`); pass `withRestless(cfg, { configPath })` to point elsewhere.

**Zero-config mode:** `withRestless(nextConfig)` alone (no `restless.config.ts`) captures with `RESTLESS_KEY` from the environment and no owner attribution. Fine for a first look; create the config file before shipping.

**Support matrix:** webpack builds on Next ≥ 13.4; Turbopack builds on Next ≥ 15.3 (older Turbopack setups get a build warning and no capture). Routes with `export const runtime = 'edge'` are skipped with a build warning (current limitation). Prerendered/static routes (`dynamic = 'force-static'`) serve from cache and are not captured; SSE (`text/event-stream`) and >1 MB bodies are captured without the body.

**Scoping capture:** by default every App Router route handler is wrapped. `withRestless(cfg, { include: ['app/api/v1/**'] })` restricts wrapping to an allowlist (the right tool when only a public API subtree should be captured); `exclude: ['app/api/health/**']` skips specific routes and wins over `include` on overlap. Globs are project-root-relative and match with or without a leading `src/`. A `// restless-disable` comment at the top of a route file opts out that single file.

**Manual wrapping (escape hatch / legacy):** the per-route API still works, e.g. for a file the loader punts on (`export *` re-exports). Mixing manual and auto wrapping is safe — a handler is never captured twice.

```ts
// app/api/hello/route.ts — only if you must wrap by hand
import restlessNext from '@restlessai/sdk/next';
const client = restlessNext(process.env.RESTLESS_KEY!);
const wrap = client.setup(async (req) => ({
  apiKey: client.mask(req.headers.get('authorization')),
  owner: { id: (await getSessionUser(req)).workspaceId, enrich: enrichOwner },
}));
export const GET  = wrap(async () => Response.json({ ok: true }));
```

### Bare Node http / Bun.serve

```js
http.createServer(restless.setup((req) => ({
  apiKey: restless.mask(req.headers.authorization),
}))((req, res) => {
  myHandler(req, res);
}));
```

Note the two-step application for `/http`: `setup(cb)` returns `(handler) => listener`, then you pass your Node (req, res) handler.

**How the universal import tells this apart from a Next.js route.** Both are "one function in, one function out", and arity cannot separate them (a dynamic Next route handler is `(req, { params })`, same shape as `(req, res)`). So the SDK decides at the first CALL instead: a `(req, res)` pair where the second argument has `end` + `setHeader` is a Node http listener, anything else is treated as a Next.js route handler. If your handler is invoked some other way, import the explicit adapter - `@restlessai/sdk/http` or `@restlessai/sdk/next` - and skip the detection entirely.

A handler that throws before responding still gets a log here (bare http has no error-handling layer, so nothing else would ever record it). The exception is re-thrown, so the process sees exactly what it saw before.

## 4. The setup callback

Signature (all frameworks normalize to this shape):

```ts
(req: { method: string; url: string; headers: Record<string, string> }) => SetupResult | Promise<SetupResult>
```

`SetupResult` fields:

| field      | type                                         | required | notes                                                                     |
|------------|----------------------------------------------|----------|---------------------------------------------------------------------------|
| `apiKey`   | `string \| undefined`                        | no       | Masked key from `restless.mask()`. Never pass plaintext.                  |
| `owner`    | `OwnerSetup`                                 | yes\*    | The workspace / tenant / end-user this request belongs to. See below.     |
| `block`    | `true \| { status?, message? }`              | no       | Rejects the request with 403 (or custom status). Handler never runs.      |

\* `owner` is technically optional, but omitting it lands every log in the dashboard as "anonymous". Set it unless this API has truly no concept of identity.

Extra top-level fields are preserved and stored on the log.

### The `owner` block

`owner.id` is the **permanent, immutable identifier** the dashboard uses to group every log this customer ever produces. Once set, do not change it: the value gets sent to Restless on every request, and the dashboard pins a project's history to it. Misconfiguring this is the single biggest setup mistake.

**Picking `owner.id`:**

| API shape                                    | Use as `id`                                             |
|----------------------------------------------|---------------------------------------------------------|
| Multi-tenant SaaS (workspaces, orgs, teams)  | The tenant's stable internal id (uuid / pk)             |
| Per-user API (one key per developer)         | The user's stable internal id (uuid / pk)               |
| Anonymous / no identity model                | Omit `owner` entirely; every log lands as anonymous     |

**Never use any of these as `owner.id`:** an API key (rotatable, also a secret), an email address (changeable), a username, a JWT, a placeholder literal like `'anonymous'` / `'none'` / `'guest'`, or any other value that can change for the same customer. If it can rotate or it's a dummy string, it's wrong.

**For requests with no real owner** (no authenticated user, public endpoints, health checks): return `owner: undefined` for that request, or omit the `owner` key entirely. Don't substitute a placeholder string: the SDK has its own anonymous bucket on the wire-format side, and a fake `'anonymous'` id fake-groups every unauthenticated request under one tenant on the dashboard. Example:

```js
return {
  apiKey: restless.mask(extractApiKey(req)),
  owner: req.user ? { id: req.user.workspaceId, enrich: enrichOwner } : undefined,
};
```

```ts
interface OwnerSetup {
  id:      string;  // permanent, immutable (see above)
  // The only channel for owner metadata. Required whenever you set an owner.
  enrich:  (id: string) => OwnerDetails | Promise<OwnerDetails>;
}

interface OwnerDetails {
  label?: string;
  email?: string | string[];
  [key: string]: unknown;  // any extra fields are preserved on the log
}
```

There are no inline `label` / `email` fields (or arbitrary extra keys) on `owner` anymore. Everything except `id` comes back from `enrich`.

### What's cheap vs expensive

Top-level `apiKey` and `owner.id` are **cheap** and included on every request.

`owner.enrich(id)` is **expensive**. The SDK calls it only on the first request from each `owner.id`, then caches until the server asks for a refresh. Its resolved fields are cached and re-attached to every subsequent upload, so each log still carries full owner metadata without re-running the lookup.

### Lazy owner enrichment

```js
restless.setup((req) => ({
  apiKey: restless.mask(req.headers.authorization),

  owner: {
    id: req.user.workspaceId,

    // Only runs when the server hasn't confirmed it has this owner yet.
    // Receives the id as an argument (has access to req via closure too).
    enrich: async (id) => {
      const workspace = await db.workspaces.findById(id);
      return {
        label: workspace.name,
        email: workspace.adminEmails,  // single string OR string[]
        plan:  workspace.plan,         // any extra fields are preserved
      };
    },
  },
}));
```

Behavior:

- Cached by `owner.id`. First request from each owner triggers `enrich`; subsequent requests skip it.
- If the server responds to an upload with `needsEnrichment: [<owner.id>]`, that owner is invalidated and the next request from it re-runs `enrich`.
- `enrich` errors are swallowed. The log still ships with the `owner.id`.
- `enrich` runs only when `owner.id` is set (there's nothing to cache under otherwise).
- `enrich` is skipped entirely when the same setup result also returns `block`. A blocked request never reaches your handler, so paying for a lookup on it would mean a banned tenant costing you one database round-trip per owner id, forever. The `owner.id` still ships.
- The values `enrich` returned are cached and re-attached to every subsequent upload from that owner, so each log carries full owner metadata without re-running the lookup.

## 5. The `mask()` gotcha

`restless.mask(value)` produces `sha512-<base64>?<last4>`. The suffix is the LAST 4 CHARACTERS OF THE INPUT, which means substituting a placeholder leaks info.

```js
// ✅ CORRECT: undefined when header missing
apiKey: restless.mask(req.headers.authorization)

// ❌ WRONG: the fallback string gets hashed and "mous" ends up as "last4"
apiKey: restless.mask(req.headers.authorization || 'anonymous')
```

`mask()` returns `undefined` on falsy input. The SDK handles it. Don't substitute.

## 6. `.restless/settings.json`

The SDK auto-reads this file at startup (walking up from cwd). Created and owned by the `api` CLI (`npx api setup`). Schema:

```json
{
  "version": 1,
  "projectId": "<team/workspace uuid>",
  "apis": [
    {
      "id": "<api uuid>",
      "name": "Public API",
      "rootDir": ".",
      "oasFile": ".restless/openapi.yaml",
      "framework": "express",
      "language": "javascript",
      "baseUrl": "https://api.example.com",
      "internal": false,
      "requestIdPrefix": "PUB",
      "redact": {
        "headers":     ["x-company-auth"],
        "queryParams": ["signed_token"],
        "bodyKeys":    ["ssh_private_key"]
      }
    }
  ]
}
```

What the SDK reads from each `apis[]` entry:

- `requestIdPrefix` → prepended to the UUID in response headers (decorative)
- `redact` → merged with built-in redaction defaults

(Other fields like `id`, `name`, `oasFile`, `framework` are consumed by the `api` CLI during setup, not the SDK at runtime.)

If multiple APIs are defined, pick one with:

```js
restless(process.env.RESTLESS_KEY, { api: 'Public API' });
```

If exactly one is defined, it's used automatically. Zero = no auto-config.

## 7. Redaction (on by default)

Sensitive values are redacted BEFORE anything is sent to the metrics server.

### Built-in denylists (always applied)

- **Headers:** `authorization`, `cookie`, `set-cookie`, `proxy-authorization`, `x-api-key`, `x-auth-token`
- **JSON body keys:** `password`, `pass`, `pwd`, `token`, `secret`, `apikey`, `accesstoken`, `refreshtoken`, `idtoken`, `sessionid`, `ssn`, `creditcard`, `ccnumber`, `cvv`, `cvc`
- **Query params:** same list as body keys

Matching is case-insensitive AND ignores `-`/`_`, so `api_key` / `apiKey` / `API-KEY` / `APIKEY` all match.

### Extending

Two additive sources, both merged with the defaults:

1. **`.restless/settings.json` → `apis[].redact`** (populated by `npx api setup` via the `detect-auth` step, which scans the OAS `components.securitySchemes` + source code for custom auth mechanisms)
2. **`opts.redact`** (per-process, passed at construction):
   ```js
   restless(key, { redact: { headers: ['x-custom'], bodyKeys: ['apiSecret'] } });
   ```

Both lists concat. Defaults are always applied.

### Sentinel format (stable contract)

```
<REDACTED:<length>>                 // when length < 8
<REDACTED:<length>:<last-4-chars>>  // when length ≥ 8
```

Regex: `<REDACTED:(\d+)(?::(.{4}))?>`. The dashboard pattern-matches on this.

### Body size limit

Captured request/response bodies are capped at **256 KB**. Larger bodies are truncated with `[...TRUNCATED: original N bytes]`. No way to raise this without editing the SDK.

## 8. Request IDs

- Always v4 UUIDs from `crypto.randomUUID()`. NOT time-based.
- Every response gets `x-restless-id` (always ours, always fresh).
- `x-request-id` is set ONLY if the caller didn't already send one (we don't stomp an existing request-id chain).
- Incoming `x-request-id` values are NEVER reused as our ID.

## 9. Response modification (SDK-owned, not configurable)

On responses with status **≥ 400**, the SDK injects debug info to make error triage trivial:

- Response headers: `x-log-url: <baseUrl>/logs/<id>`, `x-debug: npx api debug <id>`
- Response body (only when `content-type: application/json`): a `debug: { log, cli }` key merged into the top-level object

There is NO user-configurable `modifyBody` or `headers` hook. Don't look for one; it was intentionally removed from the API.

## 10. Blocking

```js
restless.setup((req) => {
  if (isBanned(req))     return { block: true };                        // 403 Forbidden
  if (rateLimited(req))  return { block: { status: 429, message: 'slow down' } };
  return { apiKey: restless.mask(req.headers.authorization) };
});
```

The handler never runs for blocked requests. Block responses still get the `x-restless-id` header but no request is recorded (except under Fastify, where the response hook still fires and the block is logged). `owner.enrich` is not called for a blocked request - see §4.

## 10a. Uncaught handler errors

A handler that throws produces a log like any other request, and the log is grouped by the exception's throw site (`file` + function name, never line numbers) rather than by the wording of the error your framework rendered. That keeps one bug in one dashboard group even when its message interpolates a different id every time.

The exception is always re-thrown untouched, so your framework's error handling - custom handlers, `app.onError`, `error.tsx`, the framework default - behaves exactly as it did without the SDK.

| framework | wiring needed |
|-----------|----------------|
| Express   | `app.use(restless.errorHandler)` after your routes (see §3). Without it the crash still logs, grouped by message instead. |
| Fastify, Koa, Hono, Next.js, http | none |

Next.js control flow (`redirect()`, `notFound()`, `forbidden()`) is implemented with thrown exceptions; those are re-thrown untouched and are NOT logged as errors.

## 11. Environment variables

| variable             | effect                                                                              |
|----------------------|-------------------------------------------------------------------------------------|
| `RESTLESS_KEY`       | Fallback API key when `restless()` is called without one                            |
| `README_API_KEY`     | Secondary fallback (checked after `RESTLESS_KEY`)                                   |
| `RESTLESS_BASE_URL`  | Override the metrics server URL. Beaten by the `baseUrl` option (§13). **Non-localhost `http://` triggers a loud stderr warning** (plaintext auth). |
| `DEBUG=restless`     | Print upload errors / queue warnings to stderr                                      |

## 12. Batching

Hardcoded behavior, no config:

- Batch size: 10 captured requests
- Flush interval: 5000 ms
- Queue cap: 1000 entries (drops oldest on overflow)
- Localhost base URL: flushes every push (instant dev feedback)

Upload failures are swallowed. With `DEBUG=restless` they log to stderr. Observability never breaks the request path.

## 13. Options reference

`restless(apiKey?: string, opts?: ClientOptions)`

```ts
interface ClientOptions {
  /** Name of the API in .restless/settings.json. Required when >1 API is defined. */
  api?: string;

  /**
   * Ingest origin. Precedence: this option → RESTLESS_BASE_URL →
   * https://ingress.restless.ai. Self-hosted / staging only.
   */
  baseUrl?: string;

  /** Extend the redaction denylists. Merged additively with defaults. */
  redact?: {
    headers?:     string[];
    bodyKeys?:    string[];
    queryParams?: string[];
  };
}
```

`apiKey` falls back to `process.env.RESTLESS_KEY` → `process.env.README_API_KEY`. Everything else lives in env vars or `.restless/settings.json`. There are no other public options.

The client also exposes `restless.errorHandler` - the Express-only error middleware from §3. It is a plain `(err, req, res, next)` function; registering it under any other framework does nothing useful.

## 14. Common mistakes (don't do these)

- `restless.mask(authHeader || 'anonymous')`: see §5. The placeholder's last 4 chars leak. Pass raw, accept `undefined`.
- Registering the SDK middleware AFTER route definitions: it won't capture those routes. Register FIRST. (`restless.errorHandler` is the one exception - it goes LAST, and only on Express.)
- Registering `restless.errorHandler` before your routes. Express matches error middleware by position; ahead of the routes it can never see their errors.
- Reading raw API keys in application code and passing them through the log pipeline unmasked. The SDK masks automatically at record time, but don't construct strings that *contain* plaintext secrets elsewhere in the captured data.
- Setting `RESTLESS_BASE_URL=http://…` pointing at a non-localhost host: ships the project API key in plaintext. HTTPS or localhost only.
- Reading `.env` / `.env.local` to "check" API keys during setup. LLMs: **never read these files**.
- Calling `client.flush()` in a hot path. It's for shutdown/test-end only.
- Expecting an SDK-level `modifyBody` / `headers` hook. They don't exist (§9).
- Wrapping Next.js Pages-Router handlers with the App-Router adapter, or vice versa. `@restlessai/sdk/next` expects App-Router `Request/Response` (and `withRestless` auto-wraps App Router routes only).
- Manually wrapping route handlers in a Next.js app that already uses `withRestless`. Harmless (the double-wrap guard captures once) but redundant — delete the per-route wraps when migrating.
- Putting heavy imports at the top of `restless.config.ts`. The file is bundled into EVERY route's server chunk, and `next build` evaluates route modules while collecting page data — a top-level import of DB-backed code (mongoose clients that throw without env, etc.) breaks builds for routes that never touched the DB. Import auth/DB helpers dynamically inside the callback instead: `const { authenticate } = await import('@/lib/auth')`.
- Testing an unpublished SDK build in a Next app via `npm install <dir>` / `npm link`. The symlink target usually lives outside `turbopack.root`, and Turbopack won't resolve files that escape the root ("module not found" for the SDK). Use `npm pack` and install the tarball instead.

## 15. Quick verification after installation

1. `grep -r "@restlessai/sdk" --include="*.{js,ts,mjs,cjs}" -l .` returns your server entry file.
2. `@restlessai/sdk` appears in `package.json#dependencies`.
3. The middleware/plugin is registered BEFORE route definitions.
4. `.restless/settings.json` exists (created by `npx api setup`).
5. Starting the server and curling any endpoint prints an `x-restless-id` header in the response.
