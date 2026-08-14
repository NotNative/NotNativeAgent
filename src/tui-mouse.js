// SPDX-License-Identifier: Apache-2.0
import { loadEarlierTranscriptPage } from './workspace-history.js';
import { tabMenuOverlay } from './tui-overlays.js';
import { beginSelection, clearSelection, extendDocumentSelection, updateSelection } from './tui-selection.js';

export async function scrollPageUp(workspace) {
  workspace.projection.scrollActive(-10);
  if (workspace.projection.active()?.viewportEnd === 0) await loadEarlierTranscriptPage(workspace);
}

export async function handleMouse(action, workspace, headerTargetAt, activateOverlay, clipboard) {
  if ((action.motion || !action.pressed) && updateSelection(workspace.projection, action)) {
    updateSelectionAutoScroll(workspace, action);
    return;
  }
  if (action.wheel) {
    if (action.button === 0) await scrollPageUp(workspace);
    else if (action.button === 1) workspace.projection.scrollActive(10);
    return;
  }
  if (!action.pressed) return;
  if (action.button === 2 && !action.shift && action.row !== 1) {
    await clipboard.rightClick();
    return;
  }
  if (workspace.projection.active()?.pendingPermission) {
    workspace.projection.showNotice('approval', 'Resolve the pending decision before switching conversations.');
    return;
  }
  if (action.button === 0) {
    const contentTarget = workspace.projection.mouseTargets.find((item) => item.row === action.row);
    if (contentTarget?.type === 'overlay-item') {
      clearSelection(workspace.projection);
      workspace.projection.selectOverlay(contentTarget.index);
      await activateOverlay();
      return;
    }
    if (contentTarget?.type === 'activity') {
      clearSelection(workspace.projection);
      workspace.projection.toggleActivity(contentTarget.turnId);
      return;
    }
    if (contentTarget?.type === 'work-summary') {
      clearSelection(workspace.projection);
      await workspace.toggleWorkSummary();
      return;
    }
  }
  if (action.button === 0 && action.row !== 1) {
    beginSelection(workspace.projection, action);
    return;
  }
  if (![0, 2].includes(action.button) || action.shift || action.row !== 1) return;
  clearSelection(workspace.projection);
  const target = headerTargetAt(workspace.projection, action.column);
  if (target?.type === 'session') {
    workspace.projection.activate(target.id);
    if (action.button === 2) workspace.projection.openOverlay(tabMenuOverlay(workspace.projection.active()));
  }
  else if (target?.type === 'new_tab') await workspace.createNext();
}

function updateSelectionAutoScroll(workspace, action) {
  stopSelectionAutoScroll(workspace.projection);
  if (!action.pressed) return;
  const bounds = workspace.projection.selectionContentBounds;
  const direction = action.row <= bounds?.first ? -1 : action.row >= bounds?.last ? 1 : 0;
  if (direction === 0) return;
  const tick = async () => {
    if (!workspace.projection.terminalSelection || workspace.projection.terminalSelection.complete) {
      stopSelectionAutoScroll(workspace.projection);
      return;
    }
    if (direction < 0 && workspace.projection.active()?.viewportEnd === 0) await loadEarlierTranscriptPage(workspace);
    workspace.projection.scrollActive(direction);
    extendDocumentSelection(workspace.projection, direction);
    workspace.onChange();
  };
  workspace.projection.selectionScrollTimer = setInterval(() => void tick(), 65);
  workspace.projection.selectionScrollTimer.unref?.();
}

function stopSelectionAutoScroll(projection) {
  clearInterval(projection.selectionScrollTimer);
  projection.selectionScrollTimer = null;
}
