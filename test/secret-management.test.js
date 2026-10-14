// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteUnreferencedSecret, secretReferences } from '../src/secret-management.js';

const config = {
  providerProfiles: {
    p1: { id: 'p1', displayName: 'Alpha', credential: { source: 'secret', secretId: 'sec_one' } },
    p2: { id: 'p2', displayName: 'Beta', credential: { source: 'plaintext', secretId: 'sec_one' } },
  },
  mcpServers: [
    { id: 'm1', credential: { source: 'secret', secretId: 'sec_one' } },
    { id: 'm2', headerCredentials: { authorization: { source: 'secret', secretId: 'sec_two' }, 'x-other': { source: 'plaintext', secretId: 'sec_one' } } },
  ],
};

test('secretReferences derives bindings from provider credentials, MCP credentials, and header credentials', () => {
  assert.deepEqual(secretReferences(config, 'sec_one'), [
    { kind: 'provider', id: 'p1', label: 'Provider Alpha' },
    { kind: 'mcp', id: 'm1', label: 'MCP m1' },
  ]);
  assert.deepEqual(secretReferences(config, 'sec_two'), [{ kind: 'mcp', id: 'm2', label: 'MCP m2 header authorization' }]);
  // Unbound ids and absent config sections scan to an empty reference set.
  assert.deepEqual(secretReferences(config, 'sec_missing'), []);
  assert.deepEqual(secretReferences({}, 'sec_one'), []);
  assert.deepEqual(secretReferences({ providerProfiles: {}, mcpServers: [] }, 'sec_one'), []);
});

test('deleteUnreferencedSecret refuses with secret_in_use when the derived scan is non-empty and deletes when it is empty', () => {
  const removed = [];
  const broker = { remove: (id) => { removed.push(id); return true; } };
  // Why: deleteUnreferencedSecret is synchronous — it throws (assert.throws),
  // it does not reject; the derived scan runs before any broker call.
  assert.throws(() => deleteUnreferencedSecret(broker, config, 'sec_one'), (error) => {
    assert.equal(error.code, 'secret_in_use');
    assert.match(error.message, /Provider Alpha/u);
    assert.match(error.message, /MCP m1/u);
    return true;
  });
  assert.deepEqual(removed, []);
  deleteUnreferencedSecret(broker, config, 'sec_two'.replace('two', 'missing'));
  assert.deepEqual(removed, ['sec_missing']);
});
