// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createUiProtocolHandler, injectUiRuntimeConfig, resolveUiAssetPath } from './ui-protocol.mjs';

test('UI protocol confines paths and serves SPA fallback for missing or traversing requests', async () => {
  const root = path.resolve('web-dist');
  assert.equal(resolveUiAssetPath(root, '/assets/app.js'), path.join(root, 'assets', 'app.js'));
  assert.equal(resolveUiAssetPath(root, '/%2e%2e/secret.txt'), path.join(root, 'index.html'));
  const handler = createUiProtocolHandler({
    webDistDir: root, apiOrigin: 'http://127.0.0.1:57123',
    fileStat: async (file) => {
      if (file.endsWith('index.html')) return { isFile: () => true };
      throw new Error('missing asset');
    },
    fileRealPath: async (file) => file,
    read: async () => '<html><head></head><body>app</body></html>',
    fetchFile: async (url) => new Response(url),
  });
  const response = await handler({ url: 'notnative-ui://app/missing-route', method: 'GET' });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /__NOTNATIVE_API_BASE_URL__/u);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await handler({ url: 'notnative-ui://other/index.html' })).status, 404);
  assert.equal((await handler({ url: 'notnative-ui://app/index.html', method: 'POST' })).status, 405);
});

test('runtime config is script-safe and does not overwrite existing window globals', () => {
  const html = injectUiRuntimeConfig('<head></head>', 'http://127.0.0.1/</script>\u2028');
  assert.ok(html.includes('\\u003c/script>'));
  assert.ok(html.includes('\\u2028'));
  assert.match(html, /if\(window\.__NOTNATIVE_API_BASE_URL__===undefined\)/u);
});

test('missing file assets fail closed while extensionless client routes get the SPA shell', async () => {
  const root = path.resolve('web-dist');
  const handler = createUiProtocolHandler({
    webDistDir: root, apiOrigin: 'http://127.0.0.1:57123',
    fileStat: async (file) => {
      if (file.endsWith('index.html')) return { isFile: () => true };
      throw new Error('missing asset');
    },
    fileRealPath: async (file) => file,
    read: async () => '<html><head></head></html>',
    fetchFile: async () => { throw new Error('missing files must not be fetched'); },
  });
  assert.equal((await handler({ url: 'notnative-ui://app/assets/missing.js', method: 'GET' })).status, 404);
  assert.equal((await handler({ url: 'notnative-ui://app/sessions/active', method: 'GET' })).status, 200);
});

test('manifest requests from the packaged app origin reach the local server and preserve query and HEAD', async () => {
  const calls = [];
  const handler = createUiProtocolHandler({
    webDistDir: 'web-dist', apiOrigin: 'http://127.0.0.1:57123',
    fetchFile: async (url, options) => {
      calls.push({ url, method: options.method });
      return new Response(options.method === 'HEAD' ? null : '{"name":"Review Desk"}', {
        headers: { 'content-type': 'application/manifest+json', 'cache-control': 'no-store' },
      });
    },
  });
  const response = await handler({ url: 'notnative-ui://app/manifest.webmanifest?appName=Review%20Desk', method: 'GET' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/manifest+json');
  assert.equal(await response.text(), '{"name":"Review Desk"}');
  const head = await handler({ url: 'notnative-ui://app/manifest.webmanifest?orientation=portrait-primary', method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, null);
  assert.deepEqual(calls, [
    { url: 'http://127.0.0.1:57123/manifest.webmanifest?appName=Review%20Desk', method: 'GET' },
    { url: 'http://127.0.0.1:57123/manifest.webmanifest?orientation=portrait-primary', method: 'HEAD' },
  ]);
});

test('file assets preserve MIME and cache headers, reject symlink escapes, and honor HEAD', async () => {
  const root = path.resolve('web-dist');
  const inside = path.join(root, 'assets', 'app.js');
  let fileOptions;
  const handler = createUiProtocolHandler({
    webDistDir: root, apiOrigin: 'http://127.0.0.1:57123',
    fileStat: async (file) => ({ isFile: () => file === inside || file === path.join(root, 'index.html') }),
    fileRealPath: async (file) => file === inside ? 'C:\\private\\secrets.js' : file,
    read: async () => '<html></html>',
    fetchFile: async (_url, options) => {
      fileOptions = options;
      return new Response('asset', { headers: { 'content-type': 'application/javascript', 'cache-control': 'public, max-age=31536000' } });
    },
  });
  assert.equal((await handler({ url: 'notnative-ui://app/assets/app.js', method: 'GET' })).status, 404);

  const normalHandler = createUiProtocolHandler({
    webDistDir: root, apiOrigin: 'http://127.0.0.1:57123',
    fileStat: async (file) => ({ isFile: () => file === inside || file === path.join(root, 'index.html') }),
    fileRealPath: async (file) => file,
    read: async () => '<html></html>',
    fetchFile: async (_url, options) => {
      fileOptions = options;
      return new Response(options.method === 'HEAD' ? null : 'asset', { headers: { 'content-type': 'application/javascript' } });
    },
  });
  const head = await normalHandler({ url: 'notnative-ui://app/assets/app.js', method: 'HEAD' });
  assert.equal(fileOptions.method, 'HEAD');
  assert.equal(head.body, null);
  assert.equal(head.headers.get('content-type'), 'application/javascript');
  assert.equal(head.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(head.headers.get('cache-control'), 'no-cache');
});

test('protocol rejects alternate ports and credentials on the app authority', async () => {
  const handler = createUiProtocolHandler({ webDistDir: 'web-dist', apiOrigin: 'http://127.0.0.1', fetchFile: async () => new Response() });
  assert.equal((await handler({ url: 'notnative-ui://app:1234/index.html' })).status, 404);
  assert.equal((await handler({ url: 'notnative-ui://user@app/index.html' })).status, 404);
});
