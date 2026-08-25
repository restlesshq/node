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

    (res as unknown as { write: unknown }).write = function (
      chunk: unknown,
      ...args: unknown[]
    ) {
      if (chunk) resChunks.push(Buffer.from(chunk as Buffer));
      return (origWrite as Function).apply(res, [chunk, ...args]);
    };

    (res as unknown as { end: unknown }).end = function (
      chunk: unknown,
      ...args: unknown[]
    ) {
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
      const rawPattern = (req as unknown as { route?: { path?: string } }).route
        ?.path;
      const routePattern = rawPattern?.replace(/:(\w+)/g, "{$1}");

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
      for (const [k, v] of Object.entries(debug.headers)) res.setHeader(k, v);

      const resHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.getHeaders())) {
        if (v) resHeaders[k] = Array.isArray(v) ? v.join(", ") : String(v);
      }

      const modified = applyInternalBodyMods(
        rawBody,
        resHeaders["content-type"],
        debug.mutateJsonBody,
      );

      // If we rewrote the body, Content-Length was already set to the
      // pre-injection length by res.json()/res.send(). Update it so the
      // client doesn't truncate the stream mid-JSON.
      if (modified !== rawBody && modified !== undefined && !res.headersSent) {
        res.setHeader("content-length", Buffer.byteLength(modified));
      }

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
        });
      }

      const finalChunk = modified !== rawBody ? modified : chunk;
      return (origEnd as Function).apply(res, [finalChunk, ...args]);
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
