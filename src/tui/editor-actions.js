// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';

const EDITOR_ACTIONS = new Set([
  'newline', 'insert', 'paste', 'backspace', 'delete', 'left', 'right', 'select_left', 'select_right',
  'word_left', 'word_right', 'select_word_left', 'select_word_right', 'select_up', 'select_down', 'undo',
]);

/**
 * Dispatches a decoded `{ action, text? }` input to the editor interface.
 * Returns false for unsupported or malformed actions and true when consumed.
 */
export function handleEditorAction(action, editor) {
  if (!action || typeof action.action !== 'string' || !EDITOR_ACTIONS.has(action.action)) return false;
  requireEditor(editor);
  if (action.action === 'newline') editor.insert('\n');
  else if (['insert', 'paste'].includes(action.action)) editor.insert(action.text);
  else if (action.action === 'backspace') editor.backspace();
  else if (action.action === 'delete') editor.delete();
  else if (action.action === 'left') editor.move(-1);
  else if (action.action === 'right') editor.move(1);
  else if (action.action === 'select_left') editor.move(-1, true);
  else if (action.action === 'select_right') editor.move(1, true);
  else if (action.action === 'word_left') editor.moveWord(-1);
  else if (action.action === 'word_right') editor.moveWord(1);
  else if (action.action === 'select_word_left') editor.moveWord(-1, true);
  else if (action.action === 'select_word_right') editor.moveWord(1, true);
  else if (action.action === 'select_up') editor.moveVertical(-1, true);
  else if (action.action === 'select_down') editor.moveVertical(1, true);
  else if (action.action === 'undo') editor.undo();
  return true;
}

function requireEditor(editor) {
  if (!editor || typeof editor !== 'object') {
    throw new ContractError('tui_editor_unavailable', 'terminal editor state is unavailable');
  }
}
