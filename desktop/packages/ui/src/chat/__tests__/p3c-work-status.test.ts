// SPDX-License-Identifier: Apache-2.0
/**
 * P3c gates: work-status selectors (context % + rollup math + turn stats),
 * §E.9 panel eligibility gate (ready gate only-on-success, stats survive the
 * next active turn), subagent status phrases, todo ordering, §E.3 recap
 * validity window, and the §G no-borrow rule.
 */
import { describe, expect, it } from 'vitest';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { contextUsage, nnaActiveTools, nnaContextUsage, nnaGovernanceSummary, nnaSessionConfiguredModel, nnaTurnPhase, nnaWorkSummary, sessionCostRollup, subagentRows, todoRows, turnStats, usageRows, recapFor } from '../work-status.ts';
import { panelEligible, panelStatsIfNeeded } from '../panel-gate.ts';
import { INITIAL_STATE, type DirectoryStore } from '../../sync/types.ts';
import type { Message, Todo } from '../../lib/nnd/types.ts';

function emptyStore(): StoreApi<DirectoryStore> {
  return createStore<DirectoryStore>(() => ({
    ...JSON.parse(JSON.stringify(INITIAL_STATE)) as unknown as DirectoryStore,
    patch: () => undefined,
    replace: () => undefined,
  }));
}

const TOKENS = { total: 42, input: 30, output: 12, reasoning: 2, cache: { read: 0, write: 0 } };

function assistantMessage(id: string, created: number, overrides: Partial<import('../../lib/nnd/types.ts').PresentationMessage> = {}): Message {
  const time = (overrides.time as { created?: number; completed?: number } | undefined) ?? { created, completed: created + 900 };
  return {
    id, sessionID: 's1', role: 'assistant',
    time: { created: time.created ?? created, completed: time.completed },
    providerID: 'p', modelID: 'm',
    ...(overrides as object),
  } as unknown as Message;
}

describe('context usage (unrounded; never a fabricated 100%)', () => {
  it('uses the latest reporting assistant message; null without a limit', () => {
    const store = emptyStore();
    patch(store, { message: { s1: [
      assistantMessage('a1', 1, { tokens: { total: 10, input: 6, output: 4, reasoning: 0, cache: { read: 0, write: 0 } } }),
      assistantMessage('a2', 2, { tokens: TOKENS }),
    ] } });
    const usage = contextUsage(store.getState(), 's1');
    expect(usage.percent).toBeNull(); // no limit known — supply per model (P5)
    expect(usage.tokens?.total).toBe(42);
    expect(usage.lastMessageID).toBe('a2');
    const bounded = contextUsage(store.getState(), 's1', 100);
    expect(bounded.percent).toBeCloseTo(42, 5); // unrounded, not bucketed
  });
});

describe('NNA context measurement', () => {
  it('uses an explicit estimated projection and rejects malformed or absent data', () => {
    const store = emptyStore();
    expect(nnaContextUsage(store.getState(), 's1')).toBeNull();
    patch(store, { session: [{ id: 's1', metadata: { nnd: { context: {
      estimatedTokens: 4_000, limitTokens: 16_000, measurement: 'estimated', observedAt: 1,
    } } }, time: { created: 1, updated: 1 } }] } as unknown as Partial<DirectoryStore>);
    expect(nnaContextUsage(store.getState(), 's1')).toEqual({ estimatedTokens: 4_000, limitTokens: 16_000, percent: 25 });
    patch(store, { session: [{ id: 's1', metadata: { nnd: { context: {
      estimatedTokens: 4_000, limitTokens: null, measurement: 'estimated', observedAt: 2,
    } } }, time: { created: 1, updated: 1 } }] } as unknown as Partial<DirectoryStore>);
    expect(nnaContextUsage(store.getState(), 's1')).toEqual({ estimatedTokens: 4_000, limitTokens: null, percent: null });
    patch(store, { session: [{ id: 's1', metadata: { nnd: { context: {
      estimatedTokens: -1, limitTokens: 16_000, measurement: 'estimated', observedAt: 3,
    } } }, time: { created: 1, updated: 1 } }] } as unknown as Partial<DirectoryStore>);
    expect(nnaContextUsage(store.getState(), 's1')).toBeNull();
  });
});

describe('NNA-authored turn phase', () => {
  it('accepts the bounded semantic phase only from session-owned NNA metadata', () => {
    const store = emptyStore();
    expect(nnaTurnPhase(store.getState(), 's1')).toBeNull();
    patch(store, { session: [{ id: 's1', metadata: { nnd: { turnState: {
      phase: 'waiting_provider', secret: 'not a display field',
    } } }, time: { created: 1, updated: 2 } }] } as unknown as Partial<DirectoryStore>);
    expect(nnaTurnPhase(store.getState(), 's1')).toBe('waiting_provider');
    patch(store, { session: [{ id: 's1', metadata: { nnd: { turnState: {
      phase: 'made_up_phase',
    } } }, time: { created: 1, updated: 3 } }] } as unknown as Partial<DirectoryStore>);
    expect(nnaTurnPhase(store.getState(), 's1')).toBeNull();
  });
});

describe('NNA live tool projection', () => {
  it('reads only a bounded per-session snapshot, not old tool activity', () => {
    const store = emptyStore();
    expect(nnaActiveTools(store.getState(), 's1')).toBeNull();
    patch(store, { session: [{ id: 's1', metadata: { nnd: { activeTools: {
      count: 2, names: ['shell_run', 'edit'], secret: 'private',
    } } }, time: { created: 1, updated: 2 } }] } as unknown as Partial<DirectoryStore>);
    expect(nnaActiveTools(store.getState(), 's1')).toEqual({ count: 2, names: ['shell_run', 'edit'] });
    patch(store, { session: [{ id: 's1', metadata: { nnd: { activeTools: {
      count: 0, names: [],
    } } }, time: { created: 1, updated: 3 } }] } as unknown as Partial<DirectoryStore>);
    expect(nnaActiveTools(store.getState(), 's1')).toEqual({ count: 0, names: [] });
    expect(nnaActiveTools(store.getState(), 'other')).toBeNull();
    patch(store, { session: [{ id: 's1', metadata: { nnd: { activeTools: {
      count: 2, names: ['shell_run'],
    } } }, time: { created: 1, updated: 4 } }] } as unknown as Partial<DirectoryStore>);
    expect(nnaActiveTools(store.getState(), 's1')).toBeNull();
  });
});

describe('NNA governance projection', () => {
  it('accepts only the classified fields that NNA authors', () => {
    const store = emptyStore();
    expect(nnaGovernanceSummary(store.getState(), 's1')).toBeNull();
    patch(store, { session: [{ id: 's1', metadata: { nnd: { governance: {
      reviewPosture: 'prompt', recordHealth: 'attention', durable: true,
      attentionEvidence: 2, unsettledDecisions: 1, uncertainEffects: 0,
      secret: 'must not render',
    } } }, time: { created: 1, updated: 1 } }] } as unknown as Partial<DirectoryStore>);
    expect(nnaGovernanceSummary(store.getState(), 's1')).toEqual({
      reviewPosture: 'prompt', recordHealth: 'attention', durable: true,
      attentionEvidence: 2, unsettledDecisions: 1, uncertainEffects: 0,
    });
    patch(store, { session: [{ id: 's1', metadata: { nnd: { governance: {
      reviewPosture: 'bypass', recordHealth: 'approved', attentionEvidence: -1,
    } } }, time: { created: 1, updated: 1 } }] } as unknown as Partial<DirectoryStore>);
    expect(nnaGovernanceSummary(store.getState(), 's1')).toBeNull();
  });
});

describe('NNA session configured route', () => {
  it('accepts only the two bounded route IDs from session metadata', () => {
    const store = emptyStore();
    patch(store, { session: [{ id: 'child', metadata: { nnd: { configuredModel: {
      providerID: 'local', modelID: 'subagent', secret: 'never render',
    } } }, time: { created: 1, updated: 1 } }] } as unknown as Partial<DirectoryStore>);
    expect(nnaSessionConfiguredModel(store.getState(), 'child')).toEqual({ providerID: 'local', modelID: 'subagent' });
    patch(store, { session: [{ id: 'child', metadata: { nnd: { configuredModel: {
      providerID: 'local', modelID: '\u0000bad',
    } } }, time: { created: 1, updated: 1 } }] } as unknown as Partial<DirectoryStore>);
    expect(nnaSessionConfiguredModel(store.getState(), 'child')).toBeNull();
  });
});

describe('NNA canonical conversation work', () => {
  it('projects only goal and task status, ignoring evidence and unrelated fields', () => {
    const store = emptyStore();
    expect(nnaWorkSummary(store.getState(), 's1')).toBeNull();
    patch(store, { session: [{ id: 's1', metadata: { nnd: { work: {
      revision: 3,
      goal: { id: 'goal_1', objective: 'Build NND', status: 'active', evidence: 'private' },
      tasks: [{ id: 'T1', title: 'Connect rail', status: 'in_progress', evidence: 'private' }],
      pendingCompletion: { secret: 'private' },
    } } }, time: { created: 1, updated: 1 } }] } as unknown as Partial<DirectoryStore>);
    expect(nnaWorkSummary(store.getState(), 's1')).toEqual({
      revision: 3, goal: { id: 'goal_1', objective: 'Build NND', status: 'active' },
      tasks: [{ id: 'T1', title: 'Connect rail', status: 'in_progress' }],
    });
    patch(store, { session: [{ id: 's1', metadata: { nnd: { work: {
      revision: 4, goal: null, tasks: [{ id: 'bad', title: 'Wrong ID', status: 'pending' }],
    } } }, time: { created: 1, updated: 2 } }] } as unknown as Partial<DirectoryStore>);
    expect(nnaWorkSummary(store.getState(), 's1')).toBeNull();
  });
});

describe('subtree cost rollup (§E.9 subagents)', () => {
  it('rolls parent + descendants, rounded to cents', () => {
    const store = emptyStore();
    patch(store, {
      session: [
        { id: 'p', time: {} },
        { id: 'c1', parentID: 'p', time: {} },
        { id: 'cc', parentID: 'c1', time: {} },
      ],
      message: {
        p: [assistantMessage('mp', 1, { cost: 1.111 })],
        c1: [assistantMessage('mc', 1, { cost: 0.2222 })],
        cc: [assistantMessage('mcc', 1, { cost: 2.0049 })],
      },
    } as unknown as Partial<DirectoryStore>);
    expect(sessionCostRollup(store.getState(), 'p')).toBeCloseTo(3.34, 2);
  });
});

describe('turn stats (§E.9 telemetry)', () => {
  it('computes whole turn, steps, and tokens once the turn completes', () => {
    const store = emptyStore();
    patch(store, { message: { s1: [
      { id: 'u', sessionID: 's1', role: 'user', time: { created: 0 } } as unknown as Message,
      { ...assistantMessage('a1', 5, { tokens: { total: 100, input: 40, output: 60, reasoning: 10, cache: { read: 0, write: 0 } }, time: { created: 5, completed: 1005 } }) },
    ] } });
    const stats = turnStats(store.getState(), 's1');
    expect(stats.wholeTurnMS).toBe(1005);
    expect(stats.steps).toBe(1);
    expect(stats.outputTokens).toBe(60);
    expect(stats.responseSpeedTokensPerSec).toBeCloseTo(59.7, 1); // 60 tokens / 1.005 s
  });
});

describe('panel gate (§E.9 + doc 04 gate rule 6)', () => {
  it('requires sessionStatusReady (a FAILED status fetch never grants idle authority)', () => {
    const store = emptyStore();
    patch(store, { sessionStatusReady: false, session_status: {}, message: { s1: [assistantMessage('a1', 1, { tokens: TOKENS })] } });
    expect(panelEligible(store.getState(), 's1')).toBe(false);
    patch(store, { sessionStatusReady: true });
    expect(panelEligible(store.getState(), 's1')).toBe(true);
  });

  it('committed stats survive the next active turn (one committed result keeps the panel stable)', () => {
    const store = emptyStore();
    patch(store, { sessionStatusReady: true, message: { s1: [assistantMessage('a1', 1, { tokens: TOKENS })] } });
    const committed = panelStatsIfNeeded(store.getState(), 's1', null);
    expect(committed).not.toBeNull();
    patch(store, { session_status: { s1: { type: 'busy' as const } } });
    const duringBusy = panelStatsIfNeeded(store.getState(), 's1', committed);
    expect(duringBusy).toBe(committed); // identity retention, no recompute
    patch(store, { session_status: {} });
    expect(panelEligible(store.getState(), 's1')).toBe(true);
    expect(panelStatsIfNeeded(store.getState(), 's1', committed)).toBe(committed);
  });
});

describe('subagent rows (§E.9) + tasks + §G no-borrow', () => {
  it('child phrases come from THEIR OWN status; cost is subtree rollup', () => {
    const store = emptyStore();
    patch(store, {
      session: [{ id: 'p', time: {} }, { id: 'c1', parentID: 'p', time: {}, title: 'explorer' }],
      message: { c1: [assistantMessage('a', 1, { cost: 0.5 })] },
    } as unknown as Partial<DirectoryStore>);
    const rows = subagentRows(store.getState(), 'p', () => 'working');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: 'explorer', statusPhrase: 'working', cost: 0.5 });
  });

  it('todos stay after completion and sort in-progress → pending → completed', () => {
    const store = emptyStore();
    const todos: Todo[] = [
      { content: 'b-done', status: 'completed', priority: 'high' },
      { content: 'a-active', status: 'in_progress', priority: 'high' },
      { content: 'c-wait', status: 'pending', priority: 'low' },
    ];
    patch(store, { todo: { s1: todos } });
    expect(todoRows(store.getState(), 's1').map((row) => row.content)).toEqual(['a-active', 'c-wait', 'b-done']);
  });

  it('usage rows never borrow another provider number (v1: single no-quota row)', () => {
    expect(usageRows()).toEqual([{ label: 'No rate limits reported', value: '—' }]);
  });

  it('recap validity: branded namespace, 60s quiet window, anchor freshness', () => {
    const store = emptyStore();
    patch(store, {
      sessionStatusReady: true,
      session: [{ id: 's1', time: {}, metadata: { openchamber: { assist: { recap: 'Built the thing', suggestion: 'Run tests next', forMessageID: 'a1', generatedAt: Date.now() } } } }],
      message: { s1: [assistantMessage('a1', 1, { tokens: TOKENS })] },
    } as unknown as Partial<DirectoryStore>);
    expect(recapFor(store.getState(), 's1', Date.now())).toBeNull(); // H.2 does not read the legacy nnd namespace
    const muchLater = 60_000 + 5_000;
    patch(store, {
      session: [{ id: 's1', time: {}, metadata: { openchamber: { assist: {
        recap: 'Built the thing', suggestion: 'Run tests next', forMessageID: 'a1',
        generatedAt: Date.now() - 64_000 } } } }],
    } as unknown as Partial<DirectoryStore>);
    const backed = recapFor(store.getState(), 's1', Date.now() + muchLater);
    expect(backed?.recap).toBe('Built the thing');
    expect(backed?.suggestion).toBe('Run tests next');
    patch(store, { message: { s1: [assistantMessage('a1', 1, { tokens: TOKENS }), assistantMessage('a2', 2, { tokens: TOKENS })] } });
    expect(recapFor(store.getState(), 's1', Date.now() + muchLater)).toBeNull(); // stale anchor
    patch(store, {
      session: [{ id: 's1', time: {}, metadata: { openchamber: { assist: { recap: 'Built the thing', suggestion: 'Run tests next', forMessageID: 'a1', generatedAt: Date.now() - 65_000 } } } }],
      message: { s1: [assistantMessage('a1', 1, { tokens: TOKENS })] },
    } as unknown as Partial<DirectoryStore>);
    expect(recapFor(store.getState(), 's1', Date.now(), { recap: true, suggestion: false }))
      .toEqual({ recap: 'Built the thing', suggestion: null });
    patch(store, {
      session_status: { s1: { type: 'busy' as const } },
      session: [{ id: 's1', time: {}, metadata: { openchamber: { assist: {
        recap: 'Built the thing', suggestion: 'Run tests next', forMessageID: 'a1',
        generatedAt: Date.now() - 65_000 } } } }],
    } as unknown as Partial<DirectoryStore>);
    expect(recapFor(store.getState(), 's1')).toBeNull();
    patch(store, {
      session_status: {},
      session: [{ id: 's1', time: {}, metadata: { openchamber: { assist: {
        recap: 'Built the thing', suggestion: 'Run tests next', forMessageID: 'a1',
        generatedAt: Date.now() - 200 * 24 * 60 * 60 * 1000 } } } }],
    } as unknown as Partial<DirectoryStore>);
    expect(recapFor(store.getState(), 's1')).toBeNull();
  });
});

function patch(store: StoreApi<DirectoryStore>, partial: Partial<DirectoryStore>): void {
  store.setState(partial as never);
}
