// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { EditorBuffer } from './tui-model.js';
import { handleEditorAction } from './tui-editor-actions.js';

const LABELS = Object.freeze({
  primary: 'Primary', subagent: 'Sub-agents', reviewer: 'Permission reviewer', vision: 'Vision',
});
const SETTINGS = Object.freeze({
  timeout: Object.freeze({ label: 'Overall attempt timeout', detail: 'Seconds allowed for prompt processing and generation. Enter 0 for no timeout.' }),
  temperature: Object.freeze({ label: 'Temperature', detail: 'Sampling temperature above 0 through 2. Enter 0 to use the provider default.' }),
  output: Object.freeze({ label: 'Maximum output tokens', detail: 'Maximum tokens requested from the provider. Enter 0 for no explicit limit.' }),
  budget: Object.freeze({ label: 'Fallback attempt budget', detail: 'Maximum eligible route attempts from 1 through 64. Enter 0 to use every eligible route.' }),
});

export function beginProviderRouteSettingsSelection(selected, workspace, overlay) {
  if (overlay?.kind !== 'provider') return false;
  if (selected?.id === 'global-settings') {
    workspace.projection.openOverlay(globalSettingsOverlay(workspace.config, { parentProvider: overlay }));
    return true;
  }
  if (selected?.id !== 'route-settings') return false;
  const editable = overlay.role === 'primary' || overlay.canAssign !== false;
  workspace.projection.openOverlay(routeSettingsOverlay(routeConfig(workspace, overlay.role), overlay.role, {
    editable, parentProvider: overlay,
  }));
  return true;
}

export async function handleProviderRouteSettingsAction(action, workspace) {
  const overlay = workspace.projection.overlay;
  if (overlay?.kind === 'global-provider-setting-form') return handleGlobalForm(action, workspace, overlay);
  if (overlay?.kind === 'global-provider-settings') return handleGlobalSettings(action, workspace, overlay);
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

function globalSettingsOverlay(config, options = {}) {
  const configured = config.limits.providerOverrideMs !== null;
  const items = [{
    id: 'global-timeout', label: 'Default route timeout', badge: `${formatMs(config.limits.providerMs)}${configured ? '' : ' · built in'}`,
    detail: 'All routes without a timeout override inherit this value.', section: 'Routing defaults',
  }];
  if (configured) items.push({
    id: 'global-timeout-remove', label: 'Remove configured timeout', badge: 'use built-in default',
    detail: 'Return the global route timeout to the built-in default.', section: 'Routing defaults',
  });
  return Object.freeze({
    kind: 'global-provider-settings', title: 'Global provider settings',
    lines: Object.freeze(['Workspace routing defaults', '', `Default route timeout  ${formatMs(config.limits.providerMs)} (${configured ? 'configured' : 'built in'})`,
      'Routes inherit this timeout unless their role settings define an override.']),
    items: Object.freeze(items), selected: 0, offset: 0, config, parentProvider: options.parentProvider,
    actionLabel: 'Up/Down choose | Enter edit | Ctrl+G back',
  });
}

async function handleGlobalSettings(action, workspace, overlay) {
  if (['cancel', 'help'].includes(action.action)) { workspace.projection.closeOverlay(); return true; }
  if (action.action === 'back') { workspace.projection.openOverlay(overlay.parentProvider); return true; }
  if (['history_up', 'history_down'].includes(action.action)) {
    workspace.projection.moveOverlaySelection(action.action === 'history_up' ? -1 : 1); return true;
  }
  if (action.action !== 'submit') return true;
  const selected = overlay.items[overlay.selected];
  if (selected.id === 'global-timeout-remove') {
    await workspace.configureRuntimeLimits({ providerMs: null });
    reopenGlobalSettings(workspace, overlay, 'Global route timeout now uses the built-in default.');
  } else {
    const editor = editorWith(overlay.config.limits.providerMs == null ? '0'
      : String(Math.round(overlay.config.limits.providerMs / 1_000)));
    workspace.projection.openOverlay(globalSettingFormOverlay(overlay, editor));
  }
  return true;
}

async function handleGlobalForm(action, workspace, overlay) {
  if (action.action === 'back') { workspace.projection.openOverlay(overlay.parentSettings); return true; }
  if (['cancel', 'help'].includes(action.action)) { workspace.projection.closeOverlay(); return true; }
  if (action.action === 'home') overlay.editor.moveLine('start');
  else if (action.action === 'end') overlay.editor.moveLine('end');
  else if (action.action === 'submit') {
    try {
      const value = parseSetting('timeout', overlay.editor.text);
      await workspace.configureRuntimeLimits({ providerMs: value });
      reopenGlobalSettings(workspace, overlay.parentSettings, 'Global route timeout saved.');
    } catch (error) {
      workspace.projection.openOverlay(globalSettingFormOverlay(overlay.parentSettings, overlay.editor, error.message));
    }
    return true;
  } else if (action.action !== 'newline' && handleEditorAction(singleLine(action), overlay.editor)) { /* edited */ }
  workspace.projection.openOverlay(globalSettingFormOverlay(overlay.parentSettings, overlay.editor));
  return true;
}

function globalSettingFormOverlay(parentSettings, editor, error = null) {
  return Object.freeze({
    kind: 'global-provider-setting-form', title: 'Default route timeout',
    lines: Object.freeze(['Seconds inherited by routes without an override. Enter 0 for no timeout.', '', ...(error ? [`Cannot save · ${error}`, ''] : []),
      'Enter a value:', '', `  ${renderEditor(editor)}`]),
    items: Object.freeze([]), selected: 0, offset: 0, parentSettings, editor,
    actionLabel: 'Type value | Enter save | Ctrl+G back',
  });
}

function reopenGlobalSettings(workspace, prior, notice) {
  workspace.projection.openOverlay(globalSettingsOverlay(workspace.config, prior));
  workspace.projection.showNotice('provider', notice);
}

export function routeSettingsOverlay(config, role, options = {}) {
  const route = config.routes[role], inherited = route.deadlineOverrideMs === null;
  const editable = options.editable !== false;
  const lines = [
    `${LABELS[role] ?? role} route settings`, '',
    `Provider                 ${route.providerId}`,
    `Model                    ${route.model}`,
    `Overall attempt timeout  ${formatMs(route.deadlineMs)} (${inherited ? 'global' : 'override'})`,
    `Temperature              ${route.temperature ?? 'Provider default'}`,
    `Maximum output tokens    ${route.maxOutputTokens?.toLocaleString('en-US') ?? 'No explicit limit'}`,
    `Fallback attempt budget  ${route.budget ?? 'All eligible routes'}`,
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

function settingValue(route, setting) {
  if (setting === 'timeout') return route.deadlineOverrideMs === null ? `global · ${formatMs(route.deadlineMs)}` : formatMs(route.deadlineMs);
  if (setting === 'temperature') return route.temperature == null ? 'provider default' : String(route.temperature);
  if (setting === 'output') return route.maxOutputTokens == null ? 'no limit' : route.maxOutputTokens.toLocaleString('en-US');
  return route.budget == null ? 'all eligible' : String(route.budget);
}

function editValue(config, role, setting) {
  const route = config?.routes?.[role];
  if (!route) return '';
  if (setting === 'timeout') return route.deadlineMs == null ? '0' : String(Math.round(route.deadlineMs / 1_000));
  if (setting === 'temperature') return String(route.temperature ?? 0);
  if (setting === 'output') return String(route.maxOutputTokens ?? 0);
  return String(route.budget ?? 0);
}

function parseSetting(setting, raw) {
  const value = Number(String(raw).trim());
  if (setting === 'temperature') {
    if (!Number.isFinite(value) || value < 0 || value > 2) throw new ContractError('route_temperature_invalid', 'Temperature must be from 0 through 2.');
    return value === 0 ? null : value;
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
