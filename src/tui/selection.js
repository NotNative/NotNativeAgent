// SPDX-License-Identifier: Apache-2.0
import { displayWidth } from './terminal-markdown.js';

const INVERSE = '\u001b[7m';
const RESET = '\u001b[0m';

export function beginSelection(projection, action) {
  const screen = point(action); const document = documentPoint(projection, action);
  projection.terminalSelection = { anchor: screen, focus: screen, documentAnchor: document, documentFocus: document, complete: false };
}

export function updateSelection(projection, action) {
  if (!projection.terminalSelection || projection.terminalSelection.complete) return false;
  projection.terminalSelection.focus = point(action);
  projection.terminalSelection.documentFocus = documentPoint(projection, action) ?? projection.terminalSelection.documentFocus;
  projection.terminalSelection.complete = !action.pressed;
  return true;
}

export function clearSelection(projection) {
  clearInterval(projection.selectionScrollTimer);
  projection.selectionScrollTimer = null;
  projection.terminalSelection = null;
}

export function selectedText(projection) {
  const document = documentSelection(projection);
  if (document !== null) return document;
  const range = selectionRange(projection.terminalSelection);
  if (!range || samePoint(range.start, range.end)) return '';
  const lines = projection.visibleFrame.slice(range.start.row - 1, range.end.row);
  return lines.map((line, index) => {
    const start = index === 0 ? range.start.column - 1 : 0;
    const end = index === lines.length - 1 ? range.end.column - 1 : displayWidth(line);
    return visibleSlice(line, start, end);
  }).join('\n');
}

export function extendDocumentSelection(projection, delta) {
  const selection = projection.terminalSelection, lines = projection.selectionDocumentLines;
  if (!selection?.documentFocus || !Array.isArray(lines)) return;
  selection.documentFocus.line = Math.max(0, Math.min(lines.length - 1, selection.documentFocus.line + delta));
  selection.documentFocus.column = delta < 0 ? 1 : displayWidth(lines[selection.documentFocus.line] ?? '') + 1;
}

export function decorateSelection(lines, selection, rowMap) {
  const document = documentRange(selection);
  if (document) {
    // Invariant: copied text and visual highlighting share document coordinates, not fixed screen rows.
    const { start, end } = document;
    if (compareDocument(start, end) === 0) return lines;
    return lines.map((line, index) => {
      const documentLine = rowMap?.get(index + 1);
      if (!Number.isInteger(documentLine) || documentLine < start.line || documentLine > end.line) return line;
      return invertVisibleRange(line, documentLine === start.line ? start.column - 1 : 0,
        documentLine === end.line ? end.column - 1 : Number.POSITIVE_INFINITY);
    });
  }
  const range = selectionRange(selection);
  if (!range || samePoint(range.start, range.end)) return lines;
  return lines.map((line, index) => {
    const row = index + 1;
    if (row < range.start.row || row > range.end.row) return line;
    const start = row === range.start.row ? range.start.column - 1 : 0;
    const end = row === range.end.row ? range.end.column - 1 : Number.POSITIVE_INFINITY;
    return invertVisibleRange(line, start, end);
  });
}

export function plainTerminalLine(value) {
  return value.replaceAll(/\u001b\[[0-?]*[ -\/]*[@-~]/gu, '');
}

function selectionRange(selection) {
  if (!selection) return null;
  const ordered = compare(selection.anchor, selection.focus) <= 0
    ? [selection.anchor, selection.focus] : [selection.focus, selection.anchor];
  return { start: ordered[0], end: ordered[1] };
}

function invertVisibleRange(value, start, end) {
  let column = 0;
  let selected = false;
  let result = '';
  for (const token of value.match(/\u001b\[[0-?]*[ -\/]*[@-~]|./gu) ?? []) {
    if (token.startsWith('\u001b')) {
      result += token;
      if (selected) result += INVERSE;
      continue;
    }
    const next = column + Math.max(1, displayWidth(token));
    const shouldSelect = next > start && column < end;
    if (shouldSelect !== selected) result += shouldSelect ? INVERSE : RESET;
    result += token; selected = shouldSelect; column = next;
  }
  return selected ? `${result}${RESET}` : result;
}

function visibleSlice(value, start, end) {
  let column = 0;
  let result = '';
  for (const character of [...value]) {
    const next = column + Math.max(1, displayWidth(character));
    if (next > start && column < end) result += character;
    column = next;
  }
  return result;
}

function point(action) {
  return { row: Math.max(1, action.row), column: Math.max(1, action.column) };
}

function documentPoint(projection, action) {
  const line = projection.selectionRowMap?.get(action.row);
  return Number.isInteger(line) ? { line, column: Math.max(1, action.column) } : null;
}

function documentSelection(projection) {
  const range = documentRange(projection.terminalSelection), lines = projection.selectionDocumentLines;
  if (!range || !Array.isArray(lines)) return null;
  const { start, end } = range;
  if (start.line === end.line && start.column === end.column) return '';
  return lines.slice(start.line, end.line + 1).map((line, index) => visibleSlice(
    line, index === 0 ? start.column - 1 : 0,
    index === end.line - start.line ? end.column - 1 : displayWidth(line),
  )).join('\n');
}

function documentRange(selection) {
  if (!selection?.documentAnchor || !selection.documentFocus) return null;
  const [start, end] = compareDocument(selection.documentAnchor, selection.documentFocus) <= 0
    ? [selection.documentAnchor, selection.documentFocus] : [selection.documentFocus, selection.documentAnchor];
  return { start, end };
}

function compareDocument(left, right) {
  return left.line === right.line ? left.column - right.column : left.line - right.line;
}

function compare(left, right) {
  return left.row === right.row ? left.column - right.column : left.row - right.row;
}

function samePoint(left, right) {
  return left.row === right.row && left.column === right.column;
}
