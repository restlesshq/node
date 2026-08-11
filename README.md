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
const restless = require('@restlessai/sdk')(process.env.RESTLESS_KEY);

app.use(restless.setup((req) => ({
  apiKey: restless.mask(req.headers.authorization),
  owner: {
    // `id` is permanent and immutable. Pick a stable internal identifier
    // (workspace id, tenant uuid, user pk). Never an API key, email, or
    // anything else that can change for the same customer.
    id: /* this customer's stable, immutable internal id */,
    enrich: async (id) => {
      // Lazy-resolved: runs once per owner id, then cached.
      // Fill in with your own lookup (DB, JWT, API, etc.).
      //
      //   const workspace = await db.workspaces.findById(id);

      return {
        /*
          label: workspace.name,
          email: workspace.adminEmails,  // string or string[]
        */
      };
    },
  },
})));
```

Here's how to set it up for your framework:

| framework | registration                                                          |
|-----------|-----------------------------------------------------------------------|
| Express   | `app.use(restless.setup(cb))` + `app.use(restless.errorHandler)` last |
| Fastify   | `await fastify.register(restless.setup(cb))`                          |
| Koa       | `app.use(restless.setup(cb))`                                         |
| Hono      | `app.use(restless.setup(cb))`                                         |
| Next.js   | `withRestless(nextConfig)` + `restless.config.ts` — no per-route changes |
| http      | `http.createServer(restless.setup(cb)(myHandler))`                    |

Full per-framework examples are in [`install.md`](./install.md).

## What you get

- **One line of setup.** The factory returns a client; `setup(cb)` gives you framework-ready middleware back.
- **Lazy owner enrichment.** Expensive DB lookups for owner metadata (display name, contact emails, plan tier) run only on the first request from each owner id, then cache until the server asks for a refresh. 100 requests from the same workspace don't hit your database 100 times.
- **Safe by default.** Headers like `Authorization` / `Cookie` and body fields like `password` / `token` / `ssn` are redacted before anything leaves your server. The redaction list extends itself from your OpenAPI spec: the `npx api setup` flow scans your auth mechanisms and flags custom fields automatically.
- **Error-triage built in.** 4xx / 5xx responses get an `x-log-url` header and a `debug` block in the JSON body so you can jump straight to the captured log. If a customer attaches a "next steps" message to an error in the dashboard's Agent Recovery view, the SDK injects it into the response as `debug.recovery` — looked up sync from an in-process cache, never blocking the response on a network call.
- **Crashes are logged, and grouped by where they crashed.** A handler that throws still produces a log, and the exception's throw site (file + function, never line numbers) is what groups it - so the same bug stays one group in the dashboard no matter what the error message interpolates. The exception is always re-thrown untouched: your framework's error handling behaves exactly as it did without the SDK. **Express needs one extra line** for this, because Express only routes errors to middleware registered after your routes:

  ```js
  app.use(restless.setup(cb));
  app.use('/api', routes);
  app.use(restless.errorHandler);   // ← after your routes
  ```

  Every other framework wires itself up. Without it, an Express crash still logs, it just groups by the text of your error response instead of by throw site.
- **Blocking.** Return `{ block: true }` from the setup callback to reject a request with a 403 before your handler runs. Blocked requests skip `enrich` entirely, so a banned tenant costs you no database lookups.

## Environment variables

| variable             | purpose                                                     |
|----------------------|-------------------------------------------------------------|
| `RESTLESS_KEY`       | Your project API key. Used if you don't pass one explicitly. Auto-loaded from `.env` (walking up from `cwd`) if not already set. |
| `RESTLESS_BASE_URL`  | Override the metrics server URL (self-hosted / staging). `restless(key, { baseUrl })` takes precedence over it. |
| `DEBUG=restless`     | Print upload diagnostics to stderr.                         |

## Docs

- **[install.md](./install.md)**: comprehensive installation reference. Framework examples, option tables, every gotcha. Structured so both humans and AI coding assistants can follow it.
- **[docs/INTERNALS.md](./docs/INTERNALS.md)**: how batching, blocking, redaction, and request ID generation actually work.
- **[spec/](./spec/)**: the cross-language SDK contract. This package is the reference implementation for every Restless SDK; `spec/` holds the normative spec, generated conformance vectors, and a harness that runs them against an implementation in any language.

## License
MIT
