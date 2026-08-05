// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { valueOverlay } from './tui-overlays.js';
import { openSessionStats } from './tui-session-stats.js';
import { openFilesView } from './tui-files-view.js';
import { listDurableSessions } from './self-diagnostics-tool.js';

export async function openRuntimeInspection(kind, workspace) {
  if (kind === 'stats') return openSessionStats(workspace);
  if (kind === 'files') return openFilesView(workspace);
  const engine = workspace.activeEngine();
  if (kind === 'sessions') {
    const sessions = await listDurableSessions({
      sessionsRoot: engine.store?.root ?? engine.dataPaths.sessions, sessionId: engine.sessionId,
    }, 32);
    workspace.projection.openOverlay(valueOverlay('sessions', 'Durable sessions', {
      content_redacted: true, sessions,
    }));
    return;
  }
  if (kind === 'project') {
    const intake = await engine.projectIntake.inspect();
    workspace.projection.openOverlay(valueOverlay('project', 'Project intake', intake));
    return;
  }
  if (kind === 'hooks') {
    workspace.projection.openOverlay(valueOverlay('hooks', 'Hook bundles', engine.hooks.health()));
    return;
  }
  if (kind === 'extensions') {
    workspace.projection.openOverlay(valueOverlay('extensions', 'Extensions', {
      items: engine.extensions.list(), diagnostics: engine.extensions.diagnostics(),
    }));
    return;
  }
  throw new ContractError('runtime_inspection_invalid', 'unknown runtime inspection area');
}
