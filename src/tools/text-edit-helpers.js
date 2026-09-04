// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';

export function replaceLineRange(content, startLine, endLine, replacement) {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const trailing = content.endsWith('\n');
  const lines = logicalLines(content);
  const inserted = replacement.length === 0 ? [] : replacement.replace(/\r\n/gu, '\n').split('\n');
  if (inserted.at(-1) === '') inserted.pop();
  lines.splice(startLine - 1, endLine - startLine + 1, ...inserted);
  const result = lines.join(newline);
  return trailing && result.length > 0 ? `${result}${newline}` : result;
}

export function countOccurrences(content, search) {
  requireNeedle(search);
  let count = 0;
  let offset = 0;
  while ((offset = content.indexOf(search, offset)) !== -1) {
    count += 1;
    offset += search.length;
  }
  return count;
}

export function replaceText(content, oldText, newText, replaceAll) {
  requireNeedle(oldText);
  return replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, () => newText);
}

function requireNeedle(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ContractError('tool_schema_invalid', 'text edit search must be non-empty text');
  }
}

export function logicalLines(content) {
  const lines = content.split(/\r?\n/u);
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines.length > 0 ? lines : [''];
}
