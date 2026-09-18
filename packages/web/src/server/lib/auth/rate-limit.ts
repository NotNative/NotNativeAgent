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

/** X-RateLimit header triple (epoch seconds for Reset per doc 08 section 2.2). */
export function rateLimitHeaders(result: LoginRateLimitResult): Record<string, string> {
  return {
    'x-ratelimit-limit': String(result.limit),
    'x-ratelimit-remaining': String(result.remaining),
    'x-ratelimit-reset': String(Math.ceil(result.resetAt / 1000)),
    ...(result.retryAfterSeconds !== null ? { 'retry-after': String(result.retryAfterSeconds) } : {}),
  };
}
