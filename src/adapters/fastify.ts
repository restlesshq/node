import type { ClientOptions } from "../types.js";
import type { ResolvedSetup } from "../lib/capture.js";
import {
  isSetupHandle,
  newRequestId,
  requestIdResponseHeaders,
  buildDebugInjection,
  applyInternalBodyMods,
  resolveBlock,
  type SetupHandle,
} from "./_shared.js";
import { makeAdapterClient, type AdapterClient } from "../lib/adapterFactory.js";

/**
 * Marker Fastify reads on a plugin function: `true` means "skip the
 * encapsulated scope" so hooks registered inside the plugin apply to the
 * parent instance. Without this marker, the SDK's `onRequest`/`onSend`
 * hooks never fire for user-defined routes, which is what `fastify-plugin`
 * fixes for third-party plugins — we inline the one-symbol equivalent here
 * to avoid a runtime dep.
 */
const skipOverride = Symbol.for("skip-override");

/** Raw Fastify plugin — exposed for users who prefer `fastify.register(plugin, handle)`. */
async function restlessFastifyPlugin(fastify: any, handle: SetupHandle) {
  if (!isSetupHandle(handle)) {
    throw new Error(
      "@restlessai/sdk/fastify: expected restless.setup(cb). See README.",
    );
  }
  const engine = handle.__restless.engine;
  const opts = engine.uploader.getOptions();

  fastify.decorateRequest("_restless", null);

  // Why two hooks instead of one:
  //
  // The user's `setup(cb)` reads framework-native request state
  // (`req.user`, `req.session`, custom decorators) that auth middleware
  // attaches. Fastify runs `onRequest` hooks in registration order, so
  // when the SDK plugin is registered before a user `addHook('onRequest',
  // authFn)`, the SDK's `onRequest` fires first and sees `req.user`
  // undefined: every authenticated request lands on the dashboard as
  // anonymous even though the user is fully logged in.
  //
  // Splitting the work fixes that: `onRequest` does the cheap stuff that
  // must happen early (mint request ID, stamp response headers, allocate
  // state), and `preHandler` calls the user's setup callback after every
  // `onRequest` hook has had a chance to populate request state. Blocking
  // still works because `preHandler` runs before the route handler.
  //
  // Edge case: if a user auth hook in `onRequest` throws or sends a
  // response, the route short-circuits and our `preHandler` never runs.
  // `state.setup` stays null and `onSend` records the log as anonymous,
  // which is correct: an auth-rejected request has no owner.

  fastify.addHook("onRequest", async (req: any, reply: any) => {
    const reqHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v) reqHeaders[k] = Array.isArray(v) ? v.join(", ") : String(v);
    }
    const protocol = req.raw.socket?.encrypted ? "https" : "http";
    const host = req.headers.host || "localhost";
    const fullUrl = `${protocol}://${host}${req.raw.url || "/"}`;

    const rawId = newRequestId();
    const idHeaders = requestIdResponseHeaders(
      rawId,
      reqHeaders,
      opts.requestIdPrefix,
      opts.hasApiKey,
    );
    for (const [k, v] of Object.entries(idHeaders)) reply.header(k, v);

    req._restless = {
      setup: null,
      reqHeaders,
      rawId,
      fullUrl,
      startedAt: new Date().toISOString(),
      startTime: Date.now(),
    };
  });

  fastify.addHook("preHandler", async (req: any, reply: any) => {
    const state = req._restless;
    if (!state) return;

    // Pass the native Fastify request through — users can access anything
    // their decorators / onRequest hooks attached (req.user, req.session,
    // etc.).
    const setup = await engine.resolve(req);
    state.setup = setup;

    const blocked = resolveBlock(setup);
    if (blocked) {
      reply
        .code(blocked.status)
        .type("application/json")
        .send({ error: blocked.message });
      return;
    }
  });

  fastify.addHook("onSend", async (req: any, reply: any, payload: any) => {
    const state = req._restless as
      | {
          /**
           * Null when `preHandler` never ran — i.e. an earlier hook (auth,
           * rate limit) short-circuited the request. The log still gets
           * recorded; it just has no apiKey / owner attached, which is
           * correct because no setup callback ever observed this request.
           */
          setup: ResolvedSetup | null;
          reqHeaders: Record<string, string>;
          rawId: string;
          fullUrl: string;
          startedAt: string;
          startTime: number;
        }
      | null;
    if (!state) return payload;
    const setup: ResolvedSetup = state.setup || {};

    const debug = buildDebugInjection({
      status: reply.statusCode,
      requestId: state.rawId,
      baseUrl: opts.baseUrl,
      prefix: opts.requestIdPrefix,
    });
    for (const [k, v] of Object.entries(debug.headers)) reply.header(k, v);

    const resHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(reply.getHeaders())) {
      if (v) resHeaders[k] = Array.isArray(v) ? v.join(", ") : String(v);
    }

    const rawBody = typeof payload === "string" ? payload : undefined;
    const modified = applyInternalBodyMods(
      rawBody,
      resHeaders["content-type"],
      debug.mutateJsonBody,
    );

    const duration = Date.now() - state.startTime;
    const rawPattern = req.routeOptions?.url as string | undefined;
    const routePattern = rawPattern?.replace(/:(\w+)/g, "{$1}");

    engine.record({
      requestId: state.rawId,
      startedAt: state.startedAt,
      routePattern,
      request: {
        method: req.raw.method || "GET",
        url: state.fullUrl,
        headers: state.reqHeaders,
        body:
          typeof req.body === "string"
            ? req.body
            : req.body
            ? JSON.stringify(req.body)
            : undefined,
      },
      response: {
        status: reply.statusCode,
        headers: resHeaders,
        body: modified,
      },
      duration,
      user: {
        apiKey: setup.apiKey,
        project: setup.project,
      },
    });

    return modified ?? payload;
  });
}

type FastifyPlugin = (fastify: any, handle: SetupHandle) => Promise<void>;

/**
 *     const restless = require('@restlessai/sdk/fastify')(process.env.RESTLESS_KEY);
 *     await fastify.register(restless.setup((req) => ({ ... })));
 *
 * `setup(cb)` returns a function you pass straight to `fastify.register`
 * — Fastify's register accepts `(instance, opts) => Promise<void>` with
 * `opts` bound to the setup handle.
 */
function restlessFastify(
  apiKey?: string,
  opts: ClientOptions = {},
): AdapterClient<FastifyPlugin> {
  return makeAdapterClient(apiKey, opts, (handle) => {
    const plugin = (fastify: any) => restlessFastifyPlugin(fastify, handle);
    (plugin as unknown as Record<symbol, unknown>)[skipOverride] = true;
    return plugin;
  });
}

// The raw plugin is also exposed as a property; mark it too so
// `fastify.register(restless.plugin, handle)` works without encapsulation.
(restlessFastifyPlugin as unknown as Record<symbol, unknown>)[skipOverride] = true;

export default Object.assign(restlessFastify, { plugin: restlessFastifyPlugin });
