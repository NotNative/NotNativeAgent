// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('nnd CLI child serves authenticated bootstrap and session projections', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-nnd-process-'));
  await mkdir(join(root, 'config'), { recursive: true });
  await writeFile(join(root, 'config', 'manifest.json'), JSON.stringify({
    format_version: 1, persistence: 'durable', workspace_root: root,
    providers: [{ id: 'primary', display_name: 'Primary', endpoint: 'http://127.0.0.1:1234/v1', model: 'test', trust_zone: 'loopback' }],
    routes: { primary: { provider_id: 'primary', model: 'test' } },
  }));
  const child = spawn(process.execPath, ['src/cli.js', 'nnd', 'serve'], {
    cwd: new URL('..', import.meta.url), env: { ...process.env, NNA_HOME: root },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let diagnostics = '';
  let createdId;
  child.stderr.on('data', (chunk) => { diagnostics = `${diagnostics}${chunk}`.slice(-2048); });
  try {
    const frame = await readiness(child);
    assert.equal(frame.type, 'ready');
    assert.equal(frame.protocol, '1.0');
    assert.match(frame.endpoint, /^http:\/\/127\.0\.0\.1:\d+$/u);
    const headers = { authorization: `Bearer ${frame.token}`, 'x-nna-principal': principal() };
    const denied = await fetch(`${frame.endpoint}/global/health`, { signal: AbortSignal.timeout(5_000) });
    assert.equal(denied.status, 401);
    const health = await fetch(`${frame.endpoint}/global/health`, { headers, signal: AbortSignal.timeout(5_000) });
    assert.equal(health.status, 200);
    assert.equal((await health.json()).healthy, true);
    const sessions = await fetch(`${frame.endpoint}/session`, { headers, signal: AbortSignal.timeout(5_000) });
    assert.equal(sessions.status, 200);
    assert.deepEqual(await sessions.json(), []);
    const created = await fetch(`${frame.endpoint}/session`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'CLI contract' }), signal: AbortSignal.timeout(5_000),
    });
    assert.equal(created.status, 201);
    const session = await created.json();
    createdId = session.id;
    assert.equal(session.title, 'CLI contract');
    assert.equal(session.directory, root);
    assert.match(session.id, /^ses_[A-Za-z0-9_-]+$/u);
    const listed = await fetch(`${frame.endpoint}/session`, { headers, signal: AbortSignal.timeout(5_000) });
    assert.deepEqual((await listed.json()).map((entry) => [entry.id, entry.directory]), [[session.id, root]]);
    const messages = await fetch(`${frame.endpoint}/session/${session.id}/message`, { headers, signal: AbortSignal.timeout(5_000) });
    assert.equal(messages.status, 200);
    assert.deepEqual(await messages.json(), []);
    const controls = { ...headers, 'x-nna-principal': principal(['nnd.read', 'nnd.session.create', 'nnd.session.update', 'nnd.session.abort', 'nnd.session.delete']) };
    const disposable = await fetch(`${frame.endpoint}/session`, {
      method: 'POST', headers: { ...controls, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Disposable' }), signal: AbortSignal.timeout(5_000),
    });
    assert.equal(disposable.status, 201);
    const disposableId = (await disposable.json()).id;
    const renamed = await fetch(`${frame.endpoint}/session/${disposableId}`, {
      method: 'PATCH', headers: { ...controls, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Renamed disposable' }), signal: AbortSignal.timeout(5_000),
    });
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json()).title, 'Renamed disposable');
    const aborted = await fetch(`${frame.endpoint}/session/${disposableId}/abort`, {
      method: 'POST', headers: controls, signal: AbortSignal.timeout(5_000),
    });
    assert.equal(aborted.status, 200);
    assert.equal(await aborted.json(), true);
    const deleted = await fetch(`${frame.endpoint}/session/${disposableId}`, {
      method: 'DELETE', headers: controls, signal: AbortSignal.timeout(5_000),
    });
    assert.equal(deleted.status, 200);
    assert.equal(await deleted.json(), true);
    const remaining = await fetch(`${frame.endpoint}/session`, { headers, signal: AbortSignal.timeout(5_000) });
    assert.deepEqual((await remaining.json()).map((entry) => entry.id), [createdId]);
  } catch (error) {
    throw new Error(`NND child contract failed: ${error.message}; stderr: ${diagnostics}`);
  } finally {
    await stopChild(child);
  }
  const reopened = spawn(process.execPath, ['src/cli.js', 'nnd', 'serve'], {
    cwd: new URL('..', import.meta.url), env: { ...process.env, NNA_HOME: root },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  reopened.stderr.resume();
  try {
    const frame = await readiness(reopened);
    const headers = { authorization: `Bearer ${frame.token}`, 'x-nna-principal': principal() };
    const listed = await fetch(`${frame.endpoint}/session`, { headers, signal: AbortSignal.timeout(5_000) });
    assert.equal(listed.status, 200);
    assert.deepEqual((await listed.json()).map((entry) => [entry.id, entry.directory]), [[createdId, root]]);
  } finally {
    await stopChild(reopened);
  }
});

function principal(permissions = ['nnd.read', 'nnd.session.create']) {
  return Buffer.from(JSON.stringify({
    subject_id: 'local-operator', platform_role: 'operator', permissions,
    workspace_ids: ['local'], group_ids: [], trace_id: 'trace', request_id: 'request',
    issued_at: new Date().toISOString(),
  })).toString('base64url');
}

function readiness(child) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const finish = (error, frame) => {
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
      if (error) reject(error); else resolve(frame);
    };
    const onData = (chunk) => {
      buffer += chunk;
      if (buffer.length > 16_384) return finish(new Error('readiness too large'));
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try { finish(null, JSON.parse(buffer.slice(0, newline))); } catch (error) { finish(error); }
    };
    const onExit = (code) => finish(new Error(`child exited ${code}`));
    const onError = (error) => finish(error);
    const timeout = setTimeout(() => finish(new Error('readiness timed out')), 10_000);
    child.stdout.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const onClose = () => { clearTimeout(force); clearTimeout(deadline); resolve(); };
    child.once('close', onClose);
    const force = setTimeout(() => { child.kill('SIGKILL'); }, 3_000);
    const deadline = setTimeout(() => { child.off('close', onClose); reject(new Error('NND child did not exit after termination')); }, 5_000);
    child.kill();
  });
}
