// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { NativeBrowserFailure, parseNativeBrowserReceipt } from '../browser.ts';

const operation = () => 'op_' + 'a'.repeat(20);
const envelope = (status: Record<string, unknown>, action: 'status' | 'verify' = 'status') => ({
  schema_version: '1.0', installation_id: 'nna_1', data_id: 'data_1', scope: 'user',
  action, application: 'not_applied', operation_id: operation(), status });
const ok = () => ({ available: true, version: '1.61.1', browser: 'chromium',
  browser_path: 'C:\\nna\\managed\\playwright\\browsers\\chromium.exe',
  root: 'C:\\nna\\managed\\playwright', reason: null });
const absent = (reason = 'not_installed') => ({ available: false, version: null,
  browser: 'chromium', browser_path: null, root: 'C:\\nna\\managed\\playwright', reason });
const parse = (receipt: unknown, action: 'status' | 'verify' = 'status') =>
  parseNativeBrowserReceipt(receipt, action);

describe('native browser receipt parser', () => {
  it('accepts the two authority outcome shapes and refuses drift', () => {
    const read = parse(envelope(ok()));
    expect(read.status.available).toBe(true);
    expect(read.action).toBe('status');
    const verified = parse(envelope(absent('validation_failed'), 'verify'), 'verify');
    expect(verified.action).toBe('verify');
    expect(verified.status.available).toBe(false);
    expect(verified.status.version).toBeNull();
    expect(verified.status.reason).toBe('validation_failed');
    for (const drift of [
      envelope({ ...ok(), unexpected: true }),
      envelope({ ...absent(), version: '1.0.0' }),
      envelope({ ...absent(), reason: 'exploded' }),
      envelope({ ...ok(), extra: true }),
      envelope(ok(), 'verify'),
      envelope({ ...absent(), available: null }),
    ]) {
      expect(() => parse(drift, 'status')).toThrow(NativeBrowserFailure);
    }
  });
});
