/**
 * Tracks which masked API keys have had fresh enrichment sent to the server.
 *
 * The metrics server is the source of truth for user metadata. If we've
 * already sent enrichment for a given masked key, the server has it — no
 * point re-running the (potentially expensive) enrichment function on every
 * request from the same user.
 *
 * Invalidation is server-driven: a successful upload response that includes
 * `needsEnrichment: [maskedKey...]` clears those keys, and the next request
 * from each will re-run enrich. A conservative 1-hour TTL backstops the
 * server in case invalidation messages are lost.
 */

const DEFAULT_TTL_MS = 60 * 60 * 1000;

export class EnrichCache {
  private cache = new Map<string, number>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /** Has this key been freshly enriched recently? */
  isFresh(maskedKey: string): boolean {
    const ts = this.cache.get(maskedKey);
    if (ts === undefined) return false;
    if (Date.now() - ts > this.ttlMs) {
      this.cache.delete(maskedKey);
      return false;
    }
    return true;
  }

  /** Record that this key's enrichment has just been sent. */
  markFresh(maskedKey: string): void {
    this.cache.set(maskedKey, Date.now());
  }

  /** Drop a key — the next request from it will re-run enrich. */
  invalidate(maskedKey: string): void {
    this.cache.delete(maskedKey);
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}
