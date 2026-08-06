// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { osc52Clipboard } from '../src/terminal-clipboard.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeClipboard } from '../src/native-clipboard.js';
import { beginSelection, decorateSelection, selectedText } from '../src/tui-selection.js';
import { handleCopyCommand } from '../src/tui-copy-command.js';
import { clipboardPasteAction, pasteClipboard } from '../src/tui-clipboard-actions.js';
import { recordTuiClick } from '../src/tui-telemetry.js';
import { handleMouse } from '../src/tui-mouse.js';
import { TuiProjection } from '../src/tui-model.js';

test('TUI-012 clipboard emission is explicit, bounded, and base64 isolated', async () => {
  let wire = '';
  const copy = osc52Clipboard({ isTTY: true, write: (value) => { wire += value; } });
  const result = await copy('safe\u001b]52;payload');
  assert.equal(result.copied, true);
  assert.equal(wire.startsWith('\u001b]52;c;'), true);
  assert.doesNotMatch(wire.slice(1), /safe|payload/u);
  await assert.rejects(copy('x'.repeat(100_001)), { code: 'clipboard_content_too_large' });
});

test('native clipboard uses bounded platform commands without command-line clipboard content', async () => {
  const calls = [];
  const clipboard = nativeClipboard({ platform: 'win32', runner: async (command, args, input) => {
    calls.push({ command, args, input });
    return input === undefined ? 'pasted text\r\n' : '';
  } });
  assert.equal(await clipboard.read(), 'pasted text');
  assert.deepEqual(await clipboard.write('private clipboard value'), { copied: true, bytes: 23 });
  assert.equal(calls[1].input, 'private clipboard value');
  assert.equal(calls[1].args.join(' ').includes('private clipboard value'), false);
  assert.equal(calls[0].args.at(-1), 'Get-Clipboard -Raw -Format Text');
});

test('Windows clipboard normalization removes only its transport newline', async () => {
  const clipboard = nativeClipboard({ platform: 'win32', runner: async () => 'first\r\nsecond\r\n\r\n' });
  assert.equal(await clipboard.read(), 'first\r\nsecond\r\n');
});

test('native clipboard image ingestion validates a bounded PNG', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-clipboard-image-'));
  const target = join(root, 'image.png');
  const clipboard = nativeClipboard({ platform: 'win32', imageRunner: async (path) => {
    await writeFile(path, Buffer.from('89504e470d0a1a0a00000000', 'hex'));
  } });
  assert.deepEqual(await clipboard.readImage(target, 1024), { path: target, mime_type: 'image/png', size: 12 });
});

test('empty or non-text clipboard paste fails visibly instead of doing nothing', async () => {
  const workspace = { options: { clipboardRead: async () => '' } };
  await assert.rejects(clipboardPasteAction(workspace), { code: 'clipboard_empty' });
});

test('TUI click and clipboard telemetry records metadata without clipboard content', async () => {
  const rows = [];
  const editor = { text: '', insert(value) { this.text += value; } };
  const projection = { overlay: null, active: () => ({ id: 'session-1', activeTurnId: null, editor }) };
  const workspace = {
    projection, options: { clipboardRead: async () => 'private clipboard text' },
    activeEngine: () => ({ telemetry: { record: (...args) => rows.push(args) } }),
  };
  recordTuiClick(workspace, { pressed: true, motion: false, button: 2, row: 4, column: 9 });
  await pasteClipboard(workspace, async () => undefined, (action, target) => target.insert(action.text), 'right_click');
  assert.equal(editor.text, 'private clipboard text');
  assert.deepEqual(rows.map(([name, status]) => [name, status]), [
    ['tui.mouse', 'observed'], ['tui.clipboard', 'started'], ['tui.clipboard', 'succeeded'],
  ]);
  assert.equal(JSON.stringify(rows).includes('private clipboard text'), false);
  assert.deepEqual(rows[2][2], {
    type: 'paste', source: 'right_click', target: 'conversation', bytes: 22, characters: 22, lines: 1,
  });
});

test('terminal selection extracts visible rows and decorates only the selected cells', () => {
  const projection = { visibleFrame: ['first row', 'second row'], terminalSelection: null };
  beginSelection(projection, { row: 1, column: 7 });
  projection.terminalSelection.focus = { row: 2, column: 7 };
  assert.equal(selectedText(projection), 'row\nsecond');
  const decorated = decorateSelection(['first row', 'second row'], projection.terminalSelection);
  assert.match(decorated[0], /\u001b\[7mrow/u);
  assert.match(decorated[1], /\u001b\[7msecond/u);
});

test('selection uses transcript coordinates and autoscrolls while held at a viewport edge', async () => {
  const projection = new TuiProjection();
  projection.addSession('main', 'Main', { model: 'm', provider: 'p' });
  projection.selectionDocumentLines = ['zero', 'one', 'two', 'three', 'four', 'five'];
  projection.selectionRowMap = new Map([[5, 4], [2, 1]]);
  projection.selectionContentBounds = { first: 2, last: 5 };
  projection.active().viewportLineCount = 100; projection.active().viewportEnd = 50;
  beginSelection(projection, { row: 5, column: 5 });
  const workspace = { projection, onChange() {} };
  await handleMouse({ motion: true, pressed: true, row: 2, column: 1 }, workspace);
  await new Promise((resolve) => setTimeout(resolve, 145));
  await handleMouse({ motion: false, pressed: false, row: 2, column: 1 }, workspace);
  assert.ok(projection.active().viewportEnd < 50);
  assert.match(selectedText(projection), /one\ntwo\nthree\nfour/u);
});

test('a completed transcript click cannot extend through a later tab click', async () => {
  const projection = new TuiProjection();
  projection.addSession('main', 'Main', { model: 'm', provider: 'p' });
  projection.addSession('other', 'Other', { model: 'm', provider: 'p' });
  projection.selectionRowMap = new Map([[5, 0]]);
  projection.selectionDocumentLines = ['transcript'];
  const workspace = { projection, onChange() {} };
  const headerTargetAt = (_projection, column) => (
    column === 10 ? { type: 'session', id: 'other' } : null
  );

  await handleMouse({ button: 0, pressed: true, row: 5, column: 4 }, workspace, headerTargetAt);
  await handleMouse({ button: 3, pressed: false, row: 5, column: 4 }, workspace, headerTargetAt);
  assert.equal(projection.terminalSelection.complete, true);

  await handleMouse({ button: 0, pressed: true, row: 1, column: 10 }, workspace, headerTargetAt);
  await handleMouse({ button: 3, pressed: false, row: 1, column: 10 }, workspace, headerTargetAt);
  assert.equal(projection.activeId, 'other');
  assert.equal(projection.terminalSelection, null);
});

test('/copy selects only an assistant response and reports metadata', async () => {
  let copied = null; let notice = null;
  const workspace = {
    activeEngine: () => ({ transcript: [
      { type: 'message', role: 'user', content: 'secret prompt' },
      { type: 'message', role: 'assistant', content: 'first response' },
      { type: 'tool_result', content: 'untrusted tool text' },
      { type: 'message', role: 'assistant', content: 'latest response' },
    ] }),
    options: { clipboard: async (value) => { copied = value; return { bytes: value.length }; } },
    projection: { showNotice: (kind, text) => { notice = { kind, text }; } }, onChange: () => undefined,
  };
  await handleCopyCommand('2', workspace);
  assert.equal(copied, 'first response');
  assert.deepEqual(notice, { kind: 'clipboard', text: 'Copied assistant response 2 (14 bytes).' });
});
