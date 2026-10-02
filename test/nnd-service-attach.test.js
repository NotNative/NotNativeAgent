// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { issueNndAttach, assertNndAttach, assertSelectedNndStatus, nndServiceCapabilities } from '../src/nnd-service-attach.js';
import { startNndController, requestNndController } from '../src/nnd-service-controller.js';

const record = { installation_id: `nna_${'a'.repeat(64)}`, data_id: `data_${'b'.repeat(64)}`,
  instance_id: 'generation-1', control_token: 'c'.repeat(43) };
const status = () => ({ service_state: 'setup_required', failure_code: 'nnd_setup_required',
  installation_id: record.installation_id, data_id: record.data_id, instance_id: record.instance_id,
  endpoint: 'http://127.0.0.1:3456', package_version: '20261002-2', protocol: '1.0', runtime_state: 'ready',
  package_state: 'ready', provider_state: 'unknown', setup_guidance: 'Configure NNA.' });
const ticket = () => ({ type: 'ui_ticket', protocol: '1.0', generation: record.instance_id,
  request_id: 'request-1', ticket: 't'.repeat(43), expires_at: new Date(Date.now() + 60000).toISOString() });

test('atomic attach exposes only UI credential bound to selected generation and origin', async () => {
  const result = await issueNndAttach(record, status, async () => ticket());
  assert.deepEqual(Object.keys(result).sort(), ['protocol', 'installation_id', 'data_id', 'generation', 'endpoint', 'ticket', 'expires_at'].sort());
  assert.equal(result.endpoint, status().endpoint); assert.equal(result.generation, record.instance_id);
  assert.equal(JSON.stringify(result).includes(record.control_token), false);
});
test('stop or generation change during ticket issuance rejects attachment', async () => {
  let changed = false;
  const stopping = () => changed ? { ...status(), service_state: 'stopping', endpoint: null, failure_code: null, setup_guidance: null } : status();
  await assert.rejects(issueNndAttach(record, stopping, async () => { changed = true; return ticket(); }), { code: 'nnd_health_unavailable' });
  await assert.rejects(issueNndAttach(record, status, async () => ({ ...ticket(), generation: 'different' })), { code: 'nnd_service_protocol_invalid' });
});
test('status and attachment reject extra secret fields, changed identity and stale tickets', async () => {
  const attached = await issueNndAttach(record, status, async () => ticket());
  for (const invalid of [{ ...attached, control_token: 'secret' }, { ...attached, installation_id: 'other' },
    { ...attached, expires_at: new Date(Date.now() - 1).toISOString() }, { ...attached, endpoint: 'https://example.com' }]) {
    assert.throws(() => assertNndAttach(invalid, record), { code: 'nnd_service_protocol_invalid' });
  }
  assert.throws(() => assertSelectedNndStatus({ ...status(), data_id: 'other' }, record), { code: 'nnd_service_protocol_invalid' });
  assert.throws(() => assertSelectedNndStatus({ ...status(), token: 'secret' }, record), { code: 'nnd_service_protocol_invalid' });
});
test('authenticated controller attachment requires exact generation and selected status identity', async () => {
  const controller = await startNndController({ getRecord: () => record, status, stop() {}, ticket: async () => ticket() });
  const discovery = { ...record, endpoint: controller.endpoint };
  try {
    assert.equal((await requestNndController(discovery, 'attach')).generation, record.instance_id);
    await assert.rejects(requestNndController({ ...discovery, instance_id: 'other' }, 'attach'), { code: 'nnd_health_unavailable' });
    await assert.rejects(requestNndController({ ...discovery, installation_id: 'other' }, 'status'), { code: 'nnd_health_unavailable' });
    assert.equal((await fetch(`${controller.endpoint}/attach`, { method: 'POST' })).status, 401);
  } finally { await controller.close(); }
});
test('capabilities identify native installation without credentials or runtime requirements', () => {
  const result = nndServiceCapabilities({ ...record, version: '20261002-2' });
  assert.equal(result.native_version, '20261002-2'); assert.ok(result.capabilities.includes('atomic_ui_attach'));
  assert.equal(Object.hasOwn(result, 'control_token'), false); assert.equal(Object.hasOwn(result, 'instance_id'), false);
});
