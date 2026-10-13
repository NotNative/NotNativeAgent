// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { parseCheckReceipt, updateActionErrorText } from '../update-actions.ts';
import { parsePackageReceipt, packageActionErrorText } from '../package-actions.ts';

const stamp = '2026-10-06T18:00:00.000Z';
const op = () => '550e8400-e29b-41d4-a716-446655440000';
const ready = () => ({ status: 'ready', checked_at: stamp, cached: false,
  current_version: '20261006-3', latest_version: '20261006-9', latest_ref: 'main',
  latest_tag: null, latest_sha: 'a'.repeat(40), available: true, error_code: null });
const envelope = (availability: Record<string, unknown>, operationId = op()) => ({ schema_version: '1.0',
  installation_id: 'install_updates', data_id: 'data_updates', scope: 'user', action: 'check',
  application: 'update_check_recorded', operation_id: operationId, availability });

describe('update action receipt grammar (NND client)', () => {
  it('pins the forced check receipt and refuses drifted availability', () => {
    const receipt = parseCheckReceipt(envelope(ready()));
    expect(receipt).toMatchObject({ action: 'check', application: 'update_check_recorded' });
    expect(receipt.availability).toMatchObject({ status: 'ready', available: true,
      latestVersion: '20261006-9', currentVersion: '20261006-3', cached: false });
    const refusals = [envelope({ ...ready(), extra: 1 }), envelope({ ...ready(), status: 'maybe' }),
      envelope({ ...ready(), available: 'yes' }), envelope({ ...ready(), latest_sha: 'z'.repeat(40) }),
      envelope({ ...ready(), error_code: 'update_check_failed' }, op()),
      envelope({ ...ready(), checked_at: 'yesterday' }), envelope(ready(), 'not-a-uuid'),
      envelope({ ...ready(), current_version: 'nope' })];
    for (const refusal of refusals) expect(() => parseCheckReceipt(refusal)).toThrow();
    expect(updateActionErrorText('nnd_update_install_unsupported')).toContain("refused");
    expect(updateActionErrorText('anything')).toBe('The update action could not be completed natively.');
  });
});

const installed = () => ({ registered: true, valid: true, root: 'D:/apps/desktop', version: '20261006-3' });
const packageEnvelope = (pkg: Record<string, unknown>, action = 'status', withOperation = false) => ({ schema_version: '1.0',
  installation_id: 'install_updates', data_id: 'data_updates', scope: 'user', action,
  application: withOperation ? 'registered_root' : 'not_applied',
  ...(withOperation ? { operation_id: op() } : { operation_id: null }), package: pkg });

describe('package action receipt grammar (NND client)', () => {
  it('pins the registry variant grammar and refuses drift', () => {
    const status = parsePackageReceipt(packageEnvelope(installed()));
    expect(status.package).toMatchObject({ registered: true, valid: true, version: '20261006-3' });
    expect(status.action).toBe('status');
    expect(status.operationId).toBeNull();
    const activated = parsePackageReceipt(packageEnvelope(installed(), 'activate', true));
    expect(activated.operationId).toBe(op());
    expect(activated.application).toBe('registered_root');
    const absent = parsePackageReceipt(packageEnvelope({ registered: false }));
    expect(absent.package).toMatchObject({ registered: false, root: null });
    for (const refusal of [packageEnvelope({ ...installed(), extra: 1 }),
      packageEnvelope({ ...installed(), valid: 'yes' }), packageEnvelope(installed(), 'activate', false),
      packageEnvelope({ registered: false, root: 'x' }), packageEnvelope({ ...installed(), root: 'x\n' }),
      { ...packageEnvelope(installed()), application: 'not_applied', action: 'activate' },
      packageEnvelope({ ...installed(), version: 'nope' })]) {
      expect(() => parsePackageReceipt(refusal)).toThrow();
    }
    expect(packageActionErrorText('nnd_package_root_mismatch')).toContain('registered NND package root');
    expect(packageActionErrorText('anything')).toBe('The package action could not be completed natively.');
  });
});
