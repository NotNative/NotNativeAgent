// SPDX-License-Identifier: Apache-2.0
import { takeNativeResumeSelection, finishNativeContinuity, recordNativeContinuityOutcome } from '../lib/native-continuity.ts';
export { finishNativeContinuity } from '../lib/native-continuity.ts';
import { getRuntimeKey } from '../lib/runtime-switch.ts';
import { harnessClient, normalizeDirectory } from '../lib/nnd/client.ts';
import { sessionNavigationRevision } from '../lib/session-route.ts';
import { useSessionViewStore } from './view-store.ts';

export async function nativeContinuityDirectory(fallback: string, navigationRevision: number): Promise<string> {
  const runtime = getRuntimeKey(), resume = takeNativeResumeSelection(runtime);
  const observed = resume ? await harnessClient.getSession(resume.sessionId, { directory: '' }).catch(() => ({ error: 'transport', data: undefined })) : null;
  const view = useSessionViewStore.getState(), session = observed?.data;
  const restored = resume && !observed?.error && session?.id === resume.sessionId && runtime === getRuntimeKey()
    && !view.currentSessionId && !view.currentDraftId && navigationRevision === sessionNavigationRevision()
    && !session.time.archived && normalizeDirectory(session.directory ?? '') === normalizeDirectory(resume.directory) ? session : null;
  // Invariant: a handed-off pointer chooses a bootstrap directory only after its native session owner confirms it.
  const directory = normalizeDirectory(restored?.directory || view.activeDirectory || fallback);
  if (resume) recordNativeContinuityOutcome(restored ? 'confirmed' : observed?.error ? 'native-read-failed'
    : session?.id !== resume.sessionId ? 'missing-session' : session.time.archived ? 'archived'
      : normalizeDirectory(session.directory ?? '') !== normalizeDirectory(resume.directory) ? 'workspace-mismatch' : 'navigation-changed');
  if (restored) view.setActiveDirectory(directory);
  else finishNativeContinuity(runtime);
  return directory;
}
