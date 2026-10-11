// A request limit per key, kept in this process's memory.
//
// It bounds what one caller can ask of one instance in a window of time. It is
// not shared between instances: with N instances behind a balancer a caller
// can make up to N times the limit. That is enough for its purpose, which is
// to stop one misbehaving credential from occupying an instance, and it is
// said here so nobody mistakes it for an exact quota.

import { createHash } from "node:crypto";

export interface RateLimit {
  /** Requests allowed per key in one window. */
  readonly limit: number;
  readonly windowSeconds: number;
  /** Keys remembered at once. When full, the oldest windows are forgotten first. */
  readonly maxKeys?: number;
}

export interface RateDecision { readonly allowed: boolean; /** Seconds until the window ends, when refused. */ readonly retryAfterSeconds: number }

export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private readonly maxKeys: number;
  constructor(private readonly config: RateLimit, private readonly now: () => number = Date.now) {
    if (!Number.isInteger(config.limit) || config.limit < 1 || !Number.isInteger(config.windowSeconds) || config.windowSeconds < 1) throw new Error("A rate limit needs a whole limit and window of at least 1");
    this.maxKeys = config.maxKeys ?? 20_000;
  }

  /** Counts one request for the key and says whether it is within the limit. */
  check(key: string): RateDecision {
    const now = this.now(); const length = this.config.windowSeconds * 1000;
    let window = this.windows.get(key);
    if (!window || now - window.start >= length) {
      // A fresh window goes to the back of the map, so iteration order is oldest first.
      this.windows.delete(key); window = { start: now, count: 0 }; this.windows.set(key, window);
      if (this.windows.size > this.maxKeys) this.forget(now, length);
    }
    window.count++;
    return window.count <= this.config.limit ? { allowed: true, retryAfterSeconds: 0 } : { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((window.start + length - now) / 1000)) };
  }

  /** Drops windows that are over, then the oldest that are not, until the map is back within its bound. */
  private forget(now: number, length: number): void {
    for (const [key, window] of this.windows) if (now - window.start >= length) this.windows.delete(key);
    for (const key of this.windows.keys()) { if (this.windows.size <= this.maxKeys) break; this.windows.delete(key); }
  }

  /** How many keys are remembered now. For tests and metrics. */
  get size(): number { return this.windows.size; }
}

/**
 * The key a credential is counted under: a digest of what was presented, so the limiter never holds a credential.
 * A request with no credential is counted under the address it came from.
 */
export function credentialKey(authorization: string | null, peerAddress: string): string {
  return authorization ? `credential:${createHash("sha256").update(authorization).digest("hex")}` : `peer:${peerAddress}`;
}
