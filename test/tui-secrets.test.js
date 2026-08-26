// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { TuiProjection } from '../src/experience/projection.js';
import { handleSecretsCommand } from '../src/tui/secret-command.js';
import { beginSecretManagementSelection, handleSecretSetupAction } from '../src/tui/secret-setup.js';

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
    renameSecret: async (id, label) => Object.assign(records.find((record) => record.id === id), { label }),
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

test('secret detail renames only display metadata through the shared form', async () => {
  const workspace = fixture();
  await workspace.createSecret({ label: 'Original label', kind: 'token', fields: { token: 'private' } });
  await handleSecretsCommand('', workspace);
  await beginSecretManagementSelection(workspace.projection.overlay.items[0], workspace, workspace.projection.overlay);
  assert.equal(workspace.projection.overlay.items[0].id, 'rename');
  await handleSecretSetupAction({ action: 'submit' }, workspace);
  assert.match(workspace.projection.overlay.title, /Rename secret/u);
  workspace.projection.overlay.editor.set('Reusable credential');
  await handleSecretSetupAction({ action: 'submit' }, workspace);
  assert.equal(workspace.records[0].id, 'sec_1');
  assert.equal(workspace.records[0].label, 'Reusable credential');
});

test('secret creation form accepts keyboard input through the shared form engine', async () => {
  const workspace = fixture();
  await handleSecretsCommand('', workspace);
  await beginSecretManagementSelection(workspace.projection.overlay.items[0], workspace, workspace.projection.overlay);
  await handleSecretSetupAction({ action: 'submit' }, workspace);
  for (const character of 'Production API') {
    await handleSecretSetupAction({ action: 'insert', text: character }, workspace);
  }
  assert.match(workspace.projection.overlay.lines.join('\n'), /Production API/u);
  await handleSecretSetupAction({ action: 'submit' }, workspace);
  await handleSecretSetupAction({ action: 'paste', text: 'key-secret-value' }, workspace);
  assert.doesNotMatch(workspace.projection.overlay.lines.join('\n'), /key-secret-value/u);
  assert.match(workspace.projection.overlay.lines.join('\n'), /16 characters entered/u);
  await handleSecretSetupAction({ action: 'submit' }, workspace);
  assert.equal(workspace.records[0].label, 'Production API');
  assert.deepEqual(workspace.records[0].fields, ['api_key']);
});
