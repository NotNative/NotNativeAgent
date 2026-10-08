// SPDX-License-Identifier: Apache-2.0
import { beforeEach, expect, it, vi } from 'vitest';
import { runtimeFetch } from '../../runtime-fetch.ts';
import { addNativeWorkspace } from '../workspace-admission.ts';

vi.mock('../../runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

const root = 'C:\\Repos\\Second';
const id = `ws_${'a'.repeat(24)}`;
const inventory = (operationId?: string) => ({ installation_id: 'install', data_id: 'data',
  revision: 'absent', selection_enabled: true,
  admitted: operationId ? [{ root, id, operation_id: operationId }] : [] });

it('uses native revision and operation identity, then selects the readback root', async () => {
  let operationId = '';
  vi.mocked(runtimeFetch).mockImplementation(async (_url, init) => {
    if (!init) return new Response(JSON.stringify(inventory(operationId || undefined)));
    const body = JSON.parse(String(init.body)) as { operation_id: string; expected_revision: string; root: string };
    operationId = body.operation_id;
    expect(body).toMatchObject({ expected_revision: 'absent', root });
    return new Response(JSON.stringify({ operation_id: operationId, persistence: 'saved' }));
  });
  expect(await addNativeWorkspace(root)).toBe(root);
  expect(operationId).toMatch(/^[a-f0-9-]{36}$/u);
});

it('recovers a lost acknowledgement by operation lookup without submitting twice', async () => {
  let operationId = '';
  let writes = 0;
  vi.mocked(runtimeFetch).mockImplementation(async (url, init) => {
    if (init) { writes += 1; operationId = (JSON.parse(String(init.body)) as { operation_id: string }).operation_id;
      throw new Error('connection lost'); }
    if (String(url).includes('/operations/')) return new Response(JSON.stringify({ operation_id: operationId, persistence: 'saved' }));
    return new Response(JSON.stringify(inventory(operationId || undefined)));
  });
  expect(await addNativeWorkspace(root)).toBe(root);
  expect(writes).toBe(1);
});

it('keeps a rejected admission rejected when no receipt exists', async () => {
  vi.mocked(runtimeFetch).mockImplementation(async (url, init) => {
    if (init) return new Response(JSON.stringify({ error: { message: 'Workspace is not canonical.' } }), { status: 409 });
    if (String(url).includes('/operations/')) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(inventory()));
  });
  await expect(addNativeWorkspace(root)).rejects.toThrow('Workspace is not canonical.');
  expect(vi.mocked(runtimeFetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
});
