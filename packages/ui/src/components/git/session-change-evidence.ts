// SPDX-License-Identifier: Apache-2.0
/** Relate authored session tool evidence to a *current* Git status snapshot. */
import type { ActivityRecord } from '../../sync/activity-log.ts';
import type { GitStatus } from '../../lib/git/api.ts';
import { groupedStatusFiles } from '../../lib/git/store';

export interface SessionChangeEvidence {
  path: string;
  staged: boolean;
  working: boolean;
}

export function repoPathFromWorkspace(prefix: unknown, path: string): string | null {
  if (typeof prefix !== 'string' || prefix.startsWith('/') || prefix !== '' && !prefix.endsWith('/')
    || /\\|[\u0000-\u001f\u007f]/u.test(prefix)
    || prefix.split('/').some((segment, index, parts) => segment === '..' || segment === '.'
      || segment === '' && index !== parts.length - 1)) return null;
  return `${prefix}${path}`;
}

export function sessionChangedFiles(records: readonly ActivityRecord[], sessionID: string, directory: string,
  status: GitStatus): SessionChangeEvidence[] {
  if (repoPathFromWorkspace(status.workspacePrefix, '') === null) return [];
  const touched = new Set(records.filter((record) => record.sessionID === sessionID && record.kind === 'tool'
    && record.status === 'completed' && record.toolEvidence?.reviewDirectory === directory
    && typeof record.toolEvidence.reviewPath === 'string')
    .map((record) => repoPathFromWorkspace(status.workspacePrefix, record.toolEvidence!.reviewPath!)!));
  const grouped = groupedStatusFiles(status);
  const current = new Map<string, SessionChangeEvidence>();
  for (const file of grouped.staged) if (touched.has(file.path)) current.set(file.path, { path: file.path, staged: true, working: false });
  for (const file of grouped.working) if (touched.has(file.path)) {
    const existing = current.get(file.path);
    current.set(file.path, { path: file.path, staged: existing?.staged ?? false, working: true });
  }
  return [...current.values()].sort((left, right) => left.path.localeCompare(right.path));
}
