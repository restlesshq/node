/**
 * In-memory cache of enriched user metadata, keyed by project id (or
 * masked API key when no id is supplied).
 *
 * The cache exists so we don't hit the user's `enrich()` callback (which
 * may hit their database) on every single request from the same user.
 * The cached VALUES are still merged into every upload, though — that's
 * what lets the metrics server associate every log with the right user
 * without us depending on a server-side join.
 *
 * Invalidation is server-driven: a successful upload response that
 * includes `needsEnrichment: [key...]` drops those keys so the next
 * request from each will re-run enrich. A 1-hour TTL backstops the
 * server in case invalidation messages are lost.
 */

const DEFAULT_TTL_MS = 60 * 60 * 1000;

interface Entry {
  value: Record<string, unknown>;
  ts: number;
}

export class EnrichCache {
  private cache = new Map<string, Entry>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /**
   * Return the cached enriched value if it's still within TTL, else
   * `null`. Entries past TTL are evicted as a side effect.
   */
  get(key: string): Record<string, unknown> | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key: string, value: Record<string, unknown>): void {
    this.cache.set(key, { value, ts: Date.now() });
  }

  /** Drop a key — the next request from it will re-run enrich. */
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
