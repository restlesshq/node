import type { RestlessClient, SetupCallback } from "../index.js";
import type { SetupResult } from "../types.js";
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
 */
export function buildDebugInjection(args: {
  status: number;
  requestId: string;
  baseUrl: string;
  prefix?: string;
}): {
  headers: Record<string, string>;
  mutateJsonBody?: (body: unknown) => unknown;
} {
  if (args.status < 400) return { headers: {} };

  const display = formatRequestId(args.requestId, args.prefix);
  const logUrl = `${args.baseUrl}/logs/${args.requestId}`;
  const debugCmd = `npx api debug ${display}`;

  return {
    headers: {
      "x-log-url": logUrl,
      "x-debug": debugCmd,
    },
    mutateJsonBody: (body: unknown) => {
      if (body && typeof body === "object" && !Array.isArray(body)) {
        return {
          ...(body as Record<string, unknown>),
          debug: { log: logUrl, cli: debugCmd },
        };
      }
      return body;
    },
  };
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
