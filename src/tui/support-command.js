// SPDX-License-Identifier: Apache-2.0
import { DiagnosticBundle } from '../diagnostic-bundle.js';
import { ContractError } from '../ids.js';
import { valueOverlay } from './overlays.js';
import { sessionStats } from './session-stats.js';

export async function handleSupportCommand(name, argument, workspace) {
  const normalizedArgument = typeof argument === 'string' ? argument : '';
  const bundle = new DiagnosticBundle({
    engine: workspace.activeEngine(), logger: workspace.options.logger,
    sessions: [...workspace.sessions.values()].map((session) => ({
      id: session.id, engine: session.engine,
      statistics: sessionStats(workspace.projection.sessions.get(session.id)),
    })),
    activeSessionId: workspace.projection.activeId,
    maintenance: () => workspace.dream?.status() ?? null,
  });
  // `/bundle create PATH` remains a compatibility alias; `/support PATH` is the canonical syntax.
  const legacyPath = name === '/bundle' && normalizedArgument.startsWith('create ')
    ? normalizedArgument.slice(7).trim() : null;
  if (normalizedArgument === 'preview') {
    workspace.projection.openOverlay(valueOverlay('support', 'Support bundle preview', await bundle.preview()));
    return;
  }
  if (name === '/bundle' && normalizedArgument && !legacyPath) {
    throw new ContractError('bundle_command_invalid', 'use /support, /support preview, or /support PATH.zip');
  }
  const result = await bundle.create(legacyPath || normalizedArgument || null);
  workspace.projection.openOverlay(valueOverlay('support', 'Support bundle ready to send', result));
}
