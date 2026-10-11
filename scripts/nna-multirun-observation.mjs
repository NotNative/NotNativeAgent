// SPDX-License-Identifier: Apache-2.0
/**
 * Live-NNA multi-run observation (deferred-verification F9, NNA behavior
 * leg): the same prompt in two sessions with different per-session model
 * selections (F9 step 1 bounded per-session primary-route override,
 * NND 20261011-30 orchestration) — each run's route must hold through the
 * assertConfiguredSelection path (NNA nnd-harness-routes). Rides the NND
 * slash-api harness proxy exactly like the timeline UI. Fixture lands in
 * the shared profile scratch root and self-cleans. Note: string
 * concatenation only — the quality-gate brace counter mis-lexes template
 * literals with interpolation.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, sep } from 'node:path';
import { reserveScratch, SCRATCH_ROOT } from './test-scratch.mjs';
import { eventReader, withTimeout } from './smoke-http.mjs';

const STEP_TIMEOUT_MS = 10_000;
const TURN_TIMEOUT_MS = 20_000;

function reply(body) {
  const delta = { role: 'assistant', content: 'ROUTE_' + (body.model ?? 'unspecified') + '_REPLY' };
  const chunk = { choices: [{ delta, finish_reason: 'stop' }] };
  return 'data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n';
}

async function startProvider() {
  let completions = 0;
  const models = [];
  const server = createServer((request, response) => {
    void (async () => {
      if (request.url === '/v1/models' && request.method === 'GET') {
        request.resume();
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [
          { id: 'test', context_length: 32768, max_output_tokens: 2048 },
          { id: 'test-alt', context_length: 65536, max_output_tokens: 4096 },
        ] }));
        return;
      }
      if (request.url !== '/v1/chat/completions' || request.method !== 'POST') {
        request.resume(); response.writeHead(404); response.end(); return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      models.push(body.model ?? null); completions += 1;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(reply(body));
    })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('provider listener has no port');
  return { server, port: address.port, models: () => models };
}

async function writeManifest(root, providerPort) {
  const config = join(root, 'config');
  const providerEndpoint = 'http://127.0.0.1:' + providerPort + '/v1';
  await mkdir(config, { recursive: true });
  await writeFile(join(config, 'manifest.json'), JSON.stringify({
    format_version: 1, persistence: 'durable', workspace_root: root,
    providers: [
      { id: 'primary', display_name: 'Primary', endpoint: providerEndpoint, model: 'test', trust_zone: 'loopback' },
      { id: 'secondary', display_name: 'Secondary', endpoint: providerEndpoint, model: 'test-alt', trust_zone: 'loopback' },
    ],
    routes: { primary: { provider_id: 'primary', model: 'test' } },
  }));
}

async function waitForExecution(harness) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await fetch(new URL('/global/health', harness.endpoint), {
      headers: { authorization: 'Bearer ' + harness.token, 'x-nna-principal': harness.principal() },
      signal: AbortSignal.timeout(Math.min(STEP_TIMEOUT_MS, deadline - Date.now())),
    });
    const body = await response.json();
    if (response.status === 200 && body.healthy === true) return;
    assert.equal(response.status, 503, 'engine readiness: ' + JSON.stringify(body));
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('NNA execution did not become ready within the observation deadline');
}

async function waitForCompletedTurn(nextEvent, id, promptId) {
  for (;;) {
    const event = await nextEvent();
    if (event.payload?.type !== 'nnd.activity') continue;
    const activity = event.payload.properties;
    if (activity?.sessionID !== id || activity.id !== id + ':turn:' + promptId) continue;
    if (activity.status === 'completed') {
      assert.equal(activity.summary, 'Turn completed', 'governed NNA turn did not complete normally');
      return;
    }
    if (activity.status === 'failed') throw new Error('governed NNA turn failed: ' + promptId);
  }
}

function makeCall(apps) {
  return async (path, init = {}, expected = 200) => {
    const response = await apps.current.fetch(new Request('http://nnd.local' + path, {
      ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
    }));
    const text = await response.text();
    const label = (init.method ?? 'GET') + ' ' + path + ' -> ' + response.status + ': ' + text.slice(0, 400);
    assert.equal(response.status, expected, label);
    return text ? JSON.parse(text) : null;
  };
}

async function cleanupObservation(root, state, provider, operationFailed) {
  state.harness?.dispose();
  if (state.spawned && !state.spawned.exitCode) { try { state.spawned.kill(); } catch { /* best effort */ } }
  if (provider) {
    const closed = new Promise((resolve) => provider.server.close(resolve));
    provider.server.closeAllConnections();
    await closed;
  }
  if (!root.startsWith(SCRATCH_ROOT + sep)) throw new Error('refusing to remove unexpected observation directory');
  try {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (error) {
    if (!operationFailed) throw error;
    const message = error instanceof Error ? error.message : 'unknown error';
    process.stderr.write('observation cleanup also failed: ' + message + '\n');
  }
}

async function runTurn(call, nextEvent, id, promptId) {
  await call('/api/session/' + id + '/prompt_async', {
    method: 'POST', body: JSON.stringify({
      messageID: promptId, agent: 'nna', parts: [{ type: 'text', text: 'F9 route observation prompt.' }],
    }),
  }, 204);
  await withTimeout(waitForCompletedTurn(nextEvent, id, promptId), TURN_TIMEOUT_MS, 'turn did not complete: ' + promptId);
  return call('/api/session/' + id + '/message');
}

async function runMultiRunProbes(call, nextEvent) {
  const sessionA = await call('/api/session', { method: 'POST', body: JSON.stringify({ title: 'F9 route A' }) }, 201);
  assert.deepEqual(sessionA.metadata.nnd.configuredModel, { providerID: 'primary', modelID: 'test' },
    'session A inherits the configured primary route');
  const sessionB = await call('/api/session', {
    method: 'POST', body: JSON.stringify({ title: 'F9 route B', providerID: 'secondary', model: 'test-alt' }),
  }, 201);
  assert.deepEqual(sessionB.metadata.nnd.configuredModel, { providerID: 'secondary', modelID: 'test-alt' },
    'session B holds its bounded per-session route override');
  await runTurn(call, nextEvent, sessionA.id, 'f9a');
  await runTurn(call, nextEvent, sessionB.id, 'f9b');
  const messagesB = await call('/api/session/' + sessionB.id + '/message');
  assert.ok(JSON.stringify(messagesB).includes('ROUTE_test-alt_REPLY'),
    'session B run rode the per-session secondary route');
  // The override path: a prompt naming a different model than the session's
  // configured selection must be refused (assertConfiguredSelection).
  const override = await call('/api/session/' + sessionA.id + '/prompt_async', {
    method: 'POST', body: JSON.stringify({
      messageID: 'f9x', agent: 'nna', parts: [{ type: 'text', text: 'F9 route observation prompt.' }],
      model: { providerID: 'secondary', modelID: 'test-alt' },
    }),
  }, 400);
  assert.equal(override.error.code, 'nnd_model_override_unsupported',
    'override followed the assertConfiguredSelection path');
  return { sessionA: sessionA.id, sessionB: sessionB.id };
}

async function bootObservation(cli, root, state, restarting) {
  process.env.NOTNATIVE_DATA_DIR = join(root, 'nnd-data');
  process.env.NOTNATIVE_UI_PASSWORD = '';
  const [nnaLocal, nnaHarness, harnessAdapter, webApp] = await Promise.all([
    import('../packages/web/src/server/harness/nna-local.ts'),
    import('../packages/web/src/server/harness/nna.ts'),
    import('../packages/web/src/server/harness/adapter.ts'),
    import('../packages/web/src/server/app.ts'),
  ]);
  const label = restarting ? 'NNA restart' : 'initial NNA start';
  state.harness = await nnaLocal.startLocalNnaHarness({
    command: process.execPath, commandArguments: [cli], dataRoot: root,
    spawnChild: (command, args, options) => { state.spawned = spawn(command, args, options); return state.spawned; },
  }).catch((error) => { throw new Error([label, error.message].join(': ')); });
  await waitForExecution(state.harness);
  assert.ok(await state.harness.ensurePrimaryWorkspaceId(), 'NNA did not establish an authoritative primary workspace identity');
  harnessAdapter.registerHarnessAdapter(nnaHarness.createNnaHarnessAdapter({
    endpoint: state.harness.endpoint, token: state.harness.token, principal: state.harness.principal(),
  }));
  return webApp.createApp();
}

async function main(nnaSource) {
  const cli = join(nnaSource, 'src', 'cli.js');
  await access(cli);
  const root = reserveScratch('nnd-multirun-observation-');
  const state = { harness: null, spawned: null };
  let provider = null;
  let operationFailed = false;
  try {
    provider = await startProvider();
    await writeManifest(root, provider.port);
    const apps = { current: null, register: null };
    const app = await bootObservation(cli, root, state, false);
    apps.current = app;
    const call = makeCall(apps);
    const eventAbort = new AbortController();
    const eventResponse = await app.fetch(new Request('http://nnd.local/api/global/event', {
      headers: { accept: 'text/event-stream' }, signal: AbortSignal.any([eventAbort.signal, AbortSignal.timeout(120_000)]),
    }));
    assert.equal(eventResponse.status, 200);
    const reader = eventResponse.body.getReader();
    const nextEvent = eventReader(reader);
    try {
      assert.equal((await nextEvent()).payload.type, 'server.connected');
      const sessions = await runMultiRunProbes(call, nextEvent);
      const roots = await call('/api/session?roots=true');
      assert.deepEqual(roots.map((s) => s.id).sort(), [sessions.sessionA, sessions.sessionB].sort(),
        'both multi-run sessions list');
      assert.deepEqual(provider.models().slice(-2), ['test', 'test-alt'],
        'the two same-prompt runs rode their per-session routes on the wire');
    } finally {
      eventAbort.abort();
      await reader.cancel().catch(() => {});
    }
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    await cleanupObservation(root, state, provider, operationFailed);
  }
  process.stdout.write('Live-NNA multi-run observation passed: same prompt, two sessions, two different per-session model selections; each run rode its own route on the wire and the override path refused a mismatched model via assertConfiguredSelection.\n');
}

main(process.argv[2]).catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write('multi-run observation failed: ' + message + '\n');
  process.exitCode = 1;
});
