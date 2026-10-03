// SPDX-License-Identifier: Apache-2.0
import { beforeEach, expect, it, vi, type Mock } from 'vitest';
vi.mock('../../runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));
import { runtimeFetch } from '../../runtime-fetch.ts';
import { nativeGatewayRequest, parseNativeGatewayView, previewNativeGateway, readNativeGateway,
  readNativeGatewayCatalog, inspectNativeGatewayOperation, type NativeGatewayView } from '../native-gateway.ts';

const fetchMock = runtimeFetch as unknown as Mock;
const revision = 'a'.repeat(64);
const view: NativeGatewayView = { schema_version: '1.0', installation_id: 'install_gateway', data_id: 'data_gateway',
  scope: 'user', source_state: 'present', source_revision: revision, resolution_revision: revision,
  project_shadowed: false, polling_timeout_seconds: 25, application: 'not_applied' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
beforeEach(() => fetchMock.mockReset());

it('accepts the bounded timeout view while dropping unknown private response fields', async () => {
  fetchMock.mockResolvedValueOnce(json({ ...view, token: 'PRIVATE', authorized_user_ids: ['123'], enabled: true }));
  const result = await readNativeGateway(new AbortController().signal);
  expect(result.polling_timeout_seconds).toBe(25);
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
  expect(result).not.toHaveProperty('authorized_user_ids');
  expect(() => parseNativeGatewayView({ ...view, polling_timeout_seconds: 51 })).toThrow('nnd_gateway_timeout_view_invalid');
});

it('requires the exact native editable catalog and sends only a revision-bound timeout intent', async () => {
  const catalog = { schema_version: '1.0', source: 'gateway', scope: 'user', fields: [{ path: 'polling_timeout_seconds',
    classification: 'operator_setting', type: 'integer', minimum: 5, maximum: 50, application: 'restart_gateway',
    editability: { available: true, scope: 'user', required_permission: 'nnd.configuration.manage' } }] };
  fetchMock.mockResolvedValueOnce(json(catalog));
  expect((await readNativeGatewayCatalog(new AbortController().signal)).fields).toHaveLength(1);
  const request = nativeGatewayRequest(view, 30);
  fetchMock.mockResolvedValueOnce(json({ valid: true, expected_revision: revision, resolution_revision: revision,
    application: 'not_applied', view: { ...view, polling_timeout_seconds: 30, token: 'PRIVATE' } }));
  expect((await previewNativeGateway(request, new AbortController().signal)).polling_timeout_seconds).toBe(30);
  const [path, init] = fetchMock.mock.calls[1] as [string, RequestInit];
  expect(path).toBe('/api/v1/nnd/configuration/gateway/preview');
  expect(JSON.parse(String(init.body))).toEqual(request);
  expect(String(init.body)).not.toContain('token');
  expect(() => nativeGatewayRequest(view, 51)).toThrow('nnd_gateway_timeout_request_invalid');
});

it('keeps operation lookup tied to selected identity and projects no private fields', async () => {
  fetchMock.mockResolvedValueOnce(json({ installation_id: view.installation_id, data_id: view.data_id,
    scope: 'user', operation_id: 'op_1', persistence: 'saved', persisted_revision: 'b'.repeat(64),
    before_revision: revision, application: 'not_applied', next_action: 'restart_gateway', replayed: true,
    replay_window: 'last_128_operations', token: 'PRIVATE' }));
  const receipt = await inspectNativeGatewayOperation(view, 'op_1', new AbortController().signal);
  expect(receipt?.persistence).toBe('saved'); expect(JSON.stringify(receipt)).not.toContain('PRIVATE');
  fetchMock.mockResolvedValueOnce(json({ ...receipt, data_id: 'foreign' }));
  await expect(inspectNativeGatewayOperation(view, 'op_1', new AbortController().signal))
    .rejects.toThrow('nnd_gateway_timeout_view_invalid');
});
