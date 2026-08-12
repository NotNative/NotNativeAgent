// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SearxngClient } from '../src/searxng-client.js';
import { SearxngDeployment, MANAGED_SEARXNG_ENDPOINT } from '../src/searxng-deployment.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { loadWebSearchConfig, saveWebSearchConfig } from '../src/web-search-config.js';
import { runWebSearchCommand } from '../src/web-search-cli.js';
import { commandDefinition } from '../src/tui-commands.js';
import { webSearchOverlay } from '../src/tui-overlays.js';

test('global WebSearch configuration is absent-safe, normalized, and durable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-web-config-'));
  const path = join(root, 'config', 'web-search.json');
  try {
    assert.equal((await loadWebSearchConfig(path)).enabled, false);
    const saved = await saveWebSearchConfig(path, {
      enabled: true, provider: 'searxng', endpoint: 'http://192.168.1.8:8080/search/', managed: false,
    });
    assert.equal(saved.endpoint, 'http://192.168.1.8:8080');
    assert.deepEqual(await loadWebSearchConfig(path), saved);
    assert.match(await readFile(path, 'utf8'), /"provider": "searxng"/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('SearXNG client requests JSON and returns bounded normalized results', async () => {
  let requested;
  const client = new SearxngClient({ fetch: async (url) => {
    requested = new URL(url);
    return new Response(JSON.stringify({
      results: [
        { title: 'One', url: 'https://example.test/1', content: 'first', engine: 'test' },
        { title: 'Two', url: 'https://example.test/2', content: 'second' },
      ], suggestions: ['next'],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  const result = await client.search('https://search.example.test/', { query: 'nna search', limit: 1, safe_search: 2 });
  assert.equal(requested.pathname, '/search');
  assert.equal(requested.searchParams.get('format'), 'json');
  assert.equal(requested.searchParams.get('safesearch'), '2');
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].title, 'One');
});

test('web.search is globally configured and unavailable when disabled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-web-tool-'));
  const workspace = join(root, 'workspace');
  const configPath = join(root, 'config.json');
  const client = { search: async (endpoint, args) => ({ endpoint, query: args.query, results: [], suggestions: [] }) };
  const registry = new ToolRegistry(workspace, { webSearchConfigPath: configPath, webSearchClient: client });
  try {
    await mkdir(workspace);
    await registry.initialize();
    assert.match(registry.definition('web.search').purpose, /current versions, releases, support status/u);
    assert.match(registry.definition('web.search').purpose, /fetch an authoritative source/u);
    await assert.rejects(registry.seal({ providerCallId: 'disabled', name: 'web.search', args: { query: 'hello' } }, sealContext()), { code: 'web_search_disabled' });
    await saveWebSearchConfig(configPath, { enabled: true, provider: 'searxng', endpoint: 'http://10.0.0.5:8080' });
    const request = await registry.seal({ providerCallId: 'enabled', name: 'web.search', args: { query: 'hello' } }, sealContext());
    assert.equal(request.resolved.endpoint, 'http://10.0.0.5:8080');
    const result = await registry.definition('web.search').executor(request, new AbortController().signal);
    assert.equal(JSON.parse(result.content).query, 'hello');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('managed deployment preflights Docker, stages pinned resources, and validates search', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-searxng-deploy-'));
  const calls = [];
  const run = async (file, args) => {
    calls.push([file, ...args]);
    if (args[0] === 'info') return { stdout: 'linux\n', stderr: '' };
    return { stdout: 'ok\n', stderr: '' };
  };
  const client = { test: async () => ({ ok: true, endpoint: MANAGED_SEARXNG_ENDPOINT, results: 1 }) };
  try {
    const result = await new SearxngDeployment({ root, run, client, portAvailable: async () => true }).deploy();
    assert.equal(result.endpoint, MANAGED_SEARXNG_ENDPOINT);
    assert.ok(calls.some((call) => call.includes('compose') && call.includes('up')));
    assert.ok(calls.some((call) => call.includes('compose') && call.includes('--force-recreate')));
    assert.match(await readFile(join(root, 'compose.yaml'), 'utf8'), /127\.0\.0\.1:8888:8080/u);
    assert.match(await readFile(join(root, 'compose.yaml'), 'utf8'), /searxng@sha256:d0aaeb14880e6e92bde1518fcc7261e995783367d63d95203383607bef9c6516/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('configuration is not persisted until endpoint validation succeeds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-web-cli-'));
  const paths = { webSearchConfig: join(root, 'config.json'), managedSearxng: join(root, 'managed') };
  try {
    await assert.rejects(runWebSearchCommand(['configure', 'https://search.invalid'], paths, {
      client: { test: async () => { throw Object.assign(new Error('offline'), { code: 'offline' }); } },
    }), { code: 'offline' });
    assert.equal((await loadWebSearchConfig(paths.webSearchConfig)).enabled, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('reset removes only saved WebSearch configuration for installer rediscovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-web-reset-'));
  const paths = { webSearchConfig: join(root, 'config.json'), managedSearxng: join(root, 'managed') };
  try {
    await mkdir(paths.managedSearxng, { recursive: true });
    await saveWebSearchConfig(paths.webSearchConfig, {
      enabled: true, provider: 'searxng', endpoint: 'http://127.0.0.1:8888', managed: true,
    });
    const result = await runWebSearchCommand(['reset'], paths);
    assert.equal(result.configured, false);
    assert.equal(result.config.endpoint, null);
    assert.equal((await loadWebSearchConfig(paths.webSearchConfig)).enabled, false);
    assert.equal((await stat(paths.managedSearxng)).isDirectory(), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('managed deployment removal is explicit and idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-searxng-remove-'));
  const calls = [];
  const run = async (file, args) => {
    calls.push([file, ...args]);
    if (args[0] === 'info') return { stdout: 'linux\n', stderr: '' };
    return { stdout: 'ok\n', stderr: '' };
  };
  try {
    await mkdir(root, { recursive: true });
    await saveWebSearchConfig(join(root, 'unused-config.json'), {
      enabled: true, provider: 'searxng', endpoint: MANAGED_SEARXNG_ENDPOINT, managed: true,
    });
    await mkdir(join(root, 'deployment'), { recursive: true });
    await writeFile(join(root, 'deployment', 'compose.yaml'), 'services: {}\n');
    const deployment = new SearxngDeployment({ root: join(root, 'deployment'), run });
    assert.equal((await deployment.remove()).removed, true);
    assert.ok(calls.some((call) => call.includes('down') && call.includes('--remove-orphans')));
    assert.equal((await deployment.remove()).removed, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('/websearch exposes an actionable keyboard menu', () => {
  assert.equal(commandDefinition('/websearch').name, '/websearch');
  assert.equal(commandDefinition('/search_config').name, '/websearch');
  const view = webSearchOverlay({
    config: { enabled: true, provider: 'searxng', endpoint: 'http://127.0.0.1:8888', managed: true },
    test: { ok: true, results: 1 },
  });
  assert.equal(view.kind, 'websearch');
  assert.deepEqual(view.items.map((item) => item.id), ['action:configure', 'test', 'deploy', 'start', 'stop', 'disable', 'remove']);
  const disabled = webSearchOverlay({
    config: { enabled: false, provider: 'searxng', endpoint: null, managed: false }, test: null,
  });
  assert.deepEqual(disabled.items.map((item) => item.id), ['action:configure', 'deploy', 'remove']);
});

function sealContext() {
  return {
    policyVersion: 1, authority: { id: 'authority', version: 1 }, stepId: 'step',
    caller: 'primary', surface: 'interactive_tui',
  };
}
