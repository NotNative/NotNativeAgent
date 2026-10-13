// SPDX-License-Identifier: Apache-2.0
/** Small path, refresh, and shortcut helpers shared by the Files editor host. */
import { workspaceRelativePath } from '../../lib/files/workspace-paths.ts';
import { publishReviewRefresh } from '../../lib/git/refresh-hints.ts';
import { effectiveShortcutCombo } from '../../lib/shortcuts/schema.ts';
import type { FileDialogMode } from './file-dialogs.tsx';

export interface DialogSpec { mode: FileDialogMode; parent: string; path?: string }

export function publishWorkspaceHint(root: string, paths: string[], reason: string): void {
  if (root.length === 0) return;
  const relative = paths
    .map((path) => workspaceRelativePath(root, path))
    .filter((entry): entry is string => entry !== null);
  publishReviewRefresh(root, relative.length > 0 ? relative : null, reason);
}

export function joinPath(parent: string, name: string): string {
  if (parent === '' || parent === '.') return name;
  const separator = parent.includes('\\') || /^[a-zA-Z]:$/u.test(parent) ? '\\' :
    parent.endsWith('/') ? '' : parent.endsWith('\\') ? '' : '/';
  return parent.endsWith('/') || parent.endsWith('\\') ? `${parent}${name}` : `${parent}${separator}${name}`;
}

export function parentDirOf(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return index > 0 ? path.slice(0, index) : path;
}

export function saveShortcutDisplay(): string {
  const combo = effectiveShortcutCombo('save_file');
  return combo.chords
    .map((chord) => `${[...chord.mods].sort().join('+')}${chord.mods.size > 0 ? '+' : ''}${chord.key === 'comma' ? ',' : chord.key.toUpperCase()}`)
    .join(' + ');
}
