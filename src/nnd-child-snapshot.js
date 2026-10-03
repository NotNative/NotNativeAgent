// SPDX-License-Identifier: Apache-2.0
import { readdir, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ContractError, requireExternalId } from './ids.js';
import { validActivityRecord } from './nnd-activity-snapshot.js';
import { persistAtomicJson } from './persistence/atomic-json.js';

const FILE_LIMIT_BYTES = 2_097_152;
const DIRECTORY_LIMIT = 1024;
const TRANSCRIPT_LIMIT = 200;
const TRANSCRIPT_CHARS = 262_144;

export function childSnapshotPath(catalogPath, sessionId) {
  return join(`${catalogPath}.children`, `${Buffer.from(sessionId, 'utf8').toString('hex')}.json`);
}

export async function persistChildSnapshot(catalogPath, snapshot, writer = persistAtomicJson) {
  if (!catalogPath) return;
  const path = childSnapshotPath(catalogPath, snapshot.sessionId);
  const content = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (Buffer.byteLength(content, 'utf8') > FILE_LIMIT_BYTES) {
    throw new ContractError('nnd_child_snapshot_capacity', 'NND child snapshot exceeds its size bound');
  }
  await writer(path, snapshot);
}

export async function removeChildSnapshot(catalogPath, sessionId) {
  if (!catalogPath) return;
  await unlink(childSnapshotPath(catalogPath, sessionId)).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

/** Security: a child snapshot is display data, never an owner or live-engine authority. */
export async function loadChildSnapshots(catalogPath, parents, limit) {
  if (!catalogPath) return [];
  const directory = `${catalogPath}.children`;
  let names;
  try { names = await readdir(directory); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new ContractError('nnd_child_snapshot_unavailable', 'NND child snapshots are unavailable', { cause: error });
  }
  if (names.length > DIRECTORY_LIMIT) throw new ContractError('nnd_child_snapshot_capacity', 'NND child snapshot directory exceeds its bound');
  const restored = [];
  const displaced = [];
  for (const name of names.sort()) {
    if (!/^(?:[0-9a-f]{2})+\.json$/u.test(name)) continue;
    const sessionId = Buffer.from(name.slice(0, -5), 'hex').toString('utf8');
    try { requireExternalId(sessionId, 'session_id'); } catch { continue; }
    if (childSnapshotPath(catalogPath, sessionId) !== join(directory, name)) continue;
    const path = join(directory, name);
    let source;
    try {
      const metadata = await stat(path);
      if (!metadata.isFile() || metadata.size > FILE_LIMIT_BYTES) throw new Error('child snapshot size bound');
      source = await readFile(path, 'utf8');
    } catch (error) {
      throw new ContractError('nnd_child_snapshot_unavailable', 'NND child snapshot is unavailable', { cause: error });
    }
    let snapshot;
    try { snapshot = JSON.parse(source); }
    catch { throw new ContractError('nnd_child_snapshot_invalid', 'NND child snapshot is invalid'); }
    if (!validSnapshot(snapshot) || snapshot.sessionId !== sessionId) {
      throw new ContractError('nnd_child_snapshot_invalid', 'NND child snapshot is invalid');
    }
    const parent = parents.get(snapshot.parentId);
    if (!parent || parent.createdAt !== snapshot.parentCreatedAt) continue;
    // Invariant: restore only the original full grant; an overlapping workspace is insufficient.
    if (snapshot.subjectId !== parent.subjectId || !sameWorkspaceIds(snapshot.workspaceIds, [...parent.workspaceIds])) {
      throw new ContractError('nnd_child_snapshot_invalid', 'NND child snapshot owner does not match its parent');
    }
    assertChildWorkspace(snapshot, parent);
    restored.push({ snapshot: { ...snapshot, activity: (snapshot.activity ?? []).map((record) => ({
      id: record.id, sessionID: record.sessionID, time: record.time, kind: record.kind,
      status: record.status, summary: record.summary,
      ...(record.toolEvidence ? { toolEvidence: record.toolEvidence } : {}),
    })) }, path });
    if (restored.length > limit) {
      // Why: a crash can leave the file for a child evicted from the bounded display cache.
      restored.sort(snapshotOrder);
      displaced.push(restored.shift().path);
    }
  }
  for (const path of displaced) {
    try { await unlink(path); }
    catch (error) {
      if (error.code !== 'ENOENT') {
        throw new ContractError('nnd_child_snapshot_unavailable', 'NND child snapshot cleanup failed', { cause: error });
      }
    }
  }
  return restored.sort(snapshotOrder).map(({ snapshot }) => snapshot);
}

function assertChildWorkspace(snapshot, parent) {
  if (parent.workspaceBinding && snapshot.directory !== parent.workspaceBinding.configured_root) {
    throw new ContractError('nnd_child_snapshot_invalid', 'NND child snapshot workspace does not match its parent');
  }
}

function snapshotOrder(left, right) {
  return left.snapshot.createdAt - right.snapshot.createdAt
    || left.snapshot.updatedAt - right.snapshot.updatedAt
    || left.snapshot.sessionId.localeCompare(right.snapshot.sessionId);
}

export function validSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) return false;
  try { requireExternalId(value.sessionId, 'session_id'); requireExternalId(value.parentId, 'session_id'); }
  catch { return false; }
  return typeof value.subjectId === 'string' && value.subjectId.trim().length > 0
    && Array.isArray(value.workspaceIds) && value.workspaceIds.length > 0
    && value.workspaceIds.every((id) => typeof id === 'string' && id.trim().length > 0)
    && Number.isSafeInteger(value.parentCreatedAt) && value.parentCreatedAt > 0
    && Number.isSafeInteger(value.createdAt) && value.createdAt > 0
    && Number.isSafeInteger(value.updatedAt) && value.updatedAt >= value.createdAt
    && typeof value.directory === 'string' && value.directory.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value.directory)
    && typeof value.title === 'string' && value.title.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value.title)
    && (value.agent === undefined || typeof value.agent === 'string' && value.agent.trim().length > 0
      && value.agent.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(value.agent))
    && (value.configuredModel === null || validModel(value.configuredModel))
    && validTranscript(value.transcript)
    && (value.activity === undefined || Array.isArray(value.activity) && value.activity.length <= 500
      && value.activity.every((record) => validActivityRecord(record, value.sessionId)));
}

function validModel(value) {
  const validId = (id) => typeof id === 'string' && id.trim().length > 0 && id.length <= 256
    && !/[\u0000-\u001f\u007f]/u.test(id);
  return value && typeof value === 'object' && !Array.isArray(value)
    && validId(value.providerID) && validId(value.modelID);
}

function validTranscript(entries) {
  if (!Array.isArray(entries) || entries.length > TRANSCRIPT_LIMIT) return false;
  let chars = 0;
  let prior = -1;
  for (const entry of entries) {
    if (!entry || !Number.isSafeInteger(entry.index) || entry.index <= prior || entry.index < 0
      || entry.item?.type !== 'message' || !['user', 'assistant'].includes(entry.item.role)
      || typeof entry.item.content !== 'string') return false;
    chars += entry.item.content.length;
    if (chars > TRANSCRIPT_CHARS) return false;
    prior = entry.index;
  }
  return true;
}

function sameWorkspaceIds(left, right) {
  return left.length === right.length && new Set(left).size === left.length
    && left.every((id) => right.includes(id));
}

/** Observational writes stay ordered so a late completion cannot undo child eviction or parent close. */
export class NndChildSnapshotStore {
  #writes = Promise.resolve();
  #deferredDeletes = new Map();
  constructor(catalogPath, writer = persistAtomicJson) {
    this.catalogPath = catalogPath;
    this.writer = writer;
  }
  observe(type, child, parent, registry, activity = []) {
    if (!this.catalogPath || !parent || !['completed', 'deleted'].includes(type)) return;
    if (type === 'deleted' && parent.closing) {
      // Invariant: a failed parent close retains recoverable child history.
      const ids = this.#deferredDeletes.get(parent.sessionId) ?? new Set();
      ids.add(child.id);
      this.#deferredDeletes.set(parent.sessionId, ids);
      return;
    }
    const snapshot = type === 'completed' ? registry.completedSnapshot?.(child.id, parent.createdAt) : null;
    if (snapshot) snapshot.activity = activity.map((record) => ({ id: record.id, sessionID: record.sessionID,
      time: record.time, kind: record.kind, status: record.status, summary: record.summary,
      ...(record.toolEvidence ? { toolEvidence: record.toolEvidence } : {}) }));
    this.#schedule(parent, () => snapshot
      ? persistChildSnapshot(this.catalogPath, snapshot, this.writer)
      : removeChildSnapshot(this.catalogPath, child.id));
  }
  async completeParentClose(parent) {
    const ids = this.#deferredDeletes.get(parent.sessionId);
    this.#deferredDeletes.delete(parent.sessionId);
    for (const id of ids ?? []) this.#schedule(parent, () => removeChildSnapshot(this.catalogPath, id));
    await this.drain();
  }
  #schedule(parent, operation) {
    const write = this.#writes.then(operation);
    this.#writes = write.catch((error) => {
      try { parent.engine.telemetry?.record('nnd.child_snapshot', 'failed', {
        code: error?.code ?? 'child_snapshot_failed',
      }); } catch { /* Display persistence cannot change delegated work. */ }
    });
  }
  async drain() { await this.#writes; }
}
