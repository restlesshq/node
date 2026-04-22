# @restlessai/sdk

Capture your API traffic and send it to [Restless](https://restless.ai).

Supports **Express**, **Fastify**, **Koa**, **Hono**, **Next.js**, and bare Node `http`. Runs on Node 18+, Bun, and Deno.

## Install

```sh
npx api setup
```

This scans your project, figures out your framework, generates an OpenAPI spec, wires the SDK into your server, and flags your custom auth fields for redaction.

## Manual installation

If you'd rather wire it up by hand:

```sh
npm install @restlessai/sdk
```

```js
// Express / Koa / Hono — middleware pattern
const restless = require('@restlessai/sdk/express')(process.env.RESTLESS_KEY);

app.use(restless.setup((req) => ({
  apiKey: restless.mask(req.headers.authorization),
})));
```

**Other frameworks** follow the same `restless.setup(cb)` pattern but register differently:

| framework | registration                                                          |
|-----------|-----------------------------------------------------------------------|
| Express   | `app.use(restless.setup(cb))`                                         |
| Fastify   | `await fastify.register(restless.setup(cb))`                          |
| Koa       | `app.use(restless.setup(cb))`                                         |
| Hono      | `app.use(restless.setup(cb))`                                         |
| Next.js   | `export const GET = restless.setup(cb)(async (req) => { ... })`       |
| http      | `http.createServer(restless.setup(cb)(myHandler))`                    |

Full per-framework examples and the `enrich` callback (for DB-backed user info) are in [`install.md`](./install.md).

## What you get

- **One line of setup.** The factory returns a client; `setup(cb)` gives you framework-ready middleware back.
- **Lazy user enrichment.** Expensive DB lookups for user metadata run only on the first request from each user, then cache until the server requests a refresh. 100 requests from the same user don't hit your database 100 times.
- **Safe by default.** Headers like `Authorization` / `Cookie` and body fields like `password` / `token` / `ssn` are redacted before anything leaves your server. The redaction list extends itself from your OpenAPI spec: the `npx api setup` flow scans your auth mechanisms and flags custom fields automatically.
- **Error-triage built in.** 4xx / 5xx responses get an `x-log-url` header and a `debug` block in the JSON body so you can jump straight to the captured log.
- **Blocking.** Return `{ block: true }` from the setup callback to reject a request with a 403 before your handler runs.

## Environment variables

| variable             | purpose                                                     |
|----------------------|-------------------------------------------------------------|
| `RESTLESS_KEY`       | Your project API key. Used if you don't pass one explicitly.     |
| `RESTLESS_BASE_URL`  | Override the metrics server URL (self-hosted / staging).    |
| `DEBUG=restless`     | Print upload diagnostics to stderr.                         |

## Docs

- **[install.md](./install.md)**: comprehensive installation reference. Framework examples, option tables, every gotcha. Structured so both humans and AI coding assistants can follow it.
- **[docs/INTERNALS.md](./docs/INTERNALS.md)**: how batching, blocking, redaction, and request ID generation actually work.

## License

ISC
