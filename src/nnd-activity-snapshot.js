// SPDX-License-Identifier: Apache-2.0
import { readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ContractError } from './ids.js';
import { persistAtomicJson } from './persistence/atomic-json.js';

const ACTIVITY_LIMIT = 500;
// 500 records can contain multibyte printable identifiers and summaries.
const FILE_LIMIT_BYTES = 2_097_152;
const KINDS = new Set(['turn', 'tool', 'notice']);
const STATUSES = new Set(['started', 'completed', 'failed', 'redacted']);

export function activityPath(catalogPath, sessionId) {
  return join(`${catalogPath}.activity`, `${Buffer.from(sessionId, 'utf8').toString('hex')}.json`);
}

export async function loadActivity(catalogPath, sessionId, createdAt) {
  if (!catalogPath) return [];
  const path = activityPath(catalogPath, sessionId);
  let content;
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > FILE_LIMIT_BYTES) throw new Error('activity size bound');
    content = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new ContractError('nnd_activity_unavailable', 'NND activity snapshot is unavailable', { cause: error });
  }
  let snapshot;
  try { snapshot = JSON.parse(content); } catch { throw new ContractError('nnd_activity_invalid', 'NND activity snapshot is invalid'); }
  if (!snapshot || snapshot.version !== 1 || snapshot.sessionId !== sessionId
    || !Number.isSafeInteger(snapshot.createdAt) || !Array.isArray(snapshot.records)
    || snapshot.records.length > ACTIVITY_LIMIT || snapshot.records.some((record) => !validActivityRecord(record, sessionId))) {
    throw new ContractError('nnd_activity_invalid', 'NND activity snapshot is invalid');
  }
  // A deleted session can be recreated with its old ID. Its prior activity is not part of the new session.
  // Security: the file is not an authority to add new API fields.
  return snapshot.createdAt === createdAt ? snapshot.records.map((record) => ({
    id: record.id, sessionID: record.sessionID, time: record.time, kind: record.kind,
    status: record.status, summary: record.summary,
  })) : [];
}

export function appendActivity(records, candidate) {
  const record = sanitizeRecord(candidate);
  if (!record) return null;
  const index = records.findIndex((entry) => entry.id === record.id);
  if (index >= 0) {
    record.time = Math.max(record.time, records[index].time + 1);
    records.splice(index, 1);
  }
  records.push(record);
  if (records.length > ACTIVITY_LIMIT) records.splice(0, records.length - ACTIVITY_LIMIT);
  return record;
}

export function persistActivity(catalogPath, sessionId, createdAt, records, writer = persistAtomicJson) {
  if (!catalogPath) return Promise.resolve();
  return writer(activityPath(catalogPath, sessionId), { version: 1, sessionId, createdAt, records });
}

export async function removeActivity(catalogPath, sessionId) {
  if (!catalogPath) return;
  await unlink(activityPath(catalogPath, sessionId)).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

/** Observational persistence: coalesce new evidence while one atomic write is pending. */
export function scheduleActivityWrite(context, catalogPath, writer) {
  if (!catalogPath || context.activityWrite) return;
  const revision = context.activityRevision;
  const snapshot = [...context.activity];
  const write = Promise.resolve().then(() => persistActivity(catalogPath, context.sessionId,
    context.createdAt, snapshot, writer));
  context.activityWrite = write;
  void write.catch((error) => reportActivityFailure(context, error)).finally(() => {
    if (context.activityWrite !== write) return;
    context.activityWrite = null;
    if (context.activityRevision > revision) scheduleActivityWrite(context, catalogPath, writer);
  });
}

export async function drainActivityWrites(context) {
  while (context.activityWrite) {
    const write = context.activityWrite;
    await write.catch(() => undefined);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export function reportActivityFailure(context, error) {
  try { context.engine.telemetry?.record('nnd.activity_snapshot', 'failed', {
    code: error?.code ?? 'activity_snapshot_failed',
  }); } catch { /* Display persistence cannot change a governed outcome. */ }
}

function sanitizeRecord(value) {
  if (!value || typeof value !== 'object' || !KINDS.has(value.kind) || !STATUSES.has(value.status)
    || typeof value.id !== 'string' || value.id.length < 1 || value.id.length > 256
    || /[\u0000-\u001f\u007f]/u.test(value.id)
    || typeof value.sessionID !== 'string' || value.sessionID.length < 1 || value.sessionID.length > 128) return null;
  const summary = typeof value.summary === 'string' ? value.summary.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 256) : '';
  return { id: value.id, sessionID: value.sessionID, time: Date.now(), kind: value.kind,
    status: value.status, summary };
}

export function validActivityRecord(value, sessionId) {
  return value && typeof value === 'object' && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 256
    && !/[\u0000-\u001f\u007f]/u.test(value.id) && value.sessionID === sessionId
    && Number.isSafeInteger(value.time) && value.time > 0 && KINDS.has(value.kind) && STATUSES.has(value.status)
    && typeof value.summary === 'string' && value.summary.length <= 256
    && !/[\u0000-\u001f\u007f]/u.test(value.summary);
}
