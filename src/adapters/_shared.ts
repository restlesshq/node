import type { RestlessClient, SetupCallback } from "../index.js";
import type { SetupResult, CapturedRequest } from "../types.js";
import type { CaptureEngine } from "../lib/capture.js";
import type { Fingerprint } from "../lib/fingerprint.js";
import { newRequestId, formatRequestId } from "../lib/requestId.js";

/** What `restless.setup(cb)` returns. Adapters accept this shape. */
export interface SetupHandle {
  __restless: RestlessClient;
  __cb: SetupCallback;
}

export function isSetupHandle(x: unknown): x is SetupHandle {
  // Accept both plain objects and functions (the universal middleware returned
  // from `client.setup()` is a function with handle props attached).
  return (
    !!x &&
    (typeof x === "object" || typeof x === "function") &&
    "__restless" in (x as object) &&
    "__cb" in (x as object)
  );
}

export { newRequestId, formatRequestId };

/**
 * Figure out which response header carries our request ID.
 *
 * Rule: emit `x-request-id` (the standard header everyone knows) carrying
 * our freshly-generated ID. If the incoming request already has an
 * `x-request-id` — set by a client, reverse proxy, or upstream middleware
 * — we don't want to clobber that chain, so we fall back to our own
 * `x-restless-id` header instead. Exactly one of the two is emitted per
 * response.
 *
 * We deliberately do NOT read the incoming `x-request-id` and reuse its
 * value as our own ID. Our ID is always freshly generated so one UUID
 * unambiguously identifies one log, even when upstream proxies set their
 * own IDs under the same name.
 *
 * Setup-time signal: when the SDK has no API key resolved (env var was
 * never set), we emit the literal string `missing-key` as the header
 * value instead of a UUID. The CLI's setup flow keys off this so it can
 * tell the user "your server is running but RESTLESS_KEY isn't loaded —
 * restart it" instead of letting them stare at a request that silently
 * dropped before upload.
 */
export function requestIdResponseHeaders(
  ourId: string,
  incomingHeaders: Record<string, string>,
  prefix?: string,
  hasApiKey: boolean = true,
): Record<string, string> {
  const value = hasApiKey ? formatRequestId(ourId, prefix) : "missing-key";
  const headerName = incomingHeaders["x-request-id"]
    ? "x-restless-id"
    : "x-request-id";
  return { [headerName]: value };
}

/**
 * Inject SDK-owned debug info into a response body. Only runs when the
 * status is >= 400 AND the body is JSON.
 *
 * On errors we also add `x-log-url` and `x-debug` response headers —
 * returned from this helper so the adapter can set them.
 *
 * `recovery`, when present, is a customer-authored "next steps" message
 * attached to this error's fingerprint via Agent Recovery (/errors).
 * It's looked up sync from the SDK's in-process cache; the lookup never
 * waits on the network.
 */
export function buildDebugInjection(args: {
  status: number;
  requestId: string;
  baseUrl: string;
  prefix?: string;
  recovery?: string;
  /** Error fingerprint key (e.g. "404:resource") + strategy, and the
   *  request's method + templated route. Encoded into the per-request
   *  "dig-in" URL so the calling agent can fetch deterministic next steps. */
  fingerprint?: string;
  strategy?: string;
  method?: string;
  path?: string;
  /**
   * Origin to use for the customer-facing log link, learned from the
   * metrics server's response to a prior upload. Origin only
   * (`https://docs.customer.com`); the helper appends `/logs/<id>`.
   *
   * Falls back to `baseUrl` when the SDK hasn't round-tripped a
   * batch yet (cold start) or the server doesn't yet return the
   * field. The result is still well-formed, just not customer-branded
   * until the next batch refreshes the cache.
   */
  docsUrl?: string;
}): {
  headers: Record<string, string>;
  mutateJsonBody?: (body: unknown) => unknown;
} {
  if (args.status < 400) return { headers: {} };

  const display = formatRequestId(args.requestId, args.prefix);
  const logHost = args.docsUrl || args.baseUrl;
  const logUrl = `${logHost}/logs/${args.requestId}`;
  const debugCmd = `npx api debug ${display}`;

  // Per-request "dig-in" URL the calling agent (often an AI) can fetch for
  // concrete next steps. Deliberately LEGIBLE - it ends in `<slug>.md` (the
  // endpoint the agent called) so it reads as documentation, not a tracking
  // blob (an opaque token in the tail kills trust / fetch-through). The first
  // segment is the request id - the SAME public id already in `debug.log` - so
  // the dashboard can correlate the follow-up back to this request (did the
  // agent then recover?) without any new tracking token. It grants no access:
  // content is resolved from the slug + public OAS. Appended INTO `recovery` so
  // the agent treats it as a next step, on every error.
  const slug = recoverySlug(args.method, args.path);
  const digInUrl = `${logHost}/p/${args.requestId}/${slug}.md`;
  const digInLine = `For the accepted parameters and next steps, fetch ${digInUrl}`;
  const recovery = args.recovery
    ? `${args.recovery}\n\n${digInLine}`
    : digInLine;

  return {
    headers: {
      "x-log-url": logUrl,
      "x-debug": debugCmd,
    },
    mutateJsonBody: (body: unknown) => {
      if (body && typeof body === "object" && !Array.isArray(body)) {
        const debug: Record<string, unknown> = {
          log: logUrl,
          cli: debugCmd,
          recovery,
        };
        return {
          ...(body as Record<string, unknown>),
          debug,
        };
      }
      return body;
    },
  };
}

/**
 * Legible URL slug for the recovery dig-in path, derived from method + route
 * pattern: `GET /car/{id}` -> `get-car-id`. The server resolves it back to the
 * operation by matching the same scheme against its OpenAPI endpoints, so this
 * MUST stay in sync with `recoverySlug` in the app's `recovery` route. Empty /
 * unmatched route (e.g. Next, or a 404 on no route) -> `unknown`, which the
 * server renders as "not a documented endpoint".
 */
export function recoverySlug(method?: string, path?: string): string {
  const m = (method || "").toLowerCase();
  const p = (path || "").trim();
  if (!m || !p) return "unknown";
  const flat = p
    .replace(/[/{}:]+/g, "-")
    .replace(/[^a-zA-Z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return flat ? `${m}-${flat}` : m;
}

/**
 * Apply the SDK's internal response-body modifications. Currently this is
 * only the debug object injection on 4xx/5xx JSON responses.
 */
export function applyInternalBodyMods(
  body: string | undefined,
  contentType: string | undefined,
  mutate: ((body: unknown) => unknown) | undefined,
): string | undefined {
  if (!body || !mutate) return body;
  if (!(contentType || "").toLowerCase().includes("application/json"))
    return body;
  try {
    const parsed = JSON.parse(body);
    return JSON.stringify(mutate(parsed));
  } catch {
    return body;
  }
}

/**
 * Compute the error fingerprint for a response (if any) and look up a
 * cached Agent Recovery message for it. Hot-path safe: both calls are
 * sync, no I/O. Adapters call this just before assembling the debug
 * injection so they can:
 *
 *   1. Inject the recovery message into the response body (when cached).
 *   2. Hand the precomputed fingerprint back to `engine.record()` so it
 *      doesn't repeat the work on the upload path.
 */
export function lookupErrorRecovery(
  engine: CaptureEngine,
  captured: Pick<
    CapturedRequest,
    "request" | "response" | "routePattern" | "stackTrace"
  >,
): { fingerprint?: Fingerprint; recovery?: string } {
  if (captured.response.status < 400) return {};
  const fingerprint = engine.computeFingerprint(captured as CapturedRequest);
  if (!fingerprint) return {};
  const recovery = engine.lookupRecovery(fingerprint.key);
  return { fingerprint, recovery };
}

/**
 * v8 stack of whatever a handler threw, or `undefined` when there isn't one
 * (a thrown string / plain object, or an Error with `stack` stripped). The
 * stack is what makes the `stack` fingerprint strategy reachable: two
 * different crashes on the same route group separately by throw site
 * instead of collapsing into one normalized-message bucket.
 */
export function errorStack(err: unknown): string | undefined {
  const stack = (err as { stack?: unknown } | null | undefined)?.stack;
  return typeof stack === "string" && stack ? stack : undefined;
}

/**
 * Status the framework will end up sending for a thrown error. `http-errors`
 * (Express, Koa) and Hono's `HTTPException` both carry one; anything else is
 * an unhandled crash, i.e. a 500.
 */
export function errorStatus(err: unknown): number {
  const e = err as { status?: unknown; statusCode?: unknown } | null | undefined;
  const raw = typeof e?.status === "number" ? e.status : e?.statusCode;
  return typeof raw === "number" && raw >= 400 && raw <= 599 ? raw : 500;
}

/**
 * Record a log for a request whose handler threw before any response was
 * captured. The framework owns the response from here, so there is no body
 * to fingerprint or inject into - but an uncaught exception is precisely
 * the request an operator needs a log for, and it is the one case where the
 * `stack` strategy fires.
 *
 * Swallows its own failures: an error raised in here would replace the
 * customer's exception with ours (SAFETY-001). Callers re-throw the
 * original, untouched.
 */
export function recordThrown(
  engine: CaptureEngine,
  err: unknown,
  base: {
    requestId: string;
    startedAt: string;
    duration: number;
    routePattern?: string;
    request: CapturedRequest["request"];
    response?: Partial<CapturedRequest["response"]>;
    user?: CapturedRequest["user"];
  },
): void {
  try {
    engine.record({
      requestId: base.requestId,
      startedAt: base.startedAt,
      routePattern: base.routePattern,
      request: base.request,
      response: {
        status: base.response?.status ?? errorStatus(err),
        headers: base.response?.headers ?? {},
        body: base.response?.body,
      },
      duration: base.duration,
      user: base.user,
      stackTrace: errorStack(err),
    });
  } catch {
    /* observability never breaks the request path */
  }
}

/**
 * Key for the per-request capture state the Node-stream adapters (Express,
 * bare http) hang off `req`, so code outside the middleware closure - the
 * error middleware, the http handler wrapper - can reach it.
 *
 * `Symbol.for` on purpose: the package ships ESM and CJS builds, and a
 * process can load both. A unique symbol per module instance would make the
 * error middleware from one build invisible to the middleware from the
 * other.
 */
export const CAPTURE_STATE = Symbol.for("@restlessai/sdk.captureState");

/** Per-request state shared between the middleware and out-of-band hooks. */
export interface CaptureState {
  /** Error thrown downstream, stashed for the response-side capture. */
  error?: unknown;
  /** Set once the log has shipped, so the two paths can't double-record. */
  recorded?: boolean;
  /**
   * Ship a log for a request whose handler threw and never responded.
   * Assigned by the middleware once it has the request context; absent
   * until then (a throw that early is the framework's, not the handler's).
   */
  recordThrow?: (err: unknown) => void;
}

/** Capture state for a Node request, if a Restless middleware is installed. */
export function captureStateOf(req: unknown): CaptureState | undefined {
  return (req as Record<symbol, CaptureState | undefined> | null | undefined)?.[
    CAPTURE_STATE
  ];
}

/**
 * Resolve the block config into a concrete response spec. Takes only the
 * `block` field so it accepts both the raw `SetupResult` and the resolved
 * setup the engine returns (whose `project` is already enriched, not an
 * `OwnerSetup`, so the full `SetupResult` shape no longer matches).
 */
export function resolveBlock(
  setup: Pick<SetupResult, "block">,
): { status: number; message: string } | null {
  if (!setup.block) return null;
  if (setup.block === true) return { status: 403, message: "Forbidden" };
  return {
    status: setup.block.status ?? 403,
    message: setup.block.message ?? "Forbidden",
  };
}
