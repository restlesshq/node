import type { ClientOptions } from "../types.js";
import {
  isSetupHandle,
  newRequestId,
  requestIdResponseHeaders,
  buildDebugInjection,
  applyInternalBodyMods,
  lookupErrorRecovery,
  resolveBlock,
  recordThrown,
  errorStack,
  type SetupHandle,
} from "./_shared.js";
import {
  makeAdapterClient,
  type AdapterClient,
} from "../lib/adapterFactory.js";

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

    let failure: { err: unknown } | undefined;
    try {
      await next();
    } catch (err) {
      failure = { err };
    }

    const duration = Date.now() - startTime;

    if (failure) {
      // A throw that made it back to us means nothing downstream (and no
      // app.onError) built a response for it - Hono's own error handling
      // still runs, above us, once we re-throw.
      recordThrown(engine, failure.err, {
        requestId: rawId,
        startedAt,
        duration,
        routePattern: c.req.routePath,
        request: {
          method: req.method,
          url: req.url,
          headers: reqHeaders,
          body: reqBody,
        },
        user: { apiKey: setup.apiKey, project: setup.project },
      });
      throw failure.err;
    }

    // Hono's compose catches a downstream throw itself, routes it to
    // app.onError and stashes the exception on the context - so in that
    // path `await next()` resolves normally and `c.res` is already the
    // error response. Both routes to the same place: the stack, attached
    // to the log below.
    const stackTrace = errorStack(c.error);

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
      stackTrace,
    });

    const debug = buildDebugInjection({
      status: res.status,
      requestId: rawId,
      prefix: opts.requestIdPrefix,
      recovery,
      fingerprint: fingerprint?.key,
      strategy: fingerprint?.strategy,
      method: req.method,
      path: c.req.routePath,
      portalUrl: engine.portalUrl,
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
      stackTrace,
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
