// SPDX-License-Identifier: Apache-2.0
/**
 * Next-run computation (doc 12 §C.2/§C.3). Zone handling rides Intl (Node's
 * ICU) instead of luxon, which is outside the dependency tree: an invalid
 * IANA zone makes every formatter call throw, the same fail-closed answer
 * (`null`) the contract needs. A candidate must be strictly later than
 * `now + TASK_DUE_SLACK_MS`; daily/weekly candidates are built in the
 * schedule's wall clock, so a slot that does not exist on a spring-forward
 * transition is skipped and a fall-back repeat resolves to its first
 * instant. CRON occurrences ride cron-parser's own tz-aware iteration.
 */
import { CronExpressionParser } from 'cron-parser';
import { TASK_CANDIDATE_DAYS, TASK_CRON_MAX, TASK_DUE_SLACK_MS } from './scheduled-constants.ts';
import type { Schedule } from './task-schema.ts';

export interface WallClock { y: number; mo: number; d: number; h: number; mi: number; weekday: number }

const HH_MM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/u;
const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/u;
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function serverZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function isValidZone(zone: string): boolean {
  try { new Intl.DateTimeFormat('en-GB', { timeZone: zone }); return true; } catch { return false; }
}

/** Same library call the future UI preview uses (§C.2); invalid → null. */
export function cronNextAt(expression: string, zone: string, now: number): number | null {
  if (expression.length === 0 || expression.length > TASK_CRON_MAX || !isValidZone(zone)) return null;
  try {
    const iterable = CronExpressionParser.parse(expression, {
      currentDate: new Date(now), tz: zone,
    });
    let next = iterable.next().getTime();
    for (let guard = 0; next <= now + TASK_DUE_SLACK_MS && guard < 8; guard += 1) {
      next = iterable.next().getTime();
    }
    return next > now + TASK_DUE_SLACK_MS ? next : null;
  } catch {
    return null;
  }
}

function parts(epochMs: number, zone: string): WallClock {
  const table = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short',
  }).formatToParts(new Date(epochMs)).map((part) => [part.type, part.value]));
  const weekday = WEEKDAYS.indexOf(String(table.weekday).slice(0, 3).toLowerCase());
  return {
    y: Number(table.year), mo: Number(table.month), d: Number(table.day),
    h: Number(table.hour), mi: Number(table.minute), weekday,
  };
}

/** Offset between the zone's wall clock and UTC at an instant (ms ahead). */
function offsetMs(epochMs: number, zone: string): number {
  const wall = parts(epochMs, zone);
  return Date.UTC(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi) - epochMs;
}

/** The instant whose wall clock is the target: fixed-point offset fix, then
 * a round-trip check. A wall time missing from the zone (spring gap) gives
 * null; a fall-back repeat steps back one minute at a time to the FIRST
 * instant (folds are far under two hours). */
function epochOfWall(target: { y: number; mo: number; d: number; h: number; mi: number }, zone: string): number | null {
  const base = Date.UTC(target.y, target.mo - 1, target.d, target.h, target.mi);
  let best = base;
  for (let pass = 0; pass < 2; pass += 1) best = base - offsetMs(best, zone);
  const matches = (epoch: number): boolean => {
    const wall = parts(epoch, zone);
    return wall.y === target.y && wall.mo === target.mo && wall.d === target.d
      && wall.h === target.h && wall.mi === target.mi;
  };
  if (!matches(best)) return null;
  let first = best;
  for (let step = 0; step < 120 && matches(first - 60_000); step += 1) first -= 60_000;
  return first;
}

function minuteSet(times: string[]): string[] {
  return [...new Set(times.filter((time) => HH_MM.test(time)))].sort();
}

function hhmm(time: string): { h: number; mi: number } {
  const [h, mi] = time.split(':').map((part) => Number(part));
  return { h: h ?? 0, mi: mi ?? 0 };
}

/** Walks today plus 14 calendar days from a noon anchor (UTC noon never
 * crosses a local DST boundary), applying the weekday filter (null = daily)
 * and taking the first in-zone wall time strictly beyond the slack. */
function nextCandidate(
  times: string[], weekdays: number[] | null, zone: string, now: number,
): number | null {
  const start = parts(now, zone);
  let stamp = new Date(Date.UTC(start.y, start.mo - 1, start.d, 12));
  for (let day = 0; day <= TASK_CANDIDATE_DAYS; day += 1) {
    if (weekdays === null || weekdays.includes(stamp.getUTCDay())) {
      for (const time of times) {
        const { h, mi } = hhmm(time);
        const instant = epochOfWall({
          y: stamp.getUTCFullYear(), mo: stamp.getUTCMonth() + 1, d: stamp.getUTCDate(), h, mi,
        }, zone);
        if (instant !== null && instant > now + TASK_DUE_SLACK_MS) return instant;
      }
    }
    stamp = new Date(stamp.getTime() + 86_400_000);
  }
  return null;
}

/** Next `YYYY-MM-DD HH:mm` (or null when consumed/past/malformed). */
export function parseOnceSlot(date: string, time: string): { y: number; mo: number; d: number; h: number; mi: number } | null {
  if (!ISO_DATE.test(date) || !HH_MM.test(time)) return null;
  const [y, mo, d] = date.split('-').map((part) => Number(part));
  const [h, mi] = time.split(':').map((part) => Number(part));
  return { y: y ?? 0, mo: mo ?? 0, d: d ?? 0, h: h ?? 0, mi: mi ?? 0 };
}

/**
 * Epoch ms of the next occurrence, or null (disabled task, invalid zone,
 * invalid cron, empty times, or a consumed `once`). §C.3. Field shapes are
 * guarded, not trusted (times/weekdays must be arrays): stored tasks, the
 * editor's JSON draft (preview) and hostile bodies ride the same path.
 */
export function computeNextRunAt(schedule: Schedule | undefined, enabled: boolean, now: number): number | null {
  if (!schedule || !enabled || !isValidZone(schedule.timezone)) return null;
  const zone = schedule.timezone;
  try { parts(now, zone); } catch { return null; }
  switch (schedule.kind) {
    case 'daily': {
      const times = minuteSet(Array.isArray(schedule.times) ? schedule.times : []);
      if (times.length === 0) return null;
      return nextCandidate(times, null, zone, now);
    }
    case 'weekly': {
      const times = minuteSet(Array.isArray(schedule.times) ? schedule.times : []);
      const weekdays = [...new Set(Array.isArray(schedule.weekdays) ? schedule.weekdays : [])]
        .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6).sort();
      if (times.length === 0 || weekdays.length === 0) return null;
      return nextCandidate(times, weekdays, zone, now);
    }
    case 'once': {
      const slot = parseOnceSlot(schedule.date, schedule.time);
      if (!slot) return null;
      const instant = epochOfWall(slot, zone);
      return instant !== null && instant > now + TASK_DUE_SLACK_MS ? instant : null;
    }
    case 'cron': return cronNextAt(schedule.cron, zone, now);
    default: return null;
  }
}
