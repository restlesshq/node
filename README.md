# @restlesshq/node

Capture your API traffic and send it to Restless.

Supports **Express**, **Fastify**, **Koa**, **Hono**, **Next.js**, and bare Node `http`. Runs on Node 18+, Bun, and Deno.

## Install

```sh
npm install @restlesshq/node
```

## Quickstart

```js
const restless = require('@restlesshq/node/express')(process.env.RESTLESS_KEY);

app.use(restless.setup((req) => ({
  apiKey: restless.mask(req.headers.authorization),
  email:  req.headers['x-user-email'],
})));
```

Swap `/express` for `/fastify`, `/koa`, `/hono`, `/next`, or `/http` — same call shape everywhere.

## What you get

- **One line of setup.** The factory returns a client; `setup(cb)` gives you framework-ready middleware back.
- **Lazy user enrichment.** Expensive DB lookups for user metadata run only on the first request from each user, then cache until the server requests a refresh. 100 requests from the same user don't hit your database 100 times.
- **Safe by default.** Headers like `Authorization` / `Cookie` and body fields like `password` / `token` / `ssn` are redacted before anything leaves your server. The redaction list extends itself from your OpenAPI spec — the `npx api setup` flow scans your auth mechanisms and flags custom fields automatically.
- **Error-triage built in.** 4xx / 5xx responses get an `x-log-url` header and a `debug` block in the JSON body so you can jump straight to the captured log.
- **Non-sequential request IDs.** Every response gets an `x-restless-id` (v4 UUID, CSPRNG). IDs don't leak ordering or timing.
- **Blocking.** Return `{ block: true }` from the setup callback to reject a request with a 403 before your handler runs.

## Setting up

The easiest path is the interactive CLI, which scans your project, generates an OpenAPI spec, wires the SDK into your server, and flags your custom auth fields for redaction:

```sh
npx api setup
```

If you'd rather set up by hand, everything is documented in [`install.md`](./install.md).

## Environment variables

| variable             | purpose                                                     |
|----------------------|-------------------------------------------------------------|
| `RESTLESS_KEY`       | Your project API key — used if you don't pass one explicitly.    |
| `RESTLESS_BASE_URL`  | Override the metrics server URL (self-hosted / staging).    |
| `DEBUG=restless`     | Print upload diagnostics to stderr.                         |

## Docs

- **[install.md](./install.md)** — comprehensive installation reference: framework examples, option tables, every gotcha. Structured so both humans and AI coding assistants can follow it.
- **[docs/INTERNALS.md](./docs/INTERNALS.md)** — how batching, blocking, redaction, and request ID generation actually work.

## License

ISC
