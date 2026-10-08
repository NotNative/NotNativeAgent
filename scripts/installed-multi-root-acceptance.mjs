// SPDX-License-Identifier: Apache-2.0
/** Disposable Windows source install with authenticated Chromium multi-root turns. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptanceEvidence, checkedFixturePath, cli, prepare, privateDirectory, run, shell, waitStopped } from './installed-source-acceptance.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = join(homedir(), 'nnd-installed-acceptance-fixtures');
const powershell = join(process.env.SystemRoot ?? '', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

async function provider() {
  const requests = [];
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === 'GET' && request.url === '/v1/models') {
        request.resume(); response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'test', context_length: 32768, max_output_tokens: 2048 }] })); return;
      }
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        request.resume(); response.writeHead(404); response.end(); return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'NND_INSTALLED_REPLY' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    })().catch(() => { if (!response.headersSent) response.writeHead(400); response.end(); });
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  return { server, port: server.address().port, requests };
}

async function fixtureRepositories(fixture, providerPort) {
  const primary = join(fixture.root, 'primary', 'shared');
  const secondary = join(fixture.root, 'secondary', 'shared');
  for (const repository of [primary, secondary]) {
    await mkdir(repository, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', repository]);
    execFileSync('git', ['config', 'user.name', 'NND Smoke'], { cwd: repository });
    execFileSync('git', ['config', 'user.email', 'smoke@nnd.invalid'], { cwd: repository });
    execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-q', '-m', 'fixture'], { cwd: repository });
  }
  await writeFile(join(primary, 'PRIMARY_SENTINEL.txt'), 'primary-only');
  await writeFile(join(secondary, 'SECONDARY_SENTINEL.txt'), 'secondary-only');
  await writeFile(join(fixture.data, 'config', 'manifest.json'), JSON.stringify({
    format_version: 1, persistence: 'durable', workspace_root: primary,
    providers: [{ id: 'primary', display_name: 'Primary', endpoint: `http://127.0.0.1:${providerPort}/v1`,
      model: 'test', trust_zone: 'loopback' }],
    routes: { primary: { provider_id: 'primary', model: 'test' } },
  }));
  return { primary: await realpath(primary), secondary: await realpath(secondary) };
}

async function browserBefore({ primary, secondary }) {
  const jsonBody = value => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const request = async (path, init, expected) => {
    const started = Date.now(); console.info(`NND_PROBE_STEP:${path}:start`);
    const response = await fetch(path, init);
    const body = response.status === 204 ? null : await response.json();
    console.info(`NND_PROBE_STEP:${path}:${response.status}:${Date.now() - started}ms`);
    if (response.status !== expected) throw Error(`${path}: ${response.status} ${JSON.stringify(body)}`);
    return body;
  };
  const inventory = await request('/api/v1/nnd/workspaces/admissions', undefined, 200);
  if (inventory.attached.root.toLowerCase() !== primary.toLowerCase()) throw Error('wrong attached root');
  const selected = await request('/api/v1/nnd/workspaces/admissions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ installation_id: inventory.installation_id, data_id: inventory.data_id,
      expected_revision: inventory.revision, operation_id: crypto.randomUUID(), root: secondary }),
  }, 200);
  if (selected.persistence !== 'saved') throw Error('selected admission not saved');
  const admitted = await request('/api/v1/nnd/workspaces/admissions', undefined, 200);
  const row = admitted.admitted.find(item => item.root.toLowerCase() === secondary.toLowerCase());
  if (!row || row.id === admitted.attached.id) throw Error('same-name roots collapsed');
  const projects = await request('/api/project', undefined, 200);
  if (!projects.some(item => item.id === row.id && item.worktree.toLowerCase() === secondary.toLowerCase())) throw Error('selected project missing');
  const earlyEscape = await fetch(`/api/fs/read?directory=${encodeURIComponent(secondary)}&path=${encodeURIComponent('../../primary/shared/PRIMARY_SENTINEL.txt')}`);
  const earlyEscapeBody = await earlyEscape.text();
  console.info(`NND_PROBE_STEP:early-escape:${earlyEscape.status}:${earlyEscapeBody.slice(0, 160)}`);
  if (earlyEscape.status !== 403) throw Error(`early sibling repository read failed: ${earlyEscape.status} ${earlyEscapeBody.slice(0, 300)}`);
  const session = await request('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace_id: row.id, directory: secondary, title: 'Installed selected root' }) }, 201);
  if (session.projectID !== row.id || session.directory.toLowerCase() !== secondary.toLowerCase()) {
    throw Error('selected session identity or execution directory mismatch');
  }
  await request(`/api/session/${session.id}/prompt_async`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messageID: `installed_${crypto.randomUUID()}`, parts: [{ type: 'text', text: 'Reply with the marker.' }] }) }, 204);
  let replied = false;
  for (let i = 0; i < 150; i++) {
    const messages = await request(`/api/session/${session.id}/message`, undefined, 200);
    if (messages.some(message => message.info?.role === 'assistant'
      && message.parts?.some(part => part.text?.includes('NND_INSTALLED_REPLY')))) { replied = true; break; }
    await new Promise(done => setTimeout(done, 100));
  }
  if (!replied) throw Error('selected installed turn did not complete');
  const write = await request(`/api/fs/write?directory=${encodeURIComponent(secondary)}`, jsonBody({ path: 'SELECTED_WRITE.txt', content: 'installed-selected' }), 200);
  if (write.success !== true) throw Error('selected file write failed');
  const escape = await fetch(`/api/fs/read?directory=${encodeURIComponent(secondary)}&path=${encodeURIComponent('../../primary/shared/PRIMARY_SENTINEL.txt')}`);
  const escapeBody = await escape.text();
  console.info(`NND_PROBE_STEP:late-escape:${escape.status}:${escapeBody.slice(0, 160)}`);
  if (escape.status !== 403) throw Error(`sibling repository read escaped selected scope: ${escape.status} ${escapeBody.slice(0, 300)}`);
  return { workspaceId: row.id, sessionId: session.id };
}

async function browserAfter({ secondary, workspaceId, sessionId }) {
  const jsonBody = value => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const request = async (path, init, expected) => {
    const started = Date.now(); console.info(`NND_PROBE_STEP:${path}:start`);
    const response = await fetch(path, init);
    const body = response.status === 204 ? null : await response.json();
    console.info(`NND_PROBE_STEP:${path}:${response.status}:${Date.now() - started}ms`);
    if (response.status !== expected) throw Error(`${path}: ${response.status} ${JSON.stringify(body)}`);
    return body;
  };
  const inventory = await request('/api/v1/nnd/workspaces/admissions', undefined, 200);
  if (!inventory.admitted.some(item => item.id === workspaceId && item.root.toLowerCase() === secondary.toLowerCase())) throw Error('selected admission lost');
  const session = await request(`/api/session/${sessionId}`, undefined, 200);
  if (session.projectID !== workspaceId || session.directory.toLowerCase() !== secondary.toLowerCase()) throw Error('selected session lost');
  await request(`/api/session/${sessionId}/prompt_async`, jsonBody({ messageID: `restarted_${crypto.randomUUID()}`,
    parts: [{ type: 'text', text: 'Reply again after the installed restart.' }] }), 204);
  for (let i = 0; i < 150; i++) {
    const messages = await request(`/api/session/${sessionId}/message`, undefined, 200);
    const replies = messages.filter(message => message.info?.role === 'assistant'
      && message.parts?.some(part => part.text?.includes('NND_INSTALLED_REPLY')));
    if (replies.length >= 2) break;
    if (i === 149) throw Error('installed selected turn did not resume');
    await new Promise(done => setTimeout(done, 100));
  }
  const file = await fetch(`/api/fs/read?directory=${encodeURIComponent(secondary)}&path=SELECTED_WRITE.txt`);
  if (file.status !== 200 || await file.text() !== 'installed-selected') throw Error('selected file lost');
  return { resumed: true };
}

async function waitReady(fixture, status) {
  const deadline = Date.now() + 80_000;
  while (status.service_state === 'starting' && Date.now() < deadline) {
    await new Promise(done => setTimeout(done, 1000));
    status = await cli(fixture, 'status');
  }
  return status;
}

async function main(nnaSource) {
  assert.equal(process.platform, 'win32');
  assert.ok(isAbsolute(nnaSource));
  await mkdir(base, { recursive: true });
  assert.equal((await lstat(base)).isSymbolicLink(), false);
  assert.equal(await realpath(base), resolve(base));
  const root = join(base, `installed-accept-${randomUUID().replaceAll('-', '').slice(0, 16)}`);
  let fixture;
  let fake, stopped = false, failed = false;
  try {
    await privateDirectory(root);
    fixture = await prepare(nnaSource, root);
    fake = await provider();
    const roots = await fixtureRepositories(fixture, fake.port);
    await run(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      join(source, 'install.ps1'), '-InstallDir', fixture.nnd, '-NnaInstallRoot', fixture.nna,
      '-ShortcutRoot', fixture.shortcuts], { cwd: root, env: fixture.env, timeout: 900000,
        outputFiles: { stdout: join(root, 'installer-stdout.log'), stderr: join(root, 'installer-stderr.log') } });
    const initial = await waitReady(fixture, await cli(fixture, 'status'));
    assert.equal(initial.service_state, 'ready', `installed native runtime did not activate: ${JSON.stringify(initial)}`);
    const before = await shell(fixture, 'browser', initial.endpoint, (await cli(fixture, 'ui-ticket')).ticket,
      [], `(${browserBefore.toString()})(${JSON.stringify(roots)})`);
    assert.equal(await readFile(join(roots.secondary, 'SELECTED_WRITE.txt'), 'utf8'), 'installed-selected');
    await assert.rejects(readFile(join(roots.primary, 'SELECTED_WRITE.txt')), { code: 'ENOENT' });
    await cli(fixture, 'stop'); await waitStopped(fixture); stopped = true;
    // The start acknowledgment can fail after spawning the native owner.
    stopped = false;
    const restartStatus = await cli(fixture, 'start');
    const restarted = await waitReady(fixture, restartStatus);
    assert.equal(restarted.service_state, 'ready', `restarted native runtime did not activate: ${JSON.stringify(restarted)}`);
    const result = await shell(fixture, 'browser', restarted.endpoint, (await cli(fixture, 'ui-ticket')).ticket,
      [], `(${browserAfter.toString()})(${JSON.stringify({ ...roots, ...before })})`);
    assert.equal(result.resumed, true);
    assert.ok(fake.requests.length >= 2, 'provider turns did not cross installed service restart');
    await shell(fixture, 'desktop', restarted.endpoint);
    const last = await cli(fixture, 'status');
    assert.equal(last.instance_id, restarted.instance_id, 'desktop exit changed installed service owner');
    await cli(fixture, 'stop'); await waitStopped(fixture); stopped = true;
  } catch (error) { failed = true; throw error; }
  finally {
    if (fixture && !stopped) {
      try { await cli(fixture, 'stop'); await waitStopped(fixture); stopped = true; }
      catch { process.stderr.write(`Installed native state uncertain; preserved ${root}\n`); }
    }
    if (fake) { fake.server.closeAllConnections(); await new Promise(done => fake.server.close(done)); }
    if (!failed && stopped && !acceptanceEvidence().uncertain) {
      await rm(await checkedFixturePath(root), { recursive: true, force: true, maxRetries: 5 });
    } else process.stderr.write(`Installed multi-root evidence preserved at ${root}\n`);
  }
  process.stdout.write('Installed multi-root browser/desktop and selected-root restart turns passed.\n');
}

if (process.argv.length !== 3) throw Error('usage: node scripts/installed-multi-root-acceptance.mjs ABSOLUTE_NNA_SOURCE');
await main(resolve(process.argv[2]));
