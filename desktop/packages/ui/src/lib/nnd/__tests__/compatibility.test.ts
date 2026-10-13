// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { NativeCompatibilityFailure, isValidCompatibilityHostnameDraft,
  isValidCompatibilityPasswordDraft, isValidCompatibilityPortDraft,
  isValidCompatibilityUsernameDraft, nativeCompatibilityRequest,
  parseNativeCompatibilityCatalog, parseNativeCompatibilityView,
  type CompatibilityCandidate } from '../compatibility.ts';

const hex = (char: string) => char.repeat(64);
const presentView = () => ({ schema_version: '1.0', installation_id: 'install_compat',
  data_id: 'data_compat', scope: 'user', source_state: 'present', source_revision: hex('b'),
  resolution_revision: hex('b'), project_shadowed: false, version: 1, enabled: false,
  hostname: '127.0.0.1', port: 4095, username: 'opencode',
  password: { configured: false, source: null }, updated_at: '2026-10-06T00:00:00.000Z',
  application: 'next_service_start' });
const absentView = () => ({ ...presentView(), source_state: 'absent', source_revision: 'absent',
  resolution_revision: 'absent', updated_at: null });
const candidateDraft = (part: Partial<CompatibilityCandidate> = {}): CompatibilityCandidate =>
  ({ enabled: false, hostname: '127.0.0.1', port: 4095, username: 'opencode',
    password: { action: 'keep' }, ...part });
const catalog = () => ({ schema_version: '1.0', source: 'compatibility_service', scope: 'user',
  fields: [
    { path: 'version', classification: 'generated_state', application: 'next_service_start',
      editability: { available: false, scope: 'user', reason: 'generated_state' } },
    { path: 'enabled', classification: 'operator_setting', application: 'next_service_start',
      editability: { available: true, scope: 'user', required_permission: 'nnd.configuration.manage' } },
    { path: 'hostname', classification: 'operator_setting', application: 'next_service_start',
      editability: { available: true, scope: 'user', required_permission: 'nnd.configuration.manage' } },
    { path: 'port', classification: 'operator_setting', application: 'next_service_start',
      editability: { available: true, scope: 'user', required_permission: 'nnd.configuration.manage' } },
    { path: 'username', classification: 'operator_setting', application: 'next_service_start',
      editability: { available: true, scope: 'user', required_permission: 'nnd.configuration.manage' } },
    { path: 'password', classification: 'operator_setting', type: 'secret',
      operations: ['replace_secret', 'clear_secret'], application: 'next_service_start',
      editability: { available: true, scope: 'user', required_permission: 'nnd.configuration.manage' } },
    { path: 'updated_at', classification: 'generated_state', application: 'next_service_start',
      editability: { available: false, scope: 'user', reason: 'generated_state' } }] });

describe('compatibility native view parser', () => {
  it('accepts the present projector shape and the absent bootstrap frame', () => {
    expect(parseNativeCompatibilityView(presentView()).version).toBe(1);
    const absent = parseNativeCompatibilityView(absentView());
    expect(absent.source_state).toBe('absent');
    expect(absent.source_revision).toBe('absent');
    expect(absent.updated_at).toBe(null);
  });
  it('refuses drifted frames, wire-identity damage, leaking credentials, and rich absent views', () => {
    for (const raw of [
      { ...presentView(), resolution_revision: hex('c') },
      { ...presentView(), hostname: ' 127.0.0.1' },
      { ...presentView(), username: 'open:code' },
      { ...presentView(), port: 65_536 },
      { ...presentView(), enabled: 'yes' },
      { ...presentView(), version: 2 },
      { ...presentView(), application: 'next_search' },
      { ...presentView(), password: { configured: true, source: null } },
      { ...presentView(), password: { configured: true, source: 'restricted local config', value: 'secret' } },
      { ...presentView(), password: { configured: false, source: 'environment' } },
      { ...absentView(), source_revision: hex('d') },
      { ...presentView(), additional_property: 1 },
      { ...presentView(), updated_at: 5 },
    ]) expect(() => parseNativeCompatibilityView(raw)).toThrow(NativeCompatibilityFailure);
  });
});

describe('draft grammar mirrors the opencode domain', () => {
  it('accepts honest bind hosts (IPv4, DNS, IPv6 literals) and refuses damage', () => {
    for (const value of ['127.0.0.1', 'localhost', '[::1]', '::1', 'opencode.example', `${'a'.repeat(64)}.example`]) {
      expect(isValidCompatibilityHostnameDraft(value)).toBe(true);
    }
    for (const value of ['1.2.3.4.5', 'http://127.0.0.1', '127[.0].0.1', `${'a'.repeat(254)}`, '']) {
      expect(isValidCompatibilityHostnameDraft(value)).toBe(false);
    }
  });
  it('bounds port, username, and the replace secret the way the domain does', () => {
    expect(isValidCompatibilityPortDraft(1)).toBe(true);
    expect(isValidCompatibilityPortDraft(65_535)).toBe(true);
    expect(isValidCompatibilityPortDraft(65_536)).toBe(false);
    expect(isValidCompatibilityPortDraft(4095.5)).toBe(false);
    expect(isValidCompatibilityUsernameDraft('opencode')).toBe(true);
    expect(isValidCompatibilityUsernameDraft('basic:auth')).toBe(false);
    expect(isValidCompatibilityPasswordDraft('c'.repeat(20))).toBe(true);
    expect(isValidCompatibilityPasswordDraft('c'.repeat(19))).toBe(false);
    expect(isValidCompatibilityPasswordDraft(`cc${'c'.repeat(18)}\n`)).toBe(false);
  });
});

describe('nativeCompatibilityRequest composes the bounded document candidate', () => {
  it('carries the full wire identity, trims inputs, and binds the replace value', () => {
    const view = parseNativeCompatibilityView(presentView());
    const request = nativeCompatibilityRequest(view,
      candidateDraft({ enabled: true, hostname: ' 127.0.0.1 ', username: ' opencode ' }));
    expect(request.view).toEqual({ enabled: true, hostname: '127.0.0.1', port: 4_095, username: 'opencode' });
    expect(request.password).toEqual({ action: 'keep' });
    expect(request.expected_revision).toBe(hex('b'));
    const replaced = nativeCompatibilityRequest(view, candidateDraft({
      password: { action: 'replace', replace: 'c'.repeat(24) } }));
    expect(replaced.password).toEqual({ action: 'replace', value: 'c'.repeat(24) });
  });
  it('forwards the honest domain codes and refuses action/value drift', () => {
    const view = parseNativeCompatibilityView(presentView());
    expect(() => nativeCompatibilityRequest(view, candidateDraft({ hostname: 'http://bad' })))
      .toThrow(/opencode_hostname_invalid/u);
    expect(() => nativeCompatibilityRequest(view, candidateDraft({ port: 65_536 })))
      .toThrow(/opencode_bind_port_invalid/u);
    expect(() => nativeCompatibilityRequest(view, candidateDraft({ username: 'bad:name' })))
      .toThrow(/opencode_username_invalid/u);
    expect(() => nativeCompatibilityRequest(view, candidateDraft({ password: { action: 'replace', replace: 'short' } })))
      .toThrow(/opencode_password_invalid/u);
    expect(() => nativeCompatibilityRequest(view, candidateDraft({ password: { action: 'keep', replace: 'x'.repeat(24) } })))
      .toThrow(NativeCompatibilityFailure);
    expect(() => nativeCompatibilityRequest(view, candidateDraft({ password: { action: 'clear', replace: 'x'.repeat(24) } })))
      .toThrow(NativeCompatibilityFailure);
  });
});

describe('compatibility catalog and receipt parsers', () => {
  it('pins the seven census fields and the manage authority statement on every edit', () => {
    const parsed = parseNativeCompatibilityCatalog(catalog());
    expect(parsed.fields.map(field => field.path)).toEqual(
      ['version', 'enabled', 'hostname', 'port', 'username', 'password', 'updated_at']);
    const password = parsed.fields.find(field => field.path === 'password')!;
    expect(password.type).toBe('secret');
    expect(password.editability).toEqual({ available: true, scope: 'user',
      required_permission: 'nnd.configuration.manage' });
    for (const bad of [
      { schema_version: '1.0', source: 'compatibility_service', scope: 'user', fields: [] },
      { schema_version: '1.0', source: 'web_search', scope: 'user',
        fields: catalog().fields.map(field => ({ ...field, application: 'next_search' })) },
      { schema_version: '1.0', source: 'compatibility_service', scope: 'user', fields:
        catalog().fields.map(field => field.path !== 'password' ? field
          : { ...field, editability: { available: true, scope: 'user',
            required_permission: 'nnd.configuration.read' } }) },
      { schema_version: '1.0', source: 'compatibility_service', scope: 'user', fields:
        catalog().fields.map(field => field.path !== 'updated_at' ? field
          : { ...field, editability: { available: true, scope: 'user',
            required_permission: 'nnd.configuration.manage' } }) },
    ]) expect(() => parseNativeCompatibilityCatalog(bad)).toThrow();
  });
});
// Receipt parsing is anchored end-to-end in the settings page test (save + operation
// roundtrip against native-shaped JSON), matching the web-search family split.
