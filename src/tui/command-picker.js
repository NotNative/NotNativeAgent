// SPDX-License-Identifier: Apache-2.0
import { commandPresentation, commandSuggestions } from './commands.js';

export function handleCommandPickerAction(action, session) {
  const suggestions = pickerSuggestions(session);
  if (suggestions.length === 0) return false;
  if (['history_up', 'history_down'].includes(action.action)) {
    if (!Array.isArray(session.commandSuggestionItems)) session.commandSuggestionItems = suggestions;
    const delta = action.action === 'history_up' ? -1 : 1;
    session.commandSuggestionIndex = (session.commandSuggestionIndex + delta + suggestions.length) % suggestions.length;
    session.editor.set(suggestions[session.commandSuggestionIndex].name);
    return true;
  }
  if (action.action !== 'complete_command') return false;
  const item = suggestions[Math.min(session.commandSuggestionIndex, suggestions.length - 1)];
  session.editor.set(item.name); resetCommandPicker(session);
  return true;
}

export function resetCommandPicker(session) {
  session.commandSuggestionIndex = 0;
  session.commandSuggestionItems = null;
}

export function commandPickerLines(session, projection, capacity) {
  const suggestions = pickerSuggestions(session)
    .map((item) => commandPresentation(item, session, projection.bindings));
  const selected = Math.min(session.commandSuggestionIndex ?? 0, Math.max(0, suggestions.length - 1));
  const start = Math.max(0, Math.min(selected - capacity + 1, suggestions.length - capacity));
  return suggestions.slice(start, start + capacity).map((item, offset) => {
    const marker = start + offset === selected ? '>' : ' ';
    return `${marker} ${item.name} - ${item.available ? item.description : `unavailable: ${item.unavailableReason}`}`;
  });
}

function pickerSuggestions(session) {
  if (Array.isArray(session.commandSuggestionItems)) return session.commandSuggestionItems;
  return commandSuggestions(session.editor.text, Number.MAX_SAFE_INTEGER);
}
