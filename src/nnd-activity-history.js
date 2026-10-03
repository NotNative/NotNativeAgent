// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { ContractError } from './ids.js';
import { ACTIVITY_LIMIT, readActivitySnapshot } from './nnd-activity-snapshot.js';

const PAGE_LIMIT_MAX = 100;
const CURSOR_LIMIT = 768;
const invalidCursor = () => new ContractError('nnd_activity_cursor_invalid', 'NND activity history cursor is invalid');

/** Recheck the exact authenticated context after async disk I/O, including close and reincarnation. */
export async function readOwnedActivityPage(catalogPath, context, options, currentContext) {
  const page = await readDurableActivityPage(catalogPath, context.sessionId, context.createdAt, options);
  if (currentContext() !== context) {
    throw new ContractError('nnd_session_unavailable', 'NND session context is unavailable');
  }
  return page;
}

/** Read only an exact durable suffix. A cursor is a snapshot bookmark, never authority. */
export async function readDurableActivityPage(catalogPath, sessionId, createdAt, options = {}) {
  if (!catalogPath) throw new ContractError('nnd_activity_unavailable', 'Durable NND activity history is unavailable');
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some((key) => !['limit', 'cursor'].includes(key))) {
    throw new ContractError('nnd_activity_page_invalid', 'NND activity history page request is invalid');
  }
  const { limit = 50, cursor = null } = options;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_LIMIT_MAX
    || cursor !== null && (typeof cursor !== 'string' || cursor.length < 1 || cursor.length > CURSOR_LIMIT)) {
    throw new ContractError('nnd_activity_page_invalid', 'NND activity history page request is invalid');
  }
  const requested = cursor === null ? null : parseCursor(cursor, sessionId);
  const { present, records } = await readActivitySnapshot(catalogPath, sessionId, createdAt);
  const digest = createHash('sha256').update(JSON.stringify([sessionId, createdAt, present, records])).digest('hex');
  const snapshot = Object.freeze({ version: 1, sessionID: sessionId, createdAt, digest,
    durablePresent: present, retainedCount: records.length, retentionLimit: ACTIVITY_LIMIT,
    retainedLowerBound: records[0]?.id ?? null, retainedUpperBound: records.at(-1)?.id ?? null,
    historyComplete: false });
  if (requested && (requested.createdAt !== createdAt || requested.digest !== digest)) {
    // Invariant: never mix rows from two persisted snapshots or session incarnations.
    return Object.freeze({ status: 'gap', reason: requested.createdAt !== createdAt
      ? 'session_recreated' : 'snapshot_changed', snapshot, records: [], nextCursor: null });
  }
  const end = requested?.before ?? records.length;
  if (requested && (end < 1 || end > records.length)) throw invalidCursor();
  const start = Math.max(0, end - limit);
  return Object.freeze({ status: 'page', snapshot, records: records.slice(start, end),
    nextCursor: start > 0 ? makeCursor(sessionId, createdAt, digest, start) : null });
}

function makeCursor(sessionId, createdAt, digest, before) {
  return Buffer.from(JSON.stringify({ version: 1, sessionId, createdAt, digest, before }), 'utf8').toString('base64url');
}

function parseCursor(value, sessionId) {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw invalidCursor();
  const source = Buffer.from(value, 'base64url');
  if (source.toString('base64url') !== value) throw invalidCursor();
  let parsed;
  try { parsed = JSON.parse(source.toString('utf8')); } catch { throw invalidCursor(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.keys(parsed).length !== 5 || parsed.version !== 1 || parsed.sessionId !== sessionId
    || !Number.isSafeInteger(parsed.createdAt) || parsed.createdAt < 1
    || typeof parsed.digest !== 'string' || !/^[0-9a-f]{64}$/u.test(parsed.digest)
    || !Number.isSafeInteger(parsed.before) || parsed.before < 1 || parsed.before > ACTIVITY_LIMIT) {
    throw invalidCursor();
  }
  return parsed;
}
