export type SlidingWindowLimiter = {
  check(key: string): { allowed: boolean; retryAfterSeconds: number };
  reset(): void;
};

/**
 * In-memory sliding windows (single-process SQLite deployment), following the
 * webauthn.ts emergency-attempts precedent. Reset on restart errs toward
 * availability.
 */
export function createSlidingWindowLimiter(options: {
  limit: number;
  windowMs: number;
  now?: () => number;
}): SlidingWindowLimiter {
  const now = options.now ?? Date.now;
  const hits = new Map<string, number[]>();

  return {
    check(key) {
      const current = now();
      const windowStart = current - options.windowMs;
      const list = (hits.get(key) ?? []).filter((t) => t > windowStart);
      if (list.length >= options.limit) {
        hits.set(key, list);
        return {
          allowed: false,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((list[0]! + options.windowMs - current) / 1000),
          ),
        };
      }
      list.push(current);
      hits.set(key, list);
      return { allowed: true, retryAfterSeconds: 0 };
    },
    reset() {
      hits.clear();
    },
  };
}

/** Per-IP request budget: 10 per 15 minutes (spec section 6). */
export const resetRequestByIpLimiter = createSlidingWindowLimiter({
  limit: 10,
  windowMs: 15 * 60 * 1000,
});

/** Per-email issuance budget: 3 tokens per hour (spec section 6). */
export const resetRequestByEmailLimiter = createSlidingWindowLimiter({
  limit: 3,
  windowMs: 60 * 60 * 1000,
});

/** Per-IP redemption failure budget: 10 per 15 minutes (spec section 6). */
export const resetRedeemByIpLimiter = createSlidingWindowLimiter({
  limit: 10,
  windowMs: 15 * 60 * 1000,
});
