// SPDX-License-Identifier: Apache-2.0
/**
 * Inline comment range helpers (doc 06 §10.2 on the textarea-host v1):
 * offsets in a textarea caret map to editor line ranges; code for the range
 * is extracted from the same content snapshot the user selected in (delta
 * E20: the CodeMirror swap keeps the same offset→line contract).
 */

export interface LineRange {
  startLine: number;
  endLine: number;
}

/** Start offset of every line (length = line count). */
export function lineOffsets(content: string): number[] {
  const offsets = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '\n') offsets.push(index + 1);
  }
  return offsets;
}

function lineOf(offsets: number[], offset: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (offsets[mid]! <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** Selection offsets → inclusive editor line range (normalized start<=end).
 * A range whose LAST line holds no selected character is clamped to end at
 * the previous line so "selected through the line start" does not create an
 * empty-tail comment. */
export function lineRangeFromOffsets(content: string, startOffset: number, endOffset: number): LineRange | null {
  if (startOffset < 0 || endOffset < 0 || startOffset >= endOffset) return null;
  const offsets = lineOffsets(content);
  const start = Math.min(startOffset, content.length);
  const end = Math.min(endOffset, content.length);
  let startLine = lineOf(offsets, start);
  let endLine = lineOf(offsets, Math.max(end - 1, start));
  if (startLine > endLine) return null;
  const lines = content.split('\n');
  endLine = trimEnd(lines, startLine, endLine);
  return { startLine, endLine };
}

function trimEnd(lines: string[], startLine: number, endLine: number): number {
  while (endLine > startLine && (lines[endLine] ?? '').trim().length === 0) endLine -= 1;
  return endLine;
}

/** §10.2 #4: code text for the range, joined without the trailing newline. */
export function extractLines(content: string, startLine: number, endLine: number): string {
  const lines = content.split('\n');
  const lo = Math.max(0, Math.min(startLine, endLine, lines.length - 1));
  const hi = Math.max(0, Math.min(Math.max(startLine, endLine), lines.length - 1));
  return lines.slice(lo, hi + 1).join('\n');
}
