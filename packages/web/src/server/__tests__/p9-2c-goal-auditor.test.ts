// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi, afterEach } from 'vitest';
import { interpretGoalAuditCall, applyGoalAuditUnavailable, applyGoalAuditVerdict,
  accountingDrift, readGoalRevision, runGoalAuditExchange, sameGoalPayload,
  type GoalAuditBody, type GoalAuditPorts, type GoalAuditWire } from '../goals/nna-goal-auditor.ts';
import { buildGoalPayload, type GoalPayload } from '../goals/goal-payload.ts';
import { NnaGoalSafetyRuntime } from '../goals/nna-goal-runtime.ts';
import { createNnaGoalAuditPorts } from '../goals/nna-goal-safety-ports.ts';
import type { GoalSafetyPorts } from '../goals/nna-goal-safety-tick.ts';
import { registerHarnessAdapter } from '../harness/adapter.ts';
import { ManualQueueFeed } from '../queue/queue-feed.ts';
import type { GoalSafetyTickResult } from '../goals/nna-goal-safety-tick.ts';

const SESSION_ID = 'ses_audit';
const DIRECTORY = '/project';

function goal(patch: Partial<GoalPayload> = {}): GoalPayload {
  const base = buildGoalPayload({ objective: 'Ship the change', objectiveFile: false, now: 10 });
  return { ...base, id: 'goal_audit', tokensUsed: 1, tokensCommitted: 1, lastAccountedMessageID: 'r1',
    ...patch };
}

/** The tick's accounting candidate: cursor advanced over receipt r2. */
function applied(patch: Partial<GoalPayload> = {}): GoalPayload {
  return goal({ tokensUsed: 5, tokensCommitted: 5, lastAccountedMessageID: 'r2', ...patch });
}

function session(goalValue: GoalPayload | null, revision: number): unknown {
  return { id: SESSION_ID, directory: DIRECTORY,
    metadata: { nnd: { ...(goalValue ? { goal: goalValue } : {}), goalRevision: revision } } };
}

function ready(goalValue: GoalPayload, skipAudit = false): Extract<GoalSafetyTickResult, { kind: 'ready' }> {
  return { kind: 'ready', goal: goalValue, objective: 'Ship the change',
    assistantText: 'Fixed the failing case and kept the suite green.', tailId: 'assistant-2', skipAudit };
}

interface AuditState {
  goal: GoalPayload | null;
  revision: number;
  failWrites: boolean;
  raceMode: boolean;
  unavailableMode: boolean;
  throwAudit: boolean;
  verdictText?: string;
}

function makePorts(state: AuditState) {
  const auditBodies: GoalAuditBody[] = [];
  const writes: Array<{ goal: GoalPayload; expected_id: string | null; expected_revision: number }> = [];
  const order: string[] = [];
  const ports: GoalAuditPorts = {
    listSessions: async () => [],
    readSession: async () => {
      order.push('read');
      return session(state.goal, state.revision);
    },
    readObjective: async () => 'Ship the change',
    readStatus: async () => ({}),
    readChildren: async () => [],
    readMessages: async () => [],
    readEvidence: async () => null,
    runAudit: async (_sessionId: string, _directory: string, body: GoalAuditBody) => {
      if (state.throwAudit) throw new Error('audit route down');
      order.push('audit');
      auditBodies.push(body);
      if (state.raceMode) return { status: 400, body: { error: { code: 'nnd_goal_audit_conflict' } } } as GoalAuditWire;
      if (state.unavailableMode) return { status: 404, body: { error: { code: 'nnd_engine_unavailable' } } } as GoalAuditWire;
      const verdict = state.verdictText ?? '{"verdict": "continue", "note": "wiring works"}';
      return { status: 200, body: { text: `\`\`\`json\n${verdict}\n\`\`\``,
        providerID: 'primary', modelID: 'test' } } as GoalAuditWire;
    },
    writeGoal: async (_sessionId: string, _directory: string, body: {
      goal: GoalPayload; expected_id: string | null; expected_revision: number }) => {
      if (state.failWrites) return false;
      if (body.expected_id !== null && state.goal?.id !== body.expected_id) return false;
      if (body.expected_revision !== state.revision) return false;
      order.push('write');
      writes.push(body);
      state.revision += 1;
      state.goal = body.goal;
      return true;
    },
  };
  return { ports, auditBodies, writes, order };
}

afterEach(() => vi.useRealTimers());

describe('applyGoalAuditVerdict', () => {
  it('settles complete with the audit note and attribution', () => {
    const result = applyGoalAuditVerdict(applied(), 'complete', 'all requirements verified',
      { providerID: 'primary', modelID: 'test' }, 999);
    expect(result.settled).toBe('complete');
    expect(result.goal.status).toBe('complete');
    expect(result.goal.statusReason).toBe('verified by audit');
    expect(result.goal.note).toBe('all requirements verified');
    expect(result.goal.evaluationProviderID).toBe('primary');
    expect(result.goal.evaluationModelID).toBe('test');
    expect(result.goal.tokensUsed).toBe(5);
    expect(result.goal.updatedAt).toBe(999);
  });

  it('persists blocked streaks and settles on the third consecutive verdict', () => {
    const first = applyGoalAuditVerdict(applied(), 'blocked', 'missing credentials',
      { providerID: 'primary', modelID: 'test' }, 11);
    expect(first.settled).toBeNull();
    expect(first.goal.status).toBe('active');
    expect(first.goal.blockedStreak).toBe(1);
    const second = applyGoalAuditVerdict(first.goal, 'blocked', 'missing credentials', null, 12);
    expect(second.goal.blockedStreak).toBe(2);
    const third = applyGoalAuditVerdict(second.goal, 'blocked', 'still without credentials', null, 13);
    expect(third.settled).toBe('blocked');
    expect(third.goal.status).toBe('blocked');
    expect(third.goal.statusReason).toBe('still without credentials');
    expect(third.goal.note).toBe('still without credentials');
    expect(third.goal.blockedStreak).toBe(0);
  });

  it('keeps the goal active for a continue verdict without consuming a continuation', () => {
    const result = applyGoalAuditVerdict(applied({ turnsUsed: 0, blockedStreak: 2 }), 'continue',
      'one test failing', { providerID: 'primary', modelID: 'test' }, 12);
    expect(result.settled).toBeNull();
    expect(result.goal.status).toBe('active');
    expect(result.goal.blockedStreak).toBe(0);
    expect(result.goal.auditFailStreak).toBe(0);
    expect(result.goal.turnsUsed).toBe(0);
    expect(result.goal.tokensUsed).toBe(5);
  });

  it('keeps the prior note and attribution when parsing dropped them', () => {
    const prior = applied({ note: 'earlier note', evaluationProviderID: 'old', evaluationModelID: 'old-model' });
    const result = applyGoalAuditVerdict(prior, 'continue', '', null, 13);
    expect(result.goal.note).toBe('earlier note');
    expect(result.goal.evaluationProviderID).toBe('old');
  });
});

describe('applyGoalAuditUnavailable', () => {
  it('records the first failure streak without advancing accounting', () => {
    const result = applyGoalAuditUnavailable(goal(), 12);
    expect(result.settled).toBe(false);
    expect(result.goal.auditFailStreak).toBe(1);
    expect(result.goal.tokensUsed).toBe(1);
    expect(result.goal.lastAccountedMessageID).toBe('r1');
  });
  it('settles blocked on the second consecutive failure', () => {
    const result = applyGoalAuditUnavailable(applied({ auditFailStreak: 1 }), 13);
    expect(result.settled).toBe(true);
    expect(result.goal.status).toBe('blocked');
    expect(result.goal.statusReason).toBe('progress audit unavailable');
    expect(result.goal.turnsUsed).toBe(0);
  });
});

describe('interpretGoalAuditCall', () => {
  it('parses wrapped verdict text and clamps attribution', () => {
    const call = interpretGoalAuditCall({ status: 200,
      body: { text: 'Preamble\n{"verdict":"COMPLETE","note":"done"}\nTrailing',
        providerID: 'p'.repeat(300), modelID: 'test' } }, 'Ship', 'work text');
    expect(call).toMatchObject({ kind: 'verdict', verdict: 'complete', note: 'done', modelID: 'test' });
    expect(call.kind === 'verdict' && call.providerID.length).toBe(200);
  });
  it('classifies target races and busy audits without failing the streak', () => {
    expect(interpretGoalAuditCall({ status: 400,
      body: { error: { code: 'nnd_goal_audit_conflict', message: 'goal changed' } } }, 'o', 'a')).toEqual({ kind: 'race' });
    expect(interpretGoalAuditCall({ status: 400,
      body: { error: { code: 'nnd_goal_audit_busy', message: 'audit in flight' } } }, 'o', 'a')).toEqual({ kind: 'race' });
  });
  it('treats unreachable routes, odd shapes, and unparseable text as unavailable', () => {
    const unavailable: unknown[] = [
      { status: 404, body: { error: { code: 'nnd_engine_unavailable' } } },
      { status: 400, body: { error: { code: 'nnd_goal_audit_invalid' } } },
      { status: 200, body: { text: 'no json here at all' } },
      { status: 200, body: { text: 42 } },
      { status: 200, body: null },
      { status: 502, body: { error: { message: 'harness adapter unavailable' } } },
      { status: 200, body: 'plain prose' },
    ];
    for (const wire of unavailable) {
      expect(interpretGoalAuditCall(wire as GoalAuditWire, 'Ship', 'text')).toEqual({ kind: 'unavailable' });
    }
  });
});

describe('goal payload helpers', () => {
  it('detects whole-payload equality and loop-field drift', () => {
    expect(sameGoalPayload(applied(), applied())).toBe(true);
    expect(sameGoalPayload(applied(), applied({ tokensUsed: 6 }))).toBe(false);
    expect(accountingDrift(applied({ tokensUsed: 6, lastAccountedMessageID: 'r3' }), applied())).toBe(false);
    expect(accountingDrift(applied({ note: 'user owned text' }), applied())).toBe(true);
    expect(accountingDrift(applied({ turnsUsed: 1 }), applied())).toBe(true);
  });
  it('reads the server-owned revision defensively', () => {
    expect(readGoalRevision(session(null, 3))).toBe(3);
    expect(readGoalRevision({ metadata: { nnd: {} } })).toBeNull();
    expect(readGoalRevision({ metadata: { nnd: { goalRevision: -1 } } })).toBeNull();
    expect(readGoalRevision({ metadata: undefined })).toBeNull();
  });
});

describe('runGoalAuditExchange', () => {
  it('audits the fresh turn and CAS-writes one complete settle', async () => {
    const state: AuditState = { goal: goal(), revision: 4, failWrites: false, raceMode: false,
      unavailableMode: false, throwAudit: false,
      verdictText: '{"verdict": "complete", "note": "all verified"}' };
    const fake = makePorts(state);
    const result = await runGoalAuditExchange(fake.ports, ready(applied(), false), SESSION_ID, DIRECTORY);
    expect(fake.order).toEqual(['read', 'audit', 'read', 'write']);
    expect(fake.auditBodies).toEqual([{ expected_id: 'goal_audit', expected_revision: 4,
      request_id: 'r2', objective: 'Ship the change' }]);
    expect(result.kind === 'settled' && result.outcome).toBe('complete');
    expect(state.revision).toBe(5);
    expect(state.goal?.status).toBe('complete');
    expect(state.goal?.tokensCommitted).toBe(5);
  });

  it('persists a continue verdict without bumping turnsUsed', async () => {
    const state: AuditState = { goal: goal(), revision: 1, failWrites: false, raceMode: false,
      unavailableMode: false, throwAudit: false };
    const fake = makePorts(state);
    const result = await runGoalAuditExchange(fake.ports, ready(applied(), false), SESSION_ID, DIRECTORY);
    expect(result).toMatchObject({ kind: 'processed', verdict: 'continue' });
    const written = fake.writes.at(-1) as { goal: GoalPayload };
    expect(written.goal.turnsUsed).toBe(0);
    expect(written.goal.lastAccountedMessageID).toBe('r2');
    expect(written.goal.evaluationModelID).toBe('test');
    expect(state.revision).toBe(2);
  });

  it('keeps accounting unadvanced when the audit is unavailable, then settles on the second failure', async () => {
    const state: AuditState = { goal: goal(), revision: 2, failWrites: false, raceMode: false,
      unavailableMode: true, throwAudit: false };
    const fake = makePorts(state);
    const first = await runGoalAuditExchange(fake.ports, ready(applied(), false), SESSION_ID, DIRECTORY);
    expect(first).toMatchObject({ kind: 'processed', verdict: null });
    const written = fake.writes.at(-1) as { goal: GoalPayload };
    expect(written.goal.auditFailStreak).toBe(1);
    expect(written.goal.tokensUsed).toBe(1);
    expect(written.goal.lastAccountedMessageID).toBe('r1');
    expect(state.revision).toBe(3);
    const second = await runGoalAuditExchange(fake.ports, ready(applied({ auditFailStreak: 1 }), false), SESSION_ID, DIRECTORY);
    expect(second.kind === 'settled' && second.outcome).toBe('blocked');
    expect(state.goal?.status).toBe('blocked');
    expect(state.goal?.statusReason).toBe('progress audit unavailable');
    expect(fake.auditBodies).toHaveLength(2);
  });

  it('drops a race without streak writes and leaves the goal untouched', async () => {
    const state: AuditState = { goal: goal(), revision: 1, failWrites: false, raceMode: true,
      unavailableMode: false, throwAudit: false };
    const fake = makePorts(state);
    const result = await runGoalAuditExchange(fake.ports, ready(applied(), false), SESSION_ID, DIRECTORY);
    expect(result).toMatchObject({ kind: 'dropped' });
    expect(fake.writes).toHaveLength(0);
    expect(state.revision).toBe(1);
  });

  it('drops the verdict write when the revision moved during the audit', async () => {
    const state: AuditState = { goal: goal(), revision: 1, failWrites: false, raceMode: false,
      unavailableMode: false, throwAudit: false };
    const fake = makePorts(state);
    const original = fake.ports.readSession;
    let reads = 0;
    fake.ports.readSession = async () => {
      reads += 1;
      if (reads === 2) state.revision += 1;
      return await original(SESSION_ID, DIRECTORY);
    };
    const result = await runGoalAuditExchange(fake.ports, ready(applied(), false), SESSION_ID, DIRECTORY);
    expect(result).toMatchObject({ kind: 'dropped', reason: 'goal changed during the audit' });
    expect(fake.writes).toHaveLength(0);
  });

  it('drops when the tick candidate no longer matches the exchange read', async () => {
    // A budget edit that landed between the tick and the exchange must be
    // refused: the verdict write would otherwise overwrite the newer goal.
    const state: AuditState = { goal: goal(), revision: 1, failWrites: false, raceMode: false,
      unavailableMode: false, throwAudit: false };
    const fake = makePorts(state);
    const original = fake.ports.readSession;
    let reads = 0;
    fake.ports.readSession = async () => {
      reads += 1;
      state.goal = goal({ tokenBudget: 50_000, statusReason: 'resumed', turnsUsed: 0, blockedStreak: 0 });
      return await original(SESSION_ID, DIRECTORY);
    };
    const result = await runGoalAuditExchange(fake.ports, ready(applied(), false), SESSION_ID, DIRECTORY);
    expect(result).toMatchObject({ kind: 'dropped', reason: 'goal changed since the tick' });
    expect(fake.auditBodies).toHaveLength(0);
    expect(fake.writes).toHaveLength(0);
    expect(state.revision).toBe(1);
  });

  it('drops when an unrelated loop field drifts under the same revision', async () => {
    const state: AuditState = { goal: goal(), revision: 1, failWrites: false, raceMode: false,
      unavailableMode: false, throwAudit: false };
    const fake = makePorts(state);
    const original = fake.ports.readSession;
    let reads = 0;
    fake.ports.readSession = async () => {
      reads += 1;
      if (reads === 2) state.goal = goal({ turnsUsed: 1 });
      return await original(SESSION_ID, DIRECTORY);
    };
    const result = await runGoalAuditExchange(fake.ports, ready(applied(), false), SESSION_ID, DIRECTORY);
    expect(result).toMatchObject({ kind: 'dropped', reason: 'goal changed during the audit' });
    expect(fake.writes).toHaveLength(0);
  });

  it('drops when the goal was replaced during the audit', async () => {
    const state: AuditState = { goal: goal(), revision: 1, failWrites: false, raceMode: false,
      unavailableMode: false, throwAudit: false };
    const fake = makePorts(state);
    const original = fake.ports.readSession;
    let reads = 0;
    fake.ports.readSession = async () => {
      reads += 1;
      if (reads === 2) state.goal = goal({ id: 'replaced_goal' });
      return await original(SESSION_ID, DIRECTORY);
    };
    const result = await runGoalAuditExchange(fake.ports, ready(applied(), false), SESSION_ID, DIRECTORY);
    expect(result).toMatchObject({ kind: 'dropped', reason: 'goal no longer active after the audit' });
    expect(fake.writes).toHaveLength(0);
  });

  it('persists a skip-audit resume candidate and never calls the auditor', async () => {
    const state: AuditState = { goal: goal(), revision: 1, failWrites: false, raceMode: false,
      unavailableMode: false, throwAudit: false };
    const fake = makePorts(state);
    const result = await runGoalAuditExchange(fake.ports, ready(applied(), true), SESSION_ID, DIRECTORY);
    expect(fake.auditBodies).toHaveLength(0);
    expect(fake.order).toEqual(['read', 'write']);
    expect(result.kind).toBe('processed');
    expect(state.revision).toBe(2);
  });

  it('writes nothing for a skip-audit candidate the server already holds', async () => {
    const state: AuditState = { goal: applied(), revision: 1, failWrites: false, raceMode: false,
      unavailableMode: false, throwAudit: false };
    const fake = makePorts(state);
    const result = await runGoalAuditExchange(fake.ports, ready(applied(), true), SESSION_ID, DIRECTORY);
    expect(fake.order).toEqual(['read']);
    expect(fake.writes).toHaveLength(0);
    expect(result.kind).toBe('processed');
  });

  it('degrades an audit route throw and a read fault to bounded outcomes', async () => {
    const audit: AuditState = { goal: goal(), revision: 1, failWrites: false, raceMode: false,
      unavailableMode: false, throwAudit: true };
    const fakeAudit = makePorts(audit);
    const first = await runGoalAuditExchange(fakeAudit.ports, ready(applied(), false), SESSION_ID, DIRECTORY);
    expect(first).toMatchObject({ kind: 'processed' });
    expect((fakeAudit.writes.at(-1) as { goal: GoalPayload }).goal.auditFailStreak).toBe(1);
    const read: AuditState = { goal: goal(), revision: 1, failWrites: false, raceMode: false,
      unavailableMode: false, throwAudit: false };
    const fakeRead = makePorts(read);
    fakeRead.ports.readSession = async () => { throw new Error('transport down'); };
    expect(await runGoalAuditExchange(fakeRead.ports, ready(applied(), false), SESSION_ID, DIRECTORY))
      .toEqual({ kind: 'wait', reason: 'goal audit exchange unavailable' });
  });

  it('drops when the CAS write is refused instead of retrying blindly', async () => {
    const state: AuditState = { goal: goal(), revision: 1, failWrites: true, raceMode: false,
      unavailableMode: false, throwAudit: false };
    const fake = makePorts(state);
    const result = await runGoalAuditExchange(fake.ports, ready(applied(), false), SESSION_ID, DIRECTORY);
    expect(result).toMatchObject({ kind: 'dropped', reason: 'goal CAS write was refused' });
  });
});

describe('NNA goal audit production port', () => {
  it('forwards the bounded audit body over the directory-scoped route', async () => {
    const seen: Array<{ method: string; path: string; directory: string | null; body: unknown }> = [];
    registerHarnessAdapter({ handle: async (request) => {
      const url = new URL(request.url);
      seen.push({ method: request.method, path: url.pathname,
        directory: request.headers.get('x-nnd-directory'), body: JSON.parse(await request.text()) });
      return Response.json({ text: '{"verdict":"continue","note":"working"}', providerID: 'primary', modelID: 'test' });
    } });
    const ports = createNnaGoalAuditPorts();
    const wire = await ports.runAudit(SESSION_ID, DIRECTORY, {
      expected_id: 'goal_x', expected_revision: 2, request_id: 'r2', objective: 'Ship the change',
    });
    expect(seen).toEqual([{ method: 'POST', path: `/api/v1/nnd/sessions/${SESSION_ID}/goal-audit`,
      directory: DIRECTORY, body: { expected_id: 'goal_x', expected_revision: 2,
        request_id: 'r2', objective: 'Ship the change' } }]);
    expect(wire).toEqual({ status: 200, body: { text: '{"verdict":"continue","note":"working"}',
      providerID: 'primary', modelID: 'test' } });
  });

  it('surfaces refused bodies for streak interpretation', async () => {
    registerHarnessAdapter({ handle: async () => new Response('gateway down', { status: 502 }) });
    const ports = createNnaGoalAuditPorts();
    const wire = await ports.runAudit(SESSION_ID, DIRECTORY, {
      expected_id: 'goal_x', expected_revision: 2, request_id: 'r2', objective: 'Ship',
    });
    expect(interpretGoalAuditCall(wire, 'Ship', 'text')).toEqual({ kind: 'unavailable' });
  });
});

describe('NNA goal safety runtime awaits the audit exchange', () => {
  it('holds the ready consumer inline and parks later arms until it resolves', async () => {
    vi.useFakeTimers();
    const feed = new ManualQueueFeed();
    const goalValue = goal();
    const ports: GoalSafetyPorts = {
      listSessions: async () => [],
      readSession: async () => session(goalValue, 1),
      readObjective: async () => goalValue.objective,
      readStatus: async () => ({}),
      readChildren: async () => [],
      readMessages: async () => [{ info: { id: 'assistant-1', role: 'assistant', time: { completed: 20 } },
        parts: [{ type: 'text', text: 'Tests pass' }] }],
      readEvidence: async () => ({ session_id: SESSION_ID, turns: [
        { request_id: 'r1', outcome: 'completed', tokens: 1, measurement: 'provider' },
        { request_id: 'r2', outcome: 'completed', tokens: 2, measurement: 'provider' },
      ], latest_request_id: 'r2', window_truncated: false }),
      writeGoal: async () => true,
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const consumed: number[] = [];
    const runtime = new NnaGoalSafetyRuntime(feed, ports, () => true,
      async () => { await gate; consumed.push(1); }, { idleMs: 20, kickoffMs: 10, resumeMs: 2 });
    runtime.start();
    feed.emit({ directory: DIRECTORY,
      payload: { id: 'ev1', type: 'session.status', properties: { sessionID: SESSION_ID,
        status: { type: 'idle' } } } });
    await vi.advanceTimersByTimeAsync(21);
    await vi.advanceTimersByTimeAsync(200);
    expect(consumed).toEqual([]);
    release();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(consumed).toEqual([1]);
    runtime.dispose();
  });
});
