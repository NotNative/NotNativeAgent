// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { parseHooksList, parseBundle, parseSubscription, parseDiagnostic,
  hooksErrorText, NativeHooksFailure, type HookBundle } from '../hooks.ts';

const envelope = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema_version: '1.0', installation_id: 'install_hooks', data_id: 'data_hooks', scope: 'user',
  source_state: 'present', count: 1, hooks: [bundle()], diagnostics: [],
  application: 'next_hook_use', ...overrides });
const rawSubscription = (overrides: Record<string, unknown> = {}) => ({ event: 'turn',
  phase: 'pre', command: 'cmd --flag', blocking: false, priority: 5, timeout_ms: 5000,
  max_concurrent: 2, ...overrides });
const bundle = (overrides: Record<string, unknown> = {}): HookBundle =>
  ({ name: 'a-valid', version: '1.0.0', directory_name: 'a-valid',
    subscriptions: [{ event: 'turn', phase: 'pre', command: 'cmd --flag', blocking: false,
      priority: 5, timeout_ms: 5000, max_concurrent: 2 }], ...overrides });
const diagnostic = (overrides: Record<string, unknown> = {}) => ({ bundle: 'b-broken',
  status: 'skipped', code: 'invalid_hook_manifest', ...overrides });

describe('native hooks roster', () => {
  it('parses the discovery projection verbatim and refuses envelope drift', () => {
    const parsed = parseHooksList(envelope());
    expect(parsed.hooks[0]?.name).toBe('a-valid');
    expect(parsed.hooks[0]?.subscriptions[0]?.timeout_ms).toBe(5000);
    expect(parsed.application).toBe('next_hook_use');
    expect(() => parseHooksList({ ...envelope(), extra: 1 })).toThrow(NativeHooksFailure);
    expect(() => parseHooksList(envelope({ application: 'next_secret_use' }))).toThrow(NativeHooksFailure);
    expect(() => parseHooksList(envelope({ source_state: 'absent' }))).toThrow(NativeHooksFailure);
    expect(() => parseHooksList(envelope({ count: 2 }))).toThrow(NativeHooksFailure);
    const absent = parseHooksList(envelope({ source_state: 'absent', count: 0, hooks: [], diagnostics: [] }));
    expect(absent.hooks).toEqual([]);
  });
  it('accepts every live bundle field and refuses discovery drift', () => {
    expect(parseBundle(bundle())).toEqual(bundle());
    expect(parseSubscription({ event: 'maintenance', phase: 'idle', command: 'x',
      blocking: true, priority: -100_000, timeout_ms: 300_000, max_concurrent: 16 }))
      .toMatchObject({ timeout_ms: 300_000 });
    expect(() => parseBundle(bundle({ version: 'x'.repeat(65) }))).toThrow(NativeHooksFailure);
    expect(() => parseBundle(bundle({ name: '../escape' }))).toThrow(NativeHooksFailure);
    expect(() => parseBundle({ ...bundle(), extra: 1 })).toThrow(NativeHooksFailure);
    expect(() => parseBundle('bundle')).toThrow(NativeHooksFailure);
    for (const drift of [{ event: 'session', phase: 'end' }, { phase: 'sideways' },
      { max_concurrent: 17 }, { timeout_ms: 99 }, { priority: 100_001 }, { blocking: 'yes' },
      { command: 'cmd\r\nline' }, { command: '' }, { extra: 1 }]) {
      expect(() => parseSubscription(rawSubscription(drift))).toThrow(NativeHooksFailure);
    }
    expect(() => parseSubscription({ ...rawSubscription(), command: ''.padEnd(1025, 'a') }))
      .toThrow(NativeHooksFailure);
  });
  it('keeps the discovery honesty channel and refuses diagnostic drift', () => {
    expect(parseDiagnostic(diagnostic())).toEqual({ bundle: 'b-broken', status: 'skipped',
      code: 'invalid_hook_manifest' });
    expect(parseDiagnostic({ bundle: null, status: 'limit_reached',
      code: 'hook_bundle_limit_reached', omitted: 3 }))
      .toEqual({ bundle: null, status: 'limit_reached', code: 'hook_bundle_limit_reached', omitted: 3 });
    expect(() => parseDiagnostic({ bundle: null, status: 'limit_reached',
      code: 'hook_bundle_limit_reached', omitted: 0 })).toThrow(NativeHooksFailure);
    expect(() => parseDiagnostic({ bundle: 'x', status: 'skipped' })).toThrow(NativeHooksFailure);
    expect(() => parseDiagnostic({ bundle: null, status: 'skipped', code: 'UPPER' }))
      .toThrow(NativeHooksFailure);
    expect(() => parseDiagnostic({ bundle: null, status: 'reordered', code: 'x' }))
      .toThrow(NativeHooksFailure);
  });
  it('maps forwarded codes to honest sentences', () => {
    expect(hooksErrorText('nnd_configuration_unavailable')).toContain('unavailable on this NNA');
    expect(hooksErrorText('nnd_hooks_unavailable')).toContain('unavailable');
    expect(hooksErrorText('anything_else')).toContain('could not be read');
  });
});
