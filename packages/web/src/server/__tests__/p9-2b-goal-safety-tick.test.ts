// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { buildGoalPayload, type GoalPayload } from '../goals/goal-payload.ts';
import { runNnaGoalSafetyTick, type GoalSafetyPorts } from '../goals/nna-goal-safety-tick.ts';

const id = 'ses_tick';
const goal = (): GoalPayload => buildGoalPayload({ objective: 'Ship', objectiveFile: false, tokenBudget: 100, now: 10 });
const session = (value: GoalPayload, revision = 0) => ({ id, metadata: { nnd: { goal: value, goalRevision: revision } } });
const evidence = (tokens: number, outcome = 'completed') => ({ session_id: id,
  turns: [{ request_id: 'turn-1', outcome, tokens, measurement: 'provider' }],
  latest_request_id: 'turn-1', window_truncated: false });
const messages = () => [{ info: { id: 'assistant-1', role: 'assistant', time: { completed: 12 } },
  parts: [{ type: 'text', text: 'Tests pass' }] }];

function setup(): { ports: GoalSafetyPorts; writes: Array<ReturnType<typeof session>['metadata']['nnd']>; state: {
  current: ReturnType<typeof session>; status: unknown; children: unknown; messages: unknown; evidence: unknown;
} } {
  const state = { current: session(goal()), status: {} as unknown, children: [] as unknown,
    messages: messages() as unknown, evidence: evidence(20) as unknown };
  const writes: Array<ReturnType<typeof session>['metadata']['nnd']> = [];
  const ports: GoalSafetyPorts = {
    listSessions: async () => [state.current],
    readSession: async () => state.current,
    readObjective: async (value) => value.objective,
    readStatus: async () => state.status,
    readChildren: async () => state.children,
    readMessages: async () => state.messages,
    readEvidence: async () => state.evidence,
    writeGoal: async (_id, _directory, body) => { writes.push({ goal: body.goal, goalRevision: body.expected_revision }); return true; },
  };
  return { ports, writes, state };
}

describe('NNA pre-audit goal safety tick', () => {
  it('returns a bounded audit-ready candidate only after authoritative idle and completed tail', async () => {
    const { ports, writes } = setup();
    const result = await runNnaGoalSafetyTick(ports, id, '/project');
    expect(result.kind).toBe('ready');
    if (result.kind === 'ready') {
      expect(result.goal.tokensUsed).toBe(20);
      expect(result.assistantText).toBe('Tests pass');
      expect(result.tailId).toBe('assistant-1');
      expect(result.skipAudit).toBe(false);
    }
    expect(writes).toHaveLength(0);
  });

  it('waits on busy root, busy child, user tail, and unavailable status', async () => {
    const { ports, state, writes } = setup();
    state.status = { [id]: { type: 'busy' } };
    expect((await runNnaGoalSafetyTick(ports, id, '/project')).kind).toBe('wait');
    state.status = { child1: { type: 'retry' } };
    state.children = [{ id: 'child1' }];
    expect((await runNnaGoalSafetyTick(ports, id, '/project')).kind).toBe('wait');
    state.status = {};
    state.messages = [{ info: { id: 'user1', role: 'user' }, parts: [] }];
    expect((await runNnaGoalSafetyTick(ports, id, '/project')).kind).toBe('wait');
    state.status = null;
    expect((await runNnaGoalSafetyTick(ports, id, '/project')).kind).toBe('wait');
    expect(writes).toHaveLength(0);
  });

  it('settles a failed receipt even when NNA has no assistant message', async () => {
    const { ports, state, writes } = setup();
    state.messages = [];
    state.evidence = evidence(5, 'failed');
    const result = await runNnaGoalSafetyTick(ports, id, '/project');
    expect(result.kind).toBe('settled');
    expect(writes[0]?.goal.status).toBe('blocked');
    expect(writes[0]?.goal.tokensUsed).toBe(5);
  });

  it('resumes a cancelled turn with no assistant message only from its matching user tail', async () => {
    const { ports, state } = setup();
    state.current = session({ ...goal(), statusReason: 'resumed', lastAccountedMessageID: 'turn-1' });
    state.evidence = evidence(5, 'cancelled');
    state.messages = [{ info: { id: 'turn-1', role: 'user' }, parts: [] }];
    const result = await runNnaGoalSafetyTick(ports, id, '/project');
    expect(result).toMatchObject({ kind: 'ready', tailId: 'turn-1', assistantText: '', skipAudit: true });
    state.messages = [{ info: { id: 'new-user', role: 'user' }, parts: [] }];
    expect((await runNnaGoalSafetyTick(ports, id, '/project')).kind).toBe('wait');
  });

  it('persists evidence hard stops even when the objective is unavailable', async () => {
    const { ports, state, writes } = setup();
    state.evidence = evidence(100);
    ports.readObjective = async () => null;
    expect((await runNnaGoalSafetyTick(ports, id, '/project')).kind).toBe('settled');
    expect(writes[0]?.goal.status).toBe('budgetLimited');
  });

  it('settles budget via revision CAS and refuses a concurrent user edit', async () => {
    const { ports, state, writes } = setup();
    state.evidence = evidence(100);
    const original = state.current;
    const write = ports.writeGoal;
    ports.readSession = async () => {
      const current = state.current;
      state.current = session(original.metadata.nnd.goal, 1);
      return current;
    };
    expect((await runNnaGoalSafetyTick(ports, id, '/project')).kind).toBe('conflict');
    expect(writes).toHaveLength(0);
    ports.readSession = async () => original;
    ports.writeGoal = write;
    expect((await runNnaGoalSafetyTick(ports, id, '/project')).kind).toBe('settled');
    expect(writes[0]?.goal.status).toBe('budgetLimited');
  });

  it('never settles or audits inactive, child, or objective-less sessions', async () => {
    const { ports, state, writes } = setup();
    state.current = { ...session(goal()), parentID: 'parent' } as typeof state.current;
    expect((await runNnaGoalSafetyTick(ports, id, '/project')).kind).toBe('wait');
    state.current = session({ ...goal(), status: 'paused' });
    expect((await runNnaGoalSafetyTick(ports, id, '/project')).kind).toBe('wait');
    state.current = session(goal());
    ports.readObjective = async () => null;
    expect((await runNnaGoalSafetyTick(ports, id, '/project')).kind).toBe('wait');
    expect(writes).toHaveLength(0);
  });
});
