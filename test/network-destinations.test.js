// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveManifest } from '../src/config.js';
import { inspectNetworkDestinations } from '../src/network-destinations.js';
import { saveWebSearchConfig } from '../src/web-search-config.js';

test('AC-PRIV-01 every configured and dynamic egress surface exposes destination and purpose', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-destinations-'));
  const webSearchConfigPath = join(root, 'web-search.json');
  await saveWebSearchConfig(webSearchConfigPath, {
    enabled: true, provider: 'searxng', endpoint: 'http://192.168.1.8:8080', managed: false,
  });
  const config = resolveManifest({
    persistence: 'ephemeral', workspace_root: root,
    provider: {
      id: 'remote', endpoint: 'https://models.example.test/v1', model: 'model',
      trust_zone: 'public_network', credential_env: 'MODEL_TOKEN',
    },
    mcp_servers: [{
      id: 'memory', enabled: true, transport: 'streamable_http',
      endpoint: 'http://127.0.0.1:7788/mcp', credential_env: 'MEMORY_TOKEN',
    }],
    telemetry: { enabled: true, destination: 'https://telemetry.example.test/ingest' },
  });
  const report = await inspectNetworkDestinations({
    config, tools: { enabled: true, webSearchConfigPath },
    hooks: { health: () => ({ bundles: [{ bundle: 'memory-hooks', status: 'loaded' }] }) },
    extensions: { list: () => [{ id: 'adapter', state: 'ready' }] },
  });
  assert.equal(report.status, 'ready');
  assert.equal(report.default_unrelated_egress, false);
  assert.deepEqual(report.destinations.map((item) => item.kind), [
    'provider', 'mcp', 'telemetry', 'web_search', 'governed_tool', 'governed_tool', 'governed_tool', 'hook', 'extension',
  ]);
  assert.equal(report.destinations.every((item) => item.destination && item.purpose && item.state), true);
  assert.equal(report.destinations.find((item) => item.kind === 'provider').credential_reference, 'MODEL_TOKEN');
  assert.equal(JSON.stringify(report).includes('secret'), false);
});

test('AC-PRIV-01 local defaults disclose no unrelated fixed remote destination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-local-destinations-'));
  const config = resolveManifest({
    persistence: 'ephemeral', workspace_root: root,
    provider: { id: 'local', endpoint: 'http://127.0.0.1:1234/v1', model: 'local', trust_zone: 'loopback' },
  });
  const report = await inspectNetworkDestinations({
    config, tools: { enabled: true, webSearchConfigPath: join(root, 'absent.json') },
    hooks: { health: () => ({ bundles: [] }) }, extensions: { list: () => [] },
  });
  const fixed = report.destinations.filter((item) => !['per_request', 'process_arguments', 'shell_script'].includes(item.destination));
  assert.deepEqual(fixed.map((item) => [item.kind, item.trust_zone]), [['provider', 'loopback']]);
});

test('telemetry destinations reject embedded credentials before runtime', () => {
  assert.throws(() => resolveManifest({
    provider: { id: 'local', endpoint: 'http://127.0.0.1:1/v1', model: 'local', trust_zone: 'loopback' },
    telemetry: { enabled: true, destination: 'https://token@example.test/ingest' },
  }), { code: 'telemetry_destination_invalid' });
});
