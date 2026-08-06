// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { TuiProjection } from '../src/tui-model.js';
import { handleSecretsCommand } from '../src/tui-secret-command.js';
import { beginSecretManagementSelection, handleSecretSetupAction } from '../src/tui-secret-setup.js';

function fixture() {
  const projection = new TuiProjection();
  projection.addSession('main', 'Main', {}, 'primary');
  const records = [];
  return {
    projection, records,
    listSecrets: async () => records.slice(),
    createSecret: async (input) => {
      const secret = { id: 'sec_1', realm: 'nna.local', label: input.label, kind: input.kind, fields: Object.keys(input.fields), enabled: true, createdAt: '', updatedAt: '', rotatedAt: null, lastUsedAt: null, useCount: 0 };
      records.push(secret); return secret;
    },
    rotateSecret: async () => records[0],
    setSecretEnabled: async (_id, enabled) => Object.assign(records[0], { enabled }),
    deleteSecret: async () => { records.splice(0); return true; },
  };
}

test('/secrets opens a write-only keyboard manager and begins a guided creation form', async () => {
  const workspace = fixture();
  await handleSecretsCommand('', workspace);
  assert.equal(workspace.projection.overlay.kind, 'secrets');
  assert.match(workspace.projection.overlay.lines.join('\n'), /never stored values/u);
  await beginSecretManagementSelection(workspace.projection.overlay.items[0], workspace, workspace.projection.overlay);
  assert.equal(workspace.projection.overlay.kind, 'secret-kind');
  await handleSecretSetupAction({ action: 'submit' }, workspace);
  assert.equal(workspace.projection.overlay.kind, 'secret-form');
  assert.match(workspace.projection.overlay.title, /Create secret/u);
});
