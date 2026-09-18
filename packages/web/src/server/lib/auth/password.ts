// SPDX-License-Identifier: Apache-2.0
/**
 * UI password verifier (doc 08 section 2.2). The password is never
 * persisted: per-process salt (16 random bytes) + scryptSync 64B digest
 * held in memory only, compared through timingSafeEqual. The candidate
 * (and the resolved password) run through Unicode normalize() + trim
 * before hashing, so pathologically spaced input never forks side
 * channels against a stored variant.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SCRYPT_LENGTH = 64;

/** String-only normalize(): default NFC + trim; anything else -> ''. */
export function normalizedPassword(value: unknown): string {
  return typeof value === 'string' ? value.normalize('NFC').trim() : '';
}

export interface PasswordSecrets {
  salt: Buffer;
  expected: Buffer;
}

export function derivePasswordSecrets(password: string, salt?: Buffer): PasswordSecrets {
  const saltBuffer = salt ?? randomBytes(16);
  return { salt: saltBuffer, expected: scryptSync(password, saltBuffer, SCRYPT_LENGTH) };
}

export function passwordMatches(candidate: string, secrets: PasswordSecrets): boolean {
  try {
    const guess = scryptSync(candidate, secrets.salt, SCRYPT_LENGTH);
    const sameLength = guess.length === secrets.expected.length;
    return sameLength && timingSafeEqual(guess, secrets.expected);
  } catch {
    return false;
  }
}

/** Small bounded cache so repeated verifications of one resolved password
 * do not re-derive scrypt on the expected side. Keyed by the password
 * string; entries evict oldest-inserted. */
export function createPasswordHashCache(limit: number = 4): (password: string) => PasswordSecrets {
  const entries = new Map<string, PasswordSecrets>();
  return (password: string): PasswordSecrets => {
    const cached = entries.get(password);
    if (cached !== undefined) {
      entries.delete(password);
      entries.set(password, cached); // refresh insertion order
      return cached;
    }
    const fresh = derivePasswordSecrets(password);
    entries.set(password, fresh);
    while (entries.size > limit) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
    return fresh;
  };
}
