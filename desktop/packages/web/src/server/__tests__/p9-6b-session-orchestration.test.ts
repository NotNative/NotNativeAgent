// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  createSession,
  sendSession,
  archiveSessionIds,
  registerOpenChamberSessionRoutes,
  type OrchestratorDeps,
  type WorktreeRequest,
} from '../session-orchestration/openchamber-sessions.ts';
import { WorktreeCreatedError } from '../session-orchestration/session-worktree.ts';

type D = OrchestratorDeps;
type Session = Record<string, unknown>;
type State = {
  providers: unknown[];
  agents: unknown[];
  commands: unknown[];
  configs: unknown[];
  sessions: Session[];
  messages: unknown[];
  sent: Record<string, unknown>[];
  goals: Record<string, unknown>[];
  calls: { createSession: number; readMessages: number; send: number };
};

let state: State;

function harness(deps: Partial<D> = {}): D {
  const call = async <T>(value: T): Promise<T> => value;
  const ports: D['harness'] = {
    providers: async () => state.providers as never,
    agents: async () => state.agents as never,
    config: async () => (state.configs.at(-1) ?? {}) as Record<string, unknown>,
    commands: async () => state.commands as never,
    createSession: async (directory, title) => {
      state.calls.createSession += 1;
      const id = `s${state.calls.createSession}`;
      const session = { id, title, directory, time: { updated: 0 } };
      state.sessions.push(session);
      state.messages.push({ info: { id: `${id}-user`, role: 'user', agent: 'build', model: { providerID: 'nna', modelID: 'test-model' } } });
      return session;
    },
    readSession: async (sessionId) => {
      const session = state.sessions.find((entry) => entry.id === sessionId);
      if (session === undefined) throw new Error('unknown session');
      return session;
    },
    readMessages: async (sessionId) => {
      state.calls.readMessages += 1;
      if (sessionId === 'missing') throw new Error('unknown session');
      return state.messages;
    },
    sendPrompt: async (_, __, body) => {
      state.calls.send += 1;
      state.sent.push(body);
      state.messages.push({ info: { id: `sent-${state.calls.send}`, role: 'user', agent: body.agent, model: body.model } });
      return { ok: true, status: 204 };
    },
    sendCommand: async (_, __, body) => {
      state.calls.send += 1;
      state.sent.push(body);
      state.messages.push({ info: { id: `sent-${state.calls.send}`, role: 'user', agent: body.agent, model: body.model } });
      return { ok: true, status: 204 };
    },
    forkSession: async (_, directory) => {
      const id = `fork-${state.sessions.length}`;
      const fork = { id, directory, title: 'Fork', time: { updated: 0 } };
      state.sessions.push(fork);
      return fork;
    },
    archiveSession: async (sessionId) => state.sessions.some((session) => session.id === sessionId),
    writeGoal: async (_, __, body) => {
      state.goals.push(body);
      return true;
    },
    patchSession: async (sessionId, __, body) => {
      const session = state.sessions.find((entry) => entry.id === sessionId);
      if (session === undefined) throw new Error('unknown session');
      if (body.metadata && typeof body.metadata === 'object') {
        session.metadata = { ...(session.metadata ?? {}) as Record<string, unknown>, ...(body.metadata as Record<string, unknown>) };
      }
      return session;
    },
  };
  void call;
  return {
    harness: ports,
    directoryExists: async () => true,
    now: () => 42,
    ...deps,
  };
}

const providers = [
  { id: 'nna', models: { 'test-model': { id: 'test-model' }, 'validator': { id: 'validator' } } },
];
const agents = [{ name: 'build', mode: 'primary', model: 'nna/agent-model' }, { name: 'sub', mode: 'subagent' }];
const config = [{ default_agent: 'build', model: 'nna/config-model' }];

beforeEach(() => {
  state = { providers, agents, commands: [], configs: config, sessions: [], messages: [], sent: [], goals: [], calls: { createSession: 0, readMessages: 0, send: 0 } };
});

describe('P9-6b session orchestration', () => {
  it('rejects invalid prompt selection before a side effect', async () => {
    const result = await createSession(harness(), {
      scope: { directory: 'C:/repo' }, prompt: 'do it',
      selection: { model: 'nna/not-real' },
    });
    expect(result).toEqual({ ok: false, failure: { status: 400, error: "Unknown model 'nna/not-real'" } });
    expect(state.calls.createSession).toBe(0);
  });

  it('resolves an explicit model with the default primary agent', async () => {
    const result = await createSession(harness(), {
      scope: { directory: 'C:/repo' }, prompt: 'do it',
      selection: { model: 'nna/test-model' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body.model).toBe('nna/test-model');
      expect(result.body.agent).toBe('build');
      expect(result.body.promptDispatched).toBe(true);
    }
    expect(state.calls.createSession).toBe(1);
    expect(state.calls.send).toBe(1);
    expect(state.sent[0]?.model).toEqual({ providerID: 'nna', modelID: 'test-model' });
    expect(state.sent[0]?.agent).toBe('build');
  });

  it('carries the per-run selection into the per-session route on create and fork', async () => {
    const deps = harness();
    const createRoutes: unknown[] = [];
    const forkBodies: Record<string, unknown>[] = [];
    const previousCreate = deps.harness.createSession;
    deps.harness.createSession = async (directory, title, route) => {
      createRoutes.push(route);
      return previousCreate(directory, title, route);
    };
    const previousFork = deps.harness.forkSession;
    deps.harness.forkSession = async (sessionId, directory, body) => {
      forkBodies.push(body ?? {});
      return previousFork(sessionId, directory, body);
    };
    const created = await createSession(deps, {
      scope: { directory: 'C:/repo' }, prompt: 'run', selection: { model: 'nna/test-model' },
    });
    expect(created.ok).toBe(true);
    expect(createRoutes.at(-1)).toEqual({ providerID: 'nna', model: 'test-model' });
    const forked = await sendSession(deps, 's1', {
      scope: { directory: 'C:/repo' }, prompt: 'again', selection: { model: 'nna/validator' },
    }, true);
    expect(forked.ok).toBe(true);
    expect(forkBodies.at(-1)).toEqual({ providerID: 'nna', model: 'validator' });
    // No explicit selection: the fork inherits the latest selected model
    // (selectedOf scans the newest user row, which the fork dispatch wrote).
    const plain = await sendSession(deps, 's1', {
      scope: { directory: 'C:/repo' }, prompt: 'plain', selection: {},
    }, true);
    expect(plain.ok).toBe(true);
    expect(forkBodies.at(-1)).toEqual({ providerID: 'nna', model: 'validator' });
  });

  it('validates an explicit selection before creating a worktree', async () => {
    const deps = harness({
      createWorktree: async () => {
        throw new Error('worktree creation should not run');
      },
    });
    const result = await createSession(deps, {
      scope: { directory: 'C:/repo' }, prompt: 'do it',
      selection: { model: 'nna/not-real' },
      worktree: { mode: 'new', name: 'topic', branchName: 'topic' },
    });
    expect(result).toEqual({ ok: false, failure: { status: 400, error: "Unknown model 'nna/not-real'" } });
  });

  it('reports a worktree that exists after bootstrap setup as worktree-created', async () => {
    const deps = harness({
      createWorktree: async () => {
        throw new WorktreeCreatedError('git branch tracking failed', {
          directory: 'C:/repo-topic', branch: 'topic',
        });
      },
    });
    const result = await createSession(deps, {
      scope: { directory: 'C:/repo' }, prompt: 'do it',
      selection: { model: 'nna/test-model' },
      worktree: { mode: 'new', name: 'topic', branchName: 'topic' },
    });
    expect(result).toEqual({
      ok: false,
      failure: {
        status: 500, error: 'git branch tracking failed', partial: true,
        partialAction: 'worktree-created', directory: 'C:/repo-topic',
      },
    });
  });

  it('normalizes worktree aliases, optional branch names, titles, and top-level upstream', async () => {
    const deps = harness();
    let requested: WorktreeRequest | undefined;
    deps.createWorktree = async (_, request) => {
      requested = request;
      return { directory: 'C:/repo-topic', branch: 'topic' };
    };
    const app = new Hono();
    registerOpenChamberSessionRoutes(app, deps);
    const response = await app.request('/api/openchamber/sessions', {
      method: 'POST',
      body: JSON.stringify({ directory: 'C:/repo', title: 'Topic', worktree: 'topic', setUpstream: true }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ title: 'Topic', directory: 'C:/repo-topic' });
    expect(requested).toEqual({ mode: 'new', name: 'topic', branchName: 'topic', setUpstream: true });
  });

  it('uses a supplied title for a harness session', async () => {
    const deps = harness();
    const result = await createSession(deps, { scope: { directory: 'C:/repo' }, title: 'Topic' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body.title).toBe('Topic');
  });

  it('plants a new goal with its exact budget before prompt dispatch', async () => {
    const result = await createSession(harness(), {
      scope: { directory: 'C:/repo' }, prompt: 'build the lakehouse',
      selection: { model: 'nna/test-model', agent: 'build' },
      goal: true, goalTokenBudget: 2_500,
    });
    expect(result.ok).toBe(true);
    expect(state.goals).toHaveLength(1);
    expect(state.goals[0]).toMatchObject({ expected_id: null, expected_revision: 0 });
    expect(state.sent).toHaveLength(1);
    expect(state.calls.send).toBe(1);
  });

  it('reports accepted transport as undispatched until a user message is observed', async () => {
    const deps = harness();
    deps.harness.sendPrompt = async (_sessionId, _directory, body) => {
      state.calls.send += 1;
      state.sent.push(body);
      return { ok: true, status: 204 };
    };
    const result = await createSession(deps, {
      scope: { directory: 'C:/repo' }, prompt: 'do it',
      selection: { model: 'nna/test-model' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body.promptDispatched).toBe(false);
      expect(result.body.promptError).toBe('OpenCode accepted the prompt but it never appeared in the session');
    }
  });

  it('fails a goal as partial when dispatch is rejected', async () => {
    const deps = harness();
    deps.harness.sendPrompt = async () => ({ ok: false, status: 502 });
    const result = await createSession(deps, {
      scope: { directory: 'C:/repo' }, prompt: 'do it',
      selection: { model: 'nna/test-model' }, goal: true, goalTokenBudget: 1_000,
    });
    expect(result).toEqual({ ok: false, failure: { status: 502, error: 'prompt dispatch rejected with 502', partial: true, partialAction: 'goal-configured', sessionId: 's1', directory: 'C:/repo' } });
  });

  it('fails a rejected prompt without claiming goal configuration', async () => {
    const deps = harness();
    deps.harness.sendPrompt = async () => ({ ok: false, status: 502 });
    const result = await createSession(deps, {
      scope: { directory: 'C:/repo' }, prompt: 'do it',
      selection: { model: 'nna/test-model' },
    });
    expect(result).toEqual({
      ok: false,
      failure: { status: 502, error: 'prompt dispatch rejected with 502', partial: true, sessionId: 's1', directory: 'C:/repo' },
    });
  });

  it('reports a created fork but not an uncreated fork as fork-created', async () => {
    const deps = harness();
    await createSession(deps, {
      scope: { directory: 'C:/repo' }, prompt: 'source',
      selection: { model: 'nna/test-model' },
    });
    deps.harness.forkSession = async () => {
      throw new Error('fork rejected');
    };
    const result = await sendSession(deps, 's1', {
      scope: { directory: 'C:/repo' }, prompt: 'fork it', selection: {},
    }, true);
    expect(result).toEqual({
      ok: false,
      failure: { status: 502, error: 'fork rejected', sessionId: 's1', directory: 'C:/repo' },
    });
  });

  it('reports a post-fork dispatch failure against the fork', async () => {
    const deps = harness();
    await createSession(deps, {
      scope: { directory: 'C:/repo' }, prompt: 'source',
      selection: { model: 'nna/test-model' },
    });
    deps.harness.sendPrompt = async () => ({ ok: false, status: 502 });
    const result = await sendSession(deps, 's1', {
      scope: { directory: 'C:/repo' }, prompt: 'fork it', selection: {},
    }, true);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.partial).toBe(true);
      expect(result.failure.partialAction).toBe('fork-created');
      expect(result.failure.sessionId).toBe('fork-1');
      expect(result.failure.directory).toBe('C:/repo');
    }
  });

  it('reuses the visible user selection for send', async () => {
    const deps = harness();
    await createSession(deps, {
      scope: { directory: 'C:/repo' }, prompt: 'first',
      selection: { model: 'nna/test-model', agent: 'build' },
    });
    state.messages[state.messages.length - 1] = {
      info: { id: 'selected', role: 'user', agent: 'build', model: { providerID: 'nna', modelID: 'validator' } },
    };
    const result = await sendSession(deps, 's1', { scope: { directory: 'C:/repo' }, prompt: 'continue', selection: {} });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body.model).toBe('nna/validator');
      expect(result.body.agent).toBe('build');
    }
  });

  it('forks before dispatch and reports sourceSessionId', async () => {
    const deps = harness();
    await createSession(deps, {
      scope: { directory: 'C:/repo' }, prompt: 'source',
      selection: { model: 'nna/test-model', agent: 'build' },
    });
    const result = await sendSession(deps, 's1', { scope: { directory: 'C:/repo' }, prompt: 'fork it', selection: {} }, true);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body.sourceSessionId).toBe('s1');
      expect(result.body.sessionId).toBe('fork-1');
    }
    expect(state.calls.send).toBe(2);
  });

  it('archives successful ids and keeps failures explicit', async () => {
    const deps = harness();
    await createSession(deps, {
      scope: { directory: 'C:/repo' }, prompt: 'source',
      selection: { model: 'nna/test-model', agent: 'build' },
    });
    const result = await archiveSessionIds(deps, ['s1', 'missing']);
    expect(result).toEqual({ ok: true, body: { archivedIds: ['s1'], failedIds: ['missing'] } });
  });
});
