import type { ClientOptions, SetupResult } from "../types.js";
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
import {
  makeAdapterClient,
  type AdapterClient,
} from "../lib/adapterFactory.js";

export { withRestless, type WithRestlessOptions } from "./next-plugin.js";
// Standalone mask for restless.config.ts, where no client instance exists.
export { mask } from "../lib/mask.js";

// The request parameter is intentionally `any` (not `Request`): under
// `strictFunctionTypes`, function parameters are contravariant, so a handler
// typed `(req: NextRequest) => ...` is NOT assignable to `(req: Request) => ...`
// even though NextRequest extends Request. App Router handlers must use
// NextRequest (they read `req.nextUrl`), so a `Request` constraint rejects the
// common case. `any` is a permissive gate that accepts Request, NextRequest,
// and Pages Router handlers alike; `T extends NextHandler` still captures each
// route's real signature (its NextRequest and async `{ params }` context) for
// Next's generated route type-checker. The return is constrained to Response so
// non-handlers are still rejected. `wrap` is identity at runtime.
type NextHandler = (req: any, ...args: any[]) => Response | Promise<Response>;

/**
 * Marker set on every function `wrap` returns. The manual API and the
 * withRestless build-time facade funnel through the same factory, so a
 * handler can end up wrapped twice during migration (manual wrap inside a
 * route file that withRestless also auto-wraps). Marked handlers pass
 * through untouched — one capture per request, whichever wrap runs first.
 */
const WRAP_MARK = "__restlessWrapped";

function isRestlessWrapped(fn: unknown): boolean {
  return (
    typeof fn === "function" &&
    (fn as unknown as Record<string, unknown>)[WRAP_MARK] === true
  );
}

/**
 * Bodies we read for capture: text-like content types only, bounded size,
 * never SSE. Everything else still gets captured (headers stamped, log
 * recorded) — just bodyless:
 *
 * - SSE would make `res.clone().text()` wait until the stream closes
 *   (potentially forever).
 * - Megabyte-plus payloads get truncated by the engine anyway.
 * - Binary / unknown content types can't be represented as text: decoding
 *   them yields garbage in the dashboard, and (for responses) the decoded
 *   string must never be re-served — see the byte-for-byte pass-through in
 *   the wrapper.
 */
const MAX_CAPTURE_BODY_BYTES = 1024 * 1024;
const TEXT_CONTENT_TYPE =
  /json|text\/|xml|x-www-form-urlencoded|javascript|graphql/;

function isCapturableBody(headers: Record<string, string>): boolean {
  const ct = (headers["content-type"] || "").toLowerCase();
  if (!ct) return false; // no declared type: assume bytes, don't decode
  if (ct.includes("text/event-stream")) return false;
  if (!TEXT_CONTENT_TYPE.test(ct)) return false;
  const len = Number(headers["content-length"]);
  return !(Number.isFinite(len) && len > MAX_CAPTURE_BODY_BYTES);
}

function nextWrapFactory(handle: SetupHandle) {
  if (!isSetupHandle(handle)) {
    throw new Error(
      "@restlessai/sdk/next: expected restless.setup(cb). See README.",
    );
  }
  const engine = handle.__restless.engine;
  const opts = engine.uploader.getOptions();

  return function wrap<T extends NextHandler>(handler: T): T {
    if (isRestlessWrapped(handler)) return handler;
    const wrapped = (async (req: Request, ctx?: any) => {
      // `next build` invokes static-eligible GET handlers to prerender their
      // responses. Capturing there would upload synthetic build-time traffic
      // and bake request-id/debug headers into the static output.
      if (process.env.NEXT_PHASE === "phase-production-build") {
        return handler(req, ctx);
      }

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
          opts.hasApiKey,
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
      if (
        req.body &&
        req.method !== "GET" &&
        req.method !== "HEAD" &&
        isCapturableBody(reqHeaders)
      ) {
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
      if (isCapturableBody(resHeaders)) {
        try {
          rawBody = await res.clone().text();
        } catch {
          /* swallow */
        }
      }

      const { fingerprint, recovery } = lookupErrorRecovery(engine, {
        request: { method: req.method, url: req.url, headers: reqHeaders },
        response: {
          status: res.status,
          headers: resHeaders,
          body: rawBody,
        },
      });

      const debug = buildDebugInjection({
        status: res.status,
        requestId: rawId,
        baseUrl: opts.baseUrl,
        prefix: opts.requestIdPrefix,
        recovery,
        fingerprint: fingerprint?.key,
        strategy: fingerprint?.strategy,
        method: req.method,
        // Next doesn't expose a matched route pattern; 404s here fall into the
        // `endpoint` bucket and the dig-in lists available endpoints.
        docsUrl: engine.docsUrl,
      });

      const modified = applyInternalBodyMods(
        rawBody,
        resHeaders["content-type"],
        debug.mutateJsonBody,
      );
      const mutated = modified !== rawBody;

      const finalHeaders = new Headers(res.headers);
      const idHeaders = requestIdResponseHeaders(
        rawId,
        reqHeaders,
        opts.requestIdPrefix,
        opts.hasApiKey,
      );
      for (const [k, v] of Object.entries(idHeaders)) finalHeaders.set(k, v);
      for (const [k, v] of Object.entries(debug.headers))
        finalHeaders.set(k, v);
      // The debug injection enlarged the body; a handler-set content-length
      // would now be wrong and truncate the response at clients. Drop it and
      // let the server recompute.
      if (mutated) finalHeaders.delete("content-length");

      const finalBody = mutated ? modified : rawBody;

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
        errorFingerprint: fingerprint,
      });

      if (mutated) {
        // We rewrote the (JSON) body ourselves — serve the new string.
        // `|| null` because null-body statuses (204/205/304) reject ANY
        // body in the Response constructor, including "".
        return new Response(modified || null, {
          status: res.status,
          headers: finalHeaders,
        });
      }
      // Everything else serves the ORIGINAL body stream, byte-for-byte —
      // capture only ever read a clone. Rebuilding from the decoded text
      // here would corrupt binary and non-UTF-8 responses.
      return new Response(res.body, {
        status: res.status,
        headers: finalHeaders,
      });
    }) as T;
    Object.defineProperty(wrapped, WRAP_MARK, {
      value: true,
      enumerable: false,
    });
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

/**
 * The shape of `restless.config.ts` at the project root — the single-config
 * counterpart to calling `restlessNext(apiKey).setup(cb)` per route. Consumed
 * by the withRestless build-time facade via `wrapRouteHandler`.
 */
export interface RestlessNextConfig {
  /**
   * Per-request identity resolution. Receives the route's web `Request`
   * (a `NextRequest` at runtime). Same contract as `setup(cb)` everywhere
   * else: return `{ apiKey, owner, block }`.
   *
   * Declared as a METHOD on purpose: method parameters are checked
   * bivariantly under `strictFunctionTypes`, so callbacks typed with
   * `NextRequest` (a Request subtype) are accepted — an arrow-function
   * property type would reject them. Same class of issue as the handler
   * typing note above NextHandler.
   */
  setup?(req: Request): SetupResult | Promise<SetupResult>;
  /** Overrides the env chain (RESTLESS_KEY → README_API_KEY → .env walk). */
  apiKey?: string;
  /** Name of the API in `.restless/settings.json`. Required when >1 defined. */
  api?: string;
  /** Extend the redaction denylists (merged with built-in defaults). */
  redact?: ClientOptions["redact"];

  /** @internal — test hook for swapping the fetch implementation. */
  fetch?: typeof fetch;
}

/** Identity helper for `restless.config.ts` — exists for type inference. */
export function defineConfig(config: RestlessNextConfig): RestlessNextConfig {
  return config;
}

// One client per distinct config object. The facade imports restless.config
// as a module (evaluated once per server process), so every auto-wrapped
// route shares the same object → one client, one uploader queue.
const autoWraps = new WeakMap<RestlessNextConfig, NextWrap>();
let zeroConfigWrap: NextWrap | undefined;

function autoWrapFor(config?: RestlessNextConfig): NextWrap {
  const build = () =>
    restlessNext(config?.apiKey, {
      api: config?.api,
      redact: config?.redact,
      fetch: config?.fetch,
    }).setup(config?.setup ?? (() => ({})));
  if (!config) return (zeroConfigWrap ||= build());
  let wrap = autoWraps.get(config);
  if (!wrap) {
    wrap = build();
    autoWraps.set(config, wrap);
  }
  return wrap;
}

/**
 * Runtime half of the withRestless build-time facade: the generated module
 * calls this once per HTTP-method export. Also a public escape hatch for
 * hand-wrapping a single route against a shared config.
 *
 * Non-functions pass through unchanged so the facade can forward whatever
 * the original module exported without inspecting it. `method` is accepted
 * for forward-compatibility (route labeling); it is not used yet.
 */
export function wrapRouteHandler<T extends NextHandler>(
  handler: T,
  config?: RestlessNextConfig,
  method?: string,
): T;
export function wrapRouteHandler(
  handler: undefined,
  config?: RestlessNextConfig,
  method?: string,
): undefined;
export function wrapRouteHandler(
  handler: unknown,
  config?: RestlessNextConfig,
  _method?: string,
): unknown {
  if (typeof handler !== "function") return handler;
  return autoWrapFor(config)(handler as NextHandler);
}

export default Object.assign(restlessNext, { wrap: nextWrapFactory });
