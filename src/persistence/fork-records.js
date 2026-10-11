// SPDX-License-Identifier: Apache-2.0
/** Native session fork (W-23 timeline primitives): derive the durable prefix
 *  a forked child replays from its parent's journal.
 *
 *  A fork boundary is a completed turn identified by its turn id: the child
 *  inherits everything up to and including that turn's `turn_outcome` journal
 *  record. The parent's own `session_created` (and lineage records) are
 *  excluded — the child writes its own identity. The seed is written through
 *  the child's normal journal append path, so the child's hash chain and
 *  provenance stay self-contained and an interrupted seed still restores as a
 *  valid prefix. */
import { ContractError } from '../ids.js';
import { reservedProjectedMessageId } from '../nnd-transcript-identity.js';

const MAX_FORK_RECORDS = 100_000;

function turnIdOf(payload) {
  const turnId = payload?.turnId ?? payload?.turn_id;
  return typeof turnId === 'string' && turnId.length > 0 ? turnId : null;
}

export function forkPrefixRecords(records, turnId) {
  if (!Array.isArray(records) || records.length > MAX_FORK_RECORDS || typeof turnId !== 'string' || turnId === '') {
    throw new ContractError('nnd_fork_invalid', 'NND fork requires a bounded journal record set and a turn id');
  }
  let cut = -1;
  for (let i = 0; i < records.length; i += 1) {
    if (records[i]?.type === 'turn_outcome' && turnIdOf(records[i].payload) === turnId) { cut = i; break; }
  }
  if (cut < 0) {
    throw new ContractError('nnd_fork_boundary_unsettled', 'NND fork requires a boundary turn that has completed');
  }
  const prefix = records.slice(0, cut + 1)
    .filter((record) => record.type !== 'session_created' && record.type !== 'session_lineage'
      && record.type !== 'revert_point' && record.type !== 'revert_cleared');
  if (prefix.length === 0) {
    throw new ContractError('nnd_fork_boundary_unknown', 'NND fork boundary has no inheritable records');
  }
  return prefix;
}

/** Boundary identity is the same projection the timeline rendered: a
 *  positional id (`session:message:index`) or a submitted user request id. */
export function resolveForkBoundary(transcript, sessionId, messageId) {
  if (typeof messageId !== 'string' || messageId.length === 0 || messageId.length > 256) {
    throw new ContractError('nnd_fork_invalid', 'NND fork requires a boundary message id');
  }
  const index = reservedProjectedMessageId(sessionId, messageId)
    ? Number(messageId.slice(`${sessionId}:message:`.length))
    : transcript.findLastIndex((item) => item?.type === 'message' && item.role === 'user' && item.requestId === messageId);
  const item = index >= 0 && index < transcript.length ? transcript[index] : null;
  const turnId = item?.type === 'message' && ['user', 'assistant'].includes(item.role) ? (item.turnId ?? null) : null;
  if (!turnId) throw new ContractError('nnd_fork_boundary_unknown', 'NND fork requires a boundary message that exists in the session');
  return { turnId, messageId };
}

/** Engine-constructor validation: a fork ingest is either absent or a bounded,
 *  validated prefix with its provenance. */
export function forkIngestContract(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)
    || !Array.isArray(value.records) || value.records.length === 0 || value.records.length > MAX_FORK_RECORDS
    || typeof value.sourceSessionId !== 'string' || value.sourceSessionId.length === 0
    || typeof value.boundaryMessageId !== 'string' || value.boundaryMessageId.length === 0) {
    throw new ContractError('nnd_fork_invalid', 'NND fork ingest requires a validated parent prefix');
  }
  return Object.freeze({ records: Object.freeze([...value.records]),
    sourceSessionId: value.sourceSessionId, boundaryMessageId: value.boundaryMessageId });
}
