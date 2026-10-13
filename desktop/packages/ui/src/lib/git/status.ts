// SPDX-License-Identifier: Apache-2.0
import type { GitStatusFile } from './types.ts';

/** Restore porcelain v1 `??` after the route removes its question marks. */
export function normalizeStatusFiles(files: GitStatusFile[]): GitStatusFile[] {
  return files.map((entry) => entry.index === ' ' && entry.working_dir === ' ' && entry.staged !== true
    ? { ...entry, index: '?', working_dir: '?' }
    : entry);
}

/** §6.3/§11.1: staged = index; untracked is working-only. */
export function isStagedStatusFile(entry: GitStatusFile): boolean {
  return entry.index !== '' && entry.index !== ' ' && entry.index !== '?';
}

export function isWorkingStatusFile(entry: GitStatusFile): boolean {
  return (entry.working_dir !== '' && entry.working_dir !== ' ') || entry.index === '?';
}

export function statusSymbol(entry: GitStatusFile): 'M' | 'A' | 'D' | 'R' | 'C' | 'U' {
  const code = entry.index !== ' ' && entry.index !== '' && entry.index !== '?' ? entry.index : entry.working_dir;
  if (code === 'A' || code === '?') return 'A';
  if (code === 'D') return 'D';
  if (code === 'R') return 'R';
  if (code === 'C') return 'C';
  if (code === 'U' || code === 'AA' || code === 'DD') return 'U';
  return 'M';
}
