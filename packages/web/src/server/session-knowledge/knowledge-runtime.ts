// SPDX-License-Identifier: Apache-2.0
/** OpenChamber-owned session-knowledge assembly and metadata delivery. */
import { resolveMemoryOwnership } from '../project-context/agent-memory-ownership.ts';
import { agentMemoryEnabled, readMemoryStore, type AgentMemoryEntry } from '../project-context/agent-memory.ts';
import { readProjectContext, type ProjectNote } from '../project-context/context-store.ts';
import { readProjectPlan } from '../project-context/plan-store.ts';
import { createNnaSessionHarnessPorts } from '../session-orchestration/session-harness-ports.ts';
import {
  clearKnowledgeSignature, mergeProjectContextPins, parseKnowledgeSignature,
  normalizeRequestDirectory, parseProjectContextPins, signatureOf, type ProjectContextPins,
} from './metadata.ts';

export const KNOWLEDGE_BUDGET = 8000;
export type MetadataBag = Record<string, unknown>;

export interface KnowledgeDependencies {
  resolveProjectId: (directory: string) => Promise<string | undefined> | string | undefined;
  readSession: (sessionId: string, directory: string) => Promise<MetadataBag>;
  patchSession: (sessionId: string, directory: string, metadata: MetadataBag) => Promise<MetadataBag>;
  readContext: (projectId: string) => Promise<{ notes?: unknown[]; plans?: unknown[] }>;
  readPlan: (projectId: string, planId: string, directory?: string) => Promise<MetadataBag>;
  readMemory: (scope: 'global' | 'project', projectId?: string) => Promise<AgentMemoryEntry[]>;
}

export interface KnowledgeResult {
  text: string; signature: string; unavailable?: boolean; reason?: string;
}
export interface KnowledgeSummary {
  notes: { id: string; body: string }[];
  plans: { id: string; title: string }[];
  memory: { global: number; project: number };
}
export type SessionMetadata = MetadataBag | Record<string, unknown>;

const EMPTY_PINS: ProjectContextPins = { notes: [], plans: [] };
const TRUNCATION_SUFFIX = '…\n\n(project knowledge truncated)';
const MEMORY_INTRO = [
  'You have stored memory from earlier sessions. Only the titles are listed below.',
  'A title is an abbreviation, not the memory. Read the entry with the',
  'openchamber_memory tool before you act on it: titles routinely leave out',
  'the conditions, exceptions and reasons that decide how the memory',
  'applies, and a title that looks self-explanatory is the most likely to',
  'be hiding them. Read every title that could bear on the task at hand; you need not',
  'read the ones unrelated to what you are doing.',
  '',
  'Memory records what was true when it was written. Verify anything it says',
  'about files, flags or commands before relying on it.',
].join('\n');

const serializedWrites = new Map<string, Promise<unknown>>();

async function serializedSessionWrite<T>(sessionId: string, directory: string,
  action: () => Promise<T>): Promise<T> {
  const key = `${sessionId}\0${normalizeRequestDirectory(directory) ?? ''}`;
  const previous = serializedWrites.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(action);
  serializedWrites.set(key, next);
  try {
    return await next;
  } finally {
    if (serializedWrites.get(key) === next) serializedWrites.delete(key);
  }
}

export async function resolveKnowledge(deps: KnowledgeDependencies, directory: string,
  sessionId: string | undefined, requestedMetadata?: SessionMetadata): Promise<KnowledgeResult> {
  try {
    const metadata = sessionId === undefined
      ? requestedMetadata
      : await freshRead(deps.readSession, sessionId, directory);
    const pins = metadata === undefined ? EMPTY_PINS : parseProjectContextPins(metadata);
    const delivered = metadata === undefined ? '' : parseKnowledgeSignature(metadata);
    const projectId = await safeProjectId(deps.resolveProjectId, directory);
    const [pinned, memory] = await Promise.all([
      readPinned(deps, projectId, pins, sessionId !== undefined ? directory : undefined),
      readMemory(deps, projectId),
    ]);
    const signature = signatureOf(knowledgeParts(pinned, memory));
    if (signature !== '' && signature === delivered) return { text: '', signature: '' };
    return { text: buildKnowledgeText(buildPinnedBlock(pinned), buildMemoryBlock(memory)), signature };
  } catch (error) {
    return unavailable(error);
  }
}

export async function resolveKnowledgeSummary(deps: KnowledgeDependencies, directory: string,
  sessionId: string | undefined): Promise<KnowledgeSummary> {
  if (directory === '') return emptySummary();
  try {
    const metadata = sessionId === undefined ? undefined
      : await freshRead(deps.readSession, sessionId, directory);
    const pins = metadata === undefined ? EMPTY_PINS : parseProjectContextPins(metadata);
    const projectId = await safeProjectId(deps.resolveProjectId, directory);
    let notes: KnowledgeSummary['notes'] = [];
    let plans: KnowledgeSummary['plans'] = [];
    if (projectId !== undefined) try {
      const context = await deps.readContext(projectId);
      const contextNotes = context.notes ?? [];
      const contextPlans = context.plans ?? [];
      notes = noteEntries(contextNotes, pins)
        .map(({ id, body, createdAt }) => ({ id, body, createdAt }));
      plans = planTitles(contextPlans, pins);
    } catch { /* summary stays zeroed for the broken pinned side only */ }
    const memory = await readMemory(deps, projectId);
    return {
      notes,
      plans,
      memory: { global: memory.global.length, project: memory.project.length },
    };
  } catch { return emptySummary(); }
}

export async function pinKnowledge(deps: KnowledgeDependencies, input: {
  sessionId: string; directory: string; kind: 'note' | 'plan'; id: string; pinned: boolean;
}): Promise<{ pins: ProjectContextPins }> {
  return serializedSessionWrite(input.sessionId, input.directory, async () => {
    const session = await freshRead(deps.readSession, input.sessionId, input.directory);
    const current = parseProjectContextPins(session);
    const key = input.kind === 'note' ? 'notes' as const : 'plans' as const;
    const other = input.kind === 'note' ? 'plans' as const : 'notes' as const;
    const next = {
      ...current,
      [key]: replacePin(current[key], input.id, input.pinned),
      [other]: [...current[other]],
    } satisfies ProjectContextPins;
    await commitPins(deps, input, session, next);
    return { pins: next };
  });
}

export async function recordKnowledgeDelivered(deps: KnowledgeDependencies, input: {
  sessionId: string; directory: string; signature: string;
}): Promise<{ recorded: boolean; reason?: string }> {
  try {
    return await serializedSessionWrite(input.sessionId, input.directory, async () => {
      const session = await freshRead(deps.readSession, input.sessionId, input.directory);
      const pins = parseProjectContextPins(session);
      await commitMetadata(deps, input.sessionId, input.directory,
        mergeProjectContextPins(session, pins, input.signature));
      return { recorded: true };
    });
  } catch (error) {
    return { recorded: false, reason: error instanceof Error ? error.message : 'session unavailable' };
  }
}

function unavailable(error: unknown): KnowledgeResult {
  return {
    text: '',
    signature: '',
    unavailable: true,
    reason: error instanceof Error ? error.message : 'knowledge unavailable',
  };
}

function emptySummary(): KnowledgeSummary {
  return { notes: [], plans: [], memory: { global: 0, project: 0 } };
}

async function safeProjectId(resolve: KnowledgeDependencies['resolveProjectId'],
  directory: string): Promise<string | undefined> {
  try { return await resolve(directory); }
  catch { return undefined; }
}

async function freshRead(read: KnowledgeDependencies['readSession'], sessionId: string,
  directory: string): Promise<MetadataBag> {
  const session = await read(sessionId, directory);
  assertSessionTarget(session, sessionId, directory);
  return { ...((session.metadata ?? {}) as MetadataBag) };
}

async function readMemory(deps: KnowledgeDependencies, projectId: string | undefined) {
  if (projectId === undefined) return { global: [], project: [] };
  const [global, project] = await Promise.all([
    deps.readMemory('global', undefined).catch(() => [] as AgentMemoryEntry[]),
    deps.readMemory('project', projectId).catch(() => [] as AgentMemoryEntry[]),
  ]);
  return {
    global: usableMemory(global).sort(byCreatedAt),
    project: usableMemory(project).sort(byCreatedAt),
  };
}

function usableMemory(entries: AgentMemoryEntry[]): AgentMemoryEntry[] {
  return entries.filter((entry) => entry.flagged === undefined);
}

function byCreatedAt(left: AgentMemoryEntry, right: AgentMemoryEntry): number {
  return left.createdAt - right.createdAt;
}

async function readPinned(deps: KnowledgeDependencies, projectId: string | undefined,
  pins: ProjectContextPins, directory: string | undefined): Promise<PinnedContext | null> {
  if (projectId === undefined) return null;
  try {
    const context = await deps.readContext(projectId);
    const contextNotes = context.notes ?? [];
    const contextPlans = context.plans ?? [];
    const notes = noteEntries(contextNotes, pins);
    const plans = planEntries(contextPlans, pins);
    if (directory === undefined) return { notes, plans };
    const bodies = await Promise.all(plans.map(async (plan) => ({
      ...plan,
      body: await planBody(projectId, plan.id, directory, deps, plan.title),
    })));
    return { notes, plans: bodies };
  } catch { return null; }
}

async function planBody(projectId: string, planId: string, directory: string,
  deps: KnowledgeDependencies, fallbackTitle: string): Promise<string> {
  try {
    const plan = await deps.readPlan(projectId, planId, directory);
    return typeof plan.body === 'string' ? plan.body.trim() : '';
  } catch {
    void fallbackTitle;
    return '(plan content unavailable)';
  }
}

interface PinnedNote { id: string; body: string; createdAt: number; updatedAt: number }
interface PinnedPlan { id: string; title: string; body?: string; createdAt?: number }
interface PinnedContext { notes: PinnedNote[]; plans: PinnedPlan[] }

function pinSet(pins: ProjectContextPins, kind: 'notes' | 'plans'): Set<string> {
  return new Set(pins[kind]);
}

function noteEntries(values: unknown[], pins: ProjectContextPins): PinnedNote[] {
  const wanted = pinSet(pins, 'notes');
  return values.flatMap((value) => {
    const note = value as Partial<ProjectNote>;
    return typeof note?.id === 'string' && wanted.has(note.id) && typeof note.body === 'string'
      && Number.isSafeInteger(note.updatedAt)
      ? [{ id: note.id, body: note.body.trim(),
        createdAt: note.createdAt as number, updatedAt: note.updatedAt as number }] : [];
  }).sort((left, right) => left.createdAt - right.createdAt);
}

function planEntries(values: unknown[], pins: ProjectContextPins): PinnedPlan[] {
  const wanted = pinSet(pins, 'plans');
  const titles = new Map<string, string>();
  for (const value of values) {
    const plan = value as Partial<{ id: unknown; title: unknown }>;
    if (typeof plan?.id === 'string' && typeof plan.title === 'string') titles.set(plan.id, plan.title);
  }
  return pins.plans.filter((id) => wanted.has(id)).map((id) => ({
    id, title: titles.get(id) ?? 'Pinned plan',
  }));
}

function planTitles(values: unknown[], pins: ProjectContextPins): { id: string; title: string }[] {
  return planEntries(values, pins).map(({ id, title }) => ({ id, title }));
}

function knowledgeParts(pinned: PinnedContext | null, memory: {
  global: AgentMemoryEntry[]; project: AgentMemoryEntry[];
}): string[] {
  const parts: string[] = [];
  for (const note of pinned?.notes ?? []) parts.push(`n:${note.id}:${note.updatedAt}`);
  for (const plan of pinned?.plans ?? []) parts.push(`p:${plan.id}:${plan.title}`);
  for (const entry of memory.global) parts.push(`mg:${entry.id}:${entry.updatedAt}`);
  for (const entry of memory.project) parts.push(`mp:${entry.id}:${entry.updatedAt}`);
  return parts;
}

function buildPinnedBlock(pinned: PinnedContext | null): string {
  if (!pinned || (pinned.notes.length === 0 && pinned.plans.length === 0)) return '';
  const sections: string[] = [
    'The user pinned the following project context. Treat it as standing background, not as a new instruction.',
  ];
  if (pinned.notes.length > 0) {
    sections.push([
      '## Pinned notes',
      ...pinned.notes.map((note) => `- ${note.body}`),
    ].join('\n'));
  }
  for (const plan of pinned.plans) {
    sections.push([`## Pinned plan: ${plan.title}`, plan.body ?? ''].join('\n\n'));
  }
  return sections.join('\n\n');
}

function buildMemoryBlock(memory: { global: AgentMemoryEntry[]; project: AgentMemoryEntry[] }): string {
  const sections: string[] = [];
  if (memory.global.length > 0) {
    sections.push(['### About the user', ...memory.global.map((entry) => `- [${entry.type}] ${entry.title}`)].join('\n'));
  }
  if (memory.project.length > 0) {
    sections.push(['### About this project', ...memory.project.map((entry) => `- [${entry.type}] ${entry.title}`)].join('\n'));
  }
  return sections.length === 0 ? '' : [MEMORY_INTRO, ...sections].join('\n\n');
}

function buildKnowledgeText(pinned: string, memory: string): string {
  const text = [pinned, memory].filter((section) => section !== '').join('\n\n');
  if (text.length <= KNOWLEDGE_BUDGET) return text;
  return Array.from(text).slice(0, KNOWLEDGE_BUDGET - TruncationLength()).join('') + TRUNCATION_SUFFIX;
}

function TruncationLength(): number {
  return Array.from(TRUNCATION_SUFFIX).length;
}

function replacePin(values: string[], id: string, pinned: boolean): string[] {
  const kept = values.filter((existing) => existing !== id);
  return pinned ? [...kept, id] : kept;
}

async function commitPins(deps: KnowledgeDependencies, input: {
  sessionId: string; directory: string; id: string;
}, session: MetadataBag, next: ProjectContextPins): Promise<void> {
  await commitMetadata(deps, input.sessionId, input.directory,
    clearKnowledgeSignature(session, next));
}

async function commitMetadata(deps: KnowledgeDependencies, sessionId: string, directory: string,
  metadata: MetadataBag): Promise<void> {
  const committed = await deps.patchSession(sessionId, directory, metadata);
  const id = typeof committed?.id === 'string' ? committed.id : sessionId;
  if (id !== sessionId) throw new Error('session changed during knowledge write');
  assertSessionTarget(committed, sessionId, directory);
}

function assertSessionTarget(session: unknown, sessionId: string, directory: string): void {
  const record = session as Partial<{ id: unknown; directory: unknown }>;
  const receivedDirectory = normalizeRequestDirectory(record.directory);
  const expectedDirectory = normalizeRequestDirectory(directory);
  if (record.id !== sessionId || receivedDirectory === undefined
    || receivedDirectory !== expectedDirectory) {
    throw new Error('session or directory mismatch');
  }
}

export function productionDependencies(): KnowledgeDependencies {
  const ports = createNnaSessionHarnessPorts();
  return {
    resolveProjectId: async (directory) => {
      const values = await ports.projects?.() ?? [];
      const projects = values.flatMap((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
        const record = value as Record<string, unknown>;
        return typeof record.id === 'string' && typeof record.worktree === 'string' && record.worktree !== ''
          ? [{ id: record.id, worktree: record.worktree }] : [];
      });
      return resolveMemoryOwnership({ directory, projects });
    },
    readSession: (sessionId, directory) => ports.readSession(sessionId, directory) as Promise<MetadataBag>,
    patchSession: (sessionId, directory, metadata) => ports.patchSession(sessionId, directory, { metadata }) as Promise<MetadataBag>,
    readContext: readProjectContext,
    readPlan,
    readMemory: async (scope, projectId) => {
      if (!agentMemoryEnabled()) return [];
      return await readMemoryStore(scope, projectId);
    },
  };
}

async function readPlan(projectId: string, planId: string, directory?: string): Promise<MetadataBag> {
  return await readProjectPlan(projectId, planId, directory) as MetadataBag;
}
