// SPDX-License-Identifier: Apache-2.0
/**
 * The editor preview route (POST /api/openchamber/scheduled-tasks/preview,
 * doc 12 §C.2 "next-4-runs preview" rendered through E-09-26): the draft
 * pipeline rides the SAME `computeNextRunAt` the armer uses; invalid drafts
 * return the collected prefix, and only shape errors are 400s.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScheduledTaskRoutes } from '../routes/scheduled-tasks.ts';
import type { ScheduledTasksRuntime } from '../scheduled/scheduled-service.ts';
import type { Schedule } from '../scheduled/task-schema.ts';

const HONO = (): ReturnType<typeof createScheduledTaskRoutes> =>
  createScheduledTaskRoutes((): ScheduledTasksRuntime | null => null);

async function preview(app: ReturnType<typeof createScheduledTaskRoutes>, body: unknown): Promise<Response> {
  return await app.request('/api/openchamber/scheduled-tasks/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const DAILY: Schedule = { kind: 'daily', times: ['09:00'], timezone: 'UTC' };
// 2026-01-26 is a Monday; 08:00Z preview start leaves 09:00Z as the first slot.
const FROM = Date.UTC(2026, 0, 26, 8, 0, 0);

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/openchamber/scheduled-tasks/preview (E-09-26)', () => {
  it('computes the next daily slots with the armer itself', async () => {
    const response = await preview(HONO(), { schedule: DAILY, count: 4, from: FROM });
    expect(response.status).toBe(200);
    const body = await response.json() as { slots: number[] };
    // slack-aware: the armer refuses anything within the due-slack window, so
    // the morning slot after 08:00Z is 09:00Z the SAME day unless the slack
    // ate it; assert the invariants instead of guessing epoch bytes.
    expect(body.slots.length).toBeGreaterThan(0);
    expect(body.slots.every((slot) => slot > FROM)).toBe(true);
    const day = 24 * 60 * 60 * 1000;
    expect(body.slots[1]! - body.slots[0]!).toBe(day);
    expect(body.slots[2]! - body.slots[1]!).toBe(day);
  });

  it('pins true epoch bytes: 08:00Z start, daily 09:00 UTC = same-day 09:00', async () => {
    const response = await preview(HONO(), { schedule: DAILY, count: 4, from: FROM });
    const body = await response.json() as { slots: number[] };
    // 09:00Z is strictly beyond 08:00Z + the 5 s due-slack, so the first
    // slot is THAT morning; the remaining daily candidates follow at +1d.
    const first = Date.UTC(2026, 0, 26, 9, 0);
    expect(body.slots).toEqual([first, first + 86_400_000, first + 172_800_000, first + 259_200_000]);
  });

  it('weekly supplies only the selected weekdays', async () => {
    const schedule: Schedule = { kind: 'weekly', times: ['09:00'], weekdays: [1, 3], timezone: 'UTC' };
    const response = await preview(HONO(), { schedule, count: 3, from: FROM });
    const body = await response.json() as { slots: number[] };
    const days = body.slots.map((slot) => new Date(slot).getUTCDay());
    expect(days).toEqual([1, 3, 1]);
  });

  it('once in the past is consumed and yields an empty prefix', async () => {
    const schedule: Schedule = { kind: 'once', date: '2020-01-01', time: '09:00', timezone: 'UTC' };
    const response = await preview(HONO(), { schedule, from: FROM });
    expect(await response.json()).toEqual({ slots: [] });
  });

  it('an invalid zone or cron is an empty prefix, never a 500', async () => {
    const badZone: Schedule = { kind: 'daily', times: ['09:00'], timezone: 'Mars/Olympus' };
    expect(((await preview(HONO(), { schedule: badZone, from: FROM })).status)).toBe(200);
    expect((await (await preview(HONO(), { schedule: badZone, from: FROM })).json())).toEqual({ slots: [] });
    const badCron: Schedule = { kind: 'cron', cron: '* * 99 * *', timezone: 'UTC' };
    const response = await preview(HONO(), { schedule: badCron, from: FROM });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ slots: [] });
  });

  it('count clamps to 1..4 with a default of 4', async () => {
    const hourly: Schedule = { kind: 'cron', cron: '0 * * * *', timezone: 'UTC' };
    const two = await (await preview(HONO(), { schedule: hourly, count: 2, from: FROM })).json() as { slots: number[] };
    expect(two.slots.length).toBe(2);
    const over = await (await preview(HONO(), { schedule: hourly, count: 9, from: FROM })).json() as { slots: number[] };
    expect(over.slots.length).toBe(4);
    const hours = over.slots.map((slot) => new Date(slot).getUTCHours());
    expect([...new Set(hours)].sort((a, b) => a - b).length).toBe(Math.min(4, hours.length));
  });

  it('shape errors are 400s with registered text', async () => {
    expect(((await preview(HONO(), { schedule: 'daily' })).status)).toBe(400);
    expect(((await preview(HONO(), null)).status)).toBe(400);
    expect(((await preview(HONO(), { schedule: [...DAILY.times] })).status)).toBe(400);
    const missing = await preview(HONO(), { from: FROM });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error?: string }).error).toBe('schedule object is required');
  });

  it('a from outside the [1970, 9999] epoch window folds, never a 500', async () => {
    // Instants near the ±10^8-day Date range overflow into invalid
    // intermediate dates inside the candidate walk (RangeError -> 500);
    // the window keeps the same arithmetic the armer ever sees.
    const MAX_EPOCH = 8_640_000_000_000_000;
    for (const bad of [MAX_EPOCH, MAX_EPOCH - 1, -5, 1e300, 253_402_300_800_000]) {
      const response = await preview(HONO(), { schedule: DAILY, from: bad });
      expect(response.status).toBe(200); // every fold is a 200 empty-or-now preview
      const body = await response.json() as { slots: number[] };
      expect(Array.isArray(body.slots)).toBe(true);
    }
    const stale = await (await preview(HONO(), { schedule: DAILY, from: 1e300 })).json() as { slots: number[] };
    // Folds to NOW (like every unusable from): the slots are now-anchored,
    // so only structure is pinnable; bytes are pinned at the window edges.
    expect(stale.slots.length).toBeLessThanOrEqual(4);
    expect(stale.slots.every((slot) => Number.isFinite(slot))).toBe(true);
  });

  it('hostile field shapes are empty prefixes, never 500s', async () => {
    // JSON can deliver non-array `times` / non-iterable `weekdays`; compute
    // guards the shapes the stored-task normalize would have rejected.
    const timesObject = { kind: 'daily', times: { 0: '09:00', length: 1 }, timezone: 'UTC' };
    expect((await preview(HONO(), { schedule: timesObject, from: FROM })).status).toBe(200);
    expect(await (await preview(HONO(), { schedule: timesObject, from: FROM })).json()).toEqual({ slots: [] });
    const weekdaysObject = { kind: 'weekly', times: ['09:00'], weekdays: {}, timezone: 'UTC' };
    expect(await (await preview(HONO(), { schedule: weekdaysObject, from: FROM })).json()).toEqual({ slots: [] });
    const junkEntries = { kind: 'daily', times: ['nonsense', null, 90], timezone: 'UTC' };
    expect(await (await preview(HONO(), { schedule: junkEntries, from: FROM })).json()).toEqual({ slots: [] });
    const weekdaysString = { kind: 'weekly', times: ['09:00'], weekdays: 'mon', timezone: 'UTC' };
    expect(await (await preview(HONO(), { schedule: weekdaysString, from: FROM })).json()).toEqual({ slots: [] });
    const nonStringCron = { kind: 'cron', cron: 7, timezone: 'UTC' };
    expect(await (await preview(HONO(), { schedule: nonStringCron, from: FROM })).json()).toEqual({ slots: [] });
    const junkZone = { kind: 'daily', times: ['09:00'], timezone: {} };
    expect(await (await preview(HONO(), { schedule: junkZone, from: FROM })).json()).toEqual({ slots: [] });
  });

  it('the boundary slot at year 10000 computes true bytes', async () => {
    // The last supported `from` (9999-12-31T23:59:59.999Z) still walks into
    // year-10000 candidates: Date arithmetic stays valid inside the window.
    const response = await preview(HONO(), {
      schedule: DAILY, count: 2, from: 253_402_300_799_999,
    });
    const body = await response.json() as { slots: number[] };
    expect(body.slots).toEqual([Date.UTC(10000, 0, 1, 9, 0), Date.UTC(10000, 0, 2, 9, 0)]);
  });
});
