/**
 * In-memory cache of Agent Recovery messages keyed by error fingerprint.
 *
 * Recovery messages are user-authored "next steps" attached to a fingerprint
 * in the dashboard (Agent Recovery, the /errors page). On every error
 * response, the SDK looks the fingerprint up here SYNCHRONOUSLY and, if
 * present, injects the message into the response body's `debug` object.
 *
 * Performance is the whole point of this file. The lookup is on the hot
 * path of every 4xx/5xx, so:
 *
 *   - All reads are sync, in-process, no I/O.
 *   - We never block the response on a network fetch. A cold miss returns
 *     immediately with no message; the server piggybacks the message onto
 *     the next `/v1/request` upload response, so the SECOND time we see
 *     the same fingerprint we have it cached.
 *   - "No message for this fingerprint" is itself a cacheable answer
 *     (stored as `null`) so a cold miss doesn't keep being a cold miss
 *     every request. The negative TTL is shorter than the positive one
 *     so newly-attached messages start working quickly.
 *
 * Trading correctness for latency on purpose: the first error after a
 * fresh process boot, or for ttlMs after a server invalidation, won't get
 * an injected message. That's the right call for an observability SDK.
 */

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_NEGATIVE_TTL_MS = 5 * 60 * 1000;

interface Entry {
  message: string | null;
  ts: number;
}

export class RecoveryCache {
  private cache = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly negativeTtlMs: number;

  constructor(
    ttlMs: number = DEFAULT_TTL_MS,
    negativeTtlMs: number = DEFAULT_NEGATIVE_TTL_MS,
  ) {
    this.ttlMs = ttlMs;
    this.negativeTtlMs = negativeTtlMs;
  }

  /**
   * Sync lookup. Returns:
   *   - `string` — a recovery message to inject
   *   - `null` — server has confirmed no message for this fingerprint
   *   - `undefined` — never seen, or expired (caller should not inject)
   */
  get(key: string): string | null | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    const age = Date.now() - entry.ts;
    const ttl = entry.message === null ? this.negativeTtlMs : this.ttlMs;
    if (age > ttl) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.message;
  }

  set(key: string, message: string | null): void {
    this.cache.set(key, { message, ts: Date.now() });
  }

  invalidate(key: string): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}
