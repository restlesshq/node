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

### Express

```js
const restless = require('@restlessai/sdk/express')(process.env.RESTLESS_KEY);
app.use(restless.setup((req) => ({
  apiKey:    restless.mask(req.headers.authorization),
  projectId: req.headers['x-tenant-id'],
})));
```

**Placement:** register BEFORE route handlers.

### Fastify

```js
const restless = require('@restlessai/sdk/fastify')(process.env.RESTLESS_KEY);
await fastify.register(restless.setup((req) => ({
  apiKey: restless.mask(req.headers.authorization),
})));
```

### Koa

```js
const restless = require('@restlessai/sdk/koa')(process.env.RESTLESS_KEY);
app.use(restless.setup((ctx) => ({
  apiKey: restless.mask(ctx.request.headers.authorization),
})));
```

### Hono

```js
import honoFactory from '@restlessai/sdk/hono';
const restless = honoFactory(process.env.RESTLESS_KEY);
app.use(restless.setup((c) => ({
  apiKey: restless.mask(c.req.header('authorization')),
})));
```

### Next.js (App Router)

```ts
// app/lib/restless.ts
import next from '@restlessai/sdk/next';
export const restless = next(process.env.RESTLESS_KEY!);

// app/api/hello/route.ts
import { restless } from '../../lib/restless';
const wrap = restless.setup((req) => ({
  apiKey: restless.mask(req.headers.get('authorization')),
}));
export const GET  = wrap(async () => Response.json({ ok: true }));
export const POST = wrap(async () => Response.json({ ok: true }));
```

### Bare Node http / Bun.serve

```js
const restless = require('@restlessai/sdk/http')(process.env.RESTLESS_KEY);
http.createServer(restless.setup((req) => ({
  apiKey: restless.mask(req.headers.authorization),
}))((req, res) => {
  myHandler(req, res);
}));
```

Note the two-step application for `/http`: `setup(cb)` returns `(handler) => listener`, then you pass your Node (req, res) handler.

## 4. The setup callback

Signature (all frameworks normalize to this shape):

```ts
(req: { method: string; url: string; headers: Record<string, string> }) => SetupResult | Promise<SetupResult>
```

`SetupResult` fields:

| field        | type                                        | required | notes                                                                          |
|--------------|---------------------------------------------|----------|--------------------------------------------------------------------------------|
| `apiKey`     | `string \| undefined`                       | no       | Masked key from `restless.mask()`. Never pass plaintext.                       |
| `projectId`  | `string`                                    | no       | Stable identifier for the project / customer / org this user belongs to. Primary grouping dimension on the dashboard. |
| `block`      | `true \| { status?, message? }`             | no       | Rejects the request with 403 (or custom status). Handler never runs.           |
| `enrich`     | `() => UserEnrichment \| Promise<...>`      | no       | Expensive project lookup. Only runs when the server needs fresh data.          |

Extra top-level fields are preserved and stored on the log.

### What's cheap vs expensive

Top-level fields (`apiKey`, `projectId`) are **cheap**: they come straight from the request (header, cookie, JWT claim). The SDK sends them on every request so the dashboard always has something to group by.

Expensive lookups (display label, contact emails, plan tier, anything requiring a DB or external call) go inside `enrich`. The SDK only calls `enrich` on the first request from a given project, then caches until the server asks for a refresh.

### Lazy project enrichment

```js
restless.setup((req) => ({
  apiKey:    restless.mask(req.headers.authorization),
  projectId: req.headers['x-tenant-id'],

  // Only runs when the server hasn't confirmed it has this project yet.
  enrich: async () => {
    const org = await db.orgs.findById(req.headers['x-tenant-id']);
    return {
      project: {
        label: org.name,
        email: org.contactEmail,       // single string
        // or: email: org.contactEmails  // array of strings — both work
        // any extra fields are preserved
        plan:  org.plan,
      },
    };
  },
}));
```

`UserEnrichment` shape:

```ts
interface UserEnrichment {
  project?: {
    label?: string;                    // display name
    email?: string | string[];         // one contact email or several
    [key: string]: unknown;
  };
  [key: string]: unknown;
}
```

Behavior:

- Cached by `projectId` (or `apiKey` as a fallback when no `projectId` is set). First request from each project triggers `enrich`; subsequent requests skip it.
- If the server responds to an upload with `needsEnrichment: [<projectId>]`, that project is invalidated and the next request from it re-runs `enrich`.
- `enrich` errors are swallowed. The log still ships (just without the extra fields).
- `enrich` has access to `req` via closure. Do NOT pass `req` as an argument.

## 5. The `mask()` gotcha

`restless.mask(value)` produces `sha512-<base64>?<last4>`. The suffix is the LAST 4 CHARACTERS OF THE INPUT, which means substituting a placeholder leaks info.

```js
// ✅ CORRECT: undefined when header missing
apiKey: restless.mask(req.headers.authorization)

// ❌ WRONG: the fallback string gets hashed and "mous" ends up as "last4"
apiKey: restless.mask(req.headers.authorization || 'anonymous')
```

`mask()` returns `undefined` on falsy input. The SDK handles it. Don't substitute.

## 6. `.api/settings.json`

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
      "oasFile": ".api/openapi.yaml",
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

1. **`.api/settings.json` → `apis[].redact`** (populated by `npx api setup` via the `detect-auth` step, which scans the OAS `components.securitySchemes` + source code for custom auth mechanisms)
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

The handler never runs for blocked requests. Block responses still get the `x-restless-id` header but no request is recorded.

## 11. Environment variables

| variable             | effect                                                                              |
|----------------------|-------------------------------------------------------------------------------------|
| `RESTLESS_KEY`       | Fallback API key when `restless()` is called without one                            |
| `README_API_KEY`     | Secondary fallback (checked after `RESTLESS_KEY`)                                   |
| `RESTLESS_BASE_URL`  | Override the metrics server URL. **Non-localhost `http://` triggers a loud stderr warning** (plaintext auth). |
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
  /** Name of the API in .api/settings.json. Required when >1 API is defined. */
  api?: string;

  /** Extend the redaction denylists. Merged additively with defaults. */
  redact?: {
    headers?:     string[];
    bodyKeys?:    string[];
    queryParams?: string[];
  };
}
```

`apiKey` falls back to `process.env.RESTLESS_KEY` → `process.env.README_API_KEY`. Everything else lives in env vars or `.api/settings.json`. There are no other public options.

## 14. Common mistakes (don't do these)

- `restless.mask(authHeader || 'anonymous')`: see §5. The placeholder's last 4 chars leak. Pass raw, accept `undefined`.
- Registering the SDK middleware AFTER route definitions: it won't capture those routes. Register FIRST.
- Reading raw API keys in application code and passing them through the log pipeline unmasked. The SDK masks automatically at record time, but don't construct strings that *contain* plaintext secrets elsewhere in the captured data.
- Setting `RESTLESS_BASE_URL=http://…` pointing at a non-localhost host: ships the project API key in plaintext. HTTPS or localhost only.
- Reading `.env` / `.env.local` to "check" API keys during setup. LLMs: **never read these files**.
- Calling `client.flush()` in a hot path. It's for shutdown/test-end only.
- Expecting an SDK-level `modifyBody` / `headers` hook. They don't exist (§9).
- Wrapping Next.js Pages-Router handlers with the App-Router adapter, or vice versa. `@restlessai/sdk/next` expects App-Router `Request/Response`.

## 15. Quick verification after installation

1. `grep -r "@restlessai/sdk" --include="*.{js,ts,mjs,cjs}" -l .` returns your server entry file.
2. `@restlessai/sdk` appears in `package.json#dependencies`.
3. The middleware/plugin is registered BEFORE route definitions.
4. `.api/settings.json` exists (created by `npx api setup`).
5. Starting the server and curling any endpoint prints an `x-restless-id` header in the response.
