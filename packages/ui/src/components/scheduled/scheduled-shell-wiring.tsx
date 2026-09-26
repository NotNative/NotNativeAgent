// SPDX-License-Identifier: Apache-2.0
/**
 * Shell wiring for the scheduled surface: the `nnd:scheduled-tasks-open`
 * window event drives the dialog (keyboard/command entries) and the dialog's
 * loop-file "edit" hands the file to the built-in editor via
 * `nnd:files-open` (FilesView pane opens with the file selected).
 */
import { useEffect, type ReactNode } from 'react';
import { SCHEDULED_OPEN_EVENT, FILES_OPEN_EVENT } from './scheduled-tasks-dialog.tsx';

export function useScheduledShellWiring(
  openScheduled: () => void,
  openFiles: (directory: string, path: string) => void,
): ReactNode {
  useEffect(() => {
    const onOpen = (): void => openScheduled();
    const onFiles = (event: Event): void => {
      const detail = (event as CustomEvent<{ directory?: string; path?: string }>).detail;
      if (typeof detail?.directory === 'string' && typeof detail.path === 'string') {
        openFiles(detail.directory, detail.path);
      }
    };
    window.addEventListener(SCHEDULED_OPEN_EVENT, onOpen);
    window.addEventListener(FILES_OPEN_EVENT, onFiles);
    return () => {
      window.removeEventListener(SCHEDULED_OPEN_EVENT, onOpen);
      window.removeEventListener(FILES_OPEN_EVENT, onFiles);
    };
  }, [openScheduled, openFiles]);
  return null;
}
