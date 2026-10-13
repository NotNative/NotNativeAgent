// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  changeGoalStatus, clearSessionGoal, effectiveObjective, loadSessionGoal,
  saveSessionGoal, type GoalApi, type SessionGoal,
} from '../session-goal-actions.ts';

const ID = 'ses_goal_test';

function fixture(): { api: GoalApi; state: { goal: SessionGoal | null; revision: number; files: Map<string, string>; aborts: number; failFile: boolean; conflict: boolean } } {
  const state = { goal: null as SessionGoal | null, revision: 0, files: new Map<string, string>(), aborts: 0, failFile: false, conflict: false };
  let serial = 0;
  const api: GoalApi = {
    get: async () => ({ data: { goal: state.goal ? { ...state.goal } : null, revision: state.revision } }),
    evidence: async () => ({ data: { session_id: ID, latest_request_id: 'msg_prior', window_truncated: false } }),
    put: async (_id, goal, expectedId, revision) => {
      if (state.conflict || expectedId !== (state.goal?.id ?? null) || revision !== state.revision) return { error: '409 goal changed', response: { status: 409 } };
      state.goal = { ...goal }; state.revision++;
      return { data: { goal: state.goal, revision: state.revision } };
    },
    clear: async (_id, expectedId, revision) => {
      if (expectedId !== state.goal?.id || revision !== state.revision) return { error: '409 goal changed' };
      state.goal = null; state.revision++;
      return { data: { goal: null, revision: state.revision } };
    },
    writeFile: async (_id, content) => {
      if (state.failFile) throw new Error('disk full');
      const key = (++serial).toString(16).padStart(64, '0');
      state.files.set(key, content);
      return key;
    },
    readFile: async (_id, key) => state.files.get(key) ?? null,
    deleteFile: async (_id, key) => { state.files.delete(key); },
    abort: async () => { state.aborts++; },
  };
  return { api, state };
}

describe('NNA-native session goal controls', () => {
  it('refuses to arm when a compacted receipt window cannot establish the pre-goal cursor', async () => {
    const { api, state } = fixture();
    api.evidence = async () => ({ data: { session_id: ID, latest_request_id: null, window_truncated: true } });
    await expect(saveSessionGoal(ID, 'Do work', 100, api)).rejects.toThrow('history is incomplete');
    expect(state.goal).toBeNull();
    expect(state.files.size).toBe(0);
  });

  it('stages a unique file before CAS, preserves inline fallback, and retires only the old generation', async () => {
    const { api, state } = fixture();
    const first = await saveSessionGoal(ID, 'Build NND', 200_000, api);
    expect(first.revision).toBe(1);
    expect(first.goal?.objective).toBe('Build NND');
    expect(first.goal?.objectiveFile).toBe(true);
    expect(first.goal?.lastAccountedMessageID).toBe('msg_prior');
    const oldKey = first.goal!.objectiveFileKey!;
    expect(state.files.get(oldKey)).toBe('Build NND');
    const second = await saveSessionGoal(ID, 'Finish the GUI', null, api);
    expect(second.goal?.id).toBe(first.goal?.id);
    expect(second.goal?.objectiveFileKey).not.toBe(oldKey);
    expect(state.files.has(oldKey)).toBe(false);
    expect(await effectiveObjective(ID, second.goal!, api)).toBe('Finish the GUI');
    state.files.clear();
    expect(await effectiveObjective(ID, second.goal!, api)).toBe('Finish the GUI');
  });

  it('falls back to inline content if staging fails, without keeping an obsolete file key', async () => {
    const { api, state } = fixture();
    const first = await saveSessionGoal(ID, 'Original', null, api);
    const oldKey = first.goal!.objectiveFileKey!;
    state.failFile = true;
    const next = await saveSessionGoal(ID, 'Revised', null, api);
    expect(next.goal?.objectiveFile).toBe(false);
    expect(next.goal?.objectiveFileKey).toBeUndefined();
    expect(next.goal?.objective).toBe('Revised');
    expect(state.files.has(oldKey)).toBe(false);
  });

  it('cleans a losing staged file without touching the winning objective', async () => {
    const { api, state } = fixture();
    await saveSessionGoal(ID, 'Winner', null, api);
    const winningKey = state.goal!.objectiveFileKey!;
    state.conflict = true;
    await expect(saveSessionGoal(ID, 'Loser', null, api)).rejects.toThrow('409');
    expect(state.files.size).toBe(1);
    expect(state.files.get(winningKey)).toBe('Winner');
    expect(state.goal?.objective).toBe('Winner');
  });

  it('pauses, resumes, marks complete, and clears through fresh goal revisions', async () => {
    const { api, state } = fixture();
    await saveSessionGoal(ID, 'Goal', 50_000, api);
    expect((await changeGoalStatus(ID, 'pause', api)).goal?.status).toBe('paused');
    expect(state.aborts).toBe(1);
    expect((await changeGoalStatus(ID, 'resume', api)).goal?.status).toBe('active');
    expect((await changeGoalStatus(ID, 'complete', api)).goal?.status).toBe('complete');
    await expect(saveSessionGoal(ID, 'Replacement', null, api)).rejects.toThrow('Clear the completed goal');
    expect((await clearSessionGoal(ID, api)).goal).toBeNull();
    expect(state.files.size).toBe(0);
    expect((await loadSessionGoal(ID, api)).revision).toBe(5);
  });

  it('uses the committed mutation response without a second GET that can fail after success', async () => {
    const { api, state } = fixture();
    const read = api.get;
    let reads = 0;
    api.get = async (id) => { if (++reads > 1) throw new Error('connection lost'); return read(id); };
    expect((await saveSessionGoal(ID, 'Persisted', null, api)).revision).toBe(1);
    expect(state.goal?.objective).toBe('Persisted');
    expect(reads).toBe(1);

    reads = 0;
    expect((await changeGoalStatus(ID, 'pause', api)).goal?.status).toBe('paused');
    expect(reads).toBe(1);

    reads = 0;
    expect((await clearSessionGoal(ID, api)).goal).toBeNull();
    expect(reads).toBe(1);
  });

  it('reports a partial pause or clear when the stop request fails after CAS', async () => {
    const { api, state } = fixture();
    await saveSessionGoal(ID, 'Goal', null, api);
    api.abort = async () => { throw new Error('transport unavailable'); };
    await expect(changeGoalStatus(ID, 'pause', api)).rejects.toThrow('Goal paused, but stopping');
    expect(state.goal?.status).toBe('paused');
    await changeGoalStatus(ID, 'resume', api);
    await expect(clearSessionGoal(ID, api)).rejects.toThrow('Goal cleared, but stopping');
    expect(state.goal).toBeNull();
    expect(state.files.size).toBe(0);
  });
});
