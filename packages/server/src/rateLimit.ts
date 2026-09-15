export interface RateLimitOptions {
  limit: number;
  windowMs: number;
  now?: () => number;
  /** Sweep fully-stale keys once the table grows past this. */
  maxKeys?: number;
}

/**
 * Sliding-window per-key limiter (login endpoints: SRP handshakes are
 * CPU-heavy by design). Small, deterministic, no timers to clean up.
 *
 * A key that is never seen again would otherwise keep its array
 * forever, so once the table passes maxKeys every fully-stale key is
 * swept. Without that, spraying distinct keys is a memory leak dressed
 * up as traffic.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor(options: RateLimitOptions) {
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.now = options.now ?? Date.now;
    this.maxKeys = options.maxKeys ?? 10_000;
  }

  /** Keys currently tracked. Exposed so the sweep can be asserted. */
  get size(): number {
    return this.hits.size;
  }

  private sweep(cutoff: number): void {
    for (const [key, times] of this.hits) {
      if (times.every((t) => t <= cutoff)) this.hits.delete(key);
    }
  }

  /** True when the hit is allowed (and recorded). False when over limit. */
  check(key: string): boolean {
    const now = this.now();
    const cutoff = now - this.windowMs;
    if (this.hits.size > this.maxKeys) this.sweep(cutoff);
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}
