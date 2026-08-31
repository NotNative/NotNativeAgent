// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { TuiProjection } from '../src/experience/projection.js';
import { overlayCommandDraft, webFetchOverlay } from '../src/tui/overlays.js';
import {
  beginWebFetchManagementSelection, handleWebFetchSetupAction,
} from '../src/tui/webfetch-setup.js';

function fixture() {
  const projection = new TuiProjection();
  projection.addSession('main', 'Main', {}, 'primary');
  let origins = [];
  return {
    projection,
    webFetchCommand: async ([action, origin]) => {
      if (action === 'status') return { config: { version: 1, trusted_origins: origins } };
      if (!/^https?:\/\/[^/]+$/u.test(origin)) throw new Error('Exact credential-free HTTP(S) origin required.');
      origins = action === 'trust' ? [...new Set([...origins, origin])].sort()
        : origins.filter((item) => item !== origin);
      return { config: { version: 1, trusted_origins: origins } };
    },
  };
}

test('/webfetch menu opens a contained form and retains invalid input', async () => {
  const workspace = fixture();
  workspace.projection.openOverlay(webFetchOverlay((await workspace.webFetchCommand(['status'])).config));
  const trust = workspace.projection.overlay.items.find((item) => item.id === 'action:trust');
  assert.equal(beginWebFetchManagementSelection(trust, workspace, workspace.projection.overlay), true);
  assert.equal(workspace.projection.overlay.kind, 'webfetch-form');
  assert.match(workspace.projection.overlay.lines.join('\n'), /scheme, host, and optional port/iu);

  workspace.projection.overlay.editor.set('http://jill:8080/path');
  await handleWebFetchSetupAction({ action: 'submit' }, workspace);
  assert.equal(workspace.projection.overlay.kind, 'webfetch-form');
  assert.equal(workspace.projection.overlay.editor.text, 'http://jill:8080/path');
  assert.match(workspace.projection.overlay.lines.join('\n'), /Cannot continue · Exact credential-free/iu);
  assert.equal(overlayCommandDraft('webfetch', 'action:trust'), null);
});

test('/webfetch menu shows progress and returns to the manager after trust completes', async () => {
  const workspace = fixture();
  let complete;
  const run = workspace.webFetchCommand;
  workspace.webFetchCommand = ([action, origin]) => action === 'trust' ? new Promise((resolve) => {
    complete = async () => resolve(await run([action, origin]));
  }) : run([action, origin]);
  workspace.projection.openOverlay({
    ...webFetchOverlay((await workspace.webFetchCommand(['status'])).config),
    parent: 'config', configSection: 'webfetch',
  });
  const trust = workspace.projection.overlay.items.find((item) => item.id === 'action:trust');
  beginWebFetchManagementSelection(trust, workspace, workspace.projection.overlay);
  workspace.projection.overlay.editor.set('http://jill:8080');
  const pending = handleWebFetchSetupAction({ action: 'submit' }, workspace);
  assert.equal(workspace.projection.overlay.kind, 'webfetch-progress');
  complete();
  await pending;
  assert.equal(workspace.projection.overlay.kind, 'webfetch');
  assert.equal(workspace.projection.overlay.parent, 'config');
  assert.match(workspace.projection.overlay.lines.join('\n'), /Trusted http:\/\/jill:8080/iu);
  assert.ok(workspace.projection.overlay.items.some((item) => item.id === 'http://jill:8080'));
});

test('/webfetch selecting a trusted origin opens a prefilled revoke flow', async () => {
  const workspace = fixture();
  await workspace.webFetchCommand(['trust', 'http://jill:8080']);
  workspace.projection.openOverlay(webFetchOverlay((await workspace.webFetchCommand(['status'])).config));
  const origin = workspace.projection.overlay.items.find((item) => item.id === 'http://jill:8080');
  assert.equal(beginWebFetchManagementSelection(origin, workspace, workspace.projection.overlay), true);
  assert.equal(workspace.projection.overlay.editor.text, 'http://jill:8080');
  assert.match(workspace.projection.overlay.title, /Revoke/iu);
  await handleWebFetchSetupAction({ action: 'submit' }, workspace);
  assert.equal(workspace.projection.overlay.kind, 'webfetch');
  assert.equal(workspace.projection.overlay.items.some((item) => item.id === 'http://jill:8080'), false);
});
