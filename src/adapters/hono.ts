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
  errorStatus,
  type SetupHandle,
} from "./_shared.js";
import {
  makeAdapterClient,
  type AdapterClient,
} from "../lib/adapterFactory.js";

interface HonoRoute {
  method?: unknown;
  path?: unknown;
  handler?: unknown;
}

/**
 * The endpoint this request was routed to, or undefined when no endpoint
 * matched. Never throws.
 *
 * `c.req.routePath` is the path of whichever handler ran last, so a
 * middleware that answers first (auth's 401, a rate limiter's 429) reports
 * its own pattern: every rejected request under `app.use('/v1/*', auth)`
 * would be logged as `/v1/*`, and so would every unmatched 404 there
 * (RES-20). The router has already matched the whole chain, though, so the
 * endpoint is in `c.req.matchedRoutes` even when it never ran.
 *
 * An endpoint is a route registered for a method (`app.get`), or an
 * `app.all` handler; `app.use` registers middleware as `ALL` too, told
 * apart by arity the way Hono's own route helper does (middleware takes
 * `next`). The route that ran wins when it is an endpoint; otherwise the
 * first endpoint matched, which is the one Hono would have dispatched to.
 * No endpoint means no pattern rather than a middleware's wildcard
 * (CONTRACT.md, "Where the route pattern comes from").
 */
function honoRoutePattern(c: any): string | undefined {
  try {
    const routes: unknown = c.req.matchedRoutes;
    // Not a Hono context we recognize (or a test double): what the
    // framework says ran is the best there is.
    if (!Array.isArray(routes)) {
      const p = c.req.routePath;
      return typeof p === "string" && p !== "" ? p : undefined;
    }
    const isEndpoint = (r: HonoRoute | undefined): boolean =>
      !!r &&
      typeof r.path === "string" &&
      (r.method !== "ALL" ||
        (typeof r.handler === "function" && r.handler.length < 2));
    const ran = routes[c.req.routeIndex] as HonoRoute | undefined;
    const hit = isEndpoint(ran)
      ? ran
      : (routes as HonoRoute[]).find(isEndpoint);
    return hit ? (hit.path as string) : undefined;
  } catch {
    return undefined;
  }
}

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
    const routePattern = honoRoutePattern(c);

    // One decision per request (SAMPLE-032). `c.res` has not been sent yet:
    // Hono serves it after the middleware chain unwinds.
    const outcome = engine.sample(
      req.method,
      routePattern,
      failure ? errorStatus(failure.err) : (c.res as Response).status,
    );

    // Dropped: no log, so no id header pointing at one (SAMPLE-033). On a
    // throw too: Hono's onError copies queued headers onto its response.
    if (outcome === "drop") {
      for (const k of Object.keys(idHeaders)) c.header(k, undefined);
      if (failure) throw failure.err;
      return;
    }

    if (failure) {
      // A throw that made it back to us means nothing downstream (and no
      // app.onError) built a response for it - Hono's own error handling
      // still runs, above us, once we re-throw.
      recordThrown(engine, failure.err, {
        requestId: rawId,
        startedAt,
        duration,
        routePattern,
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
      routePattern,
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
      path: routePattern,
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
      routePattern,
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
      sampled: outcome === "stub",
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
