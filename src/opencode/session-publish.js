// SPDX-License-Identifier: Apache-2.0
// Publication of an attached session: the v2 stream, the durable index, the log.
//
// Why this is its own module: the attach path had grown to own identity, engine
// construction, the wire projection, the durable record and three log lines at
// once. The durable record is the part with rules worth reading in isolation —
// what it must contain for a restart to reopen the same conversation, and what
// it must never contain.
import { appendSessionIndex } from './session-index.js';

/** Wire the attached session to the v2 stream, the durable index, and the log.
 *
 *  Why the index write: the wire identity is the only link between what the
 *  client sees (`ses_*`) and the journal the engine will re-open on the next
 *  boot (`session_*`). Without it a restart loses the GUI's history again. */
export async function publishAttach(workspace, options, { stored, sessionId, ocId, createdAtMs, parentID, metadata, runtimeRef }) {
  const { registry, wiredVersion } = workspace;
  workspace.v2?.attach(registry.describe(stored, wiredVersion), metadata, runtimeRef);
  if (options.storeRoot) {
    // Compatibility: the model the session runs at is part of its durable
    // identity, not a per-boot default. A real OpenCode keeps `model` (and its
    // `variant`) on a session across a restart; without it a restored session
    // reopened on whatever route the surface was configured with, which is a
    // model the conversation never ran on.
    const entry = { ocId, sessionId, title: stored.title, directory: stored.directory, createdAt: createdAtMs,
      ...(parentID ? { parentID } : {}),
      ...(Number.isFinite(stored.archivedAt) ? { archivedAt: stored.archivedAt } : {}),
      ...(runtimeRef ? { model: runtimeRef } : {}) };
    await appendSessionIndex(options.storeRoot, entry)
      .catch((error) => options.logger?.record({ type: 'opencode_session_index_failed', ocId, code: error.code ?? 'index_write_failed' }));
  }
  options.logger?.record({ type: 'opencode_session_created', ocId: stored.ocId, sessionId, title: stored.title }, { sessionId });
  options.logger?.record({ type: 'opencode_session_started', ocId: stored.ocId, sessionId, title: stored.title, directory: stored.directory }, { sessionId });
}
