// SPDX-License-Identifier: Apache-2.0
import { DiagnosticBundle } from '../diagnostic-bundle.js';
import { ContractError } from '../ids.js';
import { valueOverlay } from './overlays.js';
import { sessionStats } from './session-stats.js';

export async function handleSupportCommand(name, argument, workspace) {
  const bundle = new DiagnosticBundle({
    engine: workspace.activeEngine(), logger: workspace.options.logger,
    sessions: [...workspace.sessions.values()].map((session) => ({
      id: session.id, engine: session.engine,
      statistics: sessionStats(workspace.projection.sessions.get(session.id)),
    })),
    activeSessionId: workspace.projection.activeId,
    maintenance: () => workspace.dream?.status() ?? null,
  });
  const legacyPath = name === '/bundle' && argument.startsWith('create ') ? argument.slice(7).trim() : null;
  if (argument === 'preview') {
    workspace.projection.openOverlay(valueOverlay('support', 'Support bundle preview', await bundle.preview()));
    return;
  }
  if (name === '/bundle' && argument && !legacyPath) {
    throw new ContractError('bundle_command_invalid', 'use /support, /support preview, or /support PATH.zip');
  }
  const result = await bundle.create(legacyPath || argument || null);
  workspace.projection.openOverlay(valueOverlay('support', 'Support bundle ready to send', result));
}
