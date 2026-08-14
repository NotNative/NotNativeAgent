// SPDX-License-Identifier: Apache-2.0

export function recordTuiClick(workspace, action) {
  if (!action.pressed || action.motion) return false;
  return telemetry(workspace)?.record('tui.mouse', 'observed', {
    type: action.wheel ? 'wheel' : 'click', button: mouseButton(action),
    row: action.row, column: action.column, target: workspace.projection.overlay?.kind ?? 'conversation',
  }, correlation(workspace)) ?? false;
}

export function recordClipboard(workspace, status, payload = {}, durationMs = undefined) {
  return telemetry(workspace)?.record('tui.clipboard', status, payload, {
    ...correlation(workspace), durationMs, reasonCode: payload.code,
  }) ?? false;
}

function telemetry(workspace) {
  try { return workspace.activeEngine?.().telemetry; } catch { return null; }
}

function correlation(workspace) {
  const session = workspace.projection.active();
  return { source: 'root-tui', sessionId: session?.id, turnId: session?.activeTurnId };
}

function mouseButton(action) {
  if (action.wheel) return action.button === 0 ? 'wheel_up' : 'wheel_down';
  return ['left', 'middle', 'right'][action.button] ?? 'unknown';
}
