import type { ClientOptions, SetupResult } from "../types.js";
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

/** Raw Fastify plugin — exposed for users who prefer `fastify.register(plugin, handle)`. */
export async function restlessFastifyPlugin(fastify: any, handle: SetupHandle) {
  if (!isSetupHandle(handle)) {
    throw new Error(
      "@restlesshq/node/fastify: expected restless.setup(cb). See README.",
    );
  }
  const engine = handle.__restless.engine;
  const opts = engine.uploader.getOptions();

  fastify.decorateRequest("_restless", null);

  fastify.addHook("onRequest", async (req: any, reply: any) => {
    const reqHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v) reqHeaders[k] = Array.isArray(v) ? v.join(", ") : String(v);
    }
    const protocol = req.raw.socket?.encrypted ? "https" : "http";
    const host = req.headers.host || "localhost";
    const fullUrl = `${protocol}://${host}${req.raw.url || "/"}`;

    const setup = await engine.resolve({
      method: req.raw.method || "GET",
      url: fullUrl,
      headers: reqHeaders,
    });

    const blocked = resolveBlock(setup);
    if (blocked) {
      reply
        .code(blocked.status)
        .type("application/json")
        .send({ error: blocked.message });
      return;
    }

    const rawId = newRequestId();
    const idHeaders = requestIdResponseHeaders(
      rawId,
      reqHeaders,
      opts.requestIdPrefix,
    );
    for (const [k, v] of Object.entries(idHeaders)) reply.header(k, v);

    req._restless = {
      setup,
      reqHeaders,
      rawId,
      fullUrl,
      startedAt: new Date().toISOString(),
      startTime: Date.now(),
    };
  });

  fastify.addHook("onSend", async (req: any, reply: any, payload: any) => {
    const state = req._restless as
      | {
          setup: SetupResult;
          reqHeaders: Record<string, string>;
          rawId: string;
          fullUrl: string;
          startedAt: string;
          startTime: number;
        }
      | null;
    if (!state) return payload;

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
        apiKey: state.setup.apiKey,
        email: state.setup.email,
        project: state.setup.project,
      },
    });

    return modified ?? payload;
  });
}

type FastifyPlugin = (fastify: any, handle: SetupHandle) => Promise<void>;

/**
 *     const restless = require('@restlesshq/node/fastify')(process.env.RESTLESS_KEY);
 *     await fastify.register(restless.setup((req) => ({ ... })));
 *
 * `setup(cb)` returns a function you pass straight to `fastify.register`
 * — Fastify's register accepts `(instance, opts) => Promise<void>` with
 * `opts` bound to the setup handle.
 */
export default function restlessFastify(
  apiKey?: string,
  opts: ClientOptions = {},
): AdapterClient<FastifyPlugin> {
  return makeAdapterClient(apiKey, opts, (handle) => {
    return (fastify: any) => restlessFastifyPlugin(fastify, handle);
  });
}
