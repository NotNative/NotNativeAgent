// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfiguration } from '../src/configuration-sources.js';
import { NND_CONFIGURATION_OPTIONS } from '../src/nnd-configuration-sources.js';
import { projectNndConfigurationView } from '../src/nnd-configuration-view.js';
import { validateDream } from '../src/dream-config.js';

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

test('the tui family serves all twenty census paths with explicit, merged defaults and provenance', () => {
  const census = ['tui.reduced_motion', 'tui.color', 'tui.key_bindings',
    'tui.key_bindings.submit', 'tui.key_bindings.newline', 'tui.key_bindings.cancel',
    'tui.key_bindings.help', 'tui.key_bindings.allow_once', 'tui.key_bindings.deny',
    'tui.key_bindings.reset_keys', 'tui.key_bindings.undo', 'tui.key_bindings.toggle_activity',
    'tui.key_bindings.new_tab', 'tui.key_bindings.close_tab', 'tui.key_bindings.previous_tab',
    'tui.key_bindings.next_tab', 'tui.key_bindings.cycle_review', 'tui.key_bindings.scroll_page_up',
    'tui.key_bindings.scroll_page_down', 'tui.key_bindings.scroll_bottom'];
  const source = snapshot({ tui: { reduced_motion: true, color: false,
    key_bindings: { submit: 'ctrl+e', cancel: 'ctrl+x' } } });
  const view = projectNndConfigurationView(source);
  for (const path of census) assert.ok(row(view, path), `census path ${path} missing from the view`);
  assert.deepEqual(row(view, 'tui.reduced_motion').explicit, { present: true, value: true });
  assert.deepEqual(row(view, 'tui.color').explicit, { present: true, value: false });
  assert.deepEqual(row(view, 'tui.key_bindings').explicit, { present: true, value_unavailable: true });
  assert.deepEqual(row(view, 'tui.key_bindings.submit').explicit, { present: true, value: 'ctrl+e' });
  assert.deepEqual(row(view, 'tui.key_bindings.cancel').explicit, { present: true, value: 'ctrl+x' });
  for (const action of ['newline', 'help', 'allow_once', 'deny', 'reset_keys', 'undo',
    'toggle_activity', 'new_tab', 'close_tab', 'previous_tab', 'next_tab', 'cycle_review',
    'scroll_page_up', 'scroll_page_down', 'scroll_bottom']) {
    assert.deepEqual(row(view, `tui.key_bindings.${action}`).explicit, { present: false }, action);
  }
  assert.equal(row(view, 'tui.reduced_motion').effective.value, true);
  assert.equal(row(view, 'tui.color').effective.value, false);
  assert.deepEqual(row(view, 'tui.key_bindings').effective,
    { present: true, value_unavailable: true, source_unavailable: true });
  const merged = { submit: 'ctrl+e', newline: 'ctrl+j', cancel: 'ctrl+x', help: 'ctrl+g',
    allow_once: 'ctrl+y', deny: 'ctrl+n', reset_keys: 'f12', undo: 'ctrl+z',
    toggle_activity: 'ctrl+o', new_tab: 'ctrl+t', close_tab: 'ctrl+w', previous_tab: 'ctrl+pageup',
    next_tab: 'ctrl+pagedown', cycle_review: 'shift+tab', scroll_page_up: 'pageup',
    scroll_page_down: 'pagedown', scroll_bottom: 'end' };
  for (const [action, binding] of Object.entries(merged)) {
    assert.equal(row(view, `tui.key_bindings.${action}`).effective.value, binding, action);
    const explicit = action === 'submit' || action === 'cancel';
    if (explicit) assert.equal(row(view, `tui.key_bindings.${action}`).effective.source, 'user', action);
    else assert.equal(row(view, `tui.key_bindings.${action}`).effective.source_unavailable, true, action);
  }
});

test('absent tui blocks still project the documented defaults without inventing a source', () => {
  const view = projectNndConfigurationView(snapshot());
  assert.deepEqual(row(view, 'tui.reduced_motion').explicit, { present: false });
  assert.deepEqual(row(view, 'tui.reduced_motion').effective,
    { present: true, value: false, source: 'compiled_default' });
  assert.deepEqual(row(view, 'tui.color').effective,
    { present: true, value: true, source: 'compiled_default' });
  assert.deepEqual(row(view, 'tui.key_bindings.submit').effective,
    { present: true, value: 'ctrl+s', source_unavailable: true });
  assert.equal(row(view, 'tui.key_bindings.scroll_bottom').effective.value, 'end');
});

test('the mission family serves the sixteen census paths as honest absence for the desktop principal', () => {
  const census = ['mission.id', 'mission.outcome', 'mission.revocation_id', 'mission.not_before',
    'mission.expires_at', 'mission.resources', 'mission.targets', 'mission.side_effects',
    'mission.credential_refs', 'mission.bounds', 'mission.termination', 'mission.bounds.max_turns',
    'mission.bounds.max_tool_calls', 'mission.bounds.max_duration_ms',
    'mission.termination.suspend_on', 'mission.termination.terminate_on'];
  const view = projectNndConfigurationView(snapshot());
  for (const path of [...census, 'mission']) {
    assert.ok(row(view, path), `mission path ${path} missing from the view`);
    assert.deepEqual(row(view, path).explicit, { present: false }, `explicit ${path}`);
    assert.deepEqual(row(view, path).effective, { present: false }, `effective ${path}`);
  }
});

test('a user manifest carrying a mission block is refused before validation order and never reaches the view', () => {
  const mission = {
    id: 'mission_release', revocation_id: 'rev_1', outcome: 'ship the release',
    not_before: '2026-10-01T00:00:00.000Z', expires_at: '2026-10-08T00:00:00.000Z',
    resources: ['repo:release'], targets: ['packages/ui'], side_effects: ['irreversible'],
    credential_refs: ['RELEASE_TOKEN'], bounds: { max_turns: 12 },
    termination: { suspend_on: ['disconnect'], terminate_on: ['budget_exhaustion', 'expiration', 'disconnect'] },
  };
  // The principal is checked first (src/config.js:validateMission); the schedule order,
  // bounded lists, and the required termination conditions never run for this operator.
  assert.throws(() => snapshot({ mission }), (error) => error.code === 'mission_authority_forbidden'
    && !JSON.stringify(error).includes('ship the release')
    && !JSON.stringify(error).includes('RELEASE_TOKEN')
    && !JSON.stringify(error).includes('2026-10-08'));
});

test('the recovery family serves the documented ladder truncation and refuses bad budgets', () => {
  // src/configuration-rules.js: max_model_steps 16..100_000 default 1024,
  // local_retry_limit 2..5 default 3, turn_wall_clock_ms 1_000..86_400_000
  // with null and 0 meaning unset. src/config.js:validateRecovery slices
  // the ladder to local_retry_limit - 1 steps.
  const bare = projectNndConfigurationView(snapshot());
  assert.deepEqual(row(bare, 'recovery.max_model_steps').effective,
    { present: true, value: 1024, source: 'compiled_default' });
  assert.deepEqual(row(bare, 'recovery.local_retry_limit').effective,
    { present: true, value: 3, source: 'compiled_default' });
  assert.deepEqual(row(bare, 'recovery.turn_wall_clock_ms').effective,
    { present: true, value: null, source: 'compiled_default' });
  assert.deepEqual(row(bare, 'recovery.ladder').effective,
    { present: true, value: ['nudge', 'compact'], source_unavailable: true },
    'the default ladder is truncated to the default limit minus one');
  const mine = projectNndConfigurationView(snapshot({ recovery: { max_model_steps: 64, local_retry_limit: 5,
    turn_wall_clock_ms: 300_000, ladder: ['nudge', 'compact', 'compact', 'compact'] } }));
  assert.deepEqual(row(mine, 'recovery.max_model_steps').effective, { present: true, value: 64, source: 'user' });
  assert.deepEqual(row(mine, 'recovery.turn_wall_clock_ms').explicit, { present: true, value: 300_000 });
  assert.deepEqual(row(mine, 'recovery.ladder').explicit?.value, ['nudge', 'compact', 'compact', 'compact']);
  const tighter = projectNndConfigurationView(snapshot({ recovery: { local_retry_limit: 3,
    ladder: ['nudge', 'compact', 'compact', 'compact'] } }));
  assert.deepEqual(row(tighter, 'recovery.ladder').effective?.value, ['nudge', 'compact'],
    'an explicit ladder longer than the limit minus one is truncated');
  for (const bad of [{ ladder: ['nudge'] }, { ladder: ['explode'] }]) {
    assert.throws(() => snapshot({ recovery: bad }), (error) => error.code === 'recovery_config_invalid', JSON.stringify(bad));
  }
  for (const bad of [{ local_retry_limit: 9 }, { turn_wall_clock_ms: 5 }]) {
    assert.throws(() => snapshot({ recovery: bad }), (error) => error.code === 'invalid_limit', JSON.stringify(bad));
  }
});

test('the memory family serves user values, the documented defaults, and refuses out-of-range bounds', () => {
  // Bounds come from src/configuration-rules.js: timeout_ms 50..30_000,
  // max_items 1..64, max_bytes 1_024..262_144; enabled is opt-out and
  // required is opt-in (src/config.js:validateMemory).
  const defaults = { 'memory.enabled': true, 'memory.required': false, 'memory.timeout_ms': 750,
    'memory.max_items': 8, 'memory.max_bytes': 16_384 };
  const view = projectNndConfigurationView(snapshot());
  for (const [path, value] of Object.entries(defaults)) {
    assert.deepEqual(row(view, path).explicit, { present: false }, path);
    assert.deepEqual(row(view, path).effective, { present: true, value, source: 'compiled_default' }, path);
  }
  const mine = projectNndConfigurationView(snapshot({ memory: { enabled: false, required: false,
    timeout_ms: 2_000, max_items: 16, max_bytes: 65_536 } }));
  assert.deepEqual(row(mine, 'memory.enabled').effective, { present: true, value: false, source: 'user' });
  assert.deepEqual(row(mine, 'memory.timeout_ms').effective, { present: true, value: 2_000, source: 'user' });
  assert.deepEqual(row(mine, 'memory.max_bytes').explicit, { present: true, value: 65_536 });
  for (const bad of [{ timeout_ms: 10 }, { max_items: 100 }, { max_bytes: 1_000 }]) {
    assert.throws(() => snapshot({ memory: bad }), (error) => error.code === 'invalid_limit', JSON.stringify(bad));
  }
});

test('the dream family serves user values, the documented defaults, and the host forced-disable', () => {
  // Bounds come from src/configuration-rules.js: idle_ms 5_000..3_600_000,
  // inter_stage_ms 1_000..300_000, inference_idle_ms 10_000..3_600_000,
  // hygiene_idle_ms 30_000..7_200_000, retention_days 1..365.
  const defaults = { 'dream.enabled': true, 'dream.idle_ms': 45_000, 'dream.inter_stage_ms': 5_000,
    'dream.inference_idle_ms': 120_000, 'dream.hygiene_idle_ms': 300_000, 'dream.retention_days': 30 };
  const view = projectNndConfigurationView(snapshot());
  for (const [path, value] of Object.entries(defaults)) {
    assert.deepEqual(row(view, path).explicit, { present: false }, path);
    assert.deepEqual(row(view, path).effective, { present: true, value, source: 'compiled_default' }, path);
  }
  const mine = projectNndConfigurationView(snapshot({ dream: { enabled: false, idle_ms: 60_000,
    inter_stage_ms: 15_000, inference_idle_ms: 90_000, hygiene_idle_ms: 60_000, retention_days: 7 } }));
  assert.deepEqual(row(mine, 'dream.enabled').effective, { present: true, value: false, source: 'user' });
  assert.deepEqual(row(mine, 'dream.idle_ms').effective, { present: true, value: 60_000, source: 'user' });
  assert.deepEqual(row(mine, 'dream.retention_days').explicit, { present: true, value: 7 });
  // Out-of-range values fail the resolve before anything can apply.
  assert.throws(() => snapshot({ dream: { idle_ms: 1_000 } }), (error) => error.code === 'invalid_limit');
  assert.throws(() => snapshot({ dream: { retention_days: 400 } }), (error) => error.code === 'invalid_limit');
  // Idle maintenance is opt-out for a standalone host, and an authenticated
  // hosted execution manifest always disables it (src/dream-config.js:validateDream).
  assert.equal(validateDream({ enabled: true }, { id: 'execution_fixture' }).enabled, false);
  assert.equal(validateDream({ enabled: true }, null).enabled, true);
});

test('the attachments family serves the documented defaults, user values, and byte bounds', () => {
  // src/configuration-rules.js bounds max_bytes 1_024..104_857_600 with
  // default 10_485_760; src/config.js:validateAttachments treats enabled as
  // opt-out (only exact false disables) and retain as opt-in (only exact
  // true retains).
  const view = projectNndConfigurationView(snapshot());
  assert.deepEqual(row(view, 'attachments.enabled').effective, { present: true, value: true, source: 'compiled_default' });
  assert.deepEqual(row(view, 'attachments.max_bytes').effective,
    { present: true, value: 10_485_760, source: 'compiled_default' });
  assert.deepEqual(row(view, 'attachments.retain').effective, { present: true, value: false, source: 'compiled_default' });
  const mine = projectNndConfigurationView(snapshot({ attachments: { enabled: false, max_bytes: 2_097_152, retain: true } }));
  assert.deepEqual(row(mine, 'attachments.enabled').effective, { present: true, value: false, source: 'user' });
  assert.deepEqual(row(mine, 'attachments.max_bytes').explicit, { present: true, value: 2_097_152 });
  assert.deepEqual(row(mine, 'attachments.retain').effective, { present: true, value: true, source: 'user' });
  // Anything but an exact false is treated as enabled; anything but an exact
  // true is treated as not retaining.
  const coerced = projectNndConfigurationView(snapshot({ attachments: { enabled: 'yes', retain: 'always' } }));
  assert.deepEqual(row(coerced, 'attachments.enabled').effective.value, true);
  assert.deepEqual(row(coerced, 'attachments.retain').effective.value, false);
  for (const bad of [{ max_bytes: 512 }, { max_bytes: 200_000_000 }]) {
    assert.throws(() => snapshot({ attachments: bad }), (error) => error.code === 'invalid_limit', JSON.stringify(bad));
  }
});

test('the telemetry family is opt-in, requires a destination when enabled, and is inert when disabled', () => {
  // src/config.js:validateTelemetry: enabled only on exact true; enabling
  // without a string destination throws telemetry_destination_required;
  // when disabled, destination and retention resolve to null but the
  // explicit source value stays visible.
  const bare = projectNndConfigurationView(snapshot());
  assert.deepEqual(row(bare, 'telemetry.enabled').effective, { present: true, value: false, source: 'compiled_default' });
  assert.deepEqual(row(bare, 'telemetry.destination').effective, { present: true, value: null, source: 'compiled_default' });
  assert.deepEqual(row(bare, 'telemetry.retention').effective, { present: true, value: null, source: 'compiled_default' });
  const mine = projectNndConfigurationView(snapshot({ telemetry: { enabled: true,
    destination: 'https://collector.example/uploads', retention: 'PT24H' } }));
  assert.deepEqual(row(mine, 'telemetry.enabled').effective, { present: true, value: true, source: 'user' });
  assert.deepEqual(row(mine, 'telemetry.destination').effective,
    { present: true, value: 'https://collector.example/uploads', source: 'user' });
  assert.deepEqual(row(mine, 'telemetry.retention').explicit, { present: true, value: 'PT24H' });
  assert.throws(() => snapshot({ telemetry: { enabled: true } }), (error) => error.code === 'telemetry_destination_required');
  const disabled = projectNndConfigurationView(snapshot({ telemetry: { destination: 'not a url' } }));
  assert.deepEqual(row(disabled, 'telemetry.destination').explicit, { present: true, value: 'not a url' });
  assert.deepEqual(row(disabled, 'telemetry.destination').effective.value, null,
    'a disabled telemetry block resolves the destination to null');
});
