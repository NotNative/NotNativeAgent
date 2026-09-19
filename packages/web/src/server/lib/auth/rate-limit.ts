// SPDX-License-Identifier: Apache-2.0
/**
 * Login rate limit (doc 08 section 2.2): per client IP, 10 failed attempts
 * in a 5 min window then a 15 min lockout; callers without an IP get the
 * stricter 3-attempt budget. Env overrides are the NOTNATIVE-branded
 * OPENCHAMBER_RATE_LIMIT_* keys (E-08-4). Buckets live in memory only
 * (E-08-5, documented source posture); a successful login clears the
 * caller's bucket.
 */
export interface LoginRateLimitConfig {
  windowMs: number;
  maxAttempts: number;
  noIpMaxAttempts: number;
  lockoutMs: number;
}

export interface LoginRateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number; // epoch ms of the window end (or lockout end)
  locked: boolean;
  retryAfterSeconds: number | null;
}

export const DEFAULT_RATE_LIMIT_CONFIG: LoginRateLimitConfig = {
  windowMs: 5 * 60_000,
  maxAttempts: 10,
  noIpMaxAttempts: 3,
  lockoutMs: 15 * 60_000,
};

export interface LoginRateLimiter {
  attempt(key: string): LoginRateLimitResult;
  record(key: string): void;
  clear(key: string): void;
}

export function envRateLimitOverrides(): { maxAttempts?: number; noIpMaxAttempts?: number } {
  const maxAttempts = positiveIntEnv('NOTNATIVE_RATE_LIMIT_MAX_ATTEMPTS');
  const noIpMaxAttempts = positiveIntEnv('NOTNATIVE_RATE_LIMIT_NO_IP_MAX_ATTEMPTS');
  const overrides: { maxAttempts?: number; noIpMaxAttempts?: number } = {};
  if (maxAttempts !== undefined) overrides.maxAttempts = maxAttempts;
  if (noIpMaxAttempts !== undefined) overrides.noIpMaxAttempts = noIpMaxAttempts;
  return overrides;
}

interface Bucket {
  entries: number[];
  lockedUntil: number;
}

export function createLoginRateLimiter(
  config: LoginRateLimitConfig = DEFAULT_RATE_LIMIT_CONFIG,
  now: () => number = Date.now,
): LoginRateLimiter {
  const buckets = new Map<string, Bucket>();
  const capFor = (key: string): number => (key === '' ? config.noIpMaxAttempts : config.maxAttempts);
  const readBucket = (key: string): { bucket: Bucket | null; stamp: number } => {
    const stamp = now();
    return { bucket: pruneBucket(buckets, key, config, stamp), stamp };
  };

  return {
    attempt(key) {
      const { bucket, stamp } = readBucket(key);
      const limit = capFor(key);
      if (bucket === null) {
        return { allowed: true, limit, remaining: limit, resetAt: stamp + config.windowMs, locked: false, retryAfterSeconds: null };
      }
      if (bucket.lockedUntil > stamp) {
        return lockedResult(limit, bucket.lockedUntil, stamp);
      }
      if (bucket.entries.length >= limit) {
        bucket.lockedUntil = stamp + config.lockoutMs;
        return lockedResult(limit, bucket.lockedUntil, stamp);
      }
      const windowEnd = bucket.entries.length > 0 ? bucket.entries[0]! + config.windowMs : stamp + config.windowMs;
      return {
        allowed: true,
        limit,
        remaining: Math.max(0, limit - bucket.entries.length),
        resetAt: windowEnd,
        locked: false,
        retryAfterSeconds: null,
      };
    },
    record(key) {
      let bucket = buckets.get(key);
      if (bucket === undefined) {
        bucket = { entries: [], lockedUntil: 0 };
        buckets.set(key, bucket);
      }
      bucket.entries.push(now());
      if (bucket.entries.length > capFor(key) && bucket.lockedUntil === 0) {
        bucket.lockedUntil = now() + config.lockoutMs;
      }
    },
    clear(key) {
      buckets.delete(key);
    },
  };
}

/** Reads the live bucket, pruning the sliding window and expired locks.
 * Empty+unlocked buckets are dropped by the READER only; `record` always
 * re-inserts so pushes never land on a detached bucket. */
function pruneBucket(buckets: Map<string, Bucket>, key: string, config: LoginRateLimitConfig, stamp: number): Bucket | null {
  const bucket = buckets.get(key);
  if (bucket === undefined) return null;
  bucket.entries = bucket.entries.filter((entry) => stamp - entry < config.windowMs);
  if (bucket.lockedUntil !== 0 && bucket.lockedUntil <= stamp) bucket.lockedUntil = 0;
  if (bucket.entries.length === 0 && bucket.lockedUntil === 0) {
    buckets.delete(key);
    return null;
  }
  return bucket;
}

function lockedResult(limit: number, lockedUntil: number, stamp: number): LoginRateLimitResult {
  return {
    allowed: false,
    limit,
    remaining: 0,
    resetAt: lockedUntil,
    locked: true,
    retryAfterSeconds: Math.max(1, Math.ceil((lockedUntil - stamp) / 1000)),
  };
}

function positiveIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) return undefined;
  return value;
}

/** Redeem rate limit (doc 08 section 5.5): 10 attempts / 5 min keyed by
 * the RAW socket remote address + pairing id — deliberately not req.ip,
 * because the redeem is unauthenticated and the proxy must not be able
 * to widen the bucket. Sliding window, no lock phase; a successful
 * redeem clears the bucket; 429 answers the same safe error text. */
export const REDEEM_RATE_WINDOW_MS = 5 * 60_000;
export const REDEEM_RATE_MAX_ATTEMPTS = 10;

export function createRedeemRateLimiter(
  config: { windowMs?: number; maxAttempts?: number } = {},
  now: () => number = Date.now,
): LoginRateLimiter {
  const windowMs = config.windowMs ?? REDEEM_RATE_WINDOW_MS;
  const maxAttempts = config.maxAttempts ?? REDEEM_RATE_MAX_ATTEMPTS;
  const buckets = new Map<string, number[]>();

  const prune = (key: string): number[] | null => {
    const entries = buckets.get(key);
    if (entries === undefined) return null;
    const stamp = now();
    const alive = entries.filter((entry) => stamp - entry < windowMs);
    if (alive.length === 0) {
      buckets.delete(key);
      return null;
    }
    buckets.set(key, alive);
    return alive;
  };

  return {
    attempt(key) {
      const alive = prune(key);
      const stamp = now();
      if (alive === null) {
        return { allowed: true, limit: maxAttempts, remaining: maxAttempts, resetAt: stamp + windowMs, locked: false, retryAfterSeconds: null };
      }
      if (alive.length >= maxAttempts) {
        const resetAt = alive[0]! + windowMs;
        return {
          allowed: false,
          limit: maxAttempts,
          remaining: 0,
          resetAt,
          locked: true,
          retryAfterSeconds: Math.max(1, Math.ceil((resetAt - stamp) / 1000)),
        };
      }
      const resetAt = alive[0]! + windowMs;
      return { allowed: true, limit: maxAttempts, remaining: Math.max(0, maxAttempts - alive.length), resetAt, locked: false, retryAfterSeconds: null };
    },
    record(key) {
      const entries = buckets.get(key) ?? [];
      entries.push(now());
      buckets.set(key, entries);
    },
    clear(key) {
      buckets.delete(key);
    },
  };
}

/** X-RateLimit header triple (epoch seconds for Reset per doc 08 section 2.2). */
export function rateLimitHeaders(result: LoginRateLimitResult): Record<string, string> {
  return {
    'x-ratelimit-limit': String(result.limit),
    'x-ratelimit-remaining': String(result.remaining),
    'x-ratelimit-reset': String(Math.ceil(result.resetAt / 1000)),
    ...(result.retryAfterSeconds !== null ? { 'retry-after': String(result.retryAfterSeconds) } : {}),
  };
}
