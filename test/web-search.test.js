// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import test from 'node:test';
import { SearxngClient } from '../src/searxng-client.js';
import { SearxngDeployment, MANAGED_SEARXNG_ENDPOINT } from '../src/searxng-deployment.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { ContractError } from '../src/ids.js';
import {
  appendWebSearchProfile, loadWebSearchConfig, promoteWebSearchProfile, removeWebSearchProfile, saveWebSearchConfig,
} from '../src/web-search-config.js';
import { runWebSearchCommand } from '../src/web-search-cli.js';
import { commandDefinition } from '../src/tui/commands.js';
import { webSearchOverlay } from '../src/tui/websearch-overlay.js';

test('global WebSearch configuration is absent-safe, normalized, and durable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-web-config-'));
  const path = join(root, 'config', 'web-search.json');
  try {
    assert.equal((await loadWebSearchConfig(path)).enabled, false);
    const saved = await saveWebSearchConfig(path, {
      enabled: true, provider: 'searxng', endpoint: 'http://192.168.1.8:8080/search/', managed: false,
    });
    assert.equal(saved.version, 2);
    assert.equal(saved.profiles[0].endpoint, 'http://192.168.1.8:8080');
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
      ], suggestions: ['next'], unresponsive_engines: [['duckduckgo', 'CAPTCHA']],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  const result = await client.search('https://search.example.test/', { query: 'nna search', limit: 1, safe_search: 2 });
  assert.equal(requested.pathname, '/search');
  assert.equal(requested.searchParams.get('format'), 'json');
  assert.equal(requested.searchParams.get('safesearch'), '2');
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].title, 'One');
  assert.equal(result.search_state, 'results_returned');
  assert.deepEqual(result.upstream_failures, [{ engine: 'duckduckgo', reason: 'CAPTCHA' }]);
});

test('SearXNG client distinguishes an empty search from upstream engine degradation', async () => {
  const degraded = new SearxngClient({ fetch: async () => new Response(JSON.stringify({
    results: [], suggestions: [], unresponsive_engines: [
      ['brave', 'Too many requests'], ['duckduckgo', 'CAPTCHA'], ['invalid'], null,
    ],
  }), { status: 200 }) });
  const empty = new SearxngClient({ fetch: async () => new Response(JSON.stringify({
    results: [], suggestions: [], unresponsive_engines: [],
  }), { status: 200 }) });

  assert.deepEqual(await degraded.search('https://search.example.test', { query: 'norse mythology' }), {
    query: 'norse mythology', endpoint: 'https://search.example.test', search_state: 'upstream_degraded',
    results: [], suggestions: [], upstream_failures: [
      { engine: 'brave', reason: 'Too many requests' }, { engine: 'duckduckgo', reason: 'CAPTCHA' },
    ],
  });
  assert.equal((await empty.search('https://search.example.test', { query: 'missing' })).search_state, 'no_results');
});

test('web_search is globally configured and unavailable when disabled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-web-tool-'));
  const workspace = join(root, 'workspace');
  const configPath = join(root, 'config.json');
  const client = { search: async (endpoint, args) => ({
    endpoint, query: args.query, search_state: 'upstream_degraded', results: [], suggestions: [],
    upstream_failures: [{ engine: 'brave', reason: 'Too many requests' }],
  }) };
  const registry = new ToolRegistry(workspace, { webSearchConfigPath: configPath, webSearchClient: client });
  try {
    await mkdir(workspace);
    await registry.initialize();
    assert.equal(registry.definition('web_search').purpose,
      'Search the web through ordered SearXNG profiles and return bounded source summaries.');
    await assert.rejects(registry.seal({ providerCallId: 'disabled', name: 'web_search', args: { query: 'hello' } }, sealContext()), { code: 'web_search_disabled' });
    await saveWebSearchConfig(configPath, { enabled: true, provider: 'searxng', endpoint: 'http://10.0.0.5:8080' });
    const request = await registry.seal({
      providerCallId: 'enabled', name: 'web_search',
      args: { q: 'hello', recency: 'week', maxResults: '6' },
    }, sealContext());
    assert.equal(request.resolved.profiles[0].endpoint, 'http://10.0.0.5:8080');
    assert.deepEqual(request.publicArgs, { query: 'hello', time_range: 'week', limit: 6 });
    const result = await registry.definition('web_search').executor(request, new AbortController().signal);
    const content = JSON.parse(result.content);
    assert.equal(content.query, 'hello');
    assert.equal(content.search_state, 'upstream_degraded');
    assert.equal(content.recovery_hint, 'Every configured search profile was tried. Retry later or use another source.');
    assert.equal(content.profile_attempts.length, 1);
    assert.equal(result.metadata.upstream_failure_count, 1);
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
    await mkdir(join(root, 'config'), { recursive: true });
    await writeFile(join(root, 'config', 'settings.yml'), 'stale: true\n');
    const deployment = new SearxngDeployment({ root, run, client, portAvailable: async () => true });
    const result = await deployment.deploy();
    assert.equal(result.endpoint, MANAGED_SEARXNG_ENDPOINT);
    assert.ok(calls.some((call) => call.includes('compose') && call.includes('up')));
    assert.ok(calls.some((call) => call.includes('compose') && call.includes('--force-recreate')));
    assert.match(await readFile(join(root, 'compose.yaml'), 'utf8'), /127\.0\.0\.1:8888:8080/u);
    assert.match(await readFile(join(root, 'compose.yaml'), 'utf8'), /searxng@sha256:d0aaeb14880e6e92bde1518fcc7261e995783367d63d95203383607bef9c6516/u);
    assert.match(await readFile(join(root, 'compose.yaml'), 'utf8'), /SEARXNG_LIMITER: "false"/u);
    const settings = await readFile(join(root, 'config', 'settings.yml'), 'utf8');
    assert.doesNotMatch(settings, /stale: true/u);
    assert.match(settings, /- ahmia/u);
    assert.match(settings, /- torch/u);
    assert.match(settings, /- wikidata/u);
    assert.match(settings, /public_instance: false/u);
    assert.match(await readFile(join(root, 'config', 'limiter.toml'), 'utf8'), /trusted_proxies = \[\]/u);
    const callCount = calls.length;
    assert.equal((await deployment.refreshIfNeeded()).refreshed, false);
    assert.equal(calls.length, callCount);
    await writeFile(join(root, 'config', 'settings.yml'), 'stale: true\n');
    assert.equal((await deployment.refreshIfNeeded()).refreshed, true);
    assert.doesNotMatch(await readFile(join(root, 'config', 'settings.yml'), 'utf8'), /stale: true/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('managed WebSearch refresh is bounded to managed configurations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-web-refresh-'));
  const paths = { webSearchConfig: join(root, 'config.json'), managedSearxng: join(root, 'managed') };
  let refreshes = 0;
  const deployment = { refreshIfNeeded: async () => { refreshes += 1; return { refreshed: true }; } };
  try {
    assert.equal((await runWebSearchCommand(['refresh-managed'], paths, { deployment })).reason, 'not_managed');
    await saveWebSearchConfig(paths.webSearchConfig, {
      enabled: true, provider: 'searxng', endpoint: MANAGED_SEARXNG_ENDPOINT, managed: true,
    });
    const refreshed = await runWebSearchCommand(['refresh-managed'], paths, { deployment });
    assert.equal(refreshed.refreshed, true);
    assert.equal(refreshes, 1);
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

test('WebSearch CLI adds, promotes, and removes validated profiles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-web-cli-profiles-'));
  const paths = { webSearchConfig: join(root, 'config.json'), managedSearxng: join(root, 'managed') };
  const client = { test: async (endpoint) => ({ ok: true, endpoint, results: 1 }) };
  try {
    await runWebSearchCommand(['configure', 'https://primary.example'], paths, { client });
    const added = await runWebSearchCommand(['add', 'community', 'https://backup.example'], paths, { client });
    assert.deepEqual(added.config.profiles.map((item) => item.id), ['primary', 'community']);
    const promoted = await runWebSearchCommand(['promote', 'community'], paths, { client });
    assert.deepEqual(promoted.config.profiles.map((item) => item.id), ['community', 'primary']);
    const removed = await runWebSearchCommand(['remove-profile', 'community'], paths, { client });
    assert.deepEqual(removed.config.profiles.map((item) => item.id), ['primary']);
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
    assert.deepEqual(result.config.profiles, []);
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
    await writeFile(join(root, 'deployment', '.env'), `SEARXNG_SECRET=${'a'.repeat(64)}\n`);
    const deployment = new SearxngDeployment({ root: join(root, 'deployment'), run });
    assert.equal((await deployment.remove()).removed, true);
    assert.ok(calls.some((call) => call.includes('down') && call.includes('--remove-orphans')));
    assert.equal((await deployment.remove()).removed, false);

    const unmanaged = join(root, 'unmanaged');
    await mkdir(unmanaged);
    await writeFile(join(unmanaged, 'keep.txt'), 'preserve');
    await assert.rejects(new SearxngDeployment({ root: unmanaged, run }).remove(), { code: 'managed_root_unexpected' });
    assert.equal(await readFile(join(unmanaged, 'keep.txt'), 'utf8'), 'preserve');
    assert.throws(() => new SearxngDeployment({ root: 'relative', run }), { code: 'managed_root_unsafe' });
    assert.throws(() => new SearxngDeployment({ root: parse(root).root, run }), { code: 'managed_root_unsafe' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('/websearch exposes an actionable keyboard menu', () => {
  assert.equal(commandDefinition('/websearch').name, '/websearch');
  assert.equal(commandDefinition('/search_config').name, '/websearch');
  const view = webSearchOverlay({
    config: { enabled: true, profiles: [{ id: 'primary', display_name: 'Local', provider: 'searxng', endpoint: 'http://127.0.0.1:8888', managed: true }] },
    test: { ok: true, results: 1 },
  });
  assert.equal(view.kind, 'websearch');
  assert.deepEqual(view.items.map((item) => item.id), [
    'action:configure', 'action:add', 'test:primary', 'deploy', 'start', 'stop', 'disable', 'remove',
  ]);
  const disabled = webSearchOverlay({
    config: { enabled: false, profiles: [] }, test: null,
  });
  assert.deepEqual(disabled.items.map((item) => item.id), ['action:configure', 'action:add', 'deploy', 'remove']);
});

test('WebSearch profiles are bounded, unique, ordered, and removable', () => {
  const legacy = {
    enabled: true, provider: 'searxng', endpoint: 'https://primary.example/search/', managed: false,
  };
  const withFallback = appendWebSearchProfile(legacy, 'Community backup', 'https://backup.example');
  assert.deepEqual(withFallback.profiles.map((item) => item.id), ['primary', 'community-backup']);
  assert.equal(withFallback.profiles[0].endpoint, 'https://primary.example');
  const promoted = promoteWebSearchProfile(withFallback, 'community-backup');
  assert.deepEqual(promoted.profiles.map((item) => item.id), ['community-backup', 'primary']);
  assert.deepEqual(removeWebSearchProfile(promoted, 'community-backup').profiles.map((item) => item.id), ['primary']);
  assert.throws(() => appendWebSearchProfile(withFallback, 'Duplicate', 'https://primary.example'), {
    code: 'web_search_endpoint_duplicate',
  });
});

test('web_search advances through failures and empty results until a profile returns sources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-web-fallback-'));
  const workspace = join(root, 'workspace'); const configPath = join(root, 'config.json'); const calls = [];
  const client = { search: async (endpoint, args) => {
    calls.push(endpoint);
    if (endpoint.includes('primary')) throw Object.assign(new Error('offline'), { code: 'web_search_request_failed' });
    if (endpoint.includes('empty')) return {
      endpoint, query: args.query, search_state: 'no_results', results: [], suggestions: [], upstream_failures: [],
    };
    return {
      endpoint, query: args.query, search_state: 'results_returned',
      results: [{ title: 'Found', url: 'https://source.example', content: 'evidence' }],
      suggestions: [], upstream_failures: [],
    };
  } };
  try {
    await mkdir(workspace);
    await saveWebSearchConfig(configPath, { enabled: true, profiles: [
      { id: 'primary', display_name: 'Primary', endpoint: 'https://primary.example' },
      { id: 'empty', display_name: 'Empty', endpoint: 'https://empty.example' },
      { id: 'working', display_name: 'Working', endpoint: 'https://working.example' },
    ] });
    const registry = new ToolRegistry(workspace, { webSearchConfigPath: configPath, webSearchClient: client });
    await registry.initialize();
    const request = await registry.seal({ providerCallId: 'fallback', name: 'web_search', args: { query: 'evidence' } }, sealContext());
    const result = await registry.definition('web_search').executor(request, new AbortController().signal);
    const content = JSON.parse(result.content);
    assert.deepEqual(calls, ['https://primary.example', 'https://empty.example', 'https://working.example']);
    assert.equal(content.used_profile_id, 'working');
    assert.deepEqual(content.profile_attempts.map((item) => item.outcome), ['request_failed', 'no_results', 'results_returned']);
    assert.equal(result.metadata.fallback_used, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('web_search preserves degraded empty evidence and fails only when every profile transport fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-web-exhaustion-'));
  const workspace = join(root, 'workspace'); const configPath = join(root, 'config.json');
  try {
    await mkdir(workspace);
    await saveWebSearchConfig(configPath, { enabled: true, profiles: [
      { id: 'one', display_name: 'One', endpoint: 'https://one.example' },
      { id: 'two', display_name: 'Two', endpoint: 'https://two.example' },
    ] });
    const mixed = new ToolRegistry(workspace, { webSearchConfigPath: configPath, webSearchClient: {
      search: async (endpoint, args) => endpoint.includes('one')
        ? Promise.reject(Object.assign(new Error('offline'), { code: 'web_search_request_failed' }))
        : ({ endpoint, query: args.query, search_state: 'no_results', results: [], suggestions: [], upstream_failures: [] }),
    } });
    await mixed.initialize();
    const request = await mixed.seal({ providerCallId: 'mixed', name: 'web_search', args: { query: 'absent' } }, sealContext());
    const observation = JSON.parse((await mixed.definition('web_search').executor(request, new AbortController().signal)).content);
    assert.equal(observation.search_state, 'upstream_degraded');
    assert.deepEqual(observation.profile_attempts.map((item) => item.outcome), ['request_failed', 'no_results']);

    const failed = new ToolRegistry(workspace, { webSearchConfigPath: configPath, webSearchClient: {
      search: async () => { throw Object.assign(new Error('offline'), { code: 'web_search_request_failed' }); },
    } });
    await failed.initialize();
    const failedRequest = await failed.seal({ providerCallId: 'failed', name: 'web_search', args: { query: 'absent' } }, sealContext());
    await assert.rejects(failed.definition('web_search').executor(failedRequest, new AbortController().signal), {
      code: 'web_search_profiles_failed',
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('web_search cancellation stops the profile chain', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-web-cancel-'));
  const workspace = join(root, 'workspace'); const configPath = join(root, 'config.json'); let calls = 0;
  try {
    await mkdir(workspace);
    await saveWebSearchConfig(configPath, { enabled: true, profiles: [
      { id: 'one', display_name: 'One', endpoint: 'https://one.example' },
      { id: 'two', display_name: 'Two', endpoint: 'https://two.example' },
    ] });
    const registry = new ToolRegistry(workspace, { webSearchConfigPath: configPath, webSearchClient: {
      search: async () => { calls += 1; throw new ContractError('web_search_cancelled', 'cancelled'); },
    } });
    await registry.initialize();
    const request = await registry.seal({ providerCallId: 'cancel', name: 'web_search', args: { query: 'stop' } }, sealContext());
    await assert.rejects(registry.definition('web_search').executor(request, new AbortController().signal), {
      code: 'web_search_cancelled',
    });
    assert.equal(calls, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

function sealContext() {
  return {
    policyVersion: 1, authority: { id: 'authority', version: 1 }, stepId: 'step',
    caller: 'primary', surface: 'interactive_tui',
  };
}
