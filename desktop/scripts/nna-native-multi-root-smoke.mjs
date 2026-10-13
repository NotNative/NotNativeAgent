// SPDX-License-Identifier: Apache-2.0
/** Disposable source-built NND↔native-NNA acceptance for two disjoint roots. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { access, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { json } from './smoke-http.mjs';
import { probeRestoredSelectedWorkspace, probeSelectedWorkspace, probeWorktreeWorkspace } from './smoke-multi-root.mjs';
import { reserveScratch, SCRATCH_ROOT } from './test-scratch.mjs';

const source = process.argv[2] ? resolve(process.argv[2]) : null;
if (!source) {
  process.stderr.write('usage: node scripts/nna-native-multi-root-smoke.mjs <NNA source directory>\n');
  process.exitCode = 2;
} else {
  await main(source).catch(error => {
    process.stderr.write(`Native multi-root smoke failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

async function provider() {
  const requests = [];
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === 'GET' && request.url === '/v1/models') {
        request.resume();
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'test', context_length: 32768, max_output_tokens: 2048 }] }));
        return;
      }
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        request.resume(); response.writeHead(404); response.end(); return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(body);
      const userText = String(body.messages?.filter(message => message.role === 'user').at(-1)?.content ?? '');
      const toolProbe = userText.includes('NND_TOOL_WRITE_ALLOW') ? 'write'
        : userText.includes('NND_TOOL_READ_ALLOW') ? 'allow'
          : userText.includes('NND_TOOL_READ_ESCAPE') ? 'escape' : null;
      const callId = toolProbe === 'allow' ? 'nnd_read_allow'
        : toolProbe === 'escape' ? 'nnd_read_escape' : 'nnd_write_allow';
      const toolReply = body.messages?.find(message => message.role === 'tool' && message.tool_call_id === callId);
      const searched = body.messages?.some(message => message.role === 'tool' && message.tool_call_id === 'nnd_write_search');
      const toolCall = toolProbe === 'write' && !searched
        ? { id: 'nnd_write_search', name: 'tool_search', args: { query: 'fs_write_text' } }
        : toolProbe && !toolReply ? { id: callId, name: toolProbe === 'write' ? 'fs_write_text' : 'fs_read',
          args: toolProbe === 'write' ? { path: 'F1_GOVERNED_WRITE.txt', content: 'governed-selected' }
            : { path: toolProbe === 'allow' ? 'F1_SECONDARY_SENTINEL.txt'
              : userText.match(/NND_TOOL_READ_ESCAPE:(\S+)/u)?.[1] } } : null;
      const delta = toolCall ? { role: 'assistant', tool_calls: [{ index: 0, id: toolCall.id, type: 'function',
        function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args) } }] }
        : { role: 'assistant', content: 'NND_SOURCE_REPLY' };
      if (body.messages?.[0]?.content?.includes('isolated tool-permission decision')) {
        const review = JSON.parse(body.messages.find(message => message.role === 'user')?.content ?? '{}');
        const intent = review.authenticatedIntent?.find(item => item.content?.includes('NND_TOOL_WRITE_ALLOW'));
        const approved = review.request?.toolName === 'fs_write_text'
          && review.request.args?.path === 'F1_GOVERNED_WRITE.txt'
          && review.request.args?.content_sha256 === createHash('sha256').update('governed-selected').digest('hex')
          && review.request.args?.content_bytes === 17 && intent;
        delta.content = JSON.stringify({ outcome: approved ? 'approve' : 'deny_with_guidance', confidence: 1,
          reason_code: approved ? 'exact_fixture_write' : 'fixture_write_mismatch',
          authority_anchors: approved ? [intent.sequence] : [],
          ...(!approved ? { guidance: 'This fixture approves only its exact selected-root write.' } : {}) });
        delete delta.tool_calls;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ choices: [{ delta,
        finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
    })().catch(() => { if (!response.headersSent) response.writeHead(400); response.end(); });
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  return { server, port: server.address().port, requests: () => requests };
}

async function main(nnaSource) {
  await access(join(nnaSource, 'src', 'nnd-service-native.js'));
  const fixture = reserveScratch('nnd-native-multi-root-');
  const primary = join(fixture, 'primary', 'shared');
  const secondary = join(fixture, 'secondary', 'shared');
  const data = join(fixture, 'data');
  let service;
  let fake;
  let failed = false;
  try {
    await Promise.all([mkdir(primary, { recursive: true }), mkdir(secondary, { recursive: true })]);
    for (const repository of [primary, secondary]) {
      execFileSync('git', ['init', '-q', '-b', 'main', repository]);
      execFileSync('git', ['config', 'user.name', 'NND Smoke'], { cwd: repository });
      execFileSync('git', ['config', 'user.email', 'smoke@nnd.invalid'], { cwd: repository });
      execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-q', '-m', 'fixture'], { cwd: repository });
    }
    fake = await provider();
    const { paths, environment, identity, startNndNativeService } = await configureNativeFixture(nnaSource, fixture, primary, data, fake.port);
    process.env.NOTNATIVE_DATA_DIR = join(fixture, 'nnd-data');
    process.env.NOTNATIVE_UI_PASSWORD = '';
    const [{ createNnaHarnessAdapter }, { registerHarnessAdapter }, { createApp }] = await Promise.all([
      import('../packages/web/src/server/harness/nna.ts'),
      import('../packages/web/src/server/harness/adapter.ts'),
      import('../packages/web/src/server/app.ts'),
    ]);
    const attach = async () => {
      service = await startNndNativeService(paths, identity, { environment });
      registerHarnessAdapter(createNnaHarnessAdapter({ endpoint: service.endpoint, token: service.token, principal: 'e30' }));
      return createApp();
    };
    let app = await attach();
    const call = (path, init = {}) => app.fetch(new Request(`http://nnd.local${path}`, {
      ...init, signal: AbortSignal.timeout(5_000),
    }));
    await waitForSetup(call);
    const health = await json(call, '/api/global/health', 200);
    assert.equal(health.healthy, true);
    const selected = await probeSelectedWorkspace(app, primary, secondary, fake.requests);
    await probeWorktreeWorkspace(app, primary, fake.requests);
    const first = await json(call, '/api/session', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Primary root smoke' }) }, 201);
    assert.equal(first.directory.toLowerCase(), primary.toLowerCase());
    const priorPrimaryRequests = fake.requests().length;
    const primaryPrompt = await call(`/api/session/${first.id}/prompt_async`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageID: 'primary_smoke', parts: [{ type: 'text', text: 'Reply with the smoke marker.' }] }),
    });
    assert.equal(primaryPrompt.status, 204);
    await waitForReply(call, first.id);
    assert.ok(fake.requests().length > priorPrimaryRequests, 'primary-root prompt did not reach the isolated provider');
    await service.close(); service = null;
    app = await attach();
    await waitForSetup((path, init = {}) => app.fetch(new Request(`http://nnd.local${path}`, {
      ...init, signal: AbortSignal.timeout(5_000),
    })));
    await probeRestoredSelectedWorkspace(app, selected, fake.requests);
    const restoredCall = (path, init = {}) => app.fetch(new Request(`http://nnd.local${path}`, {
      ...init, signal: AbortSignal.timeout(5_000),
    }));
    const restored = await json(restoredCall, `/api/session/${first.id}`, 200);
    assert.equal(restored.directory.toLowerCase(), primary.toLowerCase());
    await waitForReply(restoredCall, first.id);
    assert.equal(await json(restoredCall, `/api/session/${first.id}`, { method: 'DELETE' }, 200), true);
    assert.deepEqual(await json(restoredCall, '/api/session?roots=true', 200), []);
  } catch (error) { failed = true; throw error; }
  finally {
    let cleanupFailure;
    if (service) {
      try { await service.close(); }
      catch (error) { cleanupFailure = error; }
    }
    if (fake) {
      fake.server.closeAllConnections();
      await new Promise(done => fake.server.close(done));
    }
    const canonical = await realpath(fixture);
    assert.ok(canonical.startsWith(SCRATCH_ROOT + sep), 'refusing to remove fixture outside the shared scratch root');
    assert.match(basename(canonical), /^nnd-native-multi-root-[A-Za-z0-9_-]+$/u);
    assert.equal((await lstat(canonical)).isSymbolicLink(), false);
    if (failed || cleanupFailure) {
      process.stderr.write(`Native multi-root fixture preserved for investigation: ${canonical}\n`);
      if (cleanupFailure && !failed) throw cleanupFailure;
    } else {
      await rm(canonical, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
  process.stdout.write('Native two-root source smoke passed: admission, provider turns, governed selected-root read/write and scope denial, and restart recovery.\n');
}

async function configureNativeFixture(nnaSource, fixture, primary, data, providerPort) {
  const { ensureUserDataPaths, userDataPaths } = await import(pathToFileURL(join(nnaSource, 'src', 'product.js')).href);
  const { startNndNativeService } = await import(pathToFileURL(join(nnaSource, 'src', 'nnd-service-native.js')).href);
  const environment = { ...process.env, NNA_HOME: data };
  const paths = await ensureUserDataPaths(userDataPaths({ environment }));
  await writeFile(join(paths.config, 'manifest.json'), JSON.stringify({
    format_version: 1, persistence: 'durable', workspace_root: primary,
    providers: [{ id: 'primary', display_name: 'Primary', endpoint: `http://127.0.0.1:${providerPort}/v1`,
      model: 'test', trust_zone: 'loopback' }],
    routes: { primary: { provider_id: 'primary', model: 'test' } },
  }));
  const digest = value => createHash('sha256').update(value.toLowerCase()).digest('hex');
  const identity = { installation_id: `nna_${digest(fixture)}`, data_id: `data_${digest(data)}`,
    install_root: fixture, data_root: data, node: process.execPath,
    node_major: Number(process.versions.node.split('.')[0]), platform: process.platform, architecture: process.arch };
  return { paths, environment, identity, startNndNativeService };
}

async function waitForReply(call, id) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const messages = await json(call, `/api/session/${id}/message`, 200);
    if (messages.some(message => message.info?.role === 'assistant'
      && message.parts?.some(part => part.type === 'text' && part.text?.includes('NND_SOURCE_REPLY')))) return;
    if (Date.now() >= deadline) throw new Error('primary-root native turn did not complete');
    await new Promise(done => setTimeout(done, 100));
  }
}

async function waitForSetup(call) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const status = await json(call, '/api/v1/nnd/setup/status', 200);
    if (status.execution_state === 'ready') return;
    if (status.service_state !== 'starting' || Date.now() >= deadline) {
      throw new Error(`native setup did not become ready: ${JSON.stringify(status)}`);
    }
    await new Promise(done => setTimeout(done, 100));
  }
}
