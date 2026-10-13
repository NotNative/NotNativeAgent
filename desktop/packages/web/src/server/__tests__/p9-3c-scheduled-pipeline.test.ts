// SPDX-License-Identifier: Apache-2.0
/** P9-3c scheduled run pipeline: C.6 adapter, C.10 fanout, service wiring. */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath, sep } from 'node:path';

const isolatedDataDir = mkdtempSync(`${tmpdir()}${sep}nnd-p93c-`);
process.env.NOTNATIVE_DATA_DIR = isolatedDataDir;

const T0 = Date.UTC(2026, 8, 25, 7, 30, 0); // Fri 2026-09-25 09:30 Berlin wall
const OPTS = { now: T0, serverZone: 'UTC' };

const configMod = await import('../scheduled/task-config.ts');
const schemaMod = await import('../scheduled/task-schema.ts');
const busMod = await import('../lib/bus.ts');
const pipelineMod = await import('../scheduled/scheduled-pipeline.ts');
const serviceMod = await import('../scheduled/scheduled-service.ts');
const goalPayloadMod = await import('../goals/goal-payload.ts');
const { NULL_KNOWLEDGE_PROVIDER } = await import('../queue/queue-hooks.ts');
const runtimeMod = await import('../scheduled/scheduled-runtime.ts');
const { CONTROL_EVENTS } = await import('../lib/harnessNaming.ts');

type PipelineDeps = Parameters<typeof pipelineMod.createScheduledRunPipeline>[0];
type HarnessPorts = PipelineDeps['harness'];
type Task = Parameters<ReturnType<typeof pipelineMod.createScheduledRunPipeline>>[1];
type GoalBody = Parameters<HarnessPorts['writeGoal']>[2];

interface HarnessRecorders {
  creates: Array<{ directory: string; title: string }>;
  prompts: Array<{ sessionId: string; directory: string; body: Record<string, unknown> }>;
  commands: Array<{ sessionId: string; directory: string; body: Record<string, unknown> }>;
  goals: Array<{ sessionId: string; directory: string; body: GoalBody }>;
  objectiveReads: number;
}

function taskDoc(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'task-1', name: 'Nightly digest', enabled: true,
    schedule: { kind: 'daily', times: ['09:00'], timezone: 'Europe/Berlin' },
    execution: { prompt: 'Summarize the inbox', providerID: 'acme', modelID: 'fast' },
    state: { createdAt: T0, updatedAt: T0, lastStatus: 'idle' },
    ...patch,
  };
}

function executionPatch(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...(taskDoc().execution as Record<string, unknown>), ...patch };
}

function makeTask(patch: Record<string, unknown> = {}): Task {
  const outcome = schemaMod.normalizeTaskForStorage(taskDoc(patch), OPTS);
  if (!outcome.ok) throw new Error(`fixture task refused: ${outcome.reason}`);
  return outcome.task;
}

function makeHarness(configuration: {
  catalog?: unknown;
  readSession?: unknown;
  writeGoalOk?: boolean;
  sessionCreated?: unknown;
  worktree?: string | null;
} = {}): { harness: HarnessPorts; calls: HarnessRecorders } {
  const calls: HarnessRecorders = { creates: [], prompts: [], commands: [], goals: [], objectiveReads: 0 };
  const harness: HarnessPorts = {
    createSession: async (directory, title) => {
      calls.creates.push({ directory, title });
      return configuration.sessionCreated !== undefined ? configuration.sessionCreated : { id: 'sess-1', directory, title };
    },
    sendPrompt: async (sessionId, directory, body) => {
      calls.prompts.push({ sessionId, directory, body });
      return { ok: true, status: 200 };
    },
    sendCommand: async (sessionId, directory, body) => {
      calls.commands.push({ sessionId, directory, body });
      return { ok: true, status: 200 };
    },
    listCommands: async () => configuration.catalog ?? [],
    readSession: async (sessionId) => {
      calls.objectiveReads += 1;
      void sessionId;
      return configuration.readSession !== undefined ? configuration.readSession : {};
    },
    writeGoal: async (sessionId, directory, body: GoalBody) => {
      calls.goals.push({ sessionId, directory, body });
      return configuration.writeGoalOk !== undefined ? configuration.writeGoalOk : true;
    },
    resolveDirectory: async () => configuration.worktree !== undefined ? configuration.worktree : '/repo/alpha',
  };
  return { harness, calls };
}

function makeDeps(harness: HarnessPorts, overrides: Partial<PipelineDeps> = {}) {
  const events: Array<{ projectId: string; taskId: string; ranAt: number; sessionID: string }> = [];
  const warnings: string[] = [];
  const objectiveWrites: Array<{ sessionId: string; content: string }> = [];
  let tick = T0;
  const deps: PipelineDeps = {
    harness,
    knowledge: NULL_KNOWLEDGE_PROVIDER,
    emitRunning: (event) => { events.push(event); },
    waitForReady: async () => true,
    expandPrompt: async (text) => text,
    objectiveStore: {
      write: async (sessionId, content) => {
        objectiveWrites.push({ sessionId, content });
        return 'a'.repeat(64);
      },
    },
    log: { warn: (message) => { warnings.push(message); }, error: (message) => { void message; } },
    now: () => (tick += 10),
    ...overrides,
  };
  return { deps, events, warnings, objectiveWrites };
}

type RunRequest = Parameters<ReturnType<typeof pipelineMod.createScheduledRunPipeline>>[0];

function runRequest(patch: Record<string, unknown> = {}): RunRequest {
  return { projectId: 'proj-alpha', taskId: 'task-1', reason: 'scheduled', scheduledFor: T0, ...patch } as RunRequest;
}

function knowledgeStub(textInput: string | null, fail = false) {
  const delivered: string[] = [];
  return {
    knowledge: {
      resolve: async () => { if (fail) throw new Error('knowledge store locked'); return textInput; },
      recordDelivered: (sessionId: string) => { delivered.push(sessionId); },
    },
    delivered,
  };
}

function partsOf(body: Record<string, unknown>): Array<Record<string, unknown>> {
  return (body.parts as Array<Record<string, unknown>>) ?? [];
}

afterAll(() => { rmSync(isolatedDataDir, { recursive: true, force: true }); });

describe('scheduled pipeline (C.6)', () => {
  it('titles the run with the clipped name and the slot zone wall clock', () => {
    const task = makeTask();
    expect(pipelineMod.runTitle(task, T0)).toBe('Nightly digest 2026-09-25 09:30');
    // the schema caps names at 80; the clip guards hand-edited or future raw names
    const long = { ...task, name: 'x'.repeat(200), schedule: { kind: 'daily', times: ['09:00'], timezone: 'Europe/Berlin' } } as unknown as Task;
    const title = pipelineMod.runTitle(long, T0);
    expect(title.startsWith('x'.repeat(120) + ' ')).toBe(true);
    expect(title).toBe('x'.repeat(120) + ' 2026-09-25 09:30');
  });

  it('dispatches the plain prompt with model binding and no synthetic parts when goalless', async () => {
    const { harness, calls } = makeHarness();
    const { deps, events } = makeDeps(harness);
    const outcome = await pipelineMod.createScheduledRunPipeline(deps)(runRequest(), makeTask());
    expect(outcome.sessionID).toBe('sess-1');
    expect(outcome.reason).toBe('scheduled');
    expect(outcome.durationMs).toBeGreaterThan(0);
    expect(calls.creates).toEqual([{ directory: '/repo/alpha', title: 'Nightly digest 2026-09-25 09:30' }]);
    expect(calls.prompts).toHaveLength(1);
    expect(calls.prompts[0]!.sessionId).toBe('sess-1');
    expect(calls.prompts[0]!.body).toEqual({
      model: { providerID: 'acme', modelID: 'fast' },
      parts: [{ type: 'text', text: 'Summarize the inbox' }],
    });
    expect(events).toEqual([{
      projectId: 'proj-alpha', taskId: 'task-1', ranAt: T0 + 10, sessionID: 'sess-1',
    }]);
  });

  it('orders knowledge, prompt, goal intro and records delivery only after ok', async () => {
    const { harness, calls } = makeHarness();
    const knowledge = knowledgeStub('Learnings: X');
    const { deps } = makeDeps(harness, { knowledge: knowledge.knowledge });
    const goaled = makeTask({ execution: executionPatch({ goalEnabled: true, goalTokenBudget: 5000 }) });
    const outcome = await pipelineMod.createScheduledRunPipeline(deps)(runRequest(), goaled);
    expect(outcome.sessionID).toBe('sess-1');
    const parts = partsOf(calls.prompts[0]!.body);
    expect(parts[0]).toEqual({ type: 'text', text: 'Learnings: X', synthetic: true });
    expect(parts[1]).toEqual({ type: 'text', text: 'Summarize the inbox' });
    expect(parts[2]).toEqual({ type: 'text', text: pipelineMod.goalIntro(5000), synthetic: true });
    expect(calls.goals[0]!.body.goal.status).toBe('active');
    expect(calls.goals[0]!.body.expected_id).toBeNull();
    expect(calls.goals[0]!.body.expected_revision).toBe(0);
    expect(calls.objectiveReads).toBe(1);
  });

  it('passes fresh-session revision tolerance and existing-goal guards', async () => {
    const seededGoal = goalPayloadMod.buildGoalPayload({ objective: 'earlier', objectiveFile: false, now: T0 - 1 });
    const { harness, calls } = makeHarness({
      readSession: { metadata: { nnd: { goalRevision: 3, goal: seededGoal } } },
    });
    const { deps } = makeDeps(harness);
    const goaled = makeTask({ execution: executionPatch({ goalEnabled: true }) });
    await pipelineMod.createScheduledRunPipeline(deps)(runRequest(), goaled);
    expect(calls.goals[0]!.body.expected_id).toBe(seededGoal.id);
    expect(calls.goals[0]!.body.expected_revision).toBe(3);

    const dirty = makeHarness({ readSession: { metadata: { nnd: { goal: seededGoal } } } });
    const outcome = pipelineMod.createScheduledRunPipeline(makeDeps(dirty.harness).deps)(runRequest(), goaled);
    await expect(outcome).rejects.toThrow(/goal revision is unavailable/);
    expect(dirty.calls.goals).toHaveLength(0);
  });

  it('omits the goal intro when the goal write is refused, dispatching anyway', async () => {
    const { harness, calls } = makeHarness({ writeGoalOk: false });
    const { deps, warnings } = makeDeps(harness);
    const goaled = makeTask({ execution: executionPatch({ goalEnabled: true }) });
    const outcome = await pipelineMod.createScheduledRunPipeline(deps)(runRequest(), goaled);
    expect(outcome.sessionID).toBe('sess-1');
    expect(partsOf(calls.prompts[0]!.body)).toEqual([{ type: 'text', text: 'Summarize the inbox' }]);
    expect(warnings.some((m) => m.includes('goal planting refused'))).toBe(true);
  });

  it('fits a long goal through B.6.3: the excerpt fallback when no port is bound', async () => {
    const longPrompt = 'y'.repeat(5001);
    const goaled = makeTask({ execution: executionPatch({ goalEnabled: true, prompt: longPrompt }) });
    const file = makeHarness();
    const { deps, objectiveWrites } = makeDeps(file.harness);
    await pipelineMod.createScheduledRunPipeline(deps)(runRequest(), goaled);
    const goal = file.calls.goals[0]!.body.goal;
    expect(goal.objective).toHaveLength(4000);
    expect(goal.objective).toContain('[. objective trimmed for the auditor - the full prompt was delivered in the chat message .]');
    expect(goal.objective.startsWith('yyy')).toBe(true);
    expect(goal.objective.endsWith('yyy')).toBe(true);
    expect(goal.objectiveFile).toBe(false);
    expect(objectiveWrites).toHaveLength(0); // the fitted text never needs the file
  });

  it('distills a long goal through the bound port, passing the execution pair', async () => {
    const distillArgs: Array<[string, { providerID: string; modelID: string } | null]> = [];
    const goaled = makeTask({ execution: executionPatch({ goalEnabled: true, prompt: 'x'.repeat(5001), providerID: 'acme-x', modelID: 'fast-x' }) });
    const file = makeHarness();
    const { deps } = makeDeps(file.harness, {
      distill: async (raw, preference) => { distillArgs.push([raw, preference ?? null]); return 'CRITERIA: inbox summarized'; },
    });
    await pipelineMod.createScheduledRunPipeline(deps)(runRequest(), goaled);
    const goal = file.calls.goals[0]!.body.goal;
    expect(goal.objective).toBe('CRITERIA: inbox summarized');
    expect(distillArgs[0]![0]).toHaveLength(5001);
    expect(distillArgs[0]![1]).toEqual({ providerID: 'acme-x', modelID: 'fast-x' });
    expect(goal.objectiveFile).toBe(false);
  });

  it('folds a throwing distill port to the excerpt without failing the run', async () => {
    const goaled = makeTask({ execution: executionPatch({ goalEnabled: true, prompt: 'z'.repeat(5001) }) });
    const file = makeHarness();
    const { deps, warnings } = makeDeps(file.harness, {
      distill: async () => { throw new Error('small model 429'); },
    });
    await expect(pipelineMod.createScheduledRunPipeline(deps)(runRequest(), goaled)).resolves.toMatchObject({ sessionID: 'sess-1' });
    const goal = file.calls.goals[0]!.body.goal;
    expect(goal.objective).toHaveLength(4000);
    expect(goal.objective).toContain('[. objective trimmed');
    expect(warnings.filter((m) => m.includes('objective file')).length).toBe(0);
  });

  it('expands a matched slash command on the command route with the model string', async () => {
    const catalog = [{ name: 'deploy', source: 'user', template: 'Deploy $ARGUMENTS now' }];
    const { harness, calls } = makeHarness({ catalog });
    const { deps } = makeDeps(harness);
    const cmd = makeTask({ execution: executionPatch({ prompt: '/deploy the app', goalEnabled: true }) });
    const outcome = await pipelineMod.createScheduledRunPipeline(deps)(runRequest(), cmd);
    expect(outcome.sessionID).toBe('sess-1');
    expect(calls.prompts).toHaveLength(0);
    expect(calls.commands[0]!.body).toEqual({
      command: 'deploy', arguments: 'the app', model: 'acme/fast',
    });
    expect(calls.goals[0]!.body.goal.objective).toBe('Deploy the app now');
  });

  it('applies the B.8 positional rule on the command-route goal objective', async () => {
    const catalog = [{ name: 'qa', source: 'project', template: 'Run tests $2' }];
    const { harness, calls } = makeHarness({ catalog });
    const { deps } = makeDeps(harness);
    const cmd = makeTask({ execution: executionPatch({ prompt: '/qa one two three', goalEnabled: true, goalTokenBudget: 400 }) });
    await pipelineMod.createScheduledRunPipeline(deps)(runRequest(), cmd);
    expect(calls.commands[0]!.body.arguments).toBe('one two three');
    expect(calls.goals[0]!.body.goal.objective).toBe('Run tests two three');
    expect(calls.goals[0]!.body.goal.tokenBudget).toBe(400);
    expect(calls.goals[0]!.body.goal.evaluationProviderID).toBe('acme');
  });

  it('degrades an unmatched slash, a skill match, and a catalog read failure to the plain prompt', async () => {
    const unmatched = makeHarness({ catalog: [{ name: 'other', source: 'user', template: 'T' }] });
    await pipelineMod.createScheduledRunPipeline(makeDeps(unmatched.harness).deps)(
      runRequest(), makeTask({ execution: executionPatch({ prompt: '/deploy now' }) }));
    expect(unmatched.calls.prompts[0]!.body.parts).toEqual([{ type: 'text', text: '/deploy now' }]);

    const skill = makeHarness({ catalog: [{ name: 'deep', source: 'skill', template: 'T' }] });
    await pipelineMod.createScheduledRunPipeline(makeDeps(skill.harness).deps)(
      runRequest(), makeTask({ execution: executionPatch({ prompt: '/deep stuff' }) }));
    expect(skill.calls.prompts[0]!.body.parts).toEqual([{ type: 'text', text: '/deep stuff' }]);

    const brokenCalls = makeHarness();
    const broken: HarnessPorts = {
      ...brokenCalls.harness, listCommands: async () => { throw new Error('boom'); },
    };
    await pipelineMod.createScheduledRunPipeline(makeDeps(broken).deps)(
      runRequest(), makeTask({ execution: executionPatch({ prompt: '/deploy now' }) }));
    expect(brokenCalls.calls.prompts[0]!.body.parts).toEqual([{ type: 'text', text: '/deploy now' }]);
  });

  it('sends without knowledge on lookup failure and tolerates delivery-record failure', async () => {
    const failing = knowledgeStub(null, true);
    const { harness, calls } = makeHarness();
    const { deps, warnings } = makeDeps(harness, { knowledge: failing.knowledge });
    await pipelineMod.createScheduledRunPipeline(deps)(runRequest(), makeTask());
    expect(calls.prompts[0]!.body.parts).toEqual([{ type: 'text', text: 'Summarize the inbox' }]);
    expect(failing.delivered).toHaveLength(0);
    expect(warnings.some((m) => m.includes('knowledge lookup failed'))).toBe(true);

    const throwing = knowledgeStub('K');
    throwing.knowledge.recordDelivered = () => { throw new Error('nope'); };
    const second = makeHarness();
    const secondRun = makeDeps(second.harness, { knowledge: throwing.knowledge });
    const outcome = await pipelineMod.createScheduledRunPipeline(secondRun.deps)(runRequest(), makeTask());
    expect(outcome.sessionID).toBe('sess-1');
    expect(throwing.delivered).toHaveLength(0);
    expect(secondRun.warnings.some((m) => m.includes('knowledge delivery record failed'))).toBe(true);
  });

  it('treats blank knowledge as undelivered nothing, not a lookup failure', async () => {
    for (const textInput of ['', '   \n  ']) {
      const blank = knowledgeStub(textInput);
      const { harness, calls } = makeHarness();
      const { deps, warnings } = makeDeps(harness, { knowledge: blank.knowledge });
      await pipelineMod.createScheduledRunPipeline(deps)(runRequest(), makeTask());
      expect(partsOf(calls.prompts[0]!.body)).toEqual([{ type: 'text', text: 'Summarize the inbox' }]);
      expect(blank.delivered).toHaveLength(0);
      expect(warnings.some((m) => m.includes('knowledge lookup failed'))).toBe(false);
    }
  });

  it('proceeds on readiness and emitter failures while ignoring legacy auto-accept', async () => {
    const { harness, calls } = makeHarness();
    const { deps, warnings } = makeDeps(harness, {
      waitForReady: async () => false, emitRunning: () => { throw new Error('bus closed'); },
    });
    const task = makeTask({
      execution: executionPatch({ permissionAutoAccept: true }),
    });
    expect(task.execution).not.toHaveProperty('permissionAutoAccept');
    const outcome = await pipelineMod.createScheduledRunPipeline(deps)(runRequest(), task);
    expect(outcome.sessionID).toBe('sess-1');
    expect(calls.creates).toHaveLength(1);
    expect(warnings.some((m) => m.includes('not ready within the scheduled poll window'))).toBe(true);
    expect(warnings.some((m) => m.includes('running event refused'))).toBe(true);
  });

  it('fails the run on a missing worktree, a missing session id, or a rejected dispatch', async () => {
    const noProject = pipelineMod.createScheduledRunPipeline(
      makeDeps(makeHarness({ worktree: null }).harness).deps,
    )(runRequest(), makeTask());
    await expect(noProject).rejects.toThrow(/no harness worktree/);

    const noSession = pipelineMod.createScheduledRunPipeline(
      makeDeps(makeHarness({ sessionCreated: {} }).harness).deps,
    )(runRequest(), makeTask());
    await expect(noSession).rejects.toThrow(/returned no session id/);

    const rejected = makeHarness({ sessionCreated: { id: 's9' } });
    const badPrompt: HarnessPorts = {
      ...rejected.harness, sendPrompt: async () => ({ ok: false, status: 503 }),
    };
    const refused = pipelineMod.createScheduledRunPipeline(
      makeDeps(badPrompt).deps,
    )(runRequest(), makeTask());
    await expect(refused).rejects.toThrow(/prompt dispatch rejected with 503/);

    const cmdRejected = makeHarness({ catalog: [{ name: 'deploy', source: 'user', template: 'T' }] });
    const badCommand: HarnessPorts = {
      ...cmdRejected.harness, sendCommand: async () => ({ ok: false, status: 409 }),
    };
    const refusedCommand = pipelineMod.createScheduledRunPipeline(
      makeDeps(badCommand).deps,
    )(runRequest({ reason: 'manual', scheduledFor: undefined }), makeTask({
      execution: executionPatch({ prompt: '/deploy x' }),
    }));
    await expect(refusedCommand).rejects.toThrow(/command dispatch rejected with 409/);
  });
});

describe('goal intro builder (B.6.1)', () => {
  it('embeds the budget sentence before the closing tag exactly as worded', () => {
    const intro = pipelineMod.goalIntro(1234);
    expect(intro.startsWith('<system-reminder>\n')).toBe(true);
    expect(intro.endsWith('</system-reminder>')).toBe(true);
    expect(intro.includes(' A token budget of 1234 tokens applies to this goal.\n</system-reminder>')).toBe(true);
    expect(intro.includes('The user message above defines the goal objective.')).toBe(true);
    expect(pipelineMod.goalIntro(null)).not.toContain('token budget of');
    // the schema accepts goalTokenBudget 0, but parseTokenBudget nulls every
    // sub-1 budget: the intro must not claim a budget the goal will not carry
    expect(goalPayloadMod.buildGoalPayload({ objective: 'x', objectiveFile: false, tokenBudget: 0, now: T0 }).tokenBudget).toBeNull();
    expect(pipelineMod.goalIntro(0)).not.toContain('token budget of');
    expect(pipelineMod.goalIntro(-5)).not.toContain('token budget of');
  });
});

describe('C.10 fanout + service wiring', () => {
  it('publishes the branded event with the C.10 payload shape', () => {
    const seen: Array<{ type: string; payload: unknown }> = [];
    const off = busMod.subscribeControlEvents((event) => { seen.push({ type: event.type, payload: event.payload }); });
    try {
      serviceMod.emitTaskRunEvent({ projectId: 'p', taskId: 't', ranAt: 5, status: 'running', sessionID: 's1' });
      serviceMod.emitTaskRunEvent({ projectId: 'p', taskId: 't', ranAt: 9, status: 'success' });
    } finally {
      off();
    }
    expect(seen[0]!.type).toBe('notnative:scheduled-task-ran');
    expect(seen[0]!.type).toBe(CONTROL_EVENTS.scheduledTaskRan);
    expect(seen[0]!.payload).toEqual({ projectId: 'p', taskId: 't', ranAt: 5, status: 'running', sessionId: 's1' });
    expect(seen[1]!.payload).toEqual({ projectId: 'p', taskId: 't', ranAt: 9, status: 'success' });
  });

  it('lists project stems from the store directory only', async () => {
    const dir = joinPath(isolatedDataDir, 'projects');
    mkdirSync(dir, { recursive: true });
    writeFileSync(joinPath(dir, 'alpha.json'), '{}');
    writeFileSync(joinPath(dir, 'beta.json'), '{}');
    writeFileSync(joinPath(dir, 'odd.name.json'), '{}');
    writeFileSync(joinPath(dir, 'gamma.corrupt-12'), '{}');
    writeFileSync(joinPath(dir, 'notes.txt'), '{}');
    expect(await serviceMod.listScheduledProjects(dir)).toEqual(['alpha', 'beta']);
    expect(await serviceMod.listScheduledProjects(joinPath(dir, 'missing'))).toEqual([]);
  });

  it('syncs a real store, persists the next slot, and consumes a once task end-to-end', async () => {
    await configMod.upsertScheduledTask('omega', taskDoc({
      schedule: { kind: 'daily', times: ['23:00'], timezone: 'UTC' },
    }), OPTS);
    await configMod.upsertScheduledTask('zulu', taskDoc({
      id: 'task-once', name: 'One time', schedule: { kind: 'once', date: '2026-09-25', time: '10:00', timezone: 'UTC' },
    }), OPTS);

    const runtime: ReturnType<typeof runtimeMod.createScheduledTasksRuntime> = runtimeMod.createScheduledTasksRuntime({
      ...serviceMod.createScheduledStorePorts(),
      listProjects: async () => serviceMod.listScheduledProjects(),
      runPipeline: async () => ({ sessionID: 'unreachable' }),
      emit: () => {},
      log: { warn: (m) => { void m; }, error: (m) => { void m; } },
      now: () => T0,
      jitter: () => 0,
      normalizeOptions: OPTS,
    }, {});
    try {
      await runtime.start();
      const tasksKey = (await import('../scheduled/scheduled-constants.ts')).SCHEDULED_TASKS_KEY;
      const persisted = JSON.parse(readFileSync(configMod.scheduledConfigPath('omega'), 'utf8')) as Record<string, Array<{ id: string; state: Record<string, unknown> }>>;
      const digest = (persisted[tasksKey] ?? []).find((task) => task.id === 'task-1');
      expect(digest?.state.nextRunAt).toBe(Date.UTC(2026, 8, 25, 23, 0));
    } finally {
      runtime.stop();
    }

    const loaded = await configMod.loadScheduledTasks('zulu', OPTS);
    const onceTask = loaded.tasks.find((task) => task.id === 'task-once');
    expect(onceTask).toBeDefined();
    await configMod.upsertScheduledTask('zulu', { ...onceTask, enabled: false }, OPTS);
    const consumed = await configMod.loadScheduledTasks('zulu', OPTS);
    expect(consumed.tasks.find((task) => task.id === 'task-once')?.enabled).toBe(false);
  });
});
