import type { IncomingMessage, ServerResponse } from "node:http";

/** SAFETY-007 capture ceiling for a buffered body. */
const MAX_CAPTURE_BODY_BYTES = 1024 * 1024;
import type { ClientOptions, SetupCallback } from "../types.js";
import { type RestlessClient } from "../index.js";
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
  captureStateOf,
  errorHandler,
  CAPTURE_STATE,
  type CaptureState,
  type SetupHandle,
} from "./_shared.js";
import {
  makeAdapterClient,
  type AdapterClient,
} from "../lib/adapterFactory.js";
import type { SamplingOutcome } from "../lib/sampling.js";

/**
 * The templated route Express matched, mount prefix included, or undefined
 * when there is none to report. Never throws.
 *
 * `req.route.path` is whatever the route was registered with: a string, an
 * array of them, or a RegExp. An array reports the entry this request
 * matched; a RegExp has no template, so it reports none rather than a
 * concrete path (CONTRACT.md, "Where the route pattern comes from").
 *
 * `req.route.path` is relative to the router it was registered on, so the
 * mount path in `req.baseUrl` goes in front. `req.baseUrl` is the matched
 * URL, not the mount pattern: `app.use('/users/:uid', r)` gives
 * `/users/42`. Mount params are templated back from `req.params`, which
 * holds them when the router uses `mergeParams` (as it must to read them).
 */
function expressRoutePattern(req: unknown): string | undefined {
  try {
    const r = req as {
      route?: { path?: unknown };
      baseUrl?: unknown;
      path?: unknown;
      params?: unknown;
    };
    const registered = r.route?.path;
    const route =
      typeof registered === "string"
        ? registered
        : Array.isArray(registered)
          ? registered.find(
              (p): p is string =>
                typeof p === "string" && matchesRoute(p, r.path),
            )
          : undefined;
    if (route === undefined) return undefined;

    const base =
      typeof r.baseUrl === "string" && r.baseUrl !== ""
        ? templateMount(r.baseUrl, r.params, route)
        : "";
    const full = base && route === "/" ? base : base + route;
    return full.replace(/:(\w+)/g, "{$1}");
  } catch {
    return undefined;
  }
}

/**
 * Whether `path` matches a plain route made of literal and `:param`
 * segments, the way Express does by default (case-insensitive, trailing
 * slash optional). Anything fancier (`?`, `*`, `(regex)`) is not matched,
 * so it reports no pattern rather than the wrong one.
 */
function matchesRoute(route: string, path: unknown): boolean {
  if (typeof path !== "string") return false;
  const want = route.replace(/\/+$/, "").split("/");
  const got = path.replace(/\/+$/, "").split("/");
  if (want.length !== got.length) return false;
  return want.every((seg, i) =>
    /^:\w+$/.test(seg)
      ? got[i] !== ""
      : seg.toLowerCase() === got[i].toLowerCase(),
  );
}

/**
 * `/users/42` back to `/users/:uid`, using the params the route was handed.
 * Params the route itself declares are skipped: their values come from the
 * part of the URL after the mount.
 */
function templateMount(baseUrl: string, params: unknown, route: string) {
  if (!params || typeof params !== "object") return baseUrl;
  const own = new Set([...route.matchAll(/:(\w+)/g)].map((m) => m[1]));
  const byValue = new Map<string, string>();
  for (const [name, value] of Object.entries(params)) {
    if (own.has(name) || typeof value !== "string" || value === "") continue;
    if (!byValue.has(value)) byValue.set(value, name);
  }
  if (byValue.size === 0) return baseUrl;
  return baseUrl
    .split("/")
    .map((seg) => {
      let decoded = seg;
      try {
        decoded = decodeURIComponent(seg);
      } catch {
        /* malformed escape: compare it raw */
      }
      const name = byValue.get(decoded);
      return name === undefined ? seg : `:${name}`;
    })
    .join("/");
}

/** The raw middleware — used internally and exposed for advanced wiring. */
function expressMiddleware(handle: SetupHandle) {
  if (!isSetupHandle(handle)) {
    throw new Error(
      "@restlessai/sdk/express: expected restless.setup(cb). See README.",
    );
  }
  const engine = handle.__restless.engine;
  const opts = engine.uploader.getOptions();

  return async (
    req: IncomingMessage,
    res: ServerResponse,
    next: (err?: unknown) => void,
  ) => {
    const reqHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v) reqHeaders[k] = Array.isArray(v) ? v.join(", ") : String(v);
    }

    const protocol = (req.socket as { encrypted?: boolean } | undefined)
      ?.encrypted
      ? "https"
      : "http";
    const host = req.headers.host || "localhost";
    const fullUrl = `${protocol}://${host}${req.url || "/"}`;

    // Reachable from outside this closure (the error middleware below, the
    // bare-http wrapper) via a symbol on `req`. Allocated before the first
    // await so an error raised during setup still has somewhere to land.
    const state: CaptureState = {};
    (req as unknown as Record<symbol, CaptureState>)[CAPTURE_STATE] = state;

    // Body capture, installed BEFORE the first await: with an async setup
    // callback (DB lookup, JWT verification) chunks can arrive during that
    // window, and anything pushed before the patch is invisible to us.
    //
    // We patch `push` - the one funnel every chunk goes through on its way
    // into the readable buffer - rather than subscribing to 'data'.
    // Subscribing would switch the stream into flowing mode and steal the
    // body from a handler that reads it itself, and patching `req.on('data')`
    // (what this used to do) only sees handlers that read via 'data': a
    // `for await (const chunk of req)` loop uses 'readable'/read() and
    // produced a log with no body at all. Copying at `push` is invisible to
    // the handler either way: it receives the exact chunk it would have.
    const reqChunks: Buffer[] = [];
    let reqBytes = 0;
    // SAFETY-007. Past this we stop retaining and record the request
    // bodyless, exactly as the response path does. A 500 MB upload must not
    // be held in memory just to be thrown away by truncation later.
    //
    // Note this is the 1 MiB capture ceiling, NOT the 256 KiB
    // MAX_BODY_BYTES truncation limit, and the gap is deliberate. Redaction
    // runs BEFORE truncation (REDACT-033) and needs syntactically complete
    // JSON to parse: cutting the buffer at 256 KiB would hand redactBody a
    // truncated document, it would fail to parse, and it would pass the
    // fragment through UNREDACTED. Dropping the body entirely is safe;
    // truncating it before redaction is not.
    let reqOverflow = false;
    const origPush = typeof req.push === "function" ? req.push.bind(req) : null;
    if (origPush) {
      (req as unknown as { push: unknown }).push = (
        chunk: unknown,
        encoding?: BufferEncoding,
      ) => {
        if (chunk !== null && chunk !== undefined && !reqOverflow) {
          try {
            const buf =
              typeof chunk === "string"
                ? Buffer.from(chunk, encoding || "utf8")
                : Buffer.from(chunk as Buffer);
            reqBytes += buf.length;
            if (reqBytes > MAX_CAPTURE_BODY_BYTES) {
              reqOverflow = true;
              reqChunks.length = 0;
            } else {
              reqChunks.push(buf);
            }
          } catch {
            /* unrepresentable chunk: capture bodyless, never break the read */
          }
        }
        return origPush(chunk as Buffer, encoding);
      };
    }

    // Pass the native Express req through — users can access
    // req.user, req.session, req.locals, or whatever their auth
    // middleware attached.
    const setup = await engine.resolve(req);

    const blocked = resolveBlock(setup);
    if (blocked) {
      // Nothing downstream will read this body, so stop buffering it.
      if (origPush) (req as unknown as { push: unknown }).push = origPush;
      reqChunks.length = 0;
      res.statusCode = blocked.status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: blocked.message }));
      return;
    }

    // We always mint a fresh ID — never reuse incoming x-request-id.
    const rawId = newRequestId();
    const idHeaders = requestIdResponseHeaders(
      rawId,
      reqHeaders,
      opts.requestIdPrefix,
      opts.hasApiKey,
    );
    for (const [k, v] of Object.entries(idHeaders)) res.setHeader(k, v);

    const startedAt = new Date().toISOString();
    const startTime = Date.now();

    // Express has matched the route by the time anything is written.
    const routeOf = () => expressRoutePattern(req);

    // One sampling decision per request (SAMPLE-032), taken the first time
    // the status is final: in writeHead when the handler streams (res.write
    // and flushHeaders both get there before res.end), otherwise at the top
    // of res.end. The id header was stamped before the handler ran, so a
    // dropped request has to take it back here, while it still can.
    let outcome: SamplingOutcome | undefined;
    const decideOnce = (status: number): SamplingOutcome => {
      if (outcome === undefined) {
        outcome = engine.sample(req.method || "GET", routeOf(), status);
        if (outcome === "drop" && !res.headersSent) {
          for (const k of Object.keys(idHeaders)) res.removeHeader(k);
        }
      }
      return outcome;
    };

    const capturedRequest = () => ({
      method: req.method || "GET",
      url: fullUrl,
      headers: reqHeaders,
      body: reqChunks.length ? Buffer.concat(reqChunks).toString() : undefined,
    });

    // Last resort for a handler that threw without ever responding: nothing
    // will call res.end, so this is the only chance to log the request.
    // Express itself never needs it (its error handler ends the response,
    // which goes through the patched res.end below with state.error set) -
    // bare http, which has no error-handling layer at all, does.
    state.recordThrow = (err: unknown) => {
      if (state.recorded) return;
      state.recorded = true;
      if (decideOnce(errorStatus(err)) === "drop") return;
      recordThrown(engine, err, {
        requestId: rawId,
        startedAt,
        duration: Date.now() - startTime,
        request: capturedRequest(),
        user: { apiKey: setup.apiKey, project: setup.project },
      });
    };

    const resChunks: Buffer[] = [];
    const origWrite = res.write;
    const origEnd = res.end;
    const origWriteHead = res.writeHead;

    (res as unknown as { writeHead: unknown }).writeHead = function (
      statusCode: unknown,
      ...args: unknown[]
    ) {
      try {
        decideOnce(
          typeof statusCode === "number" ? statusCode : res.statusCode,
        );
      } catch {
        /* SAFETY-001: res.end decides again, or logs nothing */
      }
      return (origWriteHead as Function).apply(res, [statusCode, ...args]);
    };

    (res as unknown as { write: unknown }).write = function (
      chunk: unknown,
      ...args: unknown[]
    ) {
      if (chunk) resChunks.push(Buffer.from(chunk as Buffer));
      return (origWrite as Function).apply(res, [chunk, ...args]);
    };

    // Everything the SDK does at res.end, returning the chunk to send in
    // place of the handler's. Kept apart from the patched res.end below so
    // a throw anywhere in here is fenced off from the response.
    const finishCapture = (chunk: unknown): unknown => {
      // Dropped: no log, so no debug headers pointing at one, and the body
      // goes out exactly as the handler wrote it.
      if (decideOnce(res.statusCode) === "drop") {
        state.recorded = true;
        return chunk;
      }

      if (chunk) resChunks.push(Buffer.from(chunk as Buffer));

      const duration = Date.now() - startTime;

      // Snapshot the raw response BEFORE debug headers/body are layered on
      // — fingerprinting runs against the user's actual response.
      const rawBody = resChunks.length
        ? Buffer.concat(resChunks).toString()
        : undefined;
      const preResHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.getHeaders())) {
        if (v) preResHeaders[k] = Array.isArray(v) ? v.join(", ") : String(v);
      }
      const routePattern = routeOf();

      // Set by the exported error middleware when the handler threw and
      // Express routed the error here. Without it a crashing handler
      // fingerprints by the normalized text of whatever error page the app
      // rendered; with it, by throw site.
      const stackTrace = errorStack(state.error);

      // Sync fingerprint + recovery cache lookup. No network on the hot
      // path; a cache miss just means no message injected this time.
      const { fingerprint, recovery } = lookupErrorRecovery(engine, {
        request: {
          method: req.method || "GET",
          url: fullUrl,
          headers: reqHeaders,
        },
        response: {
          status: res.statusCode,
          headers: preResHeaders,
          body: rawBody,
        },
        routePattern,
        stackTrace,
      });

      // Debug headers on every status; the `debug` body object on 4xx/5xx.
      const debug = buildDebugInjection({
        status: res.statusCode,
        requestId: rawId,
        prefix: opts.requestIdPrefix,
        recovery,
        fingerprint: fingerprint?.key,
        strategy: fingerprint?.strategy,
        method: req.method || "GET",
        path: routePattern,
        portalUrl: engine.portalUrl,
      });
      // A handler that called res.write() or res.flushHeaders() has already
      // sent the headers, and part of the body with them. Neither can change
      // now: setHeader would throw out of res.end and leave the response
      // hanging, and a rewritten body would be appended after the bytes
      // already sent. Log the response as it went out instead.
      const streamed = res.headersSent;
      if (!streamed) {
        for (const [k, v] of Object.entries(debug.headers)) res.setHeader(k, v);
      }

      const resHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.getHeaders())) {
        if (v) resHeaders[k] = Array.isArray(v) ? v.join(", ") : String(v);
      }

      const modified = streamed
        ? rawBody
        : applyInternalBodyMods(
            rawBody,
            resHeaders["content-type"],
            debug.mutateJsonBody,
          );

      // Guarded: a handler that both threw and (partially) responded, or
      // that calls res.end twice, must still produce exactly one log.
      if (!state.recorded) {
        state.recorded = true;
        engine.record({
          requestId: rawId,
          startedAt,
          routePattern,
          request: capturedRequest(),
          response: {
            status: res.statusCode,
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
      }

      if (modified === rawBody) return chunk;
      // Content-Length was already set to the pre-injection length by
      // res.json()/res.send(). Update it so the client doesn't truncate the
      // stream mid-JSON. Last, so nothing after it can throw and send the
      // original chunk under the new length.
      if (modified !== undefined && !res.headersSent) {
        res.setHeader("content-length", Buffer.byteLength(modified));
      }
      return modified;
    };

    (res as unknown as { end: unknown }).end = function (
      chunk: unknown,
      ...args: unknown[]
    ) {
      let out = chunk;
      try {
        out = finishCapture(chunk);
      } catch {
        // SAFETY-001: an SDK failure costs the log, never the response.
        state.recorded = true;
      }
      return (origEnd as Function).apply(res, [out, ...args]);
    };

    next();
  };
}

type ExpressMiddleware = ReturnType<typeof expressMiddleware>;

/**
 * One-liner factory:
 *
 *     const restless = require('@restlessai/sdk/express')(process.env.RESTLESS_KEY);
 *     app.use(restless.setup((req) => ({ ... })));
 */
function restlessExpress(
  apiKey?: string,
  opts: ClientOptions = {},
): AdapterClient<ExpressMiddleware> & { errorHandler: typeof errorHandler } {
  return Object.assign(
    makeAdapterClient(apiKey, opts, (handle) => expressMiddleware(handle)),
    { errorHandler },
  );
}

export default Object.assign(restlessExpress, {
  middleware: expressMiddleware,
  errorHandler,
});
