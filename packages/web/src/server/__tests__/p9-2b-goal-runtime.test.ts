// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildGoalPayload } from '../goals/goal-payload.ts';
import { NnaGoalSafetyRuntime } from '../goals/nna-goal-runtime.ts';
import type { GoalSafetyPorts } from '../goals/nna-goal-safety-tick.ts';
import { ManualQueueFeed } from '../queue/queue-feed.ts';

const id = 'ses_runtime';
const goal = buildGoalPayload({ objective: 'Ship', objectiveFile: false, now: 10 });
const session = () => ({ id, directory: '/project', metadata: { nnd: { goal, goalRevision: 0 } } });
const feedEvent = (type: string, properties: Record<string, unknown>) => ({ directory: '/project',
  payload: { id: 'ev1', type, properties: { sessionID: id, ...properties } } });

function setup() {
  const feed = new ManualQueueFeed();
  const calls: string[] = [];
  const ready: string[] = [];
  let enabled = true;
  const ports: GoalSafetyPorts = {
    listSessions: async () => [session()],
    readSession: async () => { calls.push('session'); return session(); },
    readObjective: async () => 'Ship',
    readStatus: async () => ({}),
    readChildren: async () => [],
    readMessages: async () => [{ info: { id: 'assistant-1', role: 'assistant', time: { completed: 20 } },
      parts: [{ type: 'text', text: 'Tests pass' }] }],
    readEvidence: async () => ({ session_id: id, turns: [{ request_id: 'turn-1', outcome: 'completed', tokens: 1,
      measurement: 'provider' }], latest_request_id: 'turn-1', window_truncated: false }),
    writeGoal: async () => { calls.push('write'); return true; },
  };
  const runtime = new NnaGoalSafetyRuntime(feed, ports, () => enabled,
    (_result, sessionId) => ready.push(sessionId), { idleMs: 20, kickoffMs: 10, resumeMs: 2 });
  return { feed, ports, calls, ready, runtime, enable: (value: boolean) => { enabled = value; } };
}

afterEach(() => vi.useRealTimers());

describe('NNA goal safety event runner', () => {
  it('reconciles an active goal on startup and emits a safe ready candidate', async () => {
    vi.useFakeTimers();
    const state = setup();
    state.runtime.start();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(11);
    expect(state.calls).toContain('session');
    expect(state.ready).toEqual([id]);
    expect(state.calls).not.toContain('write');
    state.runtime.dispose();
  });

  it('replaces idle timer on busy and arms after the next idle event', async () => {
    vi.useFakeTimers();
    const state = setup();
    state.ports.listSessions = async () => [];
    state.runtime.start();
    state.feed.emit(feedEvent('session.status', { status: { type: 'idle' } }));
    await vi.advanceTimersByTimeAsync(5);
    state.feed.emit(feedEvent('session.status', { status: { type: 'busy' } }));
    await vi.advanceTimersByTimeAsync(25);
    expect(state.calls).toEqual([]);
    state.feed.emit(feedEvent('session.status', { status: { type: 'idle' } }));
    await vi.advanceTimersByTimeAsync(21);
    expect(state.ready).toEqual([id]);
    state.runtime.dispose();
  });

  it('respects the live feature gate and clears timers on dispose', async () => {
    vi.useFakeTimers();
    const state = setup();
    state.ports.listSessions = async () => [];
    state.runtime.start();
    state.feed.emit(feedEvent('session.updated', { info: session() }));
    state.enable(false);
    await vi.advanceTimersByTimeAsync(11);
    expect(state.calls).toEqual([]);
    state.enable(true);
    state.feed.emit(feedEvent('session.updated', { info: session() }));
    state.runtime.dispose();
    await vi.advanceTimersByTimeAsync(11);
    expect(state.calls).toEqual([]);
  });

  it('uses one in-flight guard and re-arms an unavailable status', async () => {
    vi.useFakeTimers();
    const state = setup();
    state.ports.listSessions = async () => [];
    state.ports.readStatus = async () => null;
    state.runtime.start();
    state.feed.emit(feedEvent('session.status', { status: { type: 'idle' } }));
    await vi.advanceTimersByTimeAsync(21);
    expect(state.calls.filter((call) => call === 'session')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(21);
    expect(state.calls.filter((call) => call === 'session')).toHaveLength(2);
    state.runtime.dispose();
  });

  it('preempts a pending idle timer when the user explicitly resumes', async () => {
    vi.useFakeTimers();
    const state = setup();
    state.ports.listSessions = async () => [];
    state.runtime.start();
    state.feed.emit(feedEvent('session.status', { status: { type: 'idle' } }));
    const resumed = session();
    resumed.metadata.nnd.goal = { ...goal, statusReason: 'resumed' };
    state.feed.emit(feedEvent('session.updated', { info: resumed }));
    await vi.advanceTimersByTimeAsync(3);
    expect(state.ready).toEqual([id]);
    await vi.advanceTimersByTimeAsync(20);
    expect(state.ready).toEqual([id]);
    state.runtime.dispose();
  });

  it('cancels a pending tick when a goal is paused or its session is deleted', async () => {
    vi.useFakeTimers();
    const state = setup();
    state.ports.listSessions = async () => [];
    state.runtime.start();
    state.feed.emit(feedEvent('session.status', { status: { type: 'idle' } }));
    const paused = session();
    paused.metadata.nnd.goal = { ...goal, status: 'paused' };
    state.feed.emit(feedEvent('session.updated', { info: paused }));
    await vi.advanceTimersByTimeAsync(21);
    expect(state.calls).toEqual([]);
    state.feed.emit(feedEvent('session.status', { status: { type: 'idle' } }));
    state.feed.emit(feedEvent('session.deleted', {}));
    await vi.advanceTimersByTimeAsync(21);
    expect(state.calls).toEqual([]);
    state.runtime.dispose();
  });

  it('suppresses an in-flight result after deletion', async () => {
    vi.useFakeTimers();
    const state = setup();
    state.ports.listSessions = async () => [];
    let release!: (value: unknown) => void;
    state.ports.readStatus = () => new Promise((resolve) => { release = resolve; });
    state.runtime.start();
    state.feed.emit(feedEvent('session.status', { status: { type: 'idle' } }));
    await vi.advanceTimersByTimeAsync(21);
    expect(state.calls).toEqual(['session']);
    state.feed.emit(feedEvent('session.deleted', {}));
    release({});
    await Promise.resolve();
    await Promise.resolve();
    expect(state.ready).toEqual([]);
    state.runtime.dispose();
  });

  it('suppresses an in-flight result when the feature gate is turned off', async () => {
    vi.useFakeTimers();
    const state = setup();
    state.ports.listSessions = async () => [];
    let release!: (value: unknown) => void;
    state.ports.readStatus = () => new Promise((resolve) => { release = resolve; });
    state.runtime.start();
    state.feed.emit(feedEvent('session.status', { status: { type: 'idle' } }));
    await vi.advanceTimersByTimeAsync(21);
    state.enable(false);
    release({});
    await Promise.resolve();
    await Promise.resolve();
    expect(state.ready).toEqual([]);
    state.runtime.dispose();
  });

  it('defers a newer idle event until an invalidated in-flight tick finishes', async () => {
    vi.useFakeTimers();
    const state = setup();
    state.ports.listSessions = async () => [];
    let release!: (value: unknown) => void;
    let statuses = 0;
    state.ports.readStatus = () => ++statuses === 1
      ? new Promise((resolve) => { release = resolve; }) : Promise.resolve({});
    state.runtime.start();
    state.feed.emit(feedEvent('session.status', { status: { type: 'idle' } }));
    await vi.advanceTimersByTimeAsync(21);
    state.feed.emit(feedEvent('session.status', { status: { type: 'busy' } }));
    state.feed.emit(feedEvent('session.status', { status: { type: 'idle' } }));
    release({});
    await vi.advanceTimersByTimeAsync(21);
    expect(state.ready).toEqual([id]);
    expect(state.calls.filter((call) => call === 'session')).toHaveLength(2);
    state.runtime.dispose();
  });

  it.each(['feature disabled', 'session deleted'])('does not start a stale hard-stop write after %s', async (change) => {
    vi.useFakeTimers();
    const state = setup();
    state.ports.listSessions = async () => [];
    const limited = session();
    limited.metadata.nnd.goal = { ...goal, tokenBudget: 1 };
    state.ports.readSession = async () => { state.calls.push('session'); return limited; };
    let release!: (value: unknown) => void;
    state.ports.readEvidence = () => new Promise((resolve) => { release = resolve; });
    state.runtime.start();
    state.feed.emit(feedEvent('session.status', { status: { type: 'idle' } }));
    await vi.advanceTimersByTimeAsync(21);
    if (change === 'session deleted') state.feed.emit(feedEvent('session.deleted', {}));
    else state.enable(false);
    release({ session_id: id, turns: [{ request_id: 'turn-1', outcome: 'completed', tokens: 1,
      measurement: 'provider' }], latest_request_id: 'turn-1', window_truncated: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.calls.filter((call) => call === 'session')).toHaveLength(2);
    expect(state.calls).not.toContain('write');
    state.runtime.dispose();
  });
});
