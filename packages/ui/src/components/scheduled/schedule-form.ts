// SPDX-License-Identifier: Apache-2.0
/**
 * Schedule-form machinery for the task editor (doc 12 §H "Editor dialog",
 * doc 03 §C.1 schedule union): pure helpers + constants - draft seeding,
 * time-pill labels (rendered per the viewer's 12h/24h preference), weekday
 * chips ordered by the locale's first day (Intl weekInfo with a Monday
 * fallback), zone choices, cron shape heuristics + example chips, and the
 * schedule summary labels the list rows already render.
 */
import { getCurrentIntlLocale } from '../../lib/i18n/intl.ts';
import {
  formatDateTimeForPreference, canonicalizeTimezone, type TimeFormatPreference,
} from '../../lib/format/time.ts';
import type { TaskSchedule } from '../../lib/scheduled-tasks-api.ts';
import { SCHEDULED_TEXT, interpolateText, type ScheduledText } from './scheduledText.ts';

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const CRON_SHAPE = /^\S+( \S+){4,5}$/u;
export const CRON_MAX_LENGTH = 200;

/** Fixed 30-minute pill catalogue (12h/24h rendering is the label's job). */
export const PILL_CATALOG: string[] = ['00:00', '00:30', '01:00', '01:30', '02:00', '02:30', '03:00', '03:30',
  '04:00', '04:30', '05:00', '05:30', '06:00', '06:30', '07:00', '07:30',
  '08:00', '08:30', '09:00', '09:30', '10:00', '10:30', '11:00', '11:30',
  '12:00', '12:30', '13:00', '13:30', '14:00', '14:30', '15:00', '15:30',
  '16:00', '16:30', '17:00', '17:30', '18:00', '18:30', '19:00', '19:30',
  '20:00', '20:30', '21:00', '21:30', '22:00', '22:30', '23:00', '23:30'];

/** Cron example chips (§H "example chips"); labels stay English - they are
 * cron vocabulary, not UI prose. */
export const CRON_EXAMPLES: Array<{ cron: string; label: string }> = [
  { cron: '0 * * * *', label: 'hourly' },
  { cron: '*/15 * * * *', label: 'every 15 min' },
  { cron: '0 9 * * 1-5', label: 'weekdays 9am' },
  { cron: '30 14 * * 1', label: 'Mondays 14:30' },
  { cron: '0 8 1 * *', label: '1st of month 8am' },
];

/** The viewer's own zone (§J.1 postures); legacy ids canonicalize on use. */
export function systemZone(): string {
  return canonicalizeTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
}

/** Time-zone choices for the select: local, UTC, then the IANA catalogue. */
export function zoneChoices(): string[] {
  const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] })
    .supportedValuesOf?.('timeZone') ?? [];
  const extra = [systemZone(), 'UTC'].filter((zone) => zone.length > 0 && !supported.includes(zone));
  return [...extra, ...supported];
}

/** A fresh draft of the given kind, seeded in the schedule's zone. */
export function emptyDraft(kind: TaskSchedule['kind'], timezone: string): TaskSchedule {
  const zone = timezone.length > 0 ? timezone : systemZone();
  if (kind === 'weekly') return { kind: 'weekly', times: ['09:00'], weekdays: [1], timezone: zone };
  if (kind === 'once') return { kind: 'once', date: tomorrowIso(zone), time: '09:00', timezone: zone };
  if (kind === 'cron') return { kind: 'cron', cron: '0 9 * * 1-5', timezone: zone };
  return { kind: 'daily', times: ['09:00'], timezone: zone };
}

/** The schedule zone's LOCAL calendar date 24 h from now (`en-CA` renders
 * `YYYY-MM-DD`); the UTC-based date a naive seed would use is a day off for
 * zones far from UTC. An unusable zone folds to the UTC date so a garbage
 * argument can never crash the seeding (the zone is kept in the draft; the
 * preview folds it to empty - E-09-26). */
export function tomorrowIso(zone: string): string {
  const later = new Date(Date.now() + 24 * 60 * 60 * 1000);
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(later);
  } catch {
    return later.toISOString().slice(0, 10);
  }
}

/** `HH:MM` arrow functions / config-free wall clocks render per preference
 * through a synthetic UTC noon (the pill label is pure wall clock). */
export function timePillLabel(hhmm: string, preference: TimeFormatPreference): string {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(hhmm.trim());
  if (match === null) return hhmm;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return hhmm;
  const stamp = Date.UTC(2020, 0, 1, hour, minute);
  const hour12 = preference === '12h' ? true : preference === '24h' ? false : undefined;
  return new Intl.DateTimeFormat(getCurrentIntlLocale(), {
    hour: 'numeric', minute: '2-digit', hour12, timeZone: 'UTC',
  }).format(new Date(stamp));
}

/** The locale's first weekday, JS numbering 0=Sunday (weekInfo 1=Mon..7=Sun;
 * fall back to Monday when weekInfo is unavailable). */
export function localeFirstDay(locale?: string): number {
  const tag = locale ?? getCurrentIntlLocale();
  const weekInfo = (new Intl.Locale(tag) as unknown as { weekInfo?: { firstDay: number } }).weekInfo;
  if (weekInfo?.firstDay === undefined) return 1;
  return weekInfo.firstDay % 7;
}

/** Chip walk order starting at the locale's first day. */
export function weekdayOrder(firstDay: number): number[] {
  const start = ((firstDay % 7) + 7) % 7;
  return [start, (start + 1) % 7, (start + 2) % 7, (start + 3) % 7,
    (start + 4) % 7, (start + 5) % 7, (start + 6) % 7];
}

/** Chip labels indexed by JS weekday (0=Sunday) in the active locale. */
export function weekdayLabels(locale?: string): string[] {
  const tag = locale ?? getCurrentIntlLocale();
  const formatter = new Intl.DateTimeFormat(tag, { weekday: 'short', timeZone: 'UTC' });
  // 2020-01-05 was a Sunday: index i walks Sunday..Saturday in UTC.
  return [0, 1, 2, 3, 4, 5, 6].map((day) => formatter.format(new Date(Date.UTC(2020, 0, 5 + day))));
}

/** Cheap cron shape heuristics: 5-6 blank-separated fields within the cap.
 * Full validity stays with the preview round-trip (cron-parser). */
export function cronShapeOk(cron: string): boolean {
  return cron.length > 0 && cron.length <= CRON_MAX_LENGTH && CRON_SHAPE.test(cron);
}

/** Toggle list membership; never removes the last `keep` entries (the
 * schedule kinds must keep >= 1 time / >= 1 weekday to be valid). */
export function toggleMember<T>(list: T[], item: T, keep = 1): T[] {
  if (list.includes(item)) return list.length > keep ? list.filter((entry) => entry !== item) : list;
  return [...list, item].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The schedule summary the list rows render (moved here for the editor's
 * reuse: the rows and the editor header show the same text). */
export function scheduleLabel(schedule: TaskSchedule, text: ScheduledText = SCHEDULED_TEXT): string {
  const zone = interpolateText(text.scheduleZone, { zone: schedule.timezone });
  if (schedule.kind === 'daily') return interpolateText(text.dailySchedule, { times: schedule.times.join(', ') }) + zone;
  if (schedule.kind === 'once') return interpolateText(text.onceSchedule, { date: schedule.date, time: schedule.time }) + zone;
  if (schedule.kind === 'weekly') {
    const formatter = new Intl.DateTimeFormat(getCurrentIntlLocale(), { weekday: 'short', timeZone: 'UTC' });
    const days = schedule.weekdays.map((day) => (
      day >= 0 && day <= 6 ? formatter.format(new Date(Date.UTC(2020, 0, 5 + day))) : '?'
    )).join(', ');
    return interpolateText(text.weeklySchedule, { days, times: schedule.times.join(', ') }) + zone;
  }
  return interpolateText(text.cronSchedule, { cron: schedule.cron }) + zone;
}

/** One preview line: the viewer-zone date + the wall time INSIDE the
 * schedule zone (the slot that will actually arm), per preference. */
export function previewLine(
  at: number, zone: string, preference: TimeFormatPreference, text: ScheduledText = SCHEDULED_TEXT,
): string {
  const viewer = formatDateTimeForPreference(at, preference, { year: 'numeric', month: 'short', day: '2-digit' });
  const hour12 = preference === '12h' ? true : preference === '24h' ? false : undefined;
  const wall = new Intl.DateTimeFormat(getCurrentIntlLocale(), {
    hour: 'numeric', minute: '2-digit', hour12, timeZone: zone,
  }).format(new Date(at));
  return interpolateText(text.previewAtZone, { wall, zone });
}
