import type { SetupHandle } from "../adapters/_shared.js";
import restlessExpress from "../adapters/express.js";
import restlessKoa from "../adapters/koa.js";
import restlessHono from "../adapters/hono.js";
import restlessNext from "../adapters/next.js";
import restlessFastify from "../adapters/fastify.js";

// The adapter defaults attach their raw helpers as properties. Read them
// lazily (not at module-eval time) because index.ts → universal.ts → adapters
// → adapterFactory.ts → index.ts is a cycle, and the default-export binding
// isn't initialized yet when universal.ts runs.
const expressMiddleware = (handle: SetupHandle) =>
  restlessExpress.middleware(handle);
const koaMiddleware = (handle: SetupHandle) => restlessKoa.middleware(handle);
const honoMiddleware = (handle: SetupHandle) => restlessHono.middleware(handle);
const nextWrapFactory = (handle: SetupHandle) => restlessNext.wrap(handle);
const restlessFastifyPlugin = (fastify: any, handle: SetupHandle) =>
  restlessFastify.plugin(fastify, handle);

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
export function universalMiddleware(handle: SetupHandle) {
  // Lazily build each adapter the first time it's needed. Keeps startup
  // minimal while still sharing state across requests of the same flavor.
  let express: ReturnType<typeof expressMiddleware> | null = null;
  let koa: ReturnType<typeof koaMiddleware> | null = null;
  let hono: ReturnType<typeof honoMiddleware> | null = null;
  let nextWrap: ReturnType<typeof nextWrapFactory> | null = null;

  return function polymorphic(...args: unknown[]): unknown {
    const first = args[0];

    // Single-arg, function: Next.js route handler or generic HOF wrap.
    //   export const GET = restless.setup(cb)(async (req) => ...)
    if (args.length === 1 && typeof first === "function") {
      nextWrap ||= nextWrapFactory(handle);
      return nextWrap(first as any);
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
}
