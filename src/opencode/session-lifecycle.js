// SPDX-License-Identifier: Apache-2.0
// Lifecycle operations for OpenCode wire sessions: client delete, surface-stop
// close, and boot-time restore. Split from `sessions.js` so the file stays
// readable and under its line budget; the workspace shape these helpers take
// is the one `createOpenCodeSessionWorkspace` builds.
import { ContractError, newId, requireExternalId } from '../ids.js';
import { projectIdentifier } from './registry.js';
import { removeSessionIndex } from './session-index.js';
import { seedSessionHistory } from './session-restore.js';

/** Surface-stop close: shuts the engine down and releases its lock without
 *  deleting anything.
 *
 *  Why separate from `remove`: the client's delete means "this conversation is
 *  gone" and must also drop the durable identity, while the process stopping
 *  means nothing about the conversation. Sharing one path made a restart erase
 *  every session the GUI still listed. */
export async function closeSession(workspace, ocId) {
  const session = requireSession(workspace, ocId);
  session.wireSession.abort();
  await session.engine.shutdown({ request_id: newId('oc_shutdown'), type: 'shutdown' });
  workspace.registry.remove(ocId);
  for (const [token, owner] of [...workspace.pendingQuestions.entries()]) {
    if (owner === ocId) workspace.pendingQuestions.delete(token);
  }
  return { closed: true };
}

export async function removeSession(workspace, options, ocId) {
  const session = requireSession(workspace, ocId);
  const directory = session.directory ?? '';
  const result = await closeSession(workspace, ocId);
  // Why: a client delete must remove the durable identity too, or the next
  // boot would restore the deleted conversation. The journal stays — deletion
  // of the transcript is the engine's own recovery semantics.
  await removeSessionIndex(options.storeRoot, ocId).catch(() => undefined);
  workspace.bus.publishSession({
    directory,
    project: projectIdentifier(directory),
    sessionID: ocId,
    type: 'session.deleted',
    properties: { sessionID: ocId },
  });
  return result;
}

/** Re-open a durable journal under its recorded wire identity.
 *
 *  Why through the ordinary attach path: the engine replays and restores its
 *  own journal when constructed with an existing session id, so restore is the
 *  same supervised construction a fresh session gets — no separate governance
 *  surface, and provenance/lock checks stay fail-closed.
 *
 *  Why `attach` arrives as a parameter: the ordinary attach path is private to
 *  `sessions.js`, and importing it here would make the module graph circular. */
export async function restoreSession(workspace, options, input, attach) {
  const described = await attach({
    title: input.title ?? 'Restored session',
    directory: input.directory,
    ocId: input.ocId,
    engineSessionId: requireExternalId(input.engineSessionId, 'session_id'),
    createdAt: input.createdAt,
    parentID: input.parentID,
  });
  seedSessionHistory(workspace.registry.get(described.id), workspace);
  return described;
}

function requireSession(workspace, ocId) {
  const session = workspace.registry.get(ocId);
  if (!session) throw new ContractError('opencode_session_missing', 'session was not found on the opencode surface');
  return session;
}
