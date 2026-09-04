// SPDX-License-Identifier: Apache-2.0
const RECORD_TYPE = Object.freeze({ USER: 'user_input', STREAM: 'stream_delta', ACTIVITY: 'activity' });

/** Mutates the renderer's line accumulator to preserve visual rhythm between conversation record types. */
export function applyConversationSpacing(lines, recordType, previousMessageType, previousVisibleType) {
  if (!Array.isArray(lines)) throw new TypeError('conversation spacing requires a line accumulator');
  if (recordType === RECORD_TYPE.USER && previousMessageType === RECORD_TYPE.STREAM) setBlankLines(lines, 2);
  else if (recordType === RECORD_TYPE.USER && lines.length > 0) setBlankLines(lines, 1);
  if (recordType === RECORD_TYPE.STREAM && (previousMessageType === RECORD_TYPE.USER
    || [RECORD_TYPE.ACTIVITY, RECORD_TYPE.STREAM].includes(previousVisibleType))) setBlankLines(lines, 1);
}

function setBlankLines(lines, count) {
  while (lines.at(-1) === '') lines.pop();
  for (let index = 0; index < count; index += 1) lines.push('');
}
