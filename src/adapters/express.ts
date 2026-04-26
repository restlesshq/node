import type { IncomingMessage, ServerResponse } from "node:http";
import type { ClientOptions, SetupCallback } from "../types.js";
import { type RestlessClient } from "../index.js";
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

    // Pass the native Express req through — users can access
    // req.user, req.session, req.locals, or whatever their auth
    // middleware attached.
    const setup = await engine.resolve(req);

    const blocked = resolveBlock(setup);
    if (blocked) {
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

    const reqChunks: Buffer[] = [];
    const origOn = req.on.bind(req);
    (req as unknown as { on: unknown }).on = (
      event: string,
      listener: (...args: unknown[]) => void,
    ) => {
      if (event === "data") {
        return origOn(event, (chunk: Buffer) => {
          reqChunks.push(Buffer.from(chunk));
          listener(chunk);
        });
      }
      return origOn(event, listener);
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

      // Internal debug injection on 4xx/5xx JSON
      const debug = buildDebugInjection({
        status: res.statusCode,
        requestId: rawId,
        baseUrl: opts.baseUrl,
        prefix: opts.requestIdPrefix,
      });
      for (const [k, v] of Object.entries(debug.headers)) res.setHeader(k, v);

      const resHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.getHeaders())) {
        if (v) resHeaders[k] = Array.isArray(v) ? v.join(", ") : String(v);
      }

      const rawBody = resChunks.length
        ? Buffer.concat(resChunks).toString()
        : undefined;
      const modified = applyInternalBodyMods(
        rawBody,
        resHeaders["content-type"],
        debug.mutateJsonBody,
      );

      const rawPattern = (req as unknown as { route?: { path?: string } }).route
        ?.path;
      const routePattern = rawPattern?.replace(/:(\w+)/g, "{$1}");

      engine.record({
        requestId: rawId,
        startedAt,
        routePattern,
        request: {
          method: req.method || "GET",
          url: fullUrl,
          headers: reqHeaders,
          body: reqChunks.length
            ? Buffer.concat(reqChunks).toString()
            : undefined,
        },
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
      });

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
): AdapterClient<ExpressMiddleware> {
  return makeAdapterClient(apiKey, opts, (handle) => expressMiddleware(handle));
}

export default Object.assign(restlessExpress, { middleware: expressMiddleware });
