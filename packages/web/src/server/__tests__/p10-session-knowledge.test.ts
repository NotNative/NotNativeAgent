// SPDX-License-Identifier: Apache-2.0
/** P10-53 session knowledge: pins and the delivered signature now live in
 * the NND-owned session-org store (legacy metadata stays the read fallback).
 * The data dir is isolated before the dynamic imports below. */
import { mkdtempSync, rmSync } from 'node:fs';import { tmpdir } from 'node:os';
import { join as joinPath, sep } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { AgentMemoryEntry } from '../project-context/agent-memory.ts';

const isolatedDataDir = mkdtempSync(`${tmpdir()}${sep}nnd-data-knowledge-`);
process.env.NOTNATIVE_DATA_DIR = isolatedDataDir;

const DIRECTORY = 'C:/repo/alpha';
const MEMORY_SIGNATURE = 'mg-signature';

interface TestState {
  metadata: Record<string, unknown> | undefined;
  plans: Map<string, string>;
  memory: { global: AgentMemoryEntry[]; project: AgentMemoryEntry[] };
}

let state: TestState;
let pinKnowledge: typeof import('../session-knowledge/knowledge-runtime.ts').pinKnowledge;
let recordKnowledgeDelivered: typeof import('../session-knowledge/knowledge-runtime.ts').recordKnowledgeDelivered;
let resolveKnowledge: typeof import('../session-knowledge/knowledge-runtime.ts').resolveKnowledge;
let resolveKnowledgeSummary: typeof import('../session-knowledge/knowledge-runtime.ts').resolveKnowledgeSummary;
let productionDependencies: typeof import('../session-knowledge/knowledge-runtime.ts').productionDependencies;
let registerSessionKnowledgeRoutes: typeof import('../session-knowledge/session-knowledge-routes.ts').registerSessionKnowledgeRoutes;
let signatureOf: typeof import('../session-knowledge/metadata.ts').signatureOf;
let parseKnowledgeSignature: typeof import('../session-knowledge/metadata.ts').parseKnowledgeSignature;
let parseProjectContextPins: typeof import('../session-knowledge/metadata.ts').parseProjectContextPins;
let readSessionOrgRecord: typeof import('../routes/session-org.ts').readSessionOrgRecord;

function memoryEntry(id: string, title: string, createdAt: number, type: AgentMemoryEntry['type']): AgentMemoryEntry {
  return { id, title, type, createdAt, updatedAt: createdAt, body: 'restricted body' };
}

type KnowledgeDependencies = import('../session-knowledge/knowledge-runtime.ts').KnowledgeDependencies;
type MetadataBag = import('../session-knowledge/knowledge-runtime.ts').MetadataBag;

function deps(): KnowledgeDependencies {
  return {
    resolveProjectId: () => 'alpha',
    readSession: async (sessionId, directory) => {
      if (sessionId !== 'session-1' || directory.replaceAll('\\', '/') !== DIRECTORY) {
        throw new Error('unknown session');
      }
      return { id: sessionId, directory, metadata: state.metadata };
    },
    patchSession: async (sessionId, directory, body) => {
      state.metadata = body as MetadataBag;
      return { id: sessionId, directory, metadata: state.metadata };
    },
    readContext: async () => ({
      notes: [
        { id: 'note-2', body: 'Second note', createdAt: 20, updatedAt: 21 },
        { id: 'note-1', body: ' First note ', createdAt: 10, updatedAt: 11 },
      ],
      plans: [
        { id: 'plan-2', title: 'Second plan' },
        { id: 'plan-1', title: 'First plan' },
      ],
    }),
    readPlan: async (_projectId, planId) => {
      const body = state.plans.get(planId);
      if (body === undefined) throw new Error('plan unavailable');
      return { id: planId, title: planId, body };
    },
    readMemory: async (scope) => scope === 'global' ? state.memory.global : state.memory.project,
  };
}

beforeAll(async () => {
  const runtime = await import('../session-knowledge/knowledge-runtime.ts');
  const metadata = await import('../session-knowledge/metadata.ts');
  const routes = await import('../session-knowledge/session-knowledge-routes.ts');
  const org = await import('../routes/session-org.ts');
  pinKnowledge = runtime.pinKnowledge;
  recordKnowledgeDelivered = runtime.recordKnowledgeDelivered;
  resolveKnowledge = runtime.resolveKnowledge;
  resolveKnowledgeSummary = runtime.resolveKnowledgeSummary;
  productionDependencies = runtime.productionDependencies;
  registerSessionKnowledgeRoutes = routes.registerSessionKnowledgeRoutes;
  signatureOf = metadata.signatureOf;
  parseKnowledgeSignature = metadata.parseKnowledgeSignature;
  parseProjectContextPins = metadata.parseProjectContextPins;
  readSessionOrgRecord = org.readSessionOrgRecord;
});

beforeEach(() => {
  rmSync(joinPath(isolatedDataDir, 'session-org.json'), { force: true });
  state = {
    metadata: undefined,
    plans: new Map([['plan-1', 'Plan body']]),
    memory: {
      global: [memoryEntry('g2', 'Second', 20, 'preference'), memoryEntry('g1', 'First', 10, 'fact')],
      project: [memoryEntry('p1', 'Project', 15, 'fact')],
    },
  };
});

afterAll(() => { rmSync(isolatedDataDir, { recursive: true, force: true }); });

describe('P10-53 session knowledge', () => {
  it('represents an empty knowledge set as no signature', () => {
    expect(signatureOf([])).toBe('');
  });

  it('assembles pins and memory in contract order and signs every content identity', async () => {
    state.metadata = { client: 'keep', openchamber: {
      projectId: 'alpha',
      project_context_pins: { notes: ['note-2', 'note-1'], plans: ['plan-1', 'missing'] },
    } };
    const result = await resolveKnowledge(deps(), DIRECTORY, 'session-1');
    expect(result.text).toContain('- First note\n- Second note');
    expect(result.text).toContain('## Pinned plan: First plan\n\nPlan body');
    expect(result.text).toContain('### About the user');
    expect(result.text).toContain('- [fact] First\n- [preference] Second');
    expect(result.text).toContain('### About this project');
    expect(result.text).toContain('[fact] Project');
    expect(result.text).not.toContain('restricted body');
    expect(signatureOf([
      'n:note-1:11', 'n:note-2:21', 'p:plan-1:First plan', 'p:missing:Pinned plan',
      'mg:g1:10', 'mg:g2:20', 'mp:p1:15',
    ])).toBe(result.signature);
  });

  it('re-delivers an edited note that keeps its create timestamp', async () => {
    state.metadata = { openchamber: {
      knowledge_context_delivered: signatureOf([
        'n:note-1:10', 'n:note-2:20', 'p:plan-1:First plan', 'p:missing:Pinned plan',
        'mg:g1:10', 'mg:g2:20', 'mp:p1:15',
      ]),
      project_context_pins: { notes: ['note-2', 'note-1'], plans: ['plan-1', 'missing'] },
    } };
    const result = await resolveKnowledge(deps(), DIRECTORY, 'session-1');
    expect(result.text).toContain('First note');
    expect(result.signature).toBe(signatureOf([
      'n:note-1:11', 'n:note-2:21', 'p:plan-1:First plan', 'p:missing:Pinned plan',
      'mg:g1:10', 'mg:g2:20', 'mp:p1:15',
    ]));
  });

  it('suppresses already delivered knowledge and refreshes after pinning in the org store', async () => {
    state.metadata = {};
    const first = await resolveKnowledge(deps(), DIRECTORY, 'session-1');
    const recorded = await recordKnowledgeDelivered(deps(), {
      sessionId: 'session-1', directory: DIRECTORY, signature: first.signature,
    });
    expect(recorded).toEqual({ recorded: true });
    expect(readSessionOrgRecord(DIRECTORY, 'session-1')?.knowledgeSignature).toBe(first.signature);
    expect((await resolveKnowledge(deps(), DIRECTORY, 'session-1')).text).toBe('');
    await pinKnowledge(deps(), {
      sessionId: 'session-1', directory: DIRECTORY, kind: 'note', id: 'note-1', pinned: true,
    });
    const record = readSessionOrgRecord(DIRECTORY, 'session-1');
    expect(record?.contextPins).toEqual({ notes: ['note-1'], plans: [] });
    expect(record?.knowledgeSignature).toBe(''); // cleared so knowledge re-delivers
  });

  it('serializes a concurrent pin toggle with delivery recording', async () => {
    state.metadata = {};
    const dependencies = deps();
    const [pinned, delivered] = await Promise.all([
      pinKnowledge(dependencies, {
        sessionId: 'session-1', directory: DIRECTORY, kind: 'note', id: 'note-1', pinned: true,
      }),
      recordKnowledgeDelivered(dependencies, {
        sessionId: 'session-1', directory: DIRECTORY,
        signature: signatureOf(['mg:g1:10', 'mg:g2:20', 'mp:p1:15']),
      }),
    ]);
    expect(pinned).toEqual({ pins: { notes: ['note-1'], plans: [] } });
    expect(delivered).toEqual({ recorded: true });
    // The serialized writes land one after the other in the store; the final
    // pairing is one of the valid serial orders, never a torn mix.
    const record = readSessionOrgRecord(DIRECTORY, 'session-1');
    const outcomes: { contextPins?: { notes: string[]; plans: string[] }; knowledgeSignature?: string }[] = [
      { contextPins: { notes: ['note-1'], plans: [] }, knowledgeSignature: '' },
      { contextPins: { notes: [], plans: [] }, knowledgeSignature: signatureOf(['mg:g1:10', 'mg:g2:20', 'mp:p1:15']) },
      { contextPins: { notes: ['note-1'], plans: [] }, knowledgeSignature: signatureOf(['mg:g1:10', 'mg:g2:20', 'mp:p1:15']) },
    ];
    expect(outcomes).toContainEqual({ contextPins: record?.contextPins, knowledgeSignature: record?.knowledgeSignature });
  });

  it('summarizes pinned titles and memory counts, including an unavailable plan', async () => {
    state.metadata = { openchamber: {
      project_context_pins: { notes: ['note-1'], plans: ['plan-2'] },
    } };
    state.plans.delete('plan-2');
    const summary = await resolveKnowledgeSummary(deps(), DIRECTORY, 'session-1');
    expect(parseProjectContextPins(state.metadata)).toEqual({ notes: ['note-1'], plans: ['plan-2'] });
    expect(summary).toEqual({
      notes: [{ id: 'note-1', body: 'First note', createdAt: 10 }],
      plans: [{ id: 'plan-2', title: 'Second plan' }],
      memory: { global: 2, project: 1 },
    });
    expect(await resolveKnowledgeSummary(deps(), 'C:/does/not/exist', 'session-1'))
      .toEqual({ notes: [], plans: [], memory: { global: 0, project: 0 } });
  });
});
