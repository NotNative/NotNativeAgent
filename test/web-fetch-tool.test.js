// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { webFetchDefinition, WebFetchClient, WebFetchDestinationPolicy } from '../src/web-fetch-tool.js';
import { saveWebFetchConfig } from '../src/web-fetch-config.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('web.fetch follows bounded redirects and returns attributed UTF-8 text', async () => {
  const requested = [];
  const client = new WebFetchClient({
    resolve: async () => ['93.184.216.34'],
    transport: async (url) => {
      requested.push(url.href);
      if (requested.length === 1) return new Response(null, { status: 302, headers: { location: '/final' } });
      return new Response('useful public text', { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    },
  });
  const definition = webFetchDefinition({ client });
  assert.match(definition.purpose, /authoritative source found through web\.search/u);
  const normalized = await definition.validate({ url: 'https://example.test/start#fragment' });
  const result = await definition.executor({ args: normalized.args, resolved: normalized.resolved }, new AbortController().signal);
  assert.equal(result.content, 'useful public text');
  assert.equal(result.metadata.finalUrl, 'https://example.test/final');
  assert.equal(result.metadata.bytes, 18);
  assert.deepEqual(requested, ['https://example.test/start', 'https://example.test/final']);
});

test('web.fetch rejects private destinations before network I/O', async () => {
  let fetched = false;
  const client = new WebFetchClient({
    resolve: async () => ['192.168.1.20'],
    transport: async () => { fetched = true; return new Response('no'); },
  });
  await assert.rejects(client.fetchText('https://internal.example.test/', new AbortController().signal), {
    code: 'web_fetch_destination_blocked',
  });
  assert.equal(fetched, false);
});

test('web.fetch rejects embedded credentials, binary content, and oversized bodies', async () => {
  const definition = webFetchDefinition();
  await assert.rejects(definition.validate({ url: 'https://user:password@example.test/' }), { code: 'tool_schema_invalid' });
  const binary = new WebFetchClient({
    resolve: async () => ['93.184.216.34'],
    transport: async () => new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'application/octet-stream' } }),
  });
  await assert.rejects(binary.fetchText('https://example.test/file', new AbortController().signal), { code: 'web_fetch_type_rejected' });
  const large = new WebFetchClient({
    resolve: async () => ['93.184.216.34'],
    transport: async () => new Response(new Uint8Array(1_048_577), { headers: { 'content-type': 'text/plain' } }),
  });
  await assert.rejects(large.fetchText('https://example.test/large', new AbortController().signal), { code: 'web_fetch_response_too_large' });
});

test('AC-SEC-07 WebFetch pins the validated public address and revalidates every redirect target', async () => {
  const connections = [];
  const resolutions = new Map([
    ['public.example.test', ['93.184.216.34']],
    ['redirect.example.test', ['192.168.1.9']],
  ]);
  const client = new WebFetchClient({
    resolve: async (host) => resolutions.get(host),
    transport: async (url, address, options) => {
      connections.push({ host: url.hostname, address, authorization: options.headers.authorization });
      return new Response(null, { status: 302, headers: { location: 'https://redirect.example.test/private' } });
    },
  });
  await assert.rejects(client.fetchText('https://public.example.test/start', new AbortController().signal), {
    code: 'web_fetch_destination_blocked',
  });
  assert.deepEqual(connections, [{ host: 'public.example.test', address: '93.184.216.34', authorization: undefined }]);
});

test('trusted exact private origins are admitted while other private origins remain blocked', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-webfetch-'));
  const path = join(root, 'web-fetch.json');
  await saveWebFetchConfig(path, { trusted_origins: ['http://127.0.0.1:8080'] });
  const policy = new WebFetchDestinationPolicy(path);
  assert.equal(await policy.classify(new URL('http://127.0.0.1:8080/status')), 'trusted_private_origin');
  await assert.rejects(policy.classify(new URL('http://127.0.0.1:8081/status')), { code: 'web_fetch_destination_blocked' });
  const calls = [];
  const client = new WebFetchClient({
    policy, resolve: async () => ['127.0.0.1'],
    transport: async (url, address) => { calls.push({ url: url.href, address }); return new Response('ok', { headers: { 'content-type': 'text/plain' } }); },
  });
  assert.equal((await client.fetchText('http://127.0.0.1:8080/status')).text, 'ok');
  assert.equal(calls[0].address, '127.0.0.1');
});
