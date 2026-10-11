import { describe, expect, test } from "bun:test";
import { RateLimiter, credentialKey } from "../index.ts";

describe("the request limiter", () => {
  test("allows the limit in a window, refuses the rest with the time left, and starts again when the window ends", () => {
    let now = 1_000_000; const limiter = new RateLimiter({ limit: 3, windowSeconds: 10 }, () => now);
    expect([1, 2, 3].map(() => limiter.check("a").allowed)).toEqual([true, true, true]);
    expect(limiter.check("a")).toEqual({ allowed: false, retryAfterSeconds: 10 });
    now += 4_500; expect(limiter.check("a")).toEqual({ allowed: false, retryAfterSeconds: 6 });
    // Another key has its own count.
    expect(limiter.check("b")).toEqual({ allowed: true, retryAfterSeconds: 0 });
    // Being refused does not push the window out: it ends when it would have.
    now += 5_499; expect(limiter.check("a").allowed).toBe(false); expect(limiter.check("a").retryAfterSeconds).toBe(1);
    now += 1; expect(limiter.check("a")).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect([1, 2].map(() => limiter.check("a").allowed)).toEqual([true, true]); expect(limiter.check("a").allowed).toBe(false);
  });

  test("remembers a bounded number of keys, forgetting finished windows first and then the oldest", () => {
    let now = 0; const limiter = new RateLimiter({ limit: 1, windowSeconds: 10, maxKeys: 3 }, () => now);
    for (const key of ["a", "b", "c"]) limiter.check(key); expect(limiter.size).toBe(3);
    // Nothing has finished, so the oldest is the one forgotten: "a" may ask again, and "b" and "c" are still held to their window.
    limiter.check("d"); expect(limiter.size).toBe(3);
    expect(limiter.check("b").allowed).toBe(false); expect(limiter.check("c").allowed).toBe(false); expect(limiter.check("d").allowed).toBe(false);
    // When windows have finished they are what goes.
    now = 10_000; limiter.check("e"); expect(limiter.size).toBe(1); expect(limiter.check("e").allowed).toBe(false);
    // A flood of distinct keys never grows the map past its bound.
    for (let index = 0; index < 1000; index++) limiter.check(`flood-${index}`); expect(limiter.size).toBe(3);
  });

  test("a limit that is not a positive whole number is a configuration error", () => {
    for (const config of [{ limit: 0, windowSeconds: 1 }, { limit: 1.5, windowSeconds: 1 }, { limit: 1, windowSeconds: 0 }, { limit: -1, windowSeconds: 60 }, { limit: Number.NaN, windowSeconds: 60 }]) expect(() => new RateLimiter(config)).toThrow();
  });

  test("a credential is counted under a digest of itself, and a request without one under its address", () => {
    const token = "Bearer wc_" + "A".repeat(43); const key = credentialKey(token, "203.0.113.9");
    expect(key).toMatch(/^credential:[0-9a-f]{64}$/); expect(key).not.toContain("wc_"); expect(credentialKey(token, "198.51.100.1")).toBe(key);
    expect(credentialKey("Bearer wc_" + "B".repeat(43), "203.0.113.9")).not.toBe(key);
    expect(credentialKey(null, "203.0.113.9")).toBe("peer:203.0.113.9"); expect(credentialKey("", "203.0.113.9")).toBe("peer:203.0.113.9");
  });
});
