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
        request.resume(); response.writeHead(404); response.end(); return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(body); completions += 1;
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

async function main(nnaSource) {
  const cli = join(nnaSource, 'src', 'cli.js');
  await access(cli);
  const root = reserveScratch('nnd-timeline-observation-');
  let harness; let spawned; let provider;
  let operationFailed = false;
  let app = null;
  let parent;
  let child;
  const call = async (path, init = {}, expected = 200) => {
    const response = await app.fetch(new Request(`http://nnd.local${path}`, {
      ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
    }));
    const text = await response.text();
    assert.equal(response.status, expected, `${init.method ?? 'GET'} ${path} → ${response.status}: ${text.slice(0, 400)}`);
    return text ? JSON.parse(text) : null;
  };
  try {
    provider = await startProvider();
    await writeManifest(root, provider.port);
    process.env.NOTNATIVE_DATA_DIR = join(root, 'nnd-data');
    process.env.NOTNATIVE_UI_PASSWORD = '';
    const [{ startLocalNnaHarness }, { createNnaHarnessAdapter }, { registerHarnessAdapter }, { createApp }] = await Promise.all([
      import('../packages/web/src/server/harness/nna-local.ts'),
      import('../packages/web/src/server/harness/nna.ts'),
      import('../packages/web/src/server/harness/adapter.ts'),
      import('../packages/web/src/server/app.ts'),
    ]);
    harness = await startLocalNnaHarness({
      command: process.execPath, commandArguments: [cli], dataRoot: root,
      spawnChild: (command, args, options) => { spawned = spawn(command, args, options); return spawned; },
    }).catch((error) => { throw new Error(`initial NNA start: ${error.message}`); });
    await waitForExecution(harness);
    assert.ok(await harness.ensurePrimaryWorkspaceId(), 'NNA did not establish an authoritative primary workspace identity');
    registerHarnessAdapter(createNnaHarnessAdapter({
      endpoint: harness.endpoint, token: harness.token, principal: harness.principal(),
    }));
    app = createApp();

    const eventAbort = new AbortController();
    const eventResponse = await app.fetch(new Request('http://nnd.local/api/global/event', {
      headers: { accept: 'text/event-stream' }, signal: AbortSignal.any([eventAbort.signal, AbortSignal.timeout(120_000)]),
    }));
    assert.equal(eventResponse.status, 200);
    const reader = eventResponse.body.getReader();
    const nextEvent = eventReader(reader);
    try {
      assert.equal((await nextEvent()).payload.type, 'server.connected');

      const turn = async (id, promptId, text) => {
        await call(`/api/session/${id}/prompt_async`, {
          method: 'POST', body: JSON.stringify({
            messageID: promptId, model: { providerID: 'primary', modelID: 'test' }, agent: 'nna',
            parts: [{ type: 'text', text }],
          }),
        }, 204);
        await withTimeout(waitForCompletedTurn(nextEvent, id, promptId), TURN_TIMEOUT_MS, `turn ${promptId} did not complete`);
        return call(`/api/session/${id}/message`);
      };

      // Parent: two settled turns.
      const created = await call('/api/session', { method: 'POST', body: JSON.stringify({ title: 'Timeline observation' }) }, 201);
      parent = created.id;
      await turn(parent, 't1', 'Timeline turn one.');
      const parentTwo = await turn(parent, 't2', 'Timeline turn two.');
      assert.equal(parentTwo.length, 4, 'parent has two user + two assistant projections');

      // Fork: child inherits the full parent history. Assistant projections
      // are re-namespaced to the child id; user projections keep their ids,
      // so compare the inherited shape structurally.
      const timelineShape = (messages) => messages.map((m) => m.info.role);
      const forked = await call(`/api/session/${parent}/fork`, {
        method: 'POST', body: JSON.stringify({ messageID: 't2' }),
      }, 201);
      child = forked.id ?? forked.session?.id ?? forked.child?.id;
      assert.match(String(child), /^ses_/u, 'fork mints a child session id');
      const childInherited = await call(`/api/session/${child}/message`);
      assert.deepEqual(timelineShape(childInherited), timelineShape(parentTwo),
        'child timeline renders the inherited parent history');
      assert.deepEqual(childInherited.map((m) => m.info.id).slice(0, 2), ['t1', childInherited[1].info.id],
        'inherited user projections keep their submitted ids');
      const roots = await call('/api/session?roots=true');
      assert.deepEqual(roots.map((s) => s.id).sort(), [child, parent].sort(), 'parent and child both list as sessions');

      // Child continues independently.
      const childThree = await turn(child, 't3', 'Child-only turn.');
      assert.equal(childThree.length, 6, 'child continues past the inherited history');
      const childOnly = childThree.at(-1);
      assert.ok(JSON.stringify(childOnly).includes('CHILD_ONLY_REPLY'), 'child-only turn carries its own reply');
      assert.equal((await call(`/api/session/${parent}/message`)).length, 4, 'parent stays at two turns (independent)');

      // Revert the child-only turn: journal-backed replay hides it.
      const boundaryUser = childThree.find((m) => m.info.id === 't3');
      assert.ok(boundaryUser, 'child-only user projection present for the revert boundary');
      const reverted = await call(`/api/session/${child}/revert`, {
        method: 'POST', body: JSON.stringify({ messageID: 't3' }),
      });
      assert.ok(Array.isArray(reverted.reverted_turn_ids) && reverted.reverted_turn_ids.length >= 1,
        'revert names the reverted turn ids');
      const afterRevert = await call(`/api/session/${child}/message`);
      assert.deepEqual(timelineShape(afterRevert), timelineShape(parentTwo),
        'revert hides the child-only turn from the timeline');

      // A fresh turn after the revert replays normally on fresh turn ids.
      await turn(child, 't4', 'Timeline turn one.');
      const afterFresh = await call(`/api/session/${child}/message`);
      assert.ok(afterFresh.length >= 5, 'fresh turn replays normally after the revert point');
      assert.equal(afterFresh.some((m) => m.info.id === 't3'), false, 'reverted turn stays hidden across new turns');

      // Unrevert restores the hidden turn payload.
      await call(`/api/session/${child}/unrevert`, { method: 'POST', body: '{}' });
      const restored = await call(`/api/session/${child}/message`);
      assert.equal(restored.some((m) => m.info.id === 't3'), true, 'unrevert restores the hidden turn');
      assert.ok(restored.length >= afterFresh.length + 1, 'unrevert restores the reverted history');
    } finally {
      eventAbort.abort();
      await reader.cancel().catch(() => {});
    }

    // Multi-run leg: restart the native service and confirm both timelines
    // survive the journal replay (child keeps the restored history).
    const childBefore = await call(`/api/session/${child}/message`);
    const parentBefore = await call(`/api/session/${parent}/message`);
    const stopped = once(spawned, 'exit');
    harness.dispose();
    await withTimeout(stopped, 5_000, 'NNA did not stop for the restart leg');
    harness = await startLocalNnaHarness({
      command: process.execPath, commandArguments: [cli], dataRoot: root,
      spawnChild: (command, args, options) => { spawned = spawn(command, args, options); return spawned; },
    }).catch((error) => { throw new Error(`NNA restart: ${error.message}`); });
    await waitForExecution(harness);
    assert.ok(await harness.ensurePrimaryWorkspaceId(), 'NNA did not restore an authoritative primary workspace identity');
    registerHarnessAdapter(createNnaHarnessAdapter({
      endpoint: harness.endpoint, token: harness.token, principal: harness.principal(),
    }));
    app = createApp();
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
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    harness?.dispose();
    if (spawned && !spawned.exitCode) { try { spawned.kill(); } catch { /* best effort */ } }
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
  process.stdout.write('Live-NNA timeline observation passed: fork renders inherited history and continues independently; revert hides the boundary turn, fresh turns replay normally, unrevert restores the hidden history; parent never moved.\n');
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

main(process.argv[2]).catch((error) => {
  process.stderr.write(`timeline observation failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
