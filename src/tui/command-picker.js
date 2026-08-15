// SPDX-License-Identifier: Apache-2.0
import { commandPresentation, commandSuggestions } from './commands.js';

const PICKER_ACTIONS = Object.freeze({ previous: 'history_up', next: 'history_down', complete: 'complete_command' });
const ALL_SUGGESTIONS_LIMIT = Number.MAX_SAFE_INTEGER;

export function handleCommandPickerAction(action, session) {
  if (!action || typeof action.action !== 'string' || !session?.editor || typeof session.editor.set !== 'function') return false;
  const suggestions = pickerSuggestions(session);
  if (suggestions.length === 0) return false;
  if ([PICKER_ACTIONS.previous, PICKER_ACTIONS.next].includes(action.action)) {
    if (!Array.isArray(session.commandSuggestionItems)) session.commandSuggestionItems = suggestions;
    const delta = action.action === PICKER_ACTIONS.previous ? -1 : 1;
    const currentIndex = Number.isSafeInteger(session.commandSuggestionIndex) ? session.commandSuggestionIndex : 0;
    session.commandSuggestionIndex = (currentIndex + delta + suggestions.length) % suggestions.length;
    session.editor.set(suggestions[session.commandSuggestionIndex].name);
    return true;
  }
  if (action.action !== PICKER_ACTIONS.complete) return false;
  const currentIndex = Number.isSafeInteger(session.commandSuggestionIndex) ? session.commandSuggestionIndex : 0;
  const item = suggestions[Math.min(Math.max(0, currentIndex), suggestions.length - 1)];
  session.editor.set(item.name);
  resetCommandPicker(session);
  return true;
}

export function resetCommandPicker(session) {
  if (!session || typeof session !== 'object') return;
  session.commandSuggestionIndex = 0;
  session.commandSuggestionItems = null;
}

export function commandPickerLines(session, projection, capacity) {
  if (!session?.editor || !projection || typeof projection !== 'object') return [];
  const boundedCapacity = Number.isSafeInteger(capacity) && capacity > 0 ? capacity : 0;
  if (boundedCapacity === 0) return [];
  const suggestions = pickerSuggestions(session)
    .map((item) => commandPresentation(item, session, projection.bindings ?? {}));
  const selected = Math.min(session.commandSuggestionIndex ?? 0, Math.max(0, suggestions.length - 1));
  const start = Math.max(0, Math.min(selected - boundedCapacity + 1, suggestions.length - boundedCapacity));
  return suggestions.slice(start, start + boundedCapacity).map((item, offset) => {
    const marker = start + offset === selected ? '>' : ' ';
    return `${marker} ${item.name} - ${item.available ? item.description : `unavailable: ${item.unavailableReason}`}`;
  });
}

function pickerSuggestions(session) {
  if (Array.isArray(session.commandSuggestionItems)) return session.commandSuggestionItems;
  return commandSuggestions(session.editor.text, ALL_SUGGESTIONS_LIMIT);
}
