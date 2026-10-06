// SPDX-License-Identifier: Apache-2.0
import { expect, it } from 'vitest';
import { parseNativeTrustList, parseNativeTrustCatalog, parseNativeTrustReceipt,
  isValidTrustWorkspaceDraft } from '../trust.ts';

const identity = { installation_id: 'install_ws', data_id: 'data_ws', scope: 'user' };
const list = () => ({ ...identity, schema_version: '1.0', version: 1, source: 'trust',
  application: 'project_configuration',
  fields: ['version', 'workspaces[*].root', 'workspaces[*].trustedAt'],
  workspaces: [
    { root: 'D:\\trusted\\alpha', trusted_at: '2026-10-06T01:02:03.004Z' },
    { root: 'D:\\trusted\\beta', trusted_at: '2026-10-06T09:00:00Z' }] });
const receipt = (operation: 'grant' | 'revoke', root: string) => ({ ...identity, schema_version: '1.0',
  operation, root, trusted: operation === 'grant', application: 'project_configuration' });
const catalog = () => ({ schema_version: '1.0', source: 'trust', scope: 'user',
  fields: [
    { path: 'version', classification: 'generated_state', application: 'project_configuration',
      editability: { available: false, scope: 'user', reason: 'generated_state' } },
    { path: 'workspaces[*].root', classification: 'authority_grant',
      application: 'project_configuration', operations: ['grant', 'revoke'],
      required_permission: 'nnd.workspace.manage',
      editability: { available: true, scope: 'user', required_permission: 'nnd.workspace.manage' } },
    { path: 'workspaces[*].trustedAt', classification: 'generated_state',
      application: 'project_configuration',
      editability: { available: false, scope: 'user', reason: 'generated_state' } }] });

it('trust parser rebuilds the granted list, receipts, and catalog exactly as served', () => {
  const parsed = parseNativeTrustList(list());
  expect(Object.keys(parsed)).toEqual(['schema_version', 'installation_id', 'data_id', 'scope', 'version',
    'workspaces', 'source', 'application', 'fields']);
  expect(parsed.workspaces.map((workspace) => workspace.root)).toEqual(list().workspaces.map((w) => w.root));
  expect(parsed.workspaces.every((workspace) => Object.keys(workspace).join(',') === 'root,trusted_at')).toBe(true);
  const absentList = parseNativeTrustList({ ...list(), workspaces: [] });
  expect(absentList.workspaces).toEqual([]);
  expect(parseNativeTrustReceipt(receipt('grant', 'C:\\canonical\\alpha'), 'grant').root)
    .toBe('C:\\canonical\\alpha');
  expect(parseNativeTrustCatalog(catalog()).fields.map((field) => field.path))
    .toEqual(['version', 'workspaces[*].root', 'workspaces[*].trustedAt']);
  expect(isValidTrustWorkspaceDraft('D:\\proj')).toBe(true);
  expect(isValidTrustWorkspaceDraft('   ')).toBe(false);
  expect(isValidTrustWorkspaceDraft('x'.repeat(32_769))).toBe(false);
});

it('trust parser refuses drifted lists, receipts replayed from another operation, and untrustworthy catalog shapes', () => {
  const hostile = [
    { ...list(), version: 2 },
    { ...list(), source: 'update_state' },
    { ...list(), application: 'next_search' },
    { ...list(), fields: ['version', 'workspaces[*].root'] },
    { ...list(), workspaces: [{ root: '', trusted_at: 'x' }] },
    { ...list(), workspaces: [{ root: 'ok', trusted_at: 5 }] },
    { ...list(), workspaces: [{ root: 'ok', trustedAt: 'renamed' }] },
    { ...list(), workspaces: [{ root: 'ok', trusted_at: 'x', extra: 1 }] },
    { ...list(), workspaces: 'banana' },
    { data_id: list().data_id, schema_version: '1.0', version: 1, source: 'trust', application: 'x',
      fields: ['version'], workspaces: [] },
    null,
  ];
  for (const raw of hostile) expect(() => parseNativeTrustList(raw)).toThrow();
  expect(() => parseNativeTrustReceipt(receipt('grant', 'C:\\x'), 'revoke')).toThrow();
  expect(() => parseNativeTrustReceipt({ ...receipt('revoke', 'C:\\x'), trusted: true }, 'revoke')).toThrow();
  expect(() => parseNativeTrustReceipt({ ...receipt('grant', 'C:\\x'), root: '' }, 'grant')).toThrow();
  for (const drift of [
    { ...catalog(), fields: catalog().fields.slice(0, 2) },
    { ...catalog(), fields: catalog().fields.map((field) => field.path === 'version'
      ? { ...field, classification: 'authority_grant' } : field) },
    { ...catalog(), fields: catalog().fields.map((field) => field.path === 'workspaces[*].root'
      ? { ...field, editability: { ...field.editability, required_permission: 'nnd.configuration.manage' } } : field) },
    { ...catalog(), fields: catalog().fields.map((field) => field.path === 'workspaces[*].root'
      ? { ...field, operations: ['grant'] } : field) },
    { ...catalog(), fields: catalog().fields.map((field) => field.path === 'version'
      ? { ...field, editability: { available: true, scope: 'user', required_permission: 'nnd.workspace.manage' } } : field) },
    { ...catalog(), source: 'web_search' },
  ]) expect(() => parseNativeTrustCatalog(drift)).toThrow();
});
