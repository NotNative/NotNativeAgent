// SPDX-License-Identifier: Apache-2.0
/** Small shared time formatting helpers (doc 05 §C.8 relative labels). */

export function formatRelative(epochMs: number | undefined, now = Date.now()): string {
  if (!epochMs || epochMs <= 0) return '';
  const seconds = Math.max(0, Math.round((now - epochMs) / 1000));
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

export function formatDuration(startMs: number | undefined, endMs: number | undefined): string {
  if (!startMs || !endMs || endMs < startMs) return '';
  const seconds = Math.max(0.1, (endMs - startMs) / 1000);
  if (seconds < 60) return `${(Math.round(seconds * 10) / 10).toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

export function formatRetryCountdown(nextAt: number | string, now = Date.now()): string {
  const target = typeof nextAt === 'string' ? Number(nextAt) : nextAt;
  if (!Number.isFinite(target) || target <= 0) return '';
  const seconds = target > 1e10 ? Math.max(0, Math.round((target - now) / 1000)) : Math.max(0, Math.round(target));
  return seconds > 0 ? `Retrying in ${seconds}s` : 'Retrying…';
}
