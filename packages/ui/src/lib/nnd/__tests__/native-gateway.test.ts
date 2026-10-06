// SPDX-License-Identifier: Apache-2.0
import { beforeEach, expect, it, vi, type Mock } from 'vitest';
vi.mock('../../runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));
import { runtimeFetch } from '../../runtime-fetch.ts';
import { nativeGatewayOperations, nativeGatewayRequest, parseNativeGatewayView, previewNativeGateway,
  projectNativeGatewayOperations, readNativeGateway, readNativeGatewayCatalog, inspectNativeGatewayOperation,
  NativeGatewayFailure, type NativeGatewayView } from '../native-gateway.ts';

const fetchMock = runtimeFetch as unknown as Mock;
const revision = 'a'.repeat(64);
const view: NativeGatewayView = { schema_version: '1.0', installation_id: 'install_gateway', data_id: 'data_gateway',
  scope: 'user', source_state: 'present', source_revision: revision, resolution_revision: revision,
  project_shadowed: false, version: 1, enabled: true, token_present: false, token_env: 'NNA_TELEGRAM_BOT_TOKEN',
  authorized_user_ids: ['123'], workspace_root: null, polling_timeout_seconds: 25, updated_at: null,
  application: 'not_applied' };
const field = (path: string, extra: Record<string, unknown> = {}) => ({ path, application: 'restart_gateway',
  ...extra, editability: extra.editability ?? { available: true, scope: 'user',
    required_permission: 'nnd.configuration.manage' } });
const catalog = { schema_version: '1.0', source: 'gateway', scope: 'user', fields: [
  field('version', { classification: 'generated_state', editability: { available: false, scope: 'user', reason: 'generated_state' } }),
  field('updated_at', { classification: 'generated_state', editability: { available: false, scope: 'user', reason: 'generated_state' } }),
  field('enabled', { classification: 'operator_setting' }),
  field('token', { classification: 'operator_setting', sensitivity: 'secret' }),
  field('token_env', { classification: 'operator_setting' }),
  field('authorized_user_ids', { classification: 'authority_grant' }),
  field('workspace_root', { classification: 'operator_setting' }),
  field('polling_timeout_seconds', { classification: 'operator_setting' })] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
beforeEach(() => fetchMock.mockReset());

it('accepts the family view while dropping unknown private response fields', async () => {
  fetchMock.mockResolvedValueOnce(json({ ...view, token: 'PRIVATE', updated_at: '2026-10-05T12:00:00Z' }));
  const result = await readNativeGateway(new AbortController().signal);
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
  expect(result.updated_at).toBe('2026-10-05T12:00:00Z');
  expect([...result.authorized_user_ids]).toEqual(['123']);
  expect(() => parseNativeGatewayView({ ...view, polling_timeout_seconds: 51 })).toThrow('nnd_gateway_timeout_view_invalid');
  expect(() => parseNativeGatewayView({ ...view, enabled: 'yes' })).toThrow('nnd_gateway_timeout_view_invalid');
  expect(() => parseNativeGatewayView({ ...view, authorized_user_ids: ['0x4f'] })).toThrow('nnd_gateway_timeout_view_invalid');
  expect(() => parseNativeGatewayView({ ...view, version: 2 })).toThrow('nnd_gateway_timeout_view_invalid');
  // Workspace reads mirror the projector bound (any string up to 4096 or null), not the setter.
  expect(parseNativeGatewayView({ ...view, workspace_root: 'relative/path' }).workspace_root).toBe('relative/path');
  expect(parseNativeGatewayView({ ...view, workspace_root: '' }).workspace_root).toBe('');
  expect(() => parseNativeGatewayView({ ...view, workspace_root: 'x'.repeat(4097) })).toThrow('nnd_gateway_timeout_view_invalid');
  // The stamp parser mirrors the NNA projector's bound, not stricter ISO grammar.
  expect(parseNativeGatewayView({ ...view, updated_at: '2026-10-06T031527.999Z' }).updated_at)
    .toBe('2026-10-06T031527.999Z');
  expect(() => parseNativeGatewayView({ ...view, updated_at: '2026-10-06T03:15:27Z!' })).toThrow('nnd_gateway_timeout_view_invalid');
});

it('requires the exact eight-field family catalog and rejects the legacy single-field catalog', async () => {
  fetchMock.mockResolvedValueOnce(json(catalog));
  expect((await readNativeGatewayCatalog(new AbortController().signal)).fields).toHaveLength(8);
  fetchMock.mockResolvedValueOnce(json({ schema_version: '1.0', source: 'gateway', scope: 'user',
    fields: [catalog.fields[7]] }));
  await expect(readNativeGatewayCatalog(new AbortController().signal))
    .rejects.toThrow('nnd_gateway_timeout_view_invalid');
});

it('composes bounded operation batches and never sends a legacy flat request', () => {
  const ops = nativeGatewayOperations([{ op: 'set', field: 'polling_timeout_seconds', value: 30 },
    { op: 'reset', field: 'workspace_root' }, { op: 'set_token', token: 'unified-token-above-twenty' },
    { op: 'clear_token' }, { op: 'authorize', user_id: '55' }, { op: 'revoke', user_id: '55' }]);
  expect(ops).toHaveLength(6);
  for (const rejection of [
    [{ op: 'set', field: 'enabled', value: 'yes' }], [{ op: 'set', field: 'token', value: 'x' }],
    [{ op: 'set_token', token: 'short' }], [{ op: 'authorize', user_id: 'abc' }],
    [{ op: 'authorize', user_id: '0' }], [{ op: 'authorize', user_id: '007' }],
    [{ op: 'authorize' }], [{ op: 'clear_token', extra: true }],
    [{ op: 'set', field: 'toString', value: 'hostile' }], [{ op: 'set', field: '__proto__', value: true }],
  ]) {
    expect(() => nativeGatewayOperations(rejection as unknown[])).toThrow('nnd_gateway_timeout_request_invalid');
  }
  expect(() => nativeGatewayOperations(Array.from({ length: 17 }, () => ({ op: 'clear_token' })))).toThrow('nnd_gateway_timeout_request_invalid');
  const request = nativeGatewayRequest(view, ops);
  expect(request.operations).toHaveLength(6);
  expect(Object.keys(request).sort()).toEqual(['data_id', 'expected_resolution_revision', 'expected_revision',
    'installation_id', 'operations', 'scope']);
  expect(() => nativeGatewayRequest({ ...view, project_shadowed: true } as never, ops)).toThrow('nnd_gateway_timeout_request_invalid');
});

it('accepts a preview only when the server candidate equals the local operation mirror', async () => {
  // The allowlist mirror reproduces NNA's lexicographic normalization.
  const mirror = projectNativeGatewayOperations({ ...view, authorized_user_ids: ['10', '9'] },
    nativeGatewayOperations([{ op: 'authorize', user_id: '5' }]));
  expect([...mirror.authorized_user_ids]).toEqual(['10', '5', '9']);
  const ops = nativeGatewayOperations([{ op: 'set', field: 'polling_timeout_seconds', value: 30 },
    { op: 'authorize', user_id: '55' }]);
  const request = nativeGatewayRequest(view, ops);
  const candidate = projectNativeGatewayOperations(view, ops);
  fetchMock.mockResolvedValueOnce(json({ valid: true, expected_revision: revision, resolution_revision: revision,
    application: 'not_applied', view: { ...candidate, token: 'PRIVATE' } }));
  const result = await previewNativeGateway(request, view, new AbortController().signal);
  expect(result.polling_timeout_seconds).toBe(30);
  expect([...result.authorized_user_ids]).toEqual(['123', '55']);
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
  fetchMock.mockResolvedValueOnce(json({ valid: true, expected_revision: revision, resolution_revision: revision,
    application: 'not_applied', view: { ...candidate, workspace_root: 'D:/elsewhere' } }));
  await expect(previewNativeGateway(request, view, new AbortController().signal))
    .rejects.toThrow('nnd_gateway_timeout_view_invalid');
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

it('raises the bounded body and response limits for the wider family payload', async () => {
  const longWorkspace = 'D:/' + 'sector/'.repeat(570);
  const ops = nativeGatewayOperations([{ op: 'set', field: 'workspace_root', value: longWorkspace }]);
  const request = nativeGatewayRequest(view, ops);
  expect(new TextEncoder().encode(JSON.stringify(request)).byteLength).toBeGreaterThan(4096);
  const candidate = projectNativeGatewayOperations(view, ops);
  fetchMock.mockResolvedValueOnce(json({ valid: true, expected_revision: revision, resolution_revision: revision,
    application: 'not_applied', view: candidate }));
  expect((await previewNativeGateway(request, view, new AbortController().signal)).workspace_root).toBe(longWorkspace);
  const oversized = json({ schema_version: '1.0', oversized: 'b'.repeat(9000) });
  fetchMock.mockResolvedValueOnce(oversized);
  await expect(readNativeGateway(new AbortController().signal)).rejects.toBeInstanceOf(NativeGatewayFailure);
});
