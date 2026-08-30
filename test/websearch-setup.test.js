// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { TuiProjection } from '../src/experience/projection.js';
import { webSearchOverlay } from '../src/tui/overlays.js';
import {
  beginWebSearchManagementSelection, handleWebSearchSetupAction,
} from '../src/tui/websearch-setup.js';

function fixture() {
  const projection = new TuiProjection();
  projection.addSession('main', 'Main', {}, 'primary');
  let config = { enabled: false, provider: 'searxng', endpoint: null, managed: false };
  return {
    projection,
    webSearchStatus: async () => ({ config, test: null }),
    configureWebSearch: async (endpoint) => {
      if (endpoint.includes('invalid')) throw new Error('SearXNG validation request failed.');
      config = { enabled: true, provider: 'searxng', endpoint, managed: false };
      return { config, test: { ok: true, results: 1 } };
    },
  };
}

test('/websearch configure opens a guided endpoint form and retains failed input', async () => {
  const workspace = fixture();
  workspace.projection.openOverlay(webSearchOverlay(await workspace.webSearchStatus(false)));
  const configure = workspace.projection.overlay.items.find((item) => item.id === 'action:configure');
  assert.equal(await beginWebSearchManagementSelection(configure, workspace, workspace.projection.overlay), true);
  assert.equal(workspace.projection.overlay.kind, 'websearch-form');
  assert.match(workspace.projection.overlay.lines.join('\n'), /Enter the base URL[^]*validate it before saving[^]*Example: http:\/\/192\.168\.1\.50:8080/u);

  workspace.projection.overlay.editor.set('https://invalid.example');
  await handleWebSearchSetupAction({ action: 'submit' }, workspace);
  assert.equal(workspace.projection.overlay.kind, 'websearch-form');
  assert.equal(workspace.projection.overlay.editor.text, 'https://invalid.example');
  assert.match(workspace.projection.overlay.lines.join('\n'), /Cannot continue · SearXNG validation request failed/u);
  assert.equal((await workspace.webSearchStatus(false)).config.enabled, false);
});

test('/websearch configure shows validation progress and returns to the menu on success', async () => {
  const workspace = fixture();
  let completeValidation;
  workspace.configureWebSearch = (endpoint) => new Promise((resolve) => {
    completeValidation = () => resolve({
      config: { enabled: true, provider: 'searxng', endpoint, managed: false },
      test: { ok: true, results: 1 },
    });
    workspace.webSearchStatus = async () => ({
      config: { enabled: true, provider: 'searxng', endpoint, managed: false }, test: null,
    });
  });
  workspace.projection.openOverlay(webSearchOverlay(await workspace.webSearchStatus(false)));
  await beginWebSearchManagementSelection(workspace.projection.overlay.items[0], workspace, workspace.projection.overlay);
  workspace.projection.overlay.editor.set('https://search.example.test');
  const pending = handleWebSearchSetupAction({ action: 'submit' }, workspace);
  assert.equal(workspace.projection.overlay.kind, 'websearch-progress');
  assert.match(workspace.projection.overlay.lines.join('\n'), /Running a bounded SearXNG JSON search/u);
  completeValidation();
  await pending;
  assert.equal(workspace.projection.overlay.kind, 'websearch');
  assert.match(workspace.projection.overlay.lines.join('\n'), /Endpoint validated and WebSearch enabled at https:\/\/search\.example\.test/u);
});
