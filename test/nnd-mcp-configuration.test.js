// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createNndConfigurationService } from '../src/nnd-configuration-service.js';

const identity = { installation_id: 'install_mcp', data_id: 'data_mcp', scope: 'user' };
const owner = { subjectId: 'operator', permissions: ['nnd.configuration.read', 'nnd.configuration.manage'] };
const server = { id: 'existing', transport: 'stdio', command: 'hidden-command', args: ['private-arg'],
  credential: { source: 'environment', name: 'PRIVATE_TOKEN_REF' }, enabled: false, trusted: false };
const withoutOperation = ({ operation_id, ...request }) => request;
async function fixture(t) {
  const root = await mkdtemp(join(homedir(), '.nna-native-mcp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = { config: join(root, 'config'), trustedWorkspaces: join(root, 'trust.json') };
  await mkdir(paths.config); await mkdir(join(root, '.nna'));
  const path = join(paths.config, 'manifest.json');
  const document = { workspace_root: root, provider: { id: 'local', endpoint: 'http://127.0.0.1:9/v1', model: 'base', trust_zone: 'loopback' },
    mcp_servers: [server] };
  await writeFile(path, JSON.stringify(document));
  const make = () => createNndConfigurationService({ paths, installationId: identity.installation_id, dataId: identity.data_id });
  const service = make();
  const request = async (change, operation_id = 'mcp_change_1') => {
    const view = await service.mcpRead(owner);
    return { ...identity, expected_revision: view.source_revision, expected_resolution_revision: view.resolution_revision,
      change, operation_id };
  };
  return { root, paths, path, document, service, make, request };
}

test('preview is read-only and patch preserves credential, command and args without projecting them', async t => {
  const f = await fixture(t), before = await readFile(f.path);
  const input = await f.request({ op: 'patch', id: 'existing', fields: { enabled: true, timeout_ms: 1500 } });
  const preview = await f.service.mcpPreview(owner, withoutOperation(input));
  assert.equal(preview.view.servers[0].enabled, true);
  assert.equal(preview.application, 'not_applied');
  assert.equal(JSON.stringify(preview).includes('hidden-command'), false);
  assert.equal(JSON.stringify(preview).includes('PRIVATE_TOKEN_REF'), false);
  assert.deepEqual(await readFile(f.path), before);
  const saved = await f.service.mcpSave(owner, input);
  assert.equal(saved.persistence, 'saved'); assert.equal(saved.application, 'not_applied');
  const after = JSON.parse(await readFile(f.path, 'utf8'));
  assert.deepEqual(after.mcp_servers[0], { ...server, enabled: true, timeout_ms: 1500 });
  assert.equal((await f.make().mcpSave(owner, input)).replayed, true);
  assert.equal((await f.service.mcpOperation(owner, input.operation_id)).persisted_revision, saved.persisted_revision);
  assert.equal(await f.service.mcpOperation({ ...owner, subjectId: 'other' }, input.operation_id), null);
  await assert.rejects(f.service.mcpSave(owner, { ...input, change: { op: 'delete', id: 'existing' } }),
    { code: 'manifest_operation_conflict' });
});

test('typed create defaults disabled and delete removes only selected ID', async t => {
  const f = await fixture(t);
  const create = await f.request({ op: 'create', id: 'remote', fields: { transport: 'streamable_http', endpoint: 'https://mcp.example/v1' } }, 'create');
  await f.service.mcpSave(owner, create);
  let entries = JSON.parse(await readFile(f.path, 'utf8')).mcp_servers;
  assert.deepEqual(entries[1], { id: 'remote', transport: 'streamable_http', endpoint: 'https://mcp.example/v1', enabled: false, trusted: false });
  const remove = await f.request({ op: 'delete', id: 'remote' }, 'delete');
  await f.service.mcpSave(owner, remove);
  entries = JSON.parse(await readFile(f.path, 'utf8')).mcp_servers;
  assert.deepEqual(entries, [server]);
});

test('rejects raw credentials, OAuth, header values, unsafe endpoints and transport-confused fields', async t => {
  const f = await fixture(t), before = await readFile(f.path);
  const bad = [
    { op: 'patch', id: 'existing', fields: { credential: { token: 'SECRET' } } },
    { op: 'patch', id: 'existing', fields: { trusted: true } },
    { op: 'patch', id: 'existing', fields: { header_env: { Authorization: 'TOKEN' } } },
    { op: 'create', id: 'bad1', fields: { transport: 'streamable_http', endpoint: 'https://user:password@example.com' } },
    { op: 'create', id: 'bad2', fields: { transport: 'stdio', command: 'run', endpoint: 'https://example.com' } },
    { op: 'create', id: 'bad3', fields: { transport: 'stdio', command: 'run', oauth: { token: 'SECRET' } } },
  ];
  for (const change of bad) await assert.rejects(f.service.mcpSave(owner, await f.request(change, 'bad')), { code: 'nnd_mcp_request_invalid' });
  assert.deepEqual(await readFile(f.path), before);
});

test('permission, identity, source and resolution revisions fail closed', async t => {
  const f = await fixture(t), change = { op: 'patch', id: 'existing', fields: { enabled: true } };
  const input = await f.request(change, 'stale');
  await assert.rejects(f.service.mcpRead({ ...owner, permissions: [] }), { code: 'integration_permission_denied' });
  await assert.rejects(f.service.mcpPreview({ ...owner, permissions: ['nnd.configuration.read'] }, input), { code: 'integration_permission_denied' });
  await assert.rejects(f.service.mcpSave({ ...owner, permissions: ['nnd.configuration.read'] }, input), { code: 'integration_permission_denied' });
  await assert.rejects(f.service.mcpSave(owner, { ...input, installation_id: 'wrong' }), { code: 'nnd_mcp_request_invalid' });
  await writeFile(f.path, JSON.stringify({ ...f.document, memory: { enabled: false } }));
  await assert.rejects(f.service.mcpSave(owner, input), { code: 'manifest_revision_conflict' });
  const overlay = await f.request(change, 'overlay');
  await writeFile(f.paths.trustedWorkspaces, JSON.stringify({ version: 1,
    workspaces: [{ root: await realpath(f.root), trustedAt: '2026-10-03T00:00:00.000Z' }] }));
  await writeFile(join(f.root, '.nna', 'settings.json'), JSON.stringify({ memory: { enabled: false } }));
  await assert.rejects(f.service.mcpSave(owner, overlay), { code: 'nnd_configuration_resolution_conflict' });
  const project = await f.request(change, 'shadow');
  await writeFile(join(f.root, '.nna', 'settings.json'), JSON.stringify({ mcp_servers: [] }));
  const shadow = await f.request(change, 'shadow2');
  await assert.rejects(f.service.mcpPreview(owner, withoutOperation(shadow)), { code: 'configuration_source_shadowed' });
  await assert.rejects(f.service.mcpSave(owner, shadow), { code: 'configuration_source_shadowed' });
  await assert.rejects(f.service.mcpSave(owner, project), { code: 'nnd_configuration_resolution_conflict' });
});
