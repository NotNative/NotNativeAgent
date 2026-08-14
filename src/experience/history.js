// SPDX-License-Identifier: Apache-2.0
import { readJournalPage } from '../store.js';
import { restoreSessionRecords } from '../persistence/session-history.js';
import { transcriptEvents } from './transcript.js';

export async function loadEarlierTranscriptPage(workspace, limit = 100) {
  const view = workspace.projection.active();
  const session = view ? workspace.sessions.get(view.id) : null;
  const available = 4096 - (view?.historyRecords.length ?? 0);
  if (!view?.hasMore || !session?.engine.store || available <= 0) return false;
  const page = await readJournalPage(session.engine.store.path, {
    beforeSequence: view.beforeSequence, limit: Math.min(limit, available),
  });
  view.beforeSequence = page.beforeSequence;
  view.hasMore = page.hasMore;
  const transcript = restoreSessionRecords(page.records).transcript;
  return workspace.projection.prependHistory(view.id, transcriptEvents(transcript));
}
