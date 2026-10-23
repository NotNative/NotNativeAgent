// SPDX-License-Identifier: Apache-2.0
import { CanonicalIngress } from '../ingress.js';
import { newId } from '../ids.js';
import { isGeneratedConversationName } from './conversation-title.js';
import { routePresentation } from './provider-catalog.js';
import { restoreDurablePresentation } from './transcript.js';
import { restorePresentation } from './presentation.js';

export async function attachCreatedSession(workspace, name, sessionId, options, sessionConfig, engine) {
  const ingress = new CanonicalIngress(engine, { interactive: true });
  const role = options.role ?? (workspace.sessions.size === 0 ? 'primary' : 'standard');
  const meaningful = options.meaningful ?? engine.transcript.some((item) => item.type === 'message' && item.role === 'user');
  workspace.sessions.set(sessionId, { id: sessionId, sessionId, name, engine, ingress, meaningful,
    main: options.main === true, nameLocked: options.nameLocked ?? !isGeneratedConversationName(name),
    autoNamed: options.autoNamed === true });
  const primary = sessionConfig.routes.primary;
  workspace.projection.addSession(sessionId, name, routePresentation(sessionConfig, primary, {
    workspace: sessionConfig.workspaceRoot,
  }), role);
  workspace.projection.sessions.get(sessionId).commandCapabilities = { memoryAvailable: engine.memory.enabled,
    mcpReady: engine.mcp.status().some((item) => item.state === 'ready') };
  restoreDurablePresentation(workspace.projection, sessionId, engine.restoredJournalRecords, engine.transcript, {
    truncated: engine.resumeBoundary?.hasMore === true,
  });
  workspace.projection.sessions.get(sessionId).work = engine.workStatus();
  Object.assign(workspace.projection.sessions.get(sessionId), engine.resumeBoundary ?? { beforeSequence: null, hasMore: false });
  restorePresentation(workspace.projection.sessions.get(sessionId), engine, options.presentation);
  workspace.projection.activate(sessionId);
  if (options.persist !== false) await workspace._savePoolRecoverable();
  workspace.onChange();
  return sessionId;
}

export async function rollbackCreatedSession(workspace, sessionId, engine, previousActiveId, persist) {
  try {
    await engine.shutdown({ request_id: newId('tui_create_rollback'), type: 'shutdown' });
  } catch (error) {
    try { workspace.options.logger?.record({ type: 'session_create_cleanup_failed',
      code: error.code ?? 'session_shutdown_failed' }, { sessionId }); }
    catch { /* Cleanup diagnostics cannot replace the original create failure. */ }
  }
  workspace.sessions.delete(sessionId);
  const failedTabWasActive = workspace.projection.activeId === sessionId;
  if (workspace.projection.sessions.has(sessionId)) workspace.projection.remove(sessionId);
  if (failedTabWasActive && previousActiveId && workspace.projection.sessions.has(previousActiveId)) {
    workspace.projection.activate(previousActiveId);
  }
  if (persist) {
    try { await workspace._savePoolRecoverable(); }
    catch { /* The original create failure remains primary. */ }
  }
}
