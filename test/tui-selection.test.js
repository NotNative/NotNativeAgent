// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { TuiProjection } from '../src/experience/projection.js';
import { TuiRenderer } from '../src/tui/renderer.js';
import { beginSelection, decorateSelection, selectedText, updateSelection } from '../src/tui/selection.js';

const INVERSE = '\u001b[7m';

for (const reverse of [false, true]) {
  test(`document highlight follows scrolling with ${reverse ? 'reverse' : 'forward'} selection`, () => {
    const projection = new TuiProjection();
    projection.addSession('main', 'Main', { model: 'm', provider: 'p' });
    projection.active().records.push({ type: 'stream_delta', text: Array.from(
      { length: 60 }, (_, index) => `transcript line ${index}`,
    ).join('\n') });
    const renderer = new TuiRenderer();
    const capabilities = { width: 80, height: 20, color: true };
    renderer.frame(projection, capabilities);
    const first = projection.selectionContentBounds.first;
    const last = projection.selectionContentBounds.last;
    const startLine = projection.selectionRowMap.get(first);
    const endLine = projection.selectionRowMap.get(last);
    const anchor = { row: reverse ? last : first, column: reverse ? 8 : 4 };
    const focus = { row: reverse ? first : last, column: reverse ? 4 : 8, pressed: false };
    beginSelection(projection, anchor);
    updateSelection(projection, focus);
    const copied = selectedText(projection);
    assert.ok(copied.length > 0);

    // Scroll partially away, completely away, then back to the original selection.
    for (const delta of [-3, -20, 10, 10, 3]) {
      projection.scrollActive(delta);
      const frame = renderer.frame(projection, capabilities).trimEnd().split('\n');
      for (const [index, row] of frame.entries()) {
        const documentLine = projection.selectionRowMap.get(index + 1);
        const expected = Number.isInteger(documentLine) && documentLine >= startLine && documentLine <= endLine;
        assert.equal(row.includes(INVERSE), expected, `screen row ${index + 1}, document line ${documentLine}`);
      }
      assert.equal(selectedText(projection), copied);
    }
  });
}

test('offscreen selection endpoints highlight only mapped content and preserve partial columns', () => {
  const selection = {
    anchor: { row: 2, column: 3 }, focus: { row: 4, column: 4 },
    documentAnchor: { line: 10, column: 3 }, documentFocus: { line: 20, column: 4 },
  };
  const middle = decorateSelection(['header', 'middle', 'footer'], selection, new Map([[2, 15]]));
  assert.deepEqual(middle, ['header', `${INVERSE}middle\u001b[0m`, 'footer']);
  const edges = decorateSelection(['abcdef', 'ghijkl'], selection, new Map([[1, 10], [2, 20]]));
  assert.deepEqual(edges, [`ab${INVERSE}cdef\u001b[0m`, `${INVERSE}ghi\u001b[0mjkl`]);
  assert.deepEqual(decorateSelection(['unrelated'], selection, new Map()), ['unrelated']);
});

test('scrolling during selection can select text with identical screen endpoints', () => {
  const selection = {
    anchor: { row: 3, column: 1 }, focus: { row: 3, column: 1 },
    documentAnchor: { line: 2, column: 1 }, documentFocus: { line: 5, column: 1 },
  };
  const rows = decorateSelection(['middle'], selection, new Map([[1, 3]]));
  assert.equal(rows[0], `${INVERSE}middle\u001b[0m`);
});

test('a collapsed document selection neither highlights nor copies stale screen coordinates', () => {
  const selection = {
    anchor: { row: 1, column: 1 }, focus: { row: 2, column: 4 },
    documentAnchor: { line: 0, column: 2 }, documentFocus: { line: 0, column: 2 },
  };
  const rows = ['first', 'second'];
  assert.deepEqual(decorateSelection(rows, selection, new Map([[1, 0], [2, 1]])), rows);
  assert.equal(selectedText({ terminalSelection: selection, visibleFrame: rows, selectionDocumentLines: rows }), '');
});
