// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { parseServiceStatusReceipt, parseStartReceipt, parseStopReceipt, parseWiringReceipt,
  parseRuntimeView, parseAppliedEnvironment, serviceLifecycleErrorText,
  NativeServiceLifecycleFailure, type ServiceStatusView } from '../lifecycle.ts';

const OPERATION = '11111111-2222-4333-8444-555555555555';
const wire = () => ({ autostart_enabled: true, configured: true,
  password_source: 'restricted local config' as const, username: 'opencode', hostname: '127.0.0.1',
  port: 4095, bind_url: 'http://127.0.0.1:4095' });
const statusView = (overrides: Partial<ServiceStatusView> = {}): ServiceStatusView => ({
  service: wire(),
  runtime: { running: false },
  login: { supported: false, installed: null, script_path: null },
  environment: { supported: false, skip_start: null, host: null, password_present: null, username: null },
  stale_binding: false, ...overrides });
const status = (view: unknown = statusView()) => ({ schema_version: '1.0', installation_id: 'install_lc',
  data_id: 'data_lc', scope: 'user', action: 'status', application: 'not_applied', operation_id: OPERATION,
  status: view });
const start = (started: boolean) => ({ schema_version: '1.0', installation_id: 'install_lc',
  data_id: 'data_lc', scope: 'user', action: 'start', application: 'start_service', operation_id: OPERATION,
  started, reason: started ? null : 'already_running', pid: started ? 777 : null,
  port: started ? 4095 : null, url: started ? 'http://127.0.0.1:4095' : null,
  runtime: started ? null : { running: true, verified: true, pid: 777, port: 4095, url: 'http://127.0.0.1:4095' },
  environment: started ? { supported: true, written: ['OPENCODE_HOST'], removed: [], unchanged: ['OPENCODE_HOST'] }
    : { supported: false } });
const wiring = (action: 'enable' | 'disable', runtime: unknown = { running: false }) => ({ schema_version: '1.0',
  installation_id: 'install_lc', data_id: 'data_lc', scope: 'user', action,
  application: 'next_service_start', operation_id: OPERATION, service: wire(),
  login: { supported: true, installed: action === 'enable', script_path: 'C:/startup/NotNativeAgent-OpenCode.vbs' },
  runtime });

describe('compatibility-service lifecycle receipts', () => {
  it('parses the status observation verbatim and releases every key', () => {
    const parsed = parseServiceStatusReceipt(status());
    expect(parsed.status.service.bind_url).toBe('http://127.0.0.1:4095');
    expect(parsed.status.environment.supported).toBe(false);
    expect(JSON.stringify(parsed.status)).not.toContain('password source');
    expect(() => parseServiceStatusReceipt({ ...status(), operation_id: 'bad' })).toThrow(NativeServiceLifecycleFailure);
    expect(() => parseServiceStatusReceipt({ ...status(), extra: 1 })).toThrow(NativeServiceLifecycleFailure);
    expect(() => parseServiceStatusReceipt({ ...status(), application: 'next_service_start' }))
      .toThrow(NativeServiceLifecycleFailure);
  });
  it('accepts every runtime variant and refuses grammar drift', () => {
    for (const variant of [{ running: false }, { running: false, stale: true },
      { running: false, stale: true, pid: 4242, reason: 'dead' as const },
      { running: false, stale: true, pid: 4242 },
      { running: true, verified: false, pid: 777, legacy: true, port: 4095, url: 'http://127.0.0.1:4095' },
      { running: true, verified: false, pid: 777 },
      { running: true, verified: true, pid: 777, url: 'http://127.0.0.1:4095' }]) {
      expect(parseRuntimeView(variant)).toEqual(variant);
    }
    for (const drift of [{ running: true }, { running: true, verified: true, pid: 777, stale: true },
      { running: false, reason: 'dead' }, { running: false, verified: false },
      { running: true, verified: true, pid: 0 }, { running: true, verified: true, pid: 777, legacy: true },
      { running: false, port: 4095 }, { running: 1 }]) {
      expect(() => parseRuntimeView(drift)).toThrow(NativeServiceLifecycleFailure);
    }
  });
  it('parses start/stop/wiring receipts with the inputless-body shape and refusals', () => {
    const begun = parseStartReceipt(start(true));
    expect(begun).toMatchObject({ started: true, pid: 777, application: 'start_service' });
    expect(begun.environment).toMatchObject({ written: ['OPENCODE_HOST'] });
    const already = parseStartReceipt(start(false));
    expect(already.reason).toBe('already_running');
    expect(parseAppliedEnvironment(already.environment)).toEqual({ supported: false });
    const halted = parseStopReceipt({ schema_version: '1.0', installation_id: 'install_lc',
      data_id: 'data_lc', scope: 'user', action: 'stop', application: 'stop_service',
      operation_id: OPERATION, stopped: true, reason: null, pid: 4242,
      environment: { supported: true, written: [], removed: ['OPENCODE_HOST'] } });
    expect(halted).toMatchObject({ stopped: true, pid: 4242 });
    const enabled = parseWiringReceipt(wiring('enable'));
    expect(enabled.login.script_path).toContain('NotNativeAgent-OpenCode.vbs');
    expect(() => parseStartReceipt({ ...start(true), runtime: {} })).toThrow(NativeServiceLifecycleFailure);
    expect(() => parseStartReceipt({ ...start(true), reason: 'already_running' })).toThrow(NativeServiceLifecycleFailure);
    expect(() => parseStopReceipt({ ...start(true), action: 'stop' })).toThrow(NativeServiceLifecycleFailure);
    expect(() => parseWiringReceipt({ ...wiring('enable'), application: 'start_service' }))
      .toThrow(NativeServiceLifecycleFailure);
  });
  it('maps forwarded codes to honest sentences', () => {
    expect(serviceLifecycleErrorText('opencode_login_wiring_unsupported')).toContain('Windows-only');
    expect(serviceLifecycleErrorText('opencode_identity_unverifiable')).toContain('refuses to stop');
    expect(serviceLifecycleErrorText('nnd_service_run_unsupported')).toContain('start or the login startup script');
    expect(serviceLifecycleErrorText('opencode_start_failed')).toContain('opencode-console.log');
    expect(serviceLifecycleErrorText('everything_else')).toBe('The compatibility-service action could not be completed.');
  });
});
