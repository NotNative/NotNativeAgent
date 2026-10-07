// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { parseMcpPresence, parseMcpInner,
  type McpPresenceRow } from '../advanced.ts';

const presenceRow = () => ({ id: 'existing', has_credential: true, has_credential_target: true,
  header_credential_count: 1, has_header_env: true, tool_effect_count: 3,
  has_protocol_version: true, has_command: true, has_args: true, has_cwd: true,
  has_endpoint: false });
const presence = () => ({ schema_version: '1.0', installation_id: 'nna_1', data_id: 'data_1',
  scope: 'user', source_state: 'present', source_revision: 'a'.repeat(64),
  resolution_revision: 'b'.repeat(64), project_shadowed: false, application: 'not_applied',
  servers: [presenceRow()] });
const innerRow = (row: McpPresenceRow = presenceRow()) => ({ id: row.id,
  credential: 'PRIVATE_TOKEN_REF', credential_target: 'MCP_TARGET_ENV',
  header_credentials: [{ header: 'x-signed', reference: 'secret:sec_demo-1#token', field: 'token' }],
  header_env: [{ header: 'x-mcp', name: 'MCP_HEADER_ENV' }],
  tool_effects: [{ tool: 'shell', effect: 'denied' }, { tool: 'write_file', effect: 'allowed' }],
  protocol_version: '2026-07-28',
  surface: { command: 'hidden-command', args: ['private-arg'], cwd: null, endpoint: null },
  presence: row });
const inner = () => ({ schema_version: '1.0', installation_id: 'nna_1', data_id: 'data_1',
  scope: 'user', source_revision: 'a'.repeat(64), resolution_revision: 'b'.repeat(64),
  project_shadowed: false, application: 'not_applied', servers: [innerRow()] });

const drift = (base: () => unknown,
  modifier: (value: Record<string, unknown>) => Record<string, unknown>) => () =>
  modifier({ ...(base() as Record<string, unknown>) });

describe('native mcp advanced presence grammar', () => {
  it('parses counts without sensitive values', () => {
    const view = parseMcpPresence(presence());
    expect(view.servers[0]?.has_credential).toBe(true);
    expect(view.servers[0]?.header_credential_count).toBe(1);
    expect(JSON.stringify(view)).not.toContain('PRIVATE_TOKEN_REF');
  });
  it('refuses drift', () => {
    expect(() => parseMcpPresence(null)).toThrow();
    expect(() => parseMcpPresence(drift(presence, (v) => ({ ...v, extra: true }))())).toThrow();
    expect(() => parseMcpPresence(drift(presence,
      (v) => ({ ...v, source_state: 'missing' }))())).toThrow();
    expect(() => parseMcpPresence(drift(presence,
      (v) => ({ ...v, application: 'applied' }))())).toThrow();
    expect(() => parseMcpPresence(drift(presence,
      (v) => ({ ...v, servers: [{ ...(v.servers as Record<string, unknown>[])[0], has_credential: 'yes' }] }))())).toThrow();
    expect(() => parseMcpPresence(drift(presence,
      (v) => ({ ...v, servers: [{ ...(v.servers as Record<string, unknown>[])[0], extra: 1 }] }))())).toThrow();
    expect(() => parseMcpPresence(drift(presence,
      (v) => ({ ...v, servers: [{ ...(v.servers as Record<string, unknown>[])[0], header_credential_count: -1 }] }))())).toThrow();
  });
});

describe('native mcp advanced inner grammar', () => {
  it('parses references without serving any value', () => {
    const view = parseMcpInner(inner());
    expect(view.servers[0]?.credential).toBe('PRIVATE_TOKEN_REF');
    expect(view.servers[0]?.header_credentials[0]?.reference).toBe('secret:sec_demo-1#token');
    expect(view.servers[0]?.surface.command).toBe('hidden-command');
    expect(view.servers[0]?.presence.has_credential).toBe(true);
    expect(JSON.stringify(view)).not.toContain('token value');
  });
  it('refuses drift', () => {
    expect(() => parseMcpInner(null)).toThrow();
    expect(() => parseMcpInner(drift(inner, (v) => ({ ...v, extra: true }))())).toThrow();
    expect(() => parseMcpInner(drift(inner, (v) => ({ ...v, source_state: 'present' }))())).toThrow();
    expect(() => parseMcpInner(drift(inner,
      (v) => ({ ...v, servers: [{ ...(v.servers as Record<string, unknown>[])[0], credential: 7 }] }))())).toThrow();
    expect(() => parseMcpInner(drift(inner,
      (v) => ({ ...v, servers: [{ ...(v.servers as Record<string, unknown>[])[0],
        header_credentials: [{ header: 'h', reference: 5, field: null }] }] }))())).toThrow();
    expect(() => parseMcpInner(drift(inner,
      (v) => ({ ...v, servers: [{ ...(v.servers as Record<string, unknown>[])[0],
        tool_effects: [{ tool: 'x', effect: 'maybe' }] }] }))())).toThrow();
    expect(() => parseMcpInner(drift(inner,
      (v) => ({ ...v, servers: [{ ...(v.servers as Record<string, unknown>[])[0],
        surface: { command: null, args: null, cwd: null, endpoint: 7 } }] }))())).toThrow();
    expect(() => parseMcpInner(drift(inner,
      (v) => ({ ...v, servers: [{ ...(v.servers as Record<string, unknown>[])[0], presence: null }] }))())).toThrow();
  });
});
