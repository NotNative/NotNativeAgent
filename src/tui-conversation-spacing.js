// SPDX-License-Identifier: Apache-2.0
export function applyConversationSpacing(lines, recordType, previousMessageType, previousVisibleType) {
  if (recordType === 'user_input' && previousMessageType === 'stream_delta') setBlankLines(lines, 2);
  if (recordType === 'stream_delta' && (previousMessageType === 'user_input'
    || ['activity', 'stream_delta'].includes(previousVisibleType))) setBlankLines(lines, 1);
}

function setBlankLines(lines, count) {
  while (lines.at(-1) === '') lines.pop();
  for (let index = 0; index < count; index += 1) lines.push('');
}
