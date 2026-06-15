import type { RestlessClient, SetupCallback } from "../index.js";
import type { SetupResult, CapturedRequest } from "../types.js";
import type { CaptureEngine } from "../lib/capture.js";
import type { Fingerprint } from "../lib/fingerprint.js";
import {
  newRequestId,
  formatRequestId,
  newFollowupToken,
} from "../lib/requestId.js";

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
  // blob (an opaque token in the tail kills trust / fetch-through). The
  // `<followupToken>` is a short, throwaway correlation handle (NOT the request
  // id, grants no access); the server maps it back to the request for the
  // dashboard. Content is resolved from the slug, so the URL works even if the
  // token is unknown/expired. Appended INTO `recovery` so the agent treats it
  // as a next step, on every error - even ones with no authored hint.
  const slug = recoverySlug(args.method, args.path);
  const followupToken = newFollowupToken();
  const digInUrl = `${logHost}/p/${followupToken}/${slug}.md`;
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
  captured: Pick<CapturedRequest, "request" | "response" | "routePattern">,
): { fingerprint?: Fingerprint; recovery?: string } {
  if (captured.response.status < 400) return {};
  const fingerprint = engine.computeFingerprint(captured as CapturedRequest);
  if (!fingerprint) return {};
  const recovery = engine.lookupRecovery(fingerprint.key);
  return { fingerprint, recovery };
}

/** Resolve the block config into a concrete response spec. */
export function resolveBlock(
  setup: SetupResult,
): { status: number; message: string } | null {
  if (!setup.block) return null;
  if (setup.block === true) return { status: 403, message: "Forbidden" };
  return {
    status: setup.block.status ?? 403,
    message: setup.block.message ?? "Forbidden",
  };
}
