// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ContractError } from '../src/ids.js';
import { assertNndAttach } from '../src/nnd-service-attach.js';

async function privateProbe(dependencies) {
  const source = await readFile(new URL('../src/nnd-activation-private-ticket.js', import.meta.url), 'utf8');
  const executable = source.replace(/^import\s[\s\S]*?;\r?\n/gm, '').replaceAll('export async function', 'async function');
  return Function(...Object.keys(dependencies), executable + '\nreturn probeNndPrivateTicketUnderOwnership;')
    (...Object.values(dependencies));
}

async function fixture(t, { replayAccepted = false, changeHealth = false, redirectBootstrapTo = null,
  redirectSessionTo = null, oversizedBootstrap = false } = {}) {
  const ticket = 't'.repeat(43); let redemptions = 0, commands = 0, healthChecks = 0;
  const server = createServer(async (request, response) => {
    if (request.url === '/auth/native-bootstrap' && request.method === 'POST') {
      let body = ''; for await (const chunk of request) body += chunk;
      if (JSON.parse(body).ticket !== ticket || request.headers.origin !== endpoint) {
        response.writeHead(401); response.end('{}'); return;
      }
      if (redirectBootstrapTo) { response.writeHead(302, { location: redirectBootstrapTo }); response.end(); return; }
      redemptions++;
      response.writeHead(redemptions === 1 || replayAccepted ? 200 : 401,
        redemptions === 1 || replayAccepted ? { 'set-cookie': 'oc_ui_session=fake.jwt.signature; Path=/; HttpOnly; SameSite=Strict' } : {});
      response.end(oversizedBootstrap ? JSON.stringify({ authenticated: true, padding: 'x'.repeat(5000) })
        : JSON.stringify({ authenticated: redemptions === 1 || replayAccepted })); return;
    }
    if (request.url === '/auth/session' && request.headers.cookie === 'oc_ui_session=fake.jwt.signature') {
      if (redirectSessionTo) { response.writeHead(302, { location: redirectSessionTo }); response.end(); return; }
      response.writeHead(200); response.end(JSON.stringify({ authenticated: true })); return;
    }
    response.writeHead(404); response.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const identity = { data_root: join(tmpdir(), 'nnd-private-ticket'), installation_id: `nna_${'a'.repeat(64)}`,
    data_id: `data_${'b'.repeat(64)}` };
  const serviceLease = {}, registryLease = {};
  const options = { operationId: 'operation', stageOperationId: 'stage', generation: 'generation' };
  const evidence = { operation_id: 'operation', stage_operation_id: 'stage', generation: 'generation',
    registration_revision: 'c'.repeat(64), journal_sha256: 'd'.repeat(64), native_state: 'ready' };
  const state = { identity, lease: serviceLease, unpublishedTrial: true, published: false, stopping: false,
    ui: endpoint, record: { instance_id: 'generation', installation_id: identity.installation_id,
      data_id: identity.data_id }, controller: { isListening: () => true },
    native: { isListening: () => true, selectedPrincipalEvidence: () => evidence },
    child: { failed: false, child: { exitCode: null }, async command(action) {
      assert.equal(action, 'issue_ui_ticket'); commands++;
      return { type: 'ui_ticket', protocol: '1.0', generation: 'generation', request_id: 'request',
        ticket, expires_at: new Date(Date.now() + 60000).toISOString() };
    } } };
  const health = () => ({ ...evidence, state: 'published_healthy_unresolved',
    journal_sha256: changeHealth && ++healthChecks === 2 ? 'e'.repeat(64) : evidence.journal_sha256 });
  const api = await privateProbe({ join, resolve, ContractError,
    assertHeldNndServiceLease: lease => { if (lease !== serviceLease) throw Error('service lease lost'); },
    withNndServiceLease: (_lease, _id, work) => work(new AbortController().signal),
    assertManifestLease: lease => { if (lease !== registryLease) throw Error('registry lease lost');
      return { path: join(identity.data_root, 'config', 'nnd-package.json') }; },
    runManifestLeaseWork: (_lease, work) => work(), assertNndAttach,
    verifyNndPublishedTrialHealthUnderOwnership: async () => health() });
  return { run: () => api(identity, state, serviceLease, registryLease, options), state, options,
    get commands() { return commands; }, get redemptions() { return redemptions; } };
}

test('private selected trial redeems exactly one ticket without returning credentials', async t => {
  const f = await fixture(t);
  const result = await f.run();
  assert.deepEqual(result, { state: 'private_ticket_verified_unresolved', operation_id: 'operation',
    generation: 'generation', registration_revision: 'c'.repeat(64), journal_sha256: 'd'.repeat(64) });
  assert.equal(f.commands, 1); assert.equal(f.redemptions, 2);
  assert.equal(JSON.stringify(result).includes('t'.repeat(43)), false);
  assert.equal(f.state.published, false);
  await assert.rejects(f.run(), { code: 'nnd_activation_health_invalid' });
  assert.equal(f.commands, 1);
});

test('replay acceptance or changed post-redemption health remains unresolved and cannot request again', async t => {
  for (const option of [{ replayAccepted: true }, { changeHealth: true }]) {
    const f = await fixture(t, option);
    await assert.rejects(f.run(), { code: 'nnd_activation_health_invalid' });
    assert.equal(f.commands, 1);
    await assert.rejects(f.run(), { code: 'nnd_activation_health_invalid' });
    assert.equal(f.commands, 1);
  }
});

test('ticket and cookie are never forwarded across a redirect, and oversized responses fail closed', async t => {
  let reflected = 0;
  const foreign = createServer((request, response) => { reflected++; response.writeHead(200); response.end('{}'); });
  await new Promise(resolve => foreign.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => foreign.close(resolve)));
  const target = `http://127.0.0.1:${foreign.address().port}/capture`;
  for (const option of [{ redirectBootstrapTo: target }, { redirectSessionTo: target }, { oversizedBootstrap: true }]) {
    const f = await fixture(t, option);
    await assert.rejects(f.run(), { code: 'nnd_activation_health_invalid' });
    await assert.rejects(f.run(), { code: 'nnd_activation_health_invalid' });
    assert.equal(f.commands, 1, 'A failed probe must not mint a second ticket');
  }
  assert.equal(reflected, 0, 'Neither ticket nor session cookie may reach a redirected endpoint');
});
