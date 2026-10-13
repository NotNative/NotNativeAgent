// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
vi.mock('../../runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));
import { runtimeFetch } from '../../runtime-fetch.ts';
import { nativeMcpRequest, parseNativeMcpView, previewNativeMcp, readNativeMcp,
  inspectNativeMcpOperation, type NativeMcpView } from '../native-mcp.ts';

const fetchMock = runtimeFetch as unknown as Mock;
const revision = 'a'.repeat(64), resolution = 'b'.repeat(64);
const view: NativeMcpView = { schema_version: '1.0', installation_id: 'install_mcp', data_id: 'data_mcp', scope: 'user',
  source_state: 'present', source_revision: revision, resolution_revision: resolution, project_shadowed: false,
  application: 'not_applied', servers: [{ id: 'alpha', transport: 'stdio', enabled: false, trusted: false }] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status,
  headers: { 'content-type': 'application/json' } });
beforeEach(() => fetchMock.mockReset());

describe('native MCP contract', () => {
  it('rejects secret-bearing and malformed response fields', () => {
    expect(() => parseNativeMcpView({ ...view, servers: [{ ...view.servers[0], command: 'secret' }] })).toThrow('nnd_mcp_view_invalid');
    expect(() => parseNativeMcpView({ ...view, servers: [{ ...view.servers[0], credential: 'private' }] })).toThrow('nnd_mcp_view_invalid');
    expect(() => parseNativeMcpView({ ...view, servers: [view.servers[0], view.servers[0]] })).toThrow('nnd_mcp_view_invalid');
  });

  it('sends only a typed change and exact native revisions for preview', async () => {
    const request = nativeMcpRequest(view, { op: 'patch', id: 'alpha', fields: { enabled: true, timeout_ms: 1500 } });
    fetchMock.mockResolvedValueOnce(json({ valid: true, expected_revision: revision, resolution_revision: resolution,
      application: 'not_applied', change: { op: 'patch', id: 'alpha' }, view: { ...view,
        servers: [{ ...view.servers[0], enabled: true, timeout_ms: 1500 }] } }));
    const result = await previewNativeMcp(request, new AbortController().signal);
    expect(result.servers[0]?.enabled).toBe(true);
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/v1/nnd/configuration/mcp/preview');
    expect(JSON.parse(String(init.body))).toEqual(request);
    expect(String(init.body)).not.toContain('command');
  });

  it('requires matching operation identity and offers lookup after an uncertain write', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'manifest_publication_unknown', message: 'unresolved' } }, 503));
    await expect(readNativeMcp(new AbortController().signal)).rejects.toThrow('manifest_publication_unknown');
    fetchMock.mockResolvedValueOnce(json({ installation_id: 'foreign', data_id: view.data_id, scope: 'user',
      operation_id: 'op1', persistence: 'saved', persisted_revision: revision, before_revision: revision,
      application: 'not_applied', replayed: true }));
    await expect(inspectNativeMcpOperation(view, 'op1', new AbortController().signal)).rejects.toThrow('nnd_mcp_view_invalid');
  });

  it('projects operation receipts to known public fields', async () => {
    fetchMock.mockResolvedValueOnce(json({ installation_id: view.installation_id, data_id: view.data_id,
      scope: 'user', operation_id: 'op1', persistence: 'saved', persisted_revision: revision,
      before_revision: revision, application: 'not_applied', replayed: true,
      raw_credential: 'PRIVATE', next_action: 'activate_setup_or_restart_native_service' }));
    const result = await inspectNativeMcpOperation(view, 'op1', new AbortController().signal);
    expect(result?.persistence).toBe('saved');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(result).not.toHaveProperty('raw_credential');
  });

  it('rejects project shadow before preview construction', () => {
    expect(() => nativeMcpRequest({ ...view, project_shadowed: true },
      { op: 'delete', id: 'alpha' })).toThrow('nnd_mcp_request_invalid');
  });
});
