// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { isManagedMcpReferenceDraft, isValidManagedServerIdDraft,
  isValidManagedTokenDraft, nativeMcpCredentialDeleteRequest, nativeMcpCredentialSaveRequest,
  parseNativeMcpCredentialCatalog, parseNativeMcpCredentialList, NativeMcpCredentialsFailure,
  type NativeMcpCredentialList }
  from '../mcp-credentials.ts';

const identity = { installation_id: 'install_1', data_id: 'data_1', scope: 'user' } as const;
// Local mirror of NNA's managedMcpCredentialReference derivation, so the tests pin the
// wire shape rather than a hardcoded string.
const referenceFor = (serverId: string) => {
  const stem = serverId.toUpperCase().replace(/[^A-Z0-9]/gu, '_').slice(0, 40).replace(/_+$/u, '');
  const digest = createHash('sha256').update(serverId).digest('hex').slice(0, 12).toUpperCase();
  return `NNA_MCP_MANAGED_${stem}_${digest}_TOKEN`;
};
const list = (entries: unknown[], absent = false): NativeMcpCredentialList =>
  ({ ...identity, source_state: absent ? 'absent' : 'present' as 'present', count: entries.length,
    credentials: entries as NativeMcpCredentialList['credentials'], application: 'next_server_spawn' });
const catalog = () => ({ schema_version: '1.0', source: 'managed_mcp_credentials', scope: 'user',
  fields: [{ path: 'credentials.{NNA_MCP_MANAGED_reference}', classification: 'operator_setting',
    type: 'secret', application: 'next_server_spawn', scope: 'user',
    required_permission: 'nnd.configuration.manage',
    editability: { available: true, scope: 'user', required_permission: 'nnd.configuration.manage' } }] });
const codeOf = async (work: () => Promise<unknown>): Promise<string> => {
  try { await work(); } catch (failure) {
    expect(failure).toBeInstanceOf(NativeMcpCredentialsFailure);
    return (failure as NativeMcpCredentialsFailure).code;
  }
  throw new Error('expected a refusal');
};

describe('managed mcp credential list parser', () => {
  it('accepts the present shape and the absent-as-empty roster', () => {
    expect(parseNativeMcpCredentialList(list([], true))).toMatchObject({ count: 0, source_state: 'absent' });
    expect(parseNativeMcpCredentialList(list([{ reference: referenceFor('a'), applied: false }])))
      .toMatchObject({ count: 1, source_state: 'present' });
  });
  it('refuses drifted frames: count parity, extra keys, dirty references, applied drift', async () => {
    for (const raw of [
      { ...list([], true), count: 1 },
      { ...list([], true), application: 'next_service_start' },
      { ...list([], true), extra: 1 },
      { ...list([{ reference: 'NNA_MCP_UNMANAGED_FOREIGN', applied: false }]) },
      { ...list([{ reference: referenceFor('a'), applied: 'true' }]) },
      { ...list([{ reference: referenceFor('a'), applied: false, leaked: 'x' }]) },
      { ...list([], true), credentials: ['nope'] },
    ]) await expect(codeOf(() => Promise.resolve(parseNativeMcpCredentialList(raw))))
      .resolves.toBe('nnd_mcp_credentials_view_invalid');
  });
});

describe('draft grammar mirrors the managed-store domain', () => {
  it('accepts plain server ids and refuses controls and padding', () => {
    expect(isValidManagedServerIdDraft('filesystem-mcp')).toBe(true);
    expect(isValidManagedServerIdDraft('Server_ID.1')).toBe(true);
    expect(isValidManagedServerIdDraft(' spaced')).toBe(false);
    expect(isValidManagedServerIdDraft('bad\nid')).toBe(false);
    expect(isValidManagedServerIdDraft('i'.repeat(129))).toBe(false);
  });
  it('bounds the token like the domain: 1..16384 with no line breaks', () => {
    expect(isValidManagedTokenDraft('a')).toBe(true);
    expect(isValidManagedTokenDraft('t'.repeat(16_384))).toBe(true);
    expect(isValidManagedTokenDraft('t'.repeat(16_385))).toBe(false);
    expect(isValidManagedTokenDraft(`bad${String.fromCharCode(10)}`)).toBe(false);
    expect(isValidManagedTokenDraft('')).toBe(false);
    expect(isManagedMcpReferenceDraft(referenceFor('a'))).toBe(true);
    expect(isManagedMcpReferenceDraft('NNA_MCP_UNMANAGED_FOREIGN')).toBe(false);
    expect(isManagedMcpReferenceDraft('NNA_MCP_MANAGED_A_' + 'F'.repeat(11) + '_TOKEN')).toBe(false);
  });
});

describe('catalog parser', () => {
  it('pins the single secret field', () => {
    expect(parseNativeMcpCredentialCatalog(catalog()).fields[0]).toMatchObject({ type: 'secret' });
    const modified = catalog() as { fields: Record<string, unknown>[] };
    modified.fields[0]!.type = 'string';
    expect(() => parseNativeMcpCredentialCatalog(modified)).toThrow(NativeMcpCredentialsFailure);
    const drifted = catalog() as { fields: Record<string, unknown>[] };
    drifted.fields[0]!.path = 'other';
    expect(() => parseNativeMcpCredentialCatalog(drifted)).toThrow(NativeMcpCredentialsFailure);
    const dropped = catalog() as { fields: unknown[] };
    dropped.fields.pop();
    expect(() => parseNativeMcpCredentialCatalog(dropped)).toThrow(NativeMcpCredentialsFailure);
  });
});

describe('request composers pin the bounded wire shapes', () => {
  it('save carries identity, the staged token, and a pinned operation id once', () => {
    const request = nativeMcpCredentialSaveRequest(list([]), { server_id: 'filesystem-mcp',
      token: 'tok-1', operation_id: 'op_save' });
    expect(request).toEqual({ installation_id: 'install_1', data_id: 'data_1', scope: 'user',
      server_id: 'filesystem-mcp', token: 'tok-1', operation_id: 'op_save' });
  });
  it('delete carries the reference and refuses foreign handles before composing', async () => {
    expect(nativeMcpCredentialDeleteRequest(list([{ reference: referenceFor('a'), applied: false }]),
      { reference: referenceFor('a'), operation_id: 'op_del' })).toMatchObject({ reference: referenceFor('a'),
      operation_id: 'op_del' });
    await expect(codeOf(() => Promise.resolve(nativeMcpCredentialDeleteRequest(list([]),
      { reference: 'NNA_MCP_UNMANAGED_FOREIGN', operation_id: 'op_a' }))))
      .resolves.toBe('nnd_mcp_credentials_request_invalid');
    await expect(codeOf(() => Promise.resolve(nativeMcpCredentialSaveRequest(list([]),
      { server_id: 'bad\nid', token: 'tok-1', operation_id: 'op_a' }))))
      .resolves.toBe('nnd_mcp_credentials_request_invalid');
    await expect(codeOf(() => Promise.resolve(nativeMcpCredentialSaveRequest(list([]),
      { server_id: 'a', token: 'bad\nline', operation_id: 'op_a' }))))
      .resolves.toBe('mcp_token_invalid');
    await expect(codeOf(() => Promise.resolve(nativeMcpCredentialSaveRequest(list([]),
      { server_id: 'a', token: 't'.repeat(16_385), operation_id: 'op_a' }))))
      .resolves.toBe('mcp_token_invalid');
    await expect(codeOf(() => Promise.resolve(nativeMcpCredentialSaveRequest(list([]),
      { server_id: 'a', token: 'tok-1', operation_id: 'not allowed!' }))))
      .resolves.toBe('nnd_mcp_credentials_request_invalid');
  });
});
