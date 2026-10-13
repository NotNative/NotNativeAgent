// SPDX-License-Identifier: Apache-2.0
/** Disposable installed-payload composition, without changing operator installations. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSupervisedFixture, removeSupervisedFixture } from './supervised-smoke-fixture.mjs';
import { withTimeout } from './smoke-http.mjs';

async function firstFrame(child) {
  let buffer = '';
  return withTimeout(new Promise((resolve, reject) => {
    const read = (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 65_536) return reject(new Error('Supervisor output exceeded its bound'));
      if (buffer.includes('\n')) {
        child.stdout.off('data', read);
        try { resolve(JSON.parse(buffer.slice(0, buffer.indexOf('\n')))); } catch (error) { reject(error); }
      }
    };
    child.stdout.on('data', read); child.once('error', reject);
    child.once('exit', () => reject(new Error('Supervisor exited before readiness')));
  }), 30_000, 'Supervisor startup exceeded its bound');
}
async function cli(fixture, action) {
  const child = spawn(process.execPath, [fixture.cli, 'nnd', 'service', action, fixture.install],
    { windowsHide: true, env: { ...process.env, NNA_HOME: fixture.data }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); if (output.length > 65_536) child.kill(); });
  child.stderr.on('data', () => {});
  try { assert.equal((await withTimeout(exited, 15_000, 'Controller CLI timeout'))[0], 0); }
  catch (error) {
    child.kill();
    await withTimeout(exited, 5000, 'Owned controller CLI cleanup timeout');
    throw error;
  }
  return JSON.parse(output.trim());
}
async function checkGui(endpoint, ticket) {
  const options = { signal: AbortSignal.timeout(5000), redirect: 'error' };
  const locked = await fetch(`${endpoint}/auth/session`, options);
  assert.equal((await locked.json()).authenticated, false);
  const redeem = await fetch(`${endpoint}/auth/native-bootstrap`, { ...options, method: 'POST',
    headers: { origin: endpoint, 'content-type': 'application/json' }, body: JSON.stringify({ ticket }) });
  assert.equal(redeem.status, 200);
  const cookie = redeem.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
  const session = await fetch(`${endpoint}/auth/session`, { ...options, headers: { cookie } });
  assert.equal((await session.json()).authenticated, true);
  const replay = await fetch(`${endpoint}/auth/native-bootstrap`, { ...options, method: 'POST',
    headers: { origin: endpoint, 'content-type': 'application/json' }, body: JSON.stringify({ ticket }) });
  assert.equal(replay.status, 401);
  const blocked = await fetch(`${endpoint}/api/session`, { ...options, headers: { cookie } });
  assert.equal(blocked.status, 503, 'Fresh setup must not admit native session execution');
}
async function main(nna) {
  const nnd = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const fixture = await createSupervisedFixture(nna, nnd);
  let child, exited, stopped = false;
  try {
    child = spawn(process.execPath, [fixture.cli, 'nnd', 'service', 'run', fixture.install],
      { windowsHide: true, env: { ...process.env, NNA_HOME: fixture.data }, stdio: ['ignore', 'pipe', 'pipe'] });
    exited = once(child, 'exit'); child.stderr.on('data', () => {});
    const status = await firstFrame(child);
    assert.equal(status.service_state, 'setup_required'); assert.equal(status.provider_state, 'unknown');
    assert.ok(!JSON.stringify(status).includes('token'), 'Public status leaked credential fields');
    const current = await cli(fixture, 'status'); assert.equal(current.instance_id, status.instance_id);
    const ticket = await cli(fixture, 'ui-ticket');
    await checkGui(status.endpoint, ticket.ticket);
    await cli(fixture, 'stop');
    assert.equal((await withTimeout(exited, 15_000, 'Supervisor did not stop'))[0], 0); stopped = true;
    await assert.rejects(fetch(`${status.endpoint}/auth/session`, { signal: AbortSignal.timeout(1000) }));
    process.stdout.write('Supervised installed-payload smoke passed: native ownership, setup-required browser auth, one-use ticket, guarded execution and controller stop.\n');
  } finally {
    if (child && !stopped) {
      try {
        await cli(fixture, 'stop');
        assert.equal((await withTimeout(exited, 15_000, 'Owned supervisor cleanup timeout'))[0], 0);
        stopped = true;
      } catch {
        child.kill();
        await withTimeout(exited, 10_000, 'Owned supervisor termination timeout').catch(() => {});
        process.stderr.write(`Cleanup incomplete; preserved disposable fixture: ${fixture.root}\n`);
      }
    }
    if (stopped || !child) await removeSupervisedFixture(fixture.root);
  }
}
if (process.platform !== 'win32' || !process.argv[2]) throw new Error('usage: Windows node scripts/nna-supervised-smoke.mjs ABSOLUTE_NNA_SOURCE');
await main(resolve(process.argv[2]));
