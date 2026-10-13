// SPDX-License-Identifier: Apache-2.0
/** Small shared helpers used across the scheduled-task modules. */

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function finiteOr(value: number | null | undefined, fallback: number): number {
  return value !== null && value !== undefined && Number.isFinite(value) ? value : fallback;
}

export function optionalFinite(value: number | null | undefined): number | undefined {
  return value !== null && value !== undefined && Number.isFinite(value) ? value : undefined;
}
