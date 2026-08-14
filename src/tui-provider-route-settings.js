// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { EditorBuffer } from './tui-model.js';
import { handleEditorAction } from './tui-editor-actions.js';

const LABELS = Object.freeze({
  primary: 'Primary', subagent: 'Sub-agents', reviewer: 'Permission reviewer', vision: 'Vision',
});
const SETTINGS = Object.freeze({
  timeout: Object.freeze({ label: 'Overall attempt timeout', detail: 'Seconds allowed for prompt processing and generation.' }),
  temperature: Object.freeze({ label: 'Temperature', detail: 'Sampling temperature from 0 through 2.' }),
  output: Object.freeze({ label: 'Maximum output tokens', detail: 'Maximum tokens requested from the provider.' }),
  budget: Object.freeze({ label: 'Fallback attempt budget', detail: 'Maximum eligible route attempts from 1 through 64.' }),
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
  if (!['provider-route-settings', 'provider-route-setting-form'].includes(overlay?.kind)) return false;
  if (overlay.kind === 'provider-route-setting-form') return handleForm(action, workspace, overlay);
  if (['cancel', 'help'].includes(action.action)) { workspace.projection.closeOverlay(); return true; }
  if (action.action === 'back') { workspace.projection.openOverlay(overlay.parentProvider); return true; }
  if (['history_up', 'history_down'].includes(action.action)) {
    workspace.projection.moveOverlaySelection(action.action === 'history_up' ? -1 : 1); return true;
  }
  if (action.action !== 'submit' || !overlay.editable) return true;
  const selected = overlay.items[overlay.selected];
  if (selected.id === 'timeout-inherit') {
    await workspace.configureProviderRoute(overlay.role, 'timeout', null);
    reopenSettings(workspace, overlay, 'Timeout now inherits the global provider timeout.');
  } else workspace.projection.openOverlay(settingFormOverlay(overlay, selected.id));
  return true;
}

export function routeSettingsOverlay(config, role, options = {}) {
  const route = config.routes[role], inherited = route.deadlineOverrideMs === null;
  const editable = options.editable !== false;
  const lines = [
    `${LABELS[role] ?? role} route settings`, '',
    `Provider                 ${route.providerId}`,
    `Model                    ${route.model}`,
    `Overall attempt timeout  ${formatMs(route.deadlineMs)} (${inherited ? 'global' : 'override'})`,
    `Temperature              ${route.temperature}`,
    `Maximum output tokens    ${route.maxOutputTokens.toLocaleString('en-US')}`,
    `Fallback attempt budget  ${route.budget}`,
    `Context limit            ${route.contextLimitBytes?.toLocaleString('en-US') ?? 'provider default'}`,
    `Required capabilities    ${route.requiredCapabilities.length ? route.requiredCapabilities.join(', ') : 'none'}`,
    `Fallback profiles        ${route.fallbacks.length ? route.fallbacks.join(', ') : 'none'}`,
  ];
  const items = editable ? Object.entries(SETTINGS).map(([id, definition]) => ({
    id, label: definition.label, detail: definition.detail, badge: settingValue(route, id), section: 'Configurable settings',
  })) : [];
  if (editable && !inherited) items.push({
    id: 'timeout-inherit', label: 'Remove timeout override', badge: 'use global',
    detail: `Return this route to the global ${formatMs(config.limits.providerMs)} provider timeout.`, section: 'Timeout inheritance',
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
    lines: Object.freeze([SETTINGS[setting].detail, '', ...(error ? [`Cannot save · ${error}`, ''] : []), 'Enter a value:']),
    items: Object.freeze([]), selected: 0, offset: 0, role: parentSettings.role, setting, parentSettings, editor,
    actionLabel: 'Enter save | Ctrl+G back',
  });
}

function reopenSettings(workspace, prior, notice) {
  const next = routeSettingsOverlay(routeConfig(workspace, prior.role), prior.role, prior);
  workspace.projection.openOverlay(next); workspace.projection.showNotice('provider', notice);
}

function routeConfig(workspace, role) { return role === 'primary' ? workspace.activeConfig() : workspace.config; }

function settingValue(route, setting) {
  if (setting === 'timeout') return route.deadlineOverrideMs === null ? `global · ${formatMs(route.deadlineMs)}` : formatMs(route.deadlineMs);
  if (setting === 'temperature') return String(route.temperature);
  if (setting === 'output') return route.maxOutputTokens.toLocaleString('en-US');
  return String(route.budget);
}

function editValue(config, role, setting) {
  const route = config?.routes?.[role];
  if (!route) return '';
  if (setting === 'timeout') return String(Math.round(route.deadlineMs / 1_000));
  if (setting === 'temperature') return String(route.temperature);
  if (setting === 'output') return String(route.maxOutputTokens);
  return String(route.budget);
}

function parseSetting(setting, raw) {
  const value = Number(String(raw).trim());
  if (setting === 'temperature') {
    if (!Number.isFinite(value) || value < 0 || value > 2) throw new ContractError('route_temperature_invalid', 'Temperature must be from 0 through 2.');
    return value;
  }
  if (!Number.isSafeInteger(value)) throw new ContractError('route_setting_invalid', 'Enter a whole number.');
  if (setting === 'timeout') {
    if (value < 1 || value > 3_600) throw new ContractError('route_timeout_invalid', 'Timeout must be 1 through 3,600 seconds.');
    return value * 1_000;
  }
  const maximum = setting === 'output' ? 1_048_576 : 64;
  if (value < 1 || value > maximum) throw new ContractError('route_setting_invalid', `Value must be 1 through ${maximum.toLocaleString('en-US')}.`);
  return value;
}

function editorWith(value) { const editor = new EditorBuffer(128); editor.set(value); return editor; }
function singleLine(action) {
  return action.action === 'paste' ? { ...action, text: String(action.text).split(/\r?\n/u, 1)[0] } : action;
}
function formatMs(value) { return `${Math.round(value / 1_000).toLocaleString('en-US')}s`; }
