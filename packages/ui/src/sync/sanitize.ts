// SPDX-License-Identifier: Apache-2.0
/**
 * Sanitization boundary (doc 04 §A.5): oversized blob fields are stripped at
 * EVERY ingestion point before anything enters a store. Stores must never
 * hold file snapshot blobs — the reverted-UI derives from the lightweight
 * `session.revert.messageID` marker only.
 */
import type { Session, MessageEntry } from '../lib/nnd/types.ts';

type Loose = Record<string, unknown>;

function stripDiffStrings(diff: Loose): void {
  delete diff['before'];
  delete diff['after'];
  delete diff['from'];
  delete diff['to'];
}

export function stripSessionDiffSnapshots<T extends object>(session: T): T {
  const bag = session as unknown as Record<string, unknown>;
  const revert = bag['revert'] as Record<string, unknown> | undefined;
  if (revert && typeof revert === 'object') {
    delete revert['snapshot'];
    delete revert['diff'];
  } else if (bag['revert'] !== undefined) {
    delete bag['revert']; // non-object revert triggers the strip
  }
  const summary = bag['summary'] as Record<string, unknown> | undefined;
  if (summary && Array.isArray(summary['diffs'])) {
    for (const diff of summary['diffs'] as Record<string, unknown>[]) stripDiffStrings(diff);
  }
  return session;
}

export function stripMessageDiffSnapshots<T extends object>(message: T): T {
  const bag = message as unknown as Record<string, unknown>;
  const summary = bag['summary'] as Record<string, unknown> | undefined;
  if (summary && Array.isArray(summary['diffs'])) {
    for (const diff of summary['diffs'] as Record<string, unknown>[]) stripDiffStrings(diff); // keeps `patch`
  }
  return message;
}

/** List responses additionally drop `permission`, whole `summary.diffs`, and
 * reduce revert to its {messageID, partID?} marker. */
export function stripSessionListDetails<T extends object>(session: T): T {
  const bag = session as unknown as Record<string, unknown>;
  delete bag['permission'];
  const summary = bag['summary'] as Record<string, unknown> | undefined;
  if (summary && typeof summary === 'object') delete summary['diffs'];
  const revert = bag['revert'] as Record<string, unknown> | undefined;
  if (revert && typeof revert === 'object') {
    const { messageID, partID } = revert as { messageID?: string; partID?: string };
    if (messageID) bag['revert'] = partID ? { messageID, partID } : { messageID };
    else delete bag['revert'];
  } else if (bag['revert'] !== undefined) {
    delete bag['revert'];
  }
  return session;
}

export function sanitizeSessionListEntry(session: Session): Session {
  return stripSessionListDetails(stripSessionDiffSnapshots(session));
}

export function sanitizeMessageEntry(entry: MessageEntry): MessageEntry {
  stripMessageDiffSnapshots(entry.info);
  return entry;
}
