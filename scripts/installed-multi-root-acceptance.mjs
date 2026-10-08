// SPDX-License-Identifier: Apache-2.0
/** Disposable Windows source install with authenticated Chromium multi-root turns. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { acceptanceEvidence, checkedFixturePath, cli, prepare, privateDirectory, run, shell, waitStopped } from './installed-source-acceptance.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = join(homedir(), 'nnd-installed-acceptance-fixtures');
const powershell = join(process.env.SystemRoot ?? '', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const checkedProbe = expression => { new Script(expression, { filename: 'nnd-browser-probe.js' }); return expression; };

function providerDelta(body) {
  const userText = String(body.messages?.filter(message => message.role === 'user').at(-1)?.content ?? '');
  if (body.messages?.[0]?.content?.includes('isolated tool-permission decision')) {
    const review = JSON.parse(body.messages.find(message => message.role === 'user')?.content ?? '{}');
    const intent = review.authenticatedIntent?.findLast(item => item.content?.includes('NND_TOOL_WRITE_ALLOW:'));
    const phase = intent?.content?.match(/NND_TOOL_WRITE_ALLOW:(BEFORE|AFTER)/u)?.[1];
    const content = phase ? `governed-selected-${phase.toLowerCase()}` : '';
    const approved = review.request?.toolName === 'fs_write_text'
      && review.request.args?.path === `SELECTED_GOVERNED_${phase}.txt`
      && review.request.args?.content_sha256 === createHash('sha256').update(content).digest('hex')
      && review.request.args?.content_bytes === Buffer.byteLength(content) && intent;
    return { review: { phase, approved: Boolean(approved) }, delta: { role: 'assistant', content: JSON.stringify({ outcome: approved ? 'approve' : 'deny_with_guidance',
      confidence: 1, reason_code: approved ? 'exact_fixture_write' : 'fixture_write_mismatch',
      authority_anchors: approved ? [intent.sequence] : [],
      ...(!approved ? { guidance: 'This fixture approves only its exact selected-root write.' } : {}) }) }, toolCall: false };
  }
  const phase = userText.match(/NND_TOOL_WRITE_ALLOW:(BEFORE|AFTER)/u)?.[1];
  const toolProbe = phase ? 'write' : userText.includes('NND_TOOL_READ_ALLOW') ? 'allow'
    : userText.includes('NND_TOOL_READ_ESCAPE') ? 'escape' : null;
  const callId = phase ? `nnd_write_${phase.toLowerCase()}` : toolProbe === 'allow' ? 'nnd_read_allow' : 'nnd_read_escape';
  const toolReply = toolProbe ? body.messages?.find(message => message.role === 'tool' && message.tool_call_id === callId) : null;
  const searched = phase && body.messages?.some(message => message.role === 'tool' && message.tool_call_id === `nnd_write_search_${phase.toLowerCase()}`);
  if (phase && !searched) return { delta: { role: 'assistant', tool_calls: [{ index: 0,
    id: `nnd_write_search_${phase.toLowerCase()}`, type: 'function',
    function: { name: 'tool_search', arguments: JSON.stringify({ query: 'fs_write_text' }) } }] }, toolCall: true };
  if (toolProbe && !toolReply) return { delta: { role: 'assistant', tool_calls: [{ index: 0, id: callId,
    type: 'function', function: { name: phase ? 'fs_write_text' : 'fs_read', arguments: JSON.stringify(phase
      ? { path: `SELECTED_GOVERNED_${phase}.txt`, content: `governed-selected-${phase.toLowerCase()}` }
      : { path: toolProbe === 'allow' ? 'SECONDARY_SENTINEL.txt' : userText.match(/NND_TOOL_READ_ESCAPE:(\S+)/u)?.[1] }) } }] }, toolCall: true };
  if (toolReply) {
    const result = JSON.parse(toolReply.content);
    const valid = phase ? result.tool_lifecycle_status === 'succeeded'
      : toolProbe === 'allow' ? result.tool_lifecycle_status === 'succeeded' && result.content === 'secondary-only'
        : result.tool_lifecycle_status !== 'succeeded' && toolReply.content.includes('tool_scope_denied')
          && !toolReply.content.includes('primary-only');
    return { delta: { role: 'assistant', content: valid
      ? `NND_INSTALLED_${phase ? `WRITE_${phase}` : `READ_${toolProbe.toUpperCase()}`}_PASS`
      : `NND_INSTALLED_${phase ? `WRITE_${phase}` : `READ_${toolProbe.toUpperCase()}`}_FAIL` }, toolCall: false };
  }
  return { delta: { role: 'assistant', content: 'NND_INSTALLED_REPLY' }, toolCall: false };
}

async function provider() {
  const requests = [];
  const reviews = [];
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
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(body);
      const { delta, toolCall, review } = providerDelta(body);
      if (review) reviews.push(review);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: toolCall ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
    })().catch(() => { if (!response.headersSent) response.writeHead(400); response.end(); });
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  return { server, port: server.address().port, requests, reviews };
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

async function browserSelectedBefore({ primary, secondary }, governedReads, governedWrite) {
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
  await governedWrite(request, session.id, 'BEFORE');
  await governedReads(request, session.id, primary);
  const write = await request(`/api/fs/write?directory=${encodeURIComponent(secondary)}`, jsonBody({ path: 'SELECTED_WRITE.txt', content: 'installed-selected' }), 200);
  if (write.success !== true) throw Error('selected file write failed');
  const escape = await fetch(`/api/fs/read?directory=${encodeURIComponent(secondary)}&path=${encodeURIComponent('../../primary/shared/PRIMARY_SENTINEL.txt')}`);
  const escapeBody = await escape.text();
  console.info(`NND_PROBE_STEP:late-escape:${escape.status}:${escapeBody.slice(0, 160)}`);
  if (escape.status !== 403) throw Error(`sibling repository read escaped selected scope: ${escape.status} ${escapeBody.slice(0, 300)}`);
  return { workspaceId: row.id, sessionId: session.id };
}

async function browserGovernedWrite(request, sessionId, phase) {
  const prompt = `NND_TOOL_WRITE_ALLOW:${phase}`;
  const marker = `NND_INSTALLED_WRITE_${phase}_PASS`;
  const body = JSON.stringify({ messageID: `write_${crypto.randomUUID()}`, parts: [{ type: 'text', text: prompt }] });
  let accepted = false;
  for (let i = 0; i < 150; i++) {
    const response = await fetch(`/api/session/${sessionId}/prompt_async`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    if (response.status === 204) { accepted = true; break; }
    if (response.status !== 409) throw Error(`governed write prompt failed: ${response.status} ${await response.text()}`);
    await new Promise(done => setTimeout(done, 100));
  }
  if (!accepted) throw Error(`native session stayed busy before governed write: ${phase}`);
  for (let i = 0; i < 150; i++) {
    const messages = await request(`/api/session/${sessionId}/message`, undefined, 200);
    if (messages.some(message => message.info?.role === 'assistant'
      && message.parts?.some(part => part.text?.includes(marker)))) return;
    if (messages.some(message => message.info?.role === 'assistant'
      && message.parts?.some(part => part.text?.includes(marker.replace('_PASS', '_FAIL'))))) {
      throw Error(`governed write failed: ${phase}`);
    }
    await new Promise(done => setTimeout(done, 100));
  }
  throw Error(`governed write did not complete: ${phase}`);
}

async function browserGovernedReads(request, sessionId, primary) {
  for (const [prompt, marker] of [
    ['NND_TOOL_READ_ALLOW', 'NND_INSTALLED_READ_ALLOW_PASS'],
    [`NND_TOOL_READ_ESCAPE:${primary}\\PRIMARY_SENTINEL.txt`, 'NND_INSTALLED_READ_ESCAPE_PASS'],
  ]) {
    const body = JSON.stringify({ messageID: `tool_${crypto.randomUUID()}`, parts: [{ type: 'text', text: prompt }] });
    let accepted = false;
    for (let i = 0; i < 150; i++) {
      const response = await fetch(`/api/session/${sessionId}/prompt_async`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body,
      });
      if (response.status === 204) { accepted = true; break; }
      if (response.status !== 409) throw Error(`native tool prompt failed: ${response.status} ${await response.text()}`);
      await new Promise(done => setTimeout(done, 100));
    }
    if (!accepted) throw Error(`native session stayed busy before tool probe: ${prompt}`);
    let complete = false;
    for (let i = 0; i < 150; i++) {
      const messages = await request(`/api/session/${sessionId}/message`, undefined, 200);
      if (messages.some(message => message.info?.role === 'assistant'
        && message.parts?.some(part => part.text?.includes(marker)))) { complete = true; break; }
      if (messages.some(message => message.info?.role === 'assistant'
        && message.parts?.some(part => part.text?.includes(marker.replace('_PASS', '_FAIL'))))) {
        throw Error(`native tool scope failed: ${prompt}`);
      }
      await new Promise(done => setTimeout(done, 100));
    }
    if (!complete) throw Error(`native tool probe did not complete: ${prompt}`);
  }
}

async function browserWorktreeBefore({ primary }) {
  const jsonBody = value => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const request = async (path, init, expected) => {
    const started = Date.now(); console.info(`NND_PROBE_STEP:${path}:start`);
    const response = await fetch(path, init);
    const body = response.status === 204 ? null : await response.json();
    console.info(`NND_PROBE_STEP:${path}:${response.status}:${Date.now() - started}ms`);
    if (response.status !== expected) throw Error(`${path}: ${response.status} ${JSON.stringify(body)}`);
    return body;
  };
  const created = await request(`/api/git/worktrees?directory=${encodeURIComponent(primary)}`,
    jsonBody({ mode: 'new', branchName: `f1-installed-${crypto.randomUUID().slice(0, 8)}` }), 200);
  const worktreeRoot = created.worktree?.path;
  const worktreeId = created.workspace_id;
  if (typeof worktreeRoot !== 'string' || !/^ws_[a-f0-9]{24}$/.test(worktreeId ?? '')) throw Error('worktree was not admitted');
  const worktreeSession = await request('/api/session', jsonBody({ workspace_id: worktreeId,
    directory: worktreeRoot, title: 'Installed worktree root' }), 201);
  if (worktreeSession.projectID !== worktreeId || worktreeSession.directory.toLowerCase() !== worktreeRoot.toLowerCase()) {
    throw Error('worktree session identity mismatch');
  }
  const worktreeEscape = await fetch(`/api/fs/read?directory=${encodeURIComponent(worktreeRoot)}&path=${encodeURIComponent(`${primary}\\PRIMARY_SENTINEL.txt`)}`);
  if (worktreeEscape.status !== 403) throw Error(`worktree read escaped into primary root: ${worktreeEscape.status}`);
  await request(`/api/session/${worktreeSession.id}/prompt_async`, jsonBody({ messageID: `worktree_${crypto.randomUUID()}`,
    parts: [{ type: 'text', text: 'Reply from the installed worktree.' }] }), 204);
  for (let i = 0; i < 150; i++) {
    const messages = await request(`/api/session/${worktreeSession.id}/message`, undefined, 200);
    if (messages.some(message => message.info?.role === 'assistant'
      && message.parts?.some(part => part.text?.includes('NND_INSTALLED_REPLY')))) break;
    if (i === 149) throw Error('installed worktree turn did not complete');
    await new Promise(done => setTimeout(done, 100));
  }
  const worktreeWrite = await request(`/api/fs/write?directory=${encodeURIComponent(worktreeRoot)}`,
    jsonBody({ path: 'WORKTREE_WRITE.txt', content: 'installed-worktree' }), 200);
  if (worktreeWrite.success !== true) throw Error('worktree file write failed');
  const removal = await fetch(`/api/git/worktrees?directory=${encodeURIComponent(primary)}`, {
    method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ directory: worktreeRoot }),
  });
  if (removal.status !== 409) throw Error(`bound worktree removal was not refused: ${removal.status}`);
  return { worktreeRoot, worktreeId, worktreeSessionId: worktreeSession.id };
}

async function browserAfter({ primary, secondary, workspaceId, sessionId, worktreeRoot, worktreeId, worktreeSessionId }, governedWrite) {
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
  await governedWrite(request, sessionId, 'AFTER');
  const file = await fetch(`/api/fs/read?directory=${encodeURIComponent(secondary)}&path=SELECTED_WRITE.txt`);
  if (file.status !== 200 || await file.text() !== 'installed-selected') throw Error('selected file lost');
  const worktreeSession = await request(`/api/session/${worktreeSessionId}`, undefined, 200);
  if (worktreeSession.projectID !== worktreeId || worktreeSession.directory.toLowerCase() !== worktreeRoot.toLowerCase()) throw Error('worktree session lost after restart');
  const worktreeEscape = await fetch(`/api/fs/read?directory=${encodeURIComponent(worktreeRoot)}&path=${encodeURIComponent(`${primary}\\PRIMARY_SENTINEL.txt`)}`);
  if (worktreeEscape.status !== 403) throw Error(`restarted worktree read escaped into primary root: ${worktreeEscape.status}`);
  await request(`/api/session/${worktreeSessionId}/prompt_async`, jsonBody({ messageID: `worktree_restarted_${crypto.randomUUID()}`,
    parts: [{ type: 'text', text: 'Reply again from the worktree.' }] }), 204);
  for (let i = 0; i < 150; i++) {
    const messages = await request(`/api/session/${worktreeSessionId}/message`, undefined, 200);
    const replies = messages.filter(message => message.info?.role === 'assistant'
      && message.parts?.some(part => part.text?.includes('NND_INSTALLED_REPLY')));
    if (replies.length >= 2) break;
    if (i === 149) throw Error('installed worktree turn did not resume');
    await new Promise(done => setTimeout(done, 100));
  }
  const worktreeFile = await fetch(`/api/fs/read?directory=${encodeURIComponent(worktreeRoot)}&path=WORKTREE_WRITE.txt`);
  if (worktreeFile.status !== 200 || await worktreeFile.text() !== 'installed-worktree') throw Error('worktree file lost');
  const worktreeDelete = await request(`/api/fs/delete?directory=${encodeURIComponent(worktreeRoot)}`,
    jsonBody({ path: 'WORKTREE_WRITE.txt' }), 200);
  if (worktreeDelete.success !== true) throw Error('worktree fixture file could not be removed');
  await request(`/api/session/${worktreeSessionId}`, { method: 'DELETE' }, 200);
  await request(`/api/git/worktrees?directory=${encodeURIComponent(primary)}`, {
    method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ directory: worktreeRoot }),
  }, 200);
  const afterRemoval = await request('/api/v1/nnd/workspaces/admissions', undefined, 200);
  if (afterRemoval.admitted.some(item => item.id === worktreeId || item.root.toLowerCase() === worktreeRoot.toLowerCase())
    || afterRemoval.unavailable?.some(item => item.id === worktreeId || item.root.toLowerCase() === worktreeRoot.toLowerCase())) {
    throw Error('removed worktree remains in the native admission inventory');
  }
  const stale = await fetch('/api/session', jsonBody({ workspace_id: worktreeId, directory: worktreeRoot }));
  if (stale.status !== 409) throw Error(`stale worktree ID did not receive native selection refusal: ${stale.status}`);
  return { resumed: true };
}

function afterProbe(payload) {
  return checkedProbe(`(${browserAfter.toString()})(${JSON.stringify(payload)}, ${browserGovernedWrite.toString()})`);
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
      [], checkedProbe(`(async roots => ({ ...await (${browserSelectedBefore.toString()})(roots, ${browserGovernedReads.toString()}, ${browserGovernedWrite.toString()}), ...await (${browserWorktreeBefore.toString()})(roots) }))(${JSON.stringify(roots)})`));
    assert.equal(await readFile(join(roots.secondary, 'SELECTED_WRITE.txt'), 'utf8'), 'installed-selected');
    await assert.rejects(readFile(join(roots.primary, 'SELECTED_WRITE.txt')), { code: 'ENOENT' });
    assert.equal(await readFile(join(roots.secondary, 'SELECTED_GOVERNED_BEFORE.txt'), 'utf8'), 'governed-selected-before');
    await assert.rejects(readFile(join(roots.primary, 'SELECTED_GOVERNED_BEFORE.txt')), { code: 'ENOENT' });
    assert.equal(await readFile(join(before.worktreeRoot, 'WORKTREE_WRITE.txt'), 'utf8'), 'installed-worktree');
    await assert.rejects(readFile(join(roots.secondary, 'WORKTREE_WRITE.txt')), { code: 'ENOENT' });
    await cli(fixture, 'stop'); await waitStopped(fixture); stopped = true;
    // The start acknowledgment can fail after spawning the native owner.
    stopped = false;
    const restartStatus = await cli(fixture, 'start');
    const restarted = await waitReady(fixture, restartStatus);
    assert.equal(restarted.service_state, 'ready', `restarted native runtime did not activate: ${JSON.stringify(restarted)}`);
    const result = await shell(fixture, 'browser', restarted.endpoint, (await cli(fixture, 'ui-ticket')).ticket,
      [], afterProbe({ ...roots, ...before }));
    assert.equal(result.resumed, true);
    assert.equal(await readFile(join(roots.secondary, 'SELECTED_GOVERNED_AFTER.txt'), 'utf8'), 'governed-selected-after');
    await assert.rejects(readFile(join(roots.primary, 'SELECTED_GOVERNED_AFTER.txt')), { code: 'ENOENT' });
    for (const phase of ['BEFORE', 'AFTER']) assert.ok(fake.reviews.some(review => review.phase === phase && review.approved), `${phase} governed write lacked exact reviewer approval`);
    assert.ok(fake.requests.length >= 4, 'selected and worktree provider turns did not cross installed restart');
    await assert.rejects(readFile(before.worktreeRoot), { code: 'ENOENT' });
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
  process.stdout.write('Installed multi-root browser/desktop, selected and worktree restart turns passed.\n');
}

afterProbe({});
if (process.argv.length !== 3) throw Error('usage: node scripts/installed-multi-root-acceptance.mjs ABSOLUTE_NNA_SOURCE');
await main(resolve(process.argv[2]));
