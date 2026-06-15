import { randomUUID } from "node:crypto";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Generate a new request ID.
 *
 * Uses `crypto.randomUUID()` which produces an RFC 4122 v4 UUID from a
 * CSPRNG. Explicitly NOT time-based (no v1/v7) — request IDs show up in
 * logs and URLs, and we don't want them to leak ordering or timing.
 */
export function newRequestId(): string {
  return randomUUID();
}

/**
 * Short, throwaway correlation token for the recovery dig-in URL
 * (`/p/<token>/<slug>.md`). NOT the request ID and grants no access — it
 * only lets the dashboard correlate "an agent followed up on this error".
 * 8 hex chars from a v4 UUID: ample to avoid collisions within a project's
 * short (~5 min) follow-up window, short enough to read as an id not a payload.
 */
export function newFollowupToken(): string {
  return randomUUID().replace(/-/g, "").slice(0, 8);
}

/**
 * Prepend a decorative prefix to a raw UUID.
 * e.g. ("9f18a0e2-...", "TST") → "TST-9f18a0e2-..."
 */
export function formatRequestId(rawId: string, prefix?: string): string {
  return prefix ? `${prefix}-${rawId}` : rawId;
}

/**
 * Strip a decorative prefix, returning the raw UUID.
 * "TST-9f18a0e2-..." → "9f18a0e2-...". Safe if no prefix is present.
 */
export function stripRequestIdPrefix(requestId: string): string {
  const match = requestId.match(/^[A-Za-z0-9]{1,7}-(.+)$/);
  if (match && UUID_RE.test(match[1]!)) return match[1]!;
  return requestId;
}

export function isValidRequestId(raw: string): boolean {
  return UUID_RE.test(stripRequestIdPrefix(raw));
}
