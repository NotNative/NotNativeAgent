// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { TelegramApi } from '../src/gateway/telegram-api.js';
import { SearxngClient } from '../src/searxng-client.js';
import { localProviderFetch } from '../src/provider/local-http-transport.js';
import { attachProviderRequestMetadata } from '../src/provider/request-metadata.js';

test('Telegram HTTP errors preserve status even when the response is HTML', async () => {
  const api = new TelegramApi('fixture', { fetch: async () => new Response('<html>bad gateway</html>', { status: 502 }) });
  await assert.rejects(api.getMe(), (error) => error.code === 'telegram_api_error' && error.message.includes('502'));
});

test('Telegram already normalizes cancellation during body consumption', async () => {
  const controller = new AbortController();
  const api = new TelegramApi('fixture', { fetch: async () => {
    setImmediate(() => controller.abort()); return new Response(new ReadableStream());
  } });
  await assert.rejects(api.getMe(controller.signal), { code: 'telegram_cancelled' });
});

test('SearXNG retains timeout classification after headers and releases a failed reader', { timeout: 1000 }, async () => {
  let cancelled = false;
  const keeper = setTimeout(() => {}, 1000);
  try {
    const client = new SearxngClient({ timeoutMs: 15, fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) });
    await assert.rejects(client.search('http://localhost:8080', { query: 'x' }), { code: 'web_search_timeout' });
    assert.equal(cancelled, true);
  } finally { clearTimeout(keeper); }
});

test('SearXNG body errors stay typed and release the reader lock', async () => {
  const body = new ReadableStream({ start(controller) { controller.error(new Error('socket reset')); } });
  const client = new SearxngClient({ fetch: async () => new Response(body) });
  await assert.rejects(client.search('http://localhost:8080', { query: 'x' }), { code: 'web_search_request_failed' });
  assert.equal(body.locked, false);
});

test('native provider response construction rejects rather than escaping its callback', async () => {
  let callback;
  const promise = localProviderFetch('http://localhost:8080', {}, { request: (_url, _options, listener) => {
    callback = listener; const outgoing = new EventEmitter(); outgoing.end = () => {}; return outgoing;
  } });
  const incoming = Readable.from([]); incoming.statusCode = 700; incoming.headers = {};
  assert.doesNotThrow(() => callback(incoming));
  await assert.rejects(promise, { code: 'provider_response_invalid' });
  assert.equal(incoming.destroyed, true);
});

test('request metadata rejects malformed containers with a typed contract', () => {
  for (const [request, metadata] of [[null, {}], [{}, null], [{}, { injectedMessageIndexes: 3 }], [{}, { accountingSections: {} }]]) {
    assert.throws(() => attachProviderRequestMetadata(request, metadata), { code: 'provider_request_metadata_invalid' });
  }
});

test('transient outbox reads preserve notification files and expose the failure', async () => {
  const text = await readFile(new URL('../src/notifications/telegram.js', import.meta.url), 'utf8');
  let deletions = 0;
  const read = vm.runInNewContext(`${text.slice(text.indexOf('export async function readTelegramOutbox('), text.indexOf('export async function acknowledgeTelegramNotification(')).replace('export ', '')}\nreadTelegramOutbox`, {
    readdir: async () => ['abc.json'], join: (...parts) => parts.join('/'), MAX_OUTBOX_BATCH: 128, MAX_OUTBOX_FILE_BYTES: 16384,
    stat: async () => { throw Object.assign(new Error('temporary read failure'), { code: 'EIO' }); },
    unlink: async () => { deletions += 1; },
  });
  await assert.rejects(read('/outbox'), { code: 'EIO' }); assert.equal(deletions, 0);
});
