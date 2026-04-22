/**
 * In-memory set of masked API keys to reject. O(1) lookup, per-process state.
 * Populated by the periodic refresher; consumed by the capture engine when
 * resolving each request.
 */
export class Blocklist {
  private blocked = new Set<string>();

  /** Replace the current set with a new snapshot. Called by the refresher. */
  replace(maskedKeys: Iterable<string>) {
    this.blocked = new Set(maskedKeys);
  }

  /** Check if a (masked) key should be blocked. */
  has(maskedKey: string | undefined): boolean {
    if (!maskedKey) return false;
    return this.blocked.has(maskedKey);
  }

  size(): number {
    return this.blocked.size;
  }
}
