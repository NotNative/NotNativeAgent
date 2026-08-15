// SPDX-License-Identifier: Apache-2.0

export function recordTuiClick(workspace, action) {
  if (!workspace?.projection || !action || action.pressed !== true || action.motion === true) return false;
  try {
    return telemetry(workspace)?.record('tui.mouse', 'observed', {
      type: action.wheel ? 'wheel' : 'click', button: mouseButton(action),
      row: action.row, column: action.column, target: workspace.projection.overlay?.kind ?? 'conversation',
    }, correlation(workspace)) ?? false;
  } catch (error) { return recordTelemetryFailure(workspace, 'mouse', error); }
}

export function recordClipboard(workspace, status, payload = {}, durationMs = undefined) {
  if (!workspace?.projection) return false;
  try {
    return telemetry(workspace)?.record('tui.clipboard', status, payload, {
      ...correlation(workspace), durationMs, reasonCode: payload.code,
    }) ?? false;
  } catch (error) { return recordTelemetryFailure(workspace, 'clipboard', error); }
}

function telemetry(workspace) {
  try { return workspace.activeEngine?.().telemetry; } catch { return null; }
}

function correlation(workspace) {
  const session = workspace?.projection?.active?.();
  return { source: 'root-tui', sessionId: session?.id, turnId: session?.activeTurnId };
}

function mouseButton(action) {
  if (action.wheel) return action.button === 0 ? 'wheel_up' : 'wheel_down';
  if (!Number.isInteger(action.button) || action.button < 0 || action.button > 2) return 'unknown';
  return ['left', 'middle', 'right'][action.button];
}

function recordTelemetryFailure(workspace, operation, error) {
  try {
    workspace.options?.logger?.record({
      type: 'tui_telemetry_failed', operation, code: error?.code ?? 'telemetry_record_failed', outcome: 'failed',
    });
  } catch { /* Observability cannot become part of the input path. */ }
  return false;
}
