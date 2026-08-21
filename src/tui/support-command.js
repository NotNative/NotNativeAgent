// SPDX-License-Identifier: Apache-2.0
import { DiagnosticBundle } from '../diagnostic-bundle.js';
import { ContractError } from '../ids.js';
import { valueOverlay } from './overlays.js';
import { sessionStats } from './session-stats.js';

export async function handleSupportCommand(name, argument, workspace, dependencies = {}) {
  const normalizedArgument = typeof argument === 'string' ? argument : '';
  const Bundle = dependencies.DiagnosticBundle ?? DiagnosticBundle;
  const engine = workspace.activeEngine();
  const activeSessionId = workspace.projection.activeId ?? engine.sessionId;
  const bundle = new Bundle({
    engine, logger: workspace.options.logger,
    supportRoot: workspace.options.supportRoot,
    sessions: [{
      id: activeSessionId, engine,
      statistics: sessionStats(workspace.projection.sessions.get(activeSessionId)),
    }],
    activeSessionId,
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
  const outputPath = legacyPath || normalizedArgument || bundle.defaultPath();
  workspace.projection.showNotice('support', `Creating a local redacted ZIP at ${outputPath}`);
  let result;
  try {
    result = await bundle.create(outputPath);
  } catch (error) {
    if (error?.code !== 'zip_input_too_large') throw error;
    const lines = [
      '[ZIP_INPUT_TOO_LARGE] SUPPORT ZIP WAS NOT CREATED',
      '',
      'The current conversation diagnostic data exceeds the 16 MiB safety bound.',
      'Nothing was uploaded and no partial ZIP was published.',
      '',
      'Use /support preview to review what is included, then retry after the session is smaller.',
    ];
    workspace.projection.openOverlay({
      ...valueOverlay('support-error', 'Support bundle failed', lines.join('\n')),
      lineKinds: lines.map(() => 'error'),
    });
    workspace.projection.showNotice('error', '[ZIP_INPUT_TOO_LARGE] Support ZIP was not created; current session exceeds 16 MiB.');
    return;
  }
  workspace.projection.openOverlay(valueOverlay('support', 'Support bundle ready to send', [
    'Created locally; nothing was uploaded.',
    '',
    `File: ${result.path}`,
    `Size: ${result.bytes} bytes`,
    '',
    'Copy this ZIP to the machine where it will be inspected. Review it before sending.',
  ].join('\n')));
  workspace.projection.showNotice('support', `Support bundle saved to ${result.path}`);
}
