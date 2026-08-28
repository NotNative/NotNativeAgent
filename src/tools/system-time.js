// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';
import { normalizeArgumentAliases } from './argument-normalization.js';

const OFFSET_FIELDS = Object.freeze(['weeks', 'days', 'hours', 'minutes', 'seconds']);
const OFFSET_ALIASES = Object.freeze({
  weeks: ['week'], days: ['day'], hours: ['hour'], minutes: ['minute'], seconds: ['second'],
});
const OFFSET_LIMITS = Object.freeze({
  weeks: 5_200, days: 36_525, hours: 1_000_000, minutes: 1_000_000, seconds: 1_000_000,
});

export function systemTimeDefinition(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  return {
    name: 'system.time', version: 1,
    purpose: 'Observe the current host date, time, timezone, and UTC offset, with optional bounded relative-time arithmetic.',
    sideEffect: 'read_only', scope: 'runtime_info', cancellation: true, timeoutMs: 1_000,
    inputSchema: {
      type: 'object', additionalProperties: false, properties: Object.fromEntries(OFFSET_FIELDS.map((field) => [field, {
        type: 'integer', minimum: -OFFSET_LIMITS[field], maximum: OFFSET_LIMITS[field],
        description: `${field[0].toUpperCase()}${field.slice(1)} to add or subtract; accepts a signed integer and defaults to zero.`,
      }])),
    },
    normalizeArgs: (args) => normalizeArgumentAliases(args, OFFSET_ALIASES),
    validate: async (args) => validateOffsets(args),
    executor: async (request, signal) => {
      if (signal?.aborted) throw new ContractError('tool_cancelled', 'tool was cancelled');
      const observed = validDate(now());
      const result = applyOffsets(observed, request.args);
      const observedProjection = timeProjection(observed);
      const resultProjection = timeProjection(result);
      const offset = Object.fromEntries(OFFSET_FIELDS.filter((field) => Object.hasOwn(request.args, field))
        .map((field) => [field, request.args[field]]));
      const calendarDays = (request.args.weeks ?? 0) * 7 + (request.args.days ?? 0);
      const start = observed.getTime() <= result.getTime() ? observedProjection : resultProjection;
      const end = observed.getTime() <= result.getTime() ? resultProjection : observedProjection;
      const payload = Object.keys(offset).length === 0
        ? { ...observedProjection, yesterday_date: shiftedLocalDate(observed, -1), tomorrow_date: shiftedLocalDate(observed, 1), source: 'host_clock' }
        : {
          observed: observedProjection, offset, normalized_calendar_days: calendarDays,
          result: resultProjection,
          range: { start_date: start.local_date, end_date: end.local_date, inclusive: true },
          source: 'host_clock',
        };
      return { content: JSON.stringify(payload), metadata: { source: 'host_clock', adjusted: Object.keys(offset).length > 0 } };
    },
  };
}

function validateOffsets(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw invalid('system.time arguments must be an object');
  const unknown = Object.keys(args).find((field) => !OFFSET_FIELDS.includes(field));
  if (unknown) throw invalid(`unknown argument "${unknown}"`);
  for (const [field, value] of Object.entries(args)) {
    if (!Number.isSafeInteger(value) || Math.abs(value) > OFFSET_LIMITS[field]) {
      throw invalid(`${field} must be a signed integer from ${-OFFSET_LIMITS[field]} through ${OFFSET_LIMITS[field]}`);
    }
  }
  return { args: { ...args }, resolved: { source: 'host_clock' } };
}

function applyOffsets(observed, offsets) {
  const result = new Date(observed.getTime());
  const calendarDays = (offsets.weeks ?? 0) * 7 + (offsets.days ?? 0);
  if (calendarDays !== 0) result.setDate(result.getDate() + calendarDays);
  const elapsedSeconds = (offsets.hours ?? 0) * 3_600 + (offsets.minutes ?? 0) * 60 + (offsets.seconds ?? 0);
  if (elapsedSeconds !== 0) result.setTime(result.getTime() + elapsedSeconds * 1_000);
  return validDate(result);
}

function timeProjection(value) {
  return {
    utc: value.toISOString(), local: localIso(value), local_date: localDate(value),
    day_of_week: new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(value),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'system-local',
    utc_offset: utcOffset(value), unix_ms: value.getTime(),
  };
}

function shiftedLocalDate(value, days) {
  const shifted = new Date(value.getTime()); shifted.setDate(shifted.getDate() + days); return localDate(shifted);
}

function localDate(value) {
  return [value.getFullYear(), value.getMonth() + 1, value.getDate()].map((part, index) => String(part).padStart(index === 0 ? 4 : 2, '0')).join('-');
}

function localIso(value) {
  const time = [value.getHours(), value.getMinutes(), value.getSeconds()].map((part) => String(part).padStart(2, '0')).join(':');
  return `${localDate(value)}T${time}.${String(value.getMilliseconds()).padStart(3, '0')}${utcOffset(value)}`;
}

function utcOffset(value) {
  const minutes = -value.getTimezoneOffset(); const sign = minutes >= 0 ? '+' : '-'; const absolute = Math.abs(minutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
}

function validDate(value) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new ContractError('host_clock_invalid', 'host clock returned an invalid date');
  return value;
}

function invalid(message) { return new ContractError('tool_schema_invalid', message); }
