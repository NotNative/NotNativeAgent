// SPDX-License-Identifier: Apache-2.0
/**
 * UI session JWT (doc 08 section 2.2): hand-rolled HS256 with node:crypto
 * (E-08-1, no `jose`). The payload grammar is exactly
 * {type:'ui-session',iat,exp}; verification re-computes the tag and compares
 * in constant time. Secret resolution order: NOTNATIVE_JWT_SECRET env (doc
 * literal OPENCODE_JWT_SECRET, E-08-4) -> <data-dir>/jwt-secret file created
 * 0600 if missing -> generated in memory. Rotation is refused while the env
 * secret is set; file-backed rotation rewrites the file, memory stays memory.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';

export type JwtSecretSource = 'env' | 'file' | 'memory';

const SECRET_FILE_NAME = 'jwt-secret';
const SESSION_TYPE = 'ui-session';
const TOKEN_MAX_CHARS = 4096;
const HEADER_SEGMENT = encodeSegment(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

export interface JwtSecretHolder {
  secret(): string;
  source(): JwtSecretSource;
  /** Throws while the env secret is set (doc 08 section 2.2 global reset). */
  rotate(): void;
}

export function resolveJwtSecretHolder(dataDir: string): JwtSecretHolder {
  let state: { source: JwtSecretSource; value: string } | null = null;
  const file = joinPath(dataDir, SECRET_FILE_NAME);
  const ensure = (): { source: JwtSecretSource; value: string } => {
    if (state !== null) return state;
    const fromEnv = readEnvSecret();
    if (fromEnv !== '') {
      state = { source: 'env', value: fromEnv };
      return state;
    }
    const fromFile = readSecretFile(file);
    if (fromFile !== '') {
      state = { source: 'file', value: fromFile };
      return state;
    }
    const generated = randomBytes(32).toString('hex');
    // Persist so browser sessions survive restarts (doc 08 §2.2: the file is
    // "created 0o600 if missing"); memory is only the fallback when the write
    // cannot land.
    try {
      writeSecretFile(file, generated, dataDir);
      state = { source: 'file', value: generated };
    } catch {
      state = { source: 'memory', value: generated };
    }
    return state;
  };
  return {
    secret(): string {
      return ensure().value;
    },
    source(): JwtSecretSource {
      return ensure().source;
    },
    rotate(): void {
      ensure();
      if (state?.source === 'env') {
        throw new Error('JWT secret rotation is disabled while NOTNATIVE_JWT_SECRET is set');
      }
      const next = randomBytes(32).toString('hex');
      if (state?.source === 'file') {
        writeSecretFile(file, next, dataDir);
        state = { source: 'file', value: next };
        return;
      }
      state = { source: 'memory', value: next };
    },
  };
}

export function signSessionJwt(secret: string, iat: number, exp: number): string {
  const signing = `${HEADER_SEGMENT}.${encodeSegment(JSON.stringify({ type: SESSION_TYPE, iat, exp }))}`;
  const tag = createHmac('sha256', Buffer.from(secret, 'utf8')).update(signing).digest('base64url');
  return `${signing}.${tag}`;
}

export function verifySessionJwt(secret: string, token: unknown, now: number): boolean {
  if (typeof token !== 'string' || token.length > TOKEN_MAX_CHARS || token.length === 0) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [head, body, tag] = parts as [string, string, string];
  const expected = createHmac('sha256', Buffer.from(secret, 'utf8')).update(`${head}.${body}`).digest('base64url');
  if (!constantTimeTagCompare(tag, expected)) return false;
  return parsePayloadWithQuota(body, now);
}

function parsePayloadWithQuota(body: string, now: number): boolean {
  if (body.length === 0 || body.length > TOKEN_MAX_CHARS) return false;
  const raw = decodeSegment(body);
  if (raw === null) return false;
  try {
    const payload = JSON.parse(raw) as { type?: unknown; iat?: unknown; exp?: unknown };
    if (
      payload?.type !== SESSION_TYPE
      || typeof payload.iat !== 'number' || !Number.isSafeInteger(payload.iat)
      || typeof payload.exp !== 'number' || !Number.isSafeInteger(payload.exp)
      || payload.iat > payload.exp // E-08-1 grammar: iat<=exp numerics
      || Object.keys(payload).length !== 3
    ) {
      return false;
    }
    return payload.exp > now; // expired or exactly-now is never valid
  } catch {
    return false;
  }
}

function constantTimeTagCompare(given: string, expected: string): boolean {
  try {
    return timingSafeEqual(Buffer.from(given, 'base64url'), Buffer.from(expected, 'base64url'));
  } catch {
    return false;
  }
}

function encodeSegment(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodeSegment(value: string): string | null {
  try {
    return Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

function readEnvSecret(): string {
  const value = process.env.NOTNATIVE_JWT_SECRET;
  return typeof value === 'string' && value.trim().length > 0 ? value : '';
}

function readSecretFile(file: string): string {
  try {
    if (!existsSync(file)) return '';
    const raw = readFileSync(file, 'utf8').trim();
    if (!/^[0-9a-f]{64}$/u.test(raw)) return ''; // corrupted/foreign secret -> regenerate
    return raw;
  } catch {
    return '';
  }
}

function writeSecretFile(file: string, secret: string, dataDir: string): void {
  // Atomic tmp+rename (mirrors settings-store/remote-clients): a crash
  // mid-write must never truncate the slot into an empty inventory.
  mkdirSync(dataDir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, secret, { mode: 0o600 });
  renameSync(tmp, file);
}
