// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorBuffer } from '../src/experience/projection.js';
import { handleCommandPickerAction, commandPickerLines } from '../src/tui/command-picker.js';
import { handleEditorAction } from '../src/tui/editor-actions.js';
import { handleMcpCommand } from '../src/tui/mcp-command.js';
import { permissionControlLine, permissionLines } from '../src/tui/permission-renderer.js';
import { createMenuOverlay, createConfirmationOverlay } from '../src/tui/surface-engine.js';
import { workSummaryRows } from '../src/tui/work-summary.js';
import { osc52Clipboard } from '../src/tui/terminal-clipboard.js';
import { clipboardPasteAction } from '../src/tui/clipboard-actions.js';
import { handleCopyCommand } from '../src/tui/copy-command.js';
import { handleProviderCommand, handleModelCommand } from '../src/tui/provider-command.js';
import { handleProviderSetupAction } from '../src/tui/provider-setup.js';
import { selectedText, decorateSelection, plainTerminalLine } from '../src/tui/selection.js';
import { wrapTerminalLine, displayWidth } from '../src/tui/terminal-markdown.js';
import { RetainedTerminalScreen } from '../src/tui/terminal-screen.js';
import { applyConversationSpacing } from '../src/tui/conversation-spacing.js';
import { handleFormEditing } from '../src/tui/form-engine.js';
import { createTuiWorkspace } from '../src/tui/runtime-workspace.js';
import { resolveManifest } from '../src/config.js';
import { registerFatalTuiCleanup } from '../src/tui/fatal-cleanup.js';
import { handleWebFetchCommand } from '../src/tui/webfetch-command.js';

test('command picker leaves argument editing to the editor', () => {
  const editor = new EditorBuffer(); editor.set('/provider add myid gpt-4');
  for (const action of ['history_up', 'history_down', 'complete_command']) {
    assert.equal(handleCommandPickerAction({ action }, { editor }), false);
    assert.equal(editor.text, '/provider add myid gpt-4');
  }
});

test('command picker refreshes stale cached suggestions after an external edit', () => {
  const editor = new EditorBuffer(); editor.set('/'); const session = { editor };
  handleCommandPickerAction({ action: 'history_down' }, session);
  editor.set('/copy');
  const lines = commandPickerLines(session, { bindings: {} }, 10);
  assert.ok(lines.length > 0);
  assert.ok(lines.every((line) => line.includes('/copy')));
});

test('malformed text actions do not change the editor', () => {
  for (const text of [undefined, null, {}, 4]) {
    const editor = new EditorBuffer(); editor.set('kept');
    for (const action of ['insert', 'paste']) assert.equal(handleEditorAction({ action, text }, editor), false);
    assert.equal(editor.text, 'kept'); assert.equal(editor.cursor, 4);
  }
});

test('single-line form input rejects malformed text before normalization', () => {
  const editor = new EditorBuffer(); editor.set('kept');
  assert.equal(handleFormEditing({ action: 'insert' }, editor), false);
  assert.equal(editor.text, 'kept');
});

test('MCP prompt JSON preserves internal whitespace exactly', async () => {
  let received;
  const workspace = { activeEngine: () => ({ mcp: { getPrompt: async (...args) => { received = args; return {}; } } }),
    projection: { openOverlay() {} } };
  await handleMcpCommand('prompt server name  {"q":"a   b", "t":"\\t"}', workspace);
  assert.deepEqual(received, ['server', 'name', { q: 'a   b', t: '\t' }]);
});

test('permission rendering makes absent and unsupported data explicit without inventing choices', () => {
  assert.match(permissionControlLine({ choices: [] }, {}), /unavailable/iu);
  assert.match(permissionControlLine({ choices: ['constructor'] }, {}), /unsupported/iu);
  const lines = permissionLines({ expires_at: null }, 120, {}).join('\n');
  assert.doesNotMatch(lines, /undefined|1970/u);
  assert.match(lines, /APPROVAL REQUIRED: not provided/u);
  assert.doesNotThrow(() => permissionLines(null, 120, {}));
});

test('menu selection remains within retained items and invalid shapes fail explicitly', () => {
  const items = Array.from({ length: 300 }, (_, id) => ({ id: String(id), label: String(id) }));
  const menu = createMenuOverlay('test', 'Test', [], items, { activeId: '299' });
  assert.ok(menu.selected >= 0 && menu.selected < menu.items.length);
  for (const [lines, entries, options] of [[null, [], {}], [[], null, {}], [[], [null], {}], [[], [], null]]) {
    assert.throws(() => createMenuOverlay('test', 'Test', lines, entries, options), { code: 'tui_surface_invalid' });
  }
});

test('confirmation cannot silently select a destructive action for an absent safe id', () => {
  for (const options of [{}, { safeId: 'missing' }]) {
    assert.throws(() => createConfirmationOverlay('confirm', 'Confirm', [], [{ id: 'delete' }], options),
      { code: 'tui_surface_invalid' });
  }
});

test('legacy missing goal status renders unknown without crashing', () => {
  for (const collapsed of [false, true]) {
    const rows = workSummaryRows({ goal: { objective: 'Keep working' }, tasks: [] }, 100, 30, collapsed);
    assert.match(rows[0].text, /UNKNOWN/u);
  }
});

test('OSC52 rejects nontext before any output and still supports literal text', async () => {
  const writes = []; const copy = osc52Clipboard({ isTTY: true, write: (value) => writes.push(value) });
  for (const value of [null, undefined, {}, 42, Symbol('s')]) {
    await assert.rejects(copy(value), { code: 'clipboard_content_invalid' });
  }
  assert.equal(writes.length, 0);
  assert.equal((await copy('literal')).bytes, 7);
});

test('empty clipboard does not repeat image fallback or attach behind an overlay', async () => {
  for (const overlay of [null, { kind: 'dialog' }]) {
    let configCalls = 0;
    const workspace = { options: { clipboardRead: async () => '', clipboardImageRead() {} },
      projection: { overlay, active: () => ({ pendingAttachments: [] }) },
      activeConfig: () => { configCalls += 1; return { attachments: { enabled: false } }; } };
    await assert.rejects(clipboardPasteAction(workspace), { code: 'clipboard_empty' });
    assert.equal(configCalls, overlay ? 0 : 1);
  }
});

test('copy tolerates adapters without a receipt and preserves failure for outer handling', async () => {
  let notice;
  const workspace = { options: { clipboard: async () => undefined }, onChange() {},
    activeEngine: () => ({ transcript: [{ type: 'message', role: 'assistant', content: 'abc' }] }),
    projection: { showNotice: (...args) => { notice = args; } } };
  await handleCopyCommand('', workspace);
  assert.match(notice[1], /3 bytes/u);
  const failure = new Error('offline'); workspace.options.clipboard = async () => { throw failure; };
  await assert.rejects(handleCopyCommand('', workspace), (error) => error === failure);
});

test('provider and model menus classify a vanished active session', async () => {
  const workspace = { projection: { active: () => null, openOverlay() {} }, availableModels: async () => [],
    activeConfig: () => ({ routes: { primary: {} } }) };
  for (const handler of [handleProviderCommand, handleModelCommand]) {
    await assert.rejects(handler('', workspace, {}), { code: 'provider_session_missing' });
  }
});

test('provider credential forms set their mode and ordinary typing never saves', async () => {
  for (const id of ['environment', 'new']) {
    const workspace = { projection: { overlay: { kind: 'provider-auth-select', selected: 0, items: [{ id }],
      formState: { operation: 'add', draft: { displayName: 'Local' } } },
    openOverlay(value) { this.overlay = value; } }, editProvider() { assert.fail('typing must not save'); } };
    await handleProviderSetupAction({ action: 'submit' }, workspace);
    assert.equal(workspace.projection.overlay.form.mode, 'credential');
    await handleProviderSetupAction({ action: 'insert', text: 'x' }, workspace);
    assert.equal(workspace.projection.overlay.editor.text, 'x');
  }
});

test('selection copies visible characters without CSI or OSC controls', () => {
  const selection = { anchor: { row: 1, column: 2 }, focus: { row: 1, column: 4 } };
  for (const value of ['\u001b[31mabcd\u001b[0m', '\u001b]8;;https://example.invalid\u0007abcd\u001b]8;;\u0007']) {
    assert.equal(selectedText({ visibleFrame: [value], terminalSelection: selection }), 'bc');
    const decorated = decorateSelection([value], selection)[0];
    assert.equal(plainTerminalLine(decorated), 'abcd');
    assert.match(decorated, /\u001b\[7mbc\u001b\[0m/u);
  }
});

test('narrow markdown never overflows even with wide glyphs and oversized prefixes', () => {
  for (const [value, width, prefix] of [['abc', 2, 'long:'], ['界x', 1, ''], ['', 1, '界'], ['界x', 2, '>']]) {
    const rows = wrapTerminalLine(value, width, prefix);
    assert.ok(rows.every((row) => displayWidth(row) <= width));
  }
});

test('screen invalidation clears unknown stale rows before repaint', () => {
  const writes = []; const screen = new RetainedTerminalScreen({ write: (value) => writes.push(value) });
  screen.paint('a\nb\nc'); screen.invalidate(); screen.paint('x');
  assert.match(writes.at(-1), /\u001b\[H\u001b\[J/u);
});

test('new user blocks are separated after prior nonstream records', () => {
  for (const prior of ['user_input', 'activity', 'turn_result']) {
    const lines = ['prior']; applyConversationSpacing(lines, 'user_input', prior, prior);
    assert.deepEqual(lines, ['prior', '']);
  }
});

test('write-only clipboard adapters do not advertise read capabilities', async () => {
  const config = resolveManifest({ persistence: 'ephemeral', workspace_root: process.cwd(),
    provider: { endpoint: 'http://127.0.0.1:9/v1', model: 'fixture', trust_zone: 'loopback' } });
  const { workspace } = await createTuiWorkspace({ config, logger: {}, updateCheck: false,
    systemClipboard: { write() {} } }, {}, () => {});
  assert.equal(workspace.options.clipboardRead, undefined);
  assert.equal(workspace.options.clipboardImageRead, undefined);
  workspace.projection.dispose();
});

test('fatal cleanup flushes shutdown records after shutdown settles', async () => {
  let cleanup, release; const calls = [];
  const pending = new Promise((resolve) => { release = resolve; });
  registerFatalTuiCleanup({ registerCleanup(fn) { cleanup = fn; } },
    { restore() { calls.push('restore'); } },
    { async shutdown() { calls.push('shutdown'); await pending; calls.push('shutdown-record'); } },
    { flush() { calls.push('flush'); } });
  const done = cleanup(); await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['restore', 'shutdown']);
  release(); await done;
  assert.deepEqual(calls, ['restore', 'shutdown', 'shutdown-record', 'flush']);
});

test('fatal cleanup reports logging failure without depending on the failed logger', async () => {
  let cleanup; const diagnostics = [];
  registerFatalTuiCleanup({ registerCleanup(fn) { cleanup = fn; } }, {}, {},
    { flush() { throw new Error('sensitive detail'); }, record() { throw new Error('unavailable'); } },
    { write(value) { diagnostics.push(value); } });
  await cleanup();
  assert.match(diagnostics.join(''), /fatal cleanup.*flush/iu);
  assert.doesNotMatch(diagnostics.join(''), /sensitive detail/u);
});

test('WebFetch revoke reports the resulting origin state, not an unspecified update', async () => {
  let overlay;
  await handleWebFetchCommand('revoke http://localhost:8080', {
    webFetchCommand: async () => ({ config: { trusted_origins: [] } }),
    projection: { openOverlay(value) { overlay = value; } },
  });
  assert.match(JSON.stringify(overlay), /Not trusted: http:\/\/localhost:8080/u);
});
