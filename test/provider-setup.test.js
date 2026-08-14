// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveManifest } from '../src/config.js';
import { withProvider, withRouteSetting, withRuntimeLimits } from '../src/route-configuration.js';
import { TuiProjection } from '../src/tui-model.js';
import { providerOverlay } from '../src/tui-overlays.js';
import { handleActions } from '../src/tui.js';
import {
  beginProviderRouteSettingsSelection, handleProviderRouteSettingsAction,
} from '../src/tui-provider-route-settings.js';
import {
  availableProfileId, beginProviderManagement, handleProviderSetupAction, isProviderSetupOverlay,
} from '../src/tui-provider-setup.js';

test('provider add is a guided form with discovery and a model picker', async () => {
  let config = resolveManifest({
    providers: [{ id: 'existing', display_name: 'Existing', endpoint: 'http://127.0.0.1:1/v1', model: 'old', trust_zone: 'loopback' }],
    routes: { primary: { provider_id: 'existing', model: 'old' } },
  });
  const projection = new TuiProjection();
  projection.addSession('main', 'Main', { provider: 'existing', model: 'old' }, 'primary');
  let discoveryInput;
  const workspace = {
    projection, config, onChange() {}, activeConfig: () => config,
    async discoverProviderModels(input) {
      discoveryInput = input;
      return { ready: true, models: ['qwen-test', 'other-model'] };
    },
    async addProvider(input) {
      config = withProvider(config, input).config;
      this.config = config;
      return config.providerProfiles[input.id];
    },
  };

  beginProviderManagement('add', workspace);
  assert.equal(projection.overlay.kind, 'provider-preset');
  assert.equal(isProviderSetupOverlay(projection.overlay), true);
  await handleProviderSetupAction({ action: 'submit' }, workspace);
  assert.equal(projection.overlay.kind, 'provider-form');
  assert.match(projection.overlay.lines.join('\n'), /Provider label/u);

  await handleProviderSetupAction({ action: 'submit' }, workspace);
  await handleProviderSetupAction({ action: 'submit' }, workspace);
  assert.equal(projection.overlay.kind, 'provider-auth-select');
  assert.equal(projection.overlay.items[projection.overlay.selected].id, 'none');
  await handleProviderSetupAction({ action: 'submit' }, workspace);
  assert.equal(discoveryInput.endpoint, 'http://127.0.0.1:1234/v1');
  assert.equal(discoveryInput.credentialEnv, '');
  assert.equal(projection.overlay.kind, 'provider-model-select');
  assert.deepEqual(projection.overlay.items.slice(0, 2).map((item) => item.id), ['qwen-test', 'other-model']);
  assert.equal(projection.overlay.items[0].detail, undefined);
  assert.equal(projection.overlay.items[1].detail, undefined);

  await handleProviderSetupAction({ action: 'submit' }, workspace);
  assert.equal(config.providerProfiles['lm-studio'].model, 'qwen-test');
  assert.equal(config.providerProfiles['lm-studio'].displayName, 'LM Studio');
  assert.equal(projection.overlay.kind, 'provider');
  assert.match(projection.notice.text, /Added provider lm-studio/u);
});

test('provider model picker keeps save failures visible', async () => {
  const config = resolveManifest({
    provider: { id: 'one', endpoint: 'http://127.0.0.1:1/v1', model: 'a', trust_zone: 'loopback' },
  });
  const projection = new TuiProjection();
  projection.addSession('main', 'Main', { provider: 'one', model: 'a' }, 'primary');
  const workspace = {
    projection, config, onChange() {}, activeConfig: () => config,
    async discoverProviderModels() { return { ready: true, models: ['qwen-test'] }; },
    async addProvider() {
      const error = new Error('another conversation has an incompatible scope');
      error.code = 'configuration_scope_change';
      throw error;
    },
  };

  beginProviderManagement('add', workspace);
  await handleProviderSetupAction({ action: 'submit' }, workspace);
  await handleProviderSetupAction({ action: 'submit' }, workspace);
  await handleProviderSetupAction({ action: 'submit' }, workspace);
  await handleProviderSetupAction({ action: 'submit' }, workspace);
  assert.equal(projection.overlay.kind, 'provider-model-select');

  await handleProviderSetupAction({ action: 'submit' }, workspace);
  assert.equal(projection.overlay.kind, 'provider-model-select');
  assert.match(projection.overlay.lines.at(-1), /configuration_scope_change/u);
});

test('provider setup requests a credential reference only when environment authentication is selected', async () => {
  const config = resolveManifest({
    provider: { id: 'one', endpoint: 'http://127.0.0.1:1/v1', model: 'a', trust_zone: 'loopback' },
  });
  const projection = new TuiProjection();
  projection.addSession('main', 'Main', { provider: 'one', model: 'a' }, 'primary');
  let discoveryInput;
  const workspace = {
    projection, config, onChange() {}, activeConfig: () => config,
    async discoverProviderModels(input) { discoveryInput = input; return { ready: true, models: ['secured-model'] }; },
  };
  beginProviderManagement('add', workspace);
  await handleProviderSetupAction({ action: 'submit' }, workspace);
  await handleProviderSetupAction({ action: 'submit' }, workspace);
  await handleProviderSetupAction({ action: 'submit' }, workspace);
  projection.moveOverlaySelection(1);
  await handleProviderSetupAction({ action: 'submit' }, workspace);
  assert.equal(projection.overlay.kind, 'provider-form');
  assert.match(projection.overlay.lines.join('\n'), /API key source/u);
  projection.overlay.editor.set('MY_LLM_API_KEY');
  await handleProviderSetupAction({ action: 'submit' }, workspace);
  assert.equal(discoveryInput.credentialEnv, 'MY_LLM_API_KEY');
  assert.equal(projection.overlay.kind, 'provider-model-select');
});

test('provider setup preserves a same-level back path and supports manual model fallback', async () => {
  const config = resolveManifest({
    provider: { id: 'one', endpoint: 'http://127.0.0.1:1/v1', model: 'a', trust_zone: 'loopback' },
  });
  const projection = new TuiProjection();
  projection.addSession('main', 'Main', { provider: 'one', model: 'a' }, 'primary');
  const workspace = {
    projection, config, onChange() {}, activeConfig: () => config,
    async discoverProviderModels() { throw Object.assign(new Error('offline'), { code: 'provider_unavailable' }); },
  };
  beginProviderManagement('add', workspace);
  await handleProviderSetupAction({ action: 'submit' }, workspace);
  await handleProviderSetupAction({ action: 'back' }, workspace);
  assert.equal(projection.overlay.kind, 'provider-preset');
  await handleProviderSetupAction({ action: 'submit' }, workspace);
  for (let step = 0; step < 3; step += 1) await handleProviderSetupAction({ action: 'submit' }, workspace);
  assert.equal(projection.overlay.kind, 'provider-form');
  assert.match(projection.overlay.lines.join('\n'), /Model discovery unavailable · provider_unavailable/u);
  assert.match(projection.overlay.lines.join('\n'), /Default model/u);
});

test('provider labels generate stable internal IDs and collisions remain persistent', () => {
  assert.equal(availableProfileId('Jack Qwen 3.6 @ Q4_K_XL'), 'jack-qwen-3-6-q4-k-xl');
  assert.equal(availableProfileId('LM Studio', ['lm-studio']), 'lm-studio-2');
  assert.equal(availableProfileId('日本語', ['provider']), 'provider-2');
});

test('provider form keeps invalid input visible and explains why Enter cannot continue', async () => {
  const config = resolveManifest({
    provider: { id: 'one', endpoint: 'http://127.0.0.1:1/v1', model: 'a', trust_zone: 'loopback' },
  });
  const projection = new TuiProjection();
  projection.addSession('main', 'Main', { provider: 'one', model: 'a' }, 'primary');
  const workspace = { projection, config, onChange() {}, activeConfig: () => config };
  beginProviderManagement('add', workspace);
  await handleProviderSetupAction({ action: 'submit' }, workspace);
  await handleProviderSetupAction({ action: 'submit' }, workspace);
  projection.overlay.editor.set('not a URL');
  await handleProviderSetupAction({ action: 'submit' }, workspace);
  assert.match(projection.overlay.lines.join('\n'), /Cannot continue · Enter a complete HTTP or HTTPS provider endpoint/u);
  assert.equal(projection.overlay.editor.text, 'not a URL');
});

test('provider configuration fields reduce pasted clipboard content to one line', async () => {
  const config = resolveManifest({
    provider: { id: 'one', endpoint: 'http://127.0.0.1:1/v1', model: 'a', trust_zone: 'loopback' },
  });
  const projection = new TuiProjection();
  projection.addSession('main', 'Main', { provider: 'one', model: 'a' }, 'primary');
  const workspace = { projection, config, onChange() {}, activeConfig: () => config };
  beginProviderManagement('add', workspace);
  await handleProviderSetupAction({ action: 'submit' }, workspace);
  projection.overlay.editor.set('');
  await handleProviderSetupAction({ action: 'paste', text: 'Remote Lab\r\nignored second line' }, workspace);
  assert.equal(projection.overlay.editor.text, 'Remote Lab');
  assert.doesNotMatch(projection.overlay.lines.join('\n'), /ignored second line/u);
});

test('every provider role exposes settings and timeout overrides can return to global inheritance', async () => {
  let config = resolveManifest({
    provider: { id: 'one', endpoint: 'http://127.0.0.1:1/v1', model: 'a', trust_zone: 'loopback' },
  });
  const projection = new TuiProjection();
  projection.addSession('main', 'Main', { provider: 'one', model: 'a' }, 'primary');
  const workspace = {
    projection, config, activeConfig: () => config, onChange() {},
    async configureProviderRoute(role, setting, value) {
      config = withRouteSetting(config, role, setting, value).config; this.config = config;
    },
    async configureRuntimeLimits(values) {
      config = withRuntimeLimits(config, values).config; this.config = config;
    },
  };
  for (const role of ['primary', 'subagent', 'reviewer', 'vision']) {
    assert.equal(providerOverlay({ config }, { role }).items.some((item) => item.id === 'route-settings'), true);
  }
  const mainProviders = providerOverlay({ config }, { role: 'primary', canAssign: true, isMain: true });
  const globalSettings = mainProviders.items.find((item) => item.id === 'global-settings');
  assert.equal(beginProviderRouteSettingsSelection(globalSettings, workspace, mainProviders), true);
  assert.equal(projection.overlay.kind, 'global-provider-settings');
  assert.match(projection.overlay.lines.join('\n'), /1,800s \(built in\)/u);
  await handleProviderRouteSettingsAction({ action: 'submit' }, workspace);
  projection.overlay.editor.set('120');
  await handleProviderRouteSettingsAction({ action: 'submit' }, workspace);
  assert.equal(config.limits.providerOverrideMs, 120_000);
  assert.equal(config.routes.primary.deadlineMs, 120_000);
  projection.moveOverlaySelection(1);
  await handleProviderRouteSettingsAction({ action: 'submit' }, workspace);
  assert.equal(config.limits.providerOverrideMs, null);
  assert.equal(config.routes.primary.deadlineMs, 1_800_000);

  const providers = providerOverlay({ config }, { role: 'primary', canAssign: true });
  assert.equal(beginProviderRouteSettingsSelection(providers.items[0], workspace, providers), true);
  assert.equal(projection.overlay.kind, 'provider-route-settings');
  assert.match(projection.overlay.lines.join('\n'), /Overall attempt timeout  1,800s \(global\)/u);
  await handleProviderRouteSettingsAction({ action: 'submit' }, workspace);
  assert.equal(projection.overlay.kind, 'provider-route-setting-form');
  projection.overlay.editor.set('');
  await handleActions([{ action: 'insert', text: '120' }], workspace, () => undefined, { setBindings() {} });
  assert.equal(projection.overlay.editor.text, '120');
  assert.match(projection.overlay.lines.join('\n'), /120/u);
  projection.overlay.editor.set('120');
  await handleProviderRouteSettingsAction({ action: 'submit' }, workspace);
  assert.equal(config.routes.primary.deadlineOverrideMs, 120_000);
  assert.equal(projection.overlay.items.some((item) => item.id === 'timeout-inherit'), true);
  projection.moveOverlaySelection(projection.overlay.items.findIndex((item) => item.id === 'timeout-inherit'));
  await handleProviderRouteSettingsAction({ action: 'submit' }, workspace);
  assert.equal(config.routes.primary.deadlineOverrideMs, null);
  assert.equal(config.routes.primary.deadlineMs, 1_800_000);
  projection.moveOverlaySelection(1);
  await handleProviderRouteSettingsAction({ action: 'submit' }, workspace);
  projection.overlay.editor.set('0.35');
  await handleProviderRouteSettingsAction({ action: 'submit' }, workspace);
  assert.equal(config.routes.primary.temperature, 0.35);
});
