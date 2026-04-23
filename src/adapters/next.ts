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

type NextHandler = (req: Request, ctx?: any) => Promise<Response> | Response;

function nextWrapFactory(handle: SetupHandle) {
  if (!isSetupHandle(handle)) {
    throw new Error(
      "@restlessai/sdk/next: expected restless.setup(cb). See README.",
    );
  }
  const engine = handle.__restless.engine;
  const opts = engine.uploader.getOptions();

  return function wrap<T extends NextHandler>(handler: T): T {
    const wrapped = (async (req: Request, ctx?: any) => {
      const reqHeaders: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        reqHeaders[k] = v;
      });

      // Pass the native Request through — same as route handlers see.
      const setup = await engine.resolve(req);

      const blocked = resolveBlock(setup);
      if (blocked) {
        const idHeaders = requestIdResponseHeaders(
          newRequestId(),
          reqHeaders,
          opts.requestIdPrefix,
        );
        return new Response(JSON.stringify({ error: blocked.message }), {
          status: blocked.status,
          headers: { "content-type": "application/json", ...idHeaders },
        });
      }

      const rawId = newRequestId();
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

      const res = await handler(req, ctx);
      const duration = Date.now() - startTime;

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

      const debug = buildDebugInjection({
        status: res.status,
        requestId: rawId,
        baseUrl: opts.baseUrl,
        prefix: opts.requestIdPrefix,
      });

      const modified = applyInternalBodyMods(
        rawBody,
        resHeaders["content-type"],
        debug.mutateJsonBody,
      );

      const finalHeaders = new Headers(res.headers);
      const idHeaders = requestIdResponseHeaders(
        rawId,
        reqHeaders,
        opts.requestIdPrefix,
      );
      for (const [k, v] of Object.entries(idHeaders)) finalHeaders.set(k, v);
      for (const [k, v] of Object.entries(debug.headers)) finalHeaders.set(k, v);

      const finalBody = modified !== rawBody ? modified : rawBody;

      engine.record({
        requestId: rawId,
        startedAt,
        request: {
          method: req.method,
          url: req.url,
          headers: reqHeaders,
          body: reqBody,
        },
        response: {
          status: res.status,
          headers: Object.fromEntries(finalHeaders.entries()),
          body: finalBody,
        },
        duration,
        user: {
          apiKey: setup.apiKey,
          project: setup.project,
        },
      });

      return new Response(finalBody, {
        status: res.status,
        headers: finalHeaders,
      });
    }) as T;
    return wrapped;
  };
}

type NextWrap = ReturnType<typeof nextWrapFactory>;

function restlessNext(
  apiKey?: string,
  opts: ClientOptions = {},
): AdapterClient<NextWrap> {
  return makeAdapterClient(apiKey, opts, (handle) => nextWrapFactory(handle));
}

export default Object.assign(restlessNext, { wrap: nextWrapFactory });
