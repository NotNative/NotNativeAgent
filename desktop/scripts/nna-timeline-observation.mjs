// SPDX-License-Identifier: Apache-2.0
/**
 * Live-NNA timeline observation (deferred-verification 2026-10-11 items):
 * native fork (`POST /session/:id/fork`, NNA 20261011-8) and native revert /
 * unrevert (journal-backed replay, NNA 20261011-10) against a disposable
 * local NNA pair, riding the NND `/api/*` harness proxy exactly like the
 * timeline UI. Fixture lands in the shared profile scratch root and
 * self-cleans.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join, sep } from 'node:path';
import { reserveScratch, SCRATCH_ROOT } from './test-scratch.mjs';
import { eventReader, withTimeout } from './smoke-http.mjs';

const STEP_TIMEOUT_MS = 10_000;
const TURN_TIMEOUT_MS = 20_000;

function reply(body) {
  const userText = (body.messages ?? []).filter((m) => m.role === 'user')
    .map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
  const content = userText.includes('Child-only turn.') ? 'CHILD_ONLY_REPLY'
    : userText.includes('Timeline turn two.') ? 'TIMELINE_TWO_REPLY'
    : 'TIMELINE_ONE_REPLY';
  return `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;
}

async function startProvider() {
  let completions = 0;
  const server = createServer((request, response) => {
    void (async () => {
      if (request.url === '/v1/models' && request.method === 'GET') {
        request.resume();
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'test', context_length: 32768, max_output_tokens: 2048 }] }));
        return;
      }
      if (request.url !== '/v1/chat/completions' || request.method !== 'POST') {
        request.resume(); response.writeHead(404); response.end(); return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      completions += 1;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(reply(body));
    })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('provider listener has no port');
  return { server, port: address.port, completions: () => completions };
}

async function writeManifest(root, providerPort) {
  const config = join(root, 'config');
  const providerEndpoint = `http://127.0.0.1:${providerPort}/v1`;
  await mkdir(config, { recursive: true });
  await writeFile(join(config, 'manifest.json'), JSON.stringify({
    format_version: 1, persistence: 'durable', workspace_root: root,
    providers: [{ id: 'primary', display_name: 'Primary', endpoint: providerEndpoint, model: 'test', trust_zone: 'loopback' }],
    routes: { primary: { provider_id: 'primary', model: 'test' } },
  }));
}

async function waitForExecution(harness) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await fetch(new URL('/global/health', harness.endpoint), {
      headers: { authorization: `Bearer ${harness.token}`, 'x-nna-principal': harness.principal() },
      signal: AbortSignal.timeout(Math.min(STEP_TIMEOUT_MS, deadline - Date.now())),
    });
    const body = await response.json();
    if (response.status === 200 && body.healthy === true) return;
    assert.equal(response.status, 503, `engine readiness: ${JSON.stringify(body)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('NNA execution did not become ready within the observation deadline');
}

async function waitForCompletedTurn(nextEvent, id, promptId) {
  for (;;) {
    const event = await nextEvent();
    if (event.payload?.type !== 'nnd.activity') continue;
    const activity = event.payload.properties;
    if (activity?.sessionID !== id || activity.id !== `${id}:turn:${promptId}`) continue;
    if (activity.status === 'completed') {
      assert.equal(activity.summary, 'Turn completed', 'governed NNA turn did not complete normally');
      return;
    }
    if (activity.status === 'failed') throw new Error(`governed NNA turn failed: ${promptId}`);
  }
}

async function bootObservation(cli, root, state, restarting = false) {
  process.env.NOTNATIVE_DATA_DIR = join(root, 'nnd-data');
  process.env.NOTNATIVE_UI_PASSWORD = '';
  const [{ startLocalNnaHarness }, { createNnaHarnessAdapter }, { registerHarnessAdapter }, { createApp }] = await Promise.all([
    import('../packages/web/src/server/harness/nna-local.ts'),
    import('../packages/web/src/server/harness/nna.ts'),
    import('../packages/web/src/server/harness/adapter.ts'),
    import('../packages/web/src/server/app.ts'),
  ]);
  const startLabel = restarting ? 'NNA restart' : 'initial NNA start';
  state.harness = await startLocalNnaHarness({
    command: process.execPath, commandArguments: [cli], dataRoot: root,
    spawnChild: (command, args, options) => { state.spawned = spawn(command, args, options); return state.spawned; },
  }).catch((error) => { throw new Error(startLabel + ': ' + error.message); });
  await waitForExecution(state.harness);
  assert.ok(await state.harness.ensurePrimaryWorkspaceId(), 'NNA did not establish an authoritative primary workspace identity');
  registerHarnessAdapter(createNnaHarnessAdapter({
    endpoint: state.harness.endpoint, token: state.harness.token, principal: state.harness.principal(),
  }));
  return createApp();
}

async function runForkProbes(call, nextEvent) {
  const turn = (id, promptId, text) => runTurn(call, nextEvent, id, promptId, text);
  const created = await call('/api/session', { method: 'POST', body: JSON.stringify({ title: 'Timeline observation' }) }, 201);
  const parent = created.id;
  await turn(parent, 't1', 'Timeline turn one.');
  const parentTwo = await turn(parent, 't2', 'Timeline turn two.');
  assert.equal(parentTwo.length, 4, 'parent has two user + two assistant projections');
  const forked = await call(`/api/session/${parent}/fork`, { method: 'POST', body: JSON.stringify({ messageID: 't2' }) }, 201);
  const child = forked.id ?? forked.session?.id ?? forked.child?.id;
  assert.match(String(child), /^ses_/u, 'fork mints a child session id');
  const childInherited = await call(`/api/session/${child}/message`);
  assert.deepEqual(childInherited.map((m) => m.info.role), parentTwo.map((m) => m.info.role),
    'child timeline renders the inherited parent history');
  assert.equal(childInherited[0].info.id, 't1', 'inherited user projections keep their submitted ids');
  const roots = await call('/api/session?roots=true');
  assert.deepEqual(roots.map((s) => s.id).sort(), [child, parent].sort(), 'parent and child both list as sessions');
  const childThree = await turn(child, 't3', 'Child-only turn.');
  assert.equal(childThree.length, 6, 'child continues past the inherited history');
  assert.ok(JSON.stringify(childThree.at(-1)).includes('CHILD_ONLY_REPLY'), 'child-only turn carries its own reply');
  assert.equal((await call(`/api/session/${parent}/message`)).length, 4, 'parent stays at two turns (independent)');
  await runRevertProbes(call, nextEvent, child, parentTwo);
  return { parent, child };
}

async function runTurn(call, nextEvent, id, promptId, text) {
  await call(`/api/session/${id}/prompt_async`, {
    method: 'POST', body: JSON.stringify({
      messageID: promptId, model: { providerID: 'primary', modelID: 'test' }, agent: 'nna',
      parts: [{ type: 'text', text }],
    }),
  }, 204);
  await withTimeout(waitForCompletedTurn(nextEvent, id, promptId), TURN_TIMEOUT_MS, `turn ${promptId} did not complete`);
  return call(`/api/session/${id}/message`);
}

async function runRevertProbes(call, nextEvent, child, parentTwo) {
  const boundaryUser = (await call(`/api/session/${child}/message`)).find((m) => m.info.id === 't3');
  assert.ok(boundaryUser, 'child-only user projection present for the revert boundary');
  const reverted = await call(`/api/session/${child}/revert`, { method: 'POST', body: JSON.stringify({ messageID: 't3' }) });
  assert.ok(Array.isArray(reverted.reverted_turn_ids) && reverted.reverted_turn_ids.length >= 1,
    'revert names the reverted turn ids');
  const afterRevert = await call(`/api/session/${child}/message`);
  assert.deepEqual(afterRevert.map((m) => m.info.role), parentTwo.map((m) => m.info.role),
    'revert hides the child-only turn from the timeline');
  await runTurn(call, nextEvent, child, 't4', 'Timeline turn one.');
  const afterFresh = await call(`/api/session/${child}/message`);
  assert.ok(afterFresh.length >= 5, 'fresh turn replays normally after the revert point');
  assert.equal(afterFresh.some((m) => m.info.id === 't3'), false, 'reverted turn stays hidden across new turns');
  await call(`/api/session/${child}/unrevert`, { method: 'POST', body: '{}' });
  const restored = await call(`/api/session/${child}/message`);
  assert.equal(restored.some((m) => m.info.id === 't3'), true, 'unrevert restores the hidden turn');
  assert.ok(restored.length >= afterFresh.length + 1, 'unrevert restores the reverted history');
}

async function runRestartLeg(call, state, cli, root, parent, child, apps) {
  const childBefore = await call(`/api/session/${child}/message`);
  const parentBefore = await call(`/api/session/${parent}/message`);
  const stopped = once(state.spawned, 'exit');
  state.harness.dispose();
  await withTimeout(stopped, 5_000, 'NNA did not stop for the restart leg');
  apps.current = await bootObservation(cli, root, state, true);
  const childAfter = await call(`/api/session/${child}/message`);
  const parentAfter = await call(`/api/session/${parent}/message`);
  // Assistant projection ids renumber across the fork-marker replay, so
  // compare the timeline structurally across restart (roles + user ids).
  const structural = (messages) => messages.map((m) => m.info.id.startsWith('ses_') ? 'assistant' : m.info.id);
  assert.deepEqual(structural(childAfter), structural(childBefore),
    'child timeline (fork + revert cycle + fresh turns) survives restart');
  assert.deepEqual(structural(parentAfter), structural(parentBefore),
    'parent timeline survives restart unchanged');
  assert.equal(childAfter.some((m) => m.info.id === 't3'), true, 'restored child-only turn survives restart');
}

function makeCall(apps) {
  return async (path, init = {}, expected = 200) => {
    const response = await apps.current.fetch(new Request(`http://nnd.local${path}`, {
      ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
    }));
    const text = await response.text();
    assert.equal(response.status, expected, `${init.method ?? 'GET'} ${path} → ${response.status}: ${text.slice(0, 400)}`);
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
    process.stderr.write(`observation cleanup also failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  }
}

async function main(nnaSource) {
  const cli = join(nnaSource, 'src', 'cli.js');
  await access(cli);
  const root = reserveScratch('nnd-timeline-observation-');
  const state = { harness: null, spawned: null };
  let provider = null;
  let operationFailed = false;
  try {
    provider = await startProvider();
    await writeManifest(root, provider.port);
    const apps = { current: await bootObservation(cli, root, state) };
    const call = makeCall(apps);
    const eventAbort = new AbortController();
    const eventResponse = await apps.current.fetch(new Request('http://nnd.local/api/global/event', {
      headers: { accept: 'text/event-stream' }, signal: AbortSignal.any([eventAbort.signal, AbortSignal.timeout(120_000)]),
    }));
    assert.equal(eventResponse.status, 200);
    const reader = eventResponse.body.getReader();
    const nextEvent = eventReader(reader);
    try {
      assert.equal((await nextEvent()).payload.type, 'server.connected');
      const { parent, child } = await runForkProbes(call, nextEvent);
      await runRestartLeg(call, state, cli, root, parent, child, apps);
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
  process.stdout.write('Live-NNA timeline observation passed: fork renders inherited history and continues independently; revert hides the boundary turn, fresh turns replay normally, unrevert restores the hidden history; the cycle survives restart; parent never moved.\n');
}

main(process.argv[2]).catch((error) => {
  process.stderr.write(`timeline observation failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
