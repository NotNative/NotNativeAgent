// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserTool } from '../src/browser-tool-selection.js';

const base = { browserRoot: 'C:/data/runtime/browser/s1', sessionId: 's1', hosted: false,
  hostedTransport: null, hostedContext: null, desktopCallback: null };
const desktopCallback = { url: 'http://127.0.0.1:4172/api/browser-control/request', token: 't'.repeat(43) };
const transport = { name: 'openchamber-pane', async send() { return {}; } };
const playwright = { manager: 'm', root: 'C:/data/runtime/browser/s1', paths: 'p' };

/** Installs and reports the one tool chosen. */
function choose(options) {
  const installed = [];
  const kind = installBrowserTool({ ...base, ...options, install: (definition) => installed.push(definition.name) });
  return { kind, installed };
}

test('a hosted pane is the browser, and NNA installs no second one beside it', () => {
  // Why this is the whole point: offering Playwright next to the pane let the model
  // reach for the headless browser it knows instead of the window on screen.
  const chosen = choose({ surface: 'playwright', hostedTransport: transport, playwright });
  assert.equal(chosen.kind, 'hosted');
  assert.deepEqual(chosen.installed, ['desktop_browser']);
});

test('with no pane, the managed browser is installed — the TUI case', () => {
  const chosen = choose({ surface: 'playwright', playwright });
  assert.equal(chosen.kind, 'playwright');
  assert.deepEqual(chosen.installed, ['web_browse']);
});

test('a desktop host drives its own browser and gets no Playwright', () => {
  const chosen = choose({ surface: 'desktop', desktopCallback, playwright });
  assert.equal(chosen.kind, 'desktop');
  assert.deepEqual(chosen.installed, ['desktop_browser']);
});

test('a hosted conversation with no pane gets no browser at all', () => {
  // Security: the surface chose not to offer one, so a local browser is not a fallback.
  const chosen = choose({ surface: 'playwright', hosted: true, playwright });
  assert.equal(chosen.kind, null);
  assert.deepEqual(chosen.installed, []);
});

test('no surface and no browser capability installs nothing', () => {
  const chosen = choose({ surface: 'playwright' });
  assert.equal(chosen.kind, null);
  assert.deepEqual(chosen.installed, []);
});

test('exactly one browser tool is ever installed', () => {
  const surfaces = [
    { surface: 'playwright', hostedTransport: transport, playwright, desktopCallback },
    { surface: 'playwright', playwright, desktopCallback },
    { surface: 'desktop', desktopCallback, playwright },
    { surface: 'playwright', hosted: true, playwright },
    { surface: 'desktop' },
  ];
  for (const options of surfaces) {
    const { installed } = choose(options);
    assert.ok(installed.length <= 1, `installed ${installed.join(', ')} for ${JSON.stringify(options)}`);
  }
});
