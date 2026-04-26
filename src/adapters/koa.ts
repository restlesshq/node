import type { ClientOptions } from "../types.js";
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

function koaMiddleware(handle: SetupHandle) {
  if (!isSetupHandle(handle)) {
    throw new Error(
      "@restlessai/sdk/koa: expected restless.setup(cb). See README.",
    );
  }
  const engine = handle.__restless.engine;
  const opts = engine.uploader.getOptions();

  return async (ctx: any, next: () => Promise<void>) => {
    const reqHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(ctx.request.headers)) {
      if (v) reqHeaders[k] = Array.isArray(v) ? v.join(", ") : String(v);
    }
    const fullUrl = `${ctx.protocol}://${ctx.host}${ctx.originalUrl || ctx.url}`;

    // Pass the native Koa ctx through — users can access ctx.state,
    // ctx.request.body, etc.
    const setup = await engine.resolve(ctx);

    const blocked = resolveBlock(setup);
    if (blocked) {
      ctx.status = blocked.status;
      ctx.body = { error: blocked.message };
      return;
    }

    const rawId = newRequestId();
    const idHeaders = requestIdResponseHeaders(
      rawId,
      reqHeaders,
      opts.requestIdPrefix,
      opts.hasApiKey,
    );
    for (const [k, v] of Object.entries(idHeaders)) ctx.set(k, v);

    const startedAt = new Date().toISOString();
    const startTime = Date.now();

    await next();

    const debug = buildDebugInjection({
      status: ctx.status,
      requestId: rawId,
      baseUrl: opts.baseUrl,
      prefix: opts.requestIdPrefix,
    });
    for (const [k, v] of Object.entries(debug.headers)) ctx.set(k, v);

    const duration = Date.now() - startTime;
    const resHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(ctx.response.headers)) {
      if (v) resHeaders[k] = Array.isArray(v) ? v.join(", ") : String(v);
    }

    let rawBody: string | undefined;
    if (typeof ctx.body === "string") rawBody = ctx.body;
    else if (ctx.body != null && typeof ctx.body === "object") {
      try {
        rawBody = JSON.stringify(ctx.body);
      } catch {
        rawBody = undefined;
      }
    }

    const modified = applyInternalBodyMods(
      rawBody,
      resHeaders["content-type"] || "application/json",
      debug.mutateJsonBody,
    );

    if (modified && modified !== rawBody) {
      ctx.body = JSON.parse(modified);
    }

    engine.record({
      requestId: rawId,
      startedAt,
      routePattern: (ctx as any)._matchedRoute,
      request: {
        method: ctx.method,
        url: fullUrl,
        headers: reqHeaders,
        body:
          typeof ctx.request.body === "string"
            ? ctx.request.body
            : ctx.request.body
            ? JSON.stringify(ctx.request.body)
            : undefined,
      },
      response: {
        status: ctx.status,
        headers: resHeaders,
        body: modified,
      },
      duration,
      user: {
        apiKey: setup.apiKey,
        project: setup.project,
      },
    });
  };
}

type KoaMiddleware = ReturnType<typeof koaMiddleware>;

function restlessKoa(
  apiKey?: string,
  opts: ClientOptions = {},
): AdapterClient<KoaMiddleware> {
  return makeAdapterClient(apiKey, opts, (handle) => koaMiddleware(handle));
}

export default Object.assign(restlessKoa, { middleware: koaMiddleware });
