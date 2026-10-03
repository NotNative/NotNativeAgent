// SPDX-License-Identifier: Apache-2.0
import { handleEditorAction } from './editor-actions.js';
import { wrapTerminalLine } from './terminal-markdown.js';

export function questionLines(state, width, targets = new Map()) {
  const question = state.questions[state.index];
  const lines = [
    'QUESTION FOR YOU',
    ...wrapTerminalLine(`Question ${state.index + 1} of ${state.questions.length}: ${present(question.header)}`, width),
    '',
    ...wrapTerminalLine(present(question.question), width),
    '',
  ];
  for (const [index, option] of question.options.entries()) {
    const start = lines.length;
    const marker = state.selected === index ? '›' : ' ';
    const checked = question.multiple ? state.choices.has(option.label) ? '[x]' : '[ ]' : `${index + 1}.`;
    lines.push(...wrapTerminalLine(`${checked} ${present(option.label)}`, width, `${marker} `, '  '));
    if (option.description) lines.push(...wrapTerminalLine(present(option.description), width, '    ', '    '));
    for (let row = start; row < lines.length; row += 1) targets.set(row, { type: 'question-option', index });
  }
  if (question.custom) {
    const index = question.options.length;
    targets.set(lines.length, { type: 'question-option', index });
    lines.push(`${state.selected === index ? '›' : ' '} ${index + 1}. Write another answer`);
  }
  if (question.multiple) {
    const index = question.options.length + Number(question.custom);
    targets.set(lines.length, { type: 'question-option', index });
    lines.push(`${state.selected === index ? '›' : ' '} Continue (${state.choices.size} selected)`);
  }
  if (state.customMode) lines.push('', ...wrapTerminalLine(`Your answer: ${present(state.customEditor.text)}`, width));
  return lines;
}

function present(value) {
  return String(value).replaceAll('\r', '␍').replaceAll('\n', '⏎');
}

export function questionControlLine(state, bindings = {}) {
  const cancel = bindings.cancel?.replace('ctrl+', 'Ctrl+').replace('alt+', 'Alt+') ?? 'Ctrl+C';
  if (state.customMode) return `Type answer · Enter use answer · Esc return · ${cancel} decline`;
  return state.questions[state.index].multiple
    ? `Up/Down choose · Enter toggle/continue · PgUp/PgDn read · Esc or ${cancel} decline`
    : `Up/Down choose · Enter answer · PgUp/PgDn read · Esc or ${cancel} decline`;
}

// A question has its own editor, so answering never changes a conversation draft.
export async function handleQuestionAction(action, session, workspace) {
  const state = session.pendingQuestion;
  if (!state) return false;
  const question = state.questions[state.index];
  if (action.action === 'scroll_page_up' || action.action === 'scroll_page_down') {
    state.scrollOffset = Math.max(0, (state.scrollOffset ?? 0)
      + (action.action === 'scroll_page_up' ? -10 : 10));
    return true;
  }
  if (state.customMode) {
    if (action.action === 'back') { state.customMode = false; return true; }
    if (action.action === 'cancel') { await workspace.declineActiveQuestion(); return true; }
    if (action.action === 'submit') {
      const answer = state.customEditor.text.trim();
      if (!answer || answer.length > 256) {
        workspace.projection.showNotice('question', 'Enter an answer of 1 to 256 characters.');
        return true;
      }
      if (question.multiple) {
        if (!state.choices.has(answer) && state.choices.size >= 16) {
          workspace.projection.showNotice('question', 'A question accepts at most 16 answers.');
          return true;
        }
        state.choices.add(answer);
        state.customMode = false;
        state.customEditor.set('');
      } else await advanceQuestion(state, [answer], workspace);
      return true;
    }
    if (handleEditorAction(action, state.customEditor)) { state.scrollOffset = null; return true; }
    return true;
  }
  const count = question.options.length + Number(question.custom) + Number(question.multiple);
  if (action.action === 'history_up' || action.action === 'history_down') {
    state.selected = (state.selected + (action.action === 'history_up' ? -1 : 1) + count) % count;
    state.scrollOffset = null;
    return true;
  }
  if (action.action === 'insert' && /^[1-9]$/u.test(action.text)) {
    const index = Number(action.text) - 1;
    if (index < count) { state.selected = index; state.scrollOffset = null; }
    else return true;
  } else if (action.action === 'back' || action.action === 'cancel') {
    await workspace.declineActiveQuestion(); return true;
  } else if (action.action !== 'submit' && action.action !== 'insert') return true;
  if (action.action === 'insert' && !/^[1-9]$/u.test(action.text)) return true;
  if (state.selected < question.options.length) {
    const label = question.options[state.selected].label;
    if (question.multiple) {
      if (state.choices.has(label)) state.choices.delete(label);
      else if (state.choices.size < 16) state.choices.add(label);
      else workspace.projection.showNotice('question', 'A question accepts at most 16 answers.');
    } else await advanceQuestion(state, [label], workspace);
  } else if (question.custom && state.selected === question.options.length) {
    state.customMode = true;
  } else if (question.multiple && state.choices.size > 0) {
    await advanceQuestion(state, [...state.choices], workspace);
  } else workspace.projection.showNotice('question', 'Select at least one answer.');
  return true;
}

async function advanceQuestion(state, row, workspace) {
  if (state.index + 1 === state.questions.length) {
    await workspace.answerActiveQuestion([...state.answers, row]);
    return;
  }
  state.answers.push(row);
  state.index += 1;
  state.selected = 0;
  state.choices = new Set();
  state.customEditor.set('');
  state.customMode = false;
  state.scrollOffset = null;
}
