// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';
import { REASONING_EFFORTS } from '../provider/reasoning.js';
import { createFormOverlay, formField, handleFormEditing } from './form-engine.js';
import { createMenuOverlay } from './surface-engine.js';

const LABELS = Object.freeze({
  primary: 'Primary', subagent: 'Sub-agents', reviewer: 'Permission reviewer', vision: 'Vision',
});
const MAX_TIMEOUT_SECONDS = 86_400;
const MAX_OUTPUT_TOKENS = 1_048_576;
const MAX_ROUTE_BUDGET = 64;
const SETTING_EDITOR_BYTES = 128;
const PROVIDER_DEFAULT = 'Provider default';
const SETTINGS = Object.freeze({
  timeout: Object.freeze({ label: 'Overall attempt timeout', detail: 'Seconds allowed for prompt processing and generation. Enter 0 for no timeout.' }),
  temperature: Object.freeze({ label: 'Temperature', detail: 'Sampling temperature from 0 through 2. Enter 0 to leave sampling unset and use the provider default.' }),
  output: Object.freeze({ label: 'Maximum output tokens', detail: 'Maximum tokens requested from the provider. Enter 0 for no explicit limit.' }),
  budget: Object.freeze({ label: 'Fallback attempt budget', detail: 'Maximum eligible route attempts from 1 through 64. Enter 0 to use every eligible route.' }),
  reasoning_effort: Object.freeze({ label: 'Reasoning effort', detail: 'OpenAI-compatible reasoning_effort. Availability depends on the model.', options: true }),
  enable_thinking: Object.freeze({ label: 'Thinking mode', detail: 'Qwen-compatible chat_template_kwargs.enable_thinking.', options: true }),
});

export function beginProviderRouteSettingsSelection(selected, workspace, overlay) {
  if (overlay?.kind !== 'provider' || selected?.id !== 'route-settings') return false;
  const editable = overlay.role === 'primary' || overlay.canAssign !== false;
  workspace.projection.openOverlay(routeSettingsOverlay(routeConfig(workspace, overlay.role), overlay.role, {
    editable, parentProvider: overlay,
  }));
  return true;
}

export async function handleProviderRouteSettingsAction(action, workspace) {
  const overlay = workspace.projection.overlay;
  if (overlay?.kind === 'provider-route-setting-options') return handleSettingOptions(action, workspace, overlay);
  if (!['provider-route-settings', 'provider-route-setting-form'].includes(overlay?.kind)) return false;
  if (overlay.kind === 'provider-route-setting-form') return handleForm(action, workspace, overlay);
  if (['cancel', 'help'].includes(action.action)) { workspace.projection.closeOverlay(); return true; }
  if (action.action === 'back') { workspace.projection.openOverlay(overlay.parentProvider); return true; }
  if (['history_up', 'history_down'].includes(action.action)) {
    workspace.projection.moveOverlaySelection(action.action === 'history_up' ? -1 : 1); return true;
  }
  if (action.action !== 'submit' || !overlay.editable) return true;
  const selected = overlay.items?.[overlay.selected];
  if (!selected) return true;
  try {
    if (selected.id === 'timeout-default') {
      await workspace.configureProviderRoute(overlay.role, 'timeout', null);
      reopenSettings(workspace, overlay, 'Overall attempt timeout restored to trust-aware defaults.');
    } else if (selected.id === 'timeout-inherit') {
      await workspace.configureProviderRoute(overlay.role, 'timeout', null);
      reopenSettings(workspace, overlay, 'Timeout now uses the Primary setting.');
    } else if (selected.id === 'temperature-default') {
      await workspace.configureProviderRoute(overlay.role, 'temperature', null);
      reopenSettings(workspace, overlay, 'Temperature restored to the provider default.');
    } else if (SETTINGS[selected.id]?.options) {
      workspace.projection.openOverlay(settingOptionsOverlay(overlay, selected.id));
    } else workspace.projection.openOverlay(settingFormOverlay(overlay, selected.id));
  } catch (error) {
    workspace.projection.showNotice('provider', `Cannot save · ${error.message}`);
  }
  return true;
}

async function handleSettingOptions(action, workspace, overlay) {
  if (['cancel', 'help'].includes(action.action)) { workspace.projection.closeOverlay(); return true; }
  if (action.action === 'back') { workspace.projection.openOverlay(overlay.parentSettings); return true; }
  if (['history_up', 'history_down'].includes(action.action)) {
    workspace.projection.moveOverlaySelection(action.action === 'history_up' ? -1 : 1); return true;
  }
  if (action.action !== 'submit') return true;
  const selected = overlay.items?.[overlay.selected];
  if (!selected) return true;
  try {
    await workspace.configureProviderRoute(overlay.role, overlay.setting, selected.value);
    reopenSettings(workspace, overlay.parentSettings, `${SETTINGS[overlay.setting].label} saved.`);
  } catch (error) {
    workspace.projection.showNotice('provider', `Cannot save · ${error.message}`);
  }
  return true;
}

function settingOptionsOverlay(parentSettings, setting) {
  const current = routeSetting(parentSettings.config.routes[parentSettings.role], setting);
  const choices = setting === 'reasoning_effort'
    ? [{ id: 'default', label: PROVIDER_DEFAULT, value: null },
      ...REASONING_EFFORTS.map((value) => ({ id: value, label: value, value }))]
    : [{ id: 'default', label: PROVIDER_DEFAULT, value: null },
      { id: 'enabled', label: 'Enabled', value: true }, { id: 'disabled', label: 'Disabled', value: false }];
  const items = choices.map((choice) => ({
    ...choice, badge: choice.value === current ? 'active' : '', section: SETTINGS[setting].label,
  }));
  return createMenuOverlay('provider-route-setting-options', SETTINGS[setting].label,
    [SETTINGS[setting].detail, '', 'Choose one of the supported values.'], items, {
      activeId: items.find((item) => item.value === current)?.id,
      role: parentSettings.role, setting, parentSettings,
      actionLabel: 'Up/Down choose · Enter save',
    });
}

export function routeSettingsOverlay(config, role, options = {}) {
  const route = config.routes[role], primary = role === 'primary';
  const timeoutConfigured = primary ? config.limits.providerOverrideMs !== null : route.deadlineOverrideMs !== null;
  const effectiveTimeout = effectiveRouteTimeout(config, role);
  const editable = options.editable !== false;
  const lines = [
    `${LABELS[role] ?? role} route settings`, '',
    `Provider                 ${route.providerId}`,
    `Model                    ${route.model}`,
    `Overall attempt timeout  ${formatMs(effectiveTimeout)} (${timeoutLabel(config, role, timeoutConfigured)})`,
    `Temperature              ${temperatureLabel(route)}`,
    `Maximum output tokens    ${route.maxOutputTokens?.toLocaleString('en-US') ?? 'No explicit limit'}`,
    `Fallback attempt budget  ${route.budget ?? 'All eligible routes'}`,
    `Reasoning effort         ${route.reasoningEffort ?? PROVIDER_DEFAULT}`,
    `Thinking mode            ${thinkingLabel(route.enableThinking)}`,
    `Context limit            ${route.contextLimitBytes?.toLocaleString('en-US') ?? 'provider default'}`,
    `Required capabilities    ${route.requiredCapabilities.length ? route.requiredCapabilities.join(', ') : 'none'}`,
    `Fallback profiles        ${route.fallbacks.length ? route.fallbacks.join(', ') : 'none'}`,
  ];
  const items = editable ? Object.entries(SETTINGS).map(([id, definition]) => ({
    id, label: definition.label, detail: definition.detail, badge: settingValue(config, role, id), section: 'Configurable settings',
  })) : [];
  if (editable && timeoutConfigured) items.push(primary ? {
    id: 'timeout-default', label: 'Restore default timeout', badge: 'trust-aware',
    detail: 'Return Primary to the trust-aware timeout policy.', section: 'Setting defaults',
  } : {
    id: 'timeout-inherit', label: 'Remove timeout override', badge: 'use Primary',
    detail: `Return this route to the Primary ${formatMs(config.routes.primary.deadlineMs)} timeout.`, section: 'Setting inheritance',
  });
  if (editable && route.temperatureOverride !== null) items.push({
    id: 'temperature-default', label: 'Restore default temperature', badge: PROVIDER_DEFAULT,
    detail: 'Remove the configured temperature and let the provider choose its default.', section: 'Setting defaults',
  });
  return createMenuOverlay('provider-route-settings', `${LABELS[role] ?? role} settings`, lines, items, {
    role, editable, parentProvider: options.parentProvider, config,
    actionLabel: editable ? 'Up/Down choose · Enter edit' : 'Read only',
  });
}

async function handleForm(action, workspace, overlay) {
  if (action.action === 'back') { workspace.projection.openOverlay(overlay.parentSettings); return true; }
  if (['cancel', 'help'].includes(action.action)) { workspace.projection.closeOverlay(); return true; }
  if (action.action === 'submit') {
    try {
      const value = parseSetting(overlay.setting, overlay.editor.text);
      await workspace.configureProviderRoute(overlay.role, overlay.setting, value);
      reopenSettings(workspace, overlay.parentSettings, `${SETTINGS[overlay.setting].label} saved.`);
    } catch (error) {
      workspace.projection.openOverlay(settingFormOverlay(overlay.parentSettings, overlay.setting, overlay.editor, error.message));
    }
    return true;
  } else if (handleFormEditing(action, overlay.editor)) { /* edited */ }
  workspace.projection.openOverlay(settingFormOverlay(overlay.parentSettings, overlay.setting, overlay.editor));
  return true;
}

function settingFormOverlay(parentSettings, setting, existingEditor = null, error = null) {
  const form = {
    stepIndex: 0, error,
    draft: { value: editValue(parentSettings.config, parentSettings.role, setting) },
    steps: [formField('value', SETTINGS[setting].label, SETTINGS[setting].detail, { limit: SETTING_EDITOR_BYTES })],
  };
  const base = createFormOverlay(form, {
    kind: 'provider-route-setting-form', title: SETTINGS[setting].label,
    actionLabel: 'Type value · Enter save · Esc previous',
  }, existingEditor);
  return Object.freeze({
    ...base, role: parentSettings.role, setting, parentSettings,
  });
}

function reopenSettings(workspace, prior, notice) {
  const next = routeSettingsOverlay(routeConfig(workspace, prior.role), prior.role, prior);
  workspace.projection.openOverlay(next); workspace.projection.showNotice('provider', notice);
}

function routeConfig(workspace, role) {
  const config = role === 'primary' ? workspace.activeConfig() : workspace.config;
  if (!config?.routes?.[role]) throw new ContractError('provider_route_missing', `the ${role} provider route is unavailable`);
  return config;
}

function settingValue(config, role, setting) {
  const route = config.routes[role];
  if (setting === 'timeout') {
    const effective = effectiveRouteTimeout(config, role);
    if (role === 'primary') return `${formatMs(effective)} · ${config.limits.providerOverrideMs === null ? 'trust-aware' : 'configured'}`;
    return route.deadlineOverrideMs === null ? `Primary · ${formatMs(effective)}` : formatMs(effective);
  }
  if (setting === 'temperature') return temperatureLabel(route).toLowerCase();
  if (setting === 'output') return route.maxOutputTokens === null || route.maxOutputTokens === undefined ? 'no limit' : route.maxOutputTokens.toLocaleString('en-US');
  if (setting === 'budget') return route.budget === null || route.budget === undefined ? 'all eligible' : String(route.budget);
  if (setting === 'reasoning_effort') return route.reasoningEffort ?? 'provider default';
  return thinkingLabel(route.enableThinking).toLowerCase();
}

function effectiveRouteTimeout(config, role) {
  const route = config.routes[role];
  const profile = config.providerProfiles[route.providerId];
  const explicitlyConfigured = route.deadlineOverrideMs !== null
    || config.limits.providerOverrideMs !== null;
  if (!explicitlyConfigured && profile?.trustZone !== 'public_network') return null;
  return route.deadlineMs;
}

function timeoutLabel(config, role, configured) {
  if (configured) return role === 'primary' ? 'configured' : 'override';
  const profile = config.providerProfiles[config.routes[role].providerId];
  if (profile?.trustZone !== 'public_network' && config.limits.providerOverrideMs === null) {
    return 'trusted local · operator cancellation';
  }
  return role === 'primary' ? 'public-network default' : 'Primary';
}

function routeSetting(route, setting) {
  return setting === 'reasoning_effort' ? route.reasoningEffort : route.enableThinking;
}

function thinkingLabel(value) {
  return value === null || value === undefined ? PROVIDER_DEFAULT : value ? 'Enabled' : 'Disabled';
}

function temperatureLabel(route) {
  if (route.temperatureOverride === null) return PROVIDER_DEFAULT;
  if (route.temperatureOverride === 0) return 'Provider default (configured)';
  return `${route.temperatureOverride} (configured)`;
}

function editValue(config, role, setting) {
  const route = config?.routes?.[role];
  if (!route) return '';
  if (setting === 'timeout') return route.deadlineMs === null || route.deadlineMs === undefined ? '0' : String(Math.round(route.deadlineMs / 1_000));
  if (setting === 'temperature') return String(route.temperatureOverride ?? route.temperature ?? 0);
  if (setting === 'output') return String(route.maxOutputTokens ?? 0);
  return String(route.budget ?? 0);
}

function parseSetting(setting, raw) {
  if (raw === null || raw === undefined || String(raw).trim().length === 0) {
    throw new ContractError('route_setting_invalid', 'Enter a value.');
  }
  const value = Number(String(raw).trim());
  if (setting === 'temperature') {
    if (!Number.isFinite(value) || value < 0 || value > 2) throw new ContractError('route_temperature_invalid', 'Temperature must be from 0 through 2.');
    return value;
  }
  if (!Number.isSafeInteger(value)) throw new ContractError('route_setting_invalid', 'Enter a whole number.');
  if (setting === 'timeout') {
    if (value < 0 || value > MAX_TIMEOUT_SECONDS) throw new ContractError('route_timeout_invalid', `Timeout must be 0 through ${MAX_TIMEOUT_SECONDS.toLocaleString('en-US')} seconds.`);
    return value * 1_000;
  }
  const maximum = setting === 'output' ? MAX_OUTPUT_TOKENS : MAX_ROUTE_BUDGET;
  if (value < 0 || value > maximum) throw new ContractError('route_setting_invalid', `Value must be 0 through ${maximum.toLocaleString('en-US')}.`);
  return value === 0 ? null : value;
}

function formatMs(value) {
  return value === null || value === undefined ? 'No limit' : `${Math.round(value / 1_000).toLocaleString('en-US')}s`;
}
