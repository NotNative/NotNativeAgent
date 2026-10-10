// SPDX-License-Identifier: Apache-2.0
/**
 * Session-organization records (F4.7): NND-owned durable organization state
 * that used to ride generic session metadata — BTW linkage and markers,
 * obligatory message pins, project-context pins, and the knowledge
 * signature. NNA's session PATCH accepts only title/archived-time, so these
 * records live in `<data-dir>/session-org.json` instead of engine metadata.
 * Bounded per record; ops are validated and merged under a serialized write
 * queue; a malformed stored document answers 500 and never boots empty.
 */
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { join as joinPath, dirname } from 'node:path';
import type { Hono } from 'hono';
import { ENV } from '../env.ts';
import { normalizeRequestDirectory, PIN_ID_PATTERN, SIGNATURE_PATTERN, sessionID } from '../session-knowledge/metadata.ts';

const CAP = 4 * 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const PIN_ROLES = new Set(['user', 'assistant']);
const MESSAGE_PIN_LIMIT = 64;
const CONTEXT_PIN_LIMIT = 50;

export interface SessionOrgRecord {
  btwMarker?: { originalSessionID: string; boundaryMessageID: string; promoted: boolean };
  btwChildOf?: string;
  messagePins?: { id: string; createdAt: number; role: 'user' | 'assistant' }[];
  contextPins?: { notes: string[]; plans: string[] };
  knowledgeSignature?: string;
}

interface Store {
  version: 1;
  records: Record<string, Record<string, SessionOrgRecord>>;
  updatedAt: number;
}

const emptyStore = (): Store => ({ version: 1, records: {}, updatedAt: 0 });

function storeFile(): string { return joinPath(ENV.dataDir, 'session-org.json'); }

function stored(): Store | null {
  try { return JSON.parse(readFileSync(storeFile(), 'utf8')) as Store; } catch { return null; }
}

function shapeValid(store: unknown): store is Store {
  const bag = store as Store | null;
  if (!bag || typeof bag !== 'object' || bag.version !== 1) return false;
  if (typeof bag.updatedAt !== 'number') return false;
  if (!bag.records || typeof bag.records !== 'object' || Array.isArray(bag.records)) return false;
  return Object.values(bag.records).every(directory => {
    if (!directory || typeof directory !== 'object' || Array.isArray(directory)) return false;
    return Object.values(directory as Record<string, unknown>).every(recordShapeValid);
  });
}

const RECORD_KEYS = new Set(['btwMarker', 'btwChildOf', 'messagePins', 'contextPins', 'knowledgeSignature']);

function recordShapeValid(record: unknown): boolean {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  return Object.keys(record).every(key => RECORD_KEYS.has(key));
}

async function persist(store: Store): Promise<void> {
  store.updatedAt = Date.now();
  for (const [directory, sessions] of Object.entries(store.records)) {
    for (const [session, record] of Object.entries(sessions)) {
      if (Object.keys(record).length === 0) delete sessions[session];
    }
    if (Object.keys(sessions).length === 0) delete store.records[directory];
  }
  mkdirSync(dirname(storeFile()), { recursive: true });
  const temporary = `${storeFile()}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    await writeFile(temporary, JSON.stringify(store), 'utf8');
    await rename(temporary, storeFile());
  } catch (error) {
    try { await unlink(temporary); } catch { /* the temp file is already gone */ }
    throw error;
  }
}

let writeQueue: Promise<void> = Promise.resolve();

function queueWrite(operation: (store: Store) => Promise<void>): Promise<void> {
  const run = writeQueue.then(async () => {
    const current = stored();
    if (current !== null && !shapeValid(current)) throw new Error('Stored session-organization records are malformed');
    const store = current ?? emptyStore();
    await operation(store);
    await persist(store);
  });
  writeQueue = run.catch(() => undefined);
  return run;
}

function directoryFor(value: unknown): string | undefined { return normalizeRequestDirectory(value); }

function boundedIDs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || !PIN_ID_PATTERN.test(item)) continue;
    ids.add(item);
    if (ids.size >= CONTEXT_PIN_LIMIT) break;
  }
  return [...ids];
}

function messagePinsOf(value: unknown): SessionOrgRecord['messagePins'] {
  if (value === null) return [];
  if (!Array.isArray(value)) return undefined;
  // Deduplicate by id (last wins), then keep the NEWEST 64 by createdAt so a
  // direct over-cap call cannot silently drop the most recent pins.
  const byId = new Map<string, { id: string; createdAt: number; role: 'user' | 'assistant' }>();
  for (const item of value) {
    const record = item !== null && typeof item === 'object' && !Array.isArray(item)
      ? item as Record<string, unknown> : null;
    const id = typeof record?.id === 'string' && record.id !== '' && record.id.length <= 200 ? record.id : null;
    const createdAt = typeof record?.createdAt === 'number' && Number.isFinite(record.createdAt) ? record.createdAt : null;
    const role = typeof record?.role === 'string' && PIN_ROLES.has(record.role)
      ? record.role as 'user' | 'assistant' : null;
    if (id === null || createdAt === null || role === null) continue;
    byId.set(id, { id, createdAt, role });
  }
  const all = [...byId.values()].sort((left, right) =>
    left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : left.id < right.id ? -1 : 1);
  return all.slice(-MESSAGE_PIN_LIMIT);
}

function markerOf(value: unknown): SessionOrgRecord['btwMarker'] {
  const record = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
  const original = sessionID(record?.originalSessionID);
  if (original === undefined) return undefined;
  const boundary = typeof record?.boundaryMessageID === 'string' && record.boundaryMessageID !== ''
    && ID_PATTERN.test(record.boundaryMessageID) ? record.boundaryMessageID : '';
  return { originalSessionID: original, boundaryMessageID: boundary,
    promoted: record?.promoted === true };
}

/** Applies one bounded op to a directory+session record; rejects unknown ops. */
export function applySessionOrgOp(record: SessionOrgRecord, op: string, body: Record<string, unknown>): boolean {
  switch (op) {
    case 'btw.setMarker': {
      const marker = markerOf(body.marker);
      if (marker === undefined) return false;
      // An explicit `promoted` body flag overrides the preserve rule: the
      // panel rollback must be able to revert a promotion after a failed
      // unlink, and without it a re-marked boundary would silently keep the
      // promoted flag forever.
      const promoted = typeof body.promoted === 'boolean'
        ? body.promoted : (marker.promoted || record.btwMarker?.promoted === true);
      record.btwMarker = { ...marker, promoted };
      return true;
    }
    case 'btw.markPromoted': {
      if (!record.btwMarker) return false;
      record.btwMarker = { ...record.btwMarker, promoted: true };
      return true;
    }
    case 'btw.setChild': {
      const child = sessionID(body.childSessionID);
      if (child === undefined) return false;
      record.btwChildOf = child;
      return true;
    }
    case 'btw.clearChild': {
      const child = sessionID(body.childSessionID);
      if (child === undefined) return false;
      if (record.btwChildOf !== child) return true;
      delete record.btwChildOf;
      return true;
    }
    case 'pins.setMessages': {
      const pins = messagePinsOf(body.pins);
      if (pins === undefined) return false;
      if (pins.length === 0) delete record.messagePins; else record.messagePins = pins;
      return true;
    }
    case 'pins.setContext': {
      const notes = boundedIDs(body.notes);
      const plans = boundedIDs(body.plans);
      const signature = typeof body.knowledgeSignature === 'string'
        && (body.knowledgeSignature === '' || SIGNATURE_PATTERN.test(body.knowledgeSignature))
        ? body.knowledgeSignature : null;
      if (signature === null) return false;
      if (notes.length === 0 && plans.length === 0 && signature === '') {
        delete record.contextPins;
        delete record.knowledgeSignature;
        return true;
      }
      record.contextPins = { notes, plans };
      record.knowledgeSignature = signature;
      return true;
    }
    default: return false;
  }
}

export function registerSessionOrgRoutes(app: Hono): void {
  app.get('/api/session-org', (c) => {
    const directory = directoryFor(c.req.query('directory'));
    if (directory === undefined) return c.json({ error: 'directory is required' }, 400);
    if (!existsSync(storeFile())) return c.json({ version: 1, exists: false });
    const parsed = stored();
    if (parsed === null || !shapeValid(parsed)) {
      return c.json({ error: 'Stored session-organization records are malformed' }, 500);
    }
    const session = c.req.query('sessionID');
    if (session === undefined || session === '') {
      return c.json({ version: 1, records: parsed.records[directory] ?? {} });
    }
    if (!ID_PATTERN.test(session)) return c.json({ error: 'invalid sessionID' }, 400);
    const record = parsed.records[directory]?.[session];
    return record === undefined ? c.json({ version: 1, exists: false }) : c.json({ version: 1, record });
  });

  app.post('/api/session-org', async (c) => {
    let rawText: string;
    try { rawText = await c.req.text(); } catch { return c.json({ error: 'body read failed' }, 400); }
    if (Buffer.byteLength(rawText, 'utf8') > CAP) return c.json({ error: 'session-organization body too large' }, 413);
    let raw: unknown;
    try { raw = JSON.parse(rawText); } catch { return c.json({ error: 'body read failed' }, 400); }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return c.json({ error: 'body must be an object' }, 400);
    }
    const body = raw as Record<string, unknown>;
    const directory = directoryFor(body.directory);
    const session = sessionID(body.sessionID);
    if (directory === undefined || session === undefined) return c.json({ error: 'directory and sessionID are required' }, 400);
    const op = typeof body.op === 'string' ? body.op : '';
    let committed: SessionOrgRecord | null = null;
    try {
      await queueWrite(async (store) => {
        const directoryRecords = store.records[directory] ?? (store.records[directory] = {});
        const record = directoryRecords[session] ?? (directoryRecords[session] = {});
        if (!applySessionOrgOp(record, op, body)) throw new Error('invalid session-organization op');
        committed = record;
      });
    } catch (error) {
      const message = error instanceof Error && error.message === 'Stored session-organization records are malformed'
        ? error.message : 'invalid session-organization op';
      return c.json({ error: message }, message.startsWith('Stored') ? 500 : 400);
    }
    return c.json({ success: true, record: committed });
  });
}
