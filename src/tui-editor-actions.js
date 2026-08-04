// SPDX-License-Identifier: Apache-2.0

export function handleEditorAction(action, editor) {
  if (['insert', 'newline', 'paste'].includes(action.action)) editor.insert(action.text);
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
  else return false;
  return true;
}
