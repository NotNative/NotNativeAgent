// SPDX-License-Identifier: Apache-2.0
import { readJournalPage } from '../store.js';
import { journalEvents } from './transcript.js';

const MAX_RETAINED_HISTORY_RECORDS = 4096;

export async function loadEarlierTranscriptPage(workspace, limit = 100) {
  const view = workspace.projection.active();
  const session = view ? workspace.sessions.get(view.id) : null;
  const available = MAX_RETAINED_HISTORY_RECORDS - (view?.historyRecords.length ?? 0);
  if (!view?.hasMore || !session?.engine.store || available <= 0) return false;
  const page = await readJournalPage(session.engine.store.path, {
    beforeSequence: view.beforeSequence, limit: Math.min(limit, available),
  });
  if (!page || !Array.isArray(page.records)) return false;
  view.beforeSequence = page.beforeSequence;
  view.hasMore = page.hasMore;
  return workspace.projection.prependHistory(view.id, journalEvents(page.records));
}
