// SPDX-License-Identifier: Apache-2.0
import { commandPresentation, commandSuggestions } from './tui-commands.js';

export function handleCommandPickerAction(action, session) {
  const suggestions = pickerSuggestions(session);
  if (suggestions.length === 0) return false;
  if (['history_up', 'history_down'].includes(action.action)) {
    const delta = action.action === 'history_up' ? -1 : 1;
    session.commandSuggestionIndex = (session.commandSuggestionIndex + delta + suggestions.length) % suggestions.length;
    return true;
  }
  if (action.action !== 'complete_command') return false;
  const item = suggestions[Math.min(session.commandSuggestionIndex, suggestions.length - 1)];
  session.editor.set(commandCompletion(item)); session.commandSuggestionIndex = 0;
  return true;
}

export function commandPickerLines(session, projection, capacity) {
  const suggestions = pickerSuggestions(session)
    .map((item) => commandPresentation(item, session, projection.bindings));
  const selected = Math.min(session.commandSuggestionIndex ?? 0, Math.max(0, suggestions.length - 1));
  const start = Math.max(0, Math.min(selected - capacity + 1, suggestions.length - capacity));
  return suggestions.slice(start, start + capacity).map((item, offset) => {
    const marker = start + offset === selected ? '>' : ' ';
    return `${marker} ${item.usage} - ${item.available ? item.description : `unavailable: ${item.unavailableReason}`}`;
  });
}

function pickerSuggestions(session) {
  return commandSuggestions(session.editor.text, Number.MAX_SAFE_INTEGER);
}

function commandCompletion(item) {
  const parts = item.usage.split(/\s+/u); const literal = [];
  for (const part of parts) {
    if (/^(?:\[|<|[A-Z][A-Z0-9_|?-]*$)/u.test(part)) break;
    literal.push(part);
  }
  return `${literal.join(' ')}${literal.length < parts.length ? ' ' : ''}`;
}
