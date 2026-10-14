// SPDX-License-Identifier: Apache-2.0
/**
 * F9 durable occurrence reconciliation: duplicate submission after a lost
 * acknowledgement, restart with a pending operation, and the durable stop
 * racing a continuation. Pins the phase machine (claimed → creating →
 * session-created → accepted → settled), the operation-id identity carried to
 * NNA (`messageID`), the stop guard at the claim boundary, and the
 * resume-by-operation-id paths the boot sync drives.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyStatePatch } from '../scheduled/task-config.ts';
import { normalizeTaskForStorage, type ScheduledTask } from '../scheduled/task-schema.ts';
import { createScheduledTasksRuntime } from '../scheduled/scheduled-runtime.ts';
import {
  canAdvanceDispatch, canClaimOccurrence, dispatchOf, operationIdForOccurrence,
} from '../scheduled/scheduled-claims.ts';
import type { RunOutcome, RuntimePorts } from '../scheduled/scheduled-runtime.ts';
import type { PipelineOutcome, RunRequest } from '../scheduled/scheduled-ports.ts';

const t0 = Date.UTC(2026, 8, 21, 9, 0, 0);
const DUE = Date.UTC(2026, 8, 22, 9);
const SLOT = DUE;

interface StoreState {
  projects: Map<string, Map<string, Record<string, unknown>>>;
  patches: Array<{ taskId: string; patch: Record<string, unknown> }>;
  pipelineCalls: RunRequest[];
  pipeline: (request: RunRequest, phases?: { onSessionCreated(id: string): Promise<boolean>; onAccepted(id: string): Promise<boolean> }) => Promise<PipelineOutcome>;
  events: Array<{ status: string; sessionID?: string }>;
  logs: string[];
}

function taskDoc(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'task-1', name: 'Nightly digest', enabled: true,
    schedule: { kind: 'cron', cron: '0 9 * * *', timezone: 'UTC' },
    execution: { prompt: 'Summarize', providerID: 'nna', modelID: 'workspace-default' },
    state: { createdAt: t0, updatedAt: t0, lastStatus: 'idle' },
    ...patch,
  };
}

function makeStore(): StoreState {
  return {
    projects: new Map(), patches: [], pipelineCalls: [], logs: [], events: [],
    pipeline: async (request) => {
      throw new Error(`pipeline not configured for ${request.reason}`);
    },
  };
}

function seed(store: StoreState, projectId: string, doc: Record<string, unknown>): void {
  const map = store.projects.get(projectId) ?? new Map<string, Record<string, unknown>>();
  map.set(String(doc.id), doc);
  store.projects.set(projectId, map);
}

function normalizeFor(raw: Record<string, unknown> | null): ScheduledTask | null {
  if (raw === null) return null;
  const outcome = normalizeTaskForStorage(raw, { now: t0, serverZone: 'UTC' });
  return outcome.ok ? outcome.task : null;
}

/** The claim's write path: predicate evaluated on the RAW record, then the
 *  patch merged exactly as task-config's applyStatePatch would. */
function makePorts(store: StoreState, overrides: Partial<RuntimePorts> = {}): RuntimePorts {
  const ports: RuntimePorts = {
    load: async (projectId) => {
      const map = store.projects.get(projectId);
      if (!map) return { tasks: [], invalid: [] };
      const tasks: ScheduledTask[] = [];
      for (const raw of map.values()) {
        const known = normalizeFor(raw);
        if (known !== null) tasks.push(known);
      }
      return { tasks, invalid: [] };
    },
    patch: async (projectId, taskId, patch) => {
      const raw = store.projects.get(projectId)?.get(taskId);
      if (!raw) throw new Error('task vanished');
      store.projects.get(projectId)?.set(taskId, applyStatePatch(raw, patch));
      store.patches.push({ taskId, patch });
      return true;
    },
    patchIf: async (projectId, taskId, predicate, patch) => {
      const raw = store.projects.get(projectId)?.get(taskId);
      if (!raw) return { updated: false, task: null };
      if (!predicate(raw)) return { updated: false, task: raw };
      const updated = applyStatePatch(raw, patch);
      store.projects.get(projectId)?.set(taskId, updated);
      store.patches.push({ taskId, patch });
      return { updated: true, task: updated };
    },
    consumeOnce: async () => { /* not under test */ },
    readLatest: async (projectId, taskId) => normalizeFor(store.projects.get(projectId)?.get(taskId) ?? null),
    runPipeline: async (request, _task, phases) => store.pipeline(request, phases),
    emit: (event) => { store.events.push({ status: event.status, sessionID: event.sessionID }); },
    log: {
      warn: (message) => { store.logs.push(message); },
      error: (message) => { store.logs.push(message); },
    },
    now: () => Date.now(),
    jitter: () => 0,
    normalizeOptions: { now: t0, serverZone: 'UTC' },
    listProjects: async () => [...store.projects.keys()],
    ...overrides,
  };
  return ports;
}

function makeRuntime(store: StoreState, overrides: Partial<RuntimePorts> = {}) {
  return createScheduledTasksRuntime(makePorts(store, overrides));
}

function stateOfDoc(store: StoreState, taskId = 'task-1'): Record<string, unknown> | undefined {
  return (store.projects.get('proj')?.get(taskId)?.state ?? undefined) as Record<string, unknown> | undefined;
}

beforeEach(() => { vi.useFakeTimers({ now: t0 }); });
afterEach(() => { vi.useRealTimers(); });

describe('durable occurrence dispatch record', () => {
  it('the claim writes the dispatch record with a deterministic operation id', async () => {
    const store = makeStore();
    seed(store, 'proj', taskDoc());
    store.pipeline = async (request, phases) => {
      if (phases === undefined) throw new Error('phases required');
      expect(await phases.onSessionCreated('ses_a')).toBe(true);
      expect(await phases.onAccepted('ses_a')).toBe(true);
      return { sessionID: 'ses_a' };
    };
    const runtime = makeRuntime(store);
    await runtime.start(); // sync arms the due slot
    await vi.advanceTimersByTimeAsync(DUE + 1 - t0);
    const claimed = store.patches.find((entry) => entry.patch.lastStatus === 'running');
    expect(claimed).toBeDefined();
    const dispatch = (claimed!.patch.dispatch as Record<string, unknown>);
    expect(dispatch.phase).toBe('claimed'); // the claim patch itself
    expect(dispatch.operationId).toBe(operationIdForOccurrence('task-1', SLOT));
    expect(dispatch.pid).toBe(process.pid);
    // completion clears the record and keeps the session id
    const completion = store.patches.at(-1)!;
    expect('dispatch' in completion.patch).toBe(true);
    expect(completion.patch.dispatch).toBeUndefined();
    expect(completion.patch.lastSessionId).toBe('ses_a');
    runtime.stop();
  });

  it('phase advances require the same operation id at the expected phase', () => {
    const record = {
      state: {
        lastScheduledFor: SLOT,
        dispatch: {
          scheduledFor: SLOT, operationId: 'op-x', phase: 'creating', updatedAt: 1, pid: 999,
        },
      },
    };
    expect(canAdvanceDispatch('op-x', 'session-created')(record)).toBe(true);
    expect(canAdvanceDispatch('other', 'session-created')(record)).toBe(false);
    expect(canAdvanceDispatch('op-x', 'accepted')(record)).toBe(false); // wrong phase
    expect(canAdvanceDispatch('op-x', 'creating')(record)).toBe(false); // no regression
  });
});

describe('restart with a pending occurrence (F9 crash boundaries)', () => {
  /** Simulates the boot state: a claimed occurrence orphaned by a crash. */
  function crashState(phase: string, sessionId?: string): StoreState {
    const store = makeStore();
    seed(store, 'proj', taskDoc({
      state: {
        createdAt: t0, updatedAt: t0, lastStatus: 'running', lastScheduledFor: SLOT,
        nextRunAt: Date.UTC(2026, 8, 23, 9),
        dispatch: {
          scheduledFor: SLOT,
          operationId: operationIdForOccurrence('task-1', SLOT),
          phase,
          ...(sessionId !== undefined ? { sessionId } : {}),
          pid: 4_194_303, // a dead pid: orphaned by a crash
          updatedAt: t0,
        },
      },
    }));
    return store;
  }

  it('phase "claimed": the resume re-dispatches with the SAME idempotent identity', async () => {
    const store = crashState('claimed');
    const creates: string[] = [];
    store.pipeline = async (request, phases) => {
      expect(request.reason).toBe('resume');
      if (request.resumeSessionId === undefined) {
        creates.push('created');
        expect(await phases!.onSessionCreated('ses_new')).toBe(true);
      }
      expect(await phases!.onAccepted(request.resumeSessionId ?? 'ses_new')).toBe(true);
      return { sessionID: request.resumeSessionId ?? 'ses_new' };
    };
    const runtime = makeRuntime(store);
    await runtime.start(); // boot sync enqueues the resume
    await vi.advanceTimersByTimeAsync(1);
    expect(creates).toEqual(['created']);
    const completion = store.patches.at(-1)!;
    expect(completion.patch.lastStatus).toBe('success');
    expect(completion.patch.lastSessionId).toBe('ses_new');
    expect(completion.patch.dispatch).toBeUndefined(); // settled, record cleared
    runtime.stop();
  });

  it('phase "creating": the unknown session-create outcome settles as error, no resubmit', async () => {
    const store = crashState('creating');
    let pipelineCalls = 0;
    store.pipeline = async () => { pipelineCalls += 1; return { sessionID: 'ses_never' }; };
    const runtime = makeRuntime(store);
    await runtime.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(pipelineCalls).toBe(0); // NOTHING is re-dispatched
    const completion = store.patches.at(-1)!;
    expect(completion.patch.lastStatus).toBe('error');
    expect(String(completion.patch.lastError)).toContain('unknown after restart');
    expect(completion.patch.dispatch).toBeUndefined();
    runtime.stop();
  });

  it('phase "session-created": the resume re-dispatches to the RECORDED session (idempotent 204 path)', async () => {
    const store = crashState('session-created', 'ses_known');
    store.pipeline = async (request, phases) => {
      expect(request.resumeSessionId).toBe('ses_known'); // no second create
      expect(await phases!.onAccepted('ses_known')).toBe(true);
      return { sessionID: 'ses_known' };
    };
    const runtime = makeRuntime(store);
    await runtime.start();
    await vi.advanceTimersByTimeAsync(1);
    const completion = store.patches.at(-1)!;
    expect(completion.patch.lastStatus).toBe('success');
    expect(completion.patch.lastSessionId).toBe('ses_known');
    runtime.stop();
  });

  it('phase "accepted": the crash hidden acceptance settles from the record alone', async () => {
    const store = crashState('accepted', 'ses_done');
    let pipelineCalls = 0;
    store.pipeline = async () => { pipelineCalls += 1; return { sessionID: 'x' }; };
    const runtime = makeRuntime(store);
    await runtime.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(pipelineCalls).toBe(0); // the acceptance is NOT resubmitted
    const completion = store.patches.at(-1)!;
    expect(completion.patch.lastStatus).toBe('success');
    expect(completion.patch.lastSessionId).toBe('ses_done');
    runtime.stop();
  });

  it('a record owned by a live process is never resumed', async () => {
    const store = makeStore();
    seed(store, 'proj', taskDoc({
      state: {
        createdAt: t0, updatedAt: t0, lastStatus: 'running', lastScheduledFor: SLOT,
        nextRunAt: Date.UTC(2026, 8, 23, 9),
        dispatch: {
          scheduledFor: SLOT,
          operationId: operationIdForOccurrence('task-1', SLOT),
          phase: 'claimed',
          pid: process.pid, // this very process owns the record (in-flight run)
          updatedAt: t0,
        },
      },
    }));
    let pipelineCalls = 0;
    store.pipeline = async () => { pipelineCalls += 1; return { sessionID: 'x' }; };
    const runtime = makeRuntime(store);
    await runtime.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(pipelineCalls).toBe(0);
    expect(store.patches.some((entry) => entry.patch.lastStatus === 'success')).toBe(false);
    runtime.stop();
  });

  it('user stop racing the restart continuation: a disabled task never resumes its claim', async () => {
    const store = makeStore();
    seed(store, 'proj', taskDoc({
      // the stop landed in the store while the process was down
      enabled: false,
      state: {
        createdAt: t0, updatedAt: t0, lastStatus: 'running', lastScheduledFor: SLOT,
        nextRunAt: undefined,
        dispatch: {
          scheduledFor: SLOT,
          operationId: operationIdForOccurrence('task-1', SLOT),
          phase: 'claimed',
          pid: 4_194_303,
          updatedAt: t0,
        },
      },
    }));
    let pipelineCalls = 0;
    store.pipeline = async () => { pipelineCalls += 1; return { sessionID: 'x' }; };
    const runtime = makeRuntime(store);
    await runtime.start(); // the sync enqueues the resume...
    await vi.advanceTimersByTimeAsync(1);
    // ...but the durable stop guard outranks the automatic continuation.
    expect(pipelineCalls).toBe(0);
    const completion = store.patches.at(-1)!;
    expect(completion.patch.lastStatus).toBe('error');
    expect(String(completion.patch.lastError)).toContain('user stop');
    expect(completion.patch.dispatch).toBeUndefined(); // settled, never submitted
    runtime.stop();
  });
});

describe('duplicate occurrence claim and the durable stop guard', () => {
  it('a duplicate due fire for an already-claimed occurrence never dispatches twice', async () => {
    const store = makeStore();
    seed(store, 'proj', taskDoc());
    let dispatches = 0;
    store.pipeline = async (request, phases) => {
      dispatches += 1;
      await phases!.onSessionCreated('ses_1');
      await phases!.onAccepted('ses_1');
      return { sessionID: 'ses_1' };
    };
    const runtime = makeRuntime(store);
    await runtime.start(); // sync arms the due slot
    await vi.advanceTimersByTimeAsync(DUE + 1 - t0);
    expect(dispatches).toBe(1);
    // The SAME slot fires again through the pump (the lost-acknowledgement retry).
    const outcome: RunOutcome = await runtime.internals.runTask({
      projectId: 'proj', taskId: 'task-1', reason: 'scheduled', scheduledFor: SLOT,
    });
    expect(outcome.skipped).toBe(true);
    expect(outcome.reason).toBe('occurrence-claimed');
    expect(dispatches).toBe(1); // still one native submission for this occurrence
    runtime.stop();
  });

  it('user stop racing the due fire: a durable disable refuses the claim', async () => {
    const store = makeStore();
    seed(store, 'proj', taskDoc());
    let dispatches = 0;
    store.pipeline = async () => { dispatches += 1; return { sessionID: 'ses_1' }; };
    const runtime = makeRuntime(store);
    await runtime.start();
    // The stop lands in the STORE after arming, before the claim executes.
    const raw = store.projects.get('proj')!.get('task-1')!;
    store.projects.get('proj')!.set('task-1', { ...raw, enabled: false });
    await vi.advanceTimersByTimeAsync(DUE + 1 - t0);
    expect(dispatches).toBe(0); // the claim predicate read the disabled record
    runtime.stop();
  });

  it('the claim predicate itself refuses a disabled record regardless of slot state', () => {
    const disabled = { enabled: false, state: {} };
    expect(canClaimOccurrence(SLOT)(disabled)).toBe(false);
    const enabled = { enabled: true, state: {} };
    expect(canClaimOccurrence(SLOT)(enabled)).toBe(true);
    // and a pending resume of a stop-guarded occurrence settles as error:
    const dispatch = dispatchOf({ state: { dispatch: { scheduledFor: SLOT, operationId: 'op', phase: 'claimed', updatedAt: 1 } } });
    expect(dispatch).not.toBeNull();
  });
});
