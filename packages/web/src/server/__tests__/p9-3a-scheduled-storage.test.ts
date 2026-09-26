// SPDX-License-Identifier: Apache-2.0
/** P9-3a scheduled-task storage: next-run math, task schema, locked config. */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, fstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath, sep } from 'node:path';

const isolatedDataDir = mkdtempSync(`${tmpdir()}${sep}nnd-sched-`);
process.env.NOTNATIVE_DATA_DIR = isolatedDataDir;

const t0 = Date.UTC(2026, 8, 21, 9, 0, 0); // Mon 2026-09-21 09:00Z
const OPTS = { now: t0, serverZone: 'UTC' };

const nextRun = await import('../scheduled/next-run.ts');
const schemaMod = await import('../scheduled/task-schema.ts');
const configMod = await import('../scheduled/task-config.ts');
const lockMod = await import('../scheduled/config-lock.ts');

function writeConfig(projectId: string, doc: unknown): string {
  const dir = joinPath(isolatedDataDir, 'projects');
  mkdirSync(dir, { recursive: true });
  const path = configMod.scheduledConfigPath(projectId);
  writeFileSync(path, JSON.stringify(doc, null, 2));
  return path;
}

function taskDoc(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'task-1', name: 'Nightly digest', enabled: true,
    schedule: { kind: 'cron', cron: '0 9 * * *', timezone: 'UTC' },
    execution: { prompt: 'Summarize', providerID: 'nna', modelID: 'workspace-default' },
    ...patch,
  };
}

afterAll(() => { rmSync(isolatedDataDir, { recursive: true, force: true }); });

describe('computeNextRunAt (C.2/C.3)', () => {
  it('takes the next daily time today or tomorrow, sorted and deduped', () => {
    const schedule = { kind: 'daily' as const, times: ['09:30', '08:00'], timezone: 'UTC' };
    expect(nextRun.computeNextRunAt(schedule, true, t0)).toBe(Date.UTC(2026, 8, 21, 9, 30));
    expect(nextRun.computeNextRunAt(schedule, true, Date.UTC(2026, 8, 21, 10, 0)))
      .toBe(Date.UTC(2026, 8, 22, 8, 0));
  });

  it('skips unusable time entries (storage-level validation is the strict gate)', () => {
    const lenient = { kind: 'daily' as const, times: ['07:00', '9am'], timezone: 'UTC' };
    expect(nextRun.computeNextRunAt(lenient, true, t0)).toBe(Date.UTC(2026, 8, 22, 7, 0));
    expect(nextRun.computeNextRunAt({ kind: 'daily' as const, times: [], timezone: 'UTC' },
      true, t0)).toBeNull();
  });

  it('scans weekly candidates across the 15-day window', () => {
    const sunday = { kind: 'weekly' as const, times: ['10:00'], weekdays: [0], timezone: 'UTC' };
    expect(nextRun.computeNextRunAt(sunday, true, t0)).toBe(Date.UTC(2026, 8, 27, 10, 0));
    const monday = { kind: 'weekly' as const, times: ['10:00'], weekdays: [1], timezone: 'UTC' };
    expect(nextRun.computeNextRunAt(monday, true, Date.UTC(2026, 8, 21, 10, 0, 0, 1)))
      .toBe(Date.UTC(2026, 8, 28, 10, 0));
  });

  it('computes a once slot in its zone and treats the past as consumed', () => {
    const schedule = { kind: 'once' as const, date: '2026-09-21', time: '10:00', timezone: 'UTC' };
    expect(nextRun.computeNextRunAt(schedule, true, t0)).toBe(Date.UTC(2026, 8, 21, 10, 0));
    const consumed = { kind: 'once' as const, date: '2026-09-20', time: '10:00', timezone: 'UTC' };
    expect(nextRun.computeNextRunAt(consumed, true, t0)).toBeNull();
    expect(nextRun.computeNextRunAt({ ...schedule, date: '2026-02-30' } as never, true, t0)).toBeNull();
  });

  it('rides cron-parser with the tz option and rejects broken expressions', () => {
    expect(nextRun.cronNextAt('*/5 * * * *', 'UTC', t0)).toBe(Date.UTC(2026, 8, 21, 9, 5));
    expect(nextRun.cronNextAt('0 9 * * 1', 'Europe/Berlin', 0)).toBe(374_400_000);
    expect(nextRun.cronNextAt('banana', 'UTC', t0)).toBeNull();
    expect(nextRun.cronNextAt('0 0 31 2 *', 'UTC', t0)).toBeNull();
  });

  it('skips a spring-forward wall time and resolves the next candidate', () => {
    const schedule = { kind: 'daily' as const, times: ['02:30', '05:00'], timezone: 'America/New_York' };
    const next = nextRun.computeNextRunAt(schedule, true, Date.UTC(2026, 2, 8, 5, 0));
    expect(next).toBe(Date.UTC(2026, 2, 8, 9, 0));
  });

  it('resolves a fall-back repeat to its first instant', () => {
    const schedule = { kind: 'daily' as const, times: ['01:30'], timezone: 'America/New_York' };
    expect(nextRun.computeNextRunAt(schedule, true, Date.UTC(2026, 10, 1, 0, 0)))
      .toBe(Date.UTC(2026, 10, 1, 5, 30));
    expect(nextRun.computeNextRunAt(schedule, true, Date.UTC(2026, 10, 1, 6, 40)))
      .toBe(Date.UTC(2026, 10, 2, 6, 30));
  });

  it('is null for disabled tasks, invalid zones, and unknown kinds', () => {
    const schedule = { kind: 'cron' as const, cron: '0 9 * * *', timezone: 'UTC' };
    expect(nextRun.computeNextRunAt(schedule, false, t0)).toBeNull();
    expect(nextRun.computeNextRunAt({ ...schedule, timezone: 'Mars/Olympus' } as never, true, t0)).toBeNull();
    expect(nextRun.computeNextRunAt({ ...schedule, kind: 'rainbow' } as never, true, t0)).toBeNull();
  });
});

describe('normalizeTaskForStorage (C.1)', () => {
  it('normalizes a valid task and preserves unknown fields at every level', () => {
    const outcome = schemaMod.normalizeTaskForStorage({
      ...taskDoc({ customMarker: { keep: true } }),
      schedule: { kind: 'cron', cron: '0 9 * * *', timezone: 'UTC', vendorExtra: 7 },
      execution: { prompt: 'Summarize', providerID: 'nna', modelID: 'm', futureField: 'yes' },
      state: { createdAt: 5, updatedAt: 6, lastStatus: 'running', versionTag: 'v9' },
    }, OPTS);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.task.name).toBe('Nightly digest');
    expect((outcome.task as Record<string, unknown>).customMarker).toEqual({ keep: true });
    expect(outcome.task.schedule.timezone).toBe('UTC');
    expect((outcome.task.schedule as unknown as Record<string, unknown>).vendorExtra).toBe(7);
    expect((outcome.task.execution as unknown as Record<string, unknown>).futureField).toBe('yes');
    expect((outcome.task.state as unknown as Record<string, unknown>).versionTag).toBe('v9');
    expect(outcome.task.state.createdAt).toBe(5);
    expect(outcome.task.state.lastStatus).toBe('running');
  });

  it('accepts the legacy single daily time and dedupes + sorts times', () => {
    const legacy = schemaMod.normalizeTaskForStorage(taskDoc({
      schedule: { kind: 'daily', time: '09:00', timezone: 'UTC' },
    }), OPTS);
    expect(legacy.ok && legacy.task.schedule).toMatchObject({ times: ['09:00'], time: '09:00' });
    const sorted = schemaMod.normalizeTaskForStorage(taskDoc({
      schedule: { kind: 'daily', times: ['09:00', '07:00', '09:00'], timezone: 'UTC' },
    }), OPTS);
    expect(sorted.ok && sorted.task.schedule).toMatchObject({ times: ['07:00', '09:00'] });
  });

  it('rejects bad names, ids, flags, and execution payloads', () => {
    const broken: unknown[] = [
      taskDoc({ name: 'x'.repeat(81) }), taskDoc({ name: '   ' }), taskDoc({ name: 7 }),
      taskDoc({ enabled: undefined }), taskDoc({ id: '' }), taskDoc({ id: 'bad id!' }),
      taskDoc({ execution: { prompt: 'x' } }),
      taskDoc({ execution: { prompt: 'x', providerID: 'p' } }),
      taskDoc({ execution: { prompt: 'y'.repeat(20_001), providerID: 'p', modelID: 'm' } }),
      taskDoc({ schedule: { kind: 'interval' } }),
      taskDoc({ schedule: { kind: 'daily', times: ['9am'] } }),
      taskDoc({ schedule: { kind: 'once', date: '2026-02-30', time: '09:00' } }),
      taskDoc({ schedule: { kind: 'cron', cron: 'nope' } }),
      taskDoc({ schedule: { kind: 'cron', cron: '0 0 31 2 *' } }),
      taskDoc({ schedule: { kind: 'cron', cron: '*'.repeat(201) } }),
      taskDoc({ schedule: { kind: 'weekly', times: ['09:00'], weekdays: [7] } }),
    ];
    for (const doc of broken) {
      const outcome = schemaMod.normalizeTaskForStorage(doc, OPTS);
      expect(outcome.ok, JSON.stringify(doc)).toBe(false);
    }
    const drop = schemaMod.normalizeTaskForStorage({
      ...taskDoc(), execution: undefined,
    }, OPTS);
    expect(drop.ok).toBe(false);
    expect(drop.ok ? '' : drop.reason).toContain('execution');
  });

  it('keeps the id immutable on update and normalizes in place otherwise', () => {
    const base = schemaMod.normalizeTaskForStorage(taskDoc(), OPTS);
    if (!base.ok) throw new Error('base must normalize');
    const renamed = schemaMod.normalizeTaskForStorage(taskDoc({ name: 'New name' }), OPTS, base.task);
    expect(renamed.ok && renamed.task.name).toBe('New name');
    const conflict = schemaMod.normalizeTaskForStorage({ ...taskDoc(), id: 'task-2' }, OPTS, base.task);
    expect(conflict.ok).toBe(false);
    expect(conflict.ok ? '' : conflict.reason).toContain('immutable');
  });

  it('stores goal settings only with goalEnabled and clamps state fields', () => {
    const withGoal = schemaMod.normalizeTaskForStorage(taskDoc({
      execution: { prompt: 'p', providerID: 'x', modelID: 'y', goalEnabled: true, goalTokenBudget: 50_000 },
    }), OPTS);
    expect(withGoal.ok && withGoal.task.execution.goalTokenBudget).toBe(50_000);
    const stray = schemaMod.normalizeTaskForStorage(taskDoc({
      execution: { prompt: 'p', providerID: 'x', modelID: 'y', goalTokenBudget: 50_000 },
    }), OPTS);
    expect(stray.ok && stray.task.execution.goalTokenBudget).toBeUndefined();
    const silly = schemaMod.normalizeTaskForStorage(taskDoc({
      execution: { prompt: 'p', providerID: 'x', modelID: 'y', goalEnabled: true, goalTokenBudget: -1 },
    }), OPTS);
    expect(silly.ok && silly.task.execution.goalTokenBudget).toBeUndefined();
    const state = schemaMod.normalizeTaskForStorage(taskDoc({
      state: { lastStatus: 'bogus', lastError: 'e'.repeat(2_001), lastRunAt: Number.NaN, nextRunAt: 42 },
    }), OPTS);
    if (!state.ok) throw new Error('state normalization must survive');
    expect(state.task.state.lastStatus).toBe('idle');
    expect(state.task.state.lastError).toBeUndefined();
    expect(state.task.state.lastRunAt).toBeUndefined();
    expect(state.task.state.nextRunAt).toBe(42);
    expect(state.task.state.updatedAt).toBe(t0);
  });

  it('falls back an invalid tz to the provided server zone', () => {
    const berlin = schemaMod.normalizeTaskForStorage(taskDoc({
      schedule: { kind: 'cron', cron: '0 9 * * *', timezone: 'Not/AZone' },
    }), { ...OPTS, serverZone: 'Europe/Berlin' });
    expect(berlin.ok && berlin.task.schedule.timezone).toBe('Europe/Berlin');
    const utc = schemaMod.normalizeTaskForStorage(taskDoc({
      schedule: { kind: 'cron', cron: '0 9 * * *', timezone: 'Not/AZone' },
    }), OPTS);
    expect(utc.ok && utc.task.schedule.timezone).toBe('UTC');
  });
});

describe('per-project storage (C.1/C.9)', () => {
  it('loads an empty view when the config file is missing', async () => {
    const view = await configMod.loadScheduledTasks('proj_alpha', OPTS);
    expect(view).toEqual({ tasks: [], invalid: [] });
  });

  it('round-trips an upsert with unknown keys preserved', async () => {
    const outcome = await configMod.upsertScheduledTask('proj_alpha', taskDoc({ note: 'workspace anchor' }), OPTS);
    expect(outcome.ok).toBe(true);
    const stored = JSON.parse(readFileSync(configMod.scheduledConfigPath('proj_alpha'), 'utf8')) as {
      version?: number; scheduledTasks?: Array<Record<string, unknown>>;
    };
    expect(stored.version).toBe(1);
    expect(stored.scheduledTasks?.[0]).toMatchObject({ id: 'task-1', name: 'Nightly digest' });
    const view = await configMod.loadScheduledTasks('proj_alpha', OPTS);
    expect(view.tasks).toHaveLength(1);
    expect(view.tasks[0]?.id).toBe('task-1');
    expect((view.tasks[0] as unknown as Record<string, unknown>).note).toBe('workspace anchor');
  });

  it('serializes chained upserts so both tasks land', async () => {
    await configMod.upsertScheduledTask('proj_chain', taskDoc({ id: 'c1' }), OPTS);
    await configMod.upsertScheduledTask('proj_chain', taskDoc({ id: 'c2' }), OPTS);
    const view = await configMod.loadScheduledTasks('proj_chain', OPTS);
    expect(view.tasks.map((task) => task.id)).toEqual(['c1', 'c2']);
  });

  it('state patches keep other config keys and unknown fields, and clear keys', async () => {
    writeConfig('proj_state', { notes: ['keep me'], widgets: 3, version: 9,
      scheduledTasks: [taskDoc({ encounteredAt: 'verbatim' })] });
    const ok = await configMod.updateScheduledTaskState('proj_state', 'task-1', {
      lastStatus: 'running', lastRunAt: 77, nextRunAt: undefined,
    });
    expect(ok).toBe(true);
    const raw = JSON.parse(readFileSync(configMod.scheduledConfigPath('proj_state'), 'utf8')) as {
      notes?: unknown[]; widgets?: number; version?: number;
      scheduledTasks?: Array<Record<string, unknown>>;
    };
    expect(raw.notes).toEqual(['keep me']);
    expect(raw.widgets).toBe(3);
    expect(raw.version).toBe(9);
    const task = raw.scheduledTasks?.[0];
    const state = task?.state as Record<string, unknown> | undefined;
    expect(task?.encounteredAt).toBe('verbatim');
    expect(state).toMatchObject({ lastStatus: 'running', lastRunAt: 77 });
    expect(state?.nextRunAt).toBeUndefined();
  });

  it('an explicit-undefined updatedAt lands on the now default, never clears', async () => {
    writeConfig('proj_updated', { scheduledTasks: [taskDoc()] });
    expect(await configMod.updateScheduledTaskState('proj_updated', 'task-1',
      { updatedAt: undefined, lastRunAt: 5 })).toBe(true);
    const raw = JSON.parse(readFileSync(configMod.scheduledConfigPath('proj_updated'), 'utf8')) as {
      scheduledTasks?: Array<Record<string, unknown>>;
    };
    const state = raw.scheduledTasks?.[0]?.state as Record<string, unknown> | undefined;
    expect(state?.lastRunAt).toBe(5);
    expect(typeof state?.updatedAt).toBe('number');
  });

  it('the conditional state patch honors the predicate without rewriting', async () => {
    writeConfig('proj_cond', { scheduledTasks: [taskDoc()] });
    const refused = await configMod.updateScheduledTaskStateIf(
      'proj_cond', 'task-1', (task) => task.enabled === false, { lastRunAt: 1 });
    expect(refused.updated).toBe(false);
    expect(refused.task?.name).toBe('Nightly digest');
    const claimed = await configMod.updateScheduledTaskStateIf('proj_cond', 'task-1',
      (task) => task.enabled === true,
      { lastStatus: 'running', lastScheduledFor: t0, nextRunAt: undefined, updatedAt: 99 });
    expect(claimed.updated).toBe(true);
    const claimedState = claimed.task?.state as Record<string, unknown> | undefined;
    expect(claimedState?.lastScheduledFor).toBe(t0);
    expect(claimedState?.nextRunAt).toBeUndefined();
    expect(claimedState?.updatedAt).toBe(99);
  });

  it('removes tasks and reports misses', async () => {
    writeConfig('proj_rm', { scheduledTasks: [taskDoc()] });
    expect(await configMod.removeScheduledTask('proj_rm', 'missing')).toBe(false);
    expect(await configMod.removeScheduledTask('proj_rm', 'task-1')).toBe(true);
    const view = await configMod.loadScheduledTasks('proj_rm', OPTS);
    expect(view.tasks).toHaveLength(0);
  });

  it('quarantines a malformed config on write and keeps the aside recoverable', async () => {
    const path = configMod.scheduledConfigPath('proj_broken');
    writeFileSync(path, '{ this is not json');
    const pre = await configMod.loadScheduledTasks('proj_broken', OPTS);
    expect(pre.tasks).toHaveLength(0);
    expect(pre.invalid).toEqual(['project config is malformed']);
    const outcome = await configMod.upsertScheduledTask('proj_broken', taskDoc({ id: 'task-9' }), OPTS);
    expect(outcome.ok).toBe(true);
    const leftovers = readdirSync(joinPath(isolatedDataDir, 'projects'));
    expect(leftovers.some((name) => name.startsWith('proj_broken.json.corrupt-'))).toBe(true);
    const fresh = await configMod.loadScheduledTasks('proj_broken', OPTS);
    expect(fresh.tasks.map((task) => task.id)).toEqual(['task-9']);
  });
});

describe('config lock (C.5)', () => {
  it('steals a stale lock and leaves no lock behind on release', async () => {
    const path = configMod.scheduledConfigPath('proj_lock');
    const lockPath = lockMod.lockPathFor(path);
    writeFileSync(lockPath, JSON.stringify({ pid: 999_999, at: Date.now() - 61_000 }));
    const lock = await lockMod.acquireConfigLock(path);
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({ pid: process.pid });
    lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('release never unlinks a lock replaced by another process mid-hold', async () => {
    const path = configMod.scheduledConfigPath('proj_foreign');
    const lockPath = lockMod.lockPathFor(path);
    const lock = await lockMod.acquireConfigLock(path);
    // Another writer replaced ours with its own while we still held the token.
    writeFileSync(lockPath, JSON.stringify({ pid: 1_000_001, at: Date.now() }));
    lock.release();
    expect(existsSync(lockPath)).toBe(true);
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({ pid: 1_000_001 });
  });

  it('runs under-lock work after an in-lock re-entrant steal attempt loses', async () => {
    const path = configMod.scheduledConfigPath('proj_seq');
    let inside = 0;
    const first = lockMod.withConfigLock(path, async () => {
      inside += 1;
      await new Promise((resolve) => { setTimeout(resolve, 5); });
      inside -= 1;
      return inside;
    });
    const second = lockMod.withConfigLock(path, async () => inside);
    expect(await first).toBe(0);
    expect(await second).toBe(0);
  });

  it('release closes the held descriptor, so the fd count stays flat', async () => {
    const path = configMod.scheduledConfigPath('proj_fds');
    const openFds = (): number => {
      let open = 0;
      for (let fd = 0; fd < 2048; fd += 1) {
        try { fstatSync(fd); open += 1; } catch { /* closed */ }
      }
      return open;
    };
    const baseline = openFds();
    for (let round = 0; round < 100; round += 1) {
      (await lockMod.acquireConfigLock(path)).release();
    }
    expect(openFds() - baseline).toBeLessThanOrEqual(3);
  });
});
