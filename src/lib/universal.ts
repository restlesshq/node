import type { SetupHandle } from "../adapters/_shared.js";
import restlessExpress from "../adapters/express.js";
import restlessKoa from "../adapters/koa.js";
import restlessHono from "../adapters/hono.js";
import restlessNext from "../adapters/next.js";
import restlessFastify from "../adapters/fastify.js";
import restlessHttp from "../adapters/http.js";

// The adapter defaults attach their raw helpers as properties. Read them
// lazily (not at module-eval time) because index.ts → universal.ts → adapters
// → adapterFactory.ts → index.ts is a cycle, and the default-export binding
// isn't initialized yet when universal.ts runs.
const expressMiddleware = (handle: SetupHandle) =>
  restlessExpress.middleware(handle);
const koaMiddleware = (handle: SetupHandle) => restlessKoa.middleware(handle);
const honoMiddleware = (handle: SetupHandle) => restlessHono.middleware(handle);
const nextWrapFactory = (handle: SetupHandle) => restlessNext.wrap(handle);
const httpBuilderFactory = (handle: SetupHandle) => restlessHttp.builder(handle);
const restlessFastifyPlugin = (fastify: any, handle: SetupHandle) =>
  restlessFastify.plugin(fastify, handle);

/**
 * Is this call `(req, res)` from a Node http server, as opposed to
 * `(request)` / `(request, { params })` from a Next.js route?
 *
 * The two cases are indistinguishable at WRAP time - a dynamic Next route
 * handler is `(req, { params })`, so even arity collides with `(req, res)`
 * - which is why the dispatch happens per call instead. Here the arguments
 * themselves are unambiguous: only a `ServerResponse` has `end` +
 * `setHeader`, and Next's second argument is a plain `{ params }` object.
 */
function isNodeHttpCall(args: unknown[]): boolean {
  const res = args[1] as
    | { end?: unknown; setHeader?: unknown }
    | null
    | undefined;
  return (
    !!args[0] &&
    typeof args[0] === "object" &&
    !!res &&
    typeof res === "object" &&
    typeof res.end === "function" &&
    typeof res.setHeader === "function"
  );
}

/** Does this look like a Node `IncomingMessage` (rather than a Fetch `Request`)? */
function isNodeRequest(x: unknown): boolean {
  const req = x as { headers?: unknown; socket?: unknown } | null | undefined;
  return (
    !!req &&
    typeof req === "object" &&
    !!req.headers &&
    // Fetch `Headers` is iterable-with-forEach; IncomingMessage.headers is a
    // plain object, and it always has a socket behind it.
    typeof (req.headers as { forEach?: unknown }).forEach !== "function" &&
    !!req.socket
  );
}

/**
 * Polymorphic middleware / plugin / wrapper.
 *
 * Dispatches based on the call signature so users don't have to import a
 * framework-specific adapter. Call it from any supported framework and it
 * figures out what to do at the first invocation site.
 *
 * Supported call shapes:
 *   fn(req, res, next)          → Express / Connect / bare Node http
 *   fn(ctx, next)               → Koa (ctx.request / ctx.response)
 *   fn(c, next)                 → Hono (c.req.raw)
 *   fn(fastify, opts, done?)    → Fastify plugin (fastify.addHook)
 *   fn(handler)                 → Next.js App Router / generic HOF wrap
 */
// Marker Fastify reads on a plugin function: `true` means "skip the
// encapsulated scope" so hooks registered inside the plugin apply to the
// parent instance. Without it, the SDK's onRequest/onSend hooks attach to a
// child scope and never fire on the user's routes — the symptom is "logs
// silently never send." Mirrors the same marker on the Fastify-specific
// adapter; harmless for non-Fastify frameworks since they don't read it.
const skipOverride = Symbol.for("skip-override");

export function universalMiddleware(handle: SetupHandle) {
  // Lazily build each adapter the first time it's needed. Keeps startup
  // minimal while still sharing state across requests of the same flavor.
  let express: ReturnType<typeof expressMiddleware> | null = null;
  let koa: ReturnType<typeof koaMiddleware> | null = null;
  let hono: ReturnType<typeof honoMiddleware> | null = null;
  let nextWrap: ReturnType<typeof nextWrapFactory> | null = null;
  let httpBuilder: ReturnType<typeof httpBuilderFactory> | null = null;

  const polymorphic = function polymorphic(...args: unknown[]): unknown {
    const first = args[0];

    // Single-arg, function: a handler being wrapped. TWO frameworks land
    // here and they are not distinguishable yet:
    //   export const GET = restless.setup(cb)(async (req) => ...)   ← Next
    //   http.createServer(restless.setup(cb)(myHandler))            ← http
    // so defer to the first call, where the arguments say which it is.
    // Getting this wrong used to hand an IncomingMessage to the Next
    // adapter: `req.headers.forEach is not a function`, thrown as an
    // unhandled rejection, request hanging with no response.
    if (args.length === 1 && typeof first === "function") {
      return wrapUnknownHandler(first as (...a: any[]) => any);
    }

    // Fastify plugin: first arg has .addHook / .decorateRequest.
    //   await fastify.register(restless.setup(cb))
    if (
      first &&
      typeof first === "object" &&
      typeof (first as { addHook?: unknown }).addHook === "function"
    ) {
      return restlessFastifyPlugin(first, handle);
    }

    // Hono: first arg has c.req.raw (a Fetch API Request).
    //   app.use(restless.setup(cb))
    if (
      first &&
      typeof first === "object" &&
      (first as { req?: { raw?: unknown } }).req?.raw
    ) {
      hono ||= honoMiddleware(handle);
      return hono(first, args[1] as any);
    }

    // Koa: first arg has .request + .response (ctx).
    //   app.use(restless.setup(cb))
    if (
      first &&
      typeof first === "object" &&
      (first as { request?: unknown; response?: unknown }).request &&
      (first as { request?: unknown; response?: unknown }).response
    ) {
      koa ||= koaMiddleware(handle);
      return koa(first, args[1] as any);
    }

    // Express / Connect / http: first arg is a Node IncomingMessage
    // (has .headers + .method + .socket).
    //   app.use(restless.setup(cb))
    if (
      first &&
      typeof first === "object" &&
      (first as { headers?: unknown; method?: unknown }).headers &&
      typeof (first as { method?: unknown }).method === "string"
    ) {
      express ||= expressMiddleware(handle);
      return express(first as any, args[1] as any, args[2] as any);
    }

    throw new Error(
      "@restlessai/sdk: could not detect framework from the call signature. " +
        "If you're using a less-common framework, import the specific adapter (e.g. '@restlessai/sdk/express') and call restless.setup(cb) through it.",
    );
  };

  /**
   * Wrap a handler whose framework isn't known yet, deciding on first call:
   * `(req, res)` means bare Node http, anything else means a Next.js route
   * handler (a Fetch `Request`, optionally with a `{ params }` context).
   *
   * `@restlessai/sdk/http` and `@restlessai/sdk/next` remain the explicit
   * escape hatches, and are what to reach for if a handler is called some
   * other way.
   */
  function wrapUnknownHandler(handler: (...a: any[]) => any) {
    // Already captured (a manual wrap inside a route withRestless also
    // auto-wraps): hand it back untouched, one capture per request.
    if (restlessNext.isWrapped(handler)) return handler;

    let asHttp: ReturnType<NonNullable<typeof httpBuilder>> | null = null;
    let asNext: ((...a: any[]) => any) | null = null;

    // Marked for the same reason: an outer wrap of THIS function must see
    // that the work is already done.
    return restlessNext.mark(function restlessHandler(
      ...callArgs: unknown[]
    ): unknown {
      if (isNodeHttpCall(callArgs)) {
        httpBuilder ||= httpBuilderFactory(handle);
        asHttp ||= httpBuilder(handler as any);
        return asHttp(callArgs[0] as any, callArgs[1] as any);
      }
      // A Node request with no response argument can't be served at all,
      // and the Next adapter would fail deep inside on a header read. Say
      // what's wrong here instead.
      if (isNodeRequest(callArgs[0])) {
        throw new Error(
          "@restlessai/sdk: a Node http handler was called without a response object. " +
            "Pass the listener straight to http.createServer(...), or import the explicit adapter ('@restlessai/sdk/http').",
        );
      }
      nextWrap ||= nextWrapFactory(handle);
      const wrapped = (asNext ||= nextWrap(handler as any));
      return wrapped(...callArgs);
    });
  }
  (polymorphic as unknown as Record<symbol, unknown>)[skipOverride] = true;
  return polymorphic;
}
