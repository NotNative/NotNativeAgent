// SPDX-License-Identifier: Apache-2.0
/**
 * Scheduled-controls copy and formatting. `SCHEDULED_TEXT` is the stable
 * English fallback for bare mounts; registered table keys carry the same copy
 * through active catalogs without changing data-testids or public props.
 */
import { useMemo } from 'react';
import { useOptionalI18n } from '../../lib/i18n/context.tsx';
import type { I18nKey } from '../../lib/i18n/messages/en.ts';
import { getCurrentIntlLocale } from '../../lib/i18n/intl.ts';
import { formatDateTimeForPreference } from '../../lib/format/time.ts';
import type { TaskSchedule, TaskState } from '../../lib/scheduled-tasks-api.ts';

export const SCHEDULED_TEXT = {
  title: 'Scheduled tasks',
  projectLabel: 'Project',
  newTaskTitle: 'New scheduled task',
  newButton: '+ new',
  close: 'Close scheduled tasks',
  empty: 'No scheduled tasks for this project yet',
  taskCountOne: '{count} task',
  taskCountMany: '{count} tasks',
  footerLoopFiles: 'Loop tasks are driven by their .agents/loops file; the list refreshes when a run lands.',
  next: 'next',
  last: 'last',
  toggle: 'Toggle {name}',
  on: 'on',
  off: 'off',
  statusIdle: 'idle',
  statusRunning: 'running',
  statusSuccess: 'success',
  statusError: 'error',
  loopChip: 'loop',
  goalChip: 'goal',
  runAria: 'Run {name} now',
  run: 'run',
  editAria: 'Edit {name}',
  edit: 'task',
  loopEditAria: 'Edit loop file for {name}',
  loopEdit: 'edit',
  loopDeleteAria: 'Confirm deleting the loop file of {name}',
  loopDelete: 'delete file?',
  deleteAria: 'Delete {name}',
  runFailed: '{name}: {error}',
  runCompleted: '{name} completed',
  runEnded: '{name} ended with {status}',
  persistenceDelayed: '{name}: persistence delayed ({error})',
  loopOutsideWorkspace: '{name}: the loop file {loopFile} is outside this workspace — toggle it here instead',
  ranToastTitle: '{taskId} {status}',
  ranToastDescription: '{projectId} · scheduled task',
  changeRejected: 'the change did not land',
  editorTitle: 'Task editor',
  newTask: 'New scheduled task',
  editTask: 'Edit scheduled task',
  closeEditor: 'Close task editor',
  name: 'Name',
  nameRequired: 'a name is required',
  enabled: 'enabled',
  disabled: 'disabled',
  save: 'Save',
  saving: 'saving...',
  saved: 'task scheduled',
  updated: 'task updated',
  scheduleKind: 'Schedule kind',
  kindDaily: 'daily',
  kindWeekly: 'weekly',
  kindOnce: 'once',
  kindCron: 'cron',
  timezone: 'Timezone',
  weekdays: 'Weekdays',
  cronAria: 'Cron expression',
  cronInvalid: '5-6 cron fields',
  exampleHourly: 'hourly',
  exampleEvery15: 'every 15 min',
  exampleWeekdays9: 'weekdays 9am',
  exampleMondays: 'Mondays 14:30',
  exampleMonthlyFirst: '1st of month 8am',
  dailySchedule: 'daily {times}',
  weeklySchedule: 'weekly {days} at {times}',
  onceSchedule: 'once {date} {time}',
  cronSchedule: 'cron {cron}',
  scheduleZone: ' · {zone}',
  nextRuns: 'next runs',
  computing: 'computing...',
  previewUnavailable: 'preview unavailable',
  previewAtZone: '{wall} in {zone}',
  model: 'Model',
  noModels: 'no models configured',
  agent: 'Agent',
  promptPlaceholder: 'What should the run do? (@file /command #snippet)',
  runAsGoal: 'Run as goal',
  goalBudget: 'Goal token budget',
  autoAcceptPermissions: 'Auto-accept permissions',
} as const;

export type ScheduledText = { [K in keyof typeof SCHEDULED_TEXT]: string };

export const SCHEDULED_KEY: { [K in keyof typeof SCHEDULED_TEXT]: I18nKey } = {
  title: 'scheduledUi.title',
  projectLabel: 'scheduledUi.projectLabel',
  newTaskTitle: 'scheduledUi.newTaskTitle',
  newButton: 'scheduledUi.newButton',
  close: 'scheduledUi.close',
  empty: 'scheduledUi.empty',
  taskCountOne: 'scheduledUi.taskCountOne',
  taskCountMany: 'scheduledUi.taskCountMany',
  footerLoopFiles: 'scheduledUi.footerLoopFiles',
  next: 'scheduledUi.next',
  last: 'scheduledUi.last',
  toggle: 'scheduledUi.toggle',
  on: 'scheduledUi.on',
  off: 'scheduledUi.off',
  statusIdle: 'scheduledUi.status.idle',
  statusRunning: 'scheduledUi.status.running',
  statusSuccess: 'scheduledUi.status.success',
  statusError: 'scheduledUi.status.error',
  loopChip: 'scheduledUi.loopChip',
  goalChip: 'scheduledUi.goalChip',
  runAria: 'scheduledUi.runAria',
  run: 'scheduledUi.run',
  editAria: 'scheduledUi.editAria',
  edit: 'scheduledUi.edit',
  loopEditAria: 'scheduledUi.loopEditAria',
  loopEdit: 'scheduledUi.loopEdit',
  loopDeleteAria: 'scheduledUi.loopDeleteAria',
  loopDelete: 'scheduledUi.loopDelete',
  deleteAria: 'scheduledUi.deleteAria',
  runFailed: 'scheduledUi.runFailed',
  runCompleted: 'scheduledUi.runCompleted',
  runEnded: 'scheduledUi.runEnded',
  persistenceDelayed: 'scheduledUi.persistenceDelayed',
  loopOutsideWorkspace: 'scheduledUi.loopOutsideWorkspace',
  ranToastTitle: 'scheduledUi.ranToastTitle',
  ranToastDescription: 'scheduledUi.ranToastDescription',
  changeRejected: 'scheduledUi.changeRejected',
  editorTitle: 'scheduledUi.editorTitle',
  newTask: 'scheduledUi.newTask',
  editTask: 'scheduledUi.editTask',
  closeEditor: 'scheduledUi.closeEditor',
  name: 'scheduledUi.name',
  nameRequired: 'scheduledUi.nameRequired',
  enabled: 'scheduledUi.enabled',
  disabled: 'scheduledUi.disabled',
  save: 'scheduledUi.save',
  saving: 'scheduledUi.saving',
  saved: 'scheduledUi.saved',
  updated: 'scheduledUi.updated',
  scheduleKind: 'scheduledUi.scheduleKind',
  kindDaily: 'scheduledUi.kind.daily',
  kindWeekly: 'scheduledUi.kind.weekly',
  kindOnce: 'scheduledUi.kind.once',
  kindCron: 'scheduledUi.kind.cron',
  timezone: 'scheduledUi.timezone',
  weekdays: 'scheduledUi.weekdays',
  cronAria: 'scheduledUi.cronAria',
  cronInvalid: 'scheduledUi.cronInvalid',
  exampleHourly: 'scheduledUi.example.hourly',
  exampleEvery15: 'scheduledUi.example.every15',
  exampleWeekdays9: 'scheduledUi.example.weekdays9',
  exampleMondays: 'scheduledUi.example.mondays',
  exampleMonthlyFirst: 'scheduledUi.example.monthlyFirst',
  dailySchedule: 'scheduledUi.schedule.daily',
  weeklySchedule: 'scheduledUi.schedule.weekly',
  onceSchedule: 'scheduledUi.schedule.once',
  cronSchedule: 'scheduledUi.schedule.cron',
  scheduleZone: 'scheduledUi.scheduleZone',
  nextRuns: 'scheduledUi.nextRuns',
  computing: 'scheduledUi.computing',
  previewUnavailable: 'scheduledUi.previewUnavailable',
  previewAtZone: 'scheduledUi.previewAtZone',
  model: 'scheduledUi.model',
  noModels: 'scheduledUi.noModels',
  agent: 'scheduledUi.agent',
  promptPlaceholder: 'scheduledUi.promptPlaceholder',
  runAsGoal: 'scheduledUi.runAsGoal',
  goalBudget: 'scheduledUi.goalBudget',
  autoAcceptPermissions: 'scheduledUi.autoAcceptPermissions',
};

/** Merge explicit labels over either the provider-translated table or EN. */
export function resolveScheduledText(
  labels?: Partial<ScheduledText>,
  defaults: Partial<ScheduledText> = SCHEDULED_TEXT,
): ScheduledText {
  const merged = { ...SCHEDULED_TEXT, ...defaults } as Record<keyof ScheduledText, string>;
  for (const key of Object.keys(labels ?? {}) as Array<keyof ScheduledText>) {
    const value = labels?.[key];
    if (typeof value === 'string' && value.length > 0) merged[key] = value;
  }
  return merged;
}

/** Same authority rule as Pairing: provider catalogs, then labels, then EN. */
export function useScheduledText(labels?: Partial<ScheduledText>): ScheduledText {
  const i18n = useOptionalI18n();
  return useMemo(() => {
    if (i18n === null) return resolveScheduledText(labels);
    const translated = {} as Record<keyof ScheduledText, string>;
    for (const key of Object.keys(SCHEDULED_KEY) as Array<keyof ScheduledText>) {
      translated[key] = i18n.t(SCHEDULED_KEY[key]);
    }
    return resolveScheduledText(labels, translated);
  }, [i18n, labels]);
}

export function scheduleStatusLabel(status: TaskState['lastStatus'], text: ScheduledText): string {
  if (status === 'running') return text.statusRunning;
  if (status === 'success') return text.statusSuccess;
  if (status === 'error') return text.statusError;
  return text.statusIdle;
}

export function scheduleLabel(schedule: TaskSchedule, text: ScheduledText): string {
  const zone = text.scheduleZone.replace('{zone}', schedule.timezone);
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

export function previewLine(
  at: number, zone: string, preference: 'auto' | '12h' | '24h', text: ScheduledText,
): string {
  const viewer = formatDateTimeForPreference(at, preference, { year: 'numeric', month: 'short', day: '2-digit' });
  const hour12 = preference === '12h' ? true : preference === '24h' ? false : undefined;
  let wall = '';
  try {
    wall = new Intl.DateTimeFormat(getCurrentIntlLocale(), {
      hour: 'numeric', minute: '2-digit', hour12, timeZone: zone,
    }).format(new Date(at));
  } catch {
    wall = new Intl.DateTimeFormat('UTC', {
      hour: 'numeric', minute: '2-digit', hour12, timeZone: 'UTC',
    }).format(new Date(at));
  }
  return interpolateText(text.previewAtZone, { wall, zone });
}

export function interpolateText(template: string, params: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/gu, (match, key) =>
    Object.hasOwn(params, key) ? String(params[key]) : match);
}
