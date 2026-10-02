// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfiguration } from '../src/configuration-sources.js';
import { NND_CONFIGURATION_OPTIONS } from '../src/nnd-configuration-sources.js';
import { projectNndConfigurationView } from '../src/nnd-configuration-view.js';

const provider = { id: 'local', endpoint: 'http://127.0.0.1:9/v1', model: 'base', trust_zone: 'loopback' };
function snapshot(raw = {}) {
  const source = { provider, workspace_root: process.cwd(), ...raw };
  return { installationId: 'nna_fixture', dataId: 'data_fixture', sourceState: 'present', sourceRevision: 'a'.repeat(64),
    resolutionRevision: 'b'.repeat(64), sourceSnapshots: [{ name: 'user', revision: 'a'.repeat(64) }],
    persistedSource: { manifest: source }, ...resolveConfiguration([{ name: 'user', manifest: source }], { manifestOptions: NND_CONFIGURATION_OPTIONS }) };
}
const row = (view, path) => view.fields.find(item => item.path === path);

test('safe view distinguishes explicit absence, null, zero and false without inventing application', () => {
  const source = snapshot({ memory: { enabled: false } });
  source.persistedSource.manifest.provider_timeout_ms = 0;
  source.persistedSource.manifest.first_token_timeout_ms = null;
  const view = projectNndConfigurationView(source);
  assert.deepEqual(row(view, 'memory.enabled').explicit, { present: true, value: false });
  assert.deepEqual(row(view, 'provider_timeout_ms').explicit, { present: true, value: 0 });
  assert.deepEqual(row(view, 'first_token_timeout_ms').explicit, { present: true, value: null });
  assert.deepEqual(row(view, 'provider_connect_timeout_ms').explicit, { present: false });
  assert.equal(row(view, 'memory.enabled').effective.source, 'user');
  assert.ok(view.fields.every(item => item.application === 'not_applied'));
  assert.equal(view.application, 'not_applied');
});

test('projection never returns containers, unknown extensions or credential references', () => {
  const source = snapshot();
  source.persistedSource.manifest.provider = { ...provider, credential: { source: 'secret', secret_id: 'SECRET_REFERENCE' }, extension: 'UNKNOWN_SECRET' };
  source.persistedSource.manifest.memory = { extension: 'NESTED_SECRET' };
  source.persistedSource.manifest.extension = 'ROOT_SECRET';
  source.persistedSource.manifest.mcp_servers = [{ id: 'mcp-one', args: ['--token', 'ARG_SECRET'] }];
  const view = projectNndConfigurationView(source), serialized = JSON.stringify(view);
  for (const secret of ['SECRET_REFERENCE', 'UNKNOWN_SECRET', 'NESTED_SECRET', 'ROOT_SECRET', 'ARG_SECRET']) assert.ok(!serialized.includes(secret));
  assert.deepEqual(row(view, 'provider.credential.secret_id').explicit, { present: true, redacted: true });
  assert.deepEqual(row(view, 'memory').explicit, { present: true, value_unavailable: true });
});

test('provider and MCP concrete identifiers are stable, sanitized and bounded', () => {
  const source = snapshot();
  source.persistedSource.manifest.providers = [{ id: 'alpha', model: 'a' }, { id: 'unsafe/]secret', model: 'b' }];
  const first = projectNndConfigurationView(source);
  source.persistedSource.manifest.providers.reverse();
  const second = projectNndConfigurationView(source);
  const selected = view => view.fields.filter(item => item.catalog_path === 'providers[*].model').map(item => item.path).sort();
  assert.deepEqual(selected(first), selected(second));
  assert.ok(!JSON.stringify(first).includes('unsafe/]secret'));
  source.persistedSource.manifest.providers = Array.from({ length: 129 }, (_, index) => ({ id: String(index) }));
  assert.throws(() => projectNndConfigurationView(source), { code: 'nnd_configuration_view_invalid' });
});

test('invalid source exposes only absence and revision, not parser text or raw bytes', () => {
  const view = projectNndConfigurationView({ installationId: 'nna_fixture', dataId: 'data_fixture', sourceState: 'invalid',
    sourceRevision: 'c'.repeat(64), rawBytes: 'SECRET', failureCode: 'SECRET parser exception' });
  assert.equal(view.source_state, 'invalid'); assert.equal(view.source_revision, 'c'.repeat(64));
  assert.ok(view.fields.every(item => !item.explicit.present && !item.effective.present));
  assert.ok(!JSON.stringify(view).includes('SECRET'));
});

test('effective projection includes actual defaults and inherited values omitted by persistence serialization', () => {
  const source = snapshot({ routes: { primary: { deadline_ms: 120000 }, reviewer: { temperature: 0 } } });
  const view = projectNndConfigurationView(source);
  for (const [path, expected] of [
    ['application_system_prompt', ''], ['provider.tool_call_mode', 'single'],
    ['provider.capabilities.streaming', true], ['provider_timeout_ms', source.config.limits.providerMs],
    ['first_token_timeout_ms', source.config.limits.firstTokenMs], ['idle_timeout_ms', source.config.limits.idleMs],
    ['routes.primary.deadline_ms', 120000], ['routes.reviewer.provider_id', 'local'],
    ['routes.reviewer.model', 'base'], ['routes.reviewer.deadline_ms', 120000],
    ['routes.reviewer.temperature', null], ['recovery.turn_wall_clock_ms', null],
    ['tui.key_bindings.submit', 'ctrl+s'],
  ]) {
    assert.equal(row(view, path).effective.present, true, path);
    assert.equal(row(view, path).effective.value, expected, path);
  }
  assert.deepEqual(row(view, 'provider_timeout_ms').explicit, { present: false });
  assert.deepEqual(row(view, 'routes.reviewer.temperature').explicit, { present: true, value: 0 });
  assert.equal(row(view, 'provider.tool_call_mode').effective.source_unavailable, true);
  assert.equal(row(view, 'provider.tool_call_mode').effective.source, undefined);
});
