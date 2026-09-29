// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { registerSessionKnowledgeRoutes } from '../session-knowledge/session-knowledge-routes.ts';
import {
  productionDependencies, pinKnowledge, recordKnowledgeDelivered, resolveKnowledge,
  resolveKnowledgeSummary, type KnowledgeDependencies, type MetadataBag,
} from '../session-knowledge/knowledge-runtime.ts';
import { signatureOf } from '../session-knowledge/metadata.ts';
import type { AgentMemoryEntry } from '../project-context/agent-memory.ts';
import { parseKnowledgeSignature, parseProjectContextPins } from '../session-knowledge/metadata.ts';

const DIRECTORY = 'C:/repo/alpha';

interface TestState {
  metadata: MetadataBag | undefined;
  pins: { notes: unknown[]; plans: unknown[] };
  plans: Map<string, string>;
  memory: { global: AgentMemoryEntry[]; project: AgentMemoryEntry[] };
}

let state: TestState;

function memoryEntry(id: string, title: string, createdAt: number, type: AgentMemoryEntry['type']): AgentMemoryEntry {
  return { id, title, type, createdAt, updatedAt: createdAt, body: 'restricted body' };
}

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

beforeEach(() => {
  state = {
    metadata: undefined,
    pins: { notes: [], plans: [] },
    plans: new Map([['plan-1', 'Plan body']]),
    memory: {
      global: [memoryEntry('g2', 'Second', 20, 'preference'), memoryEntry('g1', 'First', 10, 'fact')],
      project: [memoryEntry('p1', 'Project', 15, 'fact')],
    },
  };
});

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

  it('suppresses already delivered knowledge and refreshes after pinning', async () => {
    state.metadata = {};
    const first = await resolveKnowledge(deps(), DIRECTORY, 'session-1');
    const recorded = await recordKnowledgeDelivered(deps(), {
      sessionId: 'session-1', directory: DIRECTORY, signature: first.signature,
    });
    expect(recorded).toEqual({ recorded: true });
    expect(state.metadata).toMatchObject({ openchamber: { knowledge_context_delivered: first.signature } });
    expect((await resolveKnowledge(deps(), DIRECTORY, 'session-1')).text).toBe('');
    await pinKnowledge(deps(), {
      sessionId: 'session-1', directory: DIRECTORY, kind: 'note', id: 'note-1', pinned: true,
    });
    expect(state.metadata).toMatchObject({
      openchamber: {
        project_context_pins: { notes: ['note-1'] },
        knowledge_context_delivered: '',
      },
    });
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
    expect(parseProjectContextPins(state.metadata)).toEqual({ notes: ['note-1'], plans: [] });
    expect(parseKnowledgeSignature(state.metadata))
      .toBe(signatureOf(['mg:g1:10', 'mg:g2:20', 'mp:p1:15']));
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

  it('exposes additive routes with bounded errors and delivery bookkeeping', async () => {
    const app = new Hono();
    registerSessionKnowledgeRoutes(app, deps());
    state.metadata = { openchamber: {
      project_context_pins: { notes: ['note-1'], plans: [] },
    } };
    const pending = await app.request('/api/session-knowledge?directory=C%3A%2Frepo%2Falpha&sessionId=session-1');
    expect(pending.status).toBe(200);
    const pendingBody = await pending.json() as { text: string; signature: string };
    expect(pendingBody.text).toContain('First note');

    const delivered = await app.request('/api/session-knowledge/delivered', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-1', directory: DIRECTORY, signature: pendingBody.signature }),
    });
    expect(await delivered.json()).toEqual({ recorded: true });

    const pin = await app.request('/api/session-knowledge/pin', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-1', directory: DIRECTORY, kind: 'plan', id: 'plan-1', pinned: true }),
    });
    expect(await pin.json()).toEqual({ pins: { notes: ['note-1'], plans: ['plan-1'] } });

    const invalid = await app.request('/api/session-knowledge/pin', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-1' }),
    });
    expect(invalid.status).toBe(400);

    const broken = await app.request('/api/session-knowledge?directory=C%3A%2Fother&sessionId=session-1');
    expect(await broken.json()).toMatchObject({ text: '', signature: '', unavailable: true });
  });
});

export { productionDependencies };
