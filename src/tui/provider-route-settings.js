// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';
import { EditorBuffer } from '../experience/projection.js';
import { handleEditorAction } from './editor-actions.js';
import { REASONING_EFFORTS } from '../provider/reasoning.js';

const LABELS = Object.freeze({
  primary: 'Primary', subagent: 'Sub-agents', reviewer: 'Permission reviewer', vision: 'Vision',
});
const SETTINGS = Object.freeze({
  timeout: Object.freeze({ label: 'Overall attempt timeout', detail: 'Seconds allowed for prompt processing and generation. Enter 0 for no timeout.' }),
  temperature: Object.freeze({ label: 'Temperature', detail: 'Sampling temperature from 0 through 2. The built-in default is 1.0; enter 0 to use the provider default.' }),
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
  const selected = overlay.items[overlay.selected];
  if (selected.id === 'timeout-default') {
    await workspace.configureProviderRoute(overlay.role, 'timeout', null);
    reopenSettings(workspace, overlay, 'Overall attempt timeout restored to the 1,800-second default.');
  } else if (selected.id === 'timeout-inherit') {
    await workspace.configureProviderRoute(overlay.role, 'timeout', null);
    reopenSettings(workspace, overlay, 'Timeout now uses the Primary setting.');
  } else if (selected.id === 'temperature-default') {
    await workspace.configureProviderRoute(overlay.role, 'temperature', null);
    reopenSettings(workspace, overlay, 'Temperature restored to the 1.0 default.');
  } else if (SETTINGS[selected.id]?.options) {
    workspace.projection.openOverlay(settingOptionsOverlay(overlay, selected.id));
  } else workspace.projection.openOverlay(settingFormOverlay(overlay, selected.id));
  return true;
}

async function handleSettingOptions(action, workspace, overlay) {
  if (['cancel', 'help'].includes(action.action)) { workspace.projection.closeOverlay(); return true; }
  if (action.action === 'back') { workspace.projection.openOverlay(overlay.parentSettings); return true; }
  if (['history_up', 'history_down'].includes(action.action)) {
    workspace.projection.moveOverlaySelection(action.action === 'history_up' ? -1 : 1); return true;
  }
  if (action.action !== 'submit') return true;
  const selected = overlay.items[overlay.selected];
  await workspace.configureProviderRoute(overlay.role, overlay.setting, selected.value);
  reopenSettings(workspace, overlay.parentSettings, `${SETTINGS[overlay.setting].label} saved.`);
  return true;
}

function settingOptionsOverlay(parentSettings, setting) {
  const current = routeSetting(parentSettings.config.routes[parentSettings.role], setting);
  const choices = setting === 'reasoning_effort'
    ? [{ id: 'default', label: 'Provider default', value: null },
      ...REASONING_EFFORTS.map((value) => ({ id: value, label: value, value }))]
    : [{ id: 'default', label: 'Provider default', value: null },
      { id: 'enabled', label: 'Enabled', value: true }, { id: 'disabled', label: 'Disabled', value: false }];
  const items = choices.map((choice) => ({
    ...choice, badge: choice.value === current ? 'active' : '', section: SETTINGS[setting].label,
  }));
  return Object.freeze({
    kind: 'provider-route-setting-options', title: SETTINGS[setting].label,
    lines: Object.freeze([SETTINGS[setting].detail, '', 'Choose one of the supported values.']),
    items: Object.freeze(items), selected: Math.max(0, items.findIndex((item) => item.value === current)), offset: 0,
    role: parentSettings.role, setting, parentSettings,
    actionLabel: 'Up/Down choose | Enter save | Ctrl+G back',
  });
}

export function routeSettingsOverlay(config, role, options = {}) {
  const route = config.routes[role], primary = role === 'primary';
  const timeoutConfigured = primary ? config.limits.providerOverrideMs !== null : route.deadlineOverrideMs !== null;
  const editable = options.editable !== false;
  const lines = [
    `${LABELS[role] ?? role} route settings`, '',
    `Provider                 ${route.providerId}`,
    `Model                    ${route.model}`,
    `Overall attempt timeout  ${formatMs(route.deadlineMs)} (${primary
      ? (timeoutConfigured ? 'configured' : 'default') : (timeoutConfigured ? 'override' : 'Primary')})`,
    `Temperature              ${temperatureLabel(route)}`,
    `Maximum output tokens    ${route.maxOutputTokens?.toLocaleString('en-US') ?? 'No explicit limit'}`,
    `Fallback attempt budget  ${route.budget ?? 'All eligible routes'}`,
    `Reasoning effort         ${route.reasoningEffort ?? 'Provider default'}`,
    `Thinking mode            ${thinkingLabel(route.enableThinking)}`,
    `Context limit            ${route.contextLimitBytes?.toLocaleString('en-US') ?? 'provider default'}`,
    `Required capabilities    ${route.requiredCapabilities.length ? route.requiredCapabilities.join(', ') : 'none'}`,
    `Fallback profiles        ${route.fallbacks.length ? route.fallbacks.join(', ') : 'none'}`,
  ];
  const items = editable ? Object.entries(SETTINGS).map(([id, definition]) => ({
    id, label: definition.label, detail: definition.detail, badge: settingValue(config, role, id), section: 'Configurable settings',
  })) : [];
  if (editable && timeoutConfigured) items.push(primary ? {
    id: 'timeout-default', label: 'Restore default timeout', badge: '1,800s',
    detail: 'Return Primary to the built-in 1,800-second timeout.', section: 'Setting defaults',
  } : {
    id: 'timeout-inherit', label: 'Remove timeout override', badge: 'use Primary',
    detail: `Return this route to the Primary ${formatMs(config.routes.primary.deadlineMs)} timeout.`, section: 'Setting inheritance',
  });
  if (editable && route.temperatureOverride !== null) items.push({
    id: 'temperature-default', label: 'Restore default temperature', badge: '1.0',
    detail: 'Remove the configured temperature and restore the built-in default.', section: 'Setting defaults',
  });
  return Object.freeze({
    kind: 'provider-route-settings', title: `${LABELS[role] ?? role} settings`, lines: Object.freeze(lines),
    items: Object.freeze(items), selected: 0, offset: 0, role, editable,
    parentProvider: options.parentProvider, config,
    actionLabel: editable ? 'Up/Down choose | Enter edit | Ctrl+G back' : 'Read only | Ctrl+G back',
  });
}

async function handleForm(action, workspace, overlay) {
  if (action.action === 'back') { workspace.projection.openOverlay(overlay.parentSettings); return true; }
  if (['cancel', 'help'].includes(action.action)) { workspace.projection.closeOverlay(); return true; }
  if (action.action === 'home') overlay.editor.moveLine('start');
  else if (action.action === 'end') overlay.editor.moveLine('end');
  else if (action.action === 'submit') {
    try {
      const value = parseSetting(overlay.setting, overlay.editor.text);
      await workspace.configureProviderRoute(overlay.role, overlay.setting, value);
      reopenSettings(workspace, overlay.parentSettings, `${SETTINGS[overlay.setting].label} saved.`);
    } catch (error) {
      workspace.projection.openOverlay(settingFormOverlay(overlay.parentSettings, overlay.setting, overlay.editor, error.message));
    }
    return true;
  } else if (action.action !== 'newline' && handleEditorAction(singleLine(action), overlay.editor)) { /* edited */ }
  workspace.projection.openOverlay(settingFormOverlay(overlay.parentSettings, overlay.setting, overlay.editor));
  return true;
}

function settingFormOverlay(parentSettings, setting, existingEditor = null, error = null) {
  const editor = existingEditor ?? editorWith(editValue(parentSettings.config, parentSettings.role, setting));
  return Object.freeze({
    kind: 'provider-route-setting-form', title: SETTINGS[setting].label,
    lines: Object.freeze([SETTINGS[setting].detail, '', ...(error ? [`Cannot save · ${error}`, ''] : []),
      'Enter a value:', '', `  ${renderEditor(editor)}`]),
    items: Object.freeze([]), selected: 0, offset: 0, role: parentSettings.role, setting, parentSettings, editor,
    actionLabel: 'Type value | Enter save | Ctrl+G back',
  });
}

function reopenSettings(workspace, prior, notice) {
  const next = routeSettingsOverlay(routeConfig(workspace, prior.role), prior.role, prior);
  workspace.projection.openOverlay(next); workspace.projection.showNotice('provider', notice);
}

function routeConfig(workspace, role) { return role === 'primary' ? workspace.activeConfig() : workspace.config; }

function settingValue(config, role, setting) {
  const route = config.routes[role];
  if (setting === 'timeout') {
    if (role === 'primary') return `${formatMs(route.deadlineMs)} · ${config.limits.providerOverrideMs === null ? 'default' : 'configured'}`;
    return route.deadlineOverrideMs === null ? `Primary · ${formatMs(route.deadlineMs)}` : formatMs(route.deadlineMs);
  }
  if (setting === 'temperature') return temperatureLabel(route).toLowerCase();
  if (setting === 'output') return route.maxOutputTokens == null ? 'no limit' : route.maxOutputTokens.toLocaleString('en-US');
  if (setting === 'budget') return route.budget == null ? 'all eligible' : String(route.budget);
  if (setting === 'reasoning_effort') return route.reasoningEffort ?? 'provider default';
  return thinkingLabel(route.enableThinking).toLowerCase();
}

function routeSetting(route, setting) {
  return setting === 'reasoning_effort' ? route.reasoningEffort : route.enableThinking;
}

function thinkingLabel(value) {
  return value == null ? 'Provider default' : value ? 'Enabled' : 'Disabled';
}

function temperatureLabel(route) {
  if (route.temperatureOverride === null) return '1 (default)';
  if (route.temperatureOverride === 0) return 'Provider default (configured)';
  return `${route.temperatureOverride} (configured)`;
}

function editValue(config, role, setting) {
  const route = config?.routes?.[role];
  if (!route) return '';
  if (setting === 'timeout') return route.deadlineMs == null ? '0' : String(Math.round(route.deadlineMs / 1_000));
  if (setting === 'temperature') return String(route.temperatureOverride ?? route.temperature ?? 1);
  if (setting === 'output') return String(route.maxOutputTokens ?? 0);
  return String(route.budget ?? 0);
}

function parseSetting(setting, raw) {
  const value = Number(String(raw).trim());
  if (setting === 'temperature') {
    if (!Number.isFinite(value) || value < 0 || value > 2) throw new ContractError('route_temperature_invalid', 'Temperature must be from 0 through 2.');
    return value;
  }
  if (!Number.isSafeInteger(value)) throw new ContractError('route_setting_invalid', 'Enter a whole number.');
  if (setting === 'timeout') {
    if (value < 0 || value > 3_600) throw new ContractError('route_timeout_invalid', 'Timeout must be 0 through 3,600 seconds.');
    return value * 1_000;
  }
  const maximum = setting === 'output' ? 1_048_576 : 64;
  if (value < 0 || value > maximum) throw new ContractError('route_setting_invalid', `Value must be 0 through ${maximum.toLocaleString('en-US')}.`);
  return value === 0 ? null : value;
}

function editorWith(value) { const editor = new EditorBuffer(128); editor.set(value); return editor; }
function renderEditor(editor) {
  const selection = editor.selection();
  const before = editor.text.slice(0, selection.start);
  const selected = editor.text.slice(selection.start, selection.end);
  const after = editor.text.slice(selection.end);
  return `${before}${selected ? `⟦${selected}⟧` : '│'}${after}`;
}
function singleLine(action) {
  return action.action === 'paste' ? { ...action, text: String(action.text).split(/\r?\n/u, 1)[0] } : action;
}
function formatMs(value) { return value == null ? 'No limit' : `${Math.round(value / 1_000).toLocaleString('en-US')}s`; }
