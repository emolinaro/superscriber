import { describe, expect, it } from "vitest";
import { createSlidingWindowLimiter } from "@/server/auth/password-reset-rate-limit";

describe("createSlidingWindowLimiter", () => {
  it("allows up to the limit inside the window, then denies with retry hint", () => {
    let t = 1_000_000;
    const limiter = createSlidingWindowLimiter({ limit: 2, windowMs: 1_000, now: () => t });
    expect(limiter.check("k").allowed).toBe(true);
    expect(limiter.check("k").allowed).toBe(true);
    const denied = limiter.check("k");
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    t += 1_001;
    expect(limiter.check("k").allowed).toBe(true);
  });

  it("tracks keys independently and reset() clears state", () => {
    const limiter = createSlidingWindowLimiter({ limit: 1, windowMs: 60_000 });
    limiter.check("a");
    expect(limiter.check("b").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(false);
    limiter.reset();
    expect(limiter.check("a").allowed).toBe(true);
  });
});
