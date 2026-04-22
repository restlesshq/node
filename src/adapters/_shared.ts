import type { RestlessClient, SetupCallback } from "../index.js";
import type { SetupResult } from "../types.js";
import { newRequestId, formatRequestId } from "../lib/requestId.js";

/** What `restless.setup(cb)` returns. Adapters accept this shape. */
export interface SetupHandle {
  __restless: RestlessClient;
  __cb: SetupCallback;
}

export function isSetupHandle(x: unknown): x is SetupHandle {
  return (
    !!x &&
    typeof x === "object" &&
    "__restless" in (x as object) &&
    "__cb" in (x as object)
  );
}

export { newRequestId, formatRequestId };

/**
 * Figure out which response headers carry our request ID.
 *
 * Rule: always emit `x-restless-id` (that one is ours). Also emit
 * `x-request-id` IF the incoming request didn't already have one — we don't
 * stomp a user's existing request-id chain.
 *
 * We deliberately do NOT read the incoming `x-request-id` and reuse it as
 * our own ID. Our ID is always freshly generated; that way one UUID unambiguously
 * identifies one log, even if upstream proxies are setting their own IDs.
 */
export function requestIdResponseHeaders(
  ourId: string,
  incomingHeaders: Record<string, string>,
  prefix?: string,
): Record<string, string> {
  const formatted = formatRequestId(ourId, prefix);
  const headers: Record<string, string> = {
    "x-restless-id": formatted,
  };
  if (!incomingHeaders["x-request-id"]) {
    headers["x-request-id"] = formatted;
  }
  return headers;
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
