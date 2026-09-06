// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { TuiProjection } from '../src/experience/projection.js';
import { webSearchOverlay } from '../src/tui/websearch-overlay.js';
import {
  beginWebSearchManagementSelection, handleWebSearchSetupAction,
} from '../src/tui/websearch-setup.js';

function fixture() {
  const projection = new TuiProjection();
  projection.addSession('main', 'Main', {}, 'primary');
  let config = { enabled: false, version: 2, profiles: [] };
  return {
    projection,
    webSearchStatus: async () => ({ config, test: null }),
    configureWebSearch: async (endpoint) => {
      if (endpoint.includes('invalid')) throw new Error('SearXNG validation request failed.');
      config = { enabled: true, version: 2, profiles: [
        { id: 'primary', display_name: 'Primary SearXNG', provider: 'searxng', endpoint, managed: false },
      ] };
      return { config, test: { ok: true, results: 1 } };
    },
    addWebSearchProfile: async (displayName, endpoint) => {
      config = { enabled: true, version: 2, profiles: [...config.profiles,
        { id: 'backup', display_name: displayName, provider: 'searxng', endpoint, managed: false }] };
      return { config, test: { ok: true, results: 1, profile_id: 'backup' } };
    },
    deleteWebSearchProfile: async (profileId) => {
      config = { ...config, profiles: config.profiles.filter((item) => item.id !== profileId) };
      config.enabled = config.profiles.length > 0;
      return { config, test: null, removed_profile_id: profileId };
    },
  };
}

test('/websearch configure opens a guided endpoint form and retains failed input', async () => {
  const workspace = fixture();
  workspace.projection.openOverlay(webSearchOverlay(await workspace.webSearchStatus(false)));
  const configure = workspace.projection.overlay.items.find((item) => item.id === 'action:configure');
  assert.equal(await beginWebSearchManagementSelection(configure, workspace, workspace.projection.overlay), true);
  assert.equal(workspace.projection.overlay.kind, 'websearch-form');
  assert.match(workspace.projection.overlay.lines.join('\n'), /Enter a base URL[^]*bounded JSON search[^]*Example: http:\/\/192\.168\.1\.50:8080/u);

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
      config: { enabled: true, version: 2, profiles: [
        { id: 'primary', display_name: 'Primary SearXNG', provider: 'searxng', endpoint, managed: false },
      ] },
      test: { ok: true, results: 1 },
    });
    workspace.webSearchStatus = async () => ({
      config: { enabled: true, version: 2, profiles: [
        { id: 'primary', display_name: 'Primary SearXNG', provider: 'searxng', endpoint, managed: false },
      ] }, test: null,
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
  assert.match(workspace.projection.overlay.lines.join('\n'), /Primary SearXNG validated and saved at https:\/\/search\.example\.test/u);
});

test('/websearch adds a named fallback through a two-step validated form', async () => {
  const workspace = fixture();
  await workspace.configureWebSearch('https://primary.example');
  workspace.projection.openOverlay(webSearchOverlay(await workspace.webSearchStatus(false)));
  const add = workspace.projection.overlay.items.find((item) => item.id === 'action:add');
  await beginWebSearchManagementSelection(add, workspace, workspace.projection.overlay);
  assert.match(workspace.projection.overlay.lines[0], /Step 1 of 2 · Profile name/u);
  workspace.projection.overlay.editor.set('Community backup');
  await handleWebSearchSetupAction({ action: 'submit' }, workspace);
  assert.match(workspace.projection.overlay.lines[0], /Step 2 of 2 · SearXNG endpoint URL/u);
  workspace.projection.overlay.editor.set('https://public.example');
  await handleWebSearchSetupAction({ action: 'submit' }, workspace);
  assert.equal(workspace.projection.overlay.kind, 'websearch');
  assert.match(workspace.projection.overlay.lines.join('\n'), /Fallback 1 Community backup · https:\/\/public\.example/u);
});

test('/websearch requires explicit confirmation before removing a profile', async () => {
  const workspace = fixture();
  await workspace.configureWebSearch('https://primary.example');
  await workspace.addWebSearchProfile('Backup', 'https://backup.example');
  workspace.projection.openOverlay(webSearchOverlay(await workspace.webSearchStatus(false)));
  const remove = workspace.projection.overlay.items.find((item) => item.id === 'remove-profile:backup');
  assert.equal(await beginWebSearchManagementSelection(remove, workspace, workspace.projection.overlay), true);
  assert.equal(workspace.projection.overlay.kind, 'websearch-remove-confirm');
  assert.equal(workspace.projection.overlay.items[workspace.projection.overlay.selected].id, 'cancel');
  workspace.projection.moveOverlaySelection(1);
  await handleWebSearchSetupAction({ action: 'submit' }, workspace);
  assert.equal(workspace.projection.overlay.kind, 'websearch');
  assert.equal((await workspace.webSearchStatus(false)).config.profiles.length, 1);
});
