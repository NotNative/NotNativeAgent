// SPDX-License-Identifier: Apache-2.0
import type { QueueTiming } from './queue-runtime-timing.ts';

/** §D.3.8 formula: exponential 2^(n-1) from base, with the documented cap. */
export function failureDelayMs(failures: number, timing: Pick<QueueTiming, 'backoffBaseMs' | 'backoffMaxMs'>): number {
  const exponent = Math.max(0, Math.min(failures, 32) - 1);
  return Math.min(timing.backoffBaseMs * 2 ** exponent, timing.backoffMaxMs);
}

export function optionalPropertyString(properties: Record<string, unknown>, key: string): string | null {
  const value = properties[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function errorNameOf(value: unknown): string | null {
  const name = asRecord(value)?.name;
  return typeof name === 'string' ? name : null;
}

/** §D.3.4: an unfinished assistant reply makes the session non-idle. */
export function tailUnfinishedAssistant(entry: unknown): boolean {
  const info = asRecord((entry as { info?: unknown })?.info);
  if (!info || info.role !== 'assistant') return false;
  const completed = asRecord(info.time)?.completed;
  return typeof completed !== 'number';
}
