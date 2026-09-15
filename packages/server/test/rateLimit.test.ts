import { describe, expect, test } from "bun:test";
import { RateLimiter } from "../src/rateLimit.js";

describe("RateLimiter", () => {
  test("allows up to the limit, then blocks", () => {
    let now = 0;
    const limiter = new RateLimiter({ limit: 3, windowMs: 60_000, now: () => now });
    expect(limiter.check("a")).toBe(true);
    expect(limiter.check("a")).toBe(true);
    expect(limiter.check("a")).toBe(true);
    expect(limiter.check("a")).toBe(false);
    expect(limiter.check("a")).toBe(false);
  });

  test("windows slide and keys are independent", () => {
    let now = 0;
    const limiter = new RateLimiter({ limit: 1, windowMs: 60_000, now: () => now });
    expect(limiter.check("a")).toBe(true);
    expect(limiter.check("a")).toBe(false);
    expect(limiter.check("b")).toBe(true);
    now += 61_000;
    expect(limiter.check("a")).toBe(true);
  });

  test("sweeps fully stale keys instead of growing without bound", () => {
    let now = 0;
    const limiter = new RateLimiter({ limit: 1, windowMs: 1_000, now: () => now, maxKeys: 5 });
    // a spray of one-shot keys, as a spoofed client address would produce
    for (let i = 0; i < 50; i++) limiter.check(`ip-${i}`);
    expect(limiter.size).toBeGreaterThan(5);
    now += 2_000;
    limiter.check("later");
    // everything from the spray is stale and gone
    expect(limiter.size).toBeLessThanOrEqual(5);
  });

  test("a key still inside its window survives the sweep", () => {
    let now = 0;
    const limiter = new RateLimiter({ limit: 2, windowMs: 60_000, now: () => now, maxKeys: 1 });
    expect(limiter.check("keep")).toBe(true);
    for (let i = 0; i < 10; i++) limiter.check(`noise-${i}`);
    expect(limiter.check("keep")).toBe(true);
    expect(limiter.check("keep")).toBe(false);
  });
});
