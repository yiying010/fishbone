/**
 * A token bucket per key, in process.
 *
 * Written rather than pulled in because the buckets this service needs are not
 * the usual "N requests per minute per route". The classroom sits behind one
 * school NAT, so limiting successful traffic per IP would throttle a whole
 * class; what has to be limited is *failed* room lookups, which is what
 * enumeration looks like and what ordinary use produces almost none of.
 *
 * In process is the right scope for a single container. With several replicas
 * each holds its own budget, so the effective limit multiplies by the replica
 * count; that is noted in docs/deployment.md rather than papered over.
 */

export interface RateLimitDecision {
  allowed: boolean;
  /** How long until at least one token is available again. */
  retryAfterSeconds: number;
  remaining: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export interface RateLimiterOptions {
  /** Burst size, and the steady-state allowance per period. */
  capacity: number;
  /** How long the bucket takes to refill from empty, in milliseconds. */
  refillPeriodMs: number;
  /** Upper bound on tracked keys, so a spray of source addresses cannot grow without limit. */
  maxKeys?: number;
}

export class RateLimiter {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly maxKeys: number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(options: RateLimiterOptions) {
    if (options.capacity <= 0) throw new RangeError("capacity must be positive");
    if (options.refillPeriodMs <= 0) throw new RangeError("refillPeriodMs must be positive");
    this.capacity = options.capacity;
    this.refillPerMs = options.capacity / options.refillPeriodMs;
    this.maxKeys = options.maxKeys ?? 20_000;
  }

  /** Reports the budget without spending any of it. */
  peek(key: string, now: number = Date.now()): RateLimitDecision {
    const tokens = this.refill(key, now).tokens;
    return this.decide(tokens, tokens >= 1);
  }

  /** Spends one token if there is one. */
  take(key: string, now: number = Date.now()): RateLimitDecision {
    const bucket = this.refill(key, now);
    if (bucket.tokens < 1) return this.decide(bucket.tokens, false);
    bucket.tokens -= 1;
    return this.decide(bucket.tokens, true);
  }

  /** Test seam: forget everything. */
  reset(): void {
    this.buckets.clear();
  }

  private decide(tokens: number, allowed: boolean): RateLimitDecision {
    const missing = Math.max(0, 1 - tokens);
    return {
      allowed,
      remaining: Math.floor(Math.max(0, tokens)),
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil(missing / this.refillPerMs / 1000)),
    };
  }

  private refill(key: string, now: number): Bucket {
    const existing = this.buckets.get(key);
    if (existing === undefined) {
      if (this.buckets.size >= this.maxKeys) this.evict(now);
      const created: Bucket = { tokens: this.capacity, updatedAt: now };
      this.buckets.set(key, created);
      return created;
    }
    const elapsed = Math.max(0, now - existing.updatedAt);
    existing.tokens = Math.min(this.capacity, existing.tokens + elapsed * this.refillPerMs);
    existing.updatedAt = now;
    return existing;
  }

  /**
   * Drops keys that have refilled completely: their bucket is indistinguishable
   * from a key that was never seen, so forgetting them changes nothing. If that
   * frees nothing, drop the least recently touched instead.
   */
  private evict(now: number): void {
    for (const [key, bucket] of this.buckets) {
      const elapsed = Math.max(0, now - bucket.updatedAt);
      if (bucket.tokens + elapsed * this.refillPerMs >= this.capacity) this.buckets.delete(key);
    }
    if (this.buckets.size < this.maxKeys) return;

    const byAge = [...this.buckets.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    for (const [key] of byAge.slice(0, Math.ceil(this.maxKeys / 10))) this.buckets.delete(key);
  }
}
