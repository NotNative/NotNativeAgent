// SPDX-License-Identifier: Apache-2.0
import { handleQuestionAction } from './question-view.js';
import { headerTargetAt } from './renderer.js';
import { handleMouse } from './mouse.js';
import { pasteClipboard } from './clipboard-actions.js';
import { handleEditorAction } from './editor-actions.js';
import { recordTuiClick } from './telemetry.js';

export async function handlePendingQuestion(action, session, workspace) {
  const projection = workspace.projection;
  if (action.action === 'next_tab') projection.cycleActive(1);
  else if (action.action === 'previous_tab') projection.cycleActive(-1);
  else if (/^tab_[1-8]$/u.test(action.action)) projection.activateIndex(Number(action.action.slice(-1)) - 1);
  else if (action.action === 'paste_clipboard') {
    await pasteClipboard(workspace, () => undefined, handleEditorAction);
  } else if (action.action === 'mouse') {
    recordTuiClick(workspace, action);
    if (action.button === 2 && action.row === 1) return;
    if (action.wheel) {
      await handleQuestionAction({ action: action.button === 0 ? 'scroll_page_up' : 'scroll_page_down' }, session, workspace);
      return;
    }
    const target = action.pressed && action.button === 0
      ? projection.mouseTargets.find((item) => item.row === action.row) : null;
    if (target?.type === 'question-option') {
      session.pendingQuestion.selected = target.index;
      await handleQuestionAction({ action: 'submit' }, session, workspace);
    } else await handleMouse(action, workspace, headerTargetAt, () => undefined, {
      rightClick: () => pasteClipboard(workspace, () => undefined, handleEditorAction, 'right_click'),
    });
  } else await handleQuestionAction(action, session, workspace);
}
