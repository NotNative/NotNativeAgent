// SPDX-License-Identifier: Apache-2.0
/** Explicit cross-repository smoke: NND routes -> adapter -> source NNA child. */
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const STEP_TIMEOUT_MS = 5_000;
const EXPECTED_REPLY = 'NND_SOURCE_REPLY';
// The stream spans the origin-gate request and session creation, each with
// its own step deadline. Give the live subscription their combined budget.
const EVENT_TIMEOUT_MS = 30_000;
const source = process.argv[2] ? resolve(process.argv[2]) : null;
if (!source) {
  process.stderr.write('usage: node scripts/nna-source-smoke.mjs <NNA source directory>\n');
  process.exitCode = 2;
} else {
  await main(source).catch((error) => {
    process.stderr.write(`NNA source smoke failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  });
}

async function writeManifest(root, providerPort) {
  const config = join(root, 'config');
  await mkdir(config, { recursive: true });
  await writeFile(join(config, 'manifest.json'), JSON.stringify({
    format_version: 1, persistence: 'ephemeral', workspace_root: root,
    providers: [{ id: 'primary', display_name: 'Primary', endpoint: `http://127.0.0.1:${providerPort}/v1`, model: 'test', trust_zone: 'loopback' }],
    routes: { primary: { provider_id: 'primary', model: 'test' } },
  }));
}

async function startProvider() {
  let completions = 0;
  const requests = [];
  const server = createServer((request, response) => {
    void (async () => {
      if (request.url === '/v1/models' && request.method === 'GET') {
        request.resume();
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'test', context_length: 32768, max_output_tokens: 2048 }] }));
        return;
      }
      if (request.url !== '/v1/chat/completions' || request.method !== 'POST') {
        request.resume();
        response.writeHead(404); response.end();
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(body);
      completions += 1;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: EXPECTED_REPLY }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    })().catch(() => { if (!response.headersSent) response.writeHead(400); response.end(); });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('provider listener has no port');
  return { server, port: address.port, completions: () => completions, requests: () => requests };
}

async function probe(app, workspace) {
  const call = (path, init = {}) => app.fetch(new Request(`http://nnd.local${path}`, {
    ...init, signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
  }));
  assert.equal((await json(call, '/api/global/health', 200)).healthy, true);
  assert.deepEqual(await json(call, '/api/session?roots=true', 200), []);
  const eventAbort = new AbortController();
  const eventResponse = await app.fetch(new Request('http://nnd.local/api/global/event', {
    headers: { accept: 'text/event-stream' }, signal: AbortSignal.any([eventAbort.signal, AbortSignal.timeout(EVENT_TIMEOUT_MS)]),
  }));
  assert.equal(eventResponse.status, 200);
  assert.match(eventResponse.headers.get('content-type') ?? '', /text\/event-stream/u);
  const reader = eventResponse.body.getReader();
  const nextEvent = eventReader(reader);
  try {
    assert.equal((await nextEvent()).payload.type, 'server.connected');
    await probeSession(call, workspace, nextEvent);
  } finally {
    eventAbort.abort();
    await reader.cancel().catch(() => {});
  }
}

async function probeSession(call, workspace, nextEvent) {
  const blocked = await call('/api/session', { method: 'POST', headers: { origin: 'null', 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(blocked.status, 403);
  const created = await json(call, '/api/session', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Source bridge smoke' }),
  }, 201);
  assert.equal(created.directory, workspace);
  const id = created.id;
  assert.match(id, /^ses_[A-Za-z0-9_-]+$/u);
  const createdEvent = await nextEvent();
  assert.equal(createdEvent.payload.type, 'session.created');
  assert.equal(createdEvent.payload.properties.info.id, id);
  assert.equal(createdEvent.directory, workspace);
  assert.deepEqual((await json(call, '/api/session?roots=true', 200)).map((item) => item.id), [id]);
  assert.deepEqual(await json(call, '/api/session?roots=false', 200), []);
  assert.deepEqual(await json(call, `/api/session/${id}/children`, 200), []);
  assert.deepEqual(await json(call, `/api/session/${id}/message`, 200), []);
  const submitted = await call(`/api/session/${id}/prompt_async`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messageID: 'smoke_prompt', parts: [{ type: 'text', text: 'Reply with the smoke marker.' }] }),
  });
  assert.equal(submitted.status, 204);
  await withTimeout(waitForCompletedTurn(nextEvent, id), 15_000, 'governed NNA turn did not reach a terminal activity');
  await waitForReply(call, id);
  const renamed = await json(call, `/api/session/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Renamed smoke' }),
  }, 200);
  assert.equal(renamed.title, 'Renamed smoke');
  assert.equal(await json(call, `/api/session/${id}`, { method: 'DELETE' }, 200), true);
  assert.deepEqual(await json(call, '/api/session?roots=true', 200), []);
}

async function waitForCompletedTurn(nextEvent, id) {
  for (;;) {
    const event = await nextEvent();
    if (event.payload?.type !== 'nnd.activity') continue;
    const activity = event.payload.properties;
    if (activity?.sessionID !== id || activity.id !== `${id}:turn:smoke_prompt`) continue;
    // NNA also labels cancelled/needs-input turns "completed" at the activity
    // transport layer; neither proves the provider reply finished normally.
    if (activity.status === 'completed') {
      assert.equal(activity.summary, 'Turn completed', 'governed NNA turn did not complete normally');
      return;
    }
    if (activity.status === 'failed') throw new Error('governed NNA turn failed after prompt acknowledgement');
  }
}

async function withTimeout(operation, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

async function waitForReply(call, id) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const messages = await json(call, `/api/session/${id}/message`, 200);
    if (Array.isArray(messages) && messages.some((message) => message.info?.role === 'assistant'
      && message.parts?.some((part) => part.type === 'text' && part.text?.includes(EXPECTED_REPLY)))) return;
    if (Date.now() >= deadline) throw new Error('governed NNA turn did not project the fake provider reply');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function eventReader(reader) {
  const decoder = new TextDecoder();
  let pending = '';
  return async () => {
    for (;;) {
      const split = pending.indexOf('\n\n');
      if (split >= 0) {
        const frame = pending.slice(0, split);
        pending = pending.slice(split + 2);
        const data = frame.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n');
        if (data) return JSON.parse(data);
        continue;
      }
      const part = await reader.read();
      if (part.done) throw new Error('NNA event stream ended before the expected event');
      pending += decoder.decode(part.value, { stream: true });
      if (pending.length > 65_536) throw new Error('NNA event frame exceeded smoke bound');
    }
  };
}

async function json(call, path, initOrStatus, expectedStatus) {
  const init = typeof initOrStatus === 'number' ? undefined : initOrStatus;
  const status = typeof initOrStatus === 'number' ? initOrStatus : expectedStatus;
  const response = await call(path, init);
  const body = await response.json().catch(() => null);
  assert.equal(response.status, status, `${path}: ${JSON.stringify(body)}`);
  return body;
}

async function main(nnaSource) {
  const cli = join(nnaSource, 'src', 'cli.js');
  await access(cli);
  const root = await mkdtemp(join(tmpdir(), 'nnd-nna-source-smoke-'));
  let harness;
  let provider;
  let operationFailed = false;
  try {
    provider = await startProvider();
    await writeManifest(root, provider.port);
    // Import after the isolated data root is selected: server auth/settings
    // modules capture environment at import time.
    process.env.NOTNATIVE_DATA_DIR = join(root, 'nnd-data');
    process.env.NOTNATIVE_UI_PASSWORD = '';
    const [{ startLocalNnaHarness }, { createNnaHarnessAdapter }, { registerHarnessAdapter }, { createApp }] = await Promise.all([
      import('../packages/web/src/server/harness/nna-local.ts'),
      import('../packages/web/src/server/harness/nna.ts'),
      import('../packages/web/src/server/harness/adapter.ts'),
      import('../packages/web/src/server/app.ts'),
    ]);
    harness = await startLocalNnaHarness({
      command: process.execPath, commandArguments: [cli], dataRoot: root, workspaceId: 'local',
    });
    // A successful proxy request alone would not detect an accidentally
    // unauthenticated NNA endpoint. Verify the boundary before supplying the
    // launch credential to the adapter.
    const unauthenticated = await fetch(new URL('/global/health', harness.endpoint), {
      signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
    });
    assert.equal(unauthenticated.status, 401, 'NNA must reject requests without integration credentials');
    registerHarnessAdapter(createNnaHarnessAdapter({
      endpoint: harness.endpoint, token: harness.token, principal: harness.principal,
    }));
    const app = createApp();
    await probe(app, root);
    assert.ok(provider.completions() > 0, 'NNA did not call the isolated provider');
    assert.ok(provider.requests().some((request) => request.messages?.some((message) =>
      message.role === 'user' && typeof message.content === 'string'
      && message.content.includes('Reply with the smoke marker.'))),
    'NNA did not submit the user prompt to the isolated provider');
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    harness?.dispose();
    if (provider) {
      const closed = new Promise((resolve) => provider.server.close(resolve));
      provider.server.closeAllConnections();
      await closed;
    }
    const prefix = join(tmpdir(), 'nnd-nna-source-smoke-');
    if (!root.startsWith(prefix)) throw new Error('refusing to remove unexpected smoke directory');
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      if (!operationFailed) throw error;
      process.stderr.write(`NNA source smoke cleanup also failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    }
  }
  process.stdout.write('NND↔NNA source smoke passed: authenticated bootstrap, live session event, governed prompt and transcript, root list, empty child projections, session lifecycle, and origin gate.\n');
}
