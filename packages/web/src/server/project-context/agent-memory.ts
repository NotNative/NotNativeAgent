// SPDX-License-Identifier: Apache-2.0
/** Agent-owned memory ledger; separate from user-written project context. */
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { ENV } from '../env.ts';
import { withConfigLock } from '../scheduled/config-lock.ts';
import { readMergedSettings } from '../lib/settings-store.ts';

export type AgentMemoryScope = 'global' | 'project';

export interface AgentMemoryEntry {
  id: string; title: string; body: string; type: 'fact' | 'preference' | 'reference';
  createdAt: number; updatedAt: number; sessionId?: string; flagged?: string;
}

const MAX_TITLE = 60;
const MAX_BODY = 2000;
const GLOBAL_CAP = 60;
const PROJECT_CAP = 200;
const STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from',
  'has', 'have', 'in', 'into', 'is', 'it', 'its', 'not', 'of', 'on', 'or', 'that', 'the', 'their',
  'them', 'they', 'this', 'to', 'was', 'were', 'when', 'with']);
const THREAT_PATTERNS = [
  /ignore\s+(?:(?:all|any|the)\s+)?(?:previous|prior|earlier|above|existing)\s+(?:instructions|prompts|rules|context)/iu,
  /disregard\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|earlier|above|existing)\s+(?:instructions|prompts|rules|context)/iu,
  /forget\s+(?:everything|all\s+you(?:\s+(?:have|were\s+taught))?|the\s+above|what\s+you\s+know)/iu,
  /override\s+(?:your\s+)?(?:system\s+)?(?:prompt|prompts|instructions|context)/iu,
  /you\s+are\s+now\s+(?:a|an|the)\s+./iu,
  /(?:^|\n)\s*system\s*:/iu,
  /(?:^|\n)\s*assistant\s*:/iu,
  /(?:^|\n)\s*developer\s*:/iu,
  /<\|\s*im_start\s*\|>/iu,
  /\[\/?inst\]/iu,
  /(?:bypass|disable|turn\s+off)\s+(?:all\s+)?(?:safety|security|guardrails|filters|restrictions)/iu,
  /(?:developer|god)mode\s+(?:enabled|on|activated)/iu,
  /(?:print|reveal|repeat|output|show\s+me)\s+(?:your|the)\s+(?:system\s+prompt|instructions|initial\s+prompt)/iu,
  /(?:send|post|upload|exfiltrate)\s+(?:the|your)\s+(?:api\s+key|token|credentials|secrets|env)/iu,
];

export function memoryAvailabilityFlag(): boolean {
  return /^(?:1|true|yes|on)$/iu.test((process.env.OPENCHAMBER_MEMORY_ENABLE ?? '').trim());
}

export function agentMemoryEnabled(): boolean {
  return memoryAvailabilityFlag() && readMergedSettings('web').agentMemoryToolEnabled === true;
}

function projectIdFor(projectId: unknown): string {
  if (typeof projectId !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(projectId)) {
    throw new Error('invalid project ID');
  }
  return projectId;
}

function pathFor(scope: AgentMemoryScope, projectId?: string): string {
  return scope === 'global' ? join(ENV.dataDir, 'memory.json') : join(ENV.dataDir, 'projects', projectIdFor(projectId), 'memory.json');
}

function clampText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return Array.from(trimmed).slice(0, max).join('');
}

function normalizeEntry(value: unknown): AgentMemoryEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : randomUUID();
  const title = clampText(raw.title, MAX_TITLE);
  const body = clampText(raw.body, MAX_BODY);
  if (!title || !body) return null;
  const createdAt = Number(raw.createdAt);
  const updatedAt = Number(raw.updatedAt);
  const now = Date.now();
  const entry: AgentMemoryEntry = {
    id, title, body,
    type: raw.type === 'preference' || raw.type === 'reference' ? raw.type : 'fact',
    createdAt: Number.isFinite(createdAt) && createdAt >= 0 ? createdAt : now,
    updatedAt: Number.isFinite(updatedAt) && updatedAt >= 0 ? updatedAt : (Number.isFinite(createdAt) && createdAt >= 0 ? createdAt : now),
  };
  if (typeof raw.sessionId === 'string' && raw.sessionId !== '') entry.sessionId = raw.sessionId;
  return entry;
}

function asStore(value: unknown): AgentMemoryEntry[] {
  if (!value) return [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('malformed agent memory');
  const doc = value as { version?: unknown; entries?: unknown };
  if (doc.version !== 1 || !Array.isArray(doc.entries)) throw new Error('malformed agent memory');
  return doc.entries.map(normalizeEntry).filter((entry): entry is AgentMemoryEntry => entry !== null);
}

function memoryCap(scope: AgentMemoryScope): number {
  return scope === 'global' ? GLOBAL_CAP : PROJECT_CAP;
}

export async function readMemoryStore(scope: AgentMemoryScope, projectId?: string): Promise<AgentMemoryEntry[]> {
  const path = pathFor(scope, projectId);
  let text: string | undefined;
  try { text = await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return [];
    throw error;
  }
  return asStore(JSON.parse(text) as unknown).sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, memoryCap(scope)).map((entry) => {
    const threat = THREAT_PATTERNS.find((pattern) => pattern.test(`${entry.title}\n${entry.body}`));
    return threat ? { ...entry, flagged: patternSignature(threat) } : entry;
  }).sort((left, right) => right.updatedAt - left.updatedAt);
}

function patternSignature(pattern: RegExp): string {
  return pattern.toString().slice(0, 80);
}

async function writeStore(path: string, entries: AgentMemoryEntry[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  const ordered = entries.map(storageEntry);
  await writeFile(temporary, `${JSON.stringify({ version: 1, entries: ordered }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
}

function tokensFor(value: string): string[] {
  return value.toLowerCase().split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function duplicate(existing: AgentMemoryEntry[], title: string, body: string): number | null {
  const exact = existing.findIndex((entry) => entry.title.toLowerCase() === title.toLowerCase());
  if (exact >= 0) return exact;
  const incoming = tokensFor(`${title}\n${body}`);
  if (incoming.length < 4) return null;
  let bestIndex = -1;
  let bestScore = 0;
  existing.forEach((entry, index) => {
    const stored = new Set(tokensFor(`${entry.title}\n${entry.body}`));
    const shared = incoming.reduce((count, token) => stored.has(token) ? count + 1 : count, 0);
    const score = shared / incoming.length;
    if (score > bestScore) { bestIndex = index; bestScore = score; }
  });
  return bestScore >= 0.75 && bestIndex >= 0 ? bestIndex : null;
}

function storageEntry(value: AgentMemoryEntry): Omit<AgentMemoryEntry, 'flagged'> {
  return {
    id: value.id, title: value.title, body: value.body, type: value.type,
    createdAt: value.createdAt, updatedAt: value.updatedAt,
    ...(typeof value.sessionId === 'string' ? { sessionId: value.sessionId } : {}),
  };
}

async function scoped<T>(scope: AgentMemoryScope, projectId: string | undefined, action: () => Promise<T>): Promise<T> {
  const path = pathFor(scope, projectId);
  return withConfigLock(`${path}.lock`, action);
}

export async function createMemoryEntry(projectId: string | undefined, input: {
  title: unknown; body: unknown; type?: unknown; sessionId?: unknown; scope?: AgentMemoryScope;
}): Promise<{ saved: true; memory: AgentMemoryEntry; replaced: boolean; warning?: string }> {
  const scope = input.scope === 'global' ? 'global' : 'project';
  const title = clampText(input.title, MAX_TITLE);
  const body = clampText(input.body, MAX_BODY);
  if (!title || !body) throw new Error('agent memory title and body are required');
  const sessionId = typeof input.sessionId === 'string' && input.sessionId !== '' ? input.sessionId : undefined;
  return scoped(scope, projectId, async () => {
    const entries = await readMemoryStore(scope, projectId);
    const index = duplicate(entries, title, body);
    const threat = THREAT_PATTERNS.find((pattern) => pattern.test(`${title}\n${body}`));
    const now = Date.now();
    const base: AgentMemoryEntry = index !== null ? { ...entries[index]!, updatedAt: now }
      : { id: randomUUID(), title, body, type: 'fact', createdAt: now, updatedAt: now, sessionId };
    if (index !== null) {
      base.title = title; base.body = body;
      if (typeof input.sessionId === 'string' && input.sessionId !== '') base.sessionId = input.sessionId;
    }
    base.type = input.type === 'preference' || input.type === 'reference' ? input.type : 'fact';
    if (threat) base.flagged = patternSignature(threat);
    if (index !== null) entries[index] = base;
    else entries.push(base);
    const cap = scope === 'global' ? GLOBAL_CAP : PROJECT_CAP;
    if (entries.length > cap) {
      throw new Error(`agent memory is full (${entries.length} entries). Stored titles: ${entries.map((entry) => entry.title).join('; ')}. Save under an existing title to consolidate, or delete stale entries and retry`);
    }
    await writeStore(pathFor(scope, projectId), entries);
    const { flagged, ...memory } = base;
    return { saved: true as const, memory, replaced: index !== null, warning: flagged ? WARNING : undefined };
  });
}

const WARNING = 'Stored, but held back from future sessions: this text reads as an instruction to the model rather than a fact. The user can see it in the Memory panel.';

export async function updateMemoryEntry(projectId: string | undefined, memoryId: string, input: {
  scope: AgentMemoryScope; title?: unknown; body?: unknown; type?: unknown;
}): Promise<{ entry: AgentMemoryEntry; entries: AgentMemoryEntry[] }> {
  if (!memoryId) throw new Error('memory id is required');
  const supplied = ['title', 'body', 'type'].some((field) => input[field as keyof typeof input] !== undefined);
  if (!supplied) throw new Error('no agent memory fields supplied');
  return scoped(input.scope, projectId, async () => {
    const entries = await readMemoryStore(input.scope, projectId);
    const index = entries.findIndex((entry) => entry.id === memoryId);
    if (index < 0) throw new Error('memory entry not found');
    if (input.title !== undefined) {
      const title = clampText(input.title, MAX_TITLE);
      if (!title) throw new Error('invalid agent memory title');
      entries[index]!.title = title;
    }
    if (input.body !== undefined) {
      const body = clampText(input.body, MAX_BODY);
      if (!body) throw new Error('invalid agent memory body');
      entries[index]!.body = body;
    }
    if (input.type !== undefined) {
      if (input.type !== 'fact' && input.type !== 'preference' && input.type !== 'reference') {
        throw new Error('invalid agent memory type');
      }
      entries[index]!.type = input.type;
    }
    entries[index]!.updatedAt = Date.now();
    await writeStore(pathFor(input.scope, projectId), entries);
    const threat = THREAT_PATTERNS.find((pattern) => pattern.test(`${entries[index]!.title}\n${entries[index]!.body}`));
    const entry = threat ? { ...entries[index]!, flagged: patternSignature(threat) } : entries[index]!;
    return { entry: entry, entries };
  });
}

export async function deleteMemoryEntry(projectId: string | undefined, scope: AgentMemoryScope, memoryId: string): Promise<boolean> {
  return scoped(scope, projectId, async () => {
    const entries = await readMemoryStore(scope, projectId);
    const index = entries.findIndex((entry) => entry.id === memoryId);
    if (index < 0) return false;
    entries.splice(index, 1);
    await writeStore(pathFor(scope, projectId), entries);
    return true;
  });
}
