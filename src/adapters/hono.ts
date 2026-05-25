import type { ClientOptions } from "../types.js";
import {
  isSetupHandle,
  newRequestId,
  requestIdResponseHeaders,
  buildDebugInjection,
  applyInternalBodyMods,
  lookupErrorRecovery,
  resolveBlock,
  type SetupHandle,
} from "./_shared.js";
import { makeAdapterClient, type AdapterClient } from "../lib/adapterFactory.js";

function honoMiddleware(handle: SetupHandle) {
  if (!isSetupHandle(handle)) {
    throw new Error(
      "@restlessai/sdk/hono: expected restless.setup(cb). See README.",
    );
  }
  const engine = handle.__restless.engine;
  const opts = engine.uploader.getOptions();

  return async (c: any, next: () => Promise<void>) => {
    const req: Request = c.req.raw;
    const reqHeaders: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      reqHeaders[k] = v;
    });

    // Pass the native Hono Context through — users can access
    // c.get('user'), c.var, c.env, etc.
    const setup = await engine.resolve(c);

    const blocked = resolveBlock(setup);
    if (blocked) {
      return c.json({ error: blocked.message }, blocked.status);
    }

    const rawId = newRequestId();
    const idHeaders = requestIdResponseHeaders(
      rawId,
      reqHeaders,
      opts.requestIdPrefix,
      opts.hasApiKey,
    );
    for (const [k, v] of Object.entries(idHeaders)) c.header(k, v);

    const startedAt = new Date().toISOString();
    const startTime = Date.now();

    let reqBody: string | undefined;
    if (req.body && req.method !== "GET" && req.method !== "HEAD") {
      try {
        reqBody = await req.clone().text();
      } catch {
        /* swallow */
      }
    }

    await next();

    const duration = Date.now() - startTime;
    const res = c.res as Response;

    const resHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      resHeaders[k] = v;
    });

    let rawBody: string | undefined;
    try {
      rawBody = await res.clone().text();
    } catch {
      /* swallow */
    }

    const { fingerprint, recovery } = lookupErrorRecovery(engine, {
      request: { method: req.method, url: req.url, headers: reqHeaders },
      response: {
        status: res.status,
        headers: resHeaders,
        body: rawBody,
      },
      routePattern: c.req.routePath,
    });

    const debug = buildDebugInjection({
      status: res.status,
      requestId: rawId,
      baseUrl: opts.baseUrl,
      prefix: opts.requestIdPrefix,
      recovery,
      docsUrl: engine.docsUrl,
    });
    for (const [k, v] of Object.entries(debug.headers)) c.header(k, v);

    const modified = applyInternalBodyMods(
      rawBody,
      resHeaders["content-type"],
      debug.mutateJsonBody,
    );

    if (modified && modified !== rawBody) {
      c.res = new Response(modified, {
        status: res.status,
        headers: res.headers,
      });
    }

    engine.record({
      requestId: rawId,
      startedAt,
      routePattern: c.req.routePath,
      request: {
        method: req.method,
        url: req.url,
        headers: reqHeaders,
        body: reqBody,
      },
      response: {
        status: res.status,
        headers: resHeaders,
        body: modified,
      },
      duration,
      user: {
        apiKey: setup.apiKey,
        project: setup.project,
      },
      errorFingerprint: fingerprint,
    });
  };
}

type HonoMiddleware = ReturnType<typeof honoMiddleware>;

function restlessHono(
  apiKey?: string,
  opts: ClientOptions = {},
): AdapterClient<HonoMiddleware> {
  return makeAdapterClient(apiKey, opts, (handle) => honoMiddleware(handle));
}

export default Object.assign(restlessHono, { middleware: honoMiddleware });
