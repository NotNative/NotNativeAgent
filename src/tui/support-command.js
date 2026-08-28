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
    if (!showSupportFailure(error, workspace)) throw error;
    return;
  }
  workspace.projection.openOverlay(valueOverlay('support', 'Local support ZIP ready', [
    'Local ZIP created.',
    '',
    `File: ${result.path}`,
    `Size: ${result.bytes} bytes`,
    '',
    'Review or copy this ZIP as needed.',
  ].join('\n')));
  workspace.projection.showNotice('support', `Support bundle saved to ${result.path}`);
}

function showSupportFailure(error, workspace) {
  if (!['zip_input_too_large', 'bundle_redaction_failed'].includes(error?.code)) return false;
  const redactionFailure = error.code === 'bundle_redaction_failed';
  const label = redactionFailure ? 'BUNDLE_REDACTION_FAILED' : 'ZIP_INPUT_TOO_LARGE';
  const lines = redactionFailure ? [
    `[${label}] SUPPORT ZIP WAS NOT CREATED`, '',
    'Privacy verification found secret-like material in the diagnostic projection.',
    'No ZIP or temporary archive remains.', '',
    'Use /support preview to review the included categories. Runtime diagnostics remain unchanged.',
  ] : [
    `[${label}] SUPPORT ZIP WAS NOT CREATED`, '',
    'The current conversation diagnostic data exceeds the 16 MiB safety bound.',
    'No ZIP or temporary archive remains.', '',
    'Use /support preview to review what is included, then retry after the session is smaller.',
  ];
  workspace.projection.openOverlay({
    ...valueOverlay('support-error', 'Support bundle failed', lines.join('\n')),
    lineKinds: lines.map(() => 'error'),
  });
  workspace.projection.showNotice('error', redactionFailure
    ? `[${label}] Support ZIP was not created; privacy verification rejected the diagnostic projection.`
    : `[${label}] Support ZIP was not created; current session exceeds 16 MiB.`);
  return true;
}
