import { startOpencodeServe } from '../src/opencode/serve.js';
import { resolveManifest } from '../src/config.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';

const config = resolveManifest({
  persistence: 'ephemeral',
  provider: { id: 'test', endpoint: 'http://127.0.0.1:9999/v1', model: 'fixture-model', trust_zone: 'loopback' },
});
const root = await mkdtemp(join(tmpdir(), 'nna-sse-probe-'));
const runtime = await startOpencodeServe({
  config, storeRoot: join(root, 's'), reviewerRoot: join(root, 'r'), directory: 'D:\\fx',
  stdout: { write: () => undefined },
  providerFactory: () => ({ async *stream() { yield { type: 'text', text: 'hi' }; } }),
});
const url = new URL(runtime.url);

const created = await fetch(`${runtime.url}/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'probe' }) });
const session = await created.json();
console.log('created', session.id, created.status);

await new Promise((resolve, reject) => {
  const req = httpRequest({ host: url.hostname, port: url.port, path: '/global/event', method: 'GET' }, (res) => {
    console.log('sse status', res.statusCode, res.headers['content-type']);
    res.setEncoding('utf8');
    res.on('data', (chunk) => console.log('SSE CHUNK', JSON.stringify(chunk)));
    res.on('end', () => console.log('SSE END'));
    setTimeout(resolve, 2500);
  });
  req.end();
  req.on('error', (error) => console.log('SSE ERR', error.message));
});

const prompt = await fetch(`${runtime.url}/session/${session.id}/message`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ parts: [{ type: 'text', text: 'hi' }] }),
});
console.log('prompt status', prompt.status);
await runtime.stop();
